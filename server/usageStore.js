const crypto = require('crypto');
const { getUsagePool } = require('./db');

const VALID_TYPES = new Set(['image', 'video', 'text']);
const VALID_STATUSES = new Set(['submitted', 'succeeded', 'failed', 'cancelled']);
const VALID_VIDEO_TASK_STATUSES = new Set(['submitted', 'running', 'succeeded', 'failed', 'cancelled']);
const PERIODS = new Set(['day', 'week', 'month', 'year']);

function safeJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonString(value) {
  return value == null ? null : JSON.stringify(value);
}

function text(value, max = 4000) {
  return String(value || '').slice(0, max);
}

function dateKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

function sqlDateTime(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function parseDateKey(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return dateKey();
}

function shanghaiDate(dateKeyValue) {
  return new Date(`${dateKeyValue}T00:00:00+08:00`);
}

function startOfWeek(base, parsedDate) {
  const day = new Date(`${parsedDate}T12:00:00+08:00`).getUTCDay() || 7;
  return addDays(base, 1 - day);
}

function partsFromDateKey(value) {
  const [year, month, day] = parseDateKey(value).split('-').map((part) => Number(part));
  return { year, month, day };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function rangeForPeriod(periodValue, dateValue) {
  const period = PERIODS.has(periodValue) ? periodValue : 'day';
  const parsedDate = parseDateKey(dateValue);
  const base = shanghaiDate(parsedDate);
  const parts = partsFromDateKey(parsedDate);
  let start = base;
  let end = addDays(base, 1);

  if (period === 'week') {
    start = startOfWeek(base, parsedDate);
    end = addDays(start, 7);
  } else if (period === 'month') {
    start = shanghaiDate(`${parts.year}-${pad2(parts.month)}-01`);
    const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
    const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
    end = shanghaiDate(`${nextYear}-${pad2(nextMonth)}-01`);
  } else if (period === 'year') {
    start = shanghaiDate(`${parts.year}-01-01`);
    end = shanghaiDate(`${parts.year + 1}-01-01`);
  }

  return {
    period,
    start,
    end,
    startSql: sqlDateTime(start),
    endSql: sqlDateTime(end),
    date: parseDateKey(dateValue),
  };
}

function requestHashFor(entry) {
  const payload = [
    entry.userId,
    entry.projectUuid,
    entry.nodeKey,
    entry.operationType,
    entry.endpoint,
    entry.model,
    entry.mode,
    entry.quantity,
    entry.promptPreview,
    JSON.stringify(entry.settings || {}),
    JSON.stringify(entry.inputCounts || {}),
  ].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function normalizeCreatedEntry(input) {
  const operationType = VALID_TYPES.has(input.operationType) ? input.operationType : 'text';
  const quantity = Math.max(1, Math.min(999, Number(input.quantity || 1) || 1));
  const promptPreview = text(input.promptPreview || input.prompt || '', 4000);
  return {
    userId: Number.isFinite(Number(input.userId)) ? Number(input.userId) : null,
    username: text(input.username || 'unknown', 80),
    userRole: text(input.userRole || '', 32),
    canvasId: Number.isFinite(Number(input.canvasId)) ? Number(input.canvasId) : null,
    projectUuid: input.projectUuid ? text(input.projectUuid, 64) : null,
    canvasTitle: input.canvasTitle ? text(input.canvasTitle, 180) : null,
    nodeKey: input.nodeKey ? text(input.nodeKey, 255) : null,
    operationType,
    endpoint: text(input.endpoint || '', 120),
    provider: input.provider ? text(input.provider, 64) : null,
    model: text(input.model || 'unknown', 160),
    mode: input.mode ? text(input.mode, 80) : null,
    status: VALID_STATUSES.has(input.status) ? input.status : 'submitted',
    quantity,
    promptChars: Math.max(0, Number(input.promptChars || promptPreview.length) || 0),
    promptPreview,
    inputCounts: input.inputCounts || null,
    settings: input.settings || null,
    providerJobIds: input.providerJobIds || null,
    resultCount: Math.max(0, Number(input.resultCount || 0) || 0),
    errorMessage: input.errorMessage ? text(input.errorMessage, 4000) : null,
  };
}

async function createPaidUsageLog(input) {
  const entry = normalizeCreatedEntry(input);
  const requestHash = input.requestHash || requestHashFor(entry);
  const [result] = await getUsagePool().query(
    `INSERT INTO paid_usage_logs
      (user_id, username, user_role, canvas_id, project_uuid, canvas_title, node_key,
       operation_type, endpoint, provider, model, mode, status, quantity, prompt_chars,
       prompt_preview, input_counts, settings, provider_job_ids, result_count, error_message, request_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId,
      entry.username,
      entry.userRole,
      entry.canvasId,
      entry.projectUuid,
      entry.canvasTitle,
      entry.nodeKey,
      entry.operationType,
      entry.endpoint,
      entry.provider,
      entry.model,
      entry.mode,
      entry.status,
      entry.quantity,
      entry.promptChars,
      entry.promptPreview,
      jsonString(entry.inputCounts),
      jsonString(entry.settings),
      jsonString(entry.providerJobIds),
      entry.resultCount,
      entry.errorMessage,
      requestHash,
    ]
  );
  return Number(result.insertId);
}

async function updatePaidUsageLog(id, patch = {}) {
  const logId = Number(id);
  if (!Number.isFinite(logId) || logId <= 0) return false;
  const updates = [];
  const params = [];

  if (patch.status && VALID_STATUSES.has(patch.status)) {
    updates.push('status = ?');
    params.push(patch.status);
    if (patch.status !== 'submitted') {
      updates.push('completed_at = CURRENT_TIMESTAMP');
    }
  }
  if (patch.providerJobIds !== undefined) {
    updates.push('provider_job_ids = ?');
    params.push(jsonString(patch.providerJobIds));
  }
  if (patch.resultCount !== undefined) {
    updates.push('result_count = ?');
    params.push(Math.max(0, Number(patch.resultCount || 0) || 0));
  }
  if (patch.errorMessage !== undefined) {
    updates.push('error_message = ?');
    params.push(patch.errorMessage ? text(patch.errorMessage, 4000) : null);
  }
  if (patch.settings !== undefined) {
    updates.push('settings = ?');
    params.push(jsonString(patch.settings));
  }

  if (!updates.length) return false;
  params.push(logId);
  await getUsagePool().query(`UPDATE paid_usage_logs SET ${updates.join(', ')} WHERE id = ?`, params);
  return true;
}

function normalizeVideoTaskEntry(input = {}) {
  const quantity = Math.max(1, Math.min(999, Number(input.quantity || 1) || 1));
  const durationSec = Math.max(0, Number(input.durationSec || input.duration || 0) || 0);
  return {
    usageLogId: Number.isFinite(Number(input.usageLogId)) ? Number(input.usageLogId) : null,
    userId: Number.isFinite(Number(input.userId)) ? Number(input.userId) : null,
    username: text(input.username || 'unknown', 80),
    canvasId: Number.isFinite(Number(input.canvasId)) ? Number(input.canvasId) : null,
    projectUuid: input.projectUuid ? text(input.projectUuid, 64) : null,
    canvasTitle: input.canvasTitle ? text(input.canvasTitle, 180) : null,
    nodeKey: input.nodeKey ? text(input.nodeKey, 255) : null,
    internalJobId: text(input.internalJobId || input.internalId || '', 80),
    provider: input.provider ? text(input.provider, 64) : null,
    model: text(input.model || 'unknown', 160),
    mode: input.mode ? text(input.mode, 80) : null,
    ratio: input.ratio ? text(input.ratio, 24) : null,
    resolution: input.resolution ? text(input.resolution, 24) : null,
    durationSec,
    quantity,
    status: VALID_VIDEO_TASK_STATUSES.has(input.status) ? input.status : 'submitted',
    promptPreview: text(input.promptPreview || input.prompt || '', 4000),
    submissionParams: input.submissionParams || null,
    referenceMaterials: Array.isArray(input.referenceMaterials) ? input.referenceMaterials : [],
    providerJobIds: Array.isArray(input.providerJobIds) ? input.providerJobIds : [],
    providerStatus: input.providerStatus || null,
    resultUrls: Array.isArray(input.resultUrls) ? input.resultUrls : [],
    errorMessage: input.errorMessage ? text(input.errorMessage, 4000) : null,
  };
}

async function createVideoTaskDetail(input) {
  const entry = normalizeVideoTaskEntry(input);
  if (!entry.internalJobId) return null;
  const [result] = await getUsagePool().query(
    `INSERT INTO video_task_details
      (usage_log_id, user_id, username, canvas_id, project_uuid, canvas_title, node_key,
       internal_job_id, provider, model, mode, ratio, resolution, duration_sec, quantity, status,
       prompt_preview, submission_params, reference_materials, provider_job_ids, provider_status,
       result_urls, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.usageLogId,
      entry.userId,
      entry.username,
      entry.canvasId,
      entry.projectUuid,
      entry.canvasTitle,
      entry.nodeKey,
      entry.internalJobId,
      entry.provider,
      entry.model,
      entry.mode,
      entry.ratio,
      entry.resolution,
      entry.durationSec,
      entry.quantity,
      entry.status,
      entry.promptPreview,
      jsonString(entry.submissionParams),
      jsonString(entry.referenceMaterials),
      jsonString(entry.providerJobIds),
      jsonString(entry.providerStatus),
      jsonString(entry.resultUrls),
      entry.errorMessage,
    ]
  );
  return Number(result.insertId);
}

async function updateVideoTaskDetail(id, patch = {}) {
  const detailId = Number(id);
  if (!Number.isFinite(detailId) || detailId <= 0) return false;
  const updates = [];
  const params = [];

  if (patch.status && VALID_VIDEO_TASK_STATUSES.has(patch.status)) {
    updates.push('status = ?');
    params.push(patch.status);
    if (patch.status !== 'submitted' && patch.status !== 'running') {
      updates.push('completed_at = CURRENT_TIMESTAMP');
    }
  }
  if (patch.providerJobIds !== undefined) {
    updates.push('provider_job_ids = ?');
    params.push(jsonString(Array.isArray(patch.providerJobIds) ? patch.providerJobIds : []));
  }
  if (patch.providerStatus !== undefined) {
    updates.push('provider_status = ?');
    params.push(jsonString(patch.providerStatus));
  }
  if (patch.resultUrls !== undefined) {
    updates.push('result_urls = ?');
    params.push(jsonString(Array.isArray(patch.resultUrls) ? patch.resultUrls : []));
  }
  if (patch.errorMessage !== undefined) {
    updates.push('error_message = ?');
    params.push(patch.errorMessage ? text(patch.errorMessage, 4000) : null);
  }
  if (patch.submissionParams !== undefined) {
    updates.push('submission_params = ?');
    params.push(jsonString(patch.submissionParams));
  }
  if (patch.referenceMaterials !== undefined) {
    updates.push('reference_materials = ?');
    params.push(jsonString(Array.isArray(patch.referenceMaterials) ? patch.referenceMaterials : []));
  }

  if (!updates.length) return false;
  params.push(detailId);
  await getUsagePool().query(`UPDATE video_task_details SET ${updates.join(', ')} WHERE id = ?`, params);
  return true;
}

function rowToVideoTaskDetail(row) {
  return {
    id: String(row.id),
    usageLogId: row.usage_log_id == null ? null : Number(row.usage_log_id),
    internalJobId: row.internal_job_id,
    provider: row.provider,
    model: row.model,
    mode: row.mode,
    ratio: row.ratio,
    resolution: row.resolution,
    durationSec: Number(row.duration_sec || 0),
    quantity: Number(row.quantity || 0),
    status: row.status,
    promptPreview: row.prompt_preview || '',
    submissionParams: safeJson(row.submission_params, {}),
    referenceMaterials: safeJson(row.reference_materials, []),
    providerJobIds: safeJson(row.provider_job_ids, []),
    providerStatus: safeJson(row.provider_status, {}),
    resultUrls: safeJson(row.result_urls, []),
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

async function listVideoTaskDetailsByUsageIds(usageIds = []) {
  const ids = [...new Set(usageIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await getUsagePool().query(
    `SELECT *
     FROM video_task_details
     WHERE usage_log_id IN (${placeholders})
     ORDER BY created_at DESC, id DESC`,
    ids
  );
  const map = new Map();
  for (const row of rows) {
    const usageLogId = Number(row.usage_log_id);
    if (!map.has(usageLogId)) map.set(usageLogId, rowToVideoTaskDetail(row));
  }
  return map;
}

function rowToLog(row) {
  const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : 0;
  const completedAtMs = row.completed_at ? new Date(row.completed_at).getTime() : null;
  return {
    id: String(row.id),
    userId: row.user_id == null ? null : Number(row.user_id),
    username: row.username,
    userRole: row.user_role,
    canvasId: row.canvas_id == null ? null : Number(row.canvas_id),
    projectUuid: row.project_uuid,
    canvasTitle: row.canvas_title,
    nodeKey: row.node_key,
    operationType: row.operation_type,
    endpoint: row.endpoint,
    provider: row.provider,
    model: row.model,
    mode: row.mode,
    status: row.status,
    quantity: Number(row.quantity || 0),
    promptChars: Number(row.prompt_chars || 0),
    promptPreview: row.prompt_preview || '',
    inputCounts: safeJson(row.input_counts, {}),
    settings: safeJson(row.settings, {}),
    providerJobIds: safeJson(row.provider_job_ids, []),
    resultCount: Number(row.result_count || 0),
    errorMessage: row.error_message || '',
    createdAtMs,
    createdAt: row.created_at,
    completedAtMs,
    completedAt: row.completed_at,
  };
}

function appendWhere(filters) {
  const range = rangeForPeriod(filters.period, filters.date);
  const where = ['created_at >= ?', 'created_at < ?'];
  const params = [range.startSql, range.endSql];

  if (filters.userId && filters.userId !== 'all') {
    where.push('user_id = ?');
    params.push(Number(filters.userId));
  }
  if (filters.type && VALID_TYPES.has(filters.type)) {
    where.push('operation_type = ?');
    params.push(filters.type);
  }
  if (filters.model && filters.model !== 'all') {
    where.push('model = ?');
    params.push(String(filters.model));
  }
  if (filters.status && VALID_STATUSES.has(filters.status)) {
    where.push('status = ?');
    params.push(filters.status);
  }

  return { range, whereSql: where.join(' AND '), params };
}

async function listPaidUsage(filters = {}) {
  const { range, whereSql, params } = appendWhere(filters);
  const limit = Math.max(1, Math.min(1000, Number(filters.limit || 300) || 300));
  const db = getUsagePool();

  const [rows] = await db.query(
    `SELECT *
     FROM paid_usage_logs
     WHERE ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...params, limit]
  );

  const [summaryRows] = await db.query(
    `SELECT
       operation_type,
       COUNT(*) AS records,
       COALESCE(SUM(quantity), 0) AS quantity,
       COALESCE(SUM(result_count), 0) AS results
     FROM paid_usage_logs
     WHERE ${whereSql}
     GROUP BY operation_type`,
    params
  );

  const videoDurationSql = `quantity * COALESCE(
    CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.duration')), '') AS DECIMAL(10, 2)),
    CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.durationSec')), '') AS DECIMAL(10, 2)),
    CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.seconds')), '') AS DECIMAL(10, 2)),
    0
  )`;
  const videoResolutionSql = `UPPER(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.resolution')), ''), ''))`;

  const summaryOrderBy = filters.sort === 'image_quantity_desc'
    ? 'image_quantity DESC, video_seconds DESC, records DESC, username ASC'
    : filters.sort === 'video_seconds_desc'
      ? 'video_seconds DESC, image_quantity DESC, records DESC, username ASC'
      : 'quantity DESC, records DESC, username ASC';

  const [userRows] = await db.query(
    `SELECT
       user_id,
       username,
       COUNT(*) AS records,
       COALESCE(SUM(quantity), 0) AS quantity,
       COALESCE(SUM(CASE WHEN operation_type = 'image' THEN quantity ELSE 0 END), 0) AS image_quantity,
       COALESCE(SUM(CASE WHEN operation_type = 'video' THEN quantity ELSE 0 END), 0) AS video_quantity,
       COALESCE(SUM(CASE WHEN operation_type = 'video' THEN ${videoDurationSql} ELSE 0 END), 0) AS video_seconds,
       COALESCE(SUM(CASE WHEN operation_type = 'video' AND ${videoResolutionSql} = '480P' THEN ${videoDurationSql} ELSE 0 END), 0) AS video_480p_seconds,
       COALESCE(SUM(CASE WHEN operation_type = 'video' AND ${videoResolutionSql} = '720P' THEN ${videoDurationSql} ELSE 0 END), 0) AS video_720p_seconds,
       COALESCE(SUM(CASE WHEN operation_type = 'video' AND ${videoResolutionSql} = '1080P' THEN ${videoDurationSql} ELSE 0 END), 0) AS video_1080p_seconds,
       COALESCE(SUM(CASE WHEN operation_type = 'video' AND ${videoResolutionSql} = '4K' THEN ${videoDurationSql} ELSE 0 END), 0) AS video_4k_seconds,
       COALESCE(SUM(CASE WHEN operation_type = 'video' AND ${videoResolutionSql} = '768P' THEN ${videoDurationSql} ELSE 0 END), 0) AS video_768p_seconds,
       COALESCE(SUM(CASE WHEN operation_type = 'video' AND ${videoResolutionSql} = '2K' THEN ${videoDurationSql} ELSE 0 END), 0) AS video_2k_seconds,
       COALESCE(SUM(CASE WHEN operation_type = 'text' THEN quantity ELSE 0 END), 0) AS text_quantity
     FROM paid_usage_logs
     WHERE ${whereSql}
     GROUP BY user_id, username
     ORDER BY ${summaryOrderBy}`,
    params
  );

  const [models] = await db.query(
    `SELECT DISTINCT model
     FROM paid_usage_logs
     WHERE model IS NOT NULL AND model <> ''
     ORDER BY model ASC`
  );

  const [userOptionRows] = await db.query(
    `SELECT user_id, MAX(username) AS username
     FROM paid_usage_logs
     WHERE user_id IS NOT NULL AND username IS NOT NULL AND username <> ''
     GROUP BY user_id
     ORDER BY username ASC`
  );

  // Per-user × per-model breakdown (含视频秒数), so 用户汇总 can show which models
  // each user switched between — including the video-node MiniMax model.
  const [userModelRows] = await db.query(
    `SELECT
       user_id,
       model,
       operation_type,
       COUNT(*) AS records,
       COALESCE(SUM(quantity), 0) AS quantity,
       COALESCE(SUM(CASE WHEN operation_type = 'video' THEN ${videoDurationSql} ELSE 0 END), 0) AS video_seconds
     FROM paid_usage_logs
     WHERE ${whereSql}
     GROUP BY user_id, model, operation_type
     ORDER BY quantity DESC, records DESC, model ASC`,
    params
  );
  const byModelByUser = new Map();
  for (const row of userModelRows) {
    const key = row.user_id == null ? 'null' : String(row.user_id);
    if (!byModelByUser.has(key)) byModelByUser.set(key, []);
    byModelByUser.get(key).push({
      model: row.model || 'unknown',
      operationType: row.operation_type,
      records: Number(row.records || 0),
      quantity: Number(row.quantity || 0),
      videoSeconds: Number(row.video_seconds || 0),
    });
  }

  const summary = {
    records: 0,
    quantity: 0,
    results: 0,
    byType: {
      image: { records: 0, quantity: 0, results: 0 },
      video: { records: 0, quantity: 0, results: 0 },
      text: { records: 0, quantity: 0, results: 0 },
    },
  };

  for (const row of summaryRows) {
    const item = {
      records: Number(row.records || 0),
      quantity: Number(row.quantity || 0),
      results: Number(row.results || 0),
    };
    summary.byType[row.operation_type] = item;
    summary.records += item.records;
    summary.quantity += item.quantity;
    summary.results += item.results;
  }

  const records = rows.map(rowToLog);
  const videoTasksByUsage = await listVideoTaskDetailsByUsageIds(
    records.filter((record) => record.operationType === 'video').map((record) => record.id)
  );

  return {
    range: {
      period: range.period,
      date: range.date,
      start: range.startSql,
      end: range.endSql,
    },
    summary,
    users: userRows.map((row) => ({
      userId: row.user_id == null ? null : Number(row.user_id),
      username: row.username,
      records: Number(row.records || 0),
      quantity: Number(row.quantity || 0),
      imageQuantity: Number(row.image_quantity || 0),
      videoQuantity: Number(row.video_quantity || 0),
      videoSeconds: Number(row.video_seconds || 0),
      videoSecondsByResolution: {
        '480P': Number(row.video_480p_seconds || 0),
        '720P': Number(row.video_720p_seconds || 0),
        '768P': Number(row.video_768p_seconds || 0),
        '1080P': Number(row.video_1080p_seconds || 0),
        '2K': Number(row.video_2k_seconds || 0),
        '4K': Number(row.video_4k_seconds || 0),
      },
      textQuantity: Number(row.text_quantity || 0),
      byModel: byModelByUser.get(row.user_id == null ? 'null' : String(row.user_id)) || [],
    })),
    models: models.map((row) => row.model).filter(Boolean),
    userOptions: userOptionRows.map((row) => ({
      userId: row.user_id == null ? null : Number(row.user_id),
      username: row.username,
    })),
    records: records.map((record) => ({
      ...record,
      videoTask: videoTasksByUsage.get(Number(record.id)) || null,
    })),
  };
}

module.exports = {
  createPaidUsageLog,
  createVideoTaskDetail,
  listPaidUsage,
  updatePaidUsageLog,
  updateVideoTaskDetail,
};
