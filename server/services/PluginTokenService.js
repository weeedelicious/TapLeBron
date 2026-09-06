const crypto = require('crypto');
const { getPool } = require('../db');

const TOKEN_PREFIX = 'sfp_';
const VALID_SCOPES = Object.freeze(['read', 'canvas:write', 'generate']);
const MAX_ACTIVE_TOKENS_PER_USER = 20;

function pluginTokenError(message, code = 'PLUGIN_TOKEN_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeScopes(value, options = {}) {
  const source = Array.isArray(value) ? value : [];
  const scopes = [...new Set(source.map((scope) => String(scope || '').trim()).filter(Boolean))];
  const invalid = scopes.filter((scope) => !VALID_SCOPES.includes(scope));
  if (invalid.length > 0) {
    throw pluginTokenError(`Unsupported plugin token scope: ${invalid.join(', ')}`, 'INVALID_PLUGIN_SCOPE');
  }
  if (options.defaultRead !== false && scopes.length === 0) scopes.push('read');
  if ((scopes.includes('canvas:write') || scopes.includes('generate')) && !scopes.includes('read')) {
    scopes.unshift('read');
  }
  return scopes;
}

function parseStoredScopes(value) {
  if (Array.isArray(value)) return normalizeScopes(value, { defaultRead: false });
  if (typeof value !== 'string') return [];
  try {
    return normalizeScopes(JSON.parse(value), { defaultRead: false });
  } catch {
    return normalizeScopes(value.split(','), { defaultRead: false });
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokenRecordFromRow(row) {
  return {
    id: String(row.id),
    name: row.name,
    prefix: row.token_prefix,
    scopes: parseStoredScopes(row.scopes),
    active: Boolean(row.active),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

async function createPluginToken(userId, options = {}) {
  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId) || numericUserId <= 0) {
    throw pluginTokenError('Invalid plugin token owner', 'INVALID_PLUGIN_TOKEN_OWNER');
  }

  const name = String(options.name || 'Cindy Shotflow').trim().slice(0, 80) || 'Cindy Shotflow';
  const scopes = normalizeScopes(options.scopes);
  const expiresAt = options.expiresAt ? new Date(options.expiresAt) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    throw pluginTokenError('Plugin token expiry must be in the future', 'INVALID_PLUGIN_TOKEN_EXPIRY');
  }

  const [[countRow]] = await getPool().query(
    'SELECT COUNT(*) AS count FROM plugin_api_tokens WHERE user_id = ? AND active = 1',
    [numericUserId]
  );
  if (Number(countRow?.count || 0) >= MAX_ACTIVE_TOKENS_PER_USER) {
    throw pluginTokenError(
      `A user can have at most ${MAX_ACTIVE_TOKENS_PER_USER} active plugin tokens`,
      'PLUGIN_TOKEN_LIMIT',
      409
    );
  }

  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const prefix = token.slice(0, 12);
  const [result] = await getPool().query(
    `INSERT INTO plugin_api_tokens
      (user_id, name, token_prefix, token_hash, scopes, active, expires_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [numericUserId, name, prefix, tokenHash(token), JSON.stringify(scopes), expiresAt]
  );

  const [[row]] = await getPool().query(
    `SELECT id, name, token_prefix, scopes, active, expires_at, last_used_at, created_at, revoked_at
     FROM plugin_api_tokens
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [result.insertId, numericUserId]
  );
  return { token, record: tokenRecordFromRow(row) };
}

async function listPluginTokens(userId) {
  const [rows] = await getPool().query(
    `SELECT id, name, token_prefix, scopes, active, expires_at, last_used_at, created_at, revoked_at
     FROM plugin_api_tokens
     WHERE user_id = ? AND active = 1
     ORDER BY created_at DESC, id DESC`,
    [Number(userId)]
  );
  return rows.map(tokenRecordFromRow);
}

async function revokePluginToken(userId, tokenId) {
  const [result] = await getPool().query(
    `UPDATE plugin_api_tokens
     SET active = 0, revoked_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND active = 1`,
    [Number(tokenId), Number(userId)]
  );
  return result.affectedRows > 0;
}

async function authenticatePluginToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token.startsWith(TOKEN_PREFIX) || token.length < 32 || token.length > 256) return null;

  const [rows] = await getPool().query(
    `SELECT
       t.id AS token_id,
       t.name AS token_name,
       t.token_prefix,
       t.scopes,
       t.expires_at,
       u.id,
       u.external_user_id,
       u.username,
       u.role,
       u.active
     FROM plugin_api_tokens t
     INNER JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?
       AND t.active = 1
       AND (t.expires_at IS NULL OR t.expires_at > CURRENT_TIMESTAMP)
     LIMIT 1`,
    [tokenHash(token)]
  );
  const row = rows[0];
  if (!row || !row.active) return null;

  await getPool().query(
    `UPDATE plugin_api_tokens
     SET last_used_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP - INTERVAL 5 MINUTE)`,
    [row.token_id]
  );

  return {
    user: {
      id: row.id,
      external_user_id: row.external_user_id,
      username: row.username,
      role: row.role,
      active: row.active,
    },
    token: {
      id: String(row.token_id),
      name: row.token_name,
      prefix: row.token_prefix,
      scopes: parseStoredScopes(row.scopes),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    },
  };
}

module.exports = {
  VALID_SCOPES,
  authenticatePluginToken,
  createPluginToken,
  listPluginTokens,
  normalizeScopes,
  revokePluginToken,
};
