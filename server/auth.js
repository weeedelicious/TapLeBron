const crypto = require('crypto');
const config = require('./config');
const { getPool } = require('./db');
const { authenticatePluginToken } = require('./services/PluginTokenService');
const { touchUserCatalogLastUsed } = require('./userCatalog');

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

async function touchUserLastUsed(userId, externalUserId = null) {
  await touchUserCatalogLastUsed(userId, externalUserId);
}

async function requireAuth(req, res, next) {
  try {
    const session = verifySession(req.cookies[COOKIE_NAME]);
    if (!session) {
      res.status(401).json({ error: '请先登录' });
      return;
    }

    const [rows] = await getPool().query(
      'SELECT id, external_user_id, username, role, active FROM users WHERE id = ? LIMIT 1',
      [session.id]
    );

    if (!rows.length || !rows[0].active) {
      res.status(401).json({ error: '账号不可用' });
      return;
    }

    req.user = rows[0];
    await touchUserLastUsed(req.user.id, req.user.external_user_id);
    next();
  } catch (error) {
    next(error);
  }
}

async function requirePluginAuth(req, res, next) {
  try {
    const authorization = String(req.get('authorization') || '');
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    const authenticated = match ? await authenticatePluginToken(match[1]) : null;
    if (!authenticated) {
      res.status(401).json({
        error: 'Shotflow plugin token is missing, invalid, revoked, or expired',
        errorCode: 'PLUGIN_AUTH_REQUIRED',
      });
      return;
    }

    req.user = authenticated.user;
    req.pluginAuth = authenticated.token;
    await touchUserLastUsed(req.user.id, req.user.external_user_id);
    next();
  } catch (error) {
    next(error);
  }
}

function requirePluginScope(...requiredScopes) {
  return (req, res, next) => {
    const grantedScopes = Array.isArray(req.pluginAuth?.scopes) ? req.pluginAuth.scopes : [];
    const missingScopes = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
    if (missingScopes.length > 0) {
      res.status(403).json({
        error: `Plugin token is missing required scope: ${missingScopes.join(', ')}`,
        errorCode: 'PLUGIN_SCOPE_REQUIRED',
        requiredScopes: missingScopes,
      });
      return;
    }
    next();
  };
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
  requirePluginAuth,
  requirePluginScope,
  touchUserLastUsed,
  sessionCookieOptions
};
