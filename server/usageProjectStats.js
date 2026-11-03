const { getPool, getUsagePool } = require('./db');

const CANVAS_ID_EXPR = "COALESCE(NULLIF(canvas_id, 0), CAST(NULLIF(project_uuid, '') AS UNSIGNED))";
const VIDEO_DURATION_SQL = "quantity * COALESCE(" +
  "CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.duration')), '') AS DECIMAL(10, 2))," +
  "CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.durationSec')), '') AS DECIMAL(10, 2))," +
  "CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.seconds')), '') AS DECIMAL(10, 2))," +
  "0)";

async function loadCanvasProjectMap(canvasIds) {
  const ids = [...new Set((canvasIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return new Map();
  try {
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await getPool().query(
      'SELECT c.id, c.title, c.project_id, cp.name AS project_name, cp.status AS project_status ' +
      'FROM canvases c LEFT JOIN canvas_projects cp ON cp.id = c.project_id ' +
      'WHERE c.id IN (' + placeholders + ')',
      ids
    );
    const map = new Map();
    for (const row of rows) {
      map.set(Number(row.id), {
        canvasId: Number(row.id),
        canvasTitle: row.title || '',
        projectId: row.project_id == null ? null : Number(row.project_id),
        projectName: String(row.project_name || '').trim(),
        projectStatus: row.project_status || '',
      });
    }
    return map;
  } catch (error) {
    console.warn('load canvas project map failed:', error.message);
    return new Map();
  }
}

async function loadAllProjects() {
  try {
    const [rows] = await getPool().query(
      'SELECT cp.id, cp.name, cp.status, COUNT(c.id) AS canvas_total ' +
      'FROM canvas_projects cp LEFT JOIN canvases c ON c.project_id = cp.id ' +
      'GROUP BY cp.id, cp.name, cp.status ORDER BY cp.name ASC'
    );
    return rows.map(function (row) {
      return {
        projectId: Number(row.id),
        projectName: String(row.name || '').trim() || ('项目 ' + row.id),
        projectStatus: row.status || '',
        canvasTotal: Number(row.canvas_total || 0)
      };
    }).filter(function (row) { return row.projectId > 0; });
  } catch (error) {
    console.warn('load all projects failed:', error.message);
    return [];
  }
}

function projectGroupKey(meta) {
  if (meta && meta.projectId) return 'id:' + meta.projectId;
  if (meta && meta.projectName) return 'name:' + meta.projectName;
  return 'unassigned';
}

function ensureProjectGroup(groups, meta) {
  const key = projectGroupKey(meta);
  if (!groups.has(key)) {
    const assigned = Boolean(meta && (meta.projectId || meta.projectName));
    groups.set(key, {
      key: key,
      projectId: (meta && meta.projectId) || null,
      projectName: assigned ? meta.projectName : '\u672a\u5f52\u5c5e\u9879\u76ee',
      projectStatus: assigned ? (meta.projectStatus || '') : '',
      unassigned: !assigned,
      records: 0, quantity: 0, results: 0, succeeded: 0, failed: 0,
      imageQuantity: 0, videoQuantity: 0, videoSeconds: 0, textQuantity: 0,
      canvases: new Map(), users: new Map(), models: new Map()
    });
  }
  return groups.get(key);
}

function addCanvasToGroup(group, row) {
  const canvasId = Number(row.canvas_id);
  const id = Number.isFinite(canvasId) && canvasId > 0 ? canvasId : 0;
  const key = id ? String(id) : ('none:' + (row.canvas_title || ''));
  if (!group.canvases.has(key)) {
    group.canvases.set(key, {
      canvasId: id || null,
      canvasTitle: row.canvas_title || (id ? ('\u753b\u5e03 ' + id) : '\u672a\u8bb0\u5f55\u753b\u5e03'),
      records: 0, quantity: 0, imageQuantity: 0, videoQuantity: 0, videoSeconds: 0, textQuantity: 0
    });
  }
  const canvas = group.canvases.get(key);
  canvas.records += Number(row.records || 0);
  canvas.quantity += Number(row.quantity || 0);
  canvas.imageQuantity += Number(row.image_quantity || 0);
  canvas.videoQuantity += Number(row.video_quantity || 0);
  canvas.videoSeconds += Number(row.video_seconds || 0);
  canvas.textQuantity += Number(row.text_quantity || 0);
}

function sortProjectRows(list, sort) {
  const copy = list.slice();
  copy.sort(function (a, b) {
    if (sort === 'image_quantity_desc') return (b.imageQuantity - a.imageQuantity) || (b.quantity - a.quantity);
    if (sort === 'quantity_desc') return (b.quantity - a.quantity) || (b.videoSeconds - a.videoSeconds);
    if (sort === 'records_desc') return (b.records - a.records) || (b.quantity - a.quantity);
    if (sort === 'name_asc') return String(a.projectName || '').localeCompare(String(b.projectName || ''), 'zh-CN');
    return (b.videoSeconds - a.videoSeconds) || (b.imageQuantity - a.imageQuantity) || (b.quantity - a.quantity);
  });
  return copy;
}

function finalizeProjectGroup(group) {
  const users = Array.from(group.users.values()).sort(function (a, b) { return (b.quantity - a.quantity) || String(a.username).localeCompare(String(b.username), 'zh-CN'); });
  const models = Array.from(group.models.values()).sort(function (a, b) { return (b.quantity - a.quantity) || String(a.model).localeCompare(String(b.model)); });
  const canvases = Array.from(group.canvases.values()).sort(function (a, b) { return (b.quantity - a.quantity) || String(a.canvasTitle).localeCompare(String(b.canvasTitle), 'zh-CN'); });
  const successRate = group.records > 0 ? Math.round((group.succeeded / group.records) * 1000) / 10 : 0;
  return {
    key: group.key, projectId: group.projectId, projectName: group.projectName, projectStatus: group.projectStatus, unassigned: group.unassigned,
    records: group.records, quantity: group.quantity, results: group.results, succeeded: group.succeeded, failed: group.failed, successRate: successRate,
    imageQuantity: group.imageQuantity, videoQuantity: group.videoQuantity, videoSeconds: group.videoSeconds, textQuantity: group.textQuantity,
    canvasCount: canvases.length, catalogCanvasCount: Number(group.catalogCanvasCount || 0), userCount: users.length, canvases: canvases, users: users, models: models
  };
}

async function listPaidUsageByProject(whereSql, params, sort) {
  const db = getUsagePool();
  const canvasSql = 'SELECT ' + CANVAS_ID_EXPR + ' AS canvas_id, MAX(canvas_title) AS canvas_title, COUNT(*) AS records, ' +
    'COALESCE(SUM(quantity), 0) AS quantity, COALESCE(SUM(result_count), 0) AS results, ' +
    'COALESCE(SUM(CASE WHEN status = \'succeeded\' THEN 1 ELSE 0 END), 0) AS succeeded, ' +
    'COALESCE(SUM(CASE WHEN status = \'failed\' THEN 1 ELSE 0 END), 0) AS failed, ' +
    'COALESCE(SUM(CASE WHEN operation_type = \'image\' THEN quantity ELSE 0 END), 0) AS image_quantity, ' +
    'COALESCE(SUM(CASE WHEN operation_type = \'video\' THEN quantity ELSE 0 END), 0) AS video_quantity, ' +
    'COALESCE(SUM(CASE WHEN operation_type = \'video\' THEN ' + VIDEO_DURATION_SQL + ' ELSE 0 END), 0) AS video_seconds, ' +
    'COALESCE(SUM(CASE WHEN operation_type = \'text\' THEN quantity ELSE 0 END), 0) AS text_quantity ' +
    'FROM paid_usage_logs WHERE ' + whereSql + ' GROUP BY ' + CANVAS_ID_EXPR;
  const [canvasRows] = await db.query(canvasSql, params);
  const canvasMap = await loadCanvasProjectMap(canvasRows.map(function (row) { return row.canvas_id; }));
  const groups = new Map();
  for (const row of canvasRows) {
    const canvasId = Number(row.canvas_id);
    const meta = Number.isFinite(canvasId) && canvasId > 0 ? canvasMap.get(canvasId) : null;
    const group = ensureProjectGroup(groups, meta);
    group.records += Number(row.records || 0);
    group.quantity += Number(row.quantity || 0);
    group.results += Number(row.results || 0);
    group.succeeded += Number(row.succeeded || 0);
    group.failed += Number(row.failed || 0);
    group.imageQuantity += Number(row.image_quantity || 0);
    group.videoQuantity += Number(row.video_quantity || 0);
    group.videoSeconds += Number(row.video_seconds || 0);
    group.textQuantity += Number(row.text_quantity || 0);
    addCanvasToGroup(group, row);
  }
  const userSql = 'SELECT ' + CANVAS_ID_EXPR + ' AS canvas_id, user_id, username, COUNT(*) AS records, ' +
    'COALESCE(SUM(quantity), 0) AS quantity, ' +
    'COALESCE(SUM(CASE WHEN operation_type = \'image\' THEN quantity ELSE 0 END), 0) AS image_quantity, ' +
    'COALESCE(SUM(CASE WHEN operation_type = \'video\' THEN quantity ELSE 0 END), 0) AS video_quantity, ' +
    'COALESCE(SUM(CASE WHEN operation_type = \'video\' THEN ' + VIDEO_DURATION_SQL + ' ELSE 0 END), 0) AS video_seconds, ' +
    'COALESCE(SUM(CASE WHEN operation_type = \'text\' THEN quantity ELSE 0 END), 0) AS text_quantity ' +
    'FROM paid_usage_logs WHERE ' + whereSql + ' GROUP BY ' + CANVAS_ID_EXPR + ', user_id, username';
  const [userRows] = await db.query(userSql, params);
  for (const row of userRows) {
    const canvasId = Number(row.canvas_id);
    const meta = Number.isFinite(canvasId) && canvasId > 0 ? canvasMap.get(canvasId) : null;
    const group = ensureProjectGroup(groups, meta);
    const userKey = row.user_id == null ? ('name:' + (row.username || '')) : String(row.user_id);
    if (!group.users.has(userKey)) {
      group.users.set(userKey, { userId: row.user_id == null ? null : Number(row.user_id), username: row.username || '\u672a\u77e5\u7528\u6237', records: 0, quantity: 0, imageQuantity: 0, videoQuantity: 0, videoSeconds: 0, textQuantity: 0 });
    }
    const user = group.users.get(userKey);
    user.records += Number(row.records || 0);
    user.quantity += Number(row.quantity || 0);
    user.imageQuantity += Number(row.image_quantity || 0);
    user.videoQuantity += Number(row.video_quantity || 0);
    user.videoSeconds += Number(row.video_seconds || 0);
    user.textQuantity += Number(row.text_quantity || 0);
  }
  const modelSql = 'SELECT ' + CANVAS_ID_EXPR + ' AS canvas_id, model, operation_type, COUNT(*) AS records, ' +
    'COALESCE(SUM(quantity), 0) AS quantity, ' +
    'COALESCE(SUM(CASE WHEN operation_type = \'video\' THEN ' + VIDEO_DURATION_SQL + ' ELSE 0 END), 0) AS video_seconds ' +
    'FROM paid_usage_logs WHERE ' + whereSql + ' GROUP BY ' + CANVAS_ID_EXPR + ', model, operation_type';
  const [modelRows] = await db.query(modelSql, params);
  for (const row of modelRows) {
    const canvasId = Number(row.canvas_id);
    const meta = Number.isFinite(canvasId) && canvasId > 0 ? canvasMap.get(canvasId) : null;
    const group = ensureProjectGroup(groups, meta);
    const modelKey = (row.model || 'unknown') + '|' + (row.operation_type || '');
    if (!group.models.has(modelKey)) {
      group.models.set(modelKey, { model: row.model || 'unknown', operationType: row.operation_type, records: 0, quantity: 0, videoSeconds: 0 });
    }
    const model = group.models.get(modelKey);
    model.records += Number(row.records || 0);
    model.quantity += Number(row.quantity || 0);
    model.videoSeconds += Number(row.video_seconds || 0);
  }
  const catalog = await loadAllProjects();
  for (const project of catalog) {
    const group = ensureProjectGroup(groups, project);
    group.projectName = project.projectName || group.projectName;
    group.projectStatus = project.projectStatus || group.projectStatus;
    group.catalogCanvasCount = project.canvasTotal;
    group.unassigned = false;
  }
  return sortProjectRows(Array.from(groups.values()).map(finalizeProjectGroup), sort);
}

module.exports = { listPaidUsageByProject };
