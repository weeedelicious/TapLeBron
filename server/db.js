const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const config = require('./config');

let adminPool;
let contentPool;
let usagePool;
let errorPool;

const INITIAL_CANVAS_PROJECTS = [
  { name: '火炬_SS13英雄', status: 'not_started' },
  { name: '火炬_SS14英雄', status: 'not_started' },
  { name: '火炬_SS13赛季', status: 'not_started' },
  { name: '火炬_SS14赛季', status: 'not_started' },
  { name: '小镇_泡面番', status: 'not_started' },
  { name: '香肠_AI漫剧', status: 'not_started' },
  { name: '测试', status: 'not_started' }
];

function poolOptions(settings) {
  return {
    ...settings,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+08:00'
  };
}

function sameDatabaseConfig(left, right) {
  return (
    String(left?.host || '') === String(right?.host || '') &&
    Number(left?.port || 0) === Number(right?.port || 0) &&
    String(left?.user || '') === String(right?.user || '') &&
    String(left?.database || '') === String(right?.database || '')
  );
}

function getAdminPool() {
  if (!adminPool) {
    adminPool = mysql.createPool(poolOptions(config.db.admin));
  }
  return adminPool;
}

function getContentPool() {
  if (sameDatabaseConfig(config.db.admin, config.db.content)) {
    return getAdminPool();
  }
  if (!contentPool) {
    contentPool = mysql.createPool(poolOptions(config.db.content));
  }
  return contentPool;
}

function getUsagePool() {
  if (sameDatabaseConfig(config.db.admin, config.db.usage)) {
    return getAdminPool();
  }
  if (sameDatabaseConfig(config.db.content, config.db.usage)) {
    return getContentPool();
  }
  if (!usagePool) {
    usagePool = mysql.createPool(poolOptions(config.db.usage));
  }
  return usagePool;
}

function getErrorPool() {
  if (sameDatabaseConfig(config.db.admin, config.db.errors)) {
    return getAdminPool();
  }
  if (sameDatabaseConfig(config.db.content, config.db.errors)) {
    return getContentPool();
  }
  if (sameDatabaseConfig(config.db.usage, config.db.errors)) {
    return getUsagePool();
  }
  if (!errorPool) {
    errorPool = mysql.createPool(poolOptions(config.db.errors));
  }
  return errorPool;
}

function getPool() {
  return getAdminPool();
}

function isSeparateContentDatabase() {
  return !sameDatabaseConfig(config.db.admin, config.db.content);
}

async function closePools() {
  const pools = new Set([adminPool, contentPool, usagePool, errorPool].filter(Boolean));
  for (const pool of pools) {
    await pool.end();
  }
  adminPool = null;
  contentPool = null;
  usagePool = null;
  errorPool = null;
}

function starterCanvas() {
  return {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'input-1',
        type: 'workflow',
        position: { x: 120, y: 140 },
        data: {
          kind: 'input',
          label: 'Input',
          description: 'Brand, product, goal'
        }
      },
      {
        id: 'prompt-1',
        type: 'workflow',
        position: { x: 420, y: 140 },
        data: {
          kind: 'prompt',
          label: 'Prompt',
          description: 'Style, camera, framing'
        }
      },
      {
        id: 'output-1',
        type: 'workflow',
        position: { x: 720, y: 140 },
        data: {
          kind: 'output',
          label: 'Output',
          description: 'Image, video, script, or assets'
        }
      }
    ],
    edges: [
      { id: 'edge-input-prompt', source: 'input-1', target: 'prompt-1', animated: true },
      { id: 'edge-prompt-output', source: 'prompt-1', target: 'output-1', animated: true }
    ]
  };
}

function parseJsonDocument(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  if (typeof value === 'object') return value;
  return fallback;
}

function sha1String(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function summarizeCanvasNodeList(data) {
  if (Array.isArray(data?.nodeList)) return data.nodeList;
  if (Array.isArray(data?.nodes)) return data.nodes;
  return [];
}

function parseCanvasNodeData(node) {
  const value = node?.data;
  if (typeof value === 'string') return parseJsonDocument(value, {});
  if (value && typeof value === 'object') return value;
  return {};
}

function firstCanvasMediaUrl(nodeList) {
  for (const node of nodeList) {
    const data = parseCanvasNodeData(node);
    const type = String(data.type || data.kind || '').toLowerCase();
    const urls = Array.isArray(data.url) ? data.url : [];
    const primaryUrl = urls.find((url) => String(url || '').trim());
    if (primaryUrl && ['image', 'upload', 'video'].includes(type)) {
      return String(primaryUrl).trim();
    }
  }
  return '';
}

function summarizeCanvasData(data) {
  const parsedData = parseJsonDocument(data, {});
  const nodeList = summarizeCanvasNodeList(parsedData);
  const customCoverUrl = String(parsedData?.customCoverUrl || '').trim();
  const derivedCoverUrl = firstCanvasMediaUrl(nodeList);
  const legacyCoverUrl = String(parsedData?.coverUrl || '').trim();
  return {
    coverUrl: customCoverUrl || derivedCoverUrl || legacyCoverUrl || null,
    nodeCount: nodeList.length
  };
}

async function ensureDatabaseAccessible(settings) {
  const probe = mysql.createPool({
    ...settings,
    waitForConnections: true,
    connectionLimit: 1,
    queueLimit: 0,
    timezone: '+08:00'
  });
  try {
    await probe.query('SELECT 1');
    await probe.end();
  } catch (error) {
    await probe.end().catch(() => null);
    if (error?.code !== 'ER_BAD_DB_ERROR') throw error;
    const connection = await mysql.createConnection({
      host: settings.host,
      port: settings.port,
      user: settings.user,
      password: settings.password,
      charset: settings.charset || 'utf8mb4'
    });
    try {
      const dbName = String(settings.database).replace(/`/g, '``');
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    } finally {
      await connection.end();
    }
  }
}

async function migrateAdminSchema() {
  const db = getAdminPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(80) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NULL,
      role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP NULL DEFAULT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query('ALTER TABLE users MODIFY password_hash VARCHAR(255) NULL');

  const [lastUsedColumns] = await db.query("SHOW COLUMNS FROM users LIKE 'last_used_at'");
  if (lastUsedColumns.length === 0) {
    await db.query('ALTER TABLE users ADD COLUMN last_used_at TIMESTAMP NULL DEFAULT NULL AFTER updated_at');
  }

  const [externalUserColumns] = await db.query("SHOW COLUMNS FROM users LIKE 'external_user_id'");
  if (externalUserColumns.length === 0) {
    await db.query('ALTER TABLE users ADD COLUMN external_user_id BIGINT UNSIGNED NULL AFTER id');
  }

  const [externalUserIndexes] = await db.query("SHOW INDEX FROM users WHERE Key_name = 'uk_users_external_user_id'");
  if (externalUserIndexes.length === 0) {
    await db.query('ALTER TABLE users ADD UNIQUE KEY uk_users_external_user_id (external_user_id)');
  }

  // 本地模式下注册账号自带的网关 API Key。sd2 共享目录走 sd2_users.api_key，不写这列。
  const [llmApiKeyColumns] = await db.query("SHOW COLUMNS FROM users LIKE 'llm_api_key'");
  if (llmApiKeyColumns.length === 0) {
    await db.query('ALTER TABLE users ADD COLUMN llm_api_key VARCHAR(512) NULL AFTER password_hash');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS plugin_api_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(80) NOT NULL,
      token_prefix VARCHAR(24) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      scopes JSON NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      expires_at TIMESTAMP NULL DEFAULT NULL,
      last_used_at TIMESTAMP NULL DEFAULT NULL,
      revoked_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_plugin_api_tokens_hash (token_hash),
      INDEX idx_plugin_api_tokens_user_active (user_id, active, created_at),
      CONSTRAINT fk_plugin_api_tokens_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS api_key_change_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      key_name VARCHAR(64) NOT NULL DEFAULT 'LLM_API_KEY',
      changed_by BIGINT UNSIGNED NULL,
      changed_by_name VARCHAR(80) NOT NULL DEFAULT '',
      old_key_mask VARCHAR(80) NOT NULL DEFAULT '',
      new_key_mask VARCHAR(80) NOT NULL DEFAULT '',
      old_key_hash CHAR(64) NOT NULL DEFAULT '',
      new_key_hash CHAR(64) NOT NULL DEFAULT '',
      affected_keys JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_api_key_change_logs_created (created_at),
      INDEX idx_api_key_change_logs_user_created (changed_by, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_collections (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(160) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_canvas_collections_owner_updated (owner_id, updated_at),
      CONSTRAINT fk_canvas_collections_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_projects (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(160) NOT NULL UNIQUE,
      status ENUM('not_started', 'in_progress', 'completed') NOT NULL DEFAULT 'not_started',
      shotflow_applicable TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_canvas_projects_status_updated (status, updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  const [shotflowApplicableColumns] = await db.query("SHOW COLUMNS FROM canvas_projects LIKE 'shotflow_applicable'");
  if (shotflowApplicableColumns.length === 0) {
    await db.query('ALTER TABLE canvas_projects ADD COLUMN shotflow_applicable TINYINT(1) NOT NULL DEFAULT 1 AFTER status');
  }

  // 项目属于哪个 shotflow 画布分类。值来自 sd2 项目管理页（sd2_projects.shotflow_category_id），
  // 由 projectCatalog 的目录同步镜像过来；分类块里"新建画布"的项目下拉靠它过滤。
  const [projectCategoryColumns] = await db.query("SHOW COLUMNS FROM canvas_projects LIKE 'shotflow_category_id'");
  if (projectCategoryColumns.length === 0) {
    await db.query('ALTER TABLE canvas_projects ADD COLUMN shotflow_category_id INT NULL AFTER shotflow_applicable');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvases (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_id BIGINT UNSIGNED NOT NULL,
      collection_id BIGINT UNSIGNED NULL,
      project_id BIGINT UNSIGNED NULL,
      title VARCHAR(160) NOT NULL,
      data JSON NOT NULL,
      cover_url MEDIUMTEXT NULL,
      node_count INT UNSIGNED NOT NULL DEFAULT 0,
      summary_updated_at TIMESTAMP NULL DEFAULT NULL,
      shared TINYINT(1) NOT NULL DEFAULT 0,
      canvas_role VARCHAR(24) NOT NULL DEFAULT 'normal',
      template_source_canvas_id BIGINT UNSIGNED NULL,
      template_source_owner_id BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_canvases_project_updated (project_id, updated_at),
      INDEX idx_canvases_collection_updated (collection_id, updated_at),
      INDEX idx_canvases_owner_updated (owner_id, updated_at),
      INDEX idx_canvases_shared_updated (shared, updated_at),
      INDEX idx_canvases_role_updated (canvas_role, updated_at),
      INDEX idx_canvases_owner_role_created (owner_id, canvas_role, created_at),
      CONSTRAINT fk_canvases_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  const [sharedColumns] = await db.query("SHOW COLUMNS FROM canvases LIKE 'shared'");
  if (sharedColumns.length === 0) {
    await db.query('ALTER TABLE canvases ADD COLUMN shared TINYINT(1) NOT NULL DEFAULT 0 AFTER data');
  }

  const [coverUrlColumns] = await db.query("SHOW COLUMNS FROM canvases LIKE 'cover_url'");
  if (coverUrlColumns.length === 0) {
    await db.query('ALTER TABLE canvases ADD COLUMN cover_url MEDIUMTEXT NULL AFTER data');
  }

  const [nodeCountColumns] = await db.query("SHOW COLUMNS FROM canvases LIKE 'node_count'");
  if (nodeCountColumns.length === 0) {
    await db.query('ALTER TABLE canvases ADD COLUMN node_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER cover_url');
  }

  const [summaryUpdatedColumns] = await db.query("SHOW COLUMNS FROM canvases LIKE 'summary_updated_at'");
  if (summaryUpdatedColumns.length === 0) {
    await db.query('ALTER TABLE canvases ADD COLUMN summary_updated_at TIMESTAMP NULL DEFAULT NULL AFTER node_count');
  }

  const [canvasRoleColumns] = await db.query("SHOW COLUMNS FROM canvases LIKE 'canvas_role'");
  if (canvasRoleColumns.length === 0) {
    await db.query("ALTER TABLE canvases ADD COLUMN canvas_role VARCHAR(24) NOT NULL DEFAULT 'normal' AFTER shared");
  }

  const [templateSourceCanvasColumns] = await db.query("SHOW COLUMNS FROM canvases LIKE 'template_source_canvas_id'");
  if (templateSourceCanvasColumns.length === 0) {
    await db.query('ALTER TABLE canvases ADD COLUMN template_source_canvas_id BIGINT UNSIGNED NULL AFTER canvas_role');
  }

  const [templateSourceOwnerColumns] = await db.query("SHOW COLUMNS FROM canvases LIKE 'template_source_owner_id'");
  if (templateSourceOwnerColumns.length === 0) {
    await db.query('ALTER TABLE canvases ADD COLUMN template_source_owner_id BIGINT UNSIGNED NULL AFTER template_source_canvas_id');
  }

  const [collectionColumns] = await db.query("SHOW COLUMNS FROM canvases LIKE 'collection_id'");
  if (collectionColumns.length === 0) {
    await db.query('ALTER TABLE canvases ADD COLUMN collection_id BIGINT UNSIGNED NULL AFTER owner_id');
  }

  // 分类顺序跟着 sd2 项目管理页那份 shotflow 画布分类走（测试在最上面），
  // 所以要一个显式的排序列，不能再按 created_at 排。
  const [collectionSortColumns] = await db.query("SHOW COLUMNS FROM canvas_collections LIKE 'sort_order'");
  if (collectionSortColumns.length === 0) {
    await db.query('ALTER TABLE canvas_collections ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER name');
  }

  const [projectColumns] = await db.query("SHOW COLUMNS FROM canvases LIKE 'project_id'");
  if (projectColumns.length === 0) {
    await db.query('ALTER TABLE canvases ADD COLUMN project_id BIGINT UNSIGNED NULL AFTER collection_id');
  }

  const [collectionIndexes] = await db.query(
    "SHOW INDEX FROM canvases WHERE Key_name = 'idx_canvases_collection_updated'"
  );
  if (collectionIndexes.length === 0) {
    await db.query('ALTER TABLE canvases ADD INDEX idx_canvases_collection_updated (collection_id, updated_at)');
  }

  const [projectIndexes] = await db.query(
    "SHOW INDEX FROM canvases WHERE Key_name = 'idx_canvases_project_updated'"
  );
  if (projectIndexes.length === 0) {
    await db.query('ALTER TABLE canvases ADD INDEX idx_canvases_project_updated (project_id, updated_at)');
  }

  const [collectionForeignKeys] = await db.query(`
    SELECT CONSTRAINT_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'canvases'
      AND COLUMN_NAME = 'collection_id'
      AND REFERENCED_TABLE_NAME = 'canvas_collections'
  `);
  if (collectionForeignKeys.length === 0) {
    await db.query(`
      ALTER TABLE canvases
      ADD CONSTRAINT fk_canvases_collection
      FOREIGN KEY (collection_id) REFERENCES canvas_collections(id)
      ON DELETE SET NULL
    `);
  }

  const [projectForeignKeys] = await db.query(`
    SELECT CONSTRAINT_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'canvases'
      AND COLUMN_NAME = 'project_id'
      AND REFERENCED_TABLE_NAME = 'canvas_projects'
  `);
  if (projectForeignKeys.length === 0) {
    await db.query(`
      ALTER TABLE canvases
      ADD CONSTRAINT fk_canvases_project
      FOREIGN KEY (project_id) REFERENCES canvas_projects(id)
      ON DELETE SET NULL
    `);
  }

  // AI 出片（Studio）的项目库。分镜表的真源在 storyboard 列；canvas_id 指向自动建的
  // ai_xxxxxx 画布（ON DELETE SET NULL：画布被删掉项目还留着，能重新补一个画布）。
  await db.query(`
    CREATE TABLE IF NOT EXISTS studio_projects (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_id BIGINT UNSIGNED NOT NULL,
      canvas_id BIGINT UNSIGNED NULL,
      name VARCHAR(160) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      brief JSON NULL,
      storyboard JSON NULL,
      storyboard_node_key VARCHAR(64) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_studio_projects_owner_updated (owner_id, updated_at),
      INDEX idx_studio_projects_canvas (canvas_id),
      CONSTRAINT fk_studio_projects_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_studio_projects_canvas
        FOREIGN KEY (canvas_id) REFERENCES canvases(id)
        ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // Cindy 画布对话的用户附图。存的是本画布资产地址数组（/assets/<canvasId>/<file>），
  // 不存 base64 —— 发给模型时才现场读图、缩到 1024 再转 base64，库里只留引用。
  const [cindyImageColumns] = await db.query("SHOW COLUMNS FROM cindy_canvas_messages LIKE 'images'");
  if (cindyImageColumns.length === 0) {
    await db.query('ALTER TABLE cindy_canvas_messages ADD COLUMN images JSON NULL AFTER content');
  }

  // 概念图（第二阶段）。清单是 {items:[{id,group,name,prompt,reason,imageUrl,nodeKey,status,error}]}，
  // 跟 storyboard 一样是这张表里的真源，画布里的图片节点只是投影。
  // 加列而不是新建表：概念图跟项目是 1:1 的一份清单，没有独立查询需求，跟 storyboard 同构最省事。
  const [studioConceptColumns] = await db.query("SHOW COLUMNS FROM studio_projects LIKE 'concepts'");
  if (studioConceptColumns.length === 0) {
    await db.query('ALTER TABLE studio_projects ADD COLUMN concepts JSON NULL AFTER storyboard_node_key');
  }

  // 分镜绘制（第三阶段）。跟 concepts 同构：
  // {settings:{styles,method,model,count,resolution}, items:[{id,shot,kind,prompt,imageUrl,nodeKey,status,error}]}
  // kind = main（主要画面）/ start（首帧）/ end（尾帧），对应文档「主要画面 | 镜头的开始和结束」。
  // 一样是加列不是新建表：跟项目 1:1，没有独立查询需求。
  const [studioBoardColumns] = await db.query("SHOW COLUMNS FROM studio_projects LIKE 'boards'");
  if (studioBoardColumns.length === 0) {
    await db.query('ALTER TABLE studio_projects ADD COLUMN boards JSON NULL AFTER concepts');
  }

  // 动态分镜（第四阶段）与成片（第五阶段）。两个阶段形状一样（都是按镜生成视频、
  // 可选数量/分辨率/时长），所以分成两列而不是一列加个 stage 字段 ——
  // 文档把它们当两件事，用户也会想同时留着动态分镜和成片两份结果做对比。
  for (const column of ['motion', 'film']) {
    const [existing] = await db.query(`SHOW COLUMNS FROM studio_projects LIKE '${column}'`);
    if (existing.length === 0) {
      await db.query(`ALTER TABLE studio_projects ADD COLUMN ${column} JSON NULL`);
    }
  }

  const [sharedIndexes] = await db.query("SHOW INDEX FROM canvases WHERE Key_name = 'idx_canvases_shared_updated'");
  if (sharedIndexes.length === 0) {
    await db.query('ALTER TABLE canvases ADD INDEX idx_canvases_shared_updated (shared, updated_at)');
  }

  const [roleIndexes] = await db.query("SHOW INDEX FROM canvases WHERE Key_name = 'idx_canvases_role_updated'");
  if (roleIndexes.length === 0) {
    await db.query('ALTER TABLE canvases ADD INDEX idx_canvases_role_updated (canvas_role, updated_at)');
  }

  const [ownerRoleIndexes] = await db.query("SHOW INDEX FROM canvases WHERE Key_name = 'idx_canvases_owner_role_created'");
  if (ownerRoleIndexes.length === 0) {
    await db.query('ALTER TABLE canvases ADD INDEX idx_canvases_owner_role_created (owner_id, canvas_role, created_at)');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_user_shares (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      canvas_id BIGINT UNSIGNED NOT NULL,
      owner_id BIGINT UNSIGNED NOT NULL,
      target_user_id BIGINT UNSIGNED NOT NULL,
      shared_by_user_id BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_canvas_user_shares_canvas_target (canvas_id, target_user_id),
      INDEX idx_canvas_user_shares_target_updated (target_user_id, updated_at),
      INDEX idx_canvas_user_shares_owner_updated (owner_id, updated_at),
      CONSTRAINT fk_canvas_user_shares_canvas
        FOREIGN KEY (canvas_id) REFERENCES canvases(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_canvas_user_shares_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_canvas_user_shares_target
        FOREIGN KEY (target_user_id) REFERENCES users(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_canvas_user_shares_shared_by
        FOREIGN KEY (shared_by_user_id) REFERENCES users(id)
        ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS cindy_canvas_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      canvas_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      role VARCHAR(16) NOT NULL,
      content MEDIUMTEXT NOT NULL,
      proposal_json JSON NULL,
      proposal_status VARCHAR(16) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_cindy_messages_canvas_user_id (canvas_id, user_id, id),
      INDEX idx_cindy_messages_user_created (user_id, created_at),
      CONSTRAINT fk_cindy_messages_canvas
        FOREIGN KEY (canvas_id) REFERENCES canvases(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_cindy_messages_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      canvas_id BIGINT UNSIGNED NOT NULL,
      owner_id BIGINT UNSIGNED NOT NULL,
      kind VARCHAR(16) NOT NULL DEFAULT 'file',
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      relative_path VARCHAR(512) NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT '',
      byte_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
      sha1 VARCHAR(128) NOT NULL,
      source_type VARCHAR(32) NOT NULL DEFAULT 'upload',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_canvas_assets_canvas_stored (canvas_id, stored_name),
      INDEX idx_canvas_assets_canvas_created (canvas_id, created_at),
      INDEX idx_canvas_assets_owner_created (owner_id, created_at),
      CONSTRAINT fk_canvas_assets_canvas
        FOREIGN KEY (canvas_id) REFERENCES canvases(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_canvas_assets_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_revisions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      canvas_id BIGINT UNSIGNED NOT NULL,
      owner_id BIGINT UNSIGNED NOT NULL,
      revision_hash CHAR(40) NOT NULL,
      revision_reason VARCHAR(32) NOT NULL DEFAULT 'autosave',
      snapshot JSON NOT NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_canvas_revisions_canvas_created (canvas_id, created_at),
      UNIQUE KEY uk_canvas_revisions_canvas_hash_created (canvas_id, revision_hash, created_at),
      CONSTRAINT fk_canvas_revisions_canvas
        FOREIGN KEY (canvas_id) REFERENCES canvases(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_canvas_revisions_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_favorites (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_id BIGINT UNSIGNED NOT NULL,
      source_project_uuid VARCHAR(64) NULL,
      source_root_key VARCHAR(255) NULL,
      item_type ENUM('node', 'group', 'image', 'video') NOT NULL DEFAULT 'node',
      title VARCHAR(180) NOT NULL,
      description VARCHAR(500) NULL,
      preview_url MEDIUMTEXT NULL,
      node_count INT UNSIGNED NOT NULL DEFAULT 1,
      shared TINYINT(1) NOT NULL DEFAULT 0,
      tags JSON NULL,
      payload JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_canvas_favorites_owner_updated (owner_id, updated_at),
      INDEX idx_canvas_favorites_source (owner_id, source_project_uuid, source_root_key),
      INDEX idx_canvas_favorites_shared_updated (shared, updated_at),
      INDEX idx_canvas_favorites_type_updated (item_type, updated_at),
      CONSTRAINT fk_canvas_favorites_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  const [favoriteSourceProjectColumns] = await db.query("SHOW COLUMNS FROM canvas_favorites LIKE 'source_project_uuid'");
  if (favoriteSourceProjectColumns.length === 0) {
    await db.query('ALTER TABLE canvas_favorites ADD COLUMN source_project_uuid VARCHAR(64) NULL AFTER owner_id');
  }

  const [favoriteSourceRootColumns] = await db.query("SHOW COLUMNS FROM canvas_favorites LIKE 'source_root_key'");
  if (favoriteSourceRootColumns.length === 0) {
    await db.query('ALTER TABLE canvas_favorites ADD COLUMN source_root_key VARCHAR(255) NULL AFTER source_project_uuid');
  }

  const [favoritePreviewUrlColumns] = await db.query("SHOW COLUMNS FROM canvas_favorites LIKE 'preview_url'");
  if (
    favoritePreviewUrlColumns.length > 0 &&
    !/text/i.test(String(favoritePreviewUrlColumns[0].Type || ''))
  ) {
    await db.query('ALTER TABLE canvas_favorites MODIFY COLUMN preview_url MEDIUMTEXT NULL');
  }

  const [favoriteSourceIndexes] = await db.query(
    "SHOW INDEX FROM canvas_favorites WHERE Key_name = 'idx_canvas_favorites_source'"
  );
  if (favoriteSourceIndexes.length === 0) {
    await db.query('ALTER TABLE canvas_favorites ADD INDEX idx_canvas_favorites_source (owner_id, source_project_uuid, source_root_key)');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_shared_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_id BIGINT UNSIGNED NOT NULL,
      source_project_uuid VARCHAR(64) NULL,
      source_root_key VARCHAR(255) NULL,
      item_type ENUM('node', 'group', 'image', 'video') NOT NULL DEFAULT 'node',
      title VARCHAR(180) NOT NULL,
      description VARCHAR(500) NULL,
      preview_url MEDIUMTEXT NULL,
      node_count INT UNSIGNED NOT NULL DEFAULT 1,
      tags JSON NULL,
      payload JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_canvas_shared_assets_owner_updated (owner_id, updated_at),
      INDEX idx_canvas_shared_assets_source (owner_id, source_project_uuid, source_root_key),
      INDEX idx_canvas_shared_assets_type_updated (item_type, updated_at),
      CONSTRAINT fk_canvas_shared_assets_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  const [sharedAssetPreviewUrlColumns] = await db.query("SHOW COLUMNS FROM canvas_shared_assets LIKE 'preview_url'");
  if (
    sharedAssetPreviewUrlColumns.length > 0 &&
    !/text/i.test(String(sharedAssetPreviewUrlColumns[0].Type || ''))
  ) {
    await db.query('ALTER TABLE canvas_shared_assets MODIFY COLUMN preview_url MEDIUMTEXT NULL');
  }

  await db.query(`
    INSERT INTO canvas_shared_assets
      (owner_id, source_project_uuid, source_root_key, item_type, title, description, preview_url, node_count, tags, payload, created_at, updated_at)
    SELECT
      f.owner_id,
      f.source_project_uuid,
      f.source_root_key,
      f.item_type,
      f.title,
      f.description,
      f.preview_url,
      f.node_count,
      f.tags,
      f.payload,
      f.created_at,
      f.updated_at
    FROM canvas_favorites f
    WHERE f.shared = 1
      AND NOT EXISTS (
        SELECT 1
        FROM canvas_shared_assets s
        WHERE s.owner_id = f.owner_id
          AND IFNULL(s.source_project_uuid, '') = IFNULL(f.source_project_uuid, '')
          AND IFNULL(s.source_root_key, '') = IFNULL(f.source_root_key, '')
      )
  `);
}

async function migrateContentSchema() {
  const db = getContentPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_content (
      canvas_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      owner_id BIGINT UNSIGNED NOT NULL,
      data JSON NOT NULL,
      data_hash CHAR(40) NOT NULL,
      schema_version INT UNSIGNED NOT NULL DEFAULT 1,
      updated_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_canvas_content_owner_updated (owner_id, updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  const [updatedByColumns] = await db.query("SHOW COLUMNS FROM canvas_content LIKE 'updated_by'");
  if (updatedByColumns.length === 0) {
    await db.query('ALTER TABLE canvas_content ADD COLUMN updated_by BIGINT UNSIGNED NULL AFTER schema_version');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_assets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      canvas_id BIGINT UNSIGNED NOT NULL,
      owner_id BIGINT UNSIGNED NOT NULL,
      kind VARCHAR(16) NOT NULL DEFAULT 'file',
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      relative_path VARCHAR(512) NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT '',
      byte_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
      sha1 VARCHAR(128) NOT NULL,
      source_type VARCHAR(32) NOT NULL DEFAULT 'upload',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_canvas_assets_canvas_stored (canvas_id, stored_name),
      INDEX idx_canvas_assets_canvas_created (canvas_id, created_at),
      INDEX idx_canvas_assets_owner_created (owner_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_revisions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      canvas_id BIGINT UNSIGNED NOT NULL,
      owner_id BIGINT UNSIGNED NOT NULL,
      revision_hash CHAR(40) NOT NULL,
      revision_reason VARCHAR(32) NOT NULL DEFAULT 'autosave',
      snapshot JSON NOT NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_canvas_revisions_canvas_created (canvas_id, created_at),
      UNIQUE KEY uk_canvas_revisions_canvas_hash_created (canvas_id, revision_hash, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_node_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      canvas_id BIGINT UNSIGNED NOT NULL,
      node_key VARCHAR(255) NOT NULL,
      node_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
      event_type ENUM('upsert', 'delete') NOT NULL,
      node_snapshot JSON NULL,
      client_id VARCHAR(120) NOT NULL DEFAULT '',
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_canvas_node_events_canvas_id (canvas_id, id),
      INDEX idx_canvas_node_events_canvas_node (canvas_id, node_key, id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_access_sessions (
      canvas_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      session_epoch BIGINT UNSIGNED NOT NULL DEFAULT 1,
      token_hash CHAR(64) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      client_id VARCHAR(120) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_canvas_access_sessions_user_seen (user_id, last_seen_at),
      INDEX idx_canvas_access_sessions_token (canvas_id, token_hash)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_access_session_history (
      canvas_id BIGINT UNSIGNED NOT NULL,
      session_epoch BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      client_id VARCHAR(120) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (canvas_id, session_epoch),
      INDEX idx_canvas_access_history_user_created (user_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvas_history_hidden_assets (
      canvas_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      asset_url_hash CHAR(64) NOT NULL,
      asset_url MEDIUMTEXT NOT NULL,
      hidden_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (canvas_id, user_id, asset_url_hash),
      INDEX idx_canvas_history_hidden_user (user_id, hidden_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

async function migrateUsageSchema() {
  const db = getUsagePool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS paid_usage_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NULL,
      username VARCHAR(80) NOT NULL,
      user_role VARCHAR(32) NOT NULL DEFAULT '',
      canvas_id BIGINT UNSIGNED NULL,
      project_uuid VARCHAR(64) NULL,
      canvas_title VARCHAR(180) NULL,
      node_key VARCHAR(255) NULL,
      operation_type ENUM('image', 'video', 'text') NOT NULL,
      endpoint VARCHAR(120) NOT NULL,
      provider VARCHAR(64) NULL,
      model VARCHAR(160) NOT NULL,
      mode VARCHAR(80) NULL,
      status ENUM('submitted', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'submitted',
      quantity INT UNSIGNED NOT NULL DEFAULT 1,
      prompt_chars INT UNSIGNED NOT NULL DEFAULT 0,
      prompt_preview TEXT NULL,
      input_counts JSON NULL,
      settings JSON NULL,
      provider_job_ids JSON NULL,
      result_count INT UNSIGNED NOT NULL DEFAULT 0,
      error_message TEXT NULL,
      request_hash CHAR(64) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_paid_usage_created (created_at),
      INDEX idx_paid_usage_user_created (user_id, created_at),
      INDEX idx_paid_usage_type_model_created (operation_type, model, created_at),
      INDEX idx_paid_usage_status_created (status, created_at),
      INDEX idx_paid_usage_project_created (project_uuid, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS video_task_details (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      usage_log_id BIGINT UNSIGNED NULL,
      user_id BIGINT UNSIGNED NULL,
      username VARCHAR(80) NOT NULL,
      canvas_id BIGINT UNSIGNED NULL,
      project_uuid VARCHAR(64) NULL,
      canvas_title VARCHAR(180) NULL,
      node_key VARCHAR(255) NULL,
      internal_job_id VARCHAR(80) NOT NULL,
      provider VARCHAR(64) NULL,
      model VARCHAR(160) NOT NULL,
      mode VARCHAR(80) NULL,
      ratio VARCHAR(24) NULL,
      resolution VARCHAR(24) NULL,
      duration_sec DECIMAL(10, 2) NOT NULL DEFAULT 0,
      quantity INT UNSIGNED NOT NULL DEFAULT 1,
      status ENUM('submitted', 'running', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'submitted',
      prompt_preview TEXT NULL,
      submission_params JSON NULL,
      reference_materials JSON NULL,
      provider_job_ids JSON NULL,
      provider_status JSON NULL,
      result_urls JSON NULL,
      error_message TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_video_task_usage (usage_log_id),
      INDEX idx_video_task_internal_job (internal_job_id),
      INDEX idx_video_task_user_created (user_id, created_at),
      INDEX idx_video_task_canvas_created (canvas_id, created_at),
      INDEX idx_video_task_status_created (status, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS generation_tasks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      job_id VARCHAR(80) NOT NULL,
      user_id BIGINT UNSIGNED NULL,
      username VARCHAR(80) NOT NULL DEFAULT 'unknown',
      user_role VARCHAR(32) NOT NULL DEFAULT '',
      canvas_id BIGINT UNSIGNED NULL,
      project_uuid VARCHAR(64) NULL,
      canvas_title VARCHAR(180) NULL,
      node_key VARCHAR(255) NULL,
      task_type ENUM('image', 'video', 'text') NOT NULL,
      endpoint VARCHAR(120) NOT NULL,
      provider VARCHAR(64) NULL,
      model VARCHAR(160) NOT NULL,
      mode VARCHAR(80) NULL,
      ratio VARCHAR(24) NULL,
      resolution VARCHAR(24) NULL,
      duration_sec DECIMAL(10, 2) NOT NULL DEFAULT 0,
      quantity INT UNSIGNED NOT NULL DEFAULT 1,
      reference_materials JSON NULL,
      request_params JSON NULL,
      provider_job_ids JSON NULL,
      provider_status JSON NULL,
      status ENUM('submitted', 'running', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'submitted',
      progress_percent INT UNSIGNED NOT NULL DEFAULT 0,
      error_message TEXT NULL,
      result_urls JSON NULL,
      usage_log_id BIGINT UNSIGNED NULL,
      video_task_detail_id BIGINT UNSIGNED NULL,
      request_hash CHAR(64) NULL,
      submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_polling_at TIMESTAMP NULL DEFAULT NULL,
      completed_at TIMESTAMP NULL DEFAULT NULL,
      next_poll_at TIMESTAMP NULL DEFAULT NULL,
      locked_at TIMESTAMP NULL DEFAULT NULL,
      locked_by VARCHAR(120) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_generation_tasks_job_id (job_id),
      INDEX idx_generation_tasks_user_created (user_id, created_at),
      INDEX idx_generation_tasks_canvas_created (canvas_id, created_at),
      INDEX idx_generation_tasks_node_created (node_key, created_at),
      INDEX idx_generation_tasks_status_next_poll (status, next_poll_at),
      INDEX idx_generation_tasks_type_model_created (task_type, model, created_at),
      INDEX idx_generation_tasks_usage (usage_log_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  const generationTaskColumns = [
    {
      name: 'generation_version',
      sql: 'ALTER TABLE generation_tasks ADD COLUMN generation_version BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER request_hash'
    },
    {
      name: 'apply_status',
      sql: "ALTER TABLE generation_tasks ADD COLUMN apply_status ENUM('legacy', 'pending', 'applied', 'superseded', 'orphaned') NOT NULL DEFAULT 'legacy' AFTER generation_version"
    },
    {
      name: 'superseded_by_job_id',
      sql: 'ALTER TABLE generation_tasks ADD COLUMN superseded_by_job_id VARCHAR(80) NULL AFTER apply_status'
    },
    {
      name: 'applied_at',
      sql: 'ALTER TABLE generation_tasks ADD COLUMN applied_at TIMESTAMP NULL DEFAULT NULL AFTER superseded_by_job_id'
    },
    {
      // 并发生成：同一节点可以同时挂多个任务，谁完成谁追加，互不取代。
      // 只有显式声明 concurrent 的任务才免于「新任务把旧任务标成 superseded」那条规则，
      // 图片 / 文字节点保持原来的单飞语义不变。
      name: 'concurrent',
      sql: 'ALTER TABLE generation_tasks ADD COLUMN concurrent TINYINT(1) NOT NULL DEFAULT 0 AFTER applied_at'
    }
  ];
  for (const column of generationTaskColumns) {
    const [columns] = await db.query(`SHOW COLUMNS FROM generation_tasks LIKE '${column.name}'`);
    if (columns.length === 0) await db.query(column.sql);
  }

  const [generationVersionIndexes] = await db.query(
    "SHOW INDEX FROM generation_tasks WHERE Key_name = 'idx_generation_tasks_node_version'"
  );
  if (generationVersionIndexes.length === 0) {
    await db.query(
      'ALTER TABLE generation_tasks ADD INDEX idx_generation_tasks_node_version (project_uuid, node_key, generation_version)'
    );
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS generation_node_heads (
      project_uuid VARCHAR(64) NOT NULL,
      node_key VARCHAR(255) NOT NULL,
      generation_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
      current_job_id VARCHAR(80) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (project_uuid, node_key),
      INDEX idx_generation_node_heads_job (current_job_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS generation_task_outputs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      job_id VARCHAR(80) NOT NULL,
      output_index INT UNSIGNED NOT NULL,
      asset_url MEDIUMTEXT NOT NULL,
      asset_id BIGINT UNSIGNED NULL,
      mime_type VARCHAR(120) NULL,
      width INT UNSIGNED NULL,
      height INT UNSIGNED NULL,
      duration_sec DECIMAL(10, 2) NULL,
      model VARCHAR(160) NULL,
      resolution VARCHAR(24) NULL,
      is_primary TINYINT(1) NOT NULL DEFAULT 0,
      metadata JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_generation_task_outputs_job_index (job_id, output_index),
      INDEX idx_generation_task_outputs_job (job_id),
      INDEX idx_generation_task_outputs_asset (asset_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS plugin_generation_plans (
      plan_id VARCHAR(96) NOT NULL PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      token_id BIGINT UNSIGNED NULL,
      canvas_id BIGINT UNSIGNED NOT NULL,
      node_key VARCHAR(255) NOT NULL,
      node_type ENUM('text', 'image', 'video') NOT NULL,
      required_scope VARCHAR(80) NOT NULL,
      config_hash CHAR(64) NOT NULL,
      plan_hash CHAR(64) NOT NULL,
      normalized_plan JSON NOT NULL,
      estimate JSON NOT NULL,
      consumed_idempotency_key VARCHAR(160) NULL,
      consumed_job_id VARCHAR(80) NULL,
      consumed_at TIMESTAMP NULL DEFAULT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_plugin_generation_plans_user_created (user_id, created_at),
      INDEX idx_plugin_generation_plans_canvas_node (canvas_id, node_key, created_at),
      INDEX idx_plugin_generation_plans_expiry (expires_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS plugin_idempotency_records (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      canvas_id BIGINT UNSIGNED NOT NULL,
      idempotency_key VARCHAR(160) NOT NULL,
      operation VARCHAR(80) NOT NULL,
      request_hash CHAR(64) NOT NULL,
      status ENUM('reserved', 'running', 'completed', 'failed') NOT NULL DEFAULT 'reserved',
      job_id VARCHAR(80) NULL,
      response_json JSON NULL,
      error_code VARCHAR(160) NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_plugin_idempotency_scope (user_id, canvas_id, idempotency_key),
      INDEX idx_plugin_idempotency_expiry (expires_at),
      INDEX idx_plugin_idempotency_job (job_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

async function migrateErrorSchema() {
  const db = getErrorPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS node_generation_errors (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      source_key VARCHAR(191) NOT NULL,
      source_type ENUM('task', 'http') NOT NULL DEFAULT 'task',
      task_id VARCHAR(80) NULL,
      user_id BIGINT UNSIGNED NULL,
      username VARCHAR(80) NOT NULL DEFAULT 'unknown',
      user_role VARCHAR(32) NOT NULL DEFAULT '',
      canvas_id BIGINT UNSIGNED NULL,
      project_uuid VARCHAR(64) NULL,
      canvas_title VARCHAR(180) NULL,
      node_key VARCHAR(255) NULL,
      node_type VARCHAR(80) NULL,
      node_name VARCHAR(255) NULL,
      operation_type VARCHAR(80) NULL,
      endpoint VARCHAR(160) NULL,
      provider VARCHAR(80) NULL,
      model VARCHAR(160) NULL,
      mode VARCHAR(80) NULL,
      ratio VARCHAR(24) NULL,
      resolution VARCHAR(24) NULL,
      duration_sec DECIMAL(10, 2) NOT NULL DEFAULT 0,
      quantity INT UNSIGNED NOT NULL DEFAULT 1,
      provider_job_ids LONGTEXT NULL,
      http_status INT NULL,
      error_code VARCHAR(160) NULL,
      error_message MEDIUMTEXT NOT NULL,
      request_params MEDIUMTEXT NULL,
      reference_materials MEDIUMTEXT NULL,
      provider_status MEDIUMTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_node_generation_errors_source (source_key),
      INDEX idx_node_generation_errors_created (created_at),
      INDEX idx_node_generation_errors_user_created (user_id, created_at),
      INDEX idx_node_generation_errors_canvas_created (canvas_id, created_at),
      INDEX idx_node_generation_errors_type_created (operation_type, created_at),
      INDEX idx_node_generation_errors_model_created (model, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

async function seedInitialAdmin() {
  const db = getAdminPool();
  const [admins] = await db.query('SELECT id FROM users WHERE username = ? LIMIT 1', [config.initialAdmin.username]);
  if (admins.length > 0) return;
  const passwordHash = await bcrypt.hash(config.initialAdmin.password, 12);
  await db.query('INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, ?, 1)', [
    config.initialAdmin.username,
    passwordHash,
    'admin'
  ]);
}

async function seedInitialCanvasProjects() {
  const db = getAdminPool();
  const [rows] = await db.query('SELECT id, name FROM canvas_projects');
  const existingNames = new Set(rows.map((row) => String(row.name || '').trim()).filter(Boolean));

  for (const project of INITIAL_CANVAS_PROJECTS) {
    if (existingNames.has(project.name)) continue;
    await db.query('INSERT INTO canvas_projects (name, status) VALUES (?, ?)', [project.name, project.status]);
    existingNames.add(project.name);
  }
}

async function assignExistingCanvasesToDefaultProject() {
  const db = getAdminPool();
  const [rows] = await db.query('SELECT id FROM canvas_projects WHERE name = ? LIMIT 1', ['测试']);
  const defaultProjectId = rows[0] ? Number(rows[0].id) : null;
  if (!defaultProjectId) return;
  await db.query('UPDATE canvases SET project_id = ? WHERE project_id IS NULL', [defaultProjectId]);
}

async function backfillCanvasSummaries() {
  const db = getAdminPool();
  const batchSize = 200;
  const maxRows = 10000;
  let processed = 0;

  while (processed < maxRows) {
    const [rows] = await db.query(
      `SELECT id, data
       FROM canvases
       WHERE summary_updated_at IS NULL
       ORDER BY id ASC
       LIMIT ${batchSize}`
    );
    if (rows.length === 0) break;

    let contentMap = new Map();
    try {
      contentMap = await loadCanvasContentMap(rows.map((row) => row.id));
    } catch (error) {
      console.warn('canvas summary backfill could not read canvas_content; falling back to canvases.data:', error.message);
    }

    for (const row of rows) {
      const contentRow = contentMap.get(Number(row.id));
      const summary = summarizeCanvasData(contentRow?.data || row.data);
      await db.query(
        `UPDATE canvases
         SET cover_url = ?, node_count = ?, summary_updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [summary.coverUrl, summary.nodeCount, row.id]
      );
      processed += 1;
    }
  }

  if (processed >= maxRows) {
    console.warn(`canvas summary backfill stopped after ${processed} rows; remaining rows will be processed on a later restart`);
  }
}

async function migrate() {
  await ensureDatabaseAccessible(config.db.admin);
  if (isSeparateContentDatabase()) {
    await ensureDatabaseAccessible(config.db.content);
  }
  if (!sameDatabaseConfig(config.db.admin, config.db.usage) && !sameDatabaseConfig(config.db.content, config.db.usage)) {
    await ensureDatabaseAccessible(config.db.usage);
  }
  if (
    !sameDatabaseConfig(config.db.admin, config.db.errors) &&
    !sameDatabaseConfig(config.db.content, config.db.errors) &&
    !sameDatabaseConfig(config.db.usage, config.db.errors)
  ) {
    await ensureDatabaseAccessible(config.db.errors);
  }
  await migrateAdminSchema();
  await migrateContentSchema();
  await migrateUsageSchema();
  await migrateErrorSchema();
  await backfillCanvasSummaries();
  await seedInitialAdmin();
  await seedInitialCanvasProjects();
  await assignExistingCanvasesToDefaultProject();
}

async function resolveCanvasOwnerId(canvasId, ownerId) {
  if (Number.isFinite(Number(ownerId)) && Number(ownerId) > 0) {
    return Number(ownerId);
  }
  const [rows] = await getAdminPool().query('SELECT owner_id FROM canvases WHERE id = ? LIMIT 1', [canvasId]);
  return rows[0] ? Number(rows[0].owner_id) : null;
}

async function loadCanvasContentMap(canvasIds) {
  const ids = [...new Set(canvasIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await getContentPool().query(
    `SELECT canvas_id, owner_id, data, data_hash, schema_version, updated_by, created_at, updated_at
     FROM canvas_content
     WHERE canvas_id IN (${placeholders})`,
    ids
  );
  return new Map(rows.map((row) => [Number(row.canvas_id), row]));
}

function mergeCanvasRowWithContent(row, contentRow) {
  if (!row) return null;
  const fallbackData = parseJsonDocument(row.data, {});
  if (!contentRow) {
    return { ...row, data: fallbackData, content_version: sha1String(JSON.stringify(fallbackData)) };
  }
  return {
    ...row,
    data: parseJsonDocument(contentRow.data, fallbackData),
    content_version: String(contentRow.data_hash || ''),
    content_updated_by: contentRow.updated_by == null ? null : Number(contentRow.updated_by),
    content_updated_at: contentRow.updated_at || row.updated_at
  };
}

async function hydrateCanvasRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const contentMap = await loadCanvasContentMap(rows.map((row) => row.id));
  return rows.map((row) => mergeCanvasRowWithContent(row, contentMap.get(Number(row.id))));
}

async function hydrateCanvasRow(row) {
  if (!row) return null;
  const rows = await hydrateCanvasRows([row]);
  return rows[0] || null;
}

async function upsertCanvasContent(canvasId, ownerId, data, updatedBy = null) {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  await getContentPool().query(
    `INSERT INTO canvas_content
      (canvas_id, owner_id, data, data_hash, schema_version, updated_by)
     VALUES (?, ?, ?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE
      owner_id = VALUES(owner_id),
      data = VALUES(data),
      data_hash = VALUES(data_hash),
      schema_version = VALUES(schema_version),
      updated_by = VALUES(updated_by),
      updated_at = CURRENT_TIMESTAMP`,
    [canvasId, ownerId, serialized, sha1String(serialized), updatedBy]
  );
}

async function maybeCreateCanvasRevision(canvasId, data, options = {}) {
  const db = getContentPool();
  const snapshotString = typeof data === 'string' ? data : JSON.stringify(data);
  const revisionHash = sha1String(snapshotString);
  const revisionReason = String(options.reason || 'autosave').slice(0, 32);
  const revisionCooldownMs = Number(options.cooldownMs ?? 15000);

  const [lastRows] = await db.query(
    'SELECT revision_hash, created_at FROM canvas_revisions WHERE canvas_id = ? ORDER BY id DESC LIMIT 1',
    [canvasId]
  );
  const lastRevision = lastRows[0] || null;
  if (lastRevision?.revision_hash === revisionHash) return;
  if (lastRevision && revisionReason === 'autosave') {
    const lastCreatedAt = new Date(lastRevision.created_at).getTime();
    if (Number.isFinite(lastCreatedAt) && Date.now() - lastCreatedAt < revisionCooldownMs) return;
  }

  const ownerId = await resolveCanvasOwnerId(canvasId, options.ownerId);
  if (!ownerId) return;

  await db.query(
    `INSERT INTO canvas_revisions
      (canvas_id, owner_id, revision_hash, revision_reason, snapshot, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [canvasId, ownerId, revisionHash, revisionReason, snapshotString, options.createdBy ? Number(options.createdBy) : null]
  );

  await db.query(
    `DELETE FROM canvas_revisions
     WHERE canvas_id = ?
       AND id NOT IN (
         SELECT id FROM (
           SELECT id
           FROM canvas_revisions
           WHERE canvas_id = ?
           ORDER BY id DESC
           LIMIT 100
         ) keep_ids
       )`,
    [canvasId, canvasId]
  );
}

async function saveCanvasData(canvasId, data, options = {}) {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  const parsedData = typeof data === 'string' ? parseJsonDocument(data, {}) : data;
  const ownerId = await resolveCanvasOwnerId(canvasId, options.ownerId);
  const summary = summarizeCanvasData(parsedData);

  await getAdminPool().query(
    `UPDATE canvases
     SET data = ?, cover_url = ?, node_count = ?, summary_updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [serialized, summary.coverUrl, summary.nodeCount, canvasId]
  );

  if (ownerId) {
    await upsertCanvasContent(canvasId, ownerId, serialized, options.createdBy ? Number(options.createdBy) : ownerId);
  }

  if (!options.skipRevision) {
    try {
      await maybeCreateCanvasRevision(canvasId, parsedData, { ...options, ownerId });
    } catch (error) {
      console.warn(`save canvas revision failed for ${canvasId}:`, error.message);
    }
  }
}

module.exports = {
  closePools,
  getAdminPool,
  getContentPool,
  getErrorPool,
  getPool,
  getUsagePool,
  hydrateCanvasRow,
  hydrateCanvasRows,
  isSeparateContentDatabase,
  maybeCreateCanvasRevision,
  migrate,
  parseJsonDocument,
  saveCanvasData,
  starterCanvas,
  upsertCanvasContent
};
