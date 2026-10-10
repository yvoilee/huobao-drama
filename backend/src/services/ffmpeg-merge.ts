/**
 * FFmpeg 多镜头拼接 — 将所有生成后的镜头视频拼接为一集
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db, getInsertId, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

// 片头（剧名）/片尾（「剧终」）黑底白字卡的固定时长（秒）
const TITLE_CARD_SECONDS = 3
const END_CARD_SECONDS = 2

// 镜头间过渡时长（秒）：画面 xfade 交叉溶解 + 音频 acrossfade 交叉淡化共用此值，保证音画同步
const XFADE_SECONDS = 0.4

/**
 * 拼接一集的镜头视频。
 * 优先使用视频生成产物，兼容历史的 composedVideoUrl 数据。
 * 传入 storyboardIds 时只拼接所选镜头（仍按镜号顺序）。
 */
export async function mergeEpisodeVideos(episodeId: number, dramaId: number, storyboardIds?: number[]): Promise<number> {
  let storyboards = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)

  if (storyboardIds?.length) {
    const allow = new Set(storyboardIds.map(Number))
    storyboards = storyboards.filter(sb => allow.has(sb.id))
  }

  // 允许部分拼接:按镜号顺序拼接已生成的镜头,未生成的跳过
  const clips = storyboards
    .map(sb => ({ sb, url: sb.videoUrl || sb.composedVideoUrl }))
    .filter(c => Boolean(c.url)) as { sb: typeof storyboards[number]; url: string }[]

  if (clips.length === 0) throw new Error('所选镜头还没有可拼接的视频')

  // 拼接前探测 ffmpeg：二进制损坏时 fluent-ffmpeg 的同步 EFTYPE 会崩掉整个进程，
  // 这里提前拦截并给出可操作的修复指引（路由层会作为 400 返回前端）
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法拼接视频（常见于 node_modules 跨平台拷贝或 ffmpeg-static 下载损坏）。请删除 node_modules 后在本机重新 npm install，或设置 FFMPEG_BIN 指向有效的 ffmpeg 可执行文件后重启服务')
  }

  // 校验视频文件真实存在:DB 里的 video_url 可能指向已被清理的文件,
  // 直接拼会得到 ffmpeg 的 "No such file or directory" 晦涩报错
  const missing = clips.filter(c => !fs.existsSync(toAbsPath(c.url)))
  if (missing.length > 0) {
    const nums = missing.map(c => `S${c.sb.storyboardNumber}`).join('、')
    throw new Error(`镜头 ${nums} 的视频文件已丢失（本地文件不存在），请重新生成这些镜头的视频，或在拼接时取消勾选`)
  }

  const videos = clips.map(c => c.url)

  // 片头使用剧名（始终固定，不依赖前端配置）
  const [drama] = await db.select({ title: schema.dramas.title })
    .from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  const dramaTitle = drama?.title

  logTaskStart('MergeTask', 'episode-merge', { episodeId, dramaId, clips: videos.length, title: dramaTitle })

  // 创建 merge 记录
  const ts = now()
  const res = await db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: `Episode ${episodeId} Merge`,
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'processing',
    scenes: JSON.stringify(videos),
    createdAt: ts,
  })
  const mergeId = getInsertId(res)

  // 异步执行
  doMerge(mergeId, episodeId, videos, dramaTitle).catch(async err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: err.message })
    console.error(`[Merge] Failed:`, err)
    await db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: err.message })
      .where(eq(schema.videoMerges.id, mergeId))
  })

  return mergeId
}

/** 探测单个视频的音轨与视频时长：concat filter 要求每段流数一致，无音轨需补静音 */
interface MediaProbe {
  hasAudio: boolean
  videoDuration: number
  width: number
  height: number
  frameRate: string
}

function probeMedia(filePath: string): Promise<MediaProbe> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve({ hasAudio: false, videoDuration: 0, width: 0, height: 0, frameRate: '24/1' }); return }
      const streams = metadata.streams || []
      const hasAudio = streams.some(s => s.codec_type === 'audio')
      const video = streams.find(s => s.codec_type === 'video')
      const videoDuration = Number(video?.duration ?? metadata.format?.duration ?? 0)
      resolve({
        hasAudio,
        videoDuration,
        width: Number(video?.width ?? 0),
        height: Number(video?.height ?? 0),
        frameRate: video?.r_frame_rate ?? video?.avg_frame_rate ?? '24/1',
      })
    })
  })
}

/** 解析本机可用的中文字体（drawtext 渲染片头/片尾字幕卡用）；找不到返回 null，跳过字幕卡 */
function resolveCjkFont(): string | null {
  const candidates = [
    // macOS
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    // Windows
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\msyh.ttf',
    'C:\\Windows\\Fonts\\simhei.ttf',
    // Linux
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  ]
  return candidates.find(fs.existsSync) ?? null
}

/** drawtext 过滤器值中的 `:` `,` `'` `\` 需转义（路径、文件名可能含特殊字符） */
function escFilterValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,')
}

/**
 * 生成一张黑底白字卡（片头/片尾）的 filter 片段。
 * 文字经 textfile 读取，规避 drawtext 对中文与特殊字符的转义难题。
 * 分辨率/帧率取首个镜头实际值，保证 concat 各段参数一致。
 */
function cardFilter(textFile: string, fontFile: string, seconds: number, width: number, height: number, frameRate: string) {
  const fontsize = Math.max(28, Math.round(height * 0.09))
  const video = `color=c=black:s=${width}x${height}:r=${frameRate}:d=${seconds},` +
    `drawtext=textfile=${escFilterValue(textFile)}:fontfile=${escFilterValue(fontFile)}:fontsize=${fontsize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2,` +
    `format=yuv420p,setpts=PTS-STARTPTS`
  // 与镜头音轨统一为 48kHz 立体声 fltp，保证 concat 各段格式一致
  const audio = `anullsrc=r=48000:cl=stereo:d=${seconds},aformat=sample_rates=48000:sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS`
  return { video, audio }
}

async function doMerge(mergeId: number, episodeId: number, videos: string[], title?: string) {
  // 输出文件
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)

  const abs = videos.map(toAbsPath)
  const n = abs.length

  // 逐条探测音轨与视频时长：concat filter 要求每段音视频流数一致，无音轨的镜头补一段静音
  const probes = await Promise.all(abs.map(probeMedia))

  // 片头（剧名）+ 片尾（「剧终」）黑底白字卡：找不到中文字体则整体跳过，不影响拼接
  const titleText = title?.trim()
  const font = resolveCjkFont()
  if (!font) console.warn('[Merge] 本机未找到中文字体，跳过片头/片尾字幕卡')

  // 字幕卡分辨率/帧率取首个镜头实际值，保证 concat 各段参数一致
  const first = probes[0]
  const cardW = first.width || 1280
  const cardH = first.height || 720
  const cardFps = first.frameRate || '24/1'

  // 字幕文本写入临时 UTF-8 文件；合并后统一清理
  const tempDir = font ? fs.mkdtempSync(path.join(os.tmpdir(), 'hb-drawtext-')) : ''
  const writeTextFile = (name: string, content: string) => {
    const file = path.join(tempDir, name)
    fs.writeFileSync(file, content, 'utf8')
    return file
  }

  // 用 filter（而非 concat demuxer）逐条独立解码：各镜头采样率/编码参数不一致时
  // （如 Seedance 部分镜头 44100Hz、其余 32000Hz），demuxer 会按首个镜头参数误读后续音轨，
  // 导致音画漂移；filter 逐条解码 + aresample/aformat 统一到 48k 立体声 fltp 可根治。
  const cmd = ffmpeg()
  abs.forEach(p => cmd.input(p))

  // 组装所有「段」（片头卡 + 各镜头 + 片尾卡）：每段带视频/音频 filter 与时长
  // 过渡用同一 FADE 秒数：视频 xfade + 音频 acrossfade 每处过渡都缩短 FADE 秒，音画总时长保持一致
  const FADE = XFADE_SECONDS

  type Segment = { v: string; a: string; dur: number }
  const segs: Segment[] = []
  const pushCard = (text: string, seconds: number) => {
    const { video, audio } = cardFilter(writeTextFile(`card-${segs.length}.txt`, text), font!, seconds, cardW, cardH, cardFps)
    segs.push({ v: video, a: audio, dur: seconds })
  }

  if (font && titleText) pushCard(titleText, TITLE_CARD_SECONDS)

  for (let i = 0; i < n; i++) {
    const dur = probes[i].videoDuration || 5
    // 归一化到首个镜头参数（分辨率/帧率/像素格式/SAR），xfade 要求两端参数严格一致
    const v = `[${i}:v:0]scale=${cardW}:${cardH}:force_original_aspect_ratio=decrease,pad=${cardW}:${cardH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${cardFps},format=yuv420p,setpts=PTS-STARTPTS`
    const a = probes[i].hasAudio
      ? `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS`
      : `anullsrc=r=48000:cl=stereo,asetpts=PTS-STARTPTS,atrim=duration=${dur.toFixed(3)},aformat=sample_fmts=fltp:channel_layouts=stereo`
    segs.push({ v, a, dur })
  }

  if (font) pushCard('剧终', END_CARD_SECONDS)

  const chains: string[] = []
  segs.forEach((s, i) => chains.push(`${s.v}[vseg${i}]`, `${s.a}[aseg${i}]`))

  const m = segs.length
  if (m === 1) {
    // 单段无过渡：直接透传
    chains.push(`[vseg0][aseg0]concat=n=1:v=1:a=1[v][araw]`)
  } else {
    // 链式 xfade（视频）与 acrossfade（音频）：累计时长求 offset；减 0.05s 留安全余量，避免取整误差导致 offset 越界
    let cumDur = segs[0].dur
    let vPrev = 'vseg0'
    let aPrev = 'aseg0'
    for (let k = 0; k < m - 1; k++) {
      const offset = Math.max(0, cumDur - FADE - 0.05).toFixed(3)
      const vOut = k === m - 2 ? 'v' : `xf${k}`
      chains.push(`[${vPrev}][vseg${k + 1}]xfade=transition=fade:duration=${FADE}:offset=${offset}[${vOut}]`)
      cumDur = cumDur - FADE + segs[k + 1].dur
      vPrev = vOut
      const aOut = k === m - 2 ? 'araw' : `af${k}`
      chains.push(`[${aPrev}][aseg${k + 1}]acrossfade=d=${FADE}[${aOut}]`)
      aPrev = aOut
    }
  }
  // 响度归一化：统一到广播响度（-16 LUFS），消除镜头间音量跳变
  chains.push(`[araw]loudnorm=I=-16:TP=-1.5:LRA=11[a]`)

  const filter = chains.join(';')

  try {
    await new Promise<void>((resolve, reject) => {
      cmd
        .complexFilter(filter)
        .outputOptions([
          '-map', '[v]', '-map', '[a]',
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-movflags', '+faststart',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  } finally {
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {} }
  }

  // 获取时长
  const duration = await getVideoDuration(outputPath)

  const mergedRelative = `static/merged/${outputFilename}`

  // 成片海报帧（导出页封面用）：跳过片头字幕卡，取片头后 1s 的正片画面
  await extractVideoPoster(mergedRelative, TITLE_CARD_SECONDS + 1)

  // 更新 merge 记录
  await db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, completedAt: now() })
    .where(eq(schema.videoMerges.id, mergeId))

  // 更新 episode
  await db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))

  logTaskSuccess('MergeTask', 'episode-merge', { mergeId, episodeId, output: mergedRelative, duration, clips: videos.length })
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(metadata.format.duration || 0))
    })
  })
}
