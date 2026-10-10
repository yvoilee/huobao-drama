/**
 * 火山引擎 Seedance 2.0 视频生成 Adapter
 * 端点: /api/v3/contents/generations/tasks (注意 /api/v3 前缀)
 * 响应: { id: "task-xxx" } -> 轮询获取状态
 *
 * 仅支持 Doubao Seedance 2.0+ 系列模型，生成模式只保留多模态参考:
 * - reference   多模态参考（≤9 reference_image + ≤3 reference_video + ≤3 reference_audio + 可选文本）
 *   有参考音频时至少包含 1 个参考图片或视频
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

/** 仅支持 Seedance 2.0+ 系列（前缀匹配，兼容未来 2.0.x 变体） */
const SEEDANCE2_MODEL_PREFIX = 'doubao-seedance-2-0'
/** Seedance 2.5 系列（Ark 短横线命名 doubao-seedance-2-5），支持最长 30 秒直出 */
const SEEDANCE25_MODEL_PREFIX = 'doubao-seedance-2-5'
const DEFAULT_MODEL = 'doubao-seedance-2-0-mini-260615'

/** 多模态参考素材上限：图片 9、视频 3、音频 3（Seedance 2.0） */
const REF_LIMITS = { images: 9, videos: 3, audios: 3 } as const
/** Seedance 2.5 参考素材上限：图片 30、视频 10、音频 10 */
const REF_LIMITS_25 = { images: 30, videos: 10, audios: 10 } as const

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

export class VolcEngineVideoAdapter implements VideoProviderAdapter {
  provider = 'volcengine'

  /** 方舟接口前缀：普通方舟 /api/v3，AgentPlan 企业版 /api/plan/v3（子类覆写） */
  protected apiPrefix = '/api/v3'

  /** 默认模型 */
  protected defaultModel = DEFAULT_MODEL

  /** 支持的模型前缀；AgentPlan 子类覆写以兼容其模型命名空间（dot 命名 doubao-seedance-2.0） */
  protected modelPrefixes: string[] = [SEEDANCE2_MODEL_PREFIX, SEEDANCE25_MODEL_PREFIX]

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || this.defaultModel
    if (!this.modelPrefixes.some((p) => model.startsWith(p))) {
      throw new Error(`仅支持 Seedance 系列模型（${this.modelPrefixes.join(' / ')}*），当前: ${model}`)
    }

    const prompt = (record.prompt || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)

    const refLimits = this.isSeedance25(model) ? REF_LIMITS_25 : REF_LIMITS
    if (refImages.length > refLimits.images || refVideos.length > refLimits.videos || refAudios.length > refLimits.audios) {
      throw new Error(`参考素材超限：图片≤${refLimits.images}、视频≤${refLimits.videos}、音频≤${refLimits.audios}`)
    }
    if (refAudios.length > 0 && refImages.length + refVideos.length === 0) {
      throw new Error('参考音频需要至少 1 个参考图片或视频')
    }
    if (!prompt && !refImages.length && !refVideos.length && !refAudios.length) {
      throw new Error('多模态参考模式需要至少一个参考素材或 prompt')
    }

    const content: any[] = []
    if (prompt) content.push({ type: 'text', text: prompt })
    for (const url of refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of refAudios) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    }

    const body: any = {
      model,
      content,
      generate_audio: record.generateAudio !== 0 && record.generateAudio !== false,
      ratio: record.aspectRatio || 'adaptive',
      duration: this.normalizeDuration(record.duration, model),
      resolution: this.normalizeResolution(record.resolution, model),
      watermark: false,
    }

    return {
      url: joinProviderUrl(config.baseUrl, this.apiPrefix, '/contents/generations/tasks'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result.id) {
      return { isAsync: true, taskId: result.id }
    }
    // 同步返回
    const videoUrl = result.video_url || result.content?.video_url || result.data?.video_url
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }
    throw new Error('No task_id or video_url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, this.apiPrefix, `/contents/generations/tasks/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result.status
    if (status === 'succeeded') {
      const videoUrl = result.video_url || result.content?.video_url || result.data?.video_url
      return {
        status: 'completed',
        videoUrl,
      }
    }
    if (status === 'failed') {
      // 上游 error 可能是对象 { code, message }（如 OutputVideoSensitiveContentDetected），规范成字符串
      const err = result.error
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err) || 'Video generation failed')
      const code = err && typeof err === 'object' && err.code ? `[${err.code}] ` : ''
      return { status: 'failed', error: `${code}${msg}` }
    }
    return { status: status || 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.video_url || result.content?.video_url || result.data?.video_url || null
  }

  /** 是否为 Seedance 2.5 系列（AgentPlan 子类用点命名 doubao-seedance-2.5，覆写此方法） */
  protected isSeedance25(model: string): boolean {
    return model.startsWith(SEEDANCE25_MODEL_PREFIX)
  }

  private normalizeDuration(duration?: number | null, model?: string): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed)) return 5
    // Seedance 2.0 支持 4-15 秒；2.5 支持 4-30 秒
    const max = model && this.isSeedance25(model) ? 30 : 15
    return Math.min(max, Math.max(4, parsed))
  }

  /** Seedance 2.0 仅 480p/720p 两档；2.5 额外支持 1080p，其余档位统一收敛到 720p */
  private normalizeResolution(resolution?: string | null, model?: string): string {
    if (resolution === '480p') return '480p'
    if (resolution === '1080p' && model && this.isSeedance25(model)) return '1080p'
    return '720p'
  }
}
