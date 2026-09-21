const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const express = require('express');
const {
  COOKIE_NAME,
  createSession,
  requireAdmin,
  requireAuth,
  requirePluginAuth,
  sessionCookieOptions,
  touchUserLastUsed,
} = require('./auth');
const {
  apiRouter: canvasApiRouter,
  assetRouter,
  generationRuntimeState,
  pauseGenerationPollers,
  resumePersistedGenerationTasks,
  waitForGenerationDrain,
} = require('./routes/canvasApiRoutes');
const { errorLibraryRouter } = require('./routes/errorLibraryRoutes');
const { pluginTokenRouter, shotflowPluginRouter } = require('./routes/shotflowPluginRoutes');
const { studioRouter } = require('./routes/studioRoutes');
const { cindyAssistantRouter } = require('./routes/cindyAssistantRoutes');
const { closePools, getPool, migrate } = require('./db');
const { hydrateCanvasRow, hydrateCanvasRows, saveCanvasData, starterCanvas } = require('./services/CanvasService');
const config = require('./config');
const assetService = require('./services/AssetService');
const {
  bootstrapSharedProjectCatalog,
  createProjectInCatalog,
  listProjectCatalogRows,
  updateProjectInCatalog,
} = require('./projectCatalog');
const {
  bootstrapSharedUserCatalog,
  countActiveCatalogAdmins,
  createUserInCatalog,
  deleteUserInCatalog,
  getLocalShadowByCatalogUserId,
  getUserCatalogRowById,
  listUserCatalogRows,
  getUserApiKeyByUser,
  setUserApiKeyInCatalog,
  setUserPasswordInCatalog,
  updateUserInCatalog,
} = require('./userCatalog');
const { listPaidUsage } = require('./services/UsageService');
const { getApiKeyStatus, replaceApiKey } = require('./services/ApiKeyService');
const jobService = require('./services/JobService');
const { backfillGenerationTaskFailures, recordHttpGenerationFailure } = require('./services/ErrorService');

const app = express();
const APP_HOME_PATH = '/Shotflow';
const APP_ADMIN_PATH = '/Shotflow/admin';
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 30 * 60 * 1000)
);
let httpServer = null;
let isShuttingDown = false;
let shutdownPromise = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function captureGenerationHttpErrors(req, res, next) {
  const path = String(req.path || '');
  const shouldCapture = (
    req.method !== 'GET' &&
    (
      path.startsWith('/generate/') ||
      path.startsWith('/toolbox/') ||
      path.startsWith('/light-stage/')
    )
  );
  if (!shouldCapture) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (res.statusCode >= 400 && res.statusCode !== 401 && res.statusCode !== 403) {
      void recordHttpGenerationFailure(req, payload, res.statusCode);
    }
    return originalJson(payload);
  };
  next();
}

function preserveCanvasSessionErrors(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (res.locals.canvasAccessSessionError) return originalJson(res.locals.canvasAccessSessionError);
    return originalJson(payload);
  };
  const originalStatus = res.status.bind(res);
  res.status = (code) => {
    if (res.locals.canvasAccessSessionStatus) return originalStatus(res.locals.canvasAccessSessionStatus);
    return originalStatus(code);
  };
  next();
}

function rejectGenerationWhileDraining(req, res, next) {
  if (!isShuttingDown || req.method === 'GET') {
    next();
    return;
  }
  const requestPath = String(req.path || '');
  const isGenerationRequest = (
    requestPath.startsWith('/generate/') ||
    requestPath.startsWith('/toolbox/') ||
    requestPath.startsWith('/light-stage/')
  );
  if (!isGenerationRequest) {
    next();
    return;
  }
  res.set('Retry-After', '30');
  res.status(503).json({
    error: '服务正在平滑更新，当前任务不会中断，请稍后再提交新任务',
    code: 'SERVICE_DRAINING',
  });
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
    updatedAt: row.content_updated_at || row.updated_at
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

function sharedUserCatalogEnabled() {
  return config.projectCatalog.backend === 'sd2_mysql';
}

function userStatus(user) {
  return user.active ? 'enabled' : 'disabled';
}

function currentCatalogUserId(user) {
  const value = user?.external_user_id ?? user?.id ?? null;
  const numericId = Number(value);
  return Number.isFinite(numericId) && numericId > 0 ? numericId : null;
}

function adminUserSummary(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: Boolean(user.active),
    status: userStatus(user),
    hasPassword: Boolean(user.password_hash),
    createdAt: user.created_at || null,
    updatedAt: user.updated_at || user.created_at || null,
    lastUsedAt: user.last_used_at || null
  };
}

function cleanAdminProjectName(name) {
  return String(name || '').trim().slice(0, 160);
}

function cleanAdminProjectStatus(status) {
  return ['not_started', 'in_progress', 'completed'].includes(String(status)) ? String(status) : 'not_started';
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
  if (sharedUserCatalogEnabled()) {
    return countActiveCatalogAdmins(exceptUserId);
  }
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
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(config.mivoApiKey && config.llmApiKey),
    mivoApiConfigured: Boolean(config.mivoApiKey),
    llmApiConfigured: Boolean(config.llmApiKey)
  });
});

app.get(
  '/api/auth/users',
  asyncRoute(async (req, res) => {
    const rows = sharedUserCatalogEnabled()
      ? (await listUserCatalogRows()).filter((user) => user.active)
      : (
          await getPool().query(
            'SELECT id, username, password_hash FROM users WHERE active = 1 ORDER BY username ASC'
          )
        )[0];
    res.json({ users: rows.map(loginUserSummary) });
  })
);

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username) {
      res.status(400).json({ error: 'Please select a user' });
      return;
    }

    if (sharedUserCatalogEnabled()) {
      const catalogUser = (await listUserCatalogRows()).find((row) => row.username === username) || null;
      const localShadow = catalogUser ? await getLocalShadowByCatalogUserId(catalogUser.id) : null;

      if (!catalogUser || !catalogUser.active || !localShadow || !localShadow.active) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }

      if (!catalogUser.password_hash) {
        res.status(409).json({
          error: 'Password setup required',
          requiresPasswordSetup: true,
          user: loginUserSummary(catalogUser)
        });
        return;
      }

      if (!password || !(await bcrypt.compare(password, catalogUser.password_hash))) {
        res.status(401).json({ error: 'Invalid username or password' });
        return;
      }

      await touchUserLastUsed(localShadow.id, catalogUser.id);
      res.cookie(COOKIE_NAME, createSession(localShadow), sessionCookieOptions());
      res.json({ user: publicUser(localShadow) });
      return;
    }

    const [rows] = await getPool().query(
      'SELECT id, username, password_hash, role, active FROM users WHERE username = ? LIMIT 1',
      [username]
    );

    const user = rows[0];
    if (!user || !user.active) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    if (!user.password_hash) {
      res.status(409).json({
        error: 'Password setup required',
        requiresPasswordSetup: true,
        user: loginUserSummary(user)
      });
      return;
    }

    if (!password || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    await touchUserLastUsed(user.id);
    res.cookie(COOKIE_NAME, createSession(user), sessionCookieOptions());
    res.json({ user: publicUser(user) });
  })
);

/**
 * 新用户自助注册（2026-08-24 用户要求：登录页加注册按钮，输账号密码就能注册，默认「制作人」）。
 *
 * 「制作人」是怎么落地的：sd2 的用户管理页按标志位推角色 ——
 *   is_admin → 管理员，is_tester → 测试员，is_line_producer → 制片，
 *   **三个都为 0 → 制作人**。
 * createUserInCatalog 插入时这三个正好都是 0，所以不用特意设什么字段；
 * 反过来说，谁要是在这里给 is_line_producer 置 1，注册出来的就变成「制片」而不是「制作人」了。
 *
 * 注意这个口写的是**公司共享的 sd2 用户表**，别的系统也读它。用户明确要求完全开放、不加注册码
 * （2026-08-24 确认过），所以这里只有频率限制这一道防线：防的是接口被扫到之后批量灌账号，
 * 不是防真人。
 */
const REGISTER_WINDOW_MS = 10 * 60 * 1000;
const REGISTER_MAX_PER_WINDOW = 5;
const registerAttempts = new Map();

function registerRateLimited(ip) {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const hits = (registerAttempts.get(key) || []).filter((at) => now - at < REGISTER_WINDOW_MS);
  // 顺手清掉过期的键，免得这个 Map 无限长
  if (registerAttempts.size > 5000) {
    for (const [k, list] of registerAttempts) {
      if (list.every((at) => now - at >= REGISTER_WINDOW_MS)) registerAttempts.delete(k);
    }
  }
  if (hits.length >= REGISTER_MAX_PER_WINDOW) {
    registerAttempts.set(key, hits);
    return true;
  }
  hits.push(now);
  registerAttempts.set(key, hits);
  return false;
}

app.post(
  '/api/auth/register',
  asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const apiKey = String(req.body.apiKey || '').trim();

    // 账号规则跟 normalizeUsername 的上限对齐（sd2 那张表是 VARCHAR(50)）
    if (username.length < 2 || username.length > 50) {
      res.status(400).json({ error: '账号长度需要在 2 到 50 个字符之间' });
      return;
    }
    if (/[\s\\/'"`<>]/.test(username)) {
      res.status(400).json({ error: '账号不能包含空格和 \\ / \' " ` < > 这些字符' });
      return;
    }
    // 跟 setup-password 同一条口径，免得两处规则不一样
    if (password.length < 4 || password.length > 128) {
      res.status(400).json({ error: '密码长度需要在 4 到 128 个字符之间' });
      return;
    }
    if (apiKey.length < 12 || apiKey.length > 512) {
      res.status(400).json({ error: '请填写有效的 API Key' });
      return;
    }
    if (registerRateLimited(req.ip)) {
      res.status(429).json({ error: '注册太频繁了，请过一会儿再试' });
      return;
    }

    if (sharedUserCatalogEnabled()) {
      const existing = (await listUserCatalogRows()).find((row) => row.username === username);
      if (existing) {
        res.status(409).json({ error: '这个账号已经有人用了，换一个' });
        return;
      }
      // 参数是**一个对象**，不是位置参数 —— 传成位置参数会让 username 变 undefined
      // （2026-08-23 那个 canvas.id 取错层级的 bug 就是同一类，这次先核对了签名）。
      // role 传 'user'：createUserInCatalog 会把 is_admin 置 0，
      // 加上 is_tester / is_line_producer 也是 0 —— 这就是「制作人」
      const created = await createUserInCatalog({ username, role: 'user', active: true, apiKey });
      if (!created) {
        res.status(502).json({ error: '注册失败，请稍后重试' });
        return;
      }
      await setUserPasswordInCatalog(created.id, password);
      await setUserApiKeyInCatalog(created.id, apiKey);
      const localShadow = await getLocalShadowByCatalogUserId(created.id);
      if (!localShadow) {
        // 账号已经建在共享目录里了，只是本地影子行还没同步过来。
        // 不要当成失败让用户重复注册 —— 那会建出一堆同名候选。
        res.status(202).json({
          error: '账号已创建，但还没同步完成。请回到登录页选这个账号登录。',
          username,
        });
        return;
      }
      await touchUserLastUsed(localShadow.id, created.id);
      res.cookie(COOKIE_NAME, createSession(localShadow), sessionCookieOptions());
      res.json({ user: publicUser(localShadow) });
      return;
    }

    // 本地模式（没接 sd2 时）：直接写本地 users 表，role 用 'user'
    const [duplicates] = await getPool().query('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
    if (duplicates.length > 0) {
      res.status(409).json({ error: '这个账号已经有人用了，换一个' });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const [inserted] = await getPool().query(
      "INSERT INTO users (username, password_hash, role, active, llm_api_key) VALUES (?, ?, 'user', 1, ?)",
      [username, passwordHash, apiKey]
    );
    const [rows] = await getPool().query(
      'SELECT id, username, password_hash, role, active FROM users WHERE id = ? LIMIT 1',
      [Number(inserted.insertId)]
    );
    const user = rows[0];
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
      res.status(400).json({ error: 'Please select a user' });
      return;
    }

    if (password.length < 4 || password.length > 128) {
      res.status(400).json({ error: 'Password length must be between 4 and 128 characters' });
      return;
    }

    if (sharedUserCatalogEnabled()) {
      const catalogUser = await getUserCatalogRowById(userId);
      if (!catalogUser || !catalogUser.active) {
        res.status(404).json({ error: 'User not found or disabled' });
        return;
      }

      if (catalogUser.password_hash) {
        res.status(409).json({ error: 'Password has already been set' });
        return;
      }

      await setUserPasswordInCatalog(userId, password);
      const localShadow = await getLocalShadowByCatalogUserId(userId);
      if (!localShadow || !localShadow.active) {
        res.status(404).json({ error: 'User not found or disabled' });
        return;
      }

      await touchUserLastUsed(localShadow.id, userId);
      res.cookie(COOKIE_NAME, createSession(localShadow), sessionCookieOptions());
      res.json({ user: publicUser(localShadow) });
      return;
    }

    const [rows] = await getPool().query(
      'SELECT id, username, password_hash, role, active FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    const user = rows[0];
    if (!user || !user.active) {
      res.status(404).json({ error: 'User not found or disabled' });
      return;
    }

    if (user.password_hash) {
      res.status(409).json({ error: 'Password has already been set' });
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
  '/api/auth/api-key',
  requireAuth,
  asyncRoute(async (req, res) => {
    const key = await getUserApiKeyByUser(req.user);
    res.json({ hasApiKey: Boolean(key) });
  })
);

app.post(
  '/api/auth/api-key',
  requireAuth,
  asyncRoute(async (req, res) => {
    const catalogUserId = currentCatalogUserId(req.user);
    if (!catalogUserId) {
      res.status(400).json({ error: '当前账号无法保存 API Key' });
      return;
    }
    try {
      const updated = await setUserApiKeyInCatalog(catalogUserId, req.body && req.body.apiKey);
      if (!updated) {
        res.status(404).json({ error: '账号不存在' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      if (error.status) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  })
);

app.get(
  '/api/canvases',
  requireAuth,
  asyncRoute(async (req, res) => {
    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE owner_id = ? ORDER BY updated_at DESC',
      [req.user.id]
    );
    const hydratedRows = await hydrateCanvasRows(rows);
    res.json({ canvases: hydratedRows.map(canvasSummary) });
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
    await saveCanvasData(result.insertId, data, {
      reason: 'legacy_canvas_create',
      ownerId: req.user.id,
      createdBy: req.user.id,
      cooldownMs: 0
    });

    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE id = ?',
      [result.insertId]
    );

    const row = await hydrateCanvasRow(rows[0]);
    res.status(201).json({ canvas: normalizeCanvas(row) });
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

    const row = await hydrateCanvasRow(rows[0]);
    res.json({ canvas: normalizeCanvas(row) });
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

    const existingRow = await hydrateCanvasRow(existingRows[0]);
    const existingData = typeof existingRow.data === 'string' ? JSON.parse(existingRow.data) : existingRow.data;
    const currentContentVersion = crypto
      .createHash('sha1')
      .update(JSON.stringify(existingData || {}))
      .digest('hex');
    const baseContentVersion = String(req.body.baseContentVersion || '').trim();
    if (!baseContentVersion || baseContentVersion !== currentContentVersion) {
      res.status(baseContentVersion ? 409 : 428).json({
        error: baseContentVersion
          ? '画布已在其他页面更新，已阻止旧页面覆盖最新内容'
          : '旧版画布保存已停用，请刷新页面后重试',
        errorCode: baseContentVersion
          ? 'CANVAS_CONTENT_VERSION_CONFLICT'
          : 'CANVAS_CONTENT_VERSION_REQUIRED',
        currentContentVersion
      });
      return;
    }

    const title = cleanTitle(req.body.title);
    const data = cleanCanvasData(req.body.data);
    await getPool().query('UPDATE canvases SET title = ? WHERE id = ?', [title, req.params.id]);
    await saveCanvasData(req.params.id, data, {
      reason: 'legacy_canvas_update',
      ownerId: existingRows[0].owner_id,
      createdBy: req.user.id
    });

    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE id = ?',
      [req.params.id]
    );
    const row = await hydrateCanvasRow(rows[0]);
    res.json({ canvas: normalizeCanvas(row) });
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
  '/api/admin/usage',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const usage = await listPaidUsage({
      period: req.query.period,
      date: req.query.date,
      userId: req.query.userId,
      type: req.query.type,
      model: req.query.model,
      status: req.query.status,
      limit: req.query.limit,
    });
    res.json({ ...usage, scope: req.query.scope || 'all' });
  })
);

app.get(
  '/api/admin/api-key',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    res.json(await getApiKeyStatus());
  })
);

app.post(
  '/api/admin/api-key',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    try {
      res.json(await replaceApiKey(req.body.apiKey, req.user));
    } catch (error) {
      if (error.status) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  })
);

app.get(
  '/api/admin/users',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const users = sharedUserCatalogEnabled()
      ? await listUserCatalogRows()
      : (
          await getPool().query(
            'SELECT id, username, password_hash, role, active, created_at, updated_at, last_used_at FROM users ORDER BY created_at ASC, id ASC'
          )
        )[0];
    res.json({
      users: users.map(adminUserSummary)
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
      res.status(400).json({ error: 'Username must be between 2 and 80 characters' });
      return;
    }

    try {
      const user = await createUserInCatalog({ username, role, active: true });
      res.status(201).json({ user: adminUserSummary(user) });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        res.status(409).json({ error: 'Username already exists' });
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
    const current = sharedUserCatalogEnabled()
      ? await getUserCatalogRowById(id)
      : (
          await getPool().query('SELECT id, role, active FROM users WHERE id = ?', [id])
        )[0][0] || null;

    if (!current) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const updates = {};

    if (req.body.username !== undefined) {
      const username = String(req.body.username || '').trim();
      if (username.length < 2 || username.length > 80) {
        res.status(400).json({ error: 'Username must be between 2 and 80 characters' });
        return;
      }
      updates.username = username;
    }

    if (req.body.password !== undefined) {
      res.status(400).json({ error: 'Password cannot be changed here. Clear it first and let the user set it on login.' });
      return;
    }

    if (req.body.clearPassword) {
      updates.clearPassword = true;
    }

    if (req.body.role !== undefined) {
      const nextRole = cleanRole(req.body.role);
      if (current.role === 'admin' && nextRole !== 'admin' && (await countActiveAdmins(id)) === 0) {
        res.status(400).json({ error: 'At least one active admin must remain' });
        return;
      }
      updates.role = nextRole;
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
        res.status(400).json({ error: 'Status must be enabled or disabled' });
        return;
      }
      if (id === currentCatalogUserId(req.user) && nextActive === 0) {
        res.status(400).json({ error: 'You cannot disable the current account' });
        return;
      }
      if (current.role === 'admin' && nextActive === 0 && (await countActiveAdmins(id)) === 0) {
        res.status(400).json({ error: 'At least one active admin must remain' });
        return;
      }
      updates.active = Boolean(nextActive);
    }

    if (!Object.keys(updates).length) {
      res.status(400).json({ error: 'No changes to apply' });
      return;
    }

    try {
      const updated = await updateUserInCatalog(id, updates);
      res.json({ user: adminUserSummary(updated) });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        res.status(409).json({ error: 'Username already exists' });
        return;
      }
      throw error;
    }
  })
);

app.delete(
  '/api/admin/users/:id',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (id === currentCatalogUserId(req.user)) {
      res.status(400).json({ error: 'You cannot delete the current account' });
      return;
    }

    const current = sharedUserCatalogEnabled()
      ? await getUserCatalogRowById(id)
      : (
          await getPool().query('SELECT id, role, active FROM users WHERE id = ?', [id])
        )[0][0] || null;

    if (!current) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (current.role === 'admin' && current.active && (await countActiveAdmins(id)) === 0) {
      res.status(400).json({ error: 'At least one active admin must remain' });
      return;
    }

    await deleteUserInCatalog(id);
    res.json({ ok: true });
  })
);

app.get(
  '/api/admin/projects',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const rows = await listProjectCatalogRows();
    res.json({
      projects: rows.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
        createdAt: project.created_at,
        updatedAt: project.updated_at
      }))
    });
  })
);

app.post(
  '/api/admin/projects',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const name = cleanAdminProjectName(req.body.name);
    const status = cleanAdminProjectStatus(req.body.status);

    if (!name) {
      res.status(400).json({ error: '项目名称不能为空' });
      return;
    }

    try {
      const project = await createProjectInCatalog(name, status);
      res.status(201).json({
        project: {
          id: project.id,
          name: project.name,
          status: project.status,
          createdAt: project.created_at,
          updatedAt: project.updated_at
        }
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        res.status(409).json({ error: '项目名称已存在' });
        return;
      }
      throw error;
    }
  })
);

app.put(
  '/api/admin/projects/:id',
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const existingProject = (await listProjectCatalogRows()).find((project) => Number(project.id) === id) || null;
    if (!existingProject) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }

    const updates = {};

    if (req.body.name !== undefined) {
      const name = cleanAdminProjectName(req.body.name);
      if (!name) {
        res.status(400).json({ error: '项目名称不能为空' });
        return;
      }
      updates.name = name;
    }

    if (req.body.status !== undefined) {
      updates.status = cleanAdminProjectStatus(req.body.status);
    }

    if (!Object.keys(updates).length) {
      res.status(400).json({ error: '没有需要更新的内容' });
      return;
    }

    try {
      const project = await updateProjectInCatalog(id, updates);
      res.json({
        project: {
          id: project.id,
          name: project.name,
          status: project.status,
          createdAt: project.created_at,
          updatedAt: project.updated_at
        }
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        res.status(409).json({ error: '项目名称已存在' });
        return;
      }
      throw error;
    }
  })
);

const distPath = path.join(__dirname, '..', 'dist');
const shotflowIndexPath = path.join(__dirname, '..', 'public', 'releases', 'matting-rectangle-live-preview-20260811', 'index.html');
app.use('/api/plugin-tokens', requireAuth, pluginTokenRouter);
app.use('/api/plugin/v1', requirePluginAuth, shotflowPluginRouter);
app.use('/api/error-library', requireAuth, errorLibraryRouter);
app.use('/api/cindy-assistant', requireAuth, cindyAssistantRouter);
app.use('/api/studio', requireAuth, studioRouter);
app.use('/api', requireAuth, preserveCanvasSessionErrors, rejectGenerationWhileDraining, captureGenerationHttpErrors, canvasApiRouter);
app.use('/assets', express.static(path.join(distPath, 'assets')));
app.use('/assets', requireAuth, assetRouter);
app.get('/', (req, res) => {
  res.redirect(302, APP_HOME_PATH);
});
app.get('/admin', (req, res) => {
  res.redirect(302, APP_ADMIN_PATH);
});
app.use(express.static(distPath));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(APP_ADMIN_PATH, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
app.get([APP_HOME_PATH, `${APP_HOME_PATH}/*`], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(shotflowIndexPath);
});
app.get('*', (req, res) => {
  res.status(404).send('Not Found');
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON 格式不正确' });
    return;
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: '视频文件不能超过 150MB' });
    return;
  }

  const statusCode = Number(error.statusCode);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    res.status(statusCode).json({
      error: error.message || 'Request failed',
      errorCode: error.code || 'PLUGIN_REQUEST_FAILED',
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
    return;
  }

  console.error(error);
  res.status(500).json({ error: '服务器错误' });
});

function closeHttpServer() {
  if (!httpServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    if (typeof httpServer.closeIdleConnections === 'function') {
      httpServer.closeIdleConnections();
    }
  });
}

async function runGracefulShutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    isShuttingDown = true;
    console.log(`[shutdown] ${signal} received; draining generation work`, generationRuntimeState());
    pauseGenerationPollers();
    const httpClosePromise = closeHttpServer();
    await httpClosePromise;
    const drainResult = await waitForGenerationDrain(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    if (!drainResult.drained) {
      throw new Error(`generation drain timed out: ${JSON.stringify(drainResult)}`);
    }
    const persistenceResult = await jobService.waitForPendingPersistence(30_000);
    if (!persistenceResult.drained) {
      throw new Error(`task persistence drain timed out: ${JSON.stringify(persistenceResult)}`);
    }
    await closePools();
    console.log('[shutdown] generation work drained and database pools closed');
  })();

  const timeoutPromise = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`graceful shutdown exceeded ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms`)),
      GRACEFUL_SHUTDOWN_TIMEOUT_MS
    );
    timer.unref();
  });

  try {
    await Promise.race([shutdownPromise, timeoutPromise]);
    process.exit(0);
  } catch (error) {
    console.error('[shutdown] graceful shutdown failed:', error);
    process.exit(1);
  }
}

// 兜底：别让一个请求里的未捕获拒绝把整个服务打死。
//
// Node 15+ 对 unhandledRejection 的默认行为是退出进程。2026-08-14 后端一天崩了 41 次，
// 全部是同一类：几个 async 路由漏了 try/catch，会话失效的页面轮询 /tasks/:jobId 时
// requireCanvasSession 抛 428，没人接 → 整个服务被一个人的过期页面打死，每 10 秒一次。
// 那几个路由已经用 asyncRoute 包好（见 canvasRoutes.js），这里是第二道：以后再漏一个，
// 代价是这一个请求挂住 + 一条刺眼日志，而不是全公司的画布一起断线。
// 注意这不是"忽略错误"——栈完整打出来，方便照着修。
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error('[unhandledRejection] 请求里有未捕获的 Promise 拒绝，进程继续运行，请修掉它:\n', detail);
});

process.once('SIGTERM', () => {
  void runGracefulShutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void runGracefulShutdown('SIGINT');
});

async function startServer() {
  await migrate();
  await bootstrapSharedUserCatalog();
  await bootstrapSharedProjectCatalog();
  if (assetService.isRemoteEnabled) {
    await assetService.ensureBucketReady();
  }

  const recovery = await jobService.recoverInterruptedTasks();
  const resumed = await resumePersistedGenerationTasks(recovery.resumableTasks);
  if (recovery.interruptedCount > 0) {
    console.warn(
      `[startup] interrupted generation tasks: ${recovery.interruptedCount}; ` +
      `resumed: ${resumed.resumedCount}; failed safely: ${recovery.failedCount}`
    );
  }

  httpServer = app.listen(config.port, '127.0.0.1', () => {
    console.log(`Tapflow Workbench listening on 127.0.0.1:${config.port}`);
  });
  void backfillGenerationTaskFailures().then((result) => {
    if (result.inserted > 0) {
      console.log(`[startup] backfilled ${result.inserted}/${result.scanned} missing generation errors`);
    }
  });
}

startServer().catch(async (error) => {
  console.error(error);
  await closePools().catch(() => null);
  process.exit(1);
});
