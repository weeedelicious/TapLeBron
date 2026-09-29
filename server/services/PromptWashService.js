const fs = require('fs');
const path = require('path');
const {
  rules,
  normalizeVideoMode,
  normalizeVideoRatio,
  normalizeVideoResolution,
  normalizeVideoDuration,
} = require('../videoRules');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'seedance-prompt-wash.md');
const MINIMAX_SKILL_PATH = path.join(__dirname, '..', 'skills', 'minimax-prompt-wash.md');
const SEEDANCE_SKILL_BASE_PATH = path.join(__dirname, '..', 'skills', 'seedance-skill-base.md');
const SEEDANCE_SKILL_DIR = path.join(__dirname, '..', 'skills', 'seedance');
const SEEDANCE_LIBRARY_PATH = path.join(__dirname, '../../src/shared/seedance-prompt-skills.json');
const MODES = new Set(['conservative', 'cinematic', 'references', 'timeline', 'minimax']);
let cachedSkills = new Map();
let cachedLibrary = null;

function readSkillFile(skillPath) {
  const stat = fs.statSync(skillPath);
  const cached = cachedSkills.get(skillPath);
  if (!cached || cached.mtimeMs !== stat.mtimeMs) {
    cachedSkills.set(skillPath, { mtimeMs: stat.mtimeMs, text: fs.readFileSync(skillPath, 'utf8') });
  }
  return cachedSkills.get(skillPath).text;
}

function readSkill(mode = 'conservative') {
  return readSkillFile(mode === 'minimax' ? MINIMAX_SKILL_PATH : SKILL_PATH);
}

function loadSeedanceLibrary() {
  const stat = fs.statSync(SEEDANCE_LIBRARY_PATH);
  if (!cachedLibrary || cachedLibrary.mtimeMs !== stat.mtimeMs) {
    const parsed = JSON.parse(fs.readFileSync(SEEDANCE_LIBRARY_PATH, 'utf8'));
    const skills = Array.isArray(parsed?.skills) ? parsed.skills : [];
    cachedLibrary = {
      mtimeMs: stat.mtimeMs,
      categories: Array.isArray(parsed?.categories) ? parsed.categories : [],
      skills,
      byId: new Map(skills.map((item) => [String(item.id || ''), item])),
    };
  }
  return cachedLibrary;
}

function listSeedanceSkills() {
  const library = loadSeedanceLibrary();
  return { categories: library.categories, skills: library.skills };
}

function normalizeSkillId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  return loadSeedanceLibrary().byId.has(id) ? id : '';
}

function readSeedanceGenreSkill(skillId) {
  const id = normalizeSkillId(skillId);
  if (!id) return '';
  return readSkillFile(path.join(SEEDANCE_SKILL_DIR, `${id}.md`));
}

function normalizeMode(value) {
  return MODES.has(String(value || '')) ? String(value) : 'conservative';
}

function cleanJsonText(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
}

function normalizeStringList(value, max = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, max);
}

function normalizeTarget(target = {}) {
  const requestedModel = String(target.model || 'Seedance_2_5');
  const model = rules.models[requestedModel] ? requestedModel : 'Seedance_2_5';
  const modeType = normalizeVideoMode(target.modeType || target.mode || 'omni');
  return {
    model,
    modeType,
    duration: normalizeVideoDuration(model, target.duration, modeType),
    ratio: normalizeVideoRatio(model, target.ratio, modeType),
    resolution: normalizeVideoResolution(model, target.resolution),
    enableSound: target.enableSound === 'off' ? 'off' : 'on',
  };
}

function extractSourceDuration(sourceText) {
  const text = String(sourceText || '').replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xFF10));
  const explicitPatterns = [
    /(?:总时长|视频时长|动画时长|成片时长|全片时长|时长|总计|共计|总共|共|一共|全片|整段)\s*(?:[:：=]\s*|为\s*|是\s*|约\s*|大约\s*)?(\d+(?:\.\d+)?)\s*(?:秒|s\b)/gi,
    /(?:生成|制作|输出|创作)\s*(?:一段|一个)?\s*(\d+(?:\.\d+)?)\s*(?:秒|s\b)/gi,
    /(\d+(?:\.\d+)?)\s*(?:秒|s\b)\s*(?:动画|视频|短片|成片|片段|分镜|镜头)/gi,
    /(?:^|[。！？!?\n])\s*(\d+(?:\.\d+)?)\s*(?:秒|s\b)(?=\s*(?:$|[。！？!?，,；;]))/gim,
  ];
  for (const pattern of explicitPatterns) {
    const match = pattern.exec(text);
    const value = Number(match?.[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }

  let timelineEnd = 0;
  const timelinePattern = /(\d+(?:\.\d+)?)\s*(?:-|–|—|~|～|至|到)\s*(\d+(?:\.\d+)?)\s*(?:秒|s\b)/gi;
  for (const match of text.matchAll(timelinePattern)) {
    const end = Number(match[2]);
    if (Number.isFinite(end)) timelineEnd = Math.max(timelineEnd, end);
  }
  return timelineEnd > 0 ? timelineEnd : null;
}

function resolveTarget(sourceText, target = {}) {
  const sourceDuration = extractSourceDuration(sourceText);
  return normalizeTarget({
    ...target,
    duration: sourceDuration ?? target.duration,
  });
}

function formatDuration(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function alignPromptDuration(value, targetDuration) {
  let prompt = String(value || '').trim();
  const duration = Number(targetDuration);
  if (!prompt || !Number.isFinite(duration) || duration <= 0) return prompt;
  const durationText = formatDuration(duration);
  const hasLeadingDuration = /^\s*\d+(?:\.\d+)?\s*秒(?=\s*(?:横屏|竖屏|视频|短片|动画|成片|的))/i.test(prompt);
  const hadDurationSignal = hasLeadingDuration || extractSourceDuration(prompt) !== null;

  prompt = prompt.replace(
    /((?:总时长|视频时长|动画时长|成片时长|全片时长|时长|总计|共计|一共)\s*(?:[:：=]\s*|为\s*|是\s*|约\s*|大约\s*)?)\d+(?:\.\d+)?(\s*秒)/gi,
    `$1${durationText}$2`,
  );
  prompt = prompt.replace(
    /^(\s*)\d+(?:\.\d+)?(\s*秒)(?=\s*(?:横屏|竖屏|视频|短片|动画|成片|的))/i,
    `$1${durationText}$2`,
  );

  const timelinePattern = /(\d+(?:\.\d+)?)\s*(-|–|—|~|～|至|到)\s*(\d+(?:\.\d+)?)\s*(秒|s\b)/gi;
  const ranges = Array.from(prompt.matchAll(timelinePattern));
  const timelineEnd = ranges.reduce((max, match) => Math.max(max, Number(match[3]) || 0), 0);
  if (timelineEnd > 0 && Math.abs(timelineEnd - duration) > 0.001) {
    const scale = duration / timelineEnd;
    prompt = prompt.replace(timelinePattern, (_match, start, separator, end, unit) => {
      const scaledStart = formatDuration(Math.max(0, Number(start) * scale));
      const scaledEnd = formatDuration(Math.max(0, Number(end) * scale));
      return `${scaledStart}${separator}${scaledEnd}${unit}`;
    });
  }

  const targetToken = new RegExp(`${durationText.replace('.', '\\.')}\\s*秒`, 'i');
  return !hadDurationSignal || targetToken.test(prompt) ? prompt : `总时长${durationText}秒。${prompt}`;
}

function normalizeTimeline(value, targetDuration) {
  const timeline = Array.isArray(value)
    ? value.slice(0, 16).map((item) => ({
        start: Number(item?.start) || 0,
        end: Number(item?.end) || 0,
        shot: String(item?.shot || '').trim(),
      })).filter((item) => item.shot && item.end >= item.start)
    : [];
  const duration = Number(targetDuration);
  const timelineEnd = timeline.reduce((max, item) => Math.max(max, item.end), 0);
  if (!timeline.length || !Number.isFinite(duration) || duration <= 0 || timelineEnd <= 0 || Math.abs(timelineEnd - duration) <= 0.001) {
    return timeline;
  }
  const scale = duration / timelineEnd;
  return timeline.map((item, index) => ({
    ...item,
    start: Number((item.start * scale).toFixed(2)),
    end: index === timeline.length - 1 ? duration : Number((item.end * scale).toFixed(2)),
  }));
}

function normalizeResult(raw, fallbackTarget) {
  const parsed = typeof raw === 'string' ? JSON.parse(cleanJsonText(raw)) : raw;
  if (!parsed || typeof parsed !== 'object') throw new Error('洗词结果不是有效对象');
  const rawPrompt = String(parsed.prompt || '').trim();
  if (!rawPrompt) throw new Error('洗词结果缺少可用提示词');
  const suggested = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {};
  const lockedTarget = normalizeTarget(fallbackTarget);
  const settings = normalizeTarget({ ...lockedTarget, ...suggested, duration: lockedTarget.duration });
  const prompt = alignPromptDuration(rawPrompt, settings.duration);
  const sections = parsed.sections && typeof parsed.sections === 'object' ? parsed.sections : {};
  const timeline = normalizeTimeline(sections.timeline, settings.duration);
  return {
    prompt,
    sections: {
      subject: String(sections.subject || '').trim(),
      scene: String(sections.scene || '').trim(),
      action: String(sections.action || '').trim(),
      camera: String(sections.camera || '').trim(),
      timeline,
      lighting: String(sections.lighting || '').trim(),
      audio: String(sections.audio || '').trim(),
      constraints: normalizeStringList(sections.constraints),
    },
    settings,
    referenceRoles: Array.isArray(parsed.referenceRoles)
      ? parsed.referenceRoles.slice(0, 40).map((item) => ({
          token: String(item?.token || '').trim(),
          use: String(item?.use || '').trim(),
          exclude: String(item?.exclude || '').trim(),
        })).filter((item) => item.token && item.use)
      : [],
    warnings: normalizeStringList(parsed.warnings),
    changeSummary: normalizeStringList(parsed.changeSummary),
  };
}

function buildMessages({ sourceText, mode, skillId, target, references, nodeName }) {
  const normalizedMode = normalizeMode(mode);
  const normalizedSkillId = normalizeSkillId(skillId);
  const normalizedTarget = resolveTarget(sourceText, target);
  const promptText = String(sourceText || '').trim();
  const skillMeta = normalizedSkillId ? loadSeedanceLibrary().byId.get(normalizedSkillId) : null;
  const systemContent = skillMeta
    ? [readSkillFile(SEEDANCE_SKILL_BASE_PATH), readSeedanceGenreSkill(normalizedSkillId)].join('\n\n')
    : readSkill(normalizedMode);
  return [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: [
        skillMeta ? `片种 Skill：${skillMeta.name} (${skillMeta.id})` : `优化模式：${normalizedMode}`,
        `节点名称：${String(nodeName || '').trim() || '（空）'}`,
        `目标视频设置：${JSON.stringify(normalizedTarget)}`,
        `可用参考素材：${JSON.stringify(references || {})}`,
        '',
        promptText ? '原始提示词：' : '原始提示词为空。请按片种 Skill 和节点名称、参考素材直接扩写完整可生成提示词，不要返回空 prompt。',
        promptText || '（空）',
        '',
        '只返回技能规定的严格 JSON，不要 Markdown。',
      ].join('\n'),
    },
  ];
}

module.exports = {
  SKILL_PATH,
  SEEDANCE_LIBRARY_PATH,
  alignPromptDuration,
  buildMessages,
  cleanJsonText,
  extractSourceDuration,
  listSeedanceSkills,
  normalizeMode,
  normalizeResult,
  normalizeSkillId,
  normalizeTarget,
  resolveTarget,
};
