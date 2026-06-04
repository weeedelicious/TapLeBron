const path = require('path');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const express = require('express');
const { COOKIE_NAME, createSession, requireAdmin, requireAuth, sessionCookieOptions, touchUserLastUsed } = require('./auth');
const { getPool, migrate, starterCanvas } = require('./db');
const config = require('./config');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: Boolean(user.active)
  };
}

function loginUserSummary(user) {
  return {
    id: user.id,
    username: user.username,
    hasPassword: Boolean(user.password_hash)
  };
}

function normalizeCanvas(row) {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    data,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function canvasSummary(row) {
  const canvas = normalizeCanvas(row);
  return {
    id: canvas.id,
    ownerId: canvas.ownerId,
    title: canvas.title,
    nodeCount: Array.isArray(canvas.data.nodes) ? canvas.data.nodes.length : 0,
    edgeCount: Array.isArray(canvas.data.edges) ? canvas.data.edges.length : 0,
    createdAt: canvas.createdAt,
    updatedAt: canvas.updatedAt
  };
}

function cleanTitle(title) {
  const value = String(title || '').trim();
  return value ? value.slice(0, 160) : '未命名画布';
}

function cleanRole(role) {
  return role === 'admin' ? 'admin' : 'user';
}

function userStatus(user) {
  return user.active ? 'enabled' : 'disabled';
}

function cleanCanvasData(data) {
  if (!data || typeof data !== 'object') return starterCanvas();
  return {
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    edges: Array.isArray(data.edges) ? data.edges : [],
    viewport:
      data.viewport && typeof data.viewport === 'object'
        ? data.viewport
        : { x: 0, y: 0, zoom: 1 }
  };
}

async function countActiveAdmins(exceptUserId = null) {
  const params = [];
  let sql = "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND active = 1";
  if (exceptUserId) {
    sql += ' AND id <> ?';
    params.push(exceptUserId);
  }
  const [rows] = await getPool().query(sql, params);
  return Number(rows[0].total);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get(
  '/api/auth/users',
  asyncRoute(async (req, res) => {
    const [rows] = await getPool().query(
      'SELECT id, username, password_hash FROM users WHERE active = 1 ORDER BY username ASC'
    );
    res.json({ users: rows.map(loginUserSummary) });
  })
);

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username) {
      res.status(400).json({ error: '请选择账号' });
      return;
    }

    const [rows] = await getPool().query(
      'SELECT id, username, password_hash, role, active FROM users WHERE username = ? LIMIT 1',
      [username]
    );

    const user = rows[0];
    if (!user || !user.active) {
      res.status(401).json({ error: '账号或密码不正确' });
      return;
    }

    if (!user.password_hash) {
      res.status(409).json({
        error: '请先设置密码',
        requiresPasswordSetup: true,
        user: loginUserSummary(user)
      });
      return;
    }

    if (!password || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: '账号或密码不正确' });
      return;
    }

    await touchUserLastUsed(user.id);
    res.cookie(COOKIE_NAME, createSession(user), sessionCookieOptions());
    res.json({ user: publicUser(user) });
  })
);

app.post(
  '/api/auth/setup-password',
  asyncRoute(async (req, res) => {
    const userId = Number(req.body.userId);
    const password = String(req.body.password || '');

    if (!userId) {
      res.status(400).json({ error: '请选择账号' });
      return;
    }

    if (password.length < 4 || password.length > 128) {
      res.status(400).json({ error: '密码长度需要在 4-128 个字符之间' });
      return;
    }

    const [rows] = await getPool().query(
      'SELECT id, username, password_hash, role, active FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    const user = rows[0];
    if (!user || !user.active) {
      res.status(404).json({ error: '用户不存在或已禁用' });
      return;
    }

    if (user.password_hash) {
      res.status(409).json({ error: '该账号已经设置过密码' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await getPool().query('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL', [
      passwordHash,
      userId
    ]);

    await touchUserLastUsed(user.id);
    res.cookie(COOKIE_NAME, createSession(user), sessionCookieOptions());
    res.json({ user: publicUser(user) });
  })
);

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get(
  '/api/canvases',
  requireAuth,
  asyncRoute(async (req, res) => {
    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE owner_id = ? ORDER BY updated_at DESC',
      [req.user.id]
    );
    res.json({ canvases: rows.map(canvasSummary) });
  })
);

app.post(
  '/api/canvases',
  requireAuth,
  asyncRoute(async (req, res) => {
    const title = cleanTitle(req.body.title);
    const data = starterCanvas();
    const [result] = await getPool().query(
      'INSERT INTO canvases (owner_id, title, data) VALUES (?, ?, ?)',
      [req.user.id, title, JSON.stringify(data)]
    );

    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({ canvas: normalizeCanvas(rows[0]) });
  })
);

app.get(
  '/api/canvases/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE id = ? AND (owner_id = ? OR ? = ?)',
      [req.params.id, req.user.id, req.user.role, 'admin']
    );

    if (!rows.length) {
      res.status(404).json({ error: '画布不存在' });
      return;
    }

    res.json({ canvas: normalizeCanvas(rows[0]) });
  })
);

app.put(
  '/api/canvases/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const [existingRows] = await getPool().query(
      'SELECT id, owner_id FROM canvases WHERE id = ? AND (owner_id = ? OR ? = ?) LIMIT 1',
      [req.params.id, req.user.id, req.user.role, 'admin']
    );

    if (!existingRows.length) {
      res.status(404).json({ error: '画布不存在' });
      return;
    }

    const title = cleanTitle(req.body.title);
    const data = cleanCanvasData(req.body.data);
    await getPool().query(
      'UPDATE canvases SET title = ?, data = ? WHERE id = ?',
      [title, JSON.stringify(data), req.params.id]
    );

    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE id = ?',
      [req.params.id]
    );
    res.json({ canvas: normalizeCanvas(rows[0]) });
  })
);

app.delete(
  '/api/canvases/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const [result] = await getPool().query(
      'DELETE FROM canvases WHERE id = ? AND (owner_id = ? OR ? = ?)',
      [req.params.id, req.user.id, req.user.role, 'admin']
    );

    if (!result.affectedRows) {
      res.status(404).json({ error: '画布不存在' });
      return;
    }

    res.json({ ok: true });
  })
);

app.get(
  '/api/admin/users',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const [rows] = await getPool().query(
      'SELECT id, username, password_hash, role, active, created_at, updated_at, last_used_at FROM users ORDER BY created_at ASC, id ASC'
    );
    res.json({
      users: rows.map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role,
        active: Boolean(user.active),
        status: userStatus(user),
        hasPassword: Boolean(user.password_hash),
        createdAt: user.created_at,
        updatedAt: user.updated_at,
        lastUsedAt: user.last_used_at
      }))
    });
  })
);

app.post(
  '/api/admin/users',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const role = cleanRole(req.body.role);

    if (username.length < 2 || username.length > 80) {
      res.status(400).json({ error: '用户名长度需要在 2-80 个字符之间' });
      return;
    }

    try {
      const [result] = await getPool().query(
        'INSERT INTO users (username, password_hash, role, active) VALUES (?, NULL, ?, 1)',
        [username, role]
      );
      res.status(201).json({
        user: {
          id: result.insertId,
          username,
          role,
          active: true,
          status: 'enabled',
          hasPassword: false,
          lastUsedAt: null
        }
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        res.status(409).json({ error: '用户名已存在' });
        return;
      }
      throw error;
    }
  })
);

app.put(
  '/api/admin/users/:id',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const [rows] = await getPool().query('SELECT id, role, active FROM users WHERE id = ?', [id]);
    if (!rows.length) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    const current = rows[0];
    const updates = [];
    const params = [];

    if (req.body.username !== undefined) {
      const username = String(req.body.username || '').trim();
      if (username.length < 2 || username.length > 80) {
        res.status(400).json({ error: '用户名长度需要在 2-80 个字符之间' });
        return;
      }
      updates.push('username = ?');
      params.push(username);
    }

    if (req.body.password !== undefined) {
      res.status(400).json({ error: '后台不能修改密码，请清空密码后让用户登录时自行设置' });
      return;
    }

    if (req.body.clearPassword) {
      updates.push('password_hash = NULL');
    }

    if (req.body.role !== undefined) {
      const nextRole = cleanRole(req.body.role);
      if (current.role === 'admin' && nextRole !== 'admin' && (await countActiveAdmins(id)) === 0) {
        res.status(400).json({ error: '至少需要保留一个可用管理员' });
        return;
      }
      updates.push('role = ?');
      params.push(nextRole);
    }

    if (req.body.active !== undefined || req.body.status !== undefined) {
      const nextActive =
        req.body.status !== undefined
          ? req.body.status === 'enabled'
            ? 1
            : 0
          : req.body.active
            ? 1
            : 0;
      if (req.body.status !== undefined && !['enabled', 'disabled'].includes(req.body.status)) {
        res.status(400).json({ error: '用户状态只能是启用或禁用' });
        return;
      }
      if (id === req.user.id && nextActive === 0) {
        res.status(400).json({ error: '不能禁用当前登录账号' });
        return;
      }
      if (current.role === 'admin' && nextActive === 0 && (await countActiveAdmins(id)) === 0) {
        res.status(400).json({ error: '至少需要保留一个可用管理员' });
        return;
      }
      updates.push('active = ?');
      params.push(nextActive);
    }

    if (!updates.length) {
      res.status(400).json({ error: '没有需要更新的内容' });
      return;
    }

    params.push(id);

    try {
      await getPool().query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        res.status(409).json({ error: '用户名已存在' });
        return;
      }
      throw error;
    }

    const [updated] = await getPool().query(
      'SELECT id, username, password_hash, role, active, created_at, updated_at, last_used_at FROM users WHERE id = ?',
      [id]
    );

    res.json({
      user: {
        id: updated[0].id,
        username: updated[0].username,
        role: updated[0].role,
        active: Boolean(updated[0].active),
        status: userStatus(updated[0]),
        hasPassword: Boolean(updated[0].password_hash),
        createdAt: updated[0].created_at,
        updatedAt: updated[0].updated_at,
        lastUsedAt: updated[0].last_used_at
      }
    });
  })
);

app.delete(
  '/api/admin/users/:id',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      res.status(400).json({ error: '不能删除当前登录账号' });
      return;
    }

    const [rows] = await getPool().query('SELECT id, role, active FROM users WHERE id = ?', [id]);
    if (!rows.length) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    if (rows[0].role === 'admin' && rows[0].active && (await countActiveAdmins(id)) === 0) {
      res.status(400).json({ error: '至少需要保留一个可用管理员' });
      return;
    }

    await getPool().query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ ok: true });
  })
);

const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON 格式不正确' });
    return;
  }

  console.error(error);
  res.status(500).json({ error: '服务器错误' });
});

migrate()
  .then(() => {
    app.listen(config.port, '127.0.0.1', () => {
      console.log(`Tapflow Workbench listening on 127.0.0.1:${config.port}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
