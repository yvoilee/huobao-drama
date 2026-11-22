/**
 * rea-video 拆解结果（breakdown.json）→ huobao 分镜/资产 的纯映射。
 *
 * 只做数据形状转换，不碰数据库和子进程，便于单测。
 * 参考片复刻：rea-video 把参考视频拆成 shot（实际切镜，3–6s）和
 * production_plan.units（生成单元 = 连续镜头一次生成，对应 huobao 的「分镜段落」）。
 * 这里把 unit → storyboard（分镜段落），unit 内的 shots → 段落内子镜头（【镜头N】描述）。
 */

export interface ReaVideoShot {
  index: number
  start: number
  end: number
  duration: number
  base?: { label?: string; label_zh?: string; confidence?: number }
  verdict?: string
  aspects?: {
    framing?: { result?: { shot_size?: string | null } }
    camera?: { result?: { move?: string | null; support_zh?: string | null } }
  }
  assets?: { first_frame?: string; last_frame?: string }
}

export interface ReaVideoUnit {
  id?: string
  kind?: string
  label?: string
  label_zh?: string
  shots?: number[]
  start?: number
  end?: number
  duration?: number
  model?: string
  prompt?: string
  image_prompt?: string
  note?: string
}

export interface ReaVideoCast {
  style?: string
  characters?: Array<{
    id?: string
    name?: string
    kind?: string
    look?: string
    role?: string
    voice?: string
    shots?: number[]
  }>
  scenes?: Array<{ id?: string; where?: string; when?: string; look?: string; shots?: number[] }>
  props?: Array<{ name?: string; note?: string; shots?: number[] }>
}

export interface ReaVideoBreakdown {
  shots?: ReaVideoShot[]
  production_plan?: { units?: ReaVideoUnit[] }
  cast?: ReaVideoCast | null
  review_cast?: ReaVideoCast | null
  /** 整片 VLM 分析结果；里面 characters/scenes/props/style 与 cast 同构 */
  whole_video_vlm?: ReaVideoCast | null
}

/** 落库用：storyboards 表的种子行（不含 episodeId/时间戳，由 importer 补） */
export interface StoryboardSeed {
  storyboardNumber: number
  title?: string
  shotType?: string
  angle?: string
  movement?: string
  description?: string
  imagePrompt?: string
  videoPrompt?: string
  duration: number
  /** 绑定的场景 id（cast.scenes[].id，如 "S1"），importer 用它解析 sceneId */
  sceneKey?: string
  /** 绑定的角色 id（cast.characters[].id，如 "A"），importer 用它建 storyboard_characters */
  characterKeys?: string[]
  /** 绑定的道具名（cast.props[].name），importer 用它建 storyboard_props */
  propKeys?: string[]
  /** 段首帧 / 段尾帧（rea-video 输出目录里的相对路径），importer 复制后写入 firstFrameImage/lastFrameImage */
  firstFrame?: string
  lastFrame?: string
}

/** 落库用：characters / scenes / props 的种子（best-effort，仅当拆解带 cast 时非空） */
export interface AssetSeed {
  characters: Array<{ key?: string; name: string; role?: string; appearance?: string; description?: string }>
  scenes: Array<{ key?: string; location: string; time: string; prompt: string }>
  props: Array<{ key?: string; name: string; description?: string }>
}

const SHOT_SIZE_ZH: Record<string, string> = {
  'extreme close-up': '特写',
  'close-up': '近景',
  'medium close-up': '中近景',
  'medium shot': '中景',
  'full shot': '全景',
  'long shot': '远景',
  'medium long shot': '中远景',
}

const CAMERA_MOVE_ZH: Record<string, string> = {
  static: '固定',
  'push-in': '推镜',
  'pull-out': '拉镜',
  pan: '摇镜',
  'smooth_move': '移镜',
  tracking: '跟镜',
  handheld: '手持',
}

function shotSizeZh(size?: string | null): string | undefined {
  if (!size) return undefined
  return SHOT_SIZE_ZH[size.toLowerCase()] ?? size
}

function cameraMoveZh(move?: string | null, supportZh?: string | null): string | undefined {
  if (move) {
    const mapped = CAMERA_MOVE_ZH[move.toLowerCase()]
    if (mapped) return mapped
    return move
  }
  return supportZh || undefined
}

function shotByIndex(breakdown: ReaVideoBreakdown, index: number): ReaVideoShot | undefined {
  return breakdown.shots?.find(s => s.index === index)
}

function fmtSeconds(v?: number): string {
  return typeof v === 'number' ? `${v.toFixed(1)}s` : ''
}

/** 段落内子镜头描述：把 unit 内每个 shot 写成一行【镜头N】… */
function buildDescription(subShots: ReaVideoShot[]): string {
  if (!subShots.length) return ''
  return subShots
    .map((s, i) => {
      const label = s.base?.label_zh || s.base?.label || s.verdict || ''
      const size = shotSizeZh(s.aspects?.framing?.result?.shot_size)
      const parts = [`【镜头${i + 1}】`, `${fmtSeconds(s.start)}–${fmtSeconds(s.end)}`]
      if (label) parts.push(label)
      if (size) parts.push(size)
      return parts.join(' ')
    })
    .join('\n')
}

/**
 * shots → storyboard 种子。
 * 把镜头按时间聚合成约 TARGET_SEGMENT_S 的段落（快剪片 25s 约得到 2-3 段），
 * 每个段落带场景/角色/道具的绑定键（cast 里的 id/name），由 importer 解析成 sceneId 和关联表。
 */
const MIN_RUN_S = 3  // 场景连续段少于 3s 就并入相邻段（避免 1-2 镜碎段）

function castOf(breakdown: ReaVideoBreakdown): ReaVideoCast | null | undefined {
  return breakdown.review_cast ?? breakdown.cast ?? breakdown.whole_video_vlm
}

/** 段落内出现次数最多的场景 key */
function dominantKey<K>(values: (K | undefined)[], fallback?: K): K | undefined {
  const counts = new Map<K, number>()
  for (const v of values) {
    if (v === undefined) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  if (!counts.size) return fallback
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

function shotDurationSum(shots: ReaVideoShot[]): number {
  return shots.reduce((n, s) => n + (s.duration || 0), 0)
}

/** 把 rea-video 的引用标签翻译成 huobao 约定：@图片N → @角色名；@视频N 整句去掉（huobao 用首尾帧做运动参考） */
function translatePrompt(raw: string, charNames: string[]): string {
  const charTags = charNames.map(n => `@${n}`).join(' ')
  return raw
    .replace(/@图片\d+/g, charTags || '')
    .replace(/参考\s*@视频\d+[^。；;\n]*[。；;]?/g, '')
    .replace(/@视频\d+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([。；;，,])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 合并多个 unit 的 prompt：子镜头（镜头N 行）连续重编号、setup 行去重；据此生成对齐的 description 和 videoPrompt */
function mergeNumberedPrompt(prompts: string[]): { videoPrompt: string; description: string } {
  const seenSetup = new Set<string>()
  const setupLines: string[] = []
  const shotLines: string[] = []

  for (const p of prompts) {
    for (const rawLine of p.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (/^镜头\d+/.test(line)) shotLines.push(line)
      else if (!seenSetup.has(line)) { seenSetup.add(line); setupLines.push(line) }
    }
  }

  const renumbered = shotLines.map((l, i) => l.replace(/^镜头\d+/, `镜头${i + 1}`))
  const videoPrompt = [...setupLines, ...renumbered].join('\n').trim()
  const description = renumbered.map((l, i) => l.replace(/^镜头\d+/, `【镜头${i + 1}】`)).join('\n')
  return { videoPrompt, description }
}

export function mapBreakdownToStoryboards(
  breakdown: ReaVideoBreakdown,
  opts: { granularity?: 'segment' | 'shot' } = {},
): StoryboardSeed[] {
  const granularity = opts.granularity ?? 'segment'
  const shots = (breakdown.shots ?? []).slice().sort((a, b) => a.start - b.start)
  if (!shots.length) return []

  const cast = castOf(breakdown)
  const units = breakdown.production_plan?.units ?? []

  // shot index → scene id / character ids / prop names
  const shotScene = new Map<number, string>()
  const shotChars = new Map<number, string[]>()
  const shotProps = new Map<number, string[]>()
  for (const sc of cast?.scenes ?? []) {
    for (const n of sc.shots ?? []) if (sc.id) shotScene.set(n, sc.id)
  }
  for (const c of cast?.characters ?? []) {
    for (const n of c.shots ?? []) {
      if (!c.id) continue
      const arr = shotChars.get(n) ?? []
      arr.push(c.id)
      shotChars.set(n, arr)
    }
  }
  for (const p of cast?.props ?? []) {
    for (const n of p.shots ?? []) {
      if (!p.name) continue
      const arr = shotProps.get(n) ?? []
      arr.push(p.name)
      shotProps.set(n, arr)
    }
  }

  // 按场景对齐聚合：连续同场景镜头归一段；过短的场景段并入前一段（既避免碎段，也不把多个场景塌缩成一个）
  const runs: ReaVideoShot[][] = []
  for (const s of shots) {
    const last = runs[runs.length - 1]
    if (last && shotScene.get(last[last.length - 1].index) === shotScene.get(s.index)) {
      last.push(s)
    } else {
      runs.push([s])
    }
  }
  const segments: ReaVideoShot[][] = []
  for (const run of runs) {
    const prev = segments[segments.length - 1]
    if (prev && shotDurationSum(run) < MIN_RUN_S) {
      prev.push(...run)
    } else {
      segments.push([...run])
    }
  }
  if (segments.length >= 2 && shotDurationSum(segments[segments.length - 1]) < MIN_RUN_S) {
    const tail = segments.pop()!
    segments[segments.length - 1].push(...tail)
  }

  const sceneWhere = (key?: string) => cast?.scenes?.find(s => s.id === key)?.where

  const buildSeed = (seg: ReaVideoShot[], i: number): StoryboardSeed => {
    const indices = seg.map(s => s.index)
    const sceneKeys = [...new Set(indices.map(n => shotScene.get(n)).filter(Boolean))] as string[]
    const sceneKey = dominantKey(sceneKeys, sceneKeys[0])
    const charKeys = [...new Set(indices.flatMap(n => shotChars.get(n) ?? []))]
    const propKeys = [...new Set(indices.flatMap(n => shotProps.get(n) ?? []))]

    const covering = units.filter(u => (u.shots ?? []).some(n => indices.includes(n)))
    const charNames = charKeys.map(ck => cast?.characters?.find(c => c.id === ck)?.name).filter(Boolean) as string[]
    const prompts = [...new Set(covering.map(u => u.prompt).filter((p): p is string => Boolean(p)))].map(p => translatePrompt(p, charNames))
    const imgPrompts = [...new Set(covering.map(u => u.image_prompt).filter((p): p is string => Boolean(p)))].map(p => translatePrompt(p, charNames))

    // 描述和视频提示词统一用子镜头编号（对齐）；无 VLM 提示词时回退到 shot 级描述
    const merged = prompts.length ? mergeNumberedPrompt(prompts) : null

    const first = seg[0]
    const title = sceneWhere(sceneKey)
      ?? (seg.length === 1 ? (first?.base?.label_zh || `镜头 ${first?.index ?? i + 1}`) : `段落 ${i + 1}`)
    return {
      storyboardNumber: i + 1,
      title,
      shotType: shotSizeZh(first?.aspects?.framing?.result?.shot_size),
      movement: cameraMoveZh(
        first?.aspects?.camera?.result?.move,
        first?.aspects?.camera?.result?.support_zh,
      ),
      description: merged?.description || buildDescription(seg),
      imagePrompt: imgPrompts.join('\n') || undefined,
      videoPrompt: merged?.videoPrompt || undefined,
      duration: Math.max(1, Math.round(shotDurationSum(seg))),
      sceneKey,
      characterKeys: charKeys,
      propKeys,
      firstFrame: seg[0]?.assets?.first_frame,
      lastFrame: seg[seg.length - 1]?.assets?.last_frame,
    }
  }

  // 逐镜头粒度：每个镜头一个分镜，保留快剪节奏（高保真还原）
  if (granularity === 'shot') {
    return shots.map((s, i) => buildSeed([s], i))
  }

  return segments.map((seg, i) => buildSeed(seg, i))
}

/**
 * cast / review_cast → 角色 / 场景 / 道具 种子（best-effort）。
 * 未开 VLM 且未做看图复核时拆解不带 cast，返回空数组。
 */
export function mapBreakdownToAssets(breakdown: ReaVideoBreakdown): AssetSeed {
  const cast = breakdown.review_cast ?? breakdown.cast ?? breakdown.whole_video_vlm
  if (!cast) return { characters: [], scenes: [], props: [] }

  const characters = (cast.characters ?? [])
    .filter(c => c.name || c.id)
    .map(c => ({
      key: c.id,
      name: c.name || c.id || '角色',
      role: c.role || undefined,
      appearance: c.look || undefined,
      description: c.look || undefined,
    }))

  const scenes = (cast.scenes ?? [])
    .filter(s => s.where || s.id)
    .map(s => ({
      key: s.id,
      location: s.where || s.id || '场景',
      time: s.when || '白天',
      prompt: s.look || s.where || '由参考片拆解的场景',
    }))

  const props = (cast.props ?? [])
    .filter(p => p.name)
    .map(p => ({ key: p.name, name: p.name!, description: p.note || undefined }))

  return { characters, scenes, props }
}
