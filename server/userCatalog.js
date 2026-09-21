const mysql = require('mysql2/promise');
const config = require('./config');
const { getPool } = require('./db');
const { normalizeShotflowRole, localRoleFromExternal } = require('./shotflowRole');

const USER_SYNC_INTERVAL_MS = 5_000;
const LEGACY_LOCAL_ONLY_USERNAMES = new Set(['\u5b9e\u4e60\u751f01']);

let externalPool = null;
let bootstrapPromise = null;
let lastSyncAt = 0;
let bootstrapCompleted = false;

function userCatalogEnabled() {
  return config.projectCatalog.backend === 'sd2_mysql';
}

function poolOptions(settings) {
  return {
    ...settings,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0,
    timezone: '+08:00',
  };
}

function qIdent(value) {
  return `\`${String(value || '').replace(/`/g, '``')}\``;
}

function normalizeUsername(username, maxLength = 80) {
  return String(username || '').trim().slice(0, maxLength);
}

function getTables() {
  const mainDb = qIdent(config.projectCatalog.mainDatabase);
  const projectDb = qIdent(config.projectCatalog.database);
  return {
    users: `${mainDb}.${qIdent('sd2_users')}`,
    runtime: `${mainDb}.${qIdent('sd2_user_runtime')}`,
    projects: `${projectDb}.${qIdent('sd2_projects')}`,
    userProjects: `${projectDb}.${qIdent('sd2_user_projects')}`,
  };
}

function getExternalPool() {
  if (!userCatalogEnabled()) return null;
  if (!externalPool) {
    externalPool = mysql.createPool(
      poolOptions({
        host: config.projectCatalog.host,
        port: config.projectCatalog.port,
        user: config.projectCatalog.user,
        password: config.projectCatalog.password,
        database: config.projectCatalog.mainDatabase,
        charset: config.projectCatalog.charset,
      })
    );
  }
  return externalPool;
}

function catalogUserFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: String(row.username || ''),
    password_hash: row.password_hash || null,
    role: localRoleFromExternal(row),
    shotflow_role: normalizeShotflowRole(row.shotflow_role),
    active: row.active == null ? true : Boolean(row.active),
    is_admin: Boolean(row.is_admin),
    is_tester: Boolean(row.is_tester),
    can_4k: Boolean(row.can_4k),
    is_line_producer: Boolean(row.is_line_producer),
    created_at: row.created_at || null,
    last_used_at: row.last_used_at || null,
  };
}

async function ensureLocalShadowSchema() {
  const db = getPool();
  const [columns] = await db.query("SHOW COLUMNS FROM users LIKE 'external_user_id'");
  if (!columns.length) {
    await db.query('ALTER TABLE users ADD COLUMN external_user_id BIGINT UNSIGNED NULL AFTER id');
  }
  const [indexes] = await db.query("SHOW INDEX FROM users WHERE Key_name = 'uk_users_external_user_id'");
  if (!indexes.length) {
    await db.query('ALTER TABLE users ADD UNIQUE KEY uk_users_external_user_id (external_user_id)');
  }
}

async function ensureExternalRuntimeSchema() {
  if (!userCatalogEnabled()) return;
  const pool = getExternalPool();
  const { runtime, users } = getTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${runtime} (
      user_id INT NOT NULL PRIMARY KEY,
      active TINYINT(1) NOT NULL DEFAULT 1,
      last_used_at DATETIME NULL DEFAULT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_sd2_user_runtime_user
        FOREIGN KEY (user_id) REFERENCES ${users}(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

async function listExternalCatalogUsers() {
  if (!userCatalogEnabled()) {
    const [rows] = await getPool().query(
      `SELECT id, username, password_hash, role, active, created_at, last_used_at
       FROM users
       ORDER BY username ASC, id ASC`
    );
    return rows.map((row) => ({
      id: Number(row.id),
      username: row.username,
      password_hash: row.password_hash || null,
      role: row.role || 'user',
      shotflow_role: row.role === 'admin' ? 'admin' : 'artist',
      active: Boolean(row.active),
      is_admin: row.role === 'admin',
      is_tester: false,
      can_4k: false,
      is_line_producer: false,
      created_at: row.created_at || null,
      last_used_at: row.last_used_at || null,
    }));
  }

  const pool = getExternalPool();
  const { users, runtime } = getTables();
  const [rows] = await pool.query(
    `SELECT
       u.id,
       u.username,
       u.password_hash,
       u.shotflow_role,
       u.is_admin,
       u.is_tester,
       u.can_4k,
       u.is_line_producer,
       u.created_at,
       COALESCE(r.active, 1) AS active,
       r.last_used_at
     FROM ${users} u
     LEFT JOIN ${runtime} r ON r.user_id = u.id
     ORDER BY u.created_at ASC, u.id ASC`
  );
  return rows.map(catalogUserFromRow);
}

async function getExternalCatalogUserById(userId) {
  const numericId = Number(userId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  const rows = await listExternalCatalogUsers();
  return rows.find((row) => row.id === numericId) || null;
}

async function getExternalCatalogUserByUsername(username) {
  const wanted = normalizeUsername(username, 80);
  if (!wanted) return null;
  const rows = await listExternalCatalogUsers();
  return rows.find((row) => row.username === wanted) || null;
}

async function getLocalShadowUsers() {
  const [rows] = await getPool().query(
    `SELECT id, external_user_id, username, password_hash, role, active, created_at, updated_at, last_used_at
     FROM users
     ORDER BY id ASC`
  );
  return rows.map((row) => ({
    id: Number(row.id),
    external_user_id: row.external_user_id == null ? null : Number(row.external_user_id),
    username: String(row.username || ''),
    password_hash: row.password_hash || null,
    role: row.role || 'user',
    active: Boolean(row.active),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    last_used_at: row.last_used_at || null,
  }));
}

async function upsertLocalShadowFromCatalogUser(catalogUser) {
  const externalId = Number(catalogUser.id);
  const [rows] = await getPool().query(
    `SELECT id, username, last_used_at
     FROM users
     WHERE external_user_id = ? OR username = ?
     ORDER BY CASE WHEN external_user_id = ? THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [externalId, catalogUser.username, externalId]
  );
  const existing = rows[0] || null;
  const lastUsedAt = catalogUser.last_used_at || existing?.last_used_at || null;

  if (existing) {
    await getPool().query(
      `UPDATE users
       SET external_user_id = ?,
           username = ?,
           password_hash = ?,
           role = ?,
           active = ?,
           last_used_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        externalId,
        catalogUser.username,
        catalogUser.password_hash,
        catalogUser.role,
        catalogUser.active ? 1 : 0,
        lastUsedAt,
        existing.id,
      ]
    );
    const [updatedRows] = await getPool().query(
      `SELECT id, external_user_id, username, password_hash, role, active, created_at, updated_at, last_used_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [existing.id]
    );
    return updatedRows[0] || null;
  }

  await getPool().query(
    `INSERT INTO users
      (username, password_hash, role, active, created_at, updated_at, last_used_at, external_user_id)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
    [
      catalogUser.username,
      catalogUser.password_hash,
      catalogUser.role,
      catalogUser.active ? 1 : 0,
      catalogUser.created_at || new Date(),
      lastUsedAt,
      externalId,
    ]
  );

  const [insertedRows] = await getPool().query(
    `SELECT id, external_user_id, username, password_hash, role, active, created_at, updated_at, last_used_at
     FROM users
     WHERE external_user_id = ?
     LIMIT 1`,
    [externalId]
  );
  return insertedRows[0] || null;
}

async function deactivateOrphanLocalShadow(localUserId) {
  await getPool().query(
    `UPDATE users
     SET active = 0,
         password_hash = NULL,
         external_user_id = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [Number(localUserId)]
  );
}

async function localShadowOwnsData(localUserId) {
  const [canvasRows] = await getPool().query('SELECT COUNT(*) AS total FROM canvases WHERE owner_id = ?', [Number(localUserId)]);
  const [collectionRows] = await getPool().query('SELECT COUNT(*) AS total FROM canvas_collections WHERE owner_id = ?', [Number(localUserId)]);
  return Number(canvasRows[0]?.total || 0) > 0 || Number(collectionRows[0]?.total || 0) > 0;
}

async function deleteLocalShadowIfSafe(localUserId) {
  if (await localShadowOwnsData(localUserId)) {
    await deactivateOrphanLocalShadow(localUserId);
    return false;
  }
  await getPool().query('DELETE FROM users WHERE id = ?', [Number(localUserId)]);
  return true;
}

async function syncSharedUserCatalog(options = {}) {
  if (!userCatalogEnabled()) return [];

  const force = Boolean(options.force);
  if (!force && Date.now() - lastSyncAt < USER_SYNC_INTERVAL_MS) {
    return listExternalCatalogUsers();
  }

  await ensureLocalShadowSchema();
  await ensureExternalRuntimeSchema();

  const externalUsers = await listExternalCatalogUsers();
  const externalUsernames = new Set(externalUsers.map((user) => user.username));
  const matchedLocalIds = new Set();

  for (const externalUser of externalUsers) {
    const localShadow = await upsertLocalShadowFromCatalogUser(externalUser);
    if (localShadow?.id) matchedLocalIds.add(Number(localShadow.id));
  }

  const localShadows = await getLocalShadowUsers();
  for (const localShadow of localShadows) {
    if (matchedLocalIds.has(Number(localShadow.id))) continue;
    if (localShadow.external_user_id != null || LEGACY_LOCAL_ONLY_USERNAMES.has(localShadow.username) || !externalUsernames.has(localShadow.username)) {
      await deactivateOrphanLocalShadow(localShadow.id);
    }
  }

  lastSyncAt = Date.now();
  return externalUsers;
}

async function bootstrapSharedUserCatalog() {
  if (!userCatalogEnabled()) {
    bootstrapCompleted = true;
    return [];
  }
  if (bootstrapCompleted) return listExternalCatalogUsers();
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      await syncSharedUserCatalog({ force: true });
      bootstrapCompleted = true;
      return listExternalCatalogUsers();
    })().finally(() => {
      bootstrapPromise = null;
    });
  }
  return bootstrapPromise;
}

function mergeCatalogLastUsedFromLocal(catalogUsers, localShadows) {
  const lastUsedByExternalId = new Map();
  for (const localShadow of localShadows) {
    if (localShadow.external_user_id == null || !localShadow.last_used_at) continue;
    if (!lastUsedByExternalId.has(localShadow.external_user_id)) {
      lastUsedByExternalId.set(localShadow.external_user_id, localShadow.last_used_at);
    }
  }

  return catalogUsers.map((user) =>
    user.last_used_at ? user : { ...user, last_used_at: lastUsedByExternalId.get(user.id) || null }
  );
}

async function listUserCatalogRows() {
  await bootstrapSharedUserCatalog();
  await syncSharedUserCatalog();
  const catalogUsers = await listExternalCatalogUsers();
  if (!userCatalogEnabled()) return catalogUsers;
  const localShadows = await getLocalShadowUsers();
  return mergeCatalogLastUsedFromLocal(catalogUsers, localShadows);
}

async function getUserCatalogRowById(userId) {
  await bootstrapSharedUserCatalog();
  await syncSharedUserCatalog();
  return getExternalCatalogUserById(userId);
}

async function getLocalShadowByCatalogUserId(userId) {
  await bootstrapSharedUserCatalog();
  await syncSharedUserCatalog();
  const [rows] = await getPool().query(
    `SELECT id, external_user_id, username, password_hash, role, active, created_at, updated_at, last_used_at
     FROM users
     WHERE external_user_id = ?
     LIMIT 1`,
    [Number(userId)]
  );
  return rows[0] || null;
}

async function countActiveCatalogAdmins(exceptCatalogUserId = null) {
  const users = await listUserCatalogRows();
  return users.filter((user) => user.role === 'admin' && user.active && Number(user.id) !== Number(exceptCatalogUserId)).length;
}

async function touchUserCatalogLastUsed(localUserId, catalogUserId = null) {
  const localId = Number(localUserId);
  if (!Number.isFinite(localId) || localId <= 0) return;
  await getPool().query(
    `UPDATE users
     SET last_used_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP - INTERVAL 1 MINUTE)`,
    [localId]
  );

  if (!userCatalogEnabled()) return;

  const resolvedCatalogId = catalogUserId == null ? localId : Number(catalogUserId);
  if (!Number.isFinite(resolvedCatalogId) || resolvedCatalogId <= 0) return;

  const pool = getExternalPool();
  const { runtime } = getTables();
  await pool.query(
    `INSERT INTO ${runtime} (user_id, active, last_used_at)
     VALUES (?, 1, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       last_used_at = IF(last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP - INTERVAL 1 MINUTE, CURRENT_TIMESTAMP, last_used_at),
       updated_at = CURRENT_TIMESTAMP`,
    [resolvedCatalogId]
  );
}

function cleanUserApiKey(value) {
  return String(value || '').trim();
}

function assertValidUserApiKey(value) {
  const text = cleanUserApiKey(value);
  if (text.length < 12 || text.length > 512) {
    const error = new Error('请填写有效的 API Key');
    error.status = 400;
    throw error;
  }
  return text;
}

async function createUserInCatalog({ username, role = 'user', active = true, apiKey = null }) {
  const cleanKey = apiKey == null || apiKey === '' ? null : assertValidUserApiKey(apiKey);
  if (!userCatalogEnabled()) {
    const [result] = await getPool().query(
      'INSERT INTO users (username, password_hash, role, active, llm_api_key) VALUES (?, NULL, ?, ?, ?)',
      [normalizeUsername(username), role, active ? 1 : 0, cleanKey]
    );
    const [rows] = await getPool().query(
      `SELECT id, username, password_hash, role, active, created_at, last_used_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [result.insertId]
    );
    return {
      id: Number(rows[0].id),
      username: rows[0].username,
      password_hash: rows[0].password_hash,
      role: rows[0].role,
      active: Boolean(rows[0].active),
      created_at: rows[0].created_at,
      last_used_at: rows[0].last_used_at,
    };
  }

  await bootstrapSharedUserCatalog();
  const pool = getExternalPool();
  const { users, runtime, userProjects, projects } = getTables();
  const cleanUsername = normalizeUsername(username, 50);
  const [result] = await pool.query(
    `INSERT INTO ${users} (username, is_admin, is_tester, can_4k, is_line_producer, shotflow_role, api_key)
     VALUES (?, 0, 0, 0, 0, ?, ?)`,
    [cleanUsername, role === 'admin' ? 'admin' : 'artist', cleanKey]
  );
  const catalogId = Number(result.insertId);
  await pool.query(
    `INSERT INTO ${runtime} (user_id, active, last_used_at)
     VALUES (?, ?, NULL)
     ON DUPLICATE KEY UPDATE active = VALUES(active), updated_at = CURRENT_TIMESTAMP`,
    [catalogId, active ? 1 : 0]
  );
  await pool.query(
    `INSERT IGNORE INTO ${userProjects} (user_id, project_id)
     SELECT ?, id FROM ${projects}`,
    [catalogId]
  );
  await syncSharedUserCatalog({ force: true });
  return getUserCatalogRowById(catalogId);
}

async function updateUserInCatalog(userId, patch = {}) {
  const catalogId = Number(userId);
  if (!Number.isFinite(catalogId) || catalogId <= 0) return null;

  if (!userCatalogEnabled()) {
    const updates = [];
    const params = [];
    if (patch.username !== undefined) {
      updates.push('username = ?');
      params.push(normalizeUsername(patch.username));
    }
    if (patch.role !== undefined) {
      updates.push('role = ?');
      params.push(patch.role === 'admin' ? 'admin' : 'user');
    }
    if (patch.active !== undefined) {
      updates.push('active = ?');
      params.push(patch.active ? 1 : 0);
    }
    if (patch.clearPassword) {
      updates.push('password_hash = NULL');
    }
    if (updates.length) {
      params.push(catalogId);
      await getPool().query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    const [rows] = await getPool().query(
      `SELECT id, username, password_hash, role, active, created_at, last_used_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [catalogId]
    );
    return rows[0]
      ? {
          id: Number(rows[0].id),
          username: rows[0].username,
          password_hash: rows[0].password_hash,
          role: rows[0].role,
          active: Boolean(rows[0].active),
          created_at: rows[0].created_at,
          last_used_at: rows[0].last_used_at,
        }
      : null;
  }

  await bootstrapSharedUserCatalog();
  const pool = getExternalPool();
  const { users, runtime } = getTables();
  const updates = [];
  const params = [];

  if (patch.username !== undefined) {
    updates.push('username = ?');
    params.push(normalizeUsername(patch.username, 50));
  }
  if (patch.role !== undefined) {
    updates.push('shotflow_role = ?');
    params.push(patch.role === 'admin' ? 'admin' : 'artist');
  }
  if (patch.clearPassword) {
    updates.push('password_hash = NULL');
  }
  if (updates.length) {
    params.push(catalogId);
    await pool.query(`UPDATE ${users} SET ${updates.join(', ')} WHERE id = ?`, params);
  }
  if (patch.active !== undefined) {
    await pool.query(
      `INSERT INTO ${runtime} (user_id, active, last_used_at)
       VALUES (?, ?, NULL)
       ON DUPLICATE KEY UPDATE active = VALUES(active), updated_at = CURRENT_TIMESTAMP`,
      [catalogId, patch.active ? 1 : 0]
    );
  }
  await syncSharedUserCatalog({ force: true });
  return getUserCatalogRowById(catalogId);
}

async function setUserPasswordInCatalog(userId, password) {
  const catalogId = Number(userId);
  if (!Number.isFinite(catalogId) || catalogId <= 0) return null;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(String(password || ''), 12);

  if (!userCatalogEnabled()) {
    await getPool().query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, catalogId]);
    const [rows] = await getPool().query(
      `SELECT id, username, password_hash, role, active, created_at, last_used_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [catalogId]
    );
    return rows[0] || null;
  }

  await bootstrapSharedUserCatalog();
  const pool = getExternalPool();
  const { users } = getTables();
  await pool.query(`UPDATE ${users} SET password_hash = ? WHERE id = ?`, [hash, catalogId]);
  await syncSharedUserCatalog({ force: true });
  return getUserCatalogRowById(catalogId);
}

async function deleteUserInCatalog(userId) {
  const catalogId = Number(userId);
  if (!Number.isFinite(catalogId) || catalogId <= 0) return;

  if (!userCatalogEnabled()) {
    await deleteLocalShadowIfSafe(catalogId);
    return;
  }

  await bootstrapSharedUserCatalog();
  const localShadow = await getLocalShadowByCatalogUserId(catalogId);
  const pool = getExternalPool();
  const { users, runtime, userProjects } = getTables();
  await pool.query(`DELETE FROM ${userProjects} WHERE user_id = ?`, [catalogId]);
  await pool.query(`DELETE FROM ${runtime} WHERE user_id = ?`, [catalogId]);
  await pool.query(`DELETE FROM ${users} WHERE id = ?`, [catalogId]);

  if (localShadow) {
    const ownsData = await localShadowOwnsData(localShadow.id);
    if (ownsData) {
      await getPool().query(
        `UPDATE users
         SET active = 0,
             password_hash = NULL,
             external_user_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [localShadow.id]
      );
    } else {
      await getPool().query('DELETE FROM users WHERE id = ?', [localShadow.id]);
    }
  }
}

const userApiKeyCache = new Map();
const USER_API_KEY_CACHE_TTL_MS = 30_000;

// Fetch a catalog user's own API key (sd2_users.api_key) by external user id, so
// users can generate with their own key on the llm-proxy gateway. Returns the
// trimmed key, or null (no key / local mode / lookup failure). Short-cached.
async function getUserApiKeyByUser(user) {
  if (!user) return null;
  if (userCatalogEnabled()) {
    return getUserApiKeyByExternalId(user.external_user_id);
  }
  return getUserApiKeyByExternalId(user.id);
}

async function getUserApiKeyByExternalId(externalUserId) {
  const numericId = Number(externalUserId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  const cacheKey = userCatalogEnabled() ? `ext:${numericId}` : `local:${numericId}`;
  const cached = userApiKeyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < USER_API_KEY_CACHE_TTL_MS) return cached.key;
  try {
    let raw = null;
    if (userCatalogEnabled()) {
      const pool = getExternalPool();
      const { users } = getTables();
      const [rows] = await pool.query(`SELECT api_key FROM ${users} WHERE id = ? LIMIT 1`, [numericId]);
      raw = rows[0] ? rows[0].api_key : null;
    } else {
      const [rows] = await getPool().query('SELECT llm_api_key FROM users WHERE id = ? LIMIT 1', [numericId]);
      raw = rows[0] ? rows[0].llm_api_key : null;
    }
    const key = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    userApiKeyCache.set(cacheKey, { key, at: Date.now() });
    return key;
  } catch (error) {
    return null;
  }
}

async function setUserApiKeyInCatalog(userId, apiKey) {
  const catalogId = Number(userId);
  if (!Number.isFinite(catalogId) || catalogId <= 0) return null;
  const cleanKey = assertValidUserApiKey(apiKey);

  if (!userCatalogEnabled()) {
    await getPool().query('UPDATE users SET llm_api_key = ? WHERE id = ?', [cleanKey, catalogId]);
    userApiKeyCache.delete(`local:${catalogId}`);
    return getUserCatalogRowById(catalogId);
  }

  await bootstrapSharedUserCatalog();
  const pool = getExternalPool();
  const { users } = getTables();
  await pool.query(`UPDATE ${users} SET api_key = ? WHERE id = ?`, [cleanKey, catalogId]);
  userApiKeyCache.delete(`ext:${catalogId}`);
  return getUserCatalogRowById(catalogId);
}

module.exports = {
  bootstrapSharedUserCatalog,
  getUserApiKeyByExternalId,
  getUserApiKeyByUser,
  countActiveCatalogAdmins,
  createUserInCatalog,
  setUserApiKeyInCatalog,
  deleteUserInCatalog,
  getLocalShadowByCatalogUserId,
  getUserCatalogRowById,
  listUserCatalogRows,
  setUserPasswordInCatalog,
  syncSharedUserCatalog,
  touchUserCatalogLastUsed,
  updateUserInCatalog,
};
