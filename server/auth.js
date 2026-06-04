const crypto = require('crypto');
const config = require('./config');
const { getPool } = require('./db');

const COOKIE_NAME = 'tapflow_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function base64urlJson(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function createSession(user) {
  const payload = base64urlJson({
    id: user.id,
    exp: Date.now() + SESSION_TTL_MS
  });
  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const valid =
    expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));

  if (!valid) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.id || Date.now() > data.exp) return null;
    return data;
  } catch (error) {
    return null;
  }
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: SESSION_TTL_MS
  };
}

async function touchUserLastUsed(userId) {
  await getPool().query(
    `UPDATE users
      SET last_used_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP - INTERVAL 1 MINUTE)`,
    [userId]
  );
}

async function requireAuth(req, res, next) {
  try {
    const session = verifySession(req.cookies[COOKIE_NAME]);
    if (!session) {
      res.status(401).json({ error: '请先登录' });
      return;
    }

    const [rows] = await getPool().query(
      'SELECT id, username, role, active FROM users WHERE id = ? LIMIT 1',
      [session.id]
    );

    if (!rows.length || !rows[0].active) {
      res.status(401).json({ error: '账号不可用' });
      return;
    }

    req.user = rows[0];
    await touchUserLastUsed(req.user.id);
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  createSession,
  requireAuth,
  requireAdmin,
  touchUserLastUsed,
  sessionCookieOptions
};
