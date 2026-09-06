const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function requireEnv(name, fallback) {
  const value = process.env[name] || fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function normalizeApiBaseUrl(value, fallback) {
  const raw = String(value || fallback || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
}

function normalizeOptionalUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  return raw || '';
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function positiveIntegerList(value, fallback = '') {
  return [...new Set(String(value || fallback)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item > 0))];
}

function databaseConfig(prefix, fallback = {}) {
  const host = process.env[`${prefix}_HOST`] || fallback.host || '127.0.0.1';
  const port = Number(process.env[`${prefix}_PORT`] || fallback.port || 3306);
  const user = process.env[`${prefix}_USER`] || fallback.user || '';
  const password = process.env[`${prefix}_PASSWORD`] || fallback.password || '';
  const database = process.env[`${prefix}_NAME`] || fallback.database || '';
  return {
    host,
    port,
    user: requireEnv(`${prefix}_USER`, user),
    password: requireEnv(`${prefix}_PASSWORD`, password),
    database: requireEnv(`${prefix}_NAME`, database),
    charset: 'utf8mb4'
  };
}

const adminDb = databaseConfig('DB');
const contentDb = databaseConfig('CANVAS_DB', adminDb);
const usageDb = databaseConfig('USAGE_DB', {
  ...adminDb,
  database: process.env.USAGE_DB_NAME || `${adminDb.database}_usage`
});
const errorDb = databaseConfig('ERROR_DB', {
  ...adminDb,
  database: process.env.ERROR_DB_NAME || `${adminDb.database}_errors`
});

module.exports = {
  port: Number(process.env.PORT || 3020),
  sessionSecret: requireEnv('SESSION_SECRET'),
  projectsDir: process.env.PROJECTS_DIR || path.join(__dirname, '..', 'data', 'projects'),
  backupRootDir: process.env.BACKUP_ROOT_DIR || path.join(__dirname, '..', 'data', 'backups'),
  backupAlertWebhookUrl: normalizeOptionalUrl(process.env.BACKUP_ALERT_WEBHOOK_URL),
  backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS || 14),
  mivoBaseUrl: process.env.MIVO_BASE_URL || 'https://aigc.xindong.com',
  mivoApiKey: process.env.MIVO_API_KEY || process.env.MIVO_USER_SUB || '',
  openaiBaseUrl: normalizeApiBaseUrl(process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL, 'https://api.openai.com'),
  openaiApiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '',
  llmBaseUrl: process.env.LLM_BASE_URL || 'https://llm-proxy.tapsvc.com',
  llmApiKey: process.env.LLM_API_KEY || '',
  // 后端所有纯文本/对话调用的默认模型。2026-08-17 从 gpt-5.5 换成 GPT-5.6 Sol：
  // 网关账号白名单里已经没有 gpt-5.5 了，写死它的地方会直接报
  // "user not allowed to access model"。目录里没有裸的 gpt-5.6-sol，Sol 只有
  // codex/ 这一条路由，而白名单里有 codex/*。要整体换模型只改这一行。
  defaultChatModel: String(process.env.DEFAULT_CHAT_MODEL || 'codex/gpt-5.6-sol').trim(),
  // 画布内 Cindy。2026-08-24 起「聊天 + 默认模式」对所有登录账号开放，
  // 一键出片 / 电影大师这两个 Skill 模式仍然按名单开（它们还在打磨，且更烧钱）。
  cindyAssistant: {
    // 聊天的收窄名单。**空 = 不限制，所有登录账号都能用** —— 这是现在的常态。
    // 只在出了事（比如成本失控）需要临时收回时，才在 .env 里给
    // CINDY_ASSISTANT_RESTRICT_USER_IDS 列 id，改完重启即可，不用动代码。
    restrictToUserIds: positiveIntegerList(process.env.CINDY_ASSISTANT_RESTRICT_USER_IDS, ''),
    // 高级 Skill 模式（film / master）的名单。默认沿用老的
    // CINDY_ASSISTANT_ALLOWED_USER_IDS —— 放开聊天之前谁有这两个模式，放开之后还是谁有，
    // 生产 .env 一个字都不用改。
    advancedModeUserIds: positiveIntegerList(
      process.env.CINDY_ASSISTANT_ADVANCED_MODE_USER_IDS || process.env.CINDY_ASSISTANT_ALLOWED_USER_IDS,
      '1',
    ),
    model: String(process.env.CINDY_ASSISTANT_MODEL || process.env.DEFAULT_CHAT_MODEL || 'codex/gpt-5.6-sol').trim(),
    timeoutMs: Number(process.env.CINDY_ASSISTANT_TIMEOUT_MS || 120_000),
  },
  // AI 出片（Studio）。默认只对用户 1（吴逸翔）开放，要放开就在 .env 里给
  // STUDIO_ALLOWED_USER_IDS 逗号分隔的 id 列表。
  studio: {
    allowedUserIds: positiveIntegerList(process.env.STUDIO_ALLOWED_USER_IDS, '1'),
    model: String(process.env.STUDIO_MODEL || process.env.CINDY_ASSISTANT_MODEL || process.env.DEFAULT_CHAT_MODEL || 'codex/gpt-5.6-sol').trim(),
    timeoutMs: Number(process.env.STUDIO_TIMEOUT_MS || 180_000),
  },
  lightStageGeometry: {
    serviceUrl: normalizeOptionalUrl(process.env.MOGE_SERVICE_URL),
    serviceToken: process.env.MOGE_SERVICE_TOKEN || '',
    timeoutMs: Number(process.env.MOGE_TIMEOUT_MS || 180_000),
    healthTimeoutMs: Number(process.env.MOGE_HEALTH_TIMEOUT_MS || 2_500),
    allowLocalFallback: asBool(process.env.MOGE_ALLOW_LOCAL_FALLBACK, true),
  },
  subjectMatting: {
    serviceUrl: normalizeOptionalUrl(process.env.SUBJECT_MATTING_SERVICE_URL),
    serviceToken: process.env.SUBJECT_MATTING_SERVICE_TOKEN || '',
    timeoutMs: Number(process.env.SUBJECT_MATTING_TIMEOUT_MS || 180_000),
    allowLocalFallback: asBool(process.env.SUBJECT_MATTING_ALLOW_LOCAL_FALLBACK, true),
  },
  appearanceTransfer: {
    // Lighting-descriptor vision analysis for the atmosphere-transfer tool.
    // A cheap chat/vision call (not paid image generation), so it defaults ON;
    // flip SHOTFLOW_APPEARANCE_DESCRIPTOR_ENABLED=0 to kill it without a redeploy.
    descriptorEnabled: asBool(process.env.SHOTFLOW_APPEARANCE_DESCRIPTOR_ENABLED, true),
    // Primary analyzer model (declares capability `lighting.reference-descriptor`).
    descriptorModel: String(process.env.SHOTFLOW_APPEARANCE_DESCRIPTOR_MODEL || 'gemini-3.1-flash-image').trim(),
    // Fallback used on the second attempt if the gateway does not serve the primary.
    descriptorFallbackModel: String(process.env.SHOTFLOW_APPEARANCE_DESCRIPTOR_FALLBACK_MODEL || 'gemini-3.1-flash-image').trim(),
  },
  objectStorage: {
    backend: String(process.env.OBJECT_STORAGE_BACKEND || 'local').trim().toLowerCase(),
    endpoint: normalizeOptionalUrl(process.env.OBJECT_STORAGE_ENDPOINT),
    region: process.env.OBJECT_STORAGE_REGION || 'us-east-1',
    bucket: String(process.env.OBJECT_STORAGE_BUCKET || 'shotflow-assets').trim(),
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY || '',
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY || '',
    forcePathStyle: asBool(process.env.OBJECT_STORAGE_FORCE_PATH_STYLE, true),
    prefix: String(process.env.OBJECT_STORAGE_PREFIX || 'shotflow').trim().replace(/^\/+|\/+$/g, ''),
    autoMirrorLocalAssets: asBool(process.env.OBJECT_STORAGE_AUTO_MIRROR, false),
    publicBaseUrl: normalizePublicBaseUrl(process.env.OBJECT_STORAGE_PUBLIC_BASE_URL),
  },
  db: {
    admin: adminDb,
    content: contentDb,
    usage: usageDb,
    errors: errorDb
  },
  projectCatalog: {
    backend: String(process.env.PROJECT_CATALOG_BACKEND || 'local').trim().toLowerCase(),
    host: process.env.PROJECT_CATALOG_HOST || '127.0.0.1',
    port: Number(process.env.PROJECT_CATALOG_PORT || 3306),
    user: process.env.PROJECT_CATALOG_USER || '',
    password: process.env.PROJECT_CATALOG_PASSWORD || '',
    database: process.env.PROJECT_CATALOG_NAME || 'sd2_project_mgmt',
    mainDatabase: process.env.PROJECT_CATALOG_MAIN_DB || 'sd2_studio',
    charset: 'utf8mb4'
  },
  initialAdmin: {
    username: process.env.INITIAL_ADMIN_USERNAME || '吴逸翔',
    password: requireEnv('INITIAL_ADMIN_PASSWORD')
  }
};
