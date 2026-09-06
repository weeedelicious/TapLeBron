'use strict';

// Idempotency for side-effecting generation requests. Backed by the
// pre-provisioned `plugin_idempotency_records` table (server/db.js), scoped by
// the unique key (user_id, canvas_id, idempotency_key).
//
// Contract (SKILL.md §4.2):
//   - reserve() atomically inserts a 'reserved' row BEFORE any provider submit.
//   - Same scope + same request_hash  -> returns the stored first result (replay).
//   - Same scope + different request_hash -> throws IDEMPOTENCY_CONFLICT (409).
//   - The job_id is stored on the reservation so a crash between reserve and
//     completion is recoverable: a replay re-finds the same job instead of
//     creating a second task / usage / provider call.
//
// This service never calls a provider itself; callers wrap their single
// task+usage creation and provider submit between reserve() and complete().

const crypto = require('crypto');
const { getUsagePool } = require('../db');
const config = require('../config');
const { generationError, GENERATION_ERROR_CODES } = require('./generationErrors');

function normalizeScope({ userId, canvasId, key }) {
  const uid = Number(userId);
  const cid = Number(canvasId);
  const k = String(key || '').trim();
  if (!Number.isFinite(uid) || uid <= 0) throw new Error('idempotency: invalid userId');
  if (!Number.isFinite(cid) || cid <= 0) throw new Error('idempotency: invalid canvasId');
  if (!k) throw new Error('idempotency: missing idempotencyKey');
  if (k.length > 160) throw new Error('idempotency: key too long');
  return { userId: uid, canvasId: cid, key: k };
}

// Stable request hash over the caller-supplied canonical request. Callers may
// pass a precomputed hash; otherwise we hash a JSON-stable representation.
function computeRequestHash(request) {
  if (typeof request === 'string' && /^[a-f0-9]{64}$/i.test(request)) return request.toLowerCase();
  const json = typeof request === 'string' ? request : stableStringify(request);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function safeJsonParse(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function ttlSeconds() {
  return Math.max(3600, Number(config.generation?.idempotencyTtlSeconds || 86_400) || 86_400);
}

async function findRecord(scope) {
  const [rows] = await getUsagePool().query(
    `SELECT id, request_hash, status, job_id, response_json, error_code, expires_at
       FROM plugin_idempotency_records
      WHERE user_id = ? AND canvas_id = ? AND idempotency_key = ?
      LIMIT 1`,
    [scope.userId, scope.canvasId, scope.key],
  );
  return rows[0] || null;
}

// Reserve (or replay) an idempotency slot.
// Returns one of:
//   { replay: false, recordId }                              -> caller proceeds to do the work
//   { replay: true, status, jobId, response }                -> caller returns stored result
// Throws IDEMPOTENCY_CONFLICT (409) when the key was used with a different request.
async function reserve({ userId, canvasId, key, operation, request, requestHash }) {
  const scope = normalizeScope({ userId, canvasId, key });
  const op = String(operation || '').trim().slice(0, 80) || 'generate';
  const hash = requestHash ? computeRequestHash(requestHash) : computeRequestHash(request);
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000);

  try {
    const [result] = await getUsagePool().query(
      `INSERT INTO plugin_idempotency_records
         (user_id, canvas_id, idempotency_key, operation, request_hash, status, expires_at)
       VALUES (?, ?, ?, ?, ?, 'reserved', ?)`,
      [scope.userId, scope.canvasId, scope.key, op, hash, expiresAt],
    );
    return { replay: false, recordId: Number(result.insertId), requestHash: hash };
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      // A row already exists for this scope. Decide replay vs conflict.
      const existing = await findRecord(scope);
      if (!existing) {
        // Rare race: the conflicting row vanished. Surface as conflict to be safe.
        throw generationError(
          '幂等键冲突，请重试',
          GENERATION_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          409,
          { idempotencyKey: scope.key },
        );
      }
      if (String(existing.request_hash) !== hash) {
        throw generationError(
          '相同幂等键被用于不同请求',
          GENERATION_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          409,
          { idempotencyKey: scope.key },
        );
      }
      // Same request -> replay the first outcome (may still be in-flight).
      return {
        replay: true,
        recordId: Number(existing.id),
        status: String(existing.status),
        jobId: existing.job_id ? String(existing.job_id) : null,
        response: safeJsonParse(existing.response_json, null),
        errorCode: existing.error_code || null,
        requestHash: hash,
      };
    }
    throw error;
  }
}

// Attach the created job to a reservation as soon as it exists (crash-boundary
// safety: a replay after this point re-finds the same job).
async function attachJob({ userId, canvasId, key, jobId }) {
  const scope = normalizeScope({ userId, canvasId, key });
  await getUsagePool().query(
    `UPDATE plugin_idempotency_records
        SET job_id = ?, status = 'running'
      WHERE user_id = ? AND canvas_id = ? AND idempotency_key = ?`,
    [String(jobId), scope.userId, scope.canvasId, scope.key],
  );
}

// Mark the reservation complete and store the first response for replay.
async function complete({ userId, canvasId, key, jobId, response }) {
  const scope = normalizeScope({ userId, canvasId, key });
  await getUsagePool().query(
    `UPDATE plugin_idempotency_records
        SET status = 'completed',
            job_id = COALESCE(?, job_id),
            response_json = ?,
            error_code = NULL
      WHERE user_id = ? AND canvas_id = ? AND idempotency_key = ?`,
    [jobId ? String(jobId) : null, response == null ? null : JSON.stringify(response), scope.userId, scope.canvasId, scope.key],
  );
}

// Mark the reservation failed. By default the row is deleted so the caller can
// retry with the same key (a failed attempt should not permanently burn a key);
// pass keepRecord:true to retain a 'failed' row for audit instead.
async function fail({ userId, canvasId, key, errorCode = null, keepRecord = false }) {
  const scope = normalizeScope({ userId, canvasId, key });
  if (keepRecord) {
    await getUsagePool().query(
      `UPDATE plugin_idempotency_records
          SET status = 'failed', error_code = ?
        WHERE user_id = ? AND canvas_id = ? AND idempotency_key = ?`,
      [errorCode ? String(errorCode).slice(0, 160) : null, scope.userId, scope.canvasId, scope.key],
    );
    return;
  }
  await getUsagePool().query(
    `DELETE FROM plugin_idempotency_records
      WHERE user_id = ? AND canvas_id = ? AND idempotency_key = ? AND status IN ('reserved', 'running', 'failed')`,
    [scope.userId, scope.canvasId, scope.key],
  );
}

module.exports = {
  reserve,
  attachJob,
  complete,
  fail,
  computeRequestHash,
  // exported for tests
  _stableStringify: stableStringify,
};
