const crypto = require('crypto');
const { getUsagePool } = require('../db');
const { recordGenerationTaskFailure } = require('./ErrorService');
const { applyGenerationResult } = require('./GenerationResultApplyService');
const { isResumableGenerationTask } = require('./GenerationTaskRecovery');
const { taskUserIdFromRow } = require('./GenerationTaskApiKeyContext');

const tasks = {};
const pendingPersistence = new Set();
const VALID_TASK_TYPES = new Set(['image', 'video', 'text']);
const VALID_STATUSES = new Set(['submitted', 'running', 'succeeded', 'failed', 'cancelled']);
const VALID_APPLY_STATUSES = new Set(['legacy', 'pending', 'applied', 'superseded', 'orphaned']);

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function jsonString(value) {
  return value == null ? null : JSON.stringify(value);
}

function safeJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function text(value, max = 4000) {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, max);
  if (value instanceof Error) return String(value.message || value).slice(0, max);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value).slice(0, max);
    } catch {
      return String(value).slice(0, max);
    }
  }
  return String(value).slice(0, max);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function quantity(value) {
  return Math.max(1, Math.min(999, Number(value || 1) || 1));
}

function generationVersion(value) {
  const version = Number(value);
  return Number.isFinite(version) && version > 0 ? Math.floor(version) : 0;
}

function applyStatus(value, fallback = 'legacy') {
  return VALID_APPLY_STATUSES.has(value) ? value : fallback;
}

function statusFromApiStatus(value, currentStatus = 'submitted') {
  if (VALID_STATUSES.has(value)) return value;
  const status = Number(value);
  if (status === 2) return 'succeeded';
  if (status === 3) return 'failed';
  if (status === 1) return currentStatus === 'submitted' ? 'running' : currentStatus || 'running';
  return currentStatus || 'running';
}

function apiStatusFromStatus(status) {
  if (status === 'succeeded') return 2;
  if (status === 'failed' || status === 'cancelled') return 3;
  return 1;
}

function normalizeTaskInput(input = {}) {
  const jobId = text(input.jobId || input.internalJobId || randomId(), 80);
  const taskType = VALID_TASK_TYPES.has(input.taskType) ? input.taskType : 'text';
  const requestParams = input.requestParams || input.submissionParams || null;
  const providerJobIds = Array.isArray(input.providerJobIds)
    ? input.providerJobIds
    : input.providerJobId
      ? [input.providerJobId]
      : [];
  return {
    jobId,
    userId: numberOrNull(input.userId),
    username: text(input.username || 'unknown', 80),
    userRole: text(input.userRole || '', 32),
    canvasId: numberOrNull(input.canvasId),
    projectUuid: input.projectUuid ? text(input.projectUuid, 64) : null,
    canvasTitle: input.canvasTitle ? text(input.canvasTitle, 180) : null,
    nodeKey: input.nodeKey ? text(input.nodeKey, 255) : null,
    taskType,
    endpoint: text(input.endpoint || '', 120),
    provider: input.provider ? text(input.provider, 64) : null,
    model: text(input.model || 'unknown', 160),
    mode: input.mode ? text(input.mode, 80) : null,
    ratio: input.ratio ? text(input.ratio, 24) : null,
    resolution: input.resolution ? text(input.resolution, 24) : null,
    durationSec: Math.max(0, Number(input.durationSec || input.duration || 0) || 0),
    quantity: quantity(input.quantity || input.count),
    referenceMaterials: Array.isArray(input.referenceMaterials) ? input.referenceMaterials : [],
    requestParams,
    providerJobIds,
    providerStatus: input.providerStatus || null,
    status: statusFromApiStatus(input.status, 'submitted'),
    progressPercent: Math.max(0, Math.min(100, Number(input.progressPercent || 0) || 0)),
    errorMessage: input.errorMessage || input.error ? text(input.errorMessage || input.error, 4000) : null,
    resultUrls: Array.isArray(input.resultUrls) ? input.resultUrls : Array.isArray(input.urls) ? input.urls : [],
    usageLogId: numberOrNull(input.usageLogId),
    videoTaskDetailId: numberOrNull(input.videoTaskDetailId),
    requestHash: input.requestHash ? text(input.requestHash, 64) : null,
    generationVersion: generationVersion(input.generationVersion),
    applyStatus: applyStatus(input.applyStatus, 'legacy'),
    supersededByJobId: input.supersededByJobId ? text(input.supersededByJobId, 80) : null,
    // 并发生成：同一节点允许多个任务同时在跑，谁完成谁追加。只有显式传 true 才生效，
    // 所以图片 / 文字节点的「后者取代前者」语义一点没变。
    concurrent: input.concurrent === true || input.concurrent === 1 ? 1 : 0,
  };
}

function outputFromRow(row) {
  return {
    index: Number(row.output_index || 0),
    url: row.asset_url,
    assetId: row.asset_id == null ? null : Number(row.asset_id),
    mimeType: row.mime_type || undefined,
    width: row.width == null ? undefined : Number(row.width),
    height: row.height == null ? undefined : Number(row.height),
    durationSec: row.duration_sec == null ? undefined : Number(row.duration_sec),
    model: row.model || undefined,
    resolution: row.resolution || undefined,
    isPrimary: Boolean(row.is_primary),
    metadata: safeJson(row.metadata, null),
    createdAt: row.created_at,
  };
}

function apiTaskFromRow(row, outputRows = []) {
  if (!row) return null;
  const rowApplyStatus = applyStatus(row.apply_status, generationVersion(row.generation_version) > 0 ? 'pending' : 'legacy');
  const outputs = outputRows.map(outputFromRow);
  return {
    status: apiStatusFromStatus(row.status),
    progressPercent: Number(row.progress_percent || 0),
    urls: safeJson(row.result_urls, []),
    error: row.error_message || undefined,
    providerJobIds: safeJson(row.provider_job_ids, []),
    providerStatus: safeJson(row.provider_status, null),
    meta: {
      taskType: row.task_type,
      provider: row.provider,
      model: row.model,
      mode: row.mode,
      ratio: row.ratio,
      resolution: row.resolution,
      durationSec: Number(row.duration_sec || 0),
      quantity: Number(row.quantity || 1),
      usageLogId: row.usage_log_id == null ? null : Number(row.usage_log_id),
      videoTaskDetailId: row.video_task_detail_id == null ? null : Number(row.video_task_detail_id),
      generationVersion: generationVersion(row.generation_version),
      applyStatus: rowApplyStatus,
      supersededByJobId: row.superseded_by_job_id || undefined,
      shouldApply: rowApplyStatus === 'legacy' || rowApplyStatus === 'pending' || rowApplyStatus === 'applied',
      outputs,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

function memoryPatchFromEntry(entry) {
  return {
    status: apiStatusFromStatus(entry.status),
    progressPercent: entry.progressPercent,
    urls: entry.resultUrls,
    error: entry.errorMessage || undefined,
    meta: {
      generationVersion: entry.generationVersion,
      applyStatus: entry.applyStatus,
      shouldApply: entry.applyStatus === 'legacy' || entry.applyStatus === 'pending' || entry.applyStatus === 'applied',
    },
  };
}

function remember(jobId, patch = {}) {
  tasks[jobId] = {
    ...(tasks[jobId] || {}),
    ...patch,
  };
  return tasks[jobId];
}

function logPersistenceError(action, error) {
  console.warn(`[JobService] ${action} failed:`, error?.message || error);
}

function trackPersistence(promise) {
  const tracked = Promise.resolve(promise);
  pendingPersistence.add(tracked);
  tracked.then(
    () => pendingPersistence.delete(tracked),
    () => pendingPersistence.delete(tracked)
  );
  return tracked;
}

async function waitForPendingPersistence(timeoutMs = 30_000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
  while (pendingPersistence.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return {
        drained: false,
        pendingCount: pendingPersistence.size,
      };
    }
    const batch = Array.from(pendingPersistence);
    await Promise.race([
      Promise.allSettled(batch),
      new Promise((resolve) => setTimeout(resolve, Math.min(remainingMs, 250))),
    ]);
  }
  return {
    drained: true,
    pendingCount: 0,
  };
}

async function createPersistentTask(input = {}) {
  const entry = normalizeTaskInput(input);
  const pool = getUsagePool();
  let connection = null;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    if (entry.projectUuid && entry.nodeKey) {
      await connection.query(
        `INSERT INTO generation_node_heads
          (project_uuid, node_key, generation_version, current_job_id)
         VALUES (?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE
           generation_version = generation_version + 1,
           current_job_id = VALUES(current_job_id)`,
        [entry.projectUuid, entry.nodeKey, entry.jobId]
      );
      const [headRows] = await connection.query(
        `SELECT generation_version
         FROM generation_node_heads
         WHERE project_uuid = ? AND node_key = ?
         FOR UPDATE`,
        [entry.projectUuid, entry.nodeKey]
      );
      entry.generationVersion = generationVersion(headRows[0]?.generation_version);
      entry.applyStatus = 'pending';

      // 并发任务不把同节点的兄弟任务标成 superseded —— 那条规则是「一个节点同时只有一次
      // 有效生成」的来源，视频节点要的是"两条都跑完、都能看到"。
      // 只跳过这一条；generation_version 照旧递增（历史顺序还要靠它），
      // 也照旧只把 current_job_id 指向最新任务 —— 旧任务能不能应用改由 concurrent 决定，
      // 见 currentApplyState。
      if (!entry.concurrent) {
        await connection.query(
          `UPDATE generation_tasks
           SET apply_status = 'superseded',
               superseded_by_job_id = ?
           WHERE project_uuid = ?
             AND node_key = ?
             AND job_id <> ?
             AND apply_status = 'pending'
             AND concurrent = 0`,
          [entry.jobId, entry.projectUuid, entry.nodeKey, entry.jobId]
        );
      }
    }

    await connection.query(
      `INSERT INTO generation_tasks
        (job_id, user_id, username, user_role, canvas_id, project_uuid, canvas_title, node_key,
         task_type, endpoint, provider, model, mode, ratio, resolution, duration_sec, quantity,
         reference_materials, request_params, provider_job_ids, provider_status, status, progress_percent,
         error_message, result_urls, usage_log_id, video_task_detail_id, request_hash,
         generation_version, apply_status, superseded_by_job_id, concurrent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         username = VALUES(username),
         user_role = VALUES(user_role),
         canvas_id = VALUES(canvas_id),
         project_uuid = VALUES(project_uuid),
         canvas_title = VALUES(canvas_title),
         node_key = VALUES(node_key),
         task_type = VALUES(task_type),
         endpoint = VALUES(endpoint),
         provider = VALUES(provider),
         model = VALUES(model),
         mode = VALUES(mode),
         ratio = VALUES(ratio),
         resolution = VALUES(resolution),
         duration_sec = VALUES(duration_sec),
         quantity = VALUES(quantity),
         reference_materials = VALUES(reference_materials),
         request_params = VALUES(request_params),
         provider_job_ids = VALUES(provider_job_ids),
         provider_status = VALUES(provider_status),
         status = VALUES(status),
         progress_percent = VALUES(progress_percent),
         error_message = VALUES(error_message),
         result_urls = VALUES(result_urls),
         usage_log_id = VALUES(usage_log_id),
         video_task_detail_id = VALUES(video_task_detail_id),
         request_hash = VALUES(request_hash),
         generation_version = VALUES(generation_version),
         apply_status = VALUES(apply_status),
         superseded_by_job_id = VALUES(superseded_by_job_id),
         concurrent = VALUES(concurrent)`,
      [
        entry.jobId,
        entry.userId,
        entry.username,
        entry.userRole,
        entry.canvasId,
        entry.projectUuid,
        entry.canvasTitle,
        entry.nodeKey,
        entry.taskType,
        entry.endpoint,
        entry.provider,
        entry.model,
        entry.mode,
        entry.ratio,
        entry.resolution,
        entry.durationSec,
        entry.quantity,
        jsonString(entry.referenceMaterials),
        jsonString(entry.requestParams),
        jsonString(entry.providerJobIds),
        jsonString(entry.providerStatus),
        entry.status,
        entry.progressPercent,
        entry.errorMessage,
        jsonString(entry.resultUrls),
        entry.usageLogId,
        entry.videoTaskDetailId,
        entry.requestHash,
        entry.generationVersion,
        entry.applyStatus,
        entry.supersededByJobId,
        entry.concurrent,
      ]
    );
    await connection.commit();
  } catch (error) {
    if (connection) await connection.rollback().catch(() => null);
    logPersistenceError('create task', error);
    entry.generationVersion = 0;
    entry.applyStatus = 'legacy';
  } finally {
    if (connection) connection.release();
  }
  remember(entry.jobId, memoryPatchFromEntry(entry));
  return {
    jobId: entry.jobId,
    generationVersion: entry.generationVersion,
    applyStatus: entry.applyStatus,
  };
}

function setTask(jobId, patch = {}) {
  if (!jobId) return null;
  const previous = tasks[jobId] || {};
  const apiPatch = { ...patch };
  if (patch.status !== undefined) {
    apiPatch.status = apiStatusFromStatus(statusFromApiStatus(patch.status, statusFromApiStatus(previous.status, 'submitted')));
  }
  if (patch.resultUrls !== undefined && patch.urls === undefined) {
    apiPatch.urls = patch.resultUrls;
  }
  if (patch.errorMessage !== undefined && patch.error === undefined) {
    apiPatch.error = patch.errorMessage;
  }
  const next = remember(jobId, apiPatch);
  void trackPersistence(updatePersistentTask(jobId, patch, previous));
  return next;
}

async function setTaskAndWait(jobId, patch = {}) {
  if (!jobId) return null;
  const previous = tasks[jobId] || {};
  const apiPatch = { ...patch };
  if (patch.status !== undefined) {
    apiPatch.status = apiStatusFromStatus(statusFromApiStatus(patch.status, statusFromApiStatus(previous.status, 'submitted')));
  }
  if (patch.resultUrls !== undefined && patch.urls === undefined) {
    apiPatch.urls = patch.resultUrls;
  }
  if (patch.errorMessage !== undefined && patch.error === undefined) {
    apiPatch.error = patch.errorMessage;
  }
  const next = remember(jobId, apiPatch);
  await trackPersistence(updatePersistentTask(jobId, patch, previous));
  return next;
}

function normalizeOutput(output, index, defaults = {}) {
  const item = typeof output === 'string' ? { url: output } : output || {};
  return {
    index: Number.isFinite(Number(item.index)) ? Math.max(0, Math.floor(Number(item.index))) : index,
    url: text(item.url || item.assetUrl || '', 16000),
    assetId: numberOrNull(item.assetId),
    mimeType: item.mimeType ? text(item.mimeType, 120) : null,
    width: numberOrNull(item.width),
    height: numberOrNull(item.height),
    durationSec: numberOrNull(item.durationSec),
    model: item.model ? text(item.model, 160) : defaults.model || null,
    resolution: item.resolution ? text(item.resolution, 24) : defaults.resolution || null,
    isPrimary: item.isPrimary === undefined ? index === 0 : Boolean(item.isPrimary),
    metadata: item.metadata || null,
  };
}

async function upsertTaskOutputs(jobId, rawOutputs = []) {
  const outputs = (Array.isArray(rawOutputs) ? rawOutputs : [])
    .map((output, index) => normalizeOutput(output, index))
    .filter((output) => output.url);
  if (!jobId || outputs.length === 0) return [];

  try {
    const [taskRows] = await getUsagePool().query(
      'SELECT model, resolution FROM generation_tasks WHERE job_id = ? LIMIT 1',
      [jobId]
    );
    const defaults = {
      model: taskRows[0]?.model || null,
      resolution: taskRows[0]?.resolution || null,
    };
    const normalized = outputs.map((output, index) => normalizeOutput(output, index, defaults));
    for (const output of normalized) {
      await getUsagePool().query(
        `INSERT INTO generation_task_outputs
          (job_id, output_index, asset_url, asset_id, mime_type, width, height, duration_sec,
           model, resolution, is_primary, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           asset_url = VALUES(asset_url),
           asset_id = COALESCE(VALUES(asset_id), asset_id),
           mime_type = COALESCE(VALUES(mime_type), mime_type),
           width = COALESCE(VALUES(width), width),
           height = COALESCE(VALUES(height), height),
           duration_sec = COALESCE(VALUES(duration_sec), duration_sec),
           model = COALESCE(VALUES(model), model),
           resolution = COALESCE(VALUES(resolution), resolution),
           is_primary = VALUES(is_primary),
           metadata = COALESCE(VALUES(metadata), metadata)`,
        [
          jobId,
          output.index,
          output.url,
          output.assetId,
          output.mimeType,
          output.width,
          output.height,
          output.durationSec,
          output.model,
          output.resolution,
          output.isPrimary ? 1 : 0,
          jsonString(output.metadata),
        ]
      );
    }
    return normalized;
  } catch (error) {
    logPersistenceError('upsert task outputs', error);
    return [];
  }
}

async function currentApplyState(jobId) {
  const [rows] = await getUsagePool().query(
    `SELECT t.generation_version, t.apply_status, t.project_uuid, t.node_key, t.concurrent,
            h.current_job_id
     FROM generation_tasks t
     LEFT JOIN generation_node_heads h
       ON h.project_uuid = t.project_uuid AND h.node_key = t.node_key
     WHERE t.job_id = ?
     LIMIT 1`,
    [jobId]
  );
  const row = rows[0];
  if (!row) return null;
  const version = generationVersion(row.generation_version);
  if (!version || !row.project_uuid || !row.node_key) {
    return { generationVersion: version, applyStatus: 'legacy', shouldApply: true };
  }
  // 并发任务不看 current_job_id。那个字段永远指向该节点最新的任务，用它判定就等于
  // 「后来的取代先来的」—— 而并发任务的语义是各自追加，只有被显式作废（orphaned）才不应用。
  if (Number(row.concurrent) === 1) {
    const status = applyStatus(row.apply_status, 'pending');
    return {
      generationVersion: version,
      applyStatus: status === 'superseded' ? 'pending' : status,
      shouldApply: status !== 'orphaned',
    };
  }
  if (row.current_job_id === jobId) {
    const status = applyStatus(row.apply_status, 'pending');
    return {
      generationVersion: version,
      applyStatus: status === 'superseded' ? 'pending' : status,
      shouldApply: status !== 'orphaned',
    };
  }
  return {
    generationVersion: version,
    applyStatus: 'superseded',
    shouldApply: false,
    supersededByJobId: row.current_job_id || undefined,
  };
}

async function refreshTaskApplyStatus(jobId) {
  try {
    const state = await currentApplyState(jobId);
    if (!state || state.applyStatus === 'legacy') return state;
    if (state.applyStatus === 'superseded') {
      await getUsagePool().query(
        `UPDATE generation_tasks
         SET apply_status = 'superseded', superseded_by_job_id = ?
         WHERE job_id = ? AND apply_status = 'pending'`,
        [state.supersededByJobId || null, jobId]
      );
    }
    return state;
  } catch (error) {
    logPersistenceError('refresh apply status', error);
    return null;
  }
}

async function markTaskApplied(jobId, outputs = []) {
  await upsertTaskOutputs(jobId, outputs);
  try {
    const state = await currentApplyState(jobId);
    if (!state) return null;
    if (!state.shouldApply) {
      await refreshTaskApplyStatus(jobId);
      return state;
    }
    if (state.applyStatus !== 'legacy') {
      await getUsagePool().query(
        `UPDATE generation_tasks
         SET apply_status = 'applied', applied_at = COALESCE(applied_at, CURRENT_TIMESTAMP)
         WHERE job_id = ? AND apply_status NOT IN ('superseded', 'orphaned')`,
        [jobId]
      );
    }
    return { ...state, applyStatus: state.applyStatus === 'legacy' ? 'legacy' : 'applied', shouldApply: true };
  } catch (error) {
    logPersistenceError('mark task applied', error);
    return null;
  }
}

async function markTaskOrphaned(jobId) {
  try {
    await getUsagePool().query(
      `UPDATE generation_tasks
       SET apply_status = 'orphaned'
       WHERE job_id = ? AND apply_status <> 'legacy'`,
      [jobId]
    );
    return true;
  } catch (error) {
    logPersistenceError('mark task orphaned', error);
    return false;
  }
}

async function cancelPersistentTask(jobId) {
  if (!jobId) return false;
  try {
    const connection = await getUsagePool().getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        'SELECT project_uuid, node_key FROM generation_tasks WHERE job_id = ? FOR UPDATE',
        [jobId]
      );
      if (!rows[0]) {
        await connection.rollback();
        return false;
      }
      await connection.query(
        `UPDATE generation_tasks
         SET status = 'cancelled', progress_percent = 0,
             apply_status = IF(apply_status = 'legacy', 'legacy', 'superseded'),
             completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
         WHERE job_id = ?`,
        [jobId]
      );
      if (rows[0].project_uuid && rows[0].node_key) {
        await connection.query(
          `UPDATE generation_node_heads
           SET current_job_id = NULL
           WHERE project_uuid = ? AND node_key = ? AND current_job_id = ?`,
          [rows[0].project_uuid, rows[0].node_key, jobId]
        );
      }
      await connection.commit();
      remember(jobId, { status: 3, progressPercent: 0, error: '任务已取消' });
      return true;
    } catch (error) {
      await connection.rollback().catch(() => null);
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    logPersistenceError('cancel task', error);
    return false;
  }
}

async function updatePersistentTask(jobId, patch = {}, previous = {}) {
  const updates = [];
  const params = [];
  const currentStatus = statusFromApiStatus(previous.status, 'submitted');
  const dbStatus = patch.status !== undefined ? statusFromApiStatus(patch.status, currentStatus) : null;

  if (dbStatus) {
    updates.push("status = IF(status = 'cancelled', status, ?)");
    params.push(dbStatus);
    if (dbStatus === 'running') {
      updates.push('started_polling_at = COALESCE(started_polling_at, CURRENT_TIMESTAMP)');
    }
    if (dbStatus === 'succeeded' || dbStatus === 'failed' || dbStatus === 'cancelled') {
      updates.push('completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)');
    }
  }
  if (patch.progressPercent !== undefined) {
    updates.push('progress_percent = ?');
    params.push(Math.max(0, Math.min(100, Number(patch.progressPercent || 0) || 0)));
  }
  if (patch.urls !== undefined || patch.resultUrls !== undefined) {
    updates.push('result_urls = ?');
    params.push(jsonString(Array.isArray(patch.resultUrls) ? patch.resultUrls : Array.isArray(patch.urls) ? patch.urls : []));
  }
  if (patch.error !== undefined || patch.errorMessage !== undefined) {
    updates.push('error_message = ?');
    params.push(patch.error || patch.errorMessage ? text(patch.error || patch.errorMessage, 4000) : null);
  }
  if (patch.providerJobIds !== undefined) {
    updates.push('provider_job_ids = ?');
    params.push(jsonString(Array.isArray(patch.providerJobIds) ? patch.providerJobIds : []));
  }
  if (patch.providerStatus !== undefined) {
    updates.push('provider_status = ?');
    params.push(jsonString(patch.providerStatus));
  }
  if (patch.usageLogId !== undefined) {
    updates.push('usage_log_id = ?');
    params.push(numberOrNull(patch.usageLogId));
  }
  if (patch.videoTaskDetailId !== undefined) {
    updates.push('video_task_detail_id = ?');
    params.push(numberOrNull(patch.videoTaskDetailId));
  }
  if (!updates.length) return false;
  params.push(jobId);
  try {
    const [result] = await getUsagePool().query(
      `UPDATE generation_tasks SET ${updates.join(', ')} WHERE job_id = ?`,
      params
    );
    const rawOutputs = Array.isArray(patch.outputs)
      ? patch.outputs
      : Array.isArray(patch.resultUrls)
        ? patch.resultUrls
        : Array.isArray(patch.urls)
          ? patch.urls
          : [];
    if (rawOutputs.length > 0) {
      await upsertTaskOutputs(jobId, rawOutputs);
    }
    if (dbStatus === 'succeeded') {
      await refreshTaskApplyStatus(jobId);
      const task = await loadTaskWithoutRefresh(jobId);
      const ownership = await getTaskOwnership(jobId);
      if (task && ownership) {
        const applied = await applyGenerationResult({ jobId, task, ownership });
        if (applied?.applied) await markTaskApplied(jobId, task.meta?.outputs || []);
      }
    }
    if (dbStatus === 'failed') {
      await recordGenerationTaskFailure(jobId, patch.error || patch.errorMessage);
    }
    return Number(result.affectedRows || 0) > 0;
  } catch (error) {
    logPersistenceError('update task', error);
    return false;
  }
}

async function loadTaskWithoutRefresh(jobId) {
  if (!jobId) return null;
  try {
    const [rows] = await getUsagePool().query(
      'SELECT * FROM generation_tasks WHERE job_id = ? LIMIT 1',
      [jobId]
    );
    if (!rows[0]) return tasks[jobId] || null;
    const [outputRows] = await getUsagePool().query(
      'SELECT * FROM generation_task_outputs WHERE job_id = ? ORDER BY output_index ASC',
      [jobId]
    );
    return apiTaskFromRow(rows[0], outputRows);
  } catch (error) {
    logPersistenceError('load task without refresh', error);
    return tasks[jobId] || null;
  }
}

async function getTask(jobId) {
  if (!jobId) return null;
  try {
    await refreshTaskApplyStatus(jobId);
    const [rows] = await getUsagePool().query(
      `SELECT *
       FROM generation_tasks
       WHERE job_id = ?
       LIMIT 1`,
      [jobId]
    );
    if (rows[0]) {
      const [outputRows] = await getUsagePool().query(
        `SELECT *
         FROM generation_task_outputs
         WHERE job_id = ?
         ORDER BY output_index ASC`,
        [jobId]
      );
      const task = apiTaskFromRow(rows[0], outputRows);
      remember(jobId, task);
      return task;
    }
  } catch (error) {
    logPersistenceError('get task', error);
  }
  return tasks[jobId] || null;
}

function activeTaskFromRow(row, outputRows = []) {
  const task = apiTaskFromRow(row, outputRows);
  return {
    jobId: row.job_id,
    projectUuid: row.project_uuid,
    nodeKey: row.node_key,
    taskType: row.task_type,
    status: task?.status ?? 1,
    progressPercent: task?.progressPercent ?? Number(row.progress_percent || 0),
    urls: task?.urls ?? [],
    error: task?.error,
    providerStatus: task?.providerStatus ?? null,
    meta: task?.meta ?? {},
  };
}

async function listActiveTasksForProject(projectUuid, userId, isAdmin = false) {
  if (!projectUuid) return [];
  try {
    const params = [String(projectUuid)];
    let userFilter = '';
    if (!isAdmin) {
      userFilter = 'AND user_id = ?';
      params.push(Number(userId));
    }
    const [rows] = await getUsagePool().query(
      `SELECT *
       FROM generation_tasks
       WHERE project_uuid = ?
         ${userFilter}
         AND status IN ('submitted', 'running')
         AND completed_at IS NULL
         AND apply_status NOT IN ('superseded', 'orphaned')
       ORDER BY created_at ASC
       LIMIT 200`,
      params
    );
    return rows.map((row) => activeTaskFromRow(row));
  } catch (error) {
    logPersistenceError('list active tasks', error);
    return [];
  }
}

async function listRecoverableTasksForProject(projectUuid, userId, isAdmin = false) {
  if (!projectUuid) return [];
  try {
    const params = [String(projectUuid)];
    let userFilter = '';
    if (!isAdmin) {
      userFilter = 'AND t.user_id = ?';
      params.push(Number(userId));
    }
    const [rows] = await getUsagePool().query(
      `SELECT t.*
       FROM generation_tasks t
       INNER JOIN generation_node_heads h
         ON h.project_uuid = t.project_uuid
        AND h.node_key = t.node_key
        AND h.current_job_id = t.job_id
       WHERE t.project_uuid = ?
         ${userFilter}
         AND t.status = 'succeeded'
         AND t.result_urls IS NOT NULL
         AND JSON_LENGTH(t.result_urls) > 0
         AND t.apply_status NOT IN ('superseded', 'orphaned')
         AND t.created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)
       ORDER BY t.created_at ASC
       LIMIT 200`,
      params
    );
    if (!rows.length) return [];
    const jobIds = rows.map((row) => row.job_id);
    const [outputRows] = await getUsagePool().query(
      `SELECT *
       FROM generation_task_outputs
       WHERE job_id IN (?)
       ORDER BY job_id ASC, output_index ASC`,
      [jobIds]
    );
    const outputsByJobId = new Map();
    for (const output of outputRows) {
      const list = outputsByJobId.get(output.job_id) || [];
      list.push(output);
      outputsByJobId.set(output.job_id, list);
    }
    return rows.map((row) => activeTaskFromRow(row, outputsByJobId.get(row.job_id) || []));
  } catch (error) {
    logPersistenceError('list recoverable tasks', error);
    return [];
  }
}

async function canAccessTask(jobId, userId, isAdmin = false) {
  if (!jobId) return false;
  try {
    const [rows] = await getUsagePool().query(
      'SELECT user_id FROM generation_tasks WHERE job_id = ? LIMIT 1',
      [jobId]
    );
    if (!rows[0]) return Boolean(tasks[jobId] && isAdmin);
    return isAdmin || Number(rows[0].user_id) === Number(userId);
  } catch (error) {
    logPersistenceError('check task access', error);
    return false;
  }
}

// Returns the ownership descriptor for a task so callers can additionally
// enforce canvas-scoped access (a task's creator/admin always pass; other
// users must have access to the task's canvas). Returns null when the task
// cannot be located, so the caller keeps returning a uniform "not found".
async function getTaskOwnership(jobId) {
  if (!jobId) return null;
  try {
    const [rows] = await getUsagePool().query(
      'SELECT user_id, canvas_id, project_uuid, node_key FROM generation_tasks WHERE job_id = ? LIMIT 1',
      [jobId]
    );
    if (rows[0]) {
      return {
        userId: numberOrNull(rows[0].user_id),
        canvasId: numberOrNull(rows[0].canvas_id),
        projectUuid: rows[0].project_uuid ? String(rows[0].project_uuid) : null,
        nodeKey: rows[0].node_key ? String(rows[0].node_key) : null,
      };
    }
    const entry = tasks[jobId];
    if (!entry) return null;
    return {
      userId: numberOrNull(entry.userId),
      canvasId: numberOrNull(entry.canvasId),
      projectUuid: entry.projectUuid ? String(entry.projectUuid) : null,
      nodeKey: entry.nodeKey ? String(entry.nodeKey) : null,
    };
  } catch (error) {
    logPersistenceError('load task ownership', error);
    return null;
  }
}

async function failInterruptedTasks(message = '服务重启，未完成的生成任务已中断，请重新生成') {
  try {
    const [interruptedRows] = await getUsagePool().query(
      `SELECT job_id
       FROM generation_tasks
       WHERE status IN ('submitted', 'running')
         AND completed_at IS NULL`
    );
    const [result] = await getUsagePool().query(
      `UPDATE generation_tasks
       SET status = 'failed',
           progress_percent = 0,
           error_message = ?,
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
       WHERE status IN ('submitted', 'running')
         AND completed_at IS NULL`,
      [message]
    );
    await Promise.allSettled(
      interruptedRows.map((row) => recordGenerationTaskFailure(row.job_id, message))
    );
    return Number(result.affectedRows || 0);
  } catch (error) {
    logPersistenceError('fail interrupted tasks', error);
    return 0;
  }
}

function recoveryTaskFromRow(row) {
  const rawProviderJobIds = safeJson(row.provider_job_ids, []);
  return {
    jobId: row.job_id,
    userId: taskUserIdFromRow(row),
    taskType: row.task_type,
    provider: row.provider,
    model: row.model,
    projectUuid: row.project_uuid,
    canvasId: row.canvas_id == null ? null : Number(row.canvas_id),
    nodeKey: row.node_key,
    quantity: Number(row.quantity || 1),
    providerJobIds: (Array.isArray(rawProviderJobIds) ? rawProviderJobIds : [])
      .map((value) => String(value || ''))
      .filter(Boolean),
    providerStatus: safeJson(row.provider_status, null),
    usageLogId: row.usage_log_id == null ? null : Number(row.usage_log_id),
    videoTaskDetailId: row.video_task_detail_id == null ? null : Number(row.video_task_detail_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function recoverInterruptedTasks(
  failureMessage = '服务意外中断，任务无法安全恢复，请重新生成'
) {
  try {
    const [rows] = await getUsagePool().query(
      `SELECT *
       FROM generation_tasks
       WHERE status IN ('submitted', 'running')
         AND completed_at IS NULL
       ORDER BY created_at ASC`
    );
    const interruptedTasks = rows.map(recoveryTaskFromRow);
    // 判据只有一份，和 canvasRoutes.js 的 resumePersistedGenerationTasks 共用：
    // 两边如果各写一份就会漂移，任务会被判成"可恢复"但没人轮询、永久悬空。
    const resumableTasks = interruptedTasks.filter(isResumableGenerationTask);
    const failedTasks = interruptedTasks.filter((task) => !isResumableGenerationTask(task));

    if (resumableTasks.length > 0) {
      const resumableIds = resumableTasks.map((task) => task.jobId);
      await getUsagePool().query(
        `UPDATE generation_tasks
         SET status = 'running',
             error_message = NULL,
             completed_at = NULL,
             next_poll_at = CURRENT_TIMESTAMP,
             locked_at = NULL,
             locked_by = NULL
         WHERE job_id IN (?)`,
        [resumableIds]
      );
      for (const task of resumableTasks) {
        remember(task.jobId, {
          status: 1,
          progressPercent: 1,
          providerJobIds: task.providerJobIds,
          providerStatus: task.providerStatus,
        });
      }
    }

    if (failedTasks.length > 0) {
      const failedIds = failedTasks.map((task) => task.jobId);
      await getUsagePool().query(
        `UPDATE generation_tasks
         SET status = 'failed',
             progress_percent = 0,
             error_message = ?,
             completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
         WHERE job_id IN (?)`,
        [failureMessage, failedIds]
      );
      await getUsagePool().query(
        `UPDATE paid_usage_logs p
         INNER JOIN generation_tasks t ON t.usage_log_id = p.id
         SET p.status = 'failed',
             p.error_message = ?,
             p.completed_at = COALESCE(p.completed_at, CURRENT_TIMESTAMP)
         WHERE t.job_id IN (?)
           AND p.status = 'submitted'`,
        [failureMessage, failedIds]
      );
      await getUsagePool().query(
        `UPDATE video_task_details v
         INNER JOIN generation_tasks t ON t.video_task_detail_id = v.id
         SET v.status = 'failed',
             v.error_message = ?,
             v.provider_status = ?,
             v.completed_at = COALESCE(v.completed_at, CURRENT_TIMESTAMP)
         WHERE t.job_id IN (?)
           AND v.status IN ('submitted', 'running')`,
        [
          failureMessage,
          jsonString({ phase: 'interrupted_without_recovery_data' }),
          failedIds,
        ]
      );
      await Promise.allSettled(
        failedTasks.map((task) => recordGenerationTaskFailure(task.jobId, failureMessage))
      );
    }

    return {
      interruptedCount: interruptedTasks.length,
      resumableTasks,
      resumedCount: resumableTasks.length,
      failedCount: failedTasks.length,
    };
  } catch (error) {
    logPersistenceError('recover interrupted tasks', error);
    return {
      interruptedCount: 0,
      resumableTasks: [],
      resumedCount: 0,
      failedCount: 0,
      error,
    };
  }
}

function createTask(initial = {}) {
  const jobId = initial.jobId || randomId();
  remember(jobId, {
    status: 1,
    progressPercent: 0,
    ...initial,
  });
  delete tasks[jobId].jobId;
  return jobId;
}

function completeTask(jobId, urls = [], extra = {}) {
  return setTask(jobId, {
    status: 2,
    progressPercent: 100,
    urls,
    ...extra,
  });
}

function failTask(jobId, error, extra = {}) {
  return setTask(jobId, {
    status: 3,
    progressPercent: 0,
    error: error?.message || String(error || 'Task failed'),
    ...extra,
  });
}

module.exports = {
  canAccessTask,
  getTaskOwnership,
  cancelPersistentTask,
  createPersistentTask,
  createTask,
  completeTask,
  failTask,
  failInterruptedTasks,
  getTask,
  listActiveTasksForProject,
  listRecoverableTasksForProject,
  markTaskApplied,
  markTaskOrphaned,
  randomId,
  recoverInterruptedTasks,
  setTask,
  setTaskAndWait,
  tasks,
  upsertTaskOutputs,
  waitForPendingPersistence,
};
