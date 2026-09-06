const PANORAMA_DEFAULT_MODEL = 'gpt-image-2'
const PANORAMA_DEFAULT_RESOLUTION = '2K'
const PANORAMA_REQUEST_RATIO = '2:1'
const PANORAMA_TARGET_RATIO = '2:1'
const PANORAMA_MODE_STANDARD = 'standard'
const PANORAMA_MODE_STYLE_REDRAW = 'style-redraw-experiment'
const PANORAMA_MODE_ERP_TEMPLATE = 'erp-template-mask-experiment'

const PANORAMA_MODELS = Object.freeze(['gpt-image-2', 'gemini-3-pro-image'])
const PANORAMA_RESOLUTIONS = Object.freeze(['1K', '2K', '4K'])
const PANORAMA_MODES = Object.freeze([
  PANORAMA_MODE_STANDARD,
  PANORAMA_MODE_STYLE_REDRAW,
  PANORAMA_MODE_ERP_TEMPLATE,
])

function normalizeEnum(value, allowed, fallback, label) {
  const normalized = String(value || fallback).trim()
  if (!allowed.includes(normalized)) {
    const error = new Error(`${label}不受支持: ${normalized}`)
    error.code = 'PANORAMA_SETTING_UNSUPPORTED'
    error.statusCode = 400
    error.details = { field: label, value: normalized, allowed }
    throw error
  }
  return normalized
}

function normalizePanoramaSettings({
  model = PANORAMA_DEFAULT_MODEL,
  resolution = PANORAMA_DEFAULT_RESOLUTION,
  generationMode = PANORAMA_MODE_STANDARD,
  description = '',
} = {}) {
  const normalizedModel = normalizeEnum(model, PANORAMA_MODELS, PANORAMA_DEFAULT_MODEL, 'model')
  const normalizedResolution = normalizeEnum(
    String(resolution || PANORAMA_DEFAULT_RESOLUTION).toUpperCase(),
    PANORAMA_RESOLUTIONS,
    PANORAMA_DEFAULT_RESOLUTION,
    'resolution',
  )
  const normalizedMode = normalizeEnum(
    generationMode,
    PANORAMA_MODES,
    PANORAMA_MODE_STANDARD,
    'generationMode',
  )
  if (normalizedMode === PANORAMA_MODE_STYLE_REDRAW && normalizedModel !== 'gpt-image-2') {
    const error = new Error('保持风格整体重绘仅支持 GPT Image 2')
    error.code = 'PANORAMA_MODE_MODEL_MISMATCH'
    error.statusCode = 400
    error.details = { model: normalizedModel, generationMode: normalizedMode }
    throw error
  }
  return {
    model: normalizedModel,
    resolution: normalizedResolution,
    generationMode: normalizedMode,
    description: String(description || '').trim().slice(0, 4000),
  }
}

function commonPanoramaContract(sourceLabel) {
  return [
    'Create exactly one 360-degree by 180-degree equirectangular (ERP) panorama from the supplied reference material.',
    'The output must be a true 2:1 spherical environment with a continuous left/right seam, complete zenith and nadir, and coherent horizon geometry.',
    'Return only the panorama image: no UI, text, watermark, borders, letterboxing, multi-view collage, padding, crop-only result, or stretched flat image.',
    sourceLabel ? `Source image name: ${sourceLabel}` : '',
  ].filter(Boolean)
}

function panoramaPrompt({ sourceName = '', model, generationMode, description = '' } = {}) {
  const sourceLabel = String(sourceName || '').trim()
  const settings = normalizePanoramaSettings({ model, generationMode, description })
  const lines = commonPanoramaContract(sourceLabel)

  if (settings.generationMode === PANORAMA_MODE_STYLE_REDRAW) {
    lines.push(
      'Repaint the complete panorama as one continuous environment while preserving the reference scene identity, primary subject, architecture, spatial structure, color palette, lighting direction, camera height, and visual style.',
      'Prioritize seamless 360-degree continuity and clean sky, ground, poles, and back hemisphere. Local details may change slightly; do not claim pixel-exact reconstruction of hidden content.',
    )
  } else if (settings.generationMode === PANORAMA_MODE_ERP_TEMPLATE) {
    lines.push(
      'The first supplied image is an ERP editing template whose existing opaque pixels are the protected front reference. Fill all transparent or missing spherical regions in the same ERP coordinates.',
      'If a mask or missing-region guide is supplied, preserve opaque/known pixels and generate only the unknown areas. Continue the scene naturally through the side, back, sky, ground, and wrap seam.',
      'This is the first experimental ERP completion pass; do not produce comparison panels or multiple variants.',
    )
  } else if (settings.model === 'gemini-3-pro-image') {
    lines.push(
      'Use the A1 panorama expansion approach: keep the source view centered at the front and retain its visual style, scene identity, camera position, main subject, composition, materials, and lighting as faithfully as possible across roughly 270 degrees.',
      'Complete the remaining back hemisphere, sky, ground, and seam plausibly. Hidden areas are generated continuation, not an exact scan or factual reconstruction.',
    )
  } else {
    lines.push(
      'Keep the source view anchored at the front center. Preserve the original main subject identity, pose, scale, framing, perspective, camera height, architecture, materials, and known pixels as strongly as possible.',
      'Locally repaint and complete only the unseen side, back, sky, ground, zenith, nadir, and seam areas while maintaining continuity with the original composition.',
    )
  }

  if (settings.description) {
    lines.push(`Additional scene, style, or lighting direction from the user: ${settings.description}`)
  }
  return lines.join('\n')
}

function panoramaGenerationParams({
  sourceUrl,
  sourceName,
  model,
  resolution,
  generationMode,
  description,
} = {}) {
  const image = String(sourceUrl || '').trim()
  if (!image) throw new Error('缺少全景参考原图')
  const settings = normalizePanoramaSettings({ model, resolution, generationMode, description })
  return {
    prompt: panoramaPrompt({ sourceName, ...settings }),
    model: settings.model,
    count: 1,
    ratio: PANORAMA_REQUEST_RATIO,
    resolution: settings.resolution,
    quality: 'high',
    images: [image],
    mode: 'image2image',
    generationMode: settings.generationMode,
    description: settings.description,
    providerCalls: 1,
  }
}

module.exports = {
  PANORAMA_DEFAULT_MODEL,
  PANORAMA_DEFAULT_RESOLUTION,
  PANORAMA_REQUEST_RATIO,
  PANORAMA_REQUEST_RESOLUTION: PANORAMA_DEFAULT_RESOLUTION,
  PANORAMA_TARGET_RATIO,
  PANORAMA_MODE_STANDARD,
  PANORAMA_MODE_STYLE_REDRAW,
  PANORAMA_MODE_ERP_TEMPLATE,
  PANORAMA_MODELS,
  PANORAMA_RESOLUTIONS,
  PANORAMA_MODES,
  normalizePanoramaSettings,
  panoramaPrompt,
  panoramaGenerationParams,
};
