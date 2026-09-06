const crypto = require('crypto');
const { getAdminPool, getContentPool, getErrorPool, getUsagePool, parseJsonDocument } = require('../db');

const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|password|cookie/i;

function text(value, max = 4000) {
  return String(value == null ? '' : value).slice(0, max);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const SQL_TIMESTAMP_TIME_ZONE = process.env.SHOTFLOW_SQL_TIME_ZONE || 'Asia/Shanghai';

function zonedDateParts(date, timeZone = SQL_TIMESTAMP_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  const hour = part('hour') === '24' ? '00' : part('hour');
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour,
    minute: part('minute'),
    second: part('second'),
  };
}

function sqlTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const raw = value.trim();
    const isSqlTimestamp = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(raw);
    const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    if (isSqlTimestamp && !hasExplicitZone) return raw.slice(0, 19).replace('T', ' ');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = zonedDateParts(date);
  if (!parts.year || !parts.month || !parts.day) return null;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function redactText(value, max = 4000) {
  return text(value, max)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}\b/gi, 'Bearer [REDACTED]');
}

function sanitizeValue(value, depth = 0) {
  if (depth > 6) return '[内容过深，已省略]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value, 12000);
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== 'object') return text(value, 1000);

  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 120)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[已隐藏]' : sanitizeValue(item, depth + 1);
  }
  return result;
}

function jsonDocument(value, max = 120000) {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'string' ? parseJsonDocument(value, value) : value;
  try {
    return JSON.stringify(sanitizeValue(parsed)).slice(0, max);
  } catch {
    return JSON.stringify(redactText(value, Math.min(max, 12000)));
  }
}

function parseStoredJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function errorMetadata(message, explicitStatus) {
  const cleanMessage = redactText(message || '未知生成错误', 32000);
  const statusMatch = cleanMessage.match(/status(?:\s+code)?\s*[:=]?\s*(\d{3})/i)
    || cleanMessage.match(/"code"\s*:\s*(\d{3})/i);
  const codeMatch = cleanMessage.match(/(?:code|error_code)\s*[:=]\s*["']?([A-Z0-9_.-]{2,80})/i);
  return {
    message: cleanMessage,
    httpStatus: numberOrNull(explicitStatus) || numberOrNull(statusMatch?.[1]),
    errorCode: codeMatch?.[1] ? text(codeMatch[1], 160) : null,
  };
}

function nodeDisplayName(node, fallback) {
  const data = node?.data || {};
  return text(
    data.name || data.label || data.title || data.nodeName || node?.name || fallback || '未知节点',
    255
  );
}

async function resolveCanvasAndNode({ canvasId, projectUuid, nodeKey, taskType }) {
  let canvas = null;
  if (canvasId) {
    const [rows] = await getAdminPool().query(
      'SELECT id, uuid, title, data FROM canvases WHERE id = ? LIMIT 1',
      [canvasId]
    );
    canvas = rows[0] || null;
  } else if (projectUuid) {
    const [rows] = await getAdminPool().query(
      'SELECT id, uuid, title, data FROM canvases WHERE uuid = ? LIMIT 1',
      [projectUuid]
    );
    canvas = rows[0] || null;
  }

  let document = parseJsonDocument(canvas?.data, {});
  if (canvas?.id) {
    try {
      const [contentRows] = await getContentPool().query(
        'SELECT data FROM canvas_content WHERE canvas_id = ? LIMIT 1',
        [canvas.id]
      );
      if (contentRows[0]?.data) document = parseJsonDocument(contentRows[0].data, document);
    } catch {
      // Older installations may still keep the current document in canvases.data.
    }
  }

  const nodes = Array.isArray(document?.nodes) ? document.nodes : [];
  const node = nodes.find((item) => String(item?.id) === String(nodeKey)) || null;
  const data = node?.data || {};
  return {
    canvasId: numberOrNull(canvas?.id || canvasId),
    projectUuid: text(canvas?.uuid || projectUuid || '', 64) || null,
    canvasTitle: text(canvas?.title || '', 180) || null,
    nodeType: text(data.kind || node?.type || taskType || '', 80) || null,
    nodeName: nodeDisplayName(node, nodeKey),
  };
}

async function recordNodeGenerationError(input = {}) {
  try {
    const metadata = errorMetadata(input.errorMessage || input.error, input.httpStatus);
    const context = await resolveCanvasAndNode(input).catch(() => ({
      canvasId: numberOrNull(input.canvasId),
      projectUuid: text(input.projectUuid || '', 64) || null,
      canvasTitle: text(input.canvasTitle || '', 180) || null,
      nodeType: text(input.nodeType || input.taskType || '', 80) || null,
      nodeName: text(input.nodeName || input.nodeKey || '未知节点', 255),
    }));
    const sourceKey = text(
      input.sourceKey || `${input.sourceType || 'http'}:${crypto.randomUUID()}`,
      191
    );

    await getErrorPool().query(
      `INSERT INTO node_generation_errors
        (source_key, source_type, task_id, user_id, username, user_role,
         canvas_id, project_uuid, canvas_title, node_key, node_type, node_name,
         operation_type, endpoint, provider, model, mode, ratio, resolution,
         duration_sec, quantity, provider_job_ids, http_status, error_code,
         error_message, request_params, reference_materials, provider_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
       ON DUPLICATE KEY UPDATE
         error_message = VALUES(error_message),
         http_status = COALESCE(VALUES(http_status), http_status),
         error_code = COALESCE(VALUES(error_code), error_code),
         provider_status = COALESCE(VALUES(provider_status), provider_status),
         updated_at = CURRENT_TIMESTAMP`,
      [
        sourceKey,
        input.sourceType === 'http' ? 'http' : 'task',
        text(input.taskId || input.jobId || '', 80) || null,
        numberOrNull(input.userId),
        text(input.username || 'unknown', 80),
        text(input.userRole || '', 32),
        context.canvasId,
        context.projectUuid,
        context.canvasTitle || text(input.canvasTitle || '', 180) || null,
        text(input.nodeKey || '', 255) || null,
        context.nodeType,
        context.nodeName,
        text(input.operationType || input.taskType || '', 80) || null,
        text(input.endpoint || '', 160) || null,
        text(input.provider || '', 80) || null,
        text(input.model || '', 160) || null,
        text(input.mode || '', 80) || null,
        text(input.ratio || '', 24) || null,
        text(input.resolution || '', 24) || null,
        Math.max(0, Number(input.durationSec || 0) || 0),
        Math.max(1, Number(input.quantity || 1) || 1),
        jsonDocument(input.providerJobIds),
        metadata.httpStatus,
        text(input.errorCode || metadata.errorCode || '', 160) || null,
        metadata.message,
        jsonDocument(input.requestParams),
        jsonDocument(input.referenceMaterials),
        jsonDocument(input.providerStatus),
        sqlTimestamp(input.createdAt),
      ]
    );
    return true;
  } catch (error) {
    console.warn('[ErrorService] record generation error failed:', error?.message || error);
    return false;
  }
}

function generationTaskFailureInput(row, errorOverride) {
  return {
      sourceKey: `task:${row.job_id}`,
      sourceType: 'task',
      taskId: row.job_id,
      userId: row.user_id,
      username: row.username,
      userRole: row.user_role,
      canvasId: row.canvas_id,
      projectUuid: row.project_uuid,
      canvasTitle: row.canvas_title,
      nodeKey: row.node_key,
      taskType: row.task_type,
      operationType: row.task_type,
      endpoint: row.endpoint,
      provider: row.provider,
      model: row.model,
      mode: row.mode,
      ratio: row.ratio,
      resolution: row.resolution,
      durationSec: row.duration_sec,
      quantity: row.quantity,
      providerJobIds: parseStoredJson(row.provider_job_ids, []),
      errorMessage: errorOverride || row.error_message,
      requestParams: parseStoredJson(row.request_params, null),
      referenceMaterials: parseStoredJson(row.reference_materials, []),
      providerStatus: parseStoredJson(row.provider_status, null),
      createdAt: row.completed_at || row.updated_at || row.created_at,
  };
}

async function recordGenerationTaskFailure(jobId, errorOverride) {
  if (!jobId) return false;
  try {
    const [rows] = await getUsagePool().query(
      `SELECT *
       FROM generation_tasks
       WHERE job_id = ?
       LIMIT 1`,
      [jobId]
    );
    const row = rows[0];
    if (!row) return false;
    return recordNodeGenerationError(generationTaskFailureInput(row, errorOverride));
  } catch (error) {
    console.warn('[ErrorService] load failed task failed:', error?.message || error);
    return false;
  }
}

async function backfillGenerationTaskFailures() {
  try {
    const [failedRows] = await getUsagePool().query(
      `SELECT *
       FROM generation_tasks
       WHERE status = 'failed'
       ORDER BY COALESCE(completed_at, updated_at, created_at) ASC`
    );
    if (!failedRows.length) return { scanned: 0, inserted: 0 };

    const [existingRows] = await getErrorPool().query(
      `SELECT task_id
       FROM node_generation_errors
       WHERE source_type = 'task' AND task_id IS NOT NULL`
    );
    const existing = new Set(existingRows.map((row) => String(row.task_id || '')).filter(Boolean));
    const missing = failedRows.filter((row) => !existing.has(String(row.job_id || '')));
    let inserted = 0;
    for (let offset = 0; offset < missing.length; offset += 8) {
      const results = await Promise.all(
        missing.slice(offset, offset + 8).map((row) =>
          recordNodeGenerationError(generationTaskFailureInput(row))
        )
      );
      inserted += results.filter(Boolean).length;
    }
    return { scanned: failedRows.length, inserted };
  } catch (error) {
    console.warn('[ErrorService] backfill failed tasks failed:', error?.message || error);
    return { scanned: 0, inserted: 0, error: error?.message || String(error) };
  }
}

async function recordHttpGenerationFailure(req, payload, httpStatus) {
  const body = req.body || {};
  const params = body.params || {};
  const errorMessage = typeof payload === 'string'
    ? payload
    : payload?.error || payload?.message || `HTTP ${httpStatus || 500}`;
  return recordNodeGenerationError({
    sourceKey: body.clientRequestId
      ? `client:${req.user?.id || 'unknown'}:${text(body.clientRequestId, 120)}`
      : undefined,
    sourceType: 'http',
    userId: req.user?.id,
    username: req.user?.username,
    userRole: req.user?.role,
    projectUuid: body.projectUuid,
    nodeKey: body.nodeKey,
    taskType: req.path.includes('/video') ? 'video' : req.path.includes('/image') || req.path.includes('/light-stage') ? 'image' : 'text',
    operationType: req.path.split('/').filter(Boolean).join(':'),
    endpoint: req.originalUrl?.split('?')[0] || req.path,
    provider: params.provider,
    model: params.model,
    mode: params.mode || params.modeType,
    ratio: params.ratio,
    resolution: params.resolution || params.quality,
    durationSec: params.duration,
    quantity: params.count,
    httpStatus,
    errorMessage,
    requestParams: params,
    referenceMaterials: params.imageList || params.videoList || null,
  });
}

function buildFilters(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.date) {
    clauses.push('DATE(created_at) = ?');
    params.push(text(filters.date, 10));
  } else if (filters.period === 'today') {
    clauses.push('created_at >= CURRENT_DATE()');
  } else if (filters.period === 'week') {
    clauses.push('created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL WEEKDAY(CURRENT_DATE()) DAY)');
  } else if (filters.period === 'month') {
    clauses.push("created_at >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')");
  }
  if (filters.username) {
    clauses.push('username = ?');
    params.push(text(filters.username, 80));
  }
  if (filters.operationType) {
    clauses.push('operation_type = ?');
    params.push(text(filters.operationType, 80));
  }
  if (filters.model) {
    clauses.push('model = ?');
    params.push(text(filters.model, 160));
  }
  if (filters.keyword) {
    const like = `%${text(filters.keyword, 120)}%`;
    clauses.push('(error_message LIKE ? OR node_name LIKE ? OR canvas_title LIKE ? OR task_id LIKE ?)');
    params.push(like, like, like, like);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function errorRecord(row) {
  return {
    id: Number(row.id),
    sourceType: row.source_type,
    taskId: row.task_id || '',
    userId: row.user_id == null ? null : Number(row.user_id),
    username: row.username,
    canvasId: row.canvas_id == null ? null : Number(row.canvas_id),
    projectUuid: row.project_uuid || '',
    canvasTitle: row.canvas_title || '未知画布',
    nodeKey: row.node_key || '',
    nodeType: row.node_type || row.operation_type || 'unknown',
    nodeName: row.node_name || row.node_key || '未知节点',
    operationType: row.operation_type || '',
    endpoint: row.endpoint || '',
    provider: row.provider || '',
    model: row.model || '',
    mode: row.mode || '',
    ratio: row.ratio || '',
    resolution: row.resolution || '',
    durationSec: Number(row.duration_sec || 0),
    quantity: Number(row.quantity || 1),
    providerJobIds: parseStoredJson(row.provider_job_ids, []),
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    requestParams: parseStoredJson(row.request_params, null),
    referenceMaterials: parseStoredJson(row.reference_materials, []),
    providerStatus: parseStoredJson(row.provider_status, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listNodeGenerationErrors(filters = {}) {
  const page = Math.max(1, Number(filters.page || 1) || 1);
  const pageSize = Math.max(10, Math.min(100, Number(filters.pageSize || 30) || 30));
  const sortDirection = String(filters.sortOrder || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * pageSize;
  const where = buildFilters(filters);
  const db = getErrorPool();
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM node_generation_errors ${where.sql}`,
    where.params
  );
  const [rows] = await db.query(
    `SELECT *
     FROM node_generation_errors
     ${where.sql}
     ORDER BY created_at ${sortDirection}, id ${sortDirection}
     LIMIT ${pageSize} OFFSET ${offset}`,
    where.params
  );
  const [summaryRows] = await db.query(
    `SELECT
       COUNT(*) AS total,
       SUM(
         node_type = 'image'
         OR operation_type = 'image'
         OR operation_type LIKE '%image%'
         OR operation_type LIKE '%light-stage%'
       ) AS images,
       SUM(
         node_type = 'video'
         OR operation_type = 'video'
         OR operation_type LIKE '%video%'
       ) AS videos,
       SUM(
         node_type = 'text'
         OR operation_type = 'text'
         OR operation_type LIKE '%text%'
         OR operation_type LIKE '%llm%'
         OR operation_type LIKE '%script%'
         OR operation_type LIKE '%translate%'
       ) AS texts
     FROM node_generation_errors`
  );
  const [optionRows] = await db.query(
    `SELECT DISTINCT username, operation_type, model
     FROM node_generation_errors
     ORDER BY username, operation_type, model`
  );
  return {
    records: rows.map(errorRecord),
    total: Number(countRows[0]?.total || 0),
    page,
    pageSize,
    summary: {
      total: Number(summaryRows[0]?.total || 0),
      images: Number(summaryRows[0]?.images || 0),
      videos: Number(summaryRows[0]?.videos || 0),
      texts: Number(summaryRows[0]?.texts || 0),
    },
    options: {
      usernames: [...new Set(optionRows.map((row) => row.username).filter(Boolean))],
      operationTypes: [...new Set(optionRows.map((row) => row.operation_type).filter(Boolean))],
      models: [...new Set(optionRows.map((row) => row.model).filter(Boolean))],
    },
  };
}

module.exports = {
  backfillGenerationTaskFailures,
  listNodeGenerationErrors,
  recordGenerationTaskFailure,
  recordHttpGenerationFailure,
  recordNodeGenerationError,
};
