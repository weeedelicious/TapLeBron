const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const config = require('./config');

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.db,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      timezone: '+08:00'
    });
  }

  return pool;
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
          label: '创意输入',
          description: '品牌、产品、目标用户'
        }
      },
      {
        id: 'prompt-1',
        type: 'workflow',
        position: { x: 420, y: 140 },
        data: {
          kind: 'prompt',
          label: '提示词整理',
          description: '风格、镜头、画面要求'
        }
      },
      {
        id: 'output-1',
        type: 'workflow',
        position: { x: 720, y: 140 },
        data: {
          kind: 'output',
          label: '输出交付',
          description: '图片、视频、分镜或素材包'
        }
      }
    ],
    edges: [
      { id: 'edge-input-prompt', source: 'input-1', target: 'prompt-1', animated: true },
      { id: 'edge-prompt-output', source: 'prompt-1', target: 'output-1', animated: true }
    ]
  };
}

async function migrate() {
  const db = getPool();

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

  await db.query(`
    CREATE TABLE IF NOT EXISTS canvases (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_id BIGINT UNSIGNED NOT NULL,
      title VARCHAR(160) NOT NULL,
      data JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_canvases_owner_updated (owner_id, updated_at),
      CONSTRAINT fk_canvases_owner
        FOREIGN KEY (owner_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  const [admins] = await db.query('SELECT id FROM users WHERE username = ? LIMIT 1', [
    config.initialAdmin.username
  ]);

  if (admins.length === 0) {
    const passwordHash = await bcrypt.hash(config.initialAdmin.password, 12);
    await db.query(
      'INSERT INTO users (username, password_hash, role, active) VALUES (?, ?, ?, 1)',
      [config.initialAdmin.username, passwordHash, 'admin']
    );
  }
}

module.exports = {
  getPool,
  migrate,
  starterCanvas
};
