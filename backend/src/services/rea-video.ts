/**
 * rea-video 集成：参考片复刻。
 *
 * runReaVideoDecompose —— 调 rea-video CLI 拆解参考视频，产出 breakdown.json。
 * importReferenceBreakdown —— 把 breakdown.json 映射并写入 huobao 的分镜/资产。
 *
 * rea-video 是 Python CLI（默认走 PATH 上的 rea-video，可用 REA_VIDEO_BIN 覆盖，
 * 与 FFMPEG_BIN/FFPROBE_BIN 同一约定）。未安装时 import 之前会先探测并给出明确报错。
 */
import { spawn } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { logTaskStart, logTaskSuccess, logTaskError } from '../utils/task-logger.js'
import {
  mapBreakdownToAssets,
  mapBreakdownToStoryboards,
  type ReaVideoBreakdown,
} from './rea-video-map.js'

export interface DecomposeOptions {
  lang?: 'zh' | 'en'
  vlm?: boolean
  envFile?: string
  binary?: string
  granularity?: 'segment' | 'shot'
}

export interface ReferenceImportResult {
  storyboards: number
  characters: number
  scenes: number
  props: number
}

function resolveBinary(opts?: DecomposeOptions): string {
  return opts?.binary || process.env.REA_VIDEO_BIN || 'rea-video'
}

/** 探测 rea-video CLI 是否可用（spawn --help 一次） */
export async function checkReaVideo(binary?: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(resolveBinary({ binary }), ['--help'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/** 调 rea-video decompose 拆解参考视频，返回 breakdown.json 路径 */
export async function runReaVideoDecompose(
  videoPath: string,
  outDir: string,
  opts: DecomposeOptions = {},
): Promise<string> {
  const binary = resolveBinary(opts)
  const args = ['decompose', videoPath, '-o', outDir, '--lang', opts.lang || 'zh']
  if (opts.envFile) args.push('--env-file', opts.envFile)
  if (opts.vlm) args.push('--vlm')

  await fs.mkdir(outDir, { recursive: true })
  logTaskStart('ReaVideo', 'decompose', { videoPath, outDir, binary, vlm: opts.vlm === true })

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`rea-video decompose 失败 (exit ${code})：${stderr.slice(-1000)}`))
    })
  })

  const breakdownPath = path.join(outDir, 'breakdown.json')
  await fs.access(breakdownPath)
  logTaskSuccess('ReaVideo', 'decompose', { outDir, breakdownPath })
  return breakdownPath
}

/** 把 rea-video 的首尾帧图复制进 huobao 存储，返回 storage 相对路径（缺失时返回 undefined） */
async function copyReferenceFrame(sourceDir: string, relPath: string | undefined, episodeId: number): Promise<string | undefined> {
  if (!relPath) return undefined
  try {
    const buf = await fs.readFile(path.join(sourceDir, relPath))
    const subDir = `reference/${episodeId}`
    const dir = path.join(STORAGE_ROOT, subDir)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, path.basename(relPath)), buf)
    return `static/${subDir}/${path.basename(relPath)}`
  } catch {
    return undefined
  }
}

/** 把 breakdown 写入 huobao：分镜段落（替换本集旧分镜）+ 资产（best-effort，追加） */
export async function importReferenceBreakdown(
  breakdown: ReaVideoBreakdown,
  episodeId: number,
  dramaId: number,
  sourceDir?: string,
  granularity?: 'segment' | 'shot',
): Promise<ReferenceImportResult> {
  const ts = now()

  // 1) 清空本集已有分镜（replace_existing 语义，只清分镜不动资产）
  const existing = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
  for (const sb of existing) {
    await db.delete(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
    await db.delete(schema.storyboardProps)
      .where(eq(schema.storyboardProps.storyboardId, sb.id))
  }
  await db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))

  // 1.5) 替换本集旧资产：多次拆解不再累积重复角色/场景/道具。
  // 先解绑本集，再删除只被本集使用（无其它集引用）的资产。
  const oldCharLinks = await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId))
  const oldPropLinks = await db.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId))
  const oldSceneLinks = await db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId))
  await db.delete(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId))
  await db.delete(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId))
  await db.delete(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId))

  for (const l of oldCharLinks) {
    const remaining = await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.characterId, l.characterId))
    if (remaining.length === 0) await db.delete(schema.characters).where(eq(schema.characters.id, l.characterId))
  }
  for (const l of oldPropLinks) {
    const remaining = await db.select().from(schema.episodeProps).where(eq(schema.episodeProps.propId, l.propId))
    if (remaining.length === 0) await db.delete(schema.props).where(eq(schema.props.id, l.propId))
  }
  const epScenes = await db.select().from(schema.scenes).where(eq(schema.scenes.episodeId, episodeId))
  for (const s of epScenes) await db.delete(schema.scenes).where(eq(schema.scenes.id, s.id))
  for (const l of oldSceneLinks) {
    const remaining = await db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.sceneId, l.sceneId))
    if (remaining.length === 0) {
      const [sc] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, l.sceneId))
      if (sc && sc.episodeId == null) await db.delete(schema.scenes).where(eq(schema.scenes.id, l.sceneId))
    }
  }

  // 2) 资产：先建，并记录 cast key → DB id 映射，供分镜绑定
  const assets = mapBreakdownToAssets(breakdown)
  const charIdMap = new Map<string, number>()
  for (const c of assets.characters) {
    const res = await db.insert(schema.characters).values({
      dramaId, name: c.name, role: c.role, appearance: c.appearance, description: c.description,
      createdAt: ts, updatedAt: ts,
    })
    const dbId = getInsertId(res)
    if (c.key) charIdMap.set(c.key, dbId)
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId: dbId, createdAt: ts })
  }

  const sceneIdMap = new Map<string, number>()
  for (const s of assets.scenes) {
    const res = await db.insert(schema.scenes).values({
      dramaId, episodeId, location: s.location, time: s.time, prompt: s.prompt,
      createdAt: ts, updatedAt: ts,
    })
    const dbId = getInsertId(res)
    if (s.key) sceneIdMap.set(s.key, dbId)
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId: dbId, createdAt: ts })
  }

  const propIdMap = new Map<string, number>()
  for (const p of assets.props) {
    const res = await db.insert(schema.props).values({
      dramaId, name: p.name, description: p.description,
      createdAt: ts, updatedAt: ts,
    })
    const dbId = getInsertId(res)
    if (p.key) propIdMap.set(p.key, dbId)
    await db.insert(schema.episodeProps).values({ episodeId, propId: dbId, createdAt: ts })
  }

  // 3) 分镜：绑定场景 + 角色 + 道具
  const seeds = mapBreakdownToStoryboards(breakdown, { granularity })
  for (const seed of seeds) {
    const firstFrameImage = sourceDir ? await copyReferenceFrame(sourceDir, seed.firstFrame, episodeId) : undefined
    const lastFrameImage = sourceDir ? await copyReferenceFrame(sourceDir, seed.lastFrame, episodeId) : undefined
    const res = await db.insert(schema.storyboards).values({
      episodeId,
      storyboardNumber: seed.storyboardNumber,
      title: seed.title,
      shotType: seed.shotType,
      angle: seed.angle,
      movement: seed.movement,
      description: seed.description,
      imagePrompt: seed.imagePrompt,
      videoPrompt: seed.videoPrompt,
      duration: seed.duration,
      sceneId: seed.sceneKey ? (sceneIdMap.get(seed.sceneKey) ?? null) : null,
      firstFrameImage,
      lastFrameImage,
      createdAt: ts,
      updatedAt: ts,
    })
    const sbId = getInsertId(res)
    for (const ck of seed.characterKeys ?? []) {
      const cid = charIdMap.get(ck)
      if (cid) await db.insert(schema.storyboardCharacters).values({ storyboardId: sbId, characterId: cid })
    }
    for (const pk of seed.propKeys ?? []) {
      const pid = propIdMap.get(pk)
      if (pid) await db.insert(schema.storyboardProps).values({ storyboardId: sbId, propId: pid })
    }
  }

  // 4) 回写本集时长（秒 → 分钟，与 save_storyboards 一致）
  const rows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
  const totalDuration = rows.filter(sb => !sb.deletedAt).reduce((n, sb) => n + (sb.duration || 0), 0)
  await db.update(schema.episodes)
    .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
    .where(eq(schema.episodes.id, episodeId))

  const result: ReferenceImportResult = {
    storyboards: seeds.length,
    characters: assets.characters.length,
    scenes: assets.scenes.length,
    props: assets.props.length,
  }
  logTaskSuccess('ReaVideo', 'import', { episodeId, dramaId, ...result })
  return result
}

/** 生成一个 rea-video 拆解输出目录（系统临时目录下，带时间戳） */
export function defaultReaVideoOutDir(episodeId: number): string {
  return path.join(os.tmpdir(), 'rea-video', `${episodeId}-${Date.now()}`)
}

export interface ReferenceAnalyzeTask {
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at?: string
  progress?: 'decomposing' | 'importing'
  result?: ReferenceImportResult
  breakdownPath?: string
  error?: string
}

// 内存态任务表：按集跟踪「参考片拆解」。页面刷新不丢（只要后端进程不重启即可恢复查询）；
// 同集已在进行中时 startReferenceAnalyze 返回 false，避免并发重复触发。
const referenceTasks = new Map<number, ReferenceAnalyzeTask>()

export function getReferenceAnalyzeStatus(episodeId: number): ReferenceAnalyzeTask | null {
  return referenceTasks.get(episodeId) ?? null
}

/** 启动异步拆解（立即返回）；decompose + import 在后台跑，进度写入任务表 */
export function startReferenceAnalyze(
  episodeId: number,
  dramaId: number,
  videoPath: string,
  outDir: string,
  opts: DecomposeOptions = {},
): boolean {
  if (referenceTasks.get(episodeId)?.status === 'running') return false

  const task: ReferenceAnalyzeTask = { status: 'running', started_at: now(), progress: 'decomposing' }
  referenceTasks.set(episodeId, task)
  logTaskStart('ReaVideo', 'analyze-task', { episodeId, videoPath, vlm: opts.vlm === true })

  ;(async () => {
    try {
      const breakdownPath = await runReaVideoDecompose(videoPath, outDir, opts)
      task.breakdownPath = breakdownPath
      task.progress = 'importing'
      const raw = await fs.readFile(breakdownPath, 'utf8')
      const breakdown = JSON.parse(raw) as ReaVideoBreakdown
      task.result = await importReferenceBreakdown(breakdown, episodeId, dramaId, outDir, opts.granularity)
      task.status = 'done'
      logTaskSuccess('ReaVideo', 'analyze-task', { episodeId, ...task.result })
    } catch (err) {
      task.status = 'error'
      task.error = err instanceof Error ? err.message : '拆解失败'
      logTaskError('ReaVideo', 'analyze-task', { episodeId, error: task.error })
    } finally {
      task.finished_at = now()
    }
  })()

  return true
}
