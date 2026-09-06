const rules = require('../src/shared/seedance-video-rules.json');

const aliasToMode = Object.entries(rules.modes).reduce((acc, [mode, rule]) => {
  acc[String(mode).toLowerCase()] = mode;
  for (const alias of rule.aliases || []) acc[String(alias).toLowerCase()] = mode;
  return acc;
}, {});

function normalizeVideoMode(mode) {
  return aliasToMode[String(mode || '').trim().toLowerCase()] || rules.defaults.mode;
}

function getVideoModelRule(model) {
  const key = String(model || rules.defaults.model);
  const raw = rules.models[key] || rules.models[rules.defaults.model];
  if (raw && raw.extends) {
    return { ...(rules.models[raw.extends] || rules.models[rules.defaults.model]), ...raw, extends: undefined };
  }
  return raw || rules.models[rules.defaults.model];
}

function getVideoModeRule(mode) {
  return rules.modes[normalizeVideoMode(mode)] || rules.modes[rules.defaults.mode];
}

function getVideoEffectiveModeRule(model, mode) {
  const modeKey = normalizeVideoMode(mode);
  const modeRule = getVideoModeRule(modeKey);
  const modelRule = getVideoModelRule(model);
  const inputOverride = modelRule.modeInputs && modelRule.modeInputs[modeKey];
  return inputOverride ? { ...modeRule, inputs: inputOverride } : modeRule;
}

function getModeSpecificRatios(model, mode) {
  const modelRule = getVideoModelRule(model);
  const modeKey = mode ? normalizeVideoMode(mode) : '';
  return (modeKey && modelRule.modeRatios && modelRule.modeRatios[modeKey]) || modelRule.ratios || [rules.defaults.ratio];
}

function normalizeVideoRatio(model, ratio, mode) {
  const value = ratio === 'auto' ? 'adaptive' : String(ratio || rules.defaults.ratio);
  const options = getModeSpecificRatios(model, mode);
  if (options.includes(value)) return value;
  return options.includes(rules.defaults.ratio) ? rules.defaults.ratio : options[0] || rules.defaults.ratio;
}

function normalizeVideoResolution(model, resolution) {
  const modelRule = getVideoModelRule(model);
  const options = modelRule.resolutions || [rules.defaults.resolution];
  const value = String(resolution || rules.defaults.resolution);
  if (options.includes(value)) return value;
  return options.includes(rules.defaults.resolution) ? rules.defaults.resolution : options[0] || rules.defaults.resolution;
}

function getVideoDurationRule(model, mode) {
  const modelRule = getVideoModelRule(model);
  const modeKey = mode ? normalizeVideoMode(mode) : '';
  return (modeKey && modelRule.modeDurations && modelRule.modeDurations[modeKey]) || modelRule.duration || { min: 4, max: 15, step: 1, default: rules.defaults.duration };
}

function normalizeVideoDuration(model, duration, mode) {
  const durationRule = getVideoDurationRule(model, mode);
  const value = Number(duration);
  if (!Number.isFinite(value)) return durationRule.default;
  return Math.min(durationRule.max, Math.max(durationRule.min, Math.round(value)));
}

function getVideoGenerationCounts(model, _hasImageReference) {
  return getVideoModelRule(model).generationCounts || [1];
}

function normalizeVideoCount(model, count, hasImageReference) {
  const options = getVideoGenerationCounts(model, hasImageReference);
  const value = Number(count || 1);
  return options.includes(value) ? value : options[0] || 1;
}

const REF_KIND_LABEL = { images: '图片', videos: '视频', audios: '音频' };

function getVideoRefRule(model, mode, kind) {
  return getVideoEffectiveModeRule(model, mode).inputs[kind];
}

/** 这个模型里哪些模式收这类参考素材。报错时告诉用户该去哪个模式，模式名从配置取。 */
function modesAcceptingRef(model, kind) {
  const modelRule = getVideoModelRule(model);
  return (modelRule.modes || [])
    .filter((mode) => getVideoRefRule(model, mode, kind).max > 0)
    .map((mode) => rules.modes[mode]?.label || mode);
}

/**
 * 参考素材数量不合规时说人话。和前端 lib/videoRules.ts 的 videoRefCountError 同一套措辞 ——
 * 两边给出不一样的报错比不报错更让人困惑。
 *
 * max 为 0 时说「不支持」而不是「最多支持 0 个」（后者读起来像 bug，而且没说该怎么办）。
 */
function videoRefCountError(model, mode, kind, count) {
  const modeRule = getVideoEffectiveModeRule(model, mode);
  const rule = modeRule.inputs[kind];
  const label = REF_KIND_LABEL[kind] || kind;
  const modeLabel = modeRule.label || mode;
  if (count < rule.min) return `${modeLabel}至少需要 ${rule.min} 个${label}参考`;
  if (count <= rule.max) return '';
  if (rule.max === 0) {
    const alternatives = modesAcceptingRef(model, kind);
    const hint = alternatives.length ? `，可以改用「${alternatives.join(' / ')}」模式` : '';
    return `${modeLabel}不支持${label}参考${hint}`;
  }
  return `${modeLabel}最多支持 ${rule.max} 个${label}参考，当前有 ${count} 个`;
}

/**
 * Seedance 2.5 多模态会自己猜任务类型。带参考视频时，提示词里出现
 * 「参考视频 … 内容」或编辑动词（编辑 / 删除 / 替换 / 延长 / 修改）
 * 就常被判成 video editing，接着强制 ratio=adaptive、duration=-1，
 * 用户选的 16:9 / 4 秒直接 InvalidParameter。
 *
 * 用户点了哪个模式，就显式告诉上游：
 *   omni       → reference（用参考素材新生成，比例和时长按用户选的走）
 *   video-edit → edit
 *   extend     → extend
 * 2.0 没有这个字段，不要带。
 *
 * 官方说明：omni_reference_task_type 只是把校验提前，最终仍按提示词判定。
 * 声明 reference 但提示词带编辑动词 → TaskTypeMismatch（提交成功、轮询才失败）。
 * 所以多模态路径的提示词前缀绝不能写「编辑 / 删除 / 替换 / 延长」。
 * 文档：https://www.volcengine.com/docs/82379/1520757
 */
function seedanceOmniReferenceTaskType(model, mode, videoCount = 0) {
  const modelRule = getVideoModelRule(model);
  const providerModel = String(modelRule.providerModel || model || '');
  const isSeedance25 =
    String(model || '').includes('2_5') ||
    providerModel.includes('seedance-2.5') ||
    providerModel.includes('seedance-2-5');
  if (!isSeedance25) return null;
  const modeKey = normalizeVideoMode(mode);
  if (modeKey === 'video-edit') return 'edit';
  if (modeKey === 'extend') return 'extend';
  if (modeKey === 'omni' && Number(videoCount) > 0) return 'reference';
  return null;
}

const OMNI_REFERENCE_PROMPT_PREFIX =
  '这是多模态参考生视频，不是视频编辑也不是延长。请根据下列参考素材生成一段全新视频：镜头运动与表演节拍参考视频素材，角色外貌、服装与灯光氛围参考图片素材。';

const OMNI_EDIT_VERB_RE = /编辑|删除|替换|延长|修改|去掉|增加|续写|延续/;

function seedanceRewriteReferencePrompt(prompt) {
  let text = String(prompt || '').trim();
  if (!text) return '';
  // 清掉已经注入过的前缀，避免重复叠加。
  text = text
    .replace(/^根据参考素材生成一段全新视频，不要对原视频做编辑、删除、替换或延长。\s*/u, '')
    .replace(/^根据参考素材生成一段全新视频。镜头风格与动作参考视频素材，角色外貌与灯光氛围参考图片素材。\s*/u, '')
    .replace(/^这是多模态参考生视频，不是视频编辑也不是延长。请根据下列参考素材生成一段全新视频：镜头运动与表演节拍参考视频素材，角色外貌、服装与灯光氛围参考图片素材。\s*/u, '')
    .trim();
  // 「参考视频 … 内容」是用户点药丸后的默认写法，上游常把它判成「改这段原片」。
  // 药丸展开后可能没有空格（参考视频@视频1内容），所以空白要可选。
  text = text.replace(/参考视频(\s*@视频\d+\s*)?内容/gu, (_, mention) => (
    mention ? `镜头运动与表演节拍参考 ${mention.trim()}` : '镜头运动与表演节拍参考视频素材'
  ));
  text = text.replace(/灯光氛围参考(\s*@图片\d+)?/gu, (_, mention) => (
    mention ? `灯光氛围参考${mention}` : '灯光氛围参考图片素材'
  ));
  text = text.replace(/左边角色参考(\s*@图片\d+)?/gu, (_, mention) => (
    mention ? `左边角色外貌参考${mention}` : '左边角色外貌参考图片素材'
  ));
  text = text.replace(/右边角色参考(\s*@图片\d+)?/gu, (_, mention) => (
    mention ? `右边角色外貌参考${mention}` : '右边角色外貌参考图片素材'
  ));
  text = text.replace(/所有角色脸部都参考(\s*@图片\d+)?/gu, (_, mention) => (
    mention ? `所有角色脸部参考${mention}` : '所有角色脸部参考图片素材'
  ));
  return text.trim();
}

function seedanceOmniPrompt(params = {}) {
  const prompt = String(params.modelPrompt || params.prompt || '').trim();
  const videoCount = Array.isArray(params.videos)
    ? params.videos.filter(Boolean).length
    : Number(params.videoCount || 0);
  const taskType = seedanceOmniReferenceTaskType(
    params.model,
    params.modeType || params.mode,
    videoCount,
  );
  if (taskType !== 'reference') return prompt;
  const rewritten = seedanceRewriteReferencePrompt(prompt);
  if (!rewritten) return OMNI_REFERENCE_PROMPT_PREFIX;
  if (rewritten.startsWith(OMNI_REFERENCE_PROMPT_PREFIX)) return rewritten;
  return `${OMNI_REFERENCE_PROMPT_PREFIX}\n${rewritten}`;
}

function validateVideoCapabilities(input = {}) {
  const model = input.model || rules.defaults.model;
  const modelRule = getVideoModelRule(model);
  const mode = normalizeVideoMode(input.mode);
  const modeRule = getVideoEffectiveModeRule(model, mode);
  const supportedModes = new Set(modelRule.modes || []);
  const prompt = String(input.prompt || '').trim();
  const imageCount = Number(input.imageCount || 0);
  const videoCount = Number(input.videoCount || 0);
  const audioCount = Number(input.audioCount || 0);
  const ratio = input.ratio === 'auto' ? 'adaptive' : String(input.ratio || rules.defaults.ratio);
  const resolution = String(input.resolution || rules.defaults.resolution);
  const duration = Number(input.duration);
  const count = Number(input.count || 1);

  if (!supportedModes.has(mode)) throw new Error(`${modelRule.label || model} 不支持${modeRule.label || mode}`);
  if (normalizeVideoRatio(model, ratio, mode) !== ratio) throw new Error(`${modelRule.label || model} 不支持比例 ${ratio}`);
  if (normalizeVideoResolution(model, resolution) !== resolution) throw new Error(`${modelRule.label || model} 不支持清晰度 ${resolution}`);

  const durationRule = getVideoDurationRule(model, mode);
  if (!Number.isFinite(duration) || duration < durationRule.min || duration > durationRule.max) {
    throw new Error(`${modelRule.label || model} 时长需在 ${durationRule.min}-${durationRule.max} 秒之间`);
  }

  if (modeRule.promptRequired && !prompt) throw new Error(`${modeRule.label || mode}需要填写提示词`);
  const required = new Set(modeRule.requiresAnyOf || []);
  if (
    required.size > 0 &&
    !(
      (required.has('prompt') && prompt) ||
      (required.has('image') && imageCount > 0) ||
      (required.has('video') && videoCount > 0) ||
      (required.has('audio') && audioCount > 0)
    )
  ) {
    throw new Error(`${modeRule.label || mode}需要提示词或符合模式的参考素材`);
  }

  const inputChecks = [['images', imageCount], ['videos', videoCount], ['audios', audioCount]];
  for (const [kind, value] of inputChecks) {
    const message = videoRefCountError(model, mode, kind, value);
    if (message) throw new Error(message);
  }

  const allowedCounts = getVideoGenerationCounts(model, imageCount > 0);
  if (!allowedCounts.includes(count)) {
    throw new Error(`${modeRule.label || mode}当前只支持生成 ${allowedCounts.join('/')} 个视频`);
  }
}

module.exports = {
  rules,
  normalizeVideoMode,
  normalizeVideoRatio,
  normalizeVideoResolution,
  normalizeVideoDuration,
  normalizeVideoCount,
  getVideoModelRule,
  getVideoModeRule,
  getVideoEffectiveModeRule,
  getVideoGenerationCounts,
  getVideoDurationRule,
  getVideoRefRule,
  modesAcceptingRef,
  videoRefCountError,
  seedanceOmniReferenceTaskType,
  seedanceOmniPrompt,
  validateVideoCapabilities,
};
