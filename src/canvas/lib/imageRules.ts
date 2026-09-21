import imageModelRules from '../../shared/image-model-rules.json'

export interface ImageRatioOption {
  value: string
  label: string
  w: number
  h: number
}

interface ImageComputedSizeRule {
  targetAreas?: Record<string, number>
  fallback?: string
  step?: number
  maxWidth?: number
  maxHeight?: number
  maxAspectRatio?: number
}

export interface ImageProgressEstimateRule {
  text2imageSeconds: number
  image2imageSeconds: number
  resolutionMultipliers?: Record<string, number>
  extraOutputMultiplier?: number
  extraReferenceMultiplier?: number
}

interface ImageModelRule {
  extends?: string
  label?: string
  provider?: string
  providerModel?: string
  apiStyle?: string
  frontendSelectable?: boolean
  aliases?: string[]
  modes?: Array<'text2image' | 'image2image'>
  ratios?: string[]
  nativeRatios?: string[]
  resolutions?: string[]
  qualities?: string[]
  generationCounts?: number[]
  maxGenerationCount?: number
  maxReferenceImages?: number
  progressEstimate?: ImageProgressEstimateRule
  sequential?: boolean
  maxTotalImages?: number
  sizeStrategy?: 'native-map' | 'computed' | 'gemini-params' | 'seedream-size'
  nativeSizes?: Record<string, string | Record<string, string>>
  computedSize?: ImageComputedSizeRule
}

interface ImageRules {
  defaults: {
    model: string
    ratio: string
    resolution: string
    quality: string
    count: number
  }
  ratioOptions: ImageRatioOption[]
  resolutionOptions: string[]
  models: Record<string, ImageModelRule>
}

const rules = imageModelRules as ImageRules

const aliasToModel = Object.entries(rules.models).reduce<Record<string, string>>((acc, [model, rule]) => {
  const canonical = rule.extends || model
  acc[String(model).toLowerCase()] = canonical
  if (rule.label) acc[String(rule.label).toLowerCase()] = canonical
  for (const alias of rule.aliases ?? []) acc[String(alias).toLowerCase()] = canonical
  return acc
}, {})

export const IMAGE_RULES = rules
export const IMAGE_DEFAULTS = rules.defaults
export const IMAGE_RATIO_OPTIONS = rules.ratioOptions
export const IMAGE_RESOLUTION_OPTIONS = rules.resolutionOptions

const RETIRED_IMAGE_MODELS: Record<string, string> = {
  'seedream-5-lite': 'seedream-5-pro',
  'bytedance-seed/seedream-5-lite': 'seedream-5-pro',
  'doubao-seedream-5-0-lite': 'seedream-5-pro',
  'doubao-seedream-5-0-lite-260128': 'seedream-5-pro',
  'doubao-seedream-5-0-260128': 'seedream-5-pro',
  seedream5lite: 'seedream-5-pro',
  'seedream5-lite': 'seedream-5-pro',
  'seedream 5 lite': 'seedream-5-pro',
  'seedream-5.0-lite': 'seedream-5-pro',
}

export function normalizeImageModelValue(model?: string): string {
  const value = String(model || '').trim()
  if (!value) return rules.defaults.model
  const lower = value.toLowerCase()
  if (RETIRED_IMAGE_MODELS[lower]) return RETIRED_IMAGE_MODELS[lower]
  if (aliasToModel[lower]) return aliasToModel[lower]
  if (lower.startsWith('gpt')) return 'gpt-image-2'
  return value
}

export function getImageModelRule(model?: string): Required<Omit<ImageModelRule, 'extends'>> {
  const key = normalizeImageModelValue(model || rules.defaults.model)
  const raw = rules.models[key] ?? rules.models[rules.defaults.model]
  if (raw?.extends) {
    const parent = rules.models[raw.extends] ?? rules.models[rules.defaults.model]
    return { ...parent, ...raw, extends: undefined } as Required<Omit<ImageModelRule, 'extends'>>
  }
  return raw as Required<Omit<ImageModelRule, 'extends'>>
}

export function listSelectableImageModels() {
  return Object.entries(rules.models)
    .filter(([, rule]) => rule.frontendSelectable === true && !rule.extends)
    .map(([value]) => {
      const rule = getImageModelRule(value)
      return { value, label: rule.label || value }
    })
}

export function getImageModelDisplayName(model?: string): string {
  const value = String(model || '').trim()
  if (!value) return ''
  const canonical = aliasToModel[value.toLowerCase()]
  if (!canonical) return value
  const rule = getImageModelRule(canonical)
  return rule.label || value
}

export function getImageProgressEstimate(model?: string): ImageProgressEstimateRule | undefined {
  return getImageModelRule(model).progressEstimate
}

export function getImageRatioOptions(model?: string) {
  const modelRule = getImageModelRule(model)
  const allowed = new Set(modelRule.ratios ?? [rules.defaults.ratio])
  return rules.ratioOptions.filter((option) => allowed.has(option.value))
}

export function getImageResolutionOptions(model?: string) {
  const modelRule = getImageModelRule(model)
  return modelRule.resolutions ?? rules.resolutionOptions
}

export function getImageGenerationCounts(model?: string) {
  return getImageModelRule(model).generationCounts ?? [rules.defaults.count]
}

export function normalizeImageRatioValue(model: string | undefined, ratio?: string) {
  const options = getImageRatioOptions(model)
  const value = String(ratio || rules.defaults.ratio)
  if (options.some((option) => option.value === value)) return value
  if (options.some((option) => option.value === rules.defaults.ratio)) return rules.defaults.ratio
  return options[0]?.value || rules.defaults.ratio
}

export function normalizeImageResolutionValue(model: string | undefined, resolution?: string) {
  const options = getImageResolutionOptions(model)
  const value = String(resolution || rules.defaults.resolution)
  return options.includes(value) ? value : options[0] || rules.defaults.resolution
}

export function normalizeImageGenerationCount(model: string | undefined, count?: number) {
  const max = Number(getImageModelRule(model).maxGenerationCount || 10)
  const value = Math.round(Number(count || rules.defaults.count))
  if (!Number.isFinite(value)) return rules.defaults.count
  return Math.max(1, Math.min(max, value))
}

export function validateImageCapability(input: {
  model?: string
  mode?: string
  prompt?: string
  imageCount: number
  ratio?: string
  resolution?: string
  count?: number
}) {
  const model = normalizeImageModelValue(input.model)
  const modelRule = getImageModelRule(model)
  const modelLabel = modelRule.label || model
  const mode = String(input.mode || 'text2image') as 'text2image' | 'image2image'
  const modes = new Set(modelRule.modes ?? ['text2image'])
  const ratio = String(input.ratio || rules.defaults.ratio)
  const resolution = String(input.resolution || rules.defaults.resolution)
  const count = Number(input.count || rules.defaults.count)
  const imageCount = Number(input.imageCount || 0)

  if (!modes.has(mode)) return `${modelLabel} 不支持${mode === 'image2image' ? '图生图' : '文生图'}`
  if (normalizeImageRatioValue(model, ratio) !== ratio) return `${modelLabel} 不支持比例 ${ratio}`
  if (normalizeImageResolutionValue(model, resolution) !== resolution) return `${modelLabel} 不支持清晰度 ${resolution}`
  if (imageCount > Number(modelRule.maxReferenceImages || 0)) return `${modelLabel} 最多支持 ${modelRule.maxReferenceImages} 张参考图`
  if (count < 1 || count > Number(modelRule.maxGenerationCount || 10)) return `${modelLabel} 单次最多生成 ${modelRule.maxGenerationCount || 10} 张图片`
  if (modelRule.sequential && Number(modelRule.maxTotalImages || 0) > 0 && imageCount + count > Number(modelRule.maxTotalImages)) {
    return `${modelLabel} 参考图加生成张数不能超过 ${modelRule.maxTotalImages}`
  }
  if (!String(input.prompt || '').trim()) return '请先填写提示词'
  return ''
}
