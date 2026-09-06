/**
 * AI 出片（Studio）服务端。第一版只做到「文字分镜表」。
 *
 * 为什么不走交互式 Cindy：Cindy 的 proposal 是自由格式的，落地靠前端
 * Canvas.tsx 里的 applyCindyProposal（用户点「应用」）。要无人值守就得把那套搬到
 * 服务端，而 proposal 解析失败会让整条链断掉。这里改成专用链路 ——
 * 新 skill（ai-studio.md）+ 强制 JSON 输出 + 行级规范化，失败可重试、可校验行数与总时长。
 * Cindy 那三个模式一行没动，互不影响。
 *
 * 分镜表的真源是 studio_projects.storyboard。画布里那个 script 节点是给人看的投影
 * （script 节点没有「镜头运动」列，投影时并进画面描述），后续阶段以这张表为准。
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./../config');
const { getPool } = require('./../db');
const {
  addNodesForPlugin,
  createCanvasForPlugin,
  createUploadNodeForPlugin,
  getCanvasSummary,
  updateNodeForPlugin,
} = require('./PluginCanvasService');
const { listShotflowCategoryRows } = require('./../projectCatalog');

const SKILL_FILE = path.join(__dirname, '..', 'skills', 'ai-studio.md');
const CONCEPT_SKILL_FILE = path.join(__dirname, '..', 'skills', 'ai-studio-concept.md');
const MAX_SKILL_CHARS = 12_000;
const MAX_ROWS = 200;
const MAX_TEXT = 400;
const MAX_OUTLINE = 4_000;
const STYLE_LIMIT = 8;
const REFERENCE_LIMIT = 40;

// ── 概念图（第二阶段）────────────────────────────────────────────────────
const CONCEPT_GROUPS = new Set(['lead', 'support', 'scene', 'prop']);
const CONCEPT_GROUP_LABELS = { lead: '主角', support: '配角', scene: '场景', prop: '道具' };
const CONCEPT_LIMIT = 20;
const MAX_CONCEPT_PROMPT = 800;
/**
 * 一次请求最多画几张。这不是省钱，是为了别让一个 HTTP 请求挂太久：单张十几到几十秒，
 * 按下面的并发 3 算，9 张大约三轮、一两分钟，浏览器和反代都还等得起。
 */
const CONCEPT_BATCH_LIMIT = 9;
const CONCEPT_CONCURRENCY = 3;
/**
 * 概念图按分组定比例，不跟成片比例走：人物竖幅要看全身，场景横幅要看空间，道具方形看单体。
 * 这三个都在 image-model-rules.json 里两个模型的 nativeRatios 内 ——
 * generateOpenAiImages 对非原生比例会直接抛错，所以这里不能随便换成 3:2 之类。
 */
const CONCEPT_RATIO_BY_GROUP = { lead: '3:4', support: '3:4', scene: '16:9', prop: '1:1' };
const DEFAULT_CONCEPT_IMAGE_MODEL = 'gemini-3-pro-image';

// ── 分镜绘制（第三阶段）。跟前端 studio.ts 的 STUDIO_BOARD_* 必须一致 ──
const BOARD_SKILL_FILE = path.join(__dirname, '..', 'skills', 'ai-studio-board.md');
const BOARD_LIMIT = 120;
const BOARD_BATCH_LIMIT = 9;
const BOARD_CONCURRENCY = 3;
const BOARD_STYLES = new Set(['描线', '彩色', '日漫', '美漫']);
const BOARD_METHODS = new Set(['main', 'endpoints']);
const BOARD_KINDS = new Set(['main', 'start', 'end']);
const BOARD_REFERENCE_LIMIT = 8;
/** 一次生图最多喂几张参考图。概念图多了会互相稀释，也拖慢请求。 */
const BOARD_MAX_REFERENCES_PER_IMAGE = 6;
const MAX_BOARD_PROMPT = 900;

// 跟 src/canvas/lib/studio.ts 的选项表同口径。服务端只做范围校验，不做展示，
// 所以这里只留"允许值"，文案在前端。
const PROJECTS = new Set(['火炬之光', '心动小镇', '香肠派对', '伊瑟', '出发吧麦芬', '仙境传说']);
const STYLES = new Set([
  '爱情', '恐怖', '冒险', '戏剧', '剧情', '惊悚', '史诗', '科幻',
  '动作', '悬疑', '奇幻', '超级英雄', '侦探', '武侠', '贺岁',
]);
const RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '21:9']);
const DURATIONS = new Set([15, 30, 60, 90, 120, 180]);
/** 出片分辨率。跟前端 STUDIO_RESOLUTION_OPTIONS 是同一份，改一边必须改另一边。 */
const RESOLUTIONS = new Set(['480P', '720P']);
/** 默认 720P：跟画布上视频节点的默认一致，免得出片和画布两套默认对不上。 */
const DEFAULT_RESOLUTION = '720P';
const REFERENCE_GROUPS = new Set(['lead', 'support', 'scene', 'prop', 'material']);
const STATUSES = new Set(['draft', 'storyboard_ready']);

const skillCaches = new Map();

function serviceError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isStudioAllowed(userId) {
  const allowed = config.studio?.allowedUserIds || [];
  return allowed.includes(Number(userId));
}

/** 跟 Cindy 的 skill 一样按 mtime 缓存：改 .md 内容不用重启。按文件分别缓存。 */
function readSkillFrom(file) {
  try {
    const stat = fs.statSync(file);
    const cached = skillCaches.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
    const content = fs.readFileSync(file, 'utf8').trim().slice(0, MAX_SKILL_CHARS);
    skillCaches.set(file, { mtimeMs: stat.mtimeMs, content });
    return content;
  } catch {
    return '';
  }
}

function cleanText(value, limit = MAX_TEXT) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function cleanMultiline(value, limit = MAX_OUTLINE) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, limit);
}

function cleanSeconds(value, fallback = 3) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  const snapped = Math.round(number * 2) / 2;
  return Math.min(120, Math.max(0.5, snapped));
}

function isAutoShotLabel(shot) {
  return /^0*\d+$/.test(String(shot ?? '').trim());
}

/** 与 src/canvas/lib/studio.ts 的 renumberShots 同规则：手填/合并镜号保留，自动序号重排 */
function renumberShots(rows) {
  let next = 1;
  return rows.map((row) => {
    if (!isAutoShotLabel(row.shot)) {
      const numbers = String(row.shot).match(/\d+/g) || [];
      for (const text of numbers) next = Math.max(next, Number(text) + 1);
      return row;
    }
    const shot = String(next);
    next += 1;
    return { ...row, shot };
  });
}

function pickField(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

/** 一览列每格最多几项、每项最长多少字。跟前端 studio.ts 的 STUDIO_TAG_* 是同一份。 */
const TAG_LIMIT = 8;
const TAG_MAX_LENGTH = 24;

/**
 * 把角色 / 场景 / 道具解析成数组。中英文逗号、顿号、分号、斜杠、换行都当分隔符，
 * 也直接收模型给的数组 —— 模型这两种都会吐，别指望它稳定输出某一种。
 *
 * 跟前端 studio.ts 的 parseTagList 必须保持一致：两边不一样的话，
 * 前端存进去的东西会被后端规范化改掉，用户会看到自己刚输入的内容变形。
 */
function parseTagList(raw) {
  const parts = Array.isArray(raw)
    ? raw.map((item) => String(item ?? ''))
    : String(raw ?? '').split(/[,，、;；\n\r/]+/);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const text = part.trim().slice(0, TAG_MAX_LENGTH);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= TAG_LIMIT) break;
  }
  return out;
}

function normalizeStoryboard(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.rows)
      ? raw.rows
      : [];
  const rows = list
    .slice(0, MAX_ROWS)
    .map((item, index) => {
      const source = item && typeof item === 'object' ? item : {};
      return {
        id: cleanText(source.id, 64) || crypto.randomUUID(),
        shot: cleanText(pickField(source, ['shot', '镜号']), 16) || String(index + 1),
        content: cleanText(pickField(source, ['content', '内容', 'action', '画面'])),
        shotSize: cleanText(pickField(source, ['shotSize', '景别', 'sceneType']), 24),
        movement: cleanText(pickField(source, ['movement', '镜头运动', 'camera']), 24),
        seconds: cleanSeconds(pickField(source, ['seconds', '时间', 'duration', '时长'])),
        roles: parseTagList(pickField(source, ['roles', '角色', 'characters', '人物'])),
        scenes: parseTagList(pickField(source, ['scenes', '场景', 'scene', 'locations'])),
        props: parseTagList(pickField(source, ['props', '道具', 'prop', 'items'])),
      };
    })
    .filter((row) => row.content || row.shotSize || row.movement);
  return renumberShots(rows);
}

function normalizeReferences(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, REFERENCE_LIMIT).map((item) => {
    const source = item && typeof item === 'object' ? item : {};
    const group = String(source.group || '').trim();
    return {
      group: REFERENCE_GROUPS.has(group) ? group : 'material',
      label: cleanText(source.label, 80),
      url: cleanText(source.url, 600),
    };
  }).filter((item) => item.url);
}

/**
 * 概念图清单的规范化。
 *
 * status 一律由"有没有图"推导，不信任传进来的值 —— 模型不该决定它，用户在表格里改名改提示词
 * 也不该把它改坏。只有"没有图但标了 failed"这一种情况保留，否则失败原因一刷新就没了。
 */
function normalizeConcepts(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : [];
  return list
    .slice(0, CONCEPT_LIMIT)
    .map((item) => {
      const source = item && typeof item === 'object' ? item : {};
      const group = cleanText(pickField(source, ['group', '分组']), 16);
      const imageUrl = cleanText(source.imageUrl, 600);
      return {
        id: cleanText(source.id, 64) || crypto.randomUUID(),
        // 认不出来的分组归"场景"：它是最常见的一类，而且比例用 16:9 最不容易画坏
        group: CONCEPT_GROUPS.has(group) ? group : 'scene',
        name: cleanText(pickField(source, ['name', '名称']), 60),
        prompt: cleanText(pickField(source, ['prompt', '提示词']), MAX_CONCEPT_PROMPT),
        reason: cleanText(pickField(source, ['reason', '依据', '镜号']), 80),
        imageUrl,
        nodeKey: cleanText(source.nodeKey, 64),
        status: imageUrl ? 'ready' : (String(source.status || '') === 'failed' ? 'failed' : 'pending'),
        error: imageUrl ? '' : cleanText(source.error, 200),
      };
    })
    .filter((item) => item.name || item.prompt);
}

/**
 * 重新列清单时，把已经画好的图按名称接回去。
 *
 * 重列一次清单是免费的，但已经画出来的每一张都花过钱 —— 不接回去就等于用户一点「重新列清单」
 * 就把钱烧掉的结果冲掉了。提示词以新清单为准（用户可能正是想改），所以图可能跟新提示词不一致，
 * 想更新就自己勾上「重画」。
 */
function mergeConceptImages(previousItems, incomingItems) {
  const byName = new Map();
  for (const item of previousItems) {
    if (item.imageUrl && item.name) byName.set(item.name, item);
  }
  return incomingItems.map((item) => {
    const previous = byName.get(item.name);
    if (!previous) return item;
    return {
      ...item,
      id: previous.id,
      imageUrl: previous.imageUrl,
      nodeKey: previous.nodeKey,
      status: 'ready',
      error: '',
    };
  });
}

function normalizeBrief(raw, previous = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const project = cleanText(source.project, 40);
  const styles = (Array.isArray(source.styles) ? source.styles : [])
    .map((item) => cleanText(item, 20))
    .filter((item) => STYLES.has(item))
    .slice(0, STYLE_LIMIT);
  const seconds = Number(source.seconds);
  const ratio = cleanText(source.ratio, 12);
  // 大小写随手写成 720p 也认，统一存成大写；不认识的值退回上一次的、再退回默认，
  // 绝不把一个非法分辨率存进库 —— 后面拿它去调生视频接口会直接报错。
  const resolution = cleanText(source.resolution, 12).toUpperCase();
  return {
    project: PROJECTS.has(project) ? project : (previous.project || ''),
    outline: source.outline === undefined ? (previous.outline || '') : cleanMultiline(source.outline),
    styles: styles.length > 0 ? styles : (previous.styles || []),
    seconds: DURATIONS.has(seconds) ? seconds : (previous.seconds || 30),
    ratio: RATIOS.has(ratio) ? ratio : (previous.ratio || '16:9'),
    resolution: RESOLUTIONS.has(resolution) ? resolution : (previous.resolution || DEFAULT_RESOLUTION),
    references: source.references === undefined
      ? (previous.references || [])
      : normalizeReferences(source.references),
  };
}

function readJsonColumn(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function projectFromRow(row) {
  return {
    id: String(row.id),
    name: row.name,
    canvasId: row.canvas_id == null ? null : String(row.canvas_id),
    canvasTitle: row.canvas_title || null,
    status: row.status,
    brief: normalizeBrief(readJsonColumn(row.brief, {}), {}),
    storyboard: { rows: normalizeStoryboard(readJsonColumn(row.storyboard, { rows: [] })) },
    storyboardNodeKey: row.storyboard_node_key || null,
    concepts: { items: normalizeConcepts(readJsonColumn(row.concepts, { items: [] })) },
    // 老项目这一列是 NULL：normalizeBoards 会给出默认 settings + 空 items，
    // 前端拿到的形状永远一致，不用到处判 undefined。
    boards: normalizeBoards(readJsonColumn(row.boards, {}), {}),
    // 动态分镜 / 成片。老项目这两列是 NULL，规范化会给出默认 settings + 空 items，
    // 所以前端拿到的形状永远一致。
    motion: normalizeVideoStage(readJsonColumn(row.motion, {}), {}, 'motion'),
    film: normalizeVideoStage(readJsonColumn(row.film, {}), {}, 'film'),
    createdAtMs: row.created_at ? new Date(row.created_at).getTime() : 0,
    updatedAtMs: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  };
}

// ── 画布 ────────────────────────────────────────────────────────────────

/**
 * 项目对应的画布放在这个人的「测试」分类下 —— 就是 sd2 项目管理页那份 shotflow
 * 画布分类名单里的第一个（兜底分类），跟画布管理页的对齐逻辑用同一个口径。
 * 名单读不到就返回 null，画布落在"未归类"，不算失败。
 */
async function resolveFallbackCollectionId(ownerId) {
  let categories = [];
  try {
    categories = await listShotflowCategoryRows();
  } catch {
    return null;
  }
  const first = categories[0];
  if (!first) return null;
  const [rows] = await getPool().query(
    'SELECT id FROM canvas_collections WHERE owner_id = ? AND name = ? LIMIT 1',
    [Number(ownerId), first.name]
  );
  if (rows.length > 0) return Number(rows[0].id);
  const [inserted] = await getPool().query(
    'INSERT INTO canvas_collections (owner_id, name, sort_order) VALUES (?, ?, ?)',
    [Number(ownerId), first.name, first.sortOrder]
  );
  return Number(inserted.insertId);
}

/** ai_000042：项目自增 id 补零。可读、不撞、能反查到项目。 */
function canvasNameForProject(projectId) {
  return `ai_${String(projectId).padStart(6, '0')}`;
}

// ── LLM ─────────────────────────────────────────────────────────────────

function chatCompletionsUrl() {
  const base = String(config.llmBaseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${base}/v1/chat/completions`;
}

function briefForPrompt(brief) {
  const lines = [
    `项目（IP）：${brief.project || '未指定'}`,
    `总时长：${brief.seconds} 秒（所有镜头 seconds 之和必须落在 ${Math.round(brief.seconds * 0.9)}~${Math.round(brief.seconds * 1.1)} 秒之间）`,
    `画面比例：${brief.ratio}`,
    `故事风格（按优先级）：${brief.styles.length ? brief.styles.join(' / ') : '未指定'}`,
  ];
  const groups = { lead: '主角', support: '配角', scene: '场景', prop: '道具', material: '参考资料' };
  const byGroup = new Map();
  for (const item of brief.references || []) {
    const key = groups[item.group] || '参考资料';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(item.label || item.url);
  }
  if (byGroup.size > 0) {
    lines.push(`已上传设定 / 参考：${[...byGroup].map(([key, items]) => `${key}（${items.join('、')}）`).join('；')}`);
  }
  lines.push('', '故事大纲：', brief.outline || '（用户没有填大纲，请基于项目与风格给一个最朴素的短片结构）');
  return lines.join('\n');
}

/**
 * 调模型要一个 JSON 对象。分镜和概念图共用这一份 —— 两边的失败形态、超时、剥 ```json
 * 的处理都必须一样，否则第二条链一定会漏掉第一条链踩过的坑。
 */
async function requestModelJson({ skillFile, skillMissingMessage, user }) {
  if (!config.llmApiKey) {
    throw serviceError('AI 出片尚未配置 LLM_API_KEY', 'STUDIO_NOT_CONFIGURED', 503);
  }
  const skill = readSkillFrom(skillFile);
  if (!skill) {
    throw serviceError(skillMissingMessage, 'STUDIO_SKILL_MISSING', 500);
  }
  const payload = {
    model: config.studio?.model || config.cindyAssistant?.model || config.defaultChatModel,
    messages: [
      { role: 'system', content: skill },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  };
  const requestOptions = {
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: Number(config.studio?.timeoutMs || 180_000),
  };
  let response;
  try {
    response = await axios.post(chatCompletionsUrl(), payload, requestOptions);
  } catch (cause) {
    console.error('[studio] LLM 请求失败', {
      status: Number(cause?.response?.status || 0) || null,
      message: String(cause?.message || 'unknown').slice(0, 300),
    });
    throw serviceError('模型暂时连不上，稍后再试', 'STUDIO_LLM_FAILED', 502);
  }
  const message = response.data?.choices?.[0]?.message;
  const raw = typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
      : '';
  try {
    // 模型偶尔仍会包一层 ```json，剥掉再解析
    const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/,'').trim();
    return JSON.parse(text);
  } catch {
    console.error('[studio] 模型输出不是 JSON', String(raw).slice(0, 300));
    throw serviceError('模型这次没按格式返回，请重试一次', 'STUDIO_BAD_OUTPUT', 502);
  }
}

async function requestStoryboard(brief) {
  const parsed = await requestModelJson({
    skillFile: SKILL_FILE,
    skillMissingMessage: '分镜技能说明（ai-studio.md）读不到',
    user: briefForPrompt(brief),
  });
  const rows = normalizeStoryboard(parsed);
  if (rows.length === 0) {
    throw serviceError('模型这次没给出任何镜头，请重试一次', 'STUDIO_EMPTY_STORYBOARD', 502);
  }
  return rows;
}

/**
 * 概念图清单的模型输入：brief + 整张分镜表 + 已上传的设定图清单。
 * 分镜表必须整表给出去 —— 概念图挑的就是"反复出现"的对象，只给摘要模型没法判断复用次数。
 */
function conceptPlanInput(project) {
  const brief = project.brief;
  const rows = project.storyboard.rows;
  const lines = [
    `项目（IP）：${brief.project || '未指定'}`,
    `故事风格（按优先级）：${brief.styles.length ? brief.styles.join(' / ') : '未指定'}`,
    `成片比例：${brief.ratio}（概念图不跟这个比例走，比例由服务端按分组定）`,
    `镜数：${rows.length}`,
  ];
  const uploaded = new Map();
  for (const item of brief.references || []) {
    const key = CONCEPT_GROUP_LABELS[item.group] || '参考资料';
    if (!uploaded.has(key)) uploaded.set(key, []);
    uploaded.get(key).push(item.label || '（未命名）');
  }
  lines.push(uploaded.size > 0
    ? `用户已上传设定图（这些对象不要再列）：${[...uploaded].map(([key, items]) => `${key}（${items.join('、')}）`).join('；')}`
    : '用户没有上传任何设定图。');
  lines.push('', '故事大纲：', brief.outline || '（用户没有填大纲）', '', '文字分镜表：');
  for (const row of rows) {
    lines.push(`${row.shot}. [${row.shotSize || '—'} / ${row.movement || '—'} / ${row.seconds}s] ${row.content}`);
  }
  return lines.join('\n');
}

async function requestConcepts(project) {
  const parsed = await requestModelJson({
    skillFile: CONCEPT_SKILL_FILE,
    skillMissingMessage: '概念图技能说明（ai-studio-concept.md）读不到',
    user: conceptPlanInput(project),
  });
  const items = normalizeConcepts(parsed);
  if (items.length === 0) {
    throw serviceError('模型这次没给出任何概念图条目，请重试一次', 'STUDIO_EMPTY_CONCEPTS', 502);
  }
  return items;
}

// ── 分镜绘制（第三阶段）────────────────────────────────────────────────

function normalizeBoardSettings(raw, previous = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const styles = (Array.isArray(source.styles) ? source.styles : [])
    .map((item) => cleanText(item, 12))
    .filter((item) => BOARD_STYLES.has(item));
  const method = cleanText(source.method, 16);
  const referenceUrls = (Array.isArray(source.referenceUrls) ? source.referenceUrls : [])
    .map((item) => cleanText(item, 600))
    .filter(Boolean)
    .slice(0, BOARD_REFERENCE_LIMIT);
  return {
    // 一个都没选默认「描线」：分镜画的常规做法是先用线稿定构图
    styles: styles.length ? Array.from(new Set(styles)) : (previous.styles?.length ? previous.styles : ['描线']),
    method: BOARD_METHODS.has(method) ? method : (previous.method || 'main'),
    referenceUrls: referenceUrls.length ? Array.from(new Set(referenceUrls)) : (previous.referenceUrls || []),
  };
}

function normalizeBoardItem(source, index) {
  const raw = source && typeof source === 'object' ? source : {};
  const kind = cleanText(pickField(raw, ['kind', '类型']), 12);
  const imageUrl = cleanText(raw.imageUrl, 600);
  const status = String(raw.status ?? '');
  return {
    id: cleanText(raw.id, 64) || crypto.randomUUID(),
    // 跟前端 studio.ts 的 normalizeBoardItem 对齐：都不兜底成序号。
    // 后端兜、前端不兜的话，同一份数据两边条数不一样。
    shot: cleanText(pickField(raw, ['shot', '镜号']), 16),
    kind: BOARD_KINDS.has(kind) ? kind : 'main',
    prompt: cleanText(pickField(raw, ['prompt', '提示词', '画面']), MAX_BOARD_PROMPT),
    referenceUrls: (Array.isArray(raw.referenceUrls) ? raw.referenceUrls : [])
      .map((item) => cleanText(item, 600))
      .filter(Boolean)
      .slice(0, 12),
    imageUrl,
    nodeKey: cleanText(raw.nodeKey, 64),
    // 跟概念图同一条规矩：status 由"有没有图"推导，不信任传进来的值
    status: imageUrl ? 'ready' : status === 'failed' ? 'failed' : 'pending',
    error: imageUrl ? '' : cleanText(raw.error, 200),
  };
}

function normalizeBoards(raw, previous = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(source.items) ? source.items : [];
  const items = list
    .slice(0, BOARD_LIMIT)
    .map((item, index) => normalizeBoardItem(item, index))
    .filter((item) => item.shot || item.prompt);
  return { settings: normalizeBoardSettings(source.settings, previous.settings || {}), items };
}

/**
 * 重列清单时保住已经画好的图。
 *
 * 配对键是 `镜号 + kind`，不是 id —— 模型每次给的都是新对象、没有 id。
 * 不保的话用户点一下「重列清单」就把已经花过钱的图全丢了。
 */
function mergeBoardImages(previousItems, incomingItems) {
  const byKey = new Map();
  for (const item of previousItems) {
    if (item.imageUrl) byKey.set(`${item.shot}::${item.kind}`, item);
  }
  return incomingItems.map((item) => {
    const previous = byKey.get(`${item.shot}::${item.kind}`);
    if (!previous) return item;
    return {
      ...item,
      id: previous.id,
      imageUrl: previous.imageUrl,
      nodeKey: previous.nodeKey,
      referenceUrls: previous.referenceUrls,
      status: 'ready',
      error: '',
    };
  });
}

/**
 * 这一镜该喂哪些概念图当参考。
 *
 * 靠分镜表的 roles / scenes / props（就是「一览」那一列）去跟概念图的 name 对名字。
 * 这是整个阶段的关键：不喂参考图的话每一镜的角色长相都会漂，11 镜出来像 11 个人。
 *
 * 匹配刻意做得宽松（互相包含即可）：概念图名字常写成「主角 · 陆沉渊」，
 * 而分镜表里只写「陆沉渊」，严格相等一个都对不上。
 */
function conceptReferencesForShot(row, concepts) {
  const wanted = [...(row.roles || []), ...(row.scenes || []), ...(row.props || [])]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (wanted.length === 0) return [];
  const hits = [];
  for (const concept of concepts) {
    if (!concept.imageUrl) continue;
    const name = String(concept.name || '');
    if (!name) continue;
    const matched = wanted.some((term) => name.includes(term) || term.includes(name));
    if (matched) hits.push(concept.imageUrl);
  }
  return Array.from(new Set(hits));
}

/** 给模型的输入：分镜表 + 已有概念图 + 这次的画风与绘制方法。 */
function boardPlanInput(project, settings) {
  const brief = project.brief;
  const rows = project.storyboard.rows;
  const method = settings.method === 'endpoints' ? 'endpoints' : 'main';
  const lines = rows.map((row) => {
    const parts = [
      `镜号 ${row.shot}`,
      `内容：${row.content || '（空）'}`,
      row.shotSize ? `景别：${row.shotSize}` : '',
      row.movement ? `镜头运动：${row.movement}` : '',
      `时长：${row.seconds}s`,
      (row.roles || []).length ? `角色：${row.roles.join('、')}` : '',
      (row.scenes || []).length ? `场景：${row.scenes.join('、')}` : '',
      (row.props || []).length ? `道具：${row.props.join('、')}` : '',
    ].filter(Boolean);
    return `- ${parts.join('；')}`;
  });
  const conceptLines = project.concepts.items
    .filter((item) => item.imageUrl)
    .map((item) => `- ${item.name}（${item.group}）`);
  return [
    brief.project ? `项目：${brief.project}` : '',
    brief.styles.length ? `故事风格：${brief.styles.join(' / ')}` : '',
    `画面比例：${brief.ratio}`,
    '',
    '## 本次要画什么',
    method === 'endpoints'
      ? '绘制方法：**镜头的开始和结束** —— 每一镜给 start 和 end 两条，两条之间的差别就是这一镜的运动。'
      : '绘制方法：**主要画面** —— 每一镜只给一条 main。',
    `画风（写进每条提示词的结尾）：${settings.styles.join(' / ')}`,
    settings.referenceUrls.length
      ? `用户另外上传了 ${settings.referenceUrls.length} 张画风参考图，生图时会一起喂进去，所以提示词里不用再描述画风细节，点一下就够。`
      : '',
    '',
    '## 分镜表',
    ...lines,
    conceptLines.length ? '' : '',
    conceptLines.length ? '## 已有概念图（这些对象的形象已经定了，提示词里用同样的名字）' : '',
    ...conceptLines,
  ].filter((line) => line !== undefined).join('\n');
}

async function requestBoards(project, settings) {
  const parsed = await requestModelJson({
    skillFile: BOARD_SKILL_FILE,
    skillMissingMessage: '分镜绘制技能说明（ai-studio-board.md）读不到',
    user: boardPlanInput(project, settings),
  });
  const { items } = normalizeBoards({ items: parsed?.items ?? parsed, settings }, { settings });
  if (items.length === 0) {
    throw serviceError('模型这次没给出任何分镜画条目，请重试一次', 'STUDIO_EMPTY_BOARDS', 502);
  }
  return items;
}

// ── 画布里的分镜节点 ────────────────────────────────────────────────────

/**
 * 分镜在画布里落成**文本节点**。
 *
 * 本来 script 节点更合适 —— 它自己就渲染 镜号 / 景别 / 画面 / 时长 这张表，还认中文列名，
 * 也是后面「概念图 / 分镜绘制」阶段天然的上游。但 PluginCanvasService 目前只认
 * text / image / video / audio 四种类型（NODE_TYPE_INT），要落 script 得扩那份类型表 ——
 * 那是 Cindy Ghost 插件在用的生产接口，改它得单独一轮验证，不塞进第一版。
 * 分镜表的真源在 studio_projects.storyboard，画布这份只是给人看的投影，
 * 以后换成 script 节点不影响数据。
 */
function storyboardToTextBlock(project, rows) {
  const brief = project.brief;
  const total = rows.reduce((sum, row) => sum + Number(row.seconds || 0), 0);
  const header = [
    brief.project ? `项目：${brief.project}` : '',
    brief.styles.length ? `风格：${brief.styles.join(' / ')}` : '',
    `画面比例：${brief.ratio}`,
    `时长：${total} 秒（目标 ${brief.seconds} 秒）`,
    `镜数：${rows.length}`,
  ].filter(Boolean).join('　·　');
  // 角色/场景/道具也要投影过去，否则同步到画布之后这一列的信息就丢了。
  // 三项挤在一格里用短前缀区分，比再拆三列更适合纯文本节点。
  const inventory = (row) => [
    (row.roles || []).length ? `角色：${row.roles.join('、')}` : '',
    (row.scenes || []).length ? `场景：${row.scenes.join('、')}` : '',
    (row.props || []).length ? `道具：${row.props.join('、')}` : '',
  ].filter(Boolean).join('；');
  const table = [
    '镜号 | 内容 | 角色/场景/道具 | 景别 | 镜头运动 | 时间',
    '--- | --- | --- | --- | --- | ---',
    ...rows.map((row) => [
      row.shot,
      row.content || '',
      inventory(row) || '',
      row.shotSize || '',
      row.movement || '',
      `${row.seconds}s`,
    ].join(' | ')),
  ].join('\n');
  const outline = brief.outline ? `故事大纲：\n${brief.outline}` : '';
  return [header, outline, table].filter(Boolean).join('\n\n');
}

/**
 * 把分镜写进画布。写失败不影响网页上的分镜表（真源在库里），只记日志 ——
 * 画布是投影，不该因为它挂掉就让用户白填一遍。
 * 已经写过一次就改那个节点，不再新增，否则每次重新生成都会多出一个节点。
 */
async function syncStoryboardToCanvas(ownerId, project, rows) {
  // 没画布跟"写失败"是两件完全不同的事，上层要能区分：前者重试一万次也不会成功，
  // 得先补画布。旧代码两种都 return null，于是用户看到的是「请稍后重试」——
  // 一句永远不会奏效的建议（2026-08-23）。
  if (!project.canvasId) return { nodeKey: null, reason: 'no-canvas' };
  const name = `文字分镜 · ${project.brief.project || 'AI 出片'}`;
  const content = storyboardToTextBlock(project, rows);
  try {
    if (project.storyboardNodeKey) {
      try {
        const summary = await getCanvasSummary(ownerId, project.canvasId);
        await updateNodeForPlugin(ownerId, project.canvasId, project.storyboardNodeKey, {
          expectedRevision: summary.revision,
          patch: { name, content },
        });
        return { nodeKey: project.storyboardNodeKey, reason: '' };
      } catch (error) {
        // 节点被用户删了就重新建一个，别因为找不到旧节点整个失败
        if (String(error?.code || '') !== 'PLUGIN_NODE_NOT_FOUND') throw error;
        console.warn('[studio] 旧分镜节点已不在，重新创建');
      }
    }
    const latest = await getCanvasSummary(ownerId, project.canvasId);
    const result = await addNodesForPlugin(ownerId, project.canvasId, {
      expectedRevision: latest.revision,
      nodes: [{ type: 'text', name, content, column: 0, row: 0 }],
    });
    const nodeKey = result?.created?.[0]?.nodeKey || null;
    if (nodeKey) {
      await getPool().query('UPDATE studio_projects SET storyboard_node_key = ? WHERE id = ?', [nodeKey, project.id]);
      return { nodeKey, reason: '' };
    }
    return { nodeKey: null, reason: '画布没有返回节点 key' };
  } catch (error) {
    // 真实原因必须留下来：旧代码在这里吞掉了，上层只抛一句「请稍后重试」，
    // 结果 2026-08-23 查这个故障时日志里根本没有可用信息。
    const message = String(error?.message || error).slice(0, 300);
    console.error('[studio] 分镜写入画布失败（分镜表本身已保存）', message);
    return { nodeKey: null, reason: message };
  }
}

// ── 对外接口 ────────────────────────────────────────────────────────────

async function listProjects(userId) {
  const [rows] = await getPool().query(
    `SELECT sp.*, c.title AS canvas_title
     FROM studio_projects sp
     LEFT JOIN canvases c ON c.id = sp.canvas_id
     WHERE sp.owner_id = ?
     ORDER BY sp.updated_at DESC, sp.id DESC`,
    [Number(userId)]
  );
  return rows.map(projectFromRow);
}

async function getProject(userId, projectId) {
  const [rows] = await getPool().query(
    `SELECT sp.*, c.title AS canvas_title
     FROM studio_projects sp
     LEFT JOIN canvases c ON c.id = sp.canvas_id
     WHERE sp.id = ? AND sp.owner_id = ?
     LIMIT 1`,
    [Number(projectId), Number(userId)]
  );
  if (rows.length === 0) throw serviceError('项目不存在', 'STUDIO_PROJECT_NOT_FOUND', 404);
  return projectFromRow(rows[0]);
}

/**
 * 从 createCanvasForPlugin / getCanvasSummary 的返回里取画布 id。
 *
 * **这里曾经是一个从上线起就存在的 bug**（2026-08-23 查出来）：那两个函数返回的是
 * 嵌套结构 `{ canvas: { id }, revision, nodes, ... }`，而代码写的是 `Number(canvas.id)`。
 * `canvas.id` 是 undefined，`Number(undefined)` 是 NaN，mysql2 又会把 NaN 原样序列化成
 * 裸 `NaN` 塞进 SQL，于是 `WHERE id = NaN` 报 "Unknown column 'NaN' in 'where clause'"。
 * 结果：画布 INSERT 其实成功了，但紧接着的两条 UPDATE 全炸，关联没写上 ——
 * 三个出片项目的 canvas_id 全是 NULL，上传设定图 409、同步到画布 502。
 *
 * 所以取 id 只走这一个函数，不在各处手写属性路径。
 */
function canvasIdFromSummary(summary) {
  const raw = summary?.canvas?.id ?? summary?.id;
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) {
    // 宁可在这里就炸掉并说清楚，也不要让 NaN 流进 SQL 变成一句看不懂的列名错误
    throw serviceError(
      `画布 id 读不出来（拿到 ${JSON.stringify(raw)}）`,
      'STUDIO_CANVAS_ID_UNREADABLE',
      502
    );
  }
  return id;
}

/**
 * 保证这个出片项目有一张能用的画布，返回画布 id。已经有了就直接返回，不重复建。
 *
 * 三种情况：
 *   1. canvas_id 指向的画布还在 → 原样返回；
 *   2. 没有 canvas_id（历史 bug 留下的坏数据）→ 先找**同名孤儿画布**认领回来。
 *      上面那个 NaN bug 的特征就是"画布建出来了但没关联上"，所以按约定名 ai_NNNNNN
 *      去找，找到就接回去 —— 比新建一张、把原来那张永远留成垃圾要好；
 *   3. 找不到就新建。
 */
async function ensureProjectCanvas(userId, projectId) {
  const [current] = await getPool().query(
    `SELECT sp.canvas_id, c.id AS canvas_exists
       FROM studio_projects sp
       LEFT JOIN canvases c ON c.id = sp.canvas_id
      WHERE sp.id = ? AND sp.owner_id = ?
      LIMIT 1`,
    [Number(projectId), Number(userId)]
  );
  if (current.length === 0) throw serviceError('项目不存在', 'STUDIO_PROJECT_NOT_FOUND', 404);
  if (current[0].canvas_exists != null) return Number(current[0].canvas_exists);

  const wantedName = canvasNameForProject(projectId);
  let canvasId = null;

  // ── 2. 认领同名孤儿 ──
  const [orphans] = await getPool().query(
    `SELECT c.id
       FROM canvases c
       LEFT JOIN studio_projects sp ON sp.canvas_id = c.id
      WHERE c.owner_id = ? AND c.title = ? AND sp.id IS NULL
      ORDER BY c.id ASC
      LIMIT 1`,
    [Number(userId), wantedName]
  );
  if (orphans.length > 0) {
    canvasId = Number(orphans[0].id);
    console.warn('[studio] 认领了同名孤儿画布', wantedName, '→ canvas', canvasId, '（项目', projectId, '）');
  }

  // ── 3. 新建 ──
  if (canvasId == null) {
    canvasId = canvasIdFromSummary(await createCanvasForPlugin(userId, { name: wantedName }));
  }

  const collectionId = await resolveFallbackCollectionId(userId);
  if (collectionId) {
    await getPool().query('UPDATE canvases SET collection_id = ? WHERE id = ? AND owner_id = ?', [
      collectionId, canvasId, Number(userId),
    ]);
  }
  await getPool().query('UPDATE studio_projects SET canvas_id = ? WHERE id = ? AND owner_id = ?', [
    canvasId, Number(projectId), Number(userId),
  ]);
  return canvasId;
}

/**
 * 建项目：先落库拿到自增 id（画布名要用它），再建画布并归到「测试」分类。
 * 画布建失败不回滚项目 —— 项目还在，可以用「补建画布」补上，比让用户重填一遍好。
 */
async function createProject(userId, payload = {}) {
  const brief = normalizeBrief(payload.brief, {});
  const name = cleanText(payload.name, 120) || '未命名出片项目';
  const [inserted] = await getPool().query(
    `INSERT INTO studio_projects (owner_id, name, status, brief, storyboard)
     VALUES (?, ?, 'draft', ?, ?)`,
    [Number(userId), name, JSON.stringify(brief), JSON.stringify({ rows: [] })]
  );
  const projectId = Number(inserted.insertId);
  try {
    await ensureProjectCanvas(userId, projectId);
  } catch (error) {
    console.error('[studio] 建画布失败（项目已建，可用「补建画布」重试）', String(error?.message || error).slice(0, 300));
  }
  return getProject(userId, projectId);
}

async function updateProject(userId, projectId, payload = {}) {
  const project = await getProject(userId, projectId);
  const updates = [];
  const params = [];
  /**
   * 改名时要连带把画布标题改掉（2026-08-23 用户要求：项目名称就是对应画布名字）。
   * 只在名字**真的变了**的时候改：别的保存动作也会带上 name，如果每次都同步，
   * 用户在画布管理页手动改过的画布名会被无声改回去。
   */
  let renameCanvasTo = null;
  if (payload.name !== undefined) {
    const nextName = cleanText(payload.name, 120) || project.name;
    updates.push('name = ?');
    params.push(nextName);
    if (nextName !== project.name) renameCanvasTo = nextName;
  }
  if (payload.brief !== undefined) {
    updates.push('brief = ?');
    params.push(JSON.stringify(normalizeBrief(payload.brief, project.brief)));
  }
  if (payload.storyboard !== undefined) {
    const rows = normalizeStoryboard(payload.storyboard);
    updates.push('storyboard = ?');
    params.push(JSON.stringify({ rows }));
    updates.push('status = ?');
    params.push(rows.length > 0 ? 'storyboard_ready' : 'draft');
  }
  if (payload.concepts !== undefined) {
    // 用户在表格里改名 / 改提示词 / 删条目走这条。normalizeConcepts 会按"有没有图"重算 status，
    // 所以前端不用（也不该）自己维护那个字段。
    updates.push('concepts = ?');
    params.push(JSON.stringify({ items: normalizeConcepts(payload.concepts) }));
  }
  if (payload.status !== undefined && STATUSES.has(String(payload.status))) {
    updates.push('status = ?');
    params.push(String(payload.status));
  }
  if (updates.length === 0) return project;
  params.push(Number(projectId), Number(userId));
  await getPool().query(
    `UPDATE studio_projects SET ${updates.join(', ')} WHERE id = ? AND owner_id = ?`,
    params
  );
  if (renameCanvasTo && project.canvasId) {
    // 画布没了 / 不属于这个人，就什么都不发生（owner_id 兜住），项目名照样改成功。
    // 画布改名失败不该让整次保存失败 —— 名字已经存进项目了，回滚反而更糟。
    try {
      await getPool().query('UPDATE canvases SET title = ? WHERE id = ? AND owner_id = ?', [
        renameCanvasTo, Number(project.canvasId), Number(userId),
      ]);
    } catch (error) {
      console.error('[studio] 画布改名失败（项目名已保存）', String(error?.message || error).slice(0, 300));
    }
  }
  return getProject(userId, projectId);
}

async function deleteProject(userId, projectId) {
  // 只删项目记录，不动画布 —— 画布里可能已经有用户后续手工加的东西
  await getPool().query('DELETE FROM studio_projects WHERE id = ? AND owner_id = ?', [
    Number(projectId), Number(userId),
  ]);
}

/** 生成文字分镜：调模型 → 规范化 → 存库 → 投影到画布 */
async function generateStoryboard(userId, projectId) {
  let project = await getProject(userId, projectId);
  if (!project.brief.outline) {
    throw serviceError('先填故事大纲', 'STUDIO_OUTLINE_REQUIRED', 400);
  }
  const rows = await requestStoryboard(project.brief);
  await getPool().query(
    "UPDATE studio_projects SET storyboard = ?, status = 'storyboard_ready' WHERE id = ? AND owner_id = ?",
    [JSON.stringify({ rows }), Number(projectId), Number(userId)]
  );
  // 缺画布就顺手补一张再投影。补不成也不能让整次生成失败 —— 分镜表已经存进库了，
  // 那才是真源；画布上的文本节点只是投影。
  if (!project.canvasId) {
    try {
      await ensureProjectCanvas(userId, projectId);
      project = await getProject(userId, projectId);
    } catch (error) {
      console.error('[studio] 生成分镜后补画布失败', String(error?.message || error).slice(0, 300));
    }
  }
  await syncStoryboardToCanvas(userId, project, rows);
  return getProject(userId, projectId);
}

/**
 * 把当前分镜表再写一遍到画布（用户改完表想同步过去时用）。
 *
 * 没画布时**先自己补一张再同步**，而不是像以前那样抛一句「请稍后重试」——
 * 那条建议永远不会奏效，因为缺的是画布本身（2026-08-23 用户反馈"同步到画布点选失败"）。
 */
async function pushStoryboardToCanvas(userId, projectId) {
  let project = await getProject(userId, projectId);
  if (project.storyboard.rows.length === 0) {
    throw serviceError('还没有分镜可以同步', 'STUDIO_EMPTY_STORYBOARD', 400);
  }
  if (!project.canvasId) {
    await ensureProjectCanvas(userId, projectId);
    project = await getProject(userId, projectId);
  }
  const { nodeKey, reason } = await syncStoryboardToCanvas(userId, project, project.storyboard.rows);
  if (!nodeKey) {
    // 把真实原因带给用户，而不是一句放之四海而皆准的废话
    throw serviceError(
      reason === 'no-canvas'
        ? '这个项目还没有画布，补建画布后再同步'
        : `写入画布失败：${reason || '未知原因'}`,
      'STUDIO_CANVAS_WRITE_FAILED',
      502
    );
  }
  return getProject(userId, projectId);
}

// ── 概念图（第二阶段）────────────────────────────────────────────────────

/**
 * 列概念图清单。**只调模型，不生图，零付费成本。**
 *
 * 必须先有文字分镜：概念图挑的是"反复出现、画错了后面全崩"的对象，判断依据就是镜号复用。
 * 已经画好的图按名称接回去（见 mergeConceptImages），重列清单不会把花过钱的结果冲掉。
 */
async function planConcepts(userId, projectId) {
  const project = await getProject(userId, projectId);
  if (project.storyboard.rows.length === 0) {
    throw serviceError('先生成文字分镜，概念图要按分镜挑对象', 'STUDIO_STORYBOARD_REQUIRED', 400);
  }
  const incoming = await requestConcepts(project);
  const items = mergeConceptImages(project.concepts.items, incoming);
  await getPool().query('UPDATE studio_projects SET concepts = ? WHERE id = ? AND owner_id = ?', [
    JSON.stringify({ items }), Number(projectId), Number(userId),
  ]);
  return getProject(userId, projectId);
}

/**
 * 画概念图。**这是付费步骤：每条 = 一次生图。**
 *
 * 三条规矩：
 *   1. 默认只画"勾中且还没有图"的条目，想重画必须显式 redraw —— 免得一点按钮就把已有的重烧一遍。
 *   2. 每条自己 try：一条失败不带走整批，失败原因写进那一条的 error 里。用户已经为成功的付过钱，
 *      不能因为最后一条挂了就把前面的结果丢掉。
 *   3. 不写画布。生成只落库，画布由「同步概念图到画布」单独推 —— 否则反复重画会在画布上堆节点。
 *
 * 不喂参考图（纯文生图）：这一步的目的就是从零把形象定下来，喂参考图容易被直接抄成参考图本身。
 */
async function generateConcepts(userId, projectId, payload = {}) {
  let project = await getProject(userId, projectId);
  // 概念图要花钱，所以缺画布必须在**下单之前**补好，不能生成完了发现没地方放
  if (!project.canvasId) {
    await ensureProjectCanvas(userId, projectId);
    project = await getProject(userId, projectId);
  }
  if (!project.canvasId) {
    throw serviceError('这个项目的画布补建失败，暂时画不了概念图', 'STUDIO_CANVAS_MISSING', 409);
  }
  const items = project.concepts.items;
  if (items.length === 0) {
    throw serviceError('还没有概念图清单，先点「列概念图清单」', 'STUDIO_NO_CONCEPT_LIST', 400);
  }
  const requestedIds = new Set(
    (Array.isArray(payload.ids) ? payload.ids : []).map((id) => String(id)).filter(Boolean)
  );
  const redraw = payload.redraw === true;
  const targets = items.filter((item) => {
    if (requestedIds.size > 0 && !requestedIds.has(item.id)) return false;
    if (!item.prompt) return false;
    return redraw || !item.imageUrl;
  });
  if (targets.length === 0) {
    throw serviceError(
      '没有要画的条目：勾中的要么缺提示词、要么已经有图了（想重画请勾上「重画已有的」）',
      'STUDIO_NOTHING_TO_DRAW',
      400
    );
  }
  if (targets.length > CONCEPT_BATCH_LIMIT) {
    throw serviceError(
      `一次最多画 ${CONCEPT_BATCH_LIMIT} 张（这次勾了 ${targets.length} 张），请分批`,
      'STUDIO_CONCEPT_BATCH_TOO_LARGE',
      400
    );
  }

  // 惰性 require：canvasRoutes 是九千行的大模块，放到文件顶部会和 index.js 的加载顺序
  // 绕出循环依赖，拿到 undefined。跟下面 uploadReference 里的 persistUploadedAsset 同理。
  const { generateOpenAiImages } = require('../canvasRoutes');
  const model = cleanText(config.studio?.imageModel, 80) || DEFAULT_CONCEPT_IMAGE_MODEL;
  const canvasRow = { id: project.canvasId, owner_id: Number(userId) };
  const patches = new Map();
  const queue = [...targets];

  const worker = async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      try {
        const urls = await generateOpenAiImages(
          {
            model,
            prompt: target.prompt,
            ratio: CONCEPT_RATIO_BY_GROUP[target.group] || '16:9',
            resolution: '1K',
            count: 1,
            images: [],
          },
          String(project.canvasId),
          canvasRow
        );
        const url = (urls || []).map(String).filter(Boolean)[0] || '';
        if (!url) throw new Error('生图没有返回结果');
        // nodeKey 清空：插件接口改不了已有节点的图片地址，重画后得靠「同步概念图到画布」
        // 新建一个节点才能在画布上看到新图。
        patches.set(target.id, { imageUrl: url, nodeKey: '', status: 'ready', error: '' });
      } catch (error) {
        const message = String(error?.message || error).slice(0, 200);
        console.error('[studio] 概念图生成失败', target.name, message);
        patches.set(target.id, { status: 'failed', error: message });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCEPT_CONCURRENCY, targets.length) }, () => worker())
  );

  const nextItems = items.map((item) => {
    const patch = patches.get(item.id);
    return patch ? { ...item, ...patch } : item;
  });
  await getPool().query('UPDATE studio_projects SET concepts = ? WHERE id = ? AND owner_id = ?', [
    JSON.stringify({ items: nextItems }), Number(projectId), Number(userId),
  ]);
  return getProject(userId, projectId);
}

/**
 * 把概念图落成画布上的**上传节点**（不是生图节点）。
 *
 * 上传节点才是语义正确的：概念图是设定素材，后面每一镜都要把它当参考图连进去。
 * 图已经在这张画布的资产区里（generateOpenAiImages 存好才返回的 URL），所以 persistAsset
 * 只是把那个 URL 包成 asset 的形状，不再落一份字节。
 *
 * 只推"有图且还没有节点"的条目，所以重复点不会刷出重复节点。每建一个节点画布 revision 就变，
 * 因此每轮都要重新读 summary —— 拿旧 revision 去建第二个会直接撞冲突。
 */
async function pushConceptsToCanvas(userId, projectId) {
  let project = await getProject(userId, projectId);
  if (!project.canvasId) {
    await ensureProjectCanvas(userId, projectId);
    project = await getProject(userId, projectId);
  }
  if (!project.canvasId) {
    throw serviceError('这个项目的画布补建失败', 'STUDIO_CANVAS_MISSING', 409);
  }
  const items = project.concepts.items;
  const pending = items.filter((item) => item.imageUrl && !item.nodeKey);
  if (pending.length === 0) {
    throw serviceError('没有需要同步的概念图（有图的都已经在画布上了）', 'STUDIO_NOTHING_TO_PUSH', 400);
  }
  // 已经落过节点的占掉前面的格子，接着往后排，避免新节点压在旧节点上
  let slot = items.filter((item) => item.nodeKey).length;
  const patches = new Map();
  const failures = [];
  for (const item of pending) {
    const label = `概念图 · ${CONCEPT_GROUP_LABELS[item.group] || '素材'} · ${item.name || '未命名'}`;
    try {
      const summary = await getCanvasSummary(userId, project.canvasId);
      const created = await createUploadNodeForPlugin(userId, project.canvasId, {
        expectedRevision: summary.revision,
        name: label,
        // 分镜那个文本节点占着 (0,0)，概念图从 y=760 起另开一行，四个一排
        x: (slot % 4) * 620,
        y: 760 + Math.floor(slot / 4) * 620,
        persistAsset: async () => ({
          url: item.imageUrl,
          displayUrl: item.imageUrl,
          thumbUrl: '',
          originalName: `${item.name || 'concept'}.png`,
          meta: { kind: 'image', createdAtMs: Date.now() },
        }),
      });
      const nodeKey = created?.created?.nodeKey || '';
      if (!nodeKey) throw new Error('画布没有返回 nodeKey');
      patches.set(item.id, { nodeKey });
      slot += 1;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 200);
      console.error('[studio] 概念图写入画布失败', item.name, message);
      failures.push(`${item.name || '未命名'}：${message}`);
    }
  }
  if (patches.size > 0) {
    const nextItems = items.map((item) => {
      const patch = patches.get(item.id);
      return patch ? { ...item, ...patch } : item;
    });
    await getPool().query('UPDATE studio_projects SET concepts = ? WHERE id = ? AND owner_id = ?', [
      JSON.stringify({ items: nextItems }), Number(projectId), Number(userId),
    ]);
  }
  // 一个都没成功才算失败；部分成功就照实返回，前端能看出哪几条还没有 nodeKey
  if (patches.size === 0) {
    throw serviceError(
      `写入画布失败：${failures.join('；').slice(0, 300)}`,
      'STUDIO_CANVAS_WRITE_FAILED',
      502
    );
  }
  return getProject(userId, projectId);
}

// ── 动态分镜（第四阶段）与成片（第五阶段）────────────────────────────────
//
// 这两个阶段在文档里是两件事，但形状完全一样（按镜生成视频、可选数量/分辨率/时长、
// 单镜/多选/全部、改面部/pose/局部/特效），所以**一套实现两处用**，靠 stage 参数区分
// 落哪一列。区别只有两点：
//   - 默认档不同：动态分镜是给人看节奏的草样（480P 更省），成片是最终交付（720P）；
//   - 串片和贴时间码只有动态分镜有（文档里「串片，贴时间码」写在动态分镜下面）。
//
// **为什么不像图片那样同步等**：一条视频要几分钟，一批 3 条并发跑三轮就是二十分钟，
// 挂在一个 HTTP 请求里必被网关掐断。所以拆成三步：
//   generate 只提交、存下 provider 的 taskId 就返回；
//   poll 拿 taskId 去问结果，好了就把视频**落地到画布资产**；
//   前端在有 running 条目时定时调 poll。
// 好处是刷新页面不丢（状态在库里），服务端重启后再 poll 一次也能接回来 —— taskId 存着。

const MOTION_STAGES = {
  motion: { column: 'motion', label: '动态分镜', defaultResolution: '480P' },
  film: { column: 'film', label: '成片', defaultResolution: '720P' },
};
const VIDEO_BATCH_LIMIT = 9;
const VIDEO_SUBMIT_CONCURRENCY = 3;
const VIDEO_RESOLUTIONS = new Set(['480P', '720P', '1080P']);
const VIDEO_DURATIONS = new Set([4, 5, 6, 8, 10, 12]);
const DEFAULT_STUDIO_VIDEO_MODEL = 'Seedance_2_5';
const MAX_VIDEO_PROMPT = 900;
/** 文档「修改：面部 | pose | 局部画面 | 特效」——跟分镜绘制一样做成往提示词追加的快捷词 */
const VIDEO_TWEAKS = ['改面部', '改pose', '改局部画面', '改特效'];

function stageConfig(stage) {
  const found = MOTION_STAGES[String(stage || '')];
  if (!found) throw serviceError(`未知阶段 ${stage}`, 'STUDIO_UNKNOWN_STAGE', 400);
  return found;
}

function normalizeVideoSettings(raw, previous = {}, stage = 'motion') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const resolution = cleanText(source.resolution, 12).toUpperCase();
  const duration = Number(source.durationSec);
  const count = Number(source.count);
  const referenceUrls = (Array.isArray(source.referenceUrls) ? source.referenceUrls : [])
    .map((item) => cleanText(item, 600))
    .filter(Boolean)
    .slice(0, BOARD_REFERENCE_LIMIT);
  return {
    model: cleanText(source.model, 64) || previous.model || DEFAULT_STUDIO_VIDEO_MODEL,
    resolution: VIDEO_RESOLUTIONS.has(resolution)
      ? resolution
      : (previous.resolution || stageConfig(stage).defaultResolution),
    // 时长跟着分镜表那一镜走是最合理的，但用户可以在这里统一压一个值
    durationSec: VIDEO_DURATIONS.has(duration) ? duration : (previous.durationSec || 5),
    count: Number.isFinite(count) && count >= 1 && count <= 4 ? Math.floor(count) : (previous.count || 1),
    referenceUrls: referenceUrls.length ? Array.from(new Set(referenceUrls)) : (previous.referenceUrls || []),
  };
}

function normalizeVideoItem(source, index) {
  const raw = source && typeof source === 'object' ? source : {};
  const videoUrl = cleanText(raw.videoUrl, 600);
  const providerTaskId = cleanText(raw.providerTaskId, 128);
  const status = String(raw.status ?? '');
  // status 由事实推导，不信任传进来的值：有视频=ready，有 taskId 没视频=running
  const derived = videoUrl ? 'ready' : status === 'failed' ? 'failed' : providerTaskId ? 'running' : 'pending';
  return {
    id: cleanText(raw.id, 64) || crypto.randomUUID(),
    // 刻意**不**给镜号兜底成序号：兜了之后 {} 也会有镜号，下面那个丢空条目的过滤器就成了死代码。
    // 视频条目本来就是从分镜画生成的，分镜画一定带镜号。
    shot: cleanText(pickField(raw, ['shot', '镜号']), 16),
    prompt: cleanText(pickField(raw, ['prompt', '提示词']), MAX_VIDEO_PROMPT),
    /** 首帧图（来自分镜画）。没有它就是纯文生视频，角色会漂 */
    sourceImageUrl: cleanText(raw.sourceImageUrl, 600),
    /** 尾帧图，只有分镜画用了「首尾帧」方法时才有 */
    endImageUrl: cleanText(raw.endImageUrl, 600),
    providerTaskId,
    videoUrl,
    nodeKey: cleanText(raw.nodeKey, 64),
    durationSec: VIDEO_DURATIONS.has(Number(raw.durationSec)) ? Number(raw.durationSec) : 5,
    status: derived,
    error: videoUrl ? '' : cleanText(raw.error, 200),
  };
}

function normalizeVideoStage(raw, previous = {}, stage = 'motion') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(source.items) ? source.items : [];
  const items = list
    .slice(0, BOARD_LIMIT)
    .map((item, index) => normalizeVideoItem(item, index))
    .filter((item) => item.shot || item.prompt);
  return {
    settings: normalizeVideoSettings(source.settings, previous.settings || {}, stage),
    items,
    /** 串片结果（只有动态分镜用）。存在这里而不是 items 里 —— 它是整条片子的产物 */
    reelUrl: cleanText(source.reelUrl, 600),
    reelNodeKey: cleanText(source.reelNodeKey, 64),
  };
}

async function saveVideoStage(userId, projectId, stage, payload) {
  const { column } = stageConfig(stage);
  await getPool().query(
    `UPDATE studio_projects SET ${column} = ? WHERE id = ? AND owner_id = ?`,
    [JSON.stringify(payload), Number(projectId), Number(userId)]
  );
}

/**
 * 从分镜画生成视频清单。零成本。
 *
 * 提示词的来源跟分镜绘制不同：这里**要**把镜头运动写进去。
 * 分镜画是静止的一帧，写「推镜」没意义；视频恰恰相反 —— 运动就是它要表现的东西。
 */
async function planVideoStage(userId, projectId, stage, payload = {}) {
  const cfg = stageConfig(stage);
  const project = await getProject(userId, projectId);
  const boards = project.boards.items.filter((item) => item.imageUrl);
  if (boards.length === 0) {
    throw serviceError(
      `先把分镜画好 —— ${cfg.label}要拿分镜画当首帧，不然角色会漂`,
      'STUDIO_BOARDS_REQUIRED',
      400
    );
  }
  const previous = project[stage] || {};
  const settings = normalizeVideoSettings(payload.settings, previous.settings || {}, stage);
  const rowByShot = new Map(project.storyboard.rows.map((row) => [String(row.shot), row]));
  // 已经生成过的按镜号保住，别让重列清单把花过钱的视频冲掉
  const keptByShot = new Map(
    (previous.items || []).filter((item) => item.videoUrl).map((item) => [String(item.shot), item])
  );

  // 按镜号分组：一镜可能有主画面，也可能有首帧 + 尾帧
  const byShot = new Map();
  for (const board of boards) {
    const key = String(board.shot);
    if (!byShot.has(key)) byShot.set(key, {});
    byShot.get(key)[board.kind] = board.imageUrl;
  }

  const items = [];
  for (const [shot, frames] of byShot) {
    const row = rowByShot.get(shot);
    const kept = keptByShot.get(shot);
    const parts = [
      row?.content || '',
      row?.movement && row.movement !== '固定' ? `镜头${row.movement}` : '',
      row?.shotSize ? `${row.shotSize}` : '',
    ].filter(Boolean);
    items.push(normalizeVideoItem({
      ...(kept || {}),
      id: kept?.id,
      shot,
      prompt: kept?.prompt || parts.join('，'),
      sourceImageUrl: frames.main || frames.start || '',
      endImageUrl: frames.end || '',
      // 时长跟着分镜表那一镜走，但要落到 provider 支持的档位上
      durationSec: VIDEO_DURATIONS.has(Math.round(Number(row?.seconds)))
        ? Math.round(Number(row.seconds))
        : settings.durationSec,
    }, items.length));
  }

  const next = {
    settings,
    items,
    reelUrl: previous.reelUrl || '',
    reelNodeKey: previous.reelNodeKey || '',
  };
  await saveVideoStage(userId, projectId, stage, next);
  return getProject(userId, projectId);
}

async function saveVideoStageEdits(userId, projectId, stage, payload = {}) {
  const project = await getProject(userId, projectId);
  const previous = project[stage] || {};
  const settings = normalizeVideoSettings(payload.settings, previous.settings || {}, stage);
  const next = normalizeVideoStage({ items: payload.items, settings }, { settings }, stage);
  next.reelUrl = previous.reelUrl || '';
  next.reelNodeKey = previous.reelNodeKey || '';
  await saveVideoStage(userId, projectId, stage, next);
  return getProject(userId, projectId);
}

/**
 * 提交视频生成。**这是付费步骤**，但它只提交、不等结果 —— 立刻返回，靠 poll 收。
 *
 * 提交成功就把 providerTaskId 存下来。这一条很重要：只要 taskId 落库了，
 * 哪怕页面关了、服务重启了，之后 poll 一次照样能把结果收回来，不会重复付费。
 */
async function generateVideoStage(userId, projectId, stage, payload = {}) {
  const cfg = stageConfig(stage);
  let project = await getProject(userId, projectId);
  if (!project.canvasId) {
    await ensureProjectCanvas(userId, projectId);
    project = await getProject(userId, projectId);
  }
  const current = project[stage] || { settings: {}, items: [] };
  const items = current.items || [];
  if (items.length === 0) {
    throw serviceError(`还没有${cfg.label}清单，先点「列清单」`, 'STUDIO_NO_VIDEO_LIST', 400);
  }
  const requestedIds = new Set(
    (Array.isArray(payload.ids) ? payload.ids : []).map((id) => String(id)).filter(Boolean)
  );
  const redraw = payload.redraw === true;
  const targets = items.filter((item) => {
    if (requestedIds.size > 0 && !requestedIds.has(item.id)) return false;
    if (!item.prompt && !item.sourceImageUrl) return false;
    // 正在跑的不要重复提交 —— 那是白花一次钱
    if (item.status === 'running') return false;
    return redraw || !item.videoUrl;
  });
  if (targets.length === 0) {
    throw serviceError(
      '没有要生成的镜头：勾中的要么正在生成、要么已经有视频了（想重做请勾上「重做已有的」）',
      'STUDIO_NOTHING_TO_RENDER',
      400
    );
  }
  if (targets.length > VIDEO_BATCH_LIMIT) {
    throw serviceError(
      `一次最多提交 ${VIDEO_BATCH_LIMIT} 条（这次勾了 ${targets.length} 条），请分批`,
      'STUDIO_VIDEO_BATCH_TOO_LARGE',
      400
    );
  }

  const { submitSeedanceVideo } = require('../canvasRoutes');
  const settings = normalizeVideoSettings(current.settings, {}, stage);
  const patches = new Map();
  const queue = [...targets];

  const worker = async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      try {
        const images = [target.sourceImageUrl, ...settings.referenceUrls].filter(Boolean);
        const taskId = await submitSeedanceVideo({
          model: settings.model,
          prompt: target.prompt,
          resolution: settings.resolution,
          ratio: project.brief.ratio || '16:9',
          duration: target.durationSec || settings.durationSec,
          // 有首帧图就是图生视频；有尾帧图的话首尾都喂（provider 支持首尾帧模式）
          modeType: target.sourceImageUrl ? (target.endImageUrl ? 'startend' : 'image2video') : 'text2video',
          images,
          endImage: target.endImageUrl || undefined,
          projectUuid: String(project.canvasId),
        });
        patches.set(target.id, {
          providerTaskId: String(taskId), status: 'running', error: '', videoUrl: '',
        });
      } catch (error) {
        const message = String(error?.message || error).slice(0, 200);
        console.error(`[studio] ${cfg.label}提交失败`, target.shot, message);
        patches.set(target.id, { status: 'failed', error: message });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(VIDEO_SUBMIT_CONCURRENCY, targets.length) }, () => worker())
  );

  const nextItems = items.map((item) => {
    const patch = patches.get(item.id);
    return patch ? { ...item, ...patch } : item;
  });
  await saveVideoStage(userId, projectId, stage, {
    settings, items: nextItems, reelUrl: current.reelUrl || '', reelNodeKey: current.reelNodeKey || '',
  });
  return getProject(userId, projectId);
}

/**
 * 收结果。前端在有 running 条目时定时调这个。
 *
 * 拿到视频地址后**立刻落地到画布资产**：provider 的直链是会过期的，
 * 存原始地址等于过几天回来看全是死链（这是画布那边早就踩过的坑）。
 */
async function pollVideoStage(userId, projectId, stage) {
  const cfg = stageConfig(stage);
  const project = await getProject(userId, projectId);
  const current = project[stage] || { settings: {}, items: [] };
  const items = current.items || [];
  const running = items.filter((item) => item.status === 'running' && item.providerTaskId);
  if (running.length === 0) return project;

  const { pollSeedanceResult, downloadToAssets } = require('../canvasRoutes');
  const patches = new Map();

  await Promise.all(running.map(async (item) => {
    try {
      const result = await pollSeedanceResult(item.providerTaskId);
      if (result.status === 2) {
        const remoteUrl = (result.urls || []).map(String).filter(Boolean)[0] || '';
        if (!remoteUrl) {
          patches.set(item.id, { status: 'failed', error: '生成完成但没有返回视频地址' });
          return;
        }
        let stored = remoteUrl;
        try {
          // downloadToAssets(urls, projectUuid, options) → 返回本地 /assets/... 地址
          // 不传 includePreviews 时它直接返回本地地址数组；canvasRow 它自己会查，不用传
          const result = await downloadToAssets([remoteUrl], String(project.canvasId), {
            sourceType: `studio-${stage}`,
            strict: true,
            ensureRvCompatibleVideos: true,
          });
          const localUrl = (Array.isArray(result) ? result : result?.urls || [])
            .map(String).filter(Boolean)[0] || '';
          if (localUrl) stored = localUrl;
        } catch (error) {
          // 落地失败不算生成失败：先把直链存着，至少现在能看（但它会过期，所以要记日志）
          console.error(`[studio] ${cfg.label}视频落地失败，暂用直链`, String(error?.message || error).slice(0, 200));
        }
        patches.set(item.id, { videoUrl: stored, status: 'ready', error: '', providerTaskId: '' });
        return;
      }
      if (result.status === 3) {
        patches.set(item.id, { status: 'failed', error: result.error || '生成失败', providerTaskId: '' });
      }
      // status 0/1 还在跑，什么都不改
    } catch (error) {
      const message = String(error?.message || error).slice(0, 200);
      console.error(`[studio] ${cfg.label}查询失败`, item.shot, message);
      // 查询失败**不**改状态：可能只是网络抖动，下次 poll 再试，不要因此丢掉 taskId
    }
  }));

  if (patches.size === 0) return project;
  const nextItems = items.map((item) => {
    const patch = patches.get(item.id);
    return patch ? { ...item, ...patch } : item;
  });
  await saveVideoStage(userId, projectId, stage, {
    settings: current.settings, items: nextItems,
    reelUrl: current.reelUrl || '', reelNodeKey: current.reelNodeKey || '',
  });
  return getProject(userId, projectId);
}

/** 把生成好的视频同步到画布，一条一个视频节点，按镜号排。 */
async function pushVideoStageToCanvas(userId, projectId, stage) {
  const cfg = stageConfig(stage);
  let project = await getProject(userId, projectId);
  if (!project.canvasId) {
    await ensureProjectCanvas(userId, projectId);
    project = await getProject(userId, projectId);
  }
  const current = project[stage] || { items: [] };
  const items = current.items || [];
  const targets = items.filter((item) => item.videoUrl && !item.nodeKey);
  if (targets.length === 0) {
    throw serviceError(`没有要同步的${cfg.label}`, 'STUDIO_NOTHING_TO_PUSH', 400);
  }
  const patches = new Map();
  const failures = [];
  // 动态分镜和成片各占一行，别跟分镜画挤在一起
  const baseY = stage === 'motion' ? 2280 : 3040;
  let slot = items.filter((item) => item.nodeKey).length;
  for (const item of targets) {
    // 文档「贴镜号，帧数」：镜号和时长写进节点名，这是画布上唯一能带上它们的地方
    const label = `${cfg.label} ${item.shot} · ${item.durationSec}s`;
    try {
      const summary = await getCanvasSummary(userId, project.canvasId);
      const created = await createUploadNodeForPlugin(userId, project.canvasId, {
        expectedRevision: summary.revision,
        name: label,
        x: (slot % 4) * 620,
        y: baseY + Math.floor(slot / 4) * 620,
        persistAsset: async () => ({
          url: item.videoUrl,
          displayUrl: item.videoUrl,
          thumbUrl: '',
          originalName: `${stage}-${item.shot}.mp4`,
          meta: { kind: 'video', createdAtMs: Date.now() },
        }),
      });
      const nodeKey = created?.created?.nodeKey || '';
      if (!nodeKey) throw new Error('画布没有返回 nodeKey');
      patches.set(item.id, { nodeKey });
      slot += 1;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 200);
      console.error(`[studio] ${cfg.label}写入画布失败`, label, message);
      failures.push(`${label}：${message}`);
    }
  }
  if (patches.size > 0) {
    const nextItems = items.map((item) => {
      const patch = patches.get(item.id);
      return patch ? { ...item, ...patch } : item;
    });
    await saveVideoStage(userId, projectId, stage, {
      settings: current.settings, items: nextItems,
      reelUrl: current.reelUrl || '', reelNodeKey: current.reelNodeKey || '',
    });
  }
  if (patches.size === 0 && failures.length > 0) {
    throw serviceError(`都没写进画布：${failures[0]}`, 'STUDIO_CANVAS_WRITE_FAILED', 502);
  }
  return getProject(userId, projectId);
}

/**
 * 列分镜画清单。零生图成本 —— 只让模型把分镜表写成生图提示词。
 *
 * 已经画好的图按「镜号 + kind」保住（mergeBoardImages），所以改了画风重列清单
 * 不会把之前花过钱的图冲掉。
 */
async function planBoards(userId, projectId, payload = {}) {
  const project = await getProject(userId, projectId);
  if (project.storyboard.rows.length === 0) {
    throw serviceError('先生成文字分镜，分镜画要按镜来画', 'STUDIO_STORYBOARD_REQUIRED', 400);
  }
  const settings = normalizeBoardSettings(payload.settings, project.boards.settings);
  const incoming = await requestBoards(project, settings);
  const items = mergeBoardImages(project.boards.items, incoming);
  await getPool().query('UPDATE studio_projects SET boards = ? WHERE id = ? AND owner_id = ?', [
    JSON.stringify({ settings, items }), Number(projectId), Number(userId),
  ]);
  return getProject(userId, projectId);
}

/** 只存清单和设置，不生图。用户改完提示词点保存走这条。 */
async function saveBoards(userId, projectId, payload = {}) {
  const project = await getProject(userId, projectId);
  const settings = normalizeBoardSettings(payload.settings, project.boards.settings);
  const { items } = normalizeBoards({ items: payload.items, settings }, { settings });
  await getPool().query('UPDATE studio_projects SET boards = ? WHERE id = ? AND owner_id = ?', [
    JSON.stringify({ settings, items }), Number(projectId), Number(userId),
  ]);
  return getProject(userId, projectId);
}

/**
 * 画分镜画。**这是付费步骤：每条 = 一次生图。**
 *
 * 跟概念图三条规矩相同（只画勾中且没图的、每条自己 try、不写画布），另加两条：
 *   4. **喂参考图**：这一镜的角色/场景/道具对应的概念图 + 用户上传的画风参考图。
 *      这是和概念图最本质的区别 —— 概念图刻意不喂参考图（要从零定形象），
 *      分镜画必须喂（要让 11 镜里的人是同一个人）。
 *   5. 比例跟项目的画面比例，不按分组 —— 分镜画就是成片的画面，比例必须一致。
 */
async function generateBoards(userId, projectId, payload = {}) {
  let project = await getProject(userId, projectId);
  if (!project.canvasId) {
    await ensureProjectCanvas(userId, projectId);
    project = await getProject(userId, projectId);
  }
  if (!project.canvasId) {
    throw serviceError('这个项目的画布补建失败，暂时画不了分镜', 'STUDIO_CANVAS_MISSING', 409);
  }
  const items = project.boards.items;
  if (items.length === 0) {
    throw serviceError('还没有分镜画清单，先点「列分镜画清单」', 'STUDIO_NO_BOARD_LIST', 400);
  }
  const requestedIds = new Set(
    (Array.isArray(payload.ids) ? payload.ids : []).map((id) => String(id)).filter(Boolean)
  );
  const redraw = payload.redraw === true;
  const targets = items.filter((item) => {
    if (requestedIds.size > 0 && !requestedIds.has(item.id)) return false;
    if (!item.prompt) return false;
    return redraw || !item.imageUrl;
  });
  if (targets.length === 0) {
    throw serviceError(
      '没有要画的条目：勾中的要么缺提示词、要么已经有图了（想重画请勾上「重画已有的」）',
      'STUDIO_NOTHING_TO_DRAW',
      400
    );
  }
  if (targets.length > BOARD_BATCH_LIMIT) {
    throw serviceError(
      `一次最多画 ${BOARD_BATCH_LIMIT} 张（这次勾了 ${targets.length} 张），请分批`,
      'STUDIO_BOARD_BATCH_TOO_LARGE',
      400
    );
  }

  const { generateOpenAiImages } = require('../canvasRoutes');
  const model = cleanText(config.studio?.imageModel, 80) || DEFAULT_CONCEPT_IMAGE_MODEL;
  const canvasRow = { id: project.canvasId, owner_id: Number(userId) };
  const settings = project.boards.settings;
  const rowByShot = new Map(project.storyboard.rows.map((row) => [String(row.shot), row]));
  const patches = new Map();
  const queue = [...targets];

  const worker = async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      // 参考图顺序即优先级：用户上传的画风参考图在前，概念图在后
      const row = rowByShot.get(String(target.shot));
      const references = Array.from(new Set([
        ...settings.referenceUrls,
        ...(row ? conceptReferencesForShot(row, project.concepts.items) : []),
      ])).slice(0, BOARD_MAX_REFERENCES_PER_IMAGE);
      try {
        const urls = await generateOpenAiImages(
          {
            model,
            prompt: target.prompt,
            ratio: project.brief.ratio || '16:9',
            resolution: '1K',
            count: 1,
            images: references,
          },
          String(project.canvasId),
          canvasRow
        );
        const url = (urls || []).map(String).filter(Boolean)[0] || '';
        if (!url) throw new Error('生图没有返回结果');
        // nodeKey 清空：插件接口改不了已有节点的图片地址，重画后要靠「同步到画布」新建节点
        patches.set(target.id, {
          imageUrl: url, nodeKey: '', status: 'ready', error: '', referenceUrls: references,
        });
      } catch (error) {
        const message = String(error?.message || error).slice(0, 200);
        console.error('[studio] 分镜画生成失败', `${target.shot}/${target.kind}`, message);
        patches.set(target.id, { status: 'failed', error: message, referenceUrls: references });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BOARD_CONCURRENCY, targets.length) }, () => worker())
  );

  const nextItems = items.map((item) => {
    const patch = patches.get(item.id);
    return patch ? { ...item, ...patch } : item;
  });
  await getPool().query('UPDATE studio_projects SET boards = ? WHERE id = ? AND owner_id = ?', [
    JSON.stringify({ settings, items: nextItems }), Number(projectId), Number(userId),
  ]);
  return getProject(userId, projectId);
}

/**
 * 把画好的分镜画同步到画布。跟概念图同一套：一张一个上传节点，按镜号排。
 * 已经有 nodeKey 的跳过 —— 不重复堆节点。
 */
async function pushBoardsToCanvas(userId, projectId) {
  let project = await getProject(userId, projectId);
  if (!project.canvasId) {
    await ensureProjectCanvas(userId, projectId);
    project = await getProject(userId, projectId);
  }
  if (!project.canvasId) throw serviceError('这个项目的画布补建失败', 'STUDIO_CANVAS_MISSING', 409);
  const items = project.boards.items;
  const targets = items.filter((item) => item.imageUrl && !item.nodeKey);
  if (targets.length === 0) {
    throw serviceError('没有要同步的分镜画（画好的都已经在画布上了）', 'STUDIO_NOTHING_TO_PUSH', 400);
  }
  const patches = new Map();
  const failures = [];
  let slot = items.filter((item) => item.nodeKey).length;
  for (const item of targets) {
    const label = `分镜 ${item.shot} · ${item.kind === 'start' ? '首帧' : item.kind === 'end' ? '尾帧' : '主画面'}`;
    try {
      const summary = await getCanvasSummary(userId, project.canvasId);
      const created = await createUploadNodeForPlugin(userId, project.canvasId, {
        expectedRevision: summary.revision,
        name: label,
        // 概念图占了 y=760 那一行，分镜画从 y=1520 起再另开一行，一排四个
        x: (slot % 4) * 620,
        y: 1520 + Math.floor(slot / 4) * 620,
        persistAsset: async () => ({
          url: item.imageUrl,
          displayUrl: item.imageUrl,
          thumbUrl: '',
          originalName: `board-${item.shot}-${item.kind}.png`,
          meta: { kind: 'image', createdAtMs: Date.now() },
        }),
      });
      // 形状跟概念图那条完全一致：nodeKey 在 created.created.nodeKey，别再取错层级
      const nodeKey = created?.created?.nodeKey || '';
      if (!nodeKey) throw new Error('画布没有返回 nodeKey');
      patches.set(item.id, { nodeKey });
      slot += 1;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 200);
      console.error('[studio] 分镜画写入画布失败', label, message);
      failures.push(`${label}：${message}`);
    }
  }
  if (patches.size > 0) {
    const nextItems = items.map((item) => {
      const patch = patches.get(item.id);
      return patch ? { ...item, ...patch } : item;
    });
    await getPool().query('UPDATE studio_projects SET boards = ? WHERE id = ? AND owner_id = ?', [
      JSON.stringify({ settings: project.boards.settings, items: nextItems }),
      Number(projectId), Number(userId),
    ]);
  }
  if (patches.size === 0 && failures.length > 0) {
    throw serviceError(`分镜画都没写进画布：${failures[0]}`, 'STUDIO_CANVAS_WRITE_FAILED', 502);
  }
  return getProject(userId, projectId);
}

/**
 * 设定图 / 参考资料上传。文件落进这个项目自己的 ai_xxxxxx 画布的资产区，直接复用画布
 * 那套 persistUploadedAsset —— sha1 去重、缩略图、对象存储镜像都在它里面，不另起一套存储。
 *
 * 为什么不让前端直接调 /api/assets/upload：那个口是
 * getSessionWritableCanvasForUser -> requireCanvasSession，要画布的独占会话令牌，而
 * AI 出片页面从不进画布、永远拿不到令牌，调过去必吃 428。这里换成按 studio 项目的归属
 * 校验：项目是你的，它的画布就是你的。
 * 绝不在这里替页面去 enter 那张画布 —— 那会把正开着它的人踢下线。
 *
 * canvasRoutes 是个九千行的大模块，这里用惰性 require：放到文件顶部会和 index.js 的
 * 加载顺序绕出循环依赖，拿到 undefined。
 */
async function uploadReference(userId, projectId, file) {
  let project = await getProject(userId, projectId);
  // 缺画布就先补一张，而不是直接 409。用户拖张图进来的时候不该被"这个项目还没有画布"挡住，
  // 那是我们自己的历史 bug 留下的坏数据，不是他做错了什么（2026-08-23）。
  if (!project.canvasId) {
    await ensureProjectCanvas(userId, projectId);
    project = await getProject(userId, projectId);
  }
  if (!project.canvasId) {
    throw serviceError('这个项目的画布补建失败，放不了设定图', 'STUDIO_CANVAS_MISSING', 409);
  }
  const { persistUploadedAsset } = require('../canvasRoutes');
  const asset = await persistUploadedAsset({ id: project.canvasId }, file, {
    projectUuid: String(project.canvasId),
    sourceType: 'studio-reference',
  });
  return {
    url: String(asset?.displayUrl || asset?.url || ''),
    rawUrl: String(asset?.url || ''),
    thumbUrl: String(asset?.thumbUrl || ''),
  };
}

module.exports = {
  // 导出给测试：这个函数取错属性路径就是那个报废了整个 AI 出片功能的 bug，
  // 必须有一条测试盯着"读不出 id 时要抛，不能放 NaN 出去"。
  canvasIdFromSummary,
  createProject,
  deleteProject,
  // 「补建画布」用：也给一次性修数据的脚本用，免得手写 SQL 去动生产库
  ensureProjectCanvas,
  generateConcepts,
  generateStoryboard,
  getProject,
  isStudioAllowed,
  listProjects,
  // 导出给测试用：分辨率/比例/时长的兜底和拒绝逻辑值得单独锁住，
  // 不然一个非法分辨率进了库，要等调生视频接口报错才发现。
  normalizeBrief,
  // 导出给测试：角色/场景/道具的解析在前端 studio.ts 里有一份**同样的实现**，
  // 两边漂移会让用户输入的内容被静默改写。测试拿这个跟前端逐条比对。
  normalizeStoryboard,
  // 分镜绘制（第三阶段）
  generateBoards,
  planBoards,
  pushBoardsToCanvas,
  saveBoards,
  // 动态分镜（第四）与成片（第五）：一套实现两处用，stage 传 'motion' / 'film'
  generateVideoStage,
  planVideoStage,
  pollVideoStage,
  pushVideoStageToCanvas,
  saveVideoStageEdits,
  // 导出给测试：status 由事实推导、正在跑的不许重复提交，这两条直接关系到会不会重复付费
  normalizeVideoStage,
  VIDEO_TWEAKS,
  // 导出给测试：镜号 + kind 的配对不能丢已花钱的图；概念图按名字匹配的宽松规则也要锁住
  mergeBoardImages,
  conceptReferencesForShot,
  normalizeBoards,
  planConcepts,
  pushConceptsToCanvas,
  pushStoryboardToCanvas,
  updateProject,
  uploadReference,
};
