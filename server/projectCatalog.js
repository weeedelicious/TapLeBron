const mysql = require('mysql2/promise');
const config = require('./config');
const { getPool } = require('./db');

const DEFAULT_PROJECT_NAME = '\u6d4b\u8bd5';
const REQUIRED_PROJECTS = [
  { name: '\u706b\u70ac_SS13\u82f1\u96c4', status: 'not_started' },
  { name: '\u706b\u70ac_SS14\u82f1\u96c4', status: 'not_started' },
  { name: '\u706b\u70ac_SS13\u8d5b\u5b63', status: 'not_started' },
  { name: '\u706b\u70ac_SS14\u8d5b\u5b63', status: 'not_started' },
  { name: '\u5c0f\u9547_\u6ce1\u9762\u756a', status: 'not_started' },
  { name: '\u9999\u80a0_AI\u6f2b\u5267', status: 'not_started' },
  { name: DEFAULT_PROJECT_NAME, status: 'not_started' },
];
const CATALOG_SYNC_INTERVAL_MS = 5_000;

let catalogPool = null;
let bootstrapPromise = null;
let syncPromise = null;
let bootstrapCompleted = false;
let lastSyncAt = 0;

function isExternalProjectCatalogEnabled() {
  return config.projectCatalog.backend === 'sd2_mysql';
}

function qIdent(value) {
  return `\`${String(value || '').replace(/`/g, '``')}\``;
}

function normalizeProjectName(name, maxLength = 100) {
  return String(name || '').trim().slice(0, maxLength);
}

function localStatusFromExternal(status) {
  switch (String(status || '').trim().toLowerCase()) {
    case 'active':
      return 'in_progress';
    case 'done':
    case 'completed':
      return 'completed';
    case 'paused':
    case 'pending':
    default:
      return 'not_started';
  }
}

function externalStatusFromLocal(status) {
  switch (String(status || '').trim()) {
    case 'in_progress':
      return 'active';
    case 'completed':
      return 'done';
    case 'not_started':
    default:
      return 'pending';
  }
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

function getCatalogTables() {
  const projectDb = qIdent(config.projectCatalog.database);
  const mainDb = qIdent(config.projectCatalog.mainDatabase);
  return {
    projects: `${projectDb}.${qIdent('sd2_projects')}`,
    userProjects: `${projectDb}.${qIdent('sd2_user_projects')}`,
    users: `${mainDb}.${qIdent('sd2_users')}`,
    shotflowCategories: `${projectDb}.${qIdent('sd2_shotflow_categories')}`,
  };
}

/**
 * 读 sd2 项目管理页维护的那份 shotflow 画布分类（名称 + 顺序）。
 * 画布管理页的"我的分类"就是它的镜像，所以这里是唯一权威来源。
 *
 * 读不到一律返回空数组（外部目录没开、库连不上、表还没建）。调用方看到空数组
 * 必须什么都不做 —— 千万不能当成"分类被清空了"去删本地分类，那会把画布搬来搬去。
 */
async function listShotflowCategoryRows() {
  if (!isExternalProjectCatalogEnabled()) return [];
  try {
    const pool = getCatalogPool();
    if (!pool) return [];
    const { shotflowCategories } = getCatalogTables();
    const [rows] = await pool.query(
      `SELECT id, name, sort_order FROM ${shotflowCategories} ORDER BY sort_order ASC, id ASC`
    );
    return rows
      .map((row) => ({
        id: Number(row.id),
        name: String(row.name || '').trim(),
        sortOrder: Number(row.sort_order || 0),
      }))
      .filter((row) => row.name);
  } catch (error) {
    console.error('[projectCatalog] 读取 shotflow 画布分类失败:', error.message);
    return [];
  }
}

function getCatalogPool() {
  if (!isExternalProjectCatalogEnabled()) return null;
  if (!catalogPool) {
    if (!config.projectCatalog.user || !config.projectCatalog.password || !config.projectCatalog.database) {
      throw new Error('PROJECT_CATALOG_* configuration is incomplete');
    }
    catalogPool = mysql.createPool(
      poolOptions({
        host: config.projectCatalog.host,
        port: config.projectCatalog.port,
        user: config.projectCatalog.user,
        password: config.projectCatalog.password,
        database: config.projectCatalog.database,
        charset: config.projectCatalog.charset,
      })
    );
  }
  return catalogPool;
}

function projectRowFromLocal(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    status: String(row.status || 'not_started'),
    shotflow_applicable: row.shotflow_applicable == null ? true : Boolean(row.shotflow_applicable),
    // sd2 项目管理页给这个项目选的 shotflow 画布分类。分类块里"新建画布"的项目下拉靠它过滤。
    shotflow_category_id: row.shotflow_category_id == null ? null : Number(row.shotflow_category_id),
    created_at: row.created_at || null,
    updated_at: row.updated_at || row.created_at || null,
  };
}

function projectRowFromExternal(row) {
  if (!row) return null;
  const createdAt = row.created_at || null;
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    status: localStatusFromExternal(row.status),
    shotflow_applicable: row.shotflow_applicable == null ? false : Boolean(row.shotflow_applicable),
    shotflow_category_id: row.shotflow_category_id == null ? null : Number(row.shotflow_category_id),
    created_at: createdAt,
    updated_at: createdAt,
  };
}

async function listLocalProjectRows() {
  const [rows] = await getPool().query(
    `SELECT id, name, status, shotflow_applicable, shotflow_category_id, created_at, updated_at
     FROM canvas_projects
     ORDER BY created_at ASC, id ASC`
  );
  return rows.map(projectRowFromLocal);
}

async function getLocalProjectRowById(projectId) {
  const numericId = Number(projectId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  const [rows] = await getPool().query(
    `SELECT id, name, status, shotflow_applicable, shotflow_category_id, created_at, updated_at
     FROM canvas_projects
     WHERE id = ?
     LIMIT 1`,
    [numericId]
  );
  return projectRowFromLocal(rows[0] || null);
}

async function findLocalProjectRowByName(name) {
  const projectName = normalizeProjectName(name, 160);
  if (!projectName) return null;
  const [rows] = await getPool().query(
    `SELECT id, name, status, shotflow_applicable, shotflow_category_id, created_at, updated_at
     FROM canvas_projects
     WHERE name = ?
     LIMIT 1`,
    [projectName]
  );
  return projectRowFromLocal(rows[0] || null);
}

async function listExternalProjectRows() {
  const pool = getCatalogPool();
  const { projects } = getCatalogTables();
  const [rows] = await pool.query(
    `SELECT id, name, status, shotflow_applicable, shotflow_category_id, created_at
     FROM ${projects}
     ORDER BY created_at ASC, id ASC`
  );
  return rows.map(projectRowFromExternal);
}

async function getExternalProjectRowById(projectId) {
  const numericId = Number(projectId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  const pool = getCatalogPool();
  const { projects } = getCatalogTables();
  const [rows] = await pool.query(
    `SELECT id, name, status, shotflow_applicable, shotflow_category_id, created_at
     FROM ${projects}
     WHERE id = ?
     LIMIT 1`,
    [numericId]
  );
  return projectRowFromExternal(rows[0] || null);
}

async function findExternalProjectRowByName(name) {
  const projectName = normalizeProjectName(name);
  if (!projectName) return null;
  const pool = getCatalogPool();
  const { projects } = getCatalogTables();
  const [rows] = await pool.query(
    `SELECT id, name, status, shotflow_applicable, shotflow_category_id, created_at
     FROM ${projects}
     WHERE name = ?
     LIMIT 1`,
    [projectName]
  );
  return projectRowFromExternal(rows[0] || null);
}

async function linkAllUsersToExternalProject(projectId) {
  const numericId = Number(projectId);
  if (!Number.isFinite(numericId) || numericId <= 0) return;
  const pool = getCatalogPool();
  const { userProjects, users } = getCatalogTables();
  await pool.query(
    `INSERT IGNORE INTO ${userProjects} (user_id, project_id)
     SELECT id, ? FROM ${users}`,
    [numericId]
  );
}

async function createExternalProject(name, status = 'not_started') {
  const projectName = normalizeProjectName(name);
  if (!projectName) {
    throw new Error('project name is required');
  }
  const pool = getCatalogPool();
  const { projects } = getCatalogTables();
  const [result] = await pool.query(
    `INSERT INTO ${projects} (name, status) VALUES (?, ?)`,
    [projectName, externalStatusFromLocal(status)]
  );
  await linkAllUsersToExternalProject(result.insertId);
  return getExternalProjectRowById(result.insertId);
}

async function updateExternalProject(projectId, patch = {}) {
  const numericId = Number(projectId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  const updates = [];
  const params = [];

  if (patch.name !== undefined) {
    const projectName = normalizeProjectName(patch.name);
    if (!projectName) throw new Error('project name is required');
    updates.push('name = ?');
    params.push(projectName);
  }

  if (patch.status !== undefined) {
    updates.push('status = ?');
    params.push(externalStatusFromLocal(patch.status));
  }

  if (!updates.length) return getExternalProjectRowById(numericId);

  const pool = getCatalogPool();
  const { projects } = getCatalogTables();
  params.push(numericId);
  await pool.query(`UPDATE ${projects} SET ${updates.join(', ')} WHERE id = ?`, params);
  return getExternalProjectRowById(numericId);
}

async function mirrorProjectsToLocal(projectRows, options = {}) {
  const rows = Array.isArray(projectRows) ? projectRows.filter(Boolean) : [];
  const prune = options.prune !== false;
  const db = getPool();

  for (const row of rows) {
    await db.query(
      `INSERT INTO canvas_projects (id, name, status, shotflow_applicable, shotflow_category_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         status = VALUES(status),
         shotflow_applicable = VALUES(shotflow_applicable),
         shotflow_category_id = VALUES(shotflow_category_id),
         created_at = VALUES(created_at),
         updated_at = VALUES(updated_at)`,
      [
        Number(row.id),
        normalizeProjectName(row.name, 160),
        String(row.status || 'not_started'),
        row.shotflow_applicable ? 1 : 0,
        row.shotflow_category_id == null ? null : Number(row.shotflow_category_id),
        row.created_at || new Date(),
        row.updated_at || row.created_at || new Date(),
      ]
    );
  }

  if (prune && rows.length) {
    const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
    const placeholders = ids.map(() => '?').join(', ');
    await db.query(`DELETE FROM canvas_projects WHERE id NOT IN (${placeholders})`, ids);
  }
}

async function ensureExternalProjects(requiredProjects) {
  const sourceProjects = Array.isArray(requiredProjects) ? requiredProjects : [];
  const existingRows = await listExternalProjectRows();
  const existingByName = new Map(existingRows.map((row) => [row.name, row]));

  for (const project of sourceProjects) {
    const projectName = normalizeProjectName(project?.name);
    if (!projectName || existingByName.has(projectName)) continue;
    const created = await createExternalProject(projectName, project?.status || 'not_started');
    if (created) {
      existingByName.set(created.name, created);
    }
  }

  return [...existingByName.values()];
}

async function runBootstrap() {
  if (!isExternalProjectCatalogEnabled()) {
    bootstrapCompleted = true;
    return listLocalProjectRows();
  }

  const db = getPool();
  const localProjects = await listLocalProjectRows();
  const requiredProjects = [...REQUIRED_PROJECTS];

  for (const localProject of localProjects) {
    if (!requiredProjects.some((project) => project.name === localProject.name)) {
      requiredProjects.push({
        name: localProject.name,
        status: localProject.status,
      });
    }
  }

  await ensureExternalProjects(requiredProjects);
  const externalProjects = await listExternalProjectRows();
  const externalByName = new Map(externalProjects.map((row) => [row.name, row]));
  const defaultExternalProject = externalByName.get(DEFAULT_PROJECT_NAME) || null;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    for (const localProject of localProjects) {
      const externalProject = externalByName.get(localProject.name);
      if (!externalProject) continue;
      if (Number(localProject.id) === Number(externalProject.id)) continue;
      await connection.query('UPDATE canvas_projects SET name = ? WHERE id = ?', [
        `__legacy_sync_${Number(localProject.id)}__`,
        Number(localProject.id),
      ]);
    }

    for (const externalProject of externalProjects) {
      await connection.query(
        `INSERT INTO canvas_projects (id, name, status, shotflow_applicable, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           status = VALUES(status),
           shotflow_applicable = VALUES(shotflow_applicable),
           created_at = VALUES(created_at),
           updated_at = VALUES(updated_at)`,
        [
          Number(externalProject.id),
          normalizeProjectName(externalProject.name, 160),
          String(externalProject.status || 'not_started'),
          externalProject.shotflow_applicable ? 1 : 0,
          externalProject.created_at || new Date(),
          externalProject.updated_at || externalProject.created_at || new Date(),
        ]
      );
    }

    for (const localProject of localProjects) {
      const externalProject = externalByName.get(localProject.name);
      if (!externalProject) continue;
      if (Number(localProject.id) === Number(externalProject.id)) continue;
      await connection.query('UPDATE canvases SET project_id = ? WHERE project_id = ?', [
        Number(externalProject.id),
        Number(localProject.id),
      ]);
    }

    if (defaultExternalProject) {
      await connection.query('UPDATE canvases SET project_id = ? WHERE project_id IS NULL', [
        Number(defaultExternalProject.id),
      ]);
    }

    const externalIds = externalProjects.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (externalIds.length) {
      const placeholders = externalIds.map(() => '?').join(', ');
      await connection.query(`DELETE FROM canvas_projects WHERE id NOT IN (${placeholders})`, externalIds);
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  bootstrapCompleted = true;
  lastSyncAt = Date.now();
  return listLocalProjectRows();
}

async function bootstrapSharedProjectCatalog(options = {}) {
  if (!isExternalProjectCatalogEnabled()) {
    bootstrapCompleted = true;
    return listLocalProjectRows();
  }

  if (bootstrapCompleted) return listLocalProjectRows();
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().finally(() => {
      bootstrapPromise = null;
    });
  }

  if (options.requireSuccess) {
    return bootstrapPromise;
  }

  try {
    return await bootstrapPromise;
  } catch (error) {
    console.warn('project catalog bootstrap failed, using local mirror cache:', error.message);
    return listLocalProjectRows();
  }
}

async function performSync(force = false) {
  if (!isExternalProjectCatalogEnabled()) {
    bootstrapCompleted = true;
    return listLocalProjectRows();
  }

  await bootstrapSharedProjectCatalog({ requireSuccess: force });

  if (!force && Date.now() - lastSyncAt < CATALOG_SYNC_INTERVAL_MS) {
    return listLocalProjectRows();
  }

  const externalProjects = await listExternalProjectRows();
  await mirrorProjectsToLocal(externalProjects, { prune: true });
  lastSyncAt = Date.now();
  return listLocalProjectRows();
}

async function syncProjectCatalogCache(options = {}) {
  if (!isExternalProjectCatalogEnabled()) {
    bootstrapCompleted = true;
    return listLocalProjectRows();
  }

  const force = Boolean(options.force);
  if (!syncPromise) {
    syncPromise = performSync(force).finally(() => {
      syncPromise = null;
    });
  }

  if (options.requireSuccess) {
    return syncPromise;
  }

  try {
    return await syncPromise;
  } catch (error) {
    console.warn('project catalog sync failed, using local mirror cache:', error.message);
    return listLocalProjectRows();
  }
}

async function listProjectCatalogRows() {
  await syncProjectCatalogCache();
  return listLocalProjectRows();
}

async function getProjectCatalogRowById(projectId) {
  await syncProjectCatalogCache();
  return getLocalProjectRowById(projectId);
}

async function findProjectCatalogRowByName(name) {
  await syncProjectCatalogCache();
  return findLocalProjectRowByName(name);
}

async function getDefaultProjectCatalogRow() {
  await syncProjectCatalogCache();
  const [rows] = await getPool().query(
    `SELECT id, name, status, shotflow_applicable, shotflow_category_id, created_at, updated_at
     FROM canvas_projects
     ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, created_at ASC, id ASC
     LIMIT 1`,
    [DEFAULT_PROJECT_NAME]
  );
  return projectRowFromLocal(rows[0] || null);
}

async function createProjectInCatalog(name, status = 'not_started') {
  if (!isExternalProjectCatalogEnabled()) {
    const projectName = normalizeProjectName(name, 160);
    const [result] = await getPool().query('INSERT INTO canvas_projects (name, status, shotflow_applicable) VALUES (?, ?, 1)', [
      projectName,
      status,
    ]);
    return getLocalProjectRowById(result.insertId);
  }

  await bootstrapSharedProjectCatalog({ requireSuccess: true });
  const externalProject = await createExternalProject(name, status);
  await mirrorProjectsToLocal([externalProject], { prune: false });
  lastSyncAt = Date.now();
  return getLocalProjectRowById(externalProject.id);
}

async function updateProjectInCatalog(projectId, patch = {}) {
  if (!isExternalProjectCatalogEnabled()) {
    const numericId = Number(projectId);
    if (!Number.isFinite(numericId) || numericId <= 0) return null;
    const updates = [];
    const params = [];

    if (patch.name !== undefined) {
      const projectName = normalizeProjectName(patch.name, 160);
      if (!projectName) throw new Error('project name is required');
      updates.push('name = ?');
      params.push(projectName);
    }

    if (patch.status !== undefined) {
      updates.push('status = ?');
      params.push(String(patch.status || 'not_started'));
    }

    if (!updates.length) return getLocalProjectRowById(numericId);

    params.push(numericId);
    await getPool().query(`UPDATE canvas_projects SET ${updates.join(', ')} WHERE id = ?`, params);
    return getLocalProjectRowById(numericId);
  }

  await bootstrapSharedProjectCatalog({ requireSuccess: true });
  const externalProject = await updateExternalProject(projectId, patch);
  if (!externalProject) return null;
  await mirrorProjectsToLocal([externalProject], { prune: false });
  lastSyncAt = Date.now();
  return getLocalProjectRowById(externalProject.id);
}

module.exports = {
  DEFAULT_PROJECT_NAME,
  bootstrapSharedProjectCatalog,
  createProjectInCatalog,
  findProjectCatalogRowByName,
  getDefaultProjectCatalogRow,
  getProjectCatalogRowById,
  isExternalProjectCatalogEnabled,
  listProjectCatalogRows,
  listShotflowCategoryRows,
  syncProjectCatalogCache,
  updateProjectInCatalog,
};
