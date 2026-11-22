/**
 * 参考片复刻入口：拆解参考视频并映射为当前集的分镜（+ 资产）。
 *
 * POST /api/v1/reference/analyze
 * body: { episode_id: number, video_path: string, lang?: 'zh'|'en', vlm?: boolean, env_file?: string }
 * video_path 可为绝对路径，或相对 STORAGE_ROOT 的路径。
 *
 * 依赖 rea-video CLI（Python）。未安装时返回明确错误，不影响其它路由。
 */
import { Hono } from 'hono'
import fs from 'fs/promises'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, serverError } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { logTaskStart } from '../utils/task-logger.js'
import {
  checkReaVideo,
  startReferenceAnalyze,
  getReferenceAnalyzeStatus,
  defaultReaVideoOutDir,
} from '../services/rea-video.js'

const app = new Hono()

function resolveVideoPath(videoPath: string): string {
  // 上传接口返回 "static/uploads/xxx.mp4"（相对 DATA_ROOT），统一走 getAbsolutePath 解析；
  // 绝对路径原样使用，便于直接拆解本地参考片。
  return path.isAbsolute(videoPath) ? videoPath : getAbsolutePath(videoPath)
}

// POST /reference/analyze
app.post('/analyze', async (c) => {
  const body = await c.req.json().catch(() => null)
  const episodeId = Number(body?.episode_id)
  const videoPath = String(body?.video_path ?? '').trim()

  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, '缺少有效 episode_id')
  if (!videoPath) return badRequest(c, '缺少 video_path')

  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) return badRequest(c, '该集不存在')

  const ok = await checkReaVideo()
  if (!ok) {
    return serverError(c, '未检测到 rea-video CLI。请先安装（pip/pipx/uv 安装 rea-video 并确保 rea-video 在 PATH 中，或设置 REA_VIDEO_BIN）。')
  }

  const resolved = resolveVideoPath(videoPath)
  try {
    await fs.access(resolved)
  } catch {
    return badRequest(c, `参考视频不存在：${resolved}`)
  }

  const outDir = defaultReaVideoOutDir(episodeId)
  // VLM 配置：请求可显式传 env_file/vlm；未传时读 REA_VIDEO_ENV_FILE（后端环境变量）默认启用。
  const envFile = body?.env_file || process.env.REA_VIDEO_ENV_FILE || undefined
  const useVlm = body?.vlm === true || (body?.vlm !== false && Boolean(envFile))

  // 异步执行：立即返回，decompose + import 在后台跑，进度可经 GET /status 查询（刷新页面不丢）
  const started = startReferenceAnalyze(episodeId, episode.dramaId, resolved, outDir, {
    lang: body?.lang === 'en' ? 'en' : 'zh',
    vlm: useVlm,
    envFile,
    granularity: body?.granularity === 'shot' ? 'shot' : 'segment',
  })
  if (!started) return success(c, { started: false, message: '已有进行中的拆解任务' })
  logTaskStart('ReaVideo', 'analyze-start', { episodeId, videoPath: resolved, vlm: useVlm })
  return success(c, { started: true, episode_id: episodeId })
})

// GET /reference/status/:episodeId — 查询「参考片拆解」任务进度（running/done/error/idle）
app.get('/status/:episodeId', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, '缺少有效 episode_id')
  return success(c, getReferenceAnalyzeStatus(episodeId) ?? { status: 'idle' })
})

export default app
