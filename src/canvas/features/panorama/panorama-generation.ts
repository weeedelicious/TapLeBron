export type PanoramaModel = 'gpt-image-2' | 'gemini-3-pro-image'
export type PanoramaResolution = '1K' | '2K' | '4K'
export type PanoramaGenerationMode =
  | 'standard'
  | 'style-redraw-experiment'
  | 'erp-template-mask-experiment'

export interface PanoramaGenerationSettings {
  model: PanoramaModel
  resolution: PanoramaResolution
  generationMode: PanoramaGenerationMode
  description: string
}

export const PANORAMA_MODEL_OPTIONS: Array<{ value: PanoramaModel; label: string }> = [
  { value: 'gpt-image-2', label: 'GPT Image 2' },
  { value: 'gemini-3-pro-image', label: 'Nano Banana Pro' },
]

export const PANORAMA_RESOLUTION_OPTIONS: PanoramaResolution[] = ['1K', '2K', '4K']

export const DEFAULT_PANORAMA_GENERATION_SETTINGS: PanoramaGenerationSettings = {
  model: 'gpt-image-2',
  resolution: '2K',
  generationMode: 'standard',
  description: '',
}

export function panoramaModelLabel(model: PanoramaModel) {
  return PANORAMA_MODEL_OPTIONS.find((option) => option.value === model)?.label || model
}

export function panoramaModeOptions(model: PanoramaModel) {
  if (model === 'gemini-3-pro-image') {
    return [{
      value: 'standard' as const,
      label: 'A1 · 270°风格高度还原',
      summary: '约 270° 内保持较高风格一致性；天空、地面与背面仍可能有瑕疵',
    }]
  }
  return [
    {
      value: 'standard' as const,
      label: '局部重绘 · 天空地面略有瑕疵',
      summary: '主体和正面构图保持较强，补全天空、地面与不可见区域',
    },
    {
      value: 'style-redraw-experiment' as const,
      label: '保持风格整体重绘 · 360°几乎无瑕疵',
      summary: '360° 连续性优先，局部细节允许略有变化',
    },
  ]
}

export function normalizePanoramaMode(
  model: PanoramaModel,
  mode: PanoramaGenerationMode,
): PanoramaGenerationMode {
  if (mode === 'erp-template-mask-experiment') return mode
  return panoramaModeOptions(model).some((option) => option.value === mode) ? mode : 'standard'
}

export function panoramaModeLabel(model: PanoramaModel, mode: PanoramaGenerationMode) {
  if (mode === 'erp-template-mask-experiment') return 'ERP 模板实验'
  return panoramaModeOptions(model).find((option) => option.value === mode)?.label || mode
}

export function panoramaGenerateButtonLabel(settings: PanoramaGenerationSettings) {
  if (settings.generationMode === 'erp-template-mask-experiment') return 'ERP 模板生成'
  if (settings.model === 'gemini-3-pro-image') return '生成 720° 全景图 · A1'
  if (settings.generationMode === 'style-redraw-experiment') return '生成 720° 全景图 · 整体重绘'
  return '生成 720° 全景图 · 局部重绘'
}
