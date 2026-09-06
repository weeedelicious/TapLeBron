import seedanceVideoRules from '../../shared/seedance-video-rules.json'

export type VideoModeKey = 't2v' | 'i2v' | 'keyframe' | 'omni' | 'video-edit' | 'extend'

export interface VideoRatioOption {
  value: string
  label: string
  w: number
  h: number
}

interface VideoCountRule {
  min: number
  max: number
}

interface VideoModeRule {
  label: string
  aliases?: string[]
  promptRequired?: boolean
  requiresAnyOf?: Array<'prompt' | 'image' | 'video' | 'audio'>
  inputs: {
    images: VideoCountRule
    videos: VideoCountRule
    audios: VideoCountRule
  }
}

interface VideoModelRule {
  extends?: string
  label?: string
  provider?: 'seedance' | 'minimax'
  providerModel?: string
  frontendSelectable?: boolean
  modes?: VideoModeKey[]
  ratios?: string[]
  modeRatios?: Partial<Record<VideoModeKey, string[]>>
  resolutions?: string[]
  /** 个别清晰度有需要提醒用户的代价（比如 10bit HEVC 不一定能直接播），按清晰度给一句话。 */
  resolutionNotes?: Record<string, string>
  duration?: { min: number; max: number; step: number; default: number }
  modeDurations?: Partial<Record<VideoModeKey, { min: number; max: number; step: number; default: number }>>
  modeInputs?: Partial<Record<VideoModeKey, VideoModeRule['inputs']>>
  audio?: Array<'on' | 'off'>
  generationCounts?: number[]
  referenceVideo?: {
    maxCount: number
    minDurationSec: number
    maxDurationSec: number
    maxTotalDurationSec: number
    maxBytes: number
    targetBytesRatio: number
    minPixels: number
    maxPixels: number
    minAspectRatio: number
    maxAspectRatio: number
  }
}

interface VideoRules {
  defaults: {
    model: string
    mode: VideoModeKey
    ratio: string
    resolution: string
    duration: number
    enableSound: 'on' | 'off'
    count: number
  }
  ratioOptions: VideoRatioOption[]
  models: Record<string, VideoModelRule>
  modes: Record<VideoModeKey, VideoModeRule>
}

const rules = seedanceVideoRules as VideoRules

const aliasToMode = Object.entries(rules.modes).reduce<Record<string, VideoModeKey>>((acc, [mode, rule]) => {
  acc[mode.toLowerCase()] = mode as VideoModeKey
  for (const alias of rule.aliases ?? []) acc[String(alias).toLowerCase()] = mode as VideoModeKey
  return acc
}, {})

export const VIDEO_RATIO_OPTIONS = rules.ratioOptions
export const VIDEO_DEFAULTS = rules.defaults

export function normalizeVideoModeKey(mode?: string): VideoModeKey {
  return aliasToMode[String(mode || '').trim().toLowerCase()] ?? rules.defaults.mode
}

export function getVideoModeRule(mode?: string): VideoModeRule {
  return rules.modes[normalizeVideoModeKey(mode)]
}

export function getVideoEffectiveModeRule(model?: string, mode?: string): VideoModeRule {
  const modeKey = normalizeVideoModeKey(mode)
  const modeRule = rules.modes[modeKey]
  const inputOverride = getVideoModelRule(model).modeInputs?.[modeKey]
  return inputOverride ? { ...modeRule, inputs: inputOverride } : modeRule
}

export function getVideoModelRule(model?: string): Required<Omit<VideoModelRule, 'extends'>> {
  const key = String(model || rules.defaults.model)
  const raw = rules.models[key] ?? rules.models[rules.defaults.model]
  if (raw?.extends) {
    const parent = rules.models[raw.extends] ?? rules.models[rules.defaults.model]
    return { ...parent, ...raw, extends: undefined } as Required<Omit<VideoModelRule, 'extends'>>
  }
  return raw as Required<Omit<VideoModelRule, 'extends'>>
}

export function listSelectableVideoModels() {
  return Object.entries(rules.models)
    .filter(([, rule]) => rule.frontendSelectable === true)
    .map(([value]) => {
      const rule = getVideoModelRule(value)
      return { value, label: rule.label || value }
    })
}

export function getVideoModeOptions(model?: string) {
  const modelRule = getVideoModelRule(model)
  return (modelRule.modes ?? [rules.defaults.mode]).map((mode) => ({
    key: mode,
    label: rules.modes[mode]?.label ?? mode,
  }))
}

export type VideoRefKind = 'images' | 'videos' | 'audios'

const REF_KIND_LABEL: Record<VideoRefKind, string> = {
  images: '图片',
  videos: '视频',
  audios: '音频',
}

/** 这个模式下某类参考素材的数量区间。界面和校验都用它，不要各自算。 */
export function getVideoRefRule(model: string | undefined, mode: string | undefined, kind: VideoRefKind) {
  return getVideoEffectiveModeRule(model, mode).inputs[kind]
}

/** 这个模型里，哪些模式**收**这类参考素材。用来在报错时告诉用户「该去哪个模式」。 */
export function modesAcceptingRef(model: string | undefined, kind: VideoRefKind) {
  const modelRule = getVideoModelRule(model)
  return (modelRule.modes ?? [])
    .filter((mode) => getVideoRefRule(model, mode, kind).max > 0)
    .map((mode) => rules.modes[mode]?.label ?? mode)
}

/**
 * 参考素材数量不合规时说人话。
 *
 * 原来一律套「最多支持 N 个」，N=0 时就变成「视频编辑最多支持 0 个图片参考」——
 * 这句话读起来像 bug 而不像说明，而且没告诉用户接下来该怎么办
 * （2026-08-26 用户在 Seedance 2.5 的视频编辑里连了参考图，看到的就是这句）。
 *
 * max 为 0 时改成「不支持」，并顺手报出这个模型里哪些模式收这类素材。
 * 模式名从配置里取，不写死。
 */
export function videoRefCountError(
  model: string | undefined,
  mode: string | undefined,
  kind: VideoRefKind,
  count: number,
): string {
  const modeRule = getVideoEffectiveModeRule(model, mode)
  const rule = modeRule.inputs[kind]
  const label = REF_KIND_LABEL[kind]
  if (count < rule.min) return `${modeRule.label}至少需要 ${rule.min} 个${label}参考`
  if (count <= rule.max) return ''
  if (rule.max === 0) {
    const alternatives = modesAcceptingRef(model, kind)
    const hint = alternatives.length ? `，可以改用「${alternatives.join(' / ')}」模式` : ''
    return `${modeRule.label}不支持${label}参考${hint}`
  }
  return `${modeRule.label}最多支持 ${rule.max} 个${label}参考，当前有 ${count} 个`
}

/**
 * 参考视频那行说明。以前是写死在 VideoNode 里的一句「单个 2-15s，最多 3 个，总时长 ≤ 15s」——
 * 那是 Seedance 2.0 的数字，2.5 上是 2-30s / 最多 10 个 / ≤30s，说明和实际校验对不上，
 * 用户按说明摆素材反而会被拦（2026-08-26 发现）。现在一律从模型规则算。
 *
 * 条数取 `min(模型的参考视频上限, 当前模式的视频上限)`：2.5 的视频编辑模式只收 1 条，
 * 光报模型上限 10 条是骗人的。
 */
export function videoReferenceNote(model?: string, mode?: string): string {
  const reference = getVideoModelRule(model).referenceVideo
  if (!reference) return ''
  const modeMax = getVideoRefRule(model, mode, 'videos').max
  const maxCount = Math.max(0, Math.min(reference.maxCount ?? 0, modeMax))
  if (maxCount <= 0) return ''
  const parts = [
    'mp4 / mov',
    `单个 ${reference.minDurationSec}-${reference.maxDurationSec}s`,
    `最多 ${maxCount} 个`,
  ]
  // 只能放 1 条时「总时长」和「单个时长」是同一件事，别重复说
  if (maxCount > 1) parts.push(`总时长 ≤ ${reference.maxTotalDurationSec}s`)
  return `参考视频：${parts.join('，')}`
}

function getModeSpecificRatios(model?: string, mode?: string) {
  const modelRule = getVideoModelRule(model)
  const modeKey = mode ? normalizeVideoModeKey(mode) : undefined
  return (modeKey ? modelRule.modeRatios?.[modeKey] : undefined) ?? modelRule.ratios ?? [rules.defaults.ratio]
}

export function getVideoRatioOptions(model?: string, mode?: string) {
  const allowed = new Set(getModeSpecificRatios(model, mode))
  return rules.ratioOptions.filter((option) => allowed.has(option.value))
}

export function getVideoResolutionOptions(model?: string) {
  const modelRule = getVideoModelRule(model)
  return modelRule.resolutions ?? [rules.defaults.resolution]
}

/** 当前清晰度要不要给用户一句提醒；没有就返回空串。 */
export function getVideoResolutionNote(model: string | undefined, resolution?: string) {
  if (!resolution) return ''
  return getVideoModelRule(model).resolutionNotes?.[resolution] ?? ''
}

export function getVideoDurationRule(model?: string, mode?: string) {
  const modelRule = getVideoModelRule(model)
  const modeKey = mode ? normalizeVideoModeKey(mode) : undefined
  return (modeKey ? modelRule.modeDurations?.[modeKey] : undefined) ?? modelRule.duration ?? { min: 4, max: 15, step: 1, default: rules.defaults.duration }
}

export function normalizeVideoRatioValue(model: string | undefined, ratio?: string, mode?: string) {
  const value = ratio === 'auto' ? 'adaptive' : String(ratio || rules.defaults.ratio)
  const options = getVideoRatioOptions(model, mode)
  if (options.some((option) => option.value === value)) return value
  return options.some((option) => option.value === rules.defaults.ratio)
    ? rules.defaults.ratio
    : options[0]?.value || rules.defaults.ratio
}

export function normalizeVideoResolutionValue(model: string | undefined, resolution?: string) {
  const options = getVideoResolutionOptions(model)
  const value = String(resolution || rules.defaults.resolution)
  if (options.includes(value)) return value
  return options.includes(rules.defaults.resolution) ? rules.defaults.resolution : options[0] || rules.defaults.resolution
}

export function normalizeVideoDurationValue(model: string | undefined, duration?: number, mode?: string) {
  const durationRule = getVideoDurationRule(model, mode)
  const value = Number(duration)
  if (!Number.isFinite(value)) return durationRule.default
  return Math.min(durationRule.max, Math.max(durationRule.min, Math.round(value)))
}

export function getVideoGenerationCounts(model: string | undefined, _hasImageReference?: boolean) {
  return getVideoModelRule(model).generationCounts ?? [1]
}

export function normalizeVideoGenerationCount(model: string | undefined, count: number | undefined, hasImageReference: boolean) {
  const options = getVideoGenerationCounts(model, hasImageReference)
  const value = Number(count || 1)
  return options.includes(value) ? value : options[0] || 1
}

export function validateVideoCapability(input: {
  model?: string
  mode?: string
  prompt?: string
  imageCount: number
  videoCount: number
  audioCount: number
  ratio?: string
  resolution?: string
  duration?: number
  count?: number
}) {
  const modelRule = getVideoModelRule(input.model)
  const mode = normalizeVideoModeKey(input.mode)
  const modeRule = getVideoEffectiveModeRule(input.model, mode)
  const supportedModes = new Set(modelRule.modes ?? [])
  const prompt = String(input.prompt || '').trim()

  if (!supportedModes.has(mode)) return `${modelRule.label} 不支持${modeRule.label}`
  if (normalizeVideoRatioValue(input.model, input.ratio, mode) !== (input.ratio === 'auto' ? 'adaptive' : input.ratio)) {
    return `${modelRule.label} 不支持比例 ${input.ratio || ''}`
  }
  if (normalizeVideoResolutionValue(input.model, input.resolution) !== String(input.resolution || '')) {
    return `${modelRule.label} 不支持清晰度 ${input.resolution || ''}`
  }
  const durationRule = getVideoDurationRule(input.model, mode)
  const duration = Number(input.duration)
  if (!Number.isFinite(duration) || duration < durationRule.min || duration > durationRule.max) {
    return `${modelRule.label} 时长需在 ${durationRule.min}-${durationRule.max} 秒之间`
  }

  if (modeRule.promptRequired && !prompt) return `${modeRule.label}需要填写提示词`
  const required = new Set(modeRule.requiresAnyOf ?? [])
  if (
    required.size > 0 &&
    !(
      (required.has('prompt') && prompt) ||
      (required.has('image') && input.imageCount > 0) ||
      (required.has('video') && input.videoCount > 0) ||
      (required.has('audio') && input.audioCount > 0)
    )
  ) {
    return `${modeRule.label}需要提示词或符合模式的参考素材`
  }

  const checks: Array<[VideoRefKind, number]> = [
    ['images', input.imageCount],
    ['videos', input.videoCount],
    ['audios', input.audioCount],
  ]
  for (const [kind, count] of checks) {
    const message = videoRefCountError(input.model, mode, kind, count)
    if (message) return message
  }

  const countOptions = getVideoGenerationCounts(input.model, input.imageCount > 0)
  const requestCount = Number(input.count || 1)
  if (!countOptions.includes(requestCount)) return `${modeRule.label}当前只支持生成 ${countOptions.join('/')} 个视频`
  return ''
}
