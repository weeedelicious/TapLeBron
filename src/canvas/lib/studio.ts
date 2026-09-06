/**
 * AI 出片（Studio）第一阶段的纯逻辑与口径。
 *
 * 前端网页和服务端都用这一份：选项列表、分镜行的规范化、镜号重排、时长合计。
 * 之所以放在 src 下而不是 server 下 —— 网页是主要使用方，服务端只需要同样的
 * 规范化规则；服务端那份用 JS 重写会立刻漂移，所以服务端只做"信任前端已规范化的
 * 结构 + 自己再钳一遍范围"，口径定义只留这一处。
 *
 * 分镜表的真源是 studio_projects.storyboard（结构化 JSON）。画布里的 script 节点是
 * 给人看的投影：script 节点没有"镜头运动"这一列（它的既有约定是把镜头运动写进画面
 * 描述里），所以投影时会把 movement 并进 action，真值仍在这张表里。
 */

/** 文档里的 6 个项目。跟 sd2 项目管理页的 shotflow 画布分类同口径，另加两个还没建分类的 IP。 */
export const STUDIO_PROJECT_OPTIONS = [
  "火炬之光",
  "心动小镇",
  "香肠派对",
  "伊瑟",
  "出发吧麦芬",
  "仙境传说",
];

/** 故事风格，多选 */
export const STUDIO_STYLE_OPTIONS = [
  "爱情", "恐怖", "冒险", "戏剧", "剧情", "惊悚", "史诗", "科幻",
  "动作", "悬疑", "奇幻", "超级英雄", "侦探", "武侠", "贺岁",
];

/** 成片时长（秒）。分镜总时长按它来配。 */
export const STUDIO_DURATION_OPTIONS = [15, 30, 60, 90, 120, 180];

export const STUDIO_RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "21:9"];

/** 出片分辨率。跟服务端 StudioService 的 RESOLUTIONS 是同一份，改一边必须改另一边。 */
export const STUDIO_RESOLUTION_OPTIONS = ["480P", "720P"];

/** 设定图分组，对应文档「上传设定图：主角 | 配角 | 场景 | 道具」 */
export const STUDIO_REFERENCE_GROUPS = [
  { key: "lead", label: "主角" },
  { key: "support", label: "配角" },
  { key: "scene", label: "场景" },
  { key: "prop", label: "道具" },
] as const;

/** 参考资料条数上限。跟服务端 StudioService 的 REFERENCE_LIMIT 是同一个数，
 *  超出的会被服务端 normalizeReferences 截掉，所以前端也要挡。 */
export const STUDIO_REFERENCE_LIMIT = 40;

export type StudioReferenceGroupKey =
  (typeof STUDIO_REFERENCE_GROUPS)[number]["key"];

/** 景别与镜头运动的建议值。不做强校验 —— 模型和用户都可以写别的。 */
export const STUDIO_SHOT_SIZES = ["大远景", "远景", "全景", "中景", "近景", "特写", "大特写"];
export const STUDIO_CAMERA_MOVES = ["固定", "摇镜", "推镜", "拉镜", "跟镜", "移镜", "升降", "手持"];

export interface StudioStoryboardRow {
  /** 行的稳定 id，加减行时不变；镜号是展示序号，会重排 */
  id: string;
  /** 镜号。默认是 1、2、3…；允许 "4/5" 这种合并镜号（文档样例里就有） */
  shot: string;
  /** 内容：画面主体、动作、环境、情绪 */
  content: string;
  /** 景别 */
  shotSize: string;
  /** 镜头运动 */
  movement: string;
  /** 时间，秒 */
  seconds: number;
  /**
   * 这一镜出场的角色 / 场景 / 道具（2026-08-23 用户要求的「一览」列）。
   * 老分镜没有这三个字段，读出来是空数组 —— 不是 undefined，前端要直接 map。
   */
  roles: string[];
  scenes: string[];
  props: string[];
}

/** 一览列每格最多几项、每项最长多少字。够用就行，防的是模型一口气吐一整段。 */
export const STUDIO_TAG_LIMIT = 8;
export const STUDIO_TAG_MAX_LENGTH = 24;

/**
 * 把「甲、乙，丙」这种人手输入或模型输出解析成数组。
 * 中英文逗号、顿号、分号、换行都当分隔符 —— 用户不该被要求记住用哪一个。
 * 也接受模型直接给的数组。
 */
export function parseTagList(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((item) => String(item ?? ""))
    : String(raw ?? "").split(/[,，、;；\n\r/]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const text = part.trim().slice(0, STUDIO_TAG_MAX_LENGTH);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= STUDIO_TAG_LIMIT) break;
  }
  return out;
}

/** 数组转回输入框里显示的文本。用「、」是因为中文里它比逗号更像并列。 */
export function formatTagList(list: string[] | undefined): string {
  return (list ?? []).join("、");
}

export interface StudioStoryboard {
  rows: StudioStoryboardRow[];
}

export const STUDIO_MAX_ROWS = 200;
const MAX_TEXT = 400;
const MIN_SECONDS = 0.5;
const MAX_SECONDS = 120;

function cleanText(value: unknown, limit = MAX_TEXT) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanSeconds(value: unknown, fallback = 3) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  // 半秒粒度：模型爱给 2.37 这种没法用的值
  const snapped = Math.round(number * 2) / 2;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, snapped));
}

/** 镜号是不是"自动序号"（1、2、3 或 01、02）。合并镜号（4/5）和手填的会被判为 false，重排时保留原样。 */
export function isAutoShotLabel(shot: string) {
  return /^0*\d+$/.test(String(shot ?? "").trim());
}

/**
 * 镜号重排：加减行之后自动跟上。
 * 只重排"自动序号"那些行 —— 用户手动写成 "4/5" 的合并镜号必须原样留着，
 * 否则一加行就把人家标好的合并关系冲掉了。
 */
export function renumberShots(rows: StudioStoryboardRow[]): StudioStoryboardRow[] {
  let next = 1;
  return rows.map((row) => {
    if (!isAutoShotLabel(row.shot)) {
      // 手填镜号不动，但它占掉的序号要跳过，后面的行才接得上
      const numbers = String(row.shot).match(/\d+/g) ?? [];
      for (const text of numbers) next = Math.max(next, Number(text) + 1);
      return row;
    }
    const shot = String(next);
    next += 1;
    return row.shot === shot ? row : { ...row, shot };
  });
}

export function normalizeStoryboardRow(
  raw: unknown,
  index: number,
  makeId: () => string,
): StudioStoryboardRow {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim()) return value;
    }
    return "";
  };
  return {
    id: cleanText(source.id, 64) || makeId(),
    // 模型经常直接用中文键名，一起收下
    shot: cleanText(pick("shot", "镜号"), 16) || String(index + 1),
    content: cleanText(pick("content", "内容", "action", "画面")),
    shotSize: cleanText(pick("shotSize", "景别", "sceneType"), 24),
    movement: cleanText(pick("movement", "镜头运动", "camera"), 24),
    seconds: cleanSeconds(pick("seconds", "时间", "duration", "时长")),
    roles: parseTagList(pick("roles", "角色", "characters", "人物")),
    scenes: parseTagList(pick("scenes", "场景", "scene", "locations")),
    props: parseTagList(pick("props", "道具", "prop", "items")),
  };
}

export function normalizeStoryboard(
  raw: unknown,
  makeId: () => string,
): StudioStoryboard {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { rows?: unknown })?.rows)
      ? ((raw as { rows: unknown[] }).rows)
      : [];
  const rows = list
    .slice(0, STUDIO_MAX_ROWS)
    .map((row, index) => normalizeStoryboardRow(row, index, makeId))
    // 整行都空的直接丢掉：模型有时会尾随几个空对象
    .filter((row) => row.content || row.shotSize || row.movement);
  return { rows: renumberShots(rows) };
}

export function storyboardTotalSeconds(rows: StudioStoryboardRow[]) {
  return rows.reduce((total, row) => total + (Number(row.seconds) || 0), 0);
}

/** 网页上给用户看的偏差提示：跟目标时长差多少 */
export function storyboardDurationDelta(rows: StudioStoryboardRow[], targetSeconds: number) {
  return Math.round((storyboardTotalSeconds(rows) - Number(targetSeconds || 0)) * 10) / 10;
}

// ── 概念图（第二阶段）────────────────────────────────────────────────────

/**
 * 概念图分组。跟设定图上传的四个分组同一套 key —— 概念图补的就是"用户没上传设定图"的那些对象，
 * 两边用同一套 key 才能互相对账。
 */
export const STUDIO_CONCEPT_GROUPS = STUDIO_REFERENCE_GROUPS;

export type StudioConceptGroupKey = StudioReferenceGroupKey;

/** 服务端 StudioService 的 CONCEPT_LIMIT / CONCEPT_BATCH_LIMIT，两边必须一致。 */
export const STUDIO_CONCEPT_LIMIT = 20;
export const STUDIO_CONCEPT_BATCH_LIMIT = 9;

/**
 * 概念图按分组定的比例。只用于在界面上说明"这条会画成什么形状"，
 * 真正决定比例的是服务端的 CONCEPT_RATIO_BY_GROUP（改了要两边一起改）。
 */
export const STUDIO_CONCEPT_RATIO_BY_GROUP: Record<string, string> = {
  lead: "3:4",
  support: "3:4",
  scene: "16:9",
  prop: "1:1",
};

export interface StudioConceptItem {
  id: string;
  group: string;
  /** 短标签，要跟分镜表里的叫法一致，后面阶段才对得上 */
  name: string;
  /** 生图提示词 */
  prompt: string;
  /** 出现在哪几镜，如 "1/3/7 镜" */
  reason: string;
  /** 画好的图。有它就代表这条已经花过钱了 */
  imageUrl: string;
  /** 画布上对应的上传节点。重画会清空它 —— 插件接口改不了已有节点的图片地址 */
  nodeKey: string;
  status: "pending" | "ready" | "failed";
  error: string;
}

export interface StudioConcepts {
  items: StudioConceptItem[];
}

const MAX_CONCEPT_PROMPT = 800;

export function normalizeConceptItem(
  raw: unknown,
  makeId: () => string,
): StudioConceptItem {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // 跟 normalizeStoryboardRow 一样收中文键名：这份是前后端共用的口径定义，
  // 服务端 normalizeConcepts 认中文键，这里不认就是两套规则，迟早漂移。
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim()) return value;
    }
    return "";
  };
  const group = cleanText(pick("group", "分组"), 16);
  const imageUrl = cleanText(source.imageUrl, 600);
  const status = String(source.status ?? "");
  return {
    id: cleanText(source.id, 64) || makeId(),
    group: STUDIO_CONCEPT_GROUPS.some((item) => item.key === group) ? group : "scene",
    name: cleanText(pick("name", "名称"), 60),
    prompt: cleanText(pick("prompt", "提示词"), MAX_CONCEPT_PROMPT),
    reason: cleanText(pick("reason", "依据", "镜号"), 80),
    imageUrl,
    nodeKey: cleanText(source.nodeKey, 64),
    // 跟服务端同一条规矩：status 由"有没有图"推导，不信任传进来的值
    status: imageUrl ? "ready" : status === "failed" ? "failed" : "pending",
    error: imageUrl ? "" : cleanText(source.error, 200),
  };
}

export function normalizeConcepts(raw: unknown, makeId: () => string): StudioConcepts {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown })?.items)
      ? ((raw as { items: unknown[] }).items)
      : [];
  const items = list
    .slice(0, STUDIO_CONCEPT_LIMIT)
    .map((item) => normalizeConceptItem(item, makeId))
    .filter((item) => item.name || item.prompt);
  return { items };
}

/**
 * 这次点「画选中的」会花几次生图。
 *
 * 口径必须跟服务端 generateConcepts 的筛选完全一致：勾中的、有提示词的，
 * 并且（没有图 或者 勾了重画）。按钮上要把这个数字写出来 —— 用户点之前就得知道要花多少钱。
 */
export function studioConceptGenerationCost(
  items: StudioConceptItem[],
  selectedIds: ReadonlySet<string>,
  redraw: boolean,
) {
  return items.filter((item) => {
    if (!selectedIds.has(item.id)) return false;
    if (!item.prompt) return false;
    return redraw || !item.imageUrl;
  }).length;
}

/**
 * 把分镜表投影成 script 节点的 rows。
 * script 节点没有"镜头运动"列（它的既有约定是把镜头运动写进画面描述），
 * 所以这里并进 action；真值仍在 studio_projects.storyboard 里。
 */
export function storyboardToScriptRows(rows: StudioStoryboardRow[]) {
  return rows.map((row) => ({
    id: row.id,
    shot: row.shot,
    sceneType: row.shotSize,
    action: row.movement ? `${row.content}（镜头运动：${row.movement}）` : row.content,
    dialogue: "",
    duration: row.seconds,
  }));
}

// ── 分镜绘制（第三阶段）──────────────────────────────────────────────────

/**
 * 画风。文档写的是「描线 | 彩色 | 日漫 | 美漫 | 上传参考图」，多重选择。
 * 参考图不在这个列表里 —— 它是另一个维度（settings.referenceUrls），
 * 混在一起会让"选了参考图算不算选了画风"变成一个没法回答的问题。
 */
export const STUDIO_BOARD_STYLES = ["描线", "彩色", "日漫", "美漫"];

/**
 * 绘制方法。文档：「主要画面 | 镜头的开始和结束」。
 * 首尾帧是一镜两张 —— 直接决定要花几次钱，所以 perShot 写在这里，界面上算成本要用。
 */
export const STUDIO_BOARD_METHODS = [
  { key: "main", label: "主要画面", perShot: 1, hint: "一镜一张，画这一镜最代表性的那一帧" },
  { key: "endpoints", label: "镜头的开始和结束", perShot: 2, hint: "一镜两张（首帧 + 尾帧），后面做动态分镜能直接用" },
] as const;

export type StudioBoardMethod = (typeof STUDIO_BOARD_METHODS)[number]["key"];
export type StudioBoardKind = "main" | "start" | "end";

/** 服务端 StudioService 的 BOARD_LIMIT / BOARD_BATCH_LIMIT，两边必须一致。 */
export const STUDIO_BOARD_LIMIT = 120;
export const STUDIO_BOARD_BATCH_LIMIT = 9;
/** 参考图条数上限 */
export const STUDIO_BOARD_REFERENCE_LIMIT = 8;

/**
 * 文档「修改构图，角色pose」「修改透视，相机角度，角色位置」列的那几个轴。
 * 做成往提示词里追加的快捷词 —— 修改的机制就是改提示词再重画，
 * 没必要为每个轴单独造一套控件。
 */
export const STUDIO_BOARD_TWEAKS = [
  "改构图", "改透视", "改相机角度", "改角色位置", "改角色pose", "改色调",
];

export interface StudioBoardSettings {
  /** 画风多选，第一个是主调（跟故事风格同一个约定） */
  styles: string[];
  method: StudioBoardMethod;
  /** 用户额外上传的画风参考图地址 */
  referenceUrls: string[];
}

export interface StudioBoardItem {
  id: string;
  /** 镜号，跟分镜表的 shot 对齐 —— 这是两张表唯一的关联键 */
  shot: string;
  kind: StudioBoardKind;
  /** 生图提示词 */
  prompt: string;
  /** 这一张实际用到的参考图（概念图 + 用户上传的），只读，给人核对 */
  referenceUrls: string[];
  imageUrl: string;
  nodeKey: string;
  status: "pending" | "ready" | "failed";
  error: string;
}

export interface StudioBoards {
  settings: StudioBoardSettings;
  items: StudioBoardItem[];
}

const MAX_BOARD_PROMPT = 900;

export function normalizeBoardSettings(raw: unknown): StudioBoardSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const styles = (Array.isArray(source.styles) ? source.styles : [])
    .map((item) => cleanText(item, 12))
    .filter((item) => STUDIO_BOARD_STYLES.includes(item))
    .slice(0, STUDIO_BOARD_STYLES.length);
  const method = cleanText(source.method, 16);
  const referenceUrls = (Array.isArray(source.referenceUrls) ? source.referenceUrls : [])
    .map((item) => cleanText(item, 600))
    .filter(Boolean)
    .slice(0, STUDIO_BOARD_REFERENCE_LIMIT);
  return {
    // 一个都没选就默认「描线」：分镜画的常规做法是先用线稿定构图
    styles: styles.length ? Array.from(new Set(styles)) : ["描线"],
    method: STUDIO_BOARD_METHODS.some((item) => item.key === method)
      ? (method as StudioBoardMethod)
      : "main",
    referenceUrls: Array.from(new Set(referenceUrls)),
  };
}

export function normalizeBoardItem(raw: unknown, makeId: () => string): StudioBoardItem {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim()) return value;
    }
    return "";
  };
  const kind = cleanText(pick("kind", "类型"), 12);
  const imageUrl = cleanText(source.imageUrl, 600);
  const status = String(source.status ?? "");
  return {
    id: cleanText(source.id, 64) || makeId(),
    shot: cleanText(pick("shot", "镜号"), 16),
    kind: kind === "start" || kind === "end" ? kind : "main",
    prompt: cleanText(pick("prompt", "提示词", "画面"), MAX_BOARD_PROMPT),
    referenceUrls: (Array.isArray(source.referenceUrls) ? source.referenceUrls : [])
      .map((item) => cleanText(item, 600))
      .filter(Boolean)
      .slice(0, 12),
    imageUrl,
    nodeKey: cleanText(source.nodeKey, 64),
    // 跟概念图同一条规矩：status 由"有没有图"推导，不信任传进来的值
    status: imageUrl ? "ready" : status === "failed" ? "failed" : "pending",
    error: imageUrl ? "" : cleanText(source.error, 200),
  };
}

export function normalizeBoards(raw: unknown, makeId: () => string): StudioBoards {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(source.items)
      ? (source.items as unknown[])
      : [];
  const items = list
    .slice(0, STUDIO_BOARD_LIMIT)
    .map((item) => normalizeBoardItem(item, makeId))
    // 没镜号又没提示词的整条丢掉：模型偶尔会尾随空对象
    .filter((item) => item.shot || item.prompt);
  return { settings: normalizeBoardSettings(source.settings), items };
}

/** 一次「画选中的」要花几次生图。界面上必须在按钮上写出来。 */
export function boardGenerationCost(
  items: StudioBoardItem[],
  pickedIds: Set<string>,
  redraw: boolean,
): number {
  return items.filter((item) => pickedIds.has(item.id) && (redraw || !item.imageUrl)).length;
}

/** 这一镜要生成哪几个 kind。首尾帧是两条，主要画面是一条。 */
export function boardKindsForMethod(method: StudioBoardMethod): StudioBoardKind[] {
  return method === "endpoints" ? ["start", "end"] : ["main"];
}

export function boardKindLabel(kind: StudioBoardKind): string {
  return kind === "start" ? "首帧" : kind === "end" ? "尾帧" : "主画面";
}

// ── 动态分镜（第四阶段）与成片（第五阶段）────────────────────────────────
//
// 两个阶段形状完全一样，靠 stage 区分（'motion' / 'film'）。跟服务端
// StudioService 的 MOTION_STAGES / normalizeVideoStage 是同一份口径。

export type StudioVideoStage = 'motion' | 'film';

export const STUDIO_VIDEO_STAGES: { key: StudioVideoStage; label: string; hint: string }[] = [
  { key: 'motion', label: '动态分镜', hint: '给人看节奏的草样，默认 480P 更省' },
  { key: 'film', label: '成片', hint: '最终交付，默认 720P' },
];

/** provider 支持的档位。非法值服务端会退回默认，所以前端只给这些选项。 */
export const STUDIO_VIDEO_RESOLUTIONS = ['480P', '720P', '1080P'];
export const STUDIO_VIDEO_DURATIONS = [4, 5, 6, 8, 10, 12];
export const STUDIO_VIDEO_BATCH_LIMIT = 9;

/** 文档「修改：面部 | pose | 局部画面 | 特效」。跟分镜绘制一样做成追加到提示词的快捷词。 */
export const STUDIO_VIDEO_TWEAKS = ['改面部', '改pose', '改局部画面', '改特效'];

export interface StudioVideoSettings {
  model: string;
  resolution: string;
  durationSec: number;
  count: number;
  referenceUrls: string[];
}

export interface StudioVideoItem {
  id: string;
  shot: string;
  prompt: string;
  /** 首帧图（来自分镜画）。没有它就是纯文生视频，角色会漂 */
  sourceImageUrl: string;
  /** 尾帧图，只有分镜画用「首尾帧」方法时才有 */
  endImageUrl: string;
  /** provider 的任务号。有它没视频 = 正在跑；**它是能不重复付费收回结果的唯一凭据** */
  providerTaskId: string;
  videoUrl: string;
  nodeKey: string;
  durationSec: number;
  status: 'pending' | 'running' | 'ready' | 'failed';
  error: string;
}

export interface StudioVideoStageData {
  settings: StudioVideoSettings;
  items: StudioVideoItem[];
  /** 串片结果（只有动态分镜用）。是整条片子的产物，所以不在 items 里 */
  reelUrl: string;
  reelNodeKey: string;
}

/** 空壳，给前端初始 state 和老项目兜底用。 */
export function emptyVideoStage(stage: StudioVideoStage): StudioVideoStageData {
  return {
    settings: {
      model: 'Seedance_2_5',
      resolution: stage === 'motion' ? '480P' : '720P',
      durationSec: 5,
      count: 1,
      referenceUrls: [],
    },
    items: [],
    reelUrl: '',
    reelNodeKey: '',
  };
}

/**
 * 这一次「生成选中的」要提交几条。
 * **正在跑的（running）不算**——它们已经付过费了，再提交一次就是双倍花钱。
 */
export function videoGenerationCost(
  items: StudioVideoItem[],
  pickedIds: Set<string>,
  redraw: boolean,
): number {
  return items.filter((item) => {
    if (!pickedIds.has(item.id)) return false;
    if (item.status === 'running') return false;
    return redraw || !item.videoUrl;
  }).length;
}

/** 还有没有在跑的条目 —— 有就该继续轮询。 */
export function hasRunningVideos(items: StudioVideoItem[]): boolean {
  return items.some((item) => item.status === 'running');
}

export function videoStatusLabel(item: StudioVideoItem): string {
  if (item.videoUrl) return item.nodeKey ? '已在画布' : '待同步';
  if (item.status === 'running') return '生成中';
  if (item.status === 'failed') return '失败';
  return '未生成';
}
