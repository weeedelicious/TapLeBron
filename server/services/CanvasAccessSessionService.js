const crypto = require('crypto');
const { getContentPool } = require('../db');

const HEADER_NAME = 'x-shotflow-canvas-session';
const TOKEN_BYTES = 32;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokenFromRequest(req) {
  return String(req.get?.(HEADER_NAME) || req.query?.canvasSession || '').trim();
}

function timingSafeHexEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function enterCanvasSession({ canvasId, userId, clientId = '' }) {
  const db = getContentPool();
  const connection = await db.getConnection();
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const hash = tokenHash(token);
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      'SELECT session_epoch FROM canvas_access_sessions WHERE canvas_id = ? FOR UPDATE',
      [canvasId]
    );
    let epoch;
    if (rows[0]) {
      epoch = Math.max(1, Number(rows[0].session_epoch || 0) + 1);
    } else {
      const [epochRows] = await connection.query(
        'SELECT COALESCE(MAX(session_epoch), 0) AS epoch FROM canvas_access_session_history WHERE canvas_id = ?',
        [canvasId]
      );
      epoch = Math.max(1, Number(epochRows[0]?.epoch || 0) + 1);
    }
    await connection.query(
      `INSERT INTO canvas_access_sessions
        (canvas_id, session_epoch, token_hash, user_id, client_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
        session_epoch = VALUES(session_epoch),
        token_hash = VALUES(token_hash),
        user_id = VALUES(user_id),
        client_id = VALUES(client_id),
        created_at = CURRENT_TIMESTAMP,
        last_seen_at = CURRENT_TIMESTAMP`,
      [canvasId, epoch, hash, userId, String(clientId || '').slice(0, 120)]
    );
    await connection.query(
      `INSERT INTO canvas_access_session_history
        (canvas_id, session_epoch, token_hash, user_id, client_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
        token_hash = VALUES(token_hash),
        user_id = VALUES(user_id),
        client_id = VALUES(client_id),
        last_seen_at = CURRENT_TIMESTAMP`,
      [canvasId, epoch, hash, userId, String(clientId || '').slice(0, 120)]
    );
    await connection.commit();
    return { token, epoch };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function canvasSessionState(canvasId) {
  const [rows] = await getContentPool().query(
    `SELECT canvas_id, session_epoch, token_hash, user_id, client_id,
            created_at, last_seen_at, updated_at
     FROM canvas_access_sessions
     WHERE canvas_id = ? LIMIT 1`,
    [canvasId]
  );
  return rows[0] || null;
}

async function validateCanvasSession({ canvasId, token, userId = null, touch = false }) {
  if (!token) return { ok: false, reason: 'required', state: null };
  const state = await canvasSessionState(canvasId);
  if (!state || !timingSafeHexEqual(state.token_hash, tokenHash(token))) {
    return { ok: false, reason: 'revoked', state };
  }
  if (userId != null && Number(state.user_id) !== Number(userId)) {
    return { ok: false, reason: 'revoked', state };
  }
  if (touch) {
    await getContentPool().query(
      'UPDATE canvas_access_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE canvas_id = ? AND token_hash = ?',
      [canvasId, state.token_hash]
    );
  }
  return { ok: true, reason: null, state };
}

async function leaveCanvasSession({ canvasId, token, userId = null }) {
  if (!token) return false;
  const hash = tokenHash(token);
  const params = [canvasId, hash];
  let sql = 'DELETE FROM canvas_access_sessions WHERE canvas_id = ? AND token_hash = ?';
  if (userId != null) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  const [result] = await getContentPool().query(sql, params);
  return result.affectedRows > 0;
}

function sessionError(res, reason, state = null) {
  const revoked = reason !== 'required';
  return res.status(revoked ? 409 : 428).json({
    error: revoked
      ? '该画布已在另一个页面打开，当前页面已失效'
      : '请从画布管理页面重新进入该画布',
    errorCode: revoked
      ? 'CANVAS_ACCESS_SESSION_REVOKED'
      : 'CANVAS_ACCESS_SESSION_REQUIRED',
    sessionEpoch: state ? Number(state.session_epoch || 0) : null,
  });
}

async function requireCanvasSession(req, res, canvasId, { touch = false } = {}) {
  const result = await validateCanvasSession({
    canvasId,
    token: tokenFromRequest(req),
    userId: req.user?.id,
    touch,
  });
  if (!result.ok) {
    const revoked = result.reason !== 'required';
    const error = new Error(revoked
      ? '该画布已在另一个页面打开，当前页面已失效'
      : '请从画布管理页面重新进入该画布');
    error.statusCode = revoked ? 409 : 428;
    error.code = revoked
      ? 'CANVAS_ACCESS_SESSION_REVOKED'
      : 'CANVAS_ACCESS_SESSION_REQUIRED';
    error.details = {
      sessionEpoch: result.state ? Number(result.state.session_epoch || 0) : null,
    };
    error.canvasAccessSessionError = true;
    if (res?.locals) {
      res.locals.canvasAccessSessionStatus = error.statusCode;
      res.locals.canvasAccessSessionError = {
        error: error.message,
        errorCode: error.code,
        sessionEpoch: error.details.sessionEpoch,
      };
    }
    throw error;
  }
  req.canvasAccessSession = {
    canvasId: String(canvasId),
    epoch: Number(result.state.session_epoch || 0),
    clientId: result.state.client_id,
  };
  return result.state;
}

module.exports = {
  HEADER_NAME,
  canvasSessionState,
  enterCanvasSession,
  leaveCanvasSession,
  requireCanvasSession,
  sessionError,
  tokenFromRequest,
  validateCanvasSession,
};
