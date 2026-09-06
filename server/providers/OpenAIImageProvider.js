const rules = require('../../src/shared/image-model-rules.json');

const DEFAULT_IMAGE_MODEL = rules.defaults.model;

const aliasToModel = Object.entries(rules.models).reduce((acc, [model, rule]) => {
  const canonical = rule.extends || model;
  acc[String(model).toLowerCase()] = canonical;
  if (rule.label) acc[String(rule.label).toLowerCase()] = canonical;
  for (const alias of rule.aliases || []) acc[String(alias).toLowerCase()] = canonical;
  return acc;
}, {});

const RETIRED_IMAGE_MODELS = {
  'seedream-5-lite': 'seedream-5-pro',
  'bytedance-seed/seedream-5-lite': 'seedream-5-pro',
  'doubao-seedream-5-0-lite': 'seedream-5-pro',
  'doubao-seedream-5-0-lite-260128': 'seedream-5-pro',
  'doubao-seedream-5-0-260128': 'seedream-5-pro',
  seedream5lite: 'seedream-5-pro',
  'seedream5-lite': 'seedream-5-pro',
  'seedream 5 lite': 'seedream-5-pro',
  'seedream-5.0-lite': 'seedream-5-pro',
};

function normalizeImageModel(model) {
  const value = String(model || '').trim();
  if (!value) return DEFAULT_IMAGE_MODEL;
  const lower = value.toLowerCase();
  if (RETIRED_IMAGE_MODELS[lower]) return RETIRED_IMAGE_MODELS[lower];
  if (aliasToModel[lower]) return aliasToModel[lower];
  if (lower.startsWith('gpt')) return 'gpt-image-2';
  return value;
}

function getImageModelRule(model) {
  const key = normalizeImageModel(model || DEFAULT_IMAGE_MODEL);
  const raw = rules.models[key] || rules.models[DEFAULT_IMAGE_MODEL];
  if (raw && raw.extends) {
    return { ...(rules.models[raw.extends] || rules.models[DEFAULT_IMAGE_MODEL]), ...raw, extends: undefined };
  }
  return raw || rules.models[DEFAULT_IMAGE_MODEL];
}

function isGptImageModel(model) {
  return normalizeImageModel(model) === 'gpt-image-2';
}

function isGeminiImageParamModel(model) {
  return getImageModelRule(model).sizeStrategy === 'gemini-params';
}

function isGeminiInteractionsImageModel(model) {
  return getImageModelRule(model).apiStyle === 'gemini-interactions';
}

function providerModelForImage(model) {
  const normalized = normalizeImageModel(model);
  return getImageModelRule(normalized).providerModel || normalized;
}

function normalizeImageQuality(quality) {
  const value = String(quality || '').trim().toLowerCase();
  if (!value || value === 'auto' || value === 'medium') return 'high';
  return value;
}

function roundToMultiple(value, step = 16) {
  return Math.max(step, Math.round(Number(value || step) / step) * step);
}

function getImageRatioOptions(model) {
  const modelRule = getImageModelRule(model);
  const allowed = new Set(modelRule.ratios || [rules.defaults.ratio]);
  return (rules.ratioOptions || []).filter((option) => allowed.has(option.value));
}

function getImageResolutionOptions(model) {
  const modelRule = getImageModelRule(model);
  return modelRule.resolutions || rules.resolutionOptions || [rules.defaults.resolution];
}

function normalizeImageRatio(model, ratio) {
  const options = getImageRatioOptions(model);
  const value = String(ratio || rules.defaults.ratio);
  if (options.some((option) => option.value === value)) return value;
  if (options.some((option) => option.value === rules.defaults.ratio)) return rules.defaults.ratio;
  return (options[0] && options[0].value) || rules.defaults.ratio;
}

function normalizeImageResolution(model, resolution) {
  const options = getImageResolutionOptions(model);
  const value = String(resolution || rules.defaults.resolution);
  return options.includes(value) ? value : options[0] || rules.defaults.resolution;
}

function normalizeImageCount(model, count) {
  const modelRule = getImageModelRule(model);
  const max = Math.max(1, Number(modelRule.maxGenerationCount || 10) || 10);
  const value = Math.round(Number(count || rules.defaults.count));
  if (!Number.isFinite(value)) return rules.defaults.count;
  return Math.max(1, Math.min(max, value));
}

function getImageGenerationCounts(model) {
  return getImageModelRule(model).generationCounts || [rules.defaults.count];
}

function imageSizeFromSettings(ratio, resolution, model = 'gpt-image-2') {
  if (!ratio || ratio === 'auto') return 'auto';
  const [rawW, rawH] = String(ratio).split(':').map(Number);
  const computedSize = getImageModelRule(model).computedSize || rules.models['gpt-image-2']?.computedSize || {};
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) return computedSize.fallback || '1024x1024';

  const targetArea = (computedSize.targetAreas || {})[String(resolution || rules.defaults.resolution)] || 1024 * 1024;

  const aspect = rawW / rawH;
  let width = Math.sqrt(targetArea * aspect);
  let height = width / aspect;

  const step = Number(computedSize.step || 16);
  width = roundToMultiple(width, step);
  height = roundToMultiple(height, step);

  const maxWidth = Number(computedSize.maxWidth || 3840);
  const maxHeight = Number(computedSize.maxHeight || 2160);
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  width = roundToMultiple(width * scale, step);
  height = roundToMultiple(height * scale, step);

  const maxAspectRatio = Number(computedSize.maxAspectRatio || 3);
  if (width / height > maxAspectRatio) width = roundToMultiple(height * maxAspectRatio, step);
  if (height / width > maxAspectRatio) height = roundToMultiple(width * maxAspectRatio, step);

  return `${width}x${height}`;
}

function nativeNanoImageSizeFromSettings(ratio, resolution = rules.defaults.resolution, model = DEFAULT_IMAGE_MODEL) {
  const sizes = getImageModelRule(model).nativeSizes || {};
  const rawSize = sizes[String(ratio || '').trim()];
  if (!rawSize) return '';
  if (typeof rawSize === 'string') return rawSize;
  return rawSize[String(resolution || rules.defaults.resolution)] || rawSize[rules.defaults.resolution] || '';
}

function geminiImageParamsForModel(model, ratio, resolution) {
  const normalizedModel = normalizeImageModel(model);
  const normalizedRatio = normalizeImageRatio(normalizedModel, ratio);
  const normalizedResolution = normalizeImageResolution(normalizedModel, resolution);
  const params = { image_size: normalizedResolution };
  if (normalizedRatio && normalizedRatio !== 'auto') params.aspect_ratio = normalizedRatio;
  return params;
}

function geminiImageConfigForModel(model, ratio, resolution) {
  const params = geminiImageParamsForModel(model, ratio, resolution);
  const config = { imageSize: params.image_size };
  if (params.aspect_ratio) config.aspectRatio = params.aspect_ratio;
  return config;
}

function geminiCompatibleImageParamsForModel(model, ratio, resolution) {
  return geminiImageParamsForModel(model, ratio, resolution);
}

function geminiImagePrompt(prompt, ratio, hasReferences = false) {
  const visualPrompt = String(prompt || '').trim() || 'Generate a visually coherent image.';
  const normalizedRatio = String(ratio || '').trim();
  const lines = [
    hasReferences
      ? 'Create exactly one edited image using the attached image references and the instructions below.'
      : 'Create exactly one image from the visual scene description below.',
    'Return image output only. Do not answer with text, a summary, an explanation, or a rewritten prompt.',
  ];
  if (normalizedRatio && normalizedRatio !== 'auto') {
    lines.push(`Compose the scene natively at aspect ratio ${normalizedRatio}. Do not stretch, crop, pad, or blur-fill another aspect ratio.`);
  }
  lines.push(hasReferences ? 'Image edit instructions:' : 'Visual scene description:', visualPrompt);
  return lines.join('\n');
}

function isVolcengineImageModel(model) {
  return getImageModelRule(model).provider === 'volcengine';
}

function seedreamSupportsSequential(model) {
  return Boolean(getImageModelRule(model).sequential);
}

function seedreamImageSize(model, ratio, resolution) {
  const normalizedModel = normalizeImageModel(model);
  const normalizedRatio = normalizeImageRatio(normalizedModel, ratio);
  const normalizedResolution = normalizeImageResolution(normalizedModel, resolution);
  if (normalizedRatio === 'auto') return normalizedResolution;
  return nativeNanoImageSizeFromSettings(normalizedRatio, normalizedResolution, normalizedModel) || normalizedResolution;
}

function seedreamRequestBody({ model, prompt, ratio, resolution, images = [], count = 1, outputFormat = 'png' } = {}) {
  const normalizedModel = normalizeImageModel(model);
  const refs = (images || []).filter(Boolean);
  const body = {
    model: providerModelForImage(normalizedModel),
    prompt: String(prompt || ''),
    size: seedreamImageSize(normalizedModel, ratio, resolution),
    watermark: false,
    output_format: outputFormat || 'png',
    response_format: 'url',
  };
  if (refs.length === 1) body.image = refs[0];
  else if (refs.length > 1) body.image = refs;
  if (seedreamSupportsSequential(normalizedModel)) {
    const maxImages = Math.max(1, Number(count) || 1);
    if (maxImages > 1) {
      body.sequential_image_generation = 'auto';
      body.sequential_image_generation_options = { max_images: maxImages };
    } else {
      body.sequential_image_generation = 'disabled';
    }
  }
  return body;
}

function imageSizeForModel(model, ratio, resolution) {
  const modelRule = getImageModelRule(model);
  const normalizedModel = normalizeImageModel(model);
  const normalizedRatio = normalizeImageRatio(normalizedModel, ratio);
  const normalizedResolution = normalizeImageResolution(normalizedModel, resolution);
  if (modelRule.sizeStrategy === 'gemini-params') {
    return '';
  }
  if (modelRule.sizeStrategy === 'seedream-size') {
    return seedreamImageSize(normalizedModel, normalizedRatio, normalizedResolution);
  }
  if (modelRule.sizeStrategy === 'native-map') {
    if (normalizedRatio === 'auto') return '';
    return nativeNanoImageSizeFromSettings(normalizedRatio, normalizedResolution, normalizedModel);
  }
  return imageSizeFromSettings(normalizedRatio, normalizedResolution, normalizedModel);
}

function validateImageCapabilities(input = {}) {
  const model = normalizeImageModel(input.model);
  const modelRule = getImageModelRule(model);
  const modelLabel = modelRule.label || model;
  const mode = String(input.mode || 'text2image');
  const ratio = String(input.ratio || rules.defaults.ratio);
  const resolution = String(input.resolution || rules.defaults.resolution);
  const prompt = String(input.prompt || '').trim();
  const imageCount = Number(input.imageCount || 0);
  const count = Number(input.count || rules.defaults.count);

  if (!(modelRule.modes || ['text2image']).includes(mode)) {
    throw new Error(`${modelLabel} 不支持${mode === 'image2image' ? '图生图' : '文生图'}`);
  }
  if (normalizeImageRatio(model, ratio) !== ratio) throw new Error(`${modelLabel} 不支持比例 ${ratio}`);
  if (normalizeImageResolution(model, resolution) !== resolution) throw new Error(`${modelLabel} 不支持清晰度 ${resolution}`);
  if (imageCount > Number(modelRule.maxReferenceImages || 0)) throw new Error(`${modelLabel} 最多支持 ${modelRule.maxReferenceImages} 张参考图`);
  if (count < 1 || count > Number(modelRule.maxGenerationCount || 10)) throw new Error(`${modelLabel} 单次最多生成 ${modelRule.maxGenerationCount || 10} 张图片`);
  if (modelRule.sequential && Number(modelRule.maxTotalImages || 0) > 0 && imageCount + count > Number(modelRule.maxTotalImages)) {
    throw new Error(`${modelLabel} 参考图加生成张数不能超过 ${modelRule.maxTotalImages}`);
  }
  if (!prompt) throw new Error('请先填写提示词');
}

module.exports = {
  DEFAULT_IMAGE_MODEL,
  geminiImageConfigForModel,
  geminiImagePrompt,
  geminiImageParamsForModel,
  geminiCompatibleImageParamsForModel,
  getImageGenerationCounts,
  getImageModelRule,
  getImageRatioOptions,
  getImageResolutionOptions,
  imageSizeFromSettings,
  imageSizeForModel,
  isGeminiInteractionsImageModel,
  isGeminiImageParamModel,
  isGptImageModel,
  isVolcengineImageModel,
  seedreamImageSize,
  seedreamRequestBody,
  seedreamSupportsSequential,
  nativeNanoImageSizeFromSettings,
  normalizeImageCount,
  normalizeImageModel,
  normalizeImageQuality,
  normalizeImageRatio,
  normalizeImageResolution,
  providerModelForImage,
  roundToMultiple,
  rules,
  validateImageCapabilities,
};
