const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const express = require('express');
const config = require('./config');
const { getPool } = require('./db');

const apiRouter = express.Router();
const assetRouter = express.Router();
const tasks = {};
let sharpModule = null;
let sharpChecked = false;

function getSharp() {
  if (sharpChecked) return sharpModule;
  sharpChecked = true;
  try {
    sharpModule = require('sharp');
  } catch (error) {
    console.warn('sharp is unavailable; image thumbnails and compression are disabled:', error.message);
    sharpModule = null;
  }
  return sharpModule;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function projectDir(projectUuid) {
  return path.join(config.projectsDir, String(projectUuid));
}

function assetsDir(projectUuid) {
  const dir = path.join(projectDir(projectUuid), 'assets');
  ensureDir(dir);
  return dir;
}

function tmpDir() {
  const dir = path.join(config.projectsDir, '_tmp');
  ensureDir(dir);
  return dir;
}

function sha1File(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function readCanvasData(row) {
  if (!row) return {};
  if (!row.data) return {};
  if (typeof row.data === 'string') {
    try {
      return JSON.parse(row.data);
    } catch {
      return {};
    }
  }
  return row.data;
}

function dateMs(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Date.now();
}

function defaultProjectDraft(projectUuid, data = {}) {
  const viewport = data.viewport || {};
  return {
    projectUuid: String(projectUuid),
    viewportX: Number(data.projectDraft?.viewportX ?? viewport.x ?? 0),
    viewportY: Number(data.projectDraft?.viewportY ?? viewport.y ?? 0),
    viewportZoom: Number(data.projectDraft?.viewportZoom ?? viewport.zoom ?? 1),
    lastEditedAtMs: Date.now()
  };
}

function legacyNodeToCanvasNode(node, projectUuid) {
  const kind = node?.data?.kind || node?.data?.type || 'text';
  const supported = ['text', 'image', 'video', 'audio'].includes(kind) ? kind : 'text';
  const nodeKey = String(node.id || randomId());
  const name = node?.data?.label || node?.data?.name || `${supported} node`;
  const data = {
    type: supported,
    name,
    url: [],
    action:
      supported === 'image'
        ? 'image_generate'
        : supported === 'video'
          ? 'video_generate'
          : supported === 'audio'
            ? 'audio_generate'
            : 'text_node',
    params:
      supported === 'image'
        ? {
            prompt: node?.data?.description || '',
            model: 'gemini-3-pro-image-preview',
            count: 1,
            settings: { quality: 'medium', ratio: '16:9', resolution: '1K' },
            modeType: 'text2image',
            imageList: [],
            imageListOrder: [],
            videoList: [],
            audioList: [],
            textList: []
          }
        : supported === 'video'
          ? {
              prompt: node?.data?.description || '',
              model: 'Seedance_2_0',
              modeType: 'text2video',
              count: 1,
              imageList: [],
              imageListOrder: [],
              mixedList: [],
              mixedListOrder: [],
              videoList: [],
              audioList: [],
              textList: [],
              settings: { ratio: '16:9', resolution: '720P', duration: 5, enableSound: 'on' }
            }
          : supported === 'audio'
            ? { type: 'tts', prompt: node?.data?.description || '', model: 'tts-default', voice: 'default', speed: 1 }
            : { content: node?.data?.description || '', model: 'gpt-5.5', prompt: '', imageList: [], videoList: [], textList: [] }
  };

  return {
    nodeKey,
    projectUuid: String(projectUuid),
    type: supported === 'text' ? 1 : supported === 'image' ? 2 : supported === 'video' ? 3 : 6,
    name,
    position: {
      positionX: Number(node?.position?.x ?? 0),
      positionY: Number(node?.position?.y ?? 0)
    },
    measured: {
      width: Number(node?.width ?? node?.measured?.width ?? 520),
      height: Number(node?.height ?? node?.measured?.height ?? 320)
    },
    data: JSON.stringify(data),
    status: 1
  };
}

function nodeListFromData(data, projectUuid) {
  if (Array.isArray(data.nodeList)) return data.nodeList;
  if (Array.isArray(data.nodes)) return data.nodes.map((node) => legacyNodeToCanvasNode(node, projectUuid));
  return [];
}

function coverFromNodeList(nodeList) {
  for (const node of nodeList) {
    try {
      const data = typeof node.data === 'string' ? JSON.parse(node.data) : node.data;
      if ((data.type === 'image' || data.type === 'upload' || data.type === 'video') && Array.isArray(data.url) && data.url[0]) {
        return data.url[0];
      }
    } catch {
      // ignore malformed node data
    }
  }
  return undefined;
}

function projectFromCanvasRow(row) {
  const data = readCanvasData(row);
  const nodeList = nodeListFromData(data, row.id);
  const createdAtMs = dateMs(row.created_at);
  const updatedAtMs = dateMs(row.updated_at);
  return {
    projectMeta: {
      uuid: String(row.id),
      name: row.title,
      coverUrl: data.coverUrl || coverFromNodeList(nodeList),
      ownerId: row.owner_id,
      createdAtMs,
      updatedAtMs
    },
    projectDraft: defaultProjectDraft(row.id, data),
    nodeList
  };
}

function projectIndexFromCanvasRow(row) {
  const project = projectFromCanvasRow(row);
  return {
    uuid: project.projectMeta.uuid,
    name: project.projectMeta.name,
    coverUrl: project.projectMeta.coverUrl,
    updatedAtMs: project.projectMeta.updatedAtMs,
    nodeCount: project.nodeList.length
  };
}

async function getCanvasForUser(req, canvasId) {
  const [rows] = await getPool().query(
    'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE id = ? AND (owner_id = ? OR ? = ?) LIMIT 1',
    [canvasId, req.user.id, req.user.role, 'admin']
  );
  return rows[0] || null;
}

async function saveCanvasData(canvasId, data) {
  await getPool().query('UPDATE canvases SET data = ? WHERE id = ?', [JSON.stringify(data), canvasId]);
}

function cleanProjectName(name) {
  const value = String(name || '').trim();
  return value ? value.slice(0, 160) : '未命名项目';
}

function projectDataFor(projectUuid, patch = {}) {
  return {
    nodeList: [],
    projectDraft: defaultProjectDraft(projectUuid),
    ...patch
  };
}

apiRouter.get('/projects', async (req, res, next) => {
  try {
    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE owner_id = ? ORDER BY updated_at DESC',
      [req.user.id]
    );
    res.json(rows.map(projectIndexFromCanvasRow));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects', async (req, res, next) => {
  try {
    const name = cleanProjectName(req.body.name);
    const [result] = await getPool().query(
      'INSERT INTO canvases (owner_id, title, data) VALUES (?, ?, ?)',
      [req.user.id, name, JSON.stringify(projectDataFor('pending'))]
    );
    const data = projectDataFor(result.insertId);
    await saveCanvasData(result.insertId, data);
    const row = await getCanvasForUser(req, result.insertId);
    res.status(201).json(projectFromCanvasRow(row));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/projects/:uuid', async (req, res, next) => {
  try {
    const row = await getCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    res.json(projectFromCanvasRow(row));
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/projects/:uuid', async (req, res, next) => {
  try {
    const row = await getCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    const name = cleanProjectName(req.body.name);
    await getPool().query('UPDATE canvases SET title = ? WHERE id = ?', [name, req.params.uuid]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/projects/:uuid', async (req, res, next) => {
  try {
    const [result] = await getPool().query(
      'DELETE FROM canvases WHERE id = ? AND (owner_id = ? OR ? = ?)',
      [req.params.uuid, req.user.id, req.user.role, 'admin']
    );
    if (!result.affectedRows) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/projects/:uuid/cover', async (req, res, next) => {
  try {
    const row = await getCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    const data = readCanvasData(row);
    data.coverUrl = String(req.body.coverUrl || '');
    await saveCanvasData(req.params.uuid, data);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/projects/:uuid/draft', async (req, res, next) => {
  try {
    const row = await getCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    const data = readCanvasData(row);
    data.projectDraft = {
      ...defaultProjectDraft(req.params.uuid, data),
      ...req.body,
      projectUuid: String(req.params.uuid),
      lastEditedAtMs: Date.now()
    };
    await saveCanvasData(req.params.uuid, data);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects/:uuid/nodes/batch', async (req, res, next) => {
  try {
    const row = await getCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    if (!Array.isArray(req.body.nodes)) {
      res.status(400).json({ error: 'nodes must be array' });
      return;
    }
    const data = readCanvasData(row);
    data.nodeList = req.body.nodes;
    data.projectDraft = defaultProjectDraft(req.params.uuid, data);
    data.coverUrl = data.coverUrl || coverFromNodeList(data.nodeList);
    await saveCanvasData(req.params.uuid, data);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects/:uuid/nodes/delete', async (req, res, next) => {
  try {
    const row = await getCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    const nodeKeys = Array.isArray(req.body.nodeKeys) ? req.body.nodeKeys.map(String) : [];
    const data = readCanvasData(row);
    data.nodeList = nodeListFromData(data, req.params.uuid).filter((node) => !nodeKeys.includes(String(node.nodeKey)));
    await saveCanvasData(req.params.uuid, data);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

const upload = multer({ dest: tmpDir() });
const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff']);

apiRouter.post('/assets/upload', upload.single('file'), async (req, res, next) => {
  try {
    const projectUuid = String(req.body.projectUuid || '');
    const row = await getCanvasForUser(req, projectUuid);
    if (!req.file || !row) {
      if (req.file?.path) fs.rmSync(req.file.path, { force: true });
      res.status(400).json({ error: 'missing file or projectUuid' });
      return;
    }

    const sha1 = sha1File(req.file.path);
    const ext = path.extname(req.file.originalname) || `.${String(req.file.mimetype || 'application/octet-stream').split('/')[1] || 'bin'}`;
    const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '') || '.bin';
    const dest = path.join(assetsDir(projectUuid), `${sha1}${safeExt}`);

    if (!fs.existsSync(dest)) fs.renameSync(req.file.path, dest);
    else fs.rmSync(req.file.path, { force: true });

    const url = `/assets/${projectUuid}/${sha1}${safeExt}`;
    let thumbUrl = url;
    if (imageExts.has(safeExt.toLowerCase())) {
      const thumbDest = path.join(assetsDir(projectUuid), `${sha1}_thumb.webp`);
      const sharp = getSharp();
      if (sharp && !fs.existsSync(thumbDest)) {
        await sharp(dest).resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 85 }).toFile(thumbDest).catch(() => null);
      }
      if (fs.existsSync(thumbDest)) thumbUrl = `/assets/${projectUuid}/${sha1}_thumb.webp`;
    }

    res.json({ url, thumbUrl, sha1, meta: { mimeType: req.file.mimetype, byteSize: req.file.size } });
  } catch (error) {
    next(error);
  }
});

function listAssetsInProject(projectUuid) {
  const dir = assetsDir(projectUuid);
  return fs
    .readdirSync(dir)
    .filter((file) => !file.endsWith('_thumb.webp'))
    .map((file) => ({ url: `/assets/${projectUuid}/${file}`, name: file, mimeType: '', sha1: file.split('.')[0] }));
}

apiRouter.get('/assets/:projectUuid', async (req, res, next) => {
  try {
    const row = await getCanvasForUser(req, req.params.projectUuid);
    if (!row) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    res.json(listAssetsInProject(req.params.projectUuid));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/assets', async (req, res, next) => {
  try {
    const [rows] = await getPool().query('SELECT id FROM canvases WHERE owner_id = ?', [req.user.id]);
    const all = [];
    for (const row of rows) {
      all.push(...listAssetsInProject(row.id).map((asset) => ({ ...asset, projectUuid: String(row.id) })));
    }
    res.json(all);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/backup/export', async (req, res, next) => {
  try {
    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE owner_id = ? ORDER BY updated_at DESC',
      [req.user.id]
    );
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: rows.map(projectFromCanvasRow)
    };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tapflow-backup-${timestamp}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/backup/import', upload.single('backup'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: '请选择备份文件' });
      return;
    }
    const raw = fs.readFileSync(req.file.path, 'utf8');
    fs.rmSync(req.file.path, { force: true });
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.status(400).json({ error: '当前只支持导入 JSON 备份文件' });
      return;
    }
    const projects = Array.isArray(payload.projects) ? payload.projects : [];
    let imported = 0;
    for (const project of projects) {
      const name = cleanProjectName(`${project.projectMeta?.name || '导入项目'} - 导入`);
      const data = projectDataFor('pending', {
        nodeList: Array.isArray(project.nodeList) ? project.nodeList : [],
        projectDraft: project.projectDraft || defaultProjectDraft('pending'),
        coverUrl: project.projectMeta?.coverUrl || ''
      });
      const [result] = await getPool().query(
        'INSERT INTO canvases (owner_id, title, data) VALUES (?, ?, ?)',
        [req.user.id, name, JSON.stringify(data)]
      );
      data.projectDraft = { ...defaultProjectDraft(result.insertId, data), projectUuid: String(result.insertId) };
      data.nodeList = data.nodeList.map((node) => ({ ...node, projectUuid: String(result.insertId) }));
      await saveCanvasData(result.insertId, data);
      imported += 1;
    }
    res.json({ message: `已导入 ${imported} 个项目` });
  } catch (error) {
    next(error);
  }
});

assetRouter.get('/:projectUuid/:filename', async (req, res, next) => {
  try {
    const row = await getCanvasForUser(req, req.params.projectUuid);
    if (!row) {
      res.status(404).end();
      return;
    }
    const filePath = path.join(assetsDir(req.params.projectUuid), path.basename(req.params.filename));
    if (!fs.existsSync(filePath)) {
      res.status(404).end();
      return;
    }
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

let cachedMivoToken = null;
let mivoTokenPromise = null;
const mivoBaseUrl = config.mivoBaseUrl || 'https://aigc.xindong.com';
const llmBaseUrl = config.llmBaseUrl || 'https://llm-proxy.tapsvc.com';

function requireMivoKey() {
  if (!config.mivoApiKey) throw new Error('Mivo API Key 未配置');
}

function requireLlmKey() {
  if (!config.llmApiKey) throw new Error('LLM API Key 未配置');
}

async function fetchMivoToken() {
  requireMivoKey();
  const response = await axios.post(
    `${mivoBaseUrl}/api/v1/state/token`,
    { id: '', sub: config.mivoApiKey, name: '' },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const { session, expiresAt } = response.data;
  cachedMivoToken = { session, expiresAt: expiresAt || Date.now() + 30 * 24 * 60 * 60 * 1000 };
  return session;
}

async function getMivoToken() {
  if (cachedMivoToken && Date.now() < cachedMivoToken.expiresAt - 60_000) return cachedMivoToken.session;
  if (mivoTokenPromise) return mivoTokenPromise;
  mivoTokenPromise = fetchMivoToken().finally(() => {
    mivoTokenPromise = null;
  });
  return mivoTokenPromise;
}

async function mivoHttp() {
  const session = await getMivoToken();
  return axios.create({
    baseURL: mivoBaseUrl,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` }
  });
}

const chatSessions = {};

async function getChatSession(chatType) {
  if (chatSessions[chatType]) return chatSessions[chatType];
  const client = await mivoHttp();
  const response = await client.post('/api/v1/message/chat', { type: chatType });
  chatSessions[chatType] = response.data.object_id || response.data.id;
  return chatSessions[chatType];
}

async function createMivoMessage(payload, chatType, messageType, modelType, modelVersion, action = 'mcp') {
  const client = await mivoHttp();
  const chatSessionId = await getChatSession(chatType);
  const normalizedPayload = modelType === 'NANOBANANA' ? { ...payload, provider: 'genai' } : payload;
  const response = await client.post('/api/v1/message', {
    chatSessionId,
    messageType,
    modelType,
    modelFormat: { version: modelVersion },
    action,
    payload: normalizedPayload
  });
  return response.data.object_id || response.data.id;
}

function isGptImageModel(model) {
  return model === 'gpt-image-2' || String(model || '').toLowerCase().startsWith('gpt');
}

async function submitGenImage(params) {
  const model = params.model || 'gemini-3-pro-image-preview';
  const ratio = params.ratio || '1:1';
  const resolution = params.resolution || '1K';
  let modelType;
  let payload;

  if (isGptImageModel(model)) {
    modelType = 'GPT';
    payload = {
      prompt: params.prompt,
      imgRatio: ratio,
      quality: params.quality || 'auto',
      modelVersion: 'gpt-image-2',
      n: params.count || 1
    };
  } else {
    modelType = 'NANOBANANA';
    payload = {
      prompt: params.prompt,
      imgRatio: ratio,
      resolution,
      modelVersion: model,
      n: params.count || 1
    };
  }

  if (params.images?.length) payload.images = params.images;
  return createMivoMessage(payload, 'freeform', 'image', modelType, model);
}

async function submitGenAudio(params) {
  const model = params.model || 'tts-default';
  return createMivoMessage(
    { prompt: params.prompt || '', type: params.type || 'tts', voice: params.voice || 'default', modelVersion: model },
    'freeform',
    'text',
    'ALICLOUD',
    model
  );
}

async function pollMivoResult(jobId) {
  const client = await mivoHttp();
  const response = await client.get(`/api/v1/message/${jobId}`);
  const data = response.data;
  const content = data.content || {};
  const statusText = content.status || data.status || 'processing';
  const statusMap = { pending: 0, processing: 1, completed: 2, failed: 3 };
  let urls = [];
  if (Array.isArray(content.images) && content.images.length) urls = content.images;
  else if (Array.isArray(content.video_files) && content.video_files.length) urls = content.video_files;
  else if (Array.isArray(content.videos) && content.videos.length) {
    urls = content.videos.map((video) => video.object_id || video._id || video.fileId || video.id || '').filter(Boolean);
  } else if (Array.isArray(content.files) && content.files.length) urls = content.files;

  urls = urls.map((url) => (String(url).startsWith('http') ? url : `${mivoBaseUrl}/api/v1/file/image/${url}`));
  const status = statusMap[statusText] ?? 1;
  return {
    status,
    progressPercent: status === 2 ? 100 : status === 1 ? content.progress || 50 : 0,
    urls,
    error: data.error || content.error
  };
}

async function uploadFileToMivo(filePath) {
  const session = await getMivoToken();
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath), path.basename(filePath));
  const response = await axios.post(`${mivoBaseUrl}/api/v1/file/`, formData, {
    headers: { ...formData.getHeaders(), Authorization: `Bearer ${session}` }
  });
  const items = Array.isArray(response.data) ? response.data : [response.data];
  const fileId = items[0]?.object_id || items[0]?._id;
  if (!fileId) throw new Error('上传到 Mivo 失败，未返回 fileId');
  return fileId;
}

async function downloadMivoFile(fileId, savePath) {
  const session = await getMivoToken();
  const response = await axios.get(`${mivoBaseUrl}/api/v1/file/download/${fileId}`, {
    responseType: 'stream',
    headers: { Authorization: `Bearer ${session}` }
  });
  const contentType = response.headers['content-type'] || 'image/png';
  const ext = contentType.split('/')[1]?.split(';')[0] || 'png';
  const filePath = `${savePath}.${ext}`;
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  return filePath;
}

function fileIdFromUrl(url) {
  return String(url).split('/').pop() || String(url);
}

function isMivoObjectId(value) {
  return /^[0-9a-f]{24}$/.test(String(value));
}

async function resolveToMivoRef(url, projectUuid) {
  if (!url) return '';
  if (String(url).startsWith('http')) {
    const last = fileIdFromUrl(url);
    return isMivoObjectId(last) ? last : url;
  }
  const filename = path.basename(url);
  const stem = filename.replace(/\.[^.]+$/, '');
  if (isMivoObjectId(stem)) return stem;
  const localPath = path.join(assetsDir(projectUuid), filename);
  return uploadFileToMivo(localPath);
}

async function downloadToAssets(urls, projectUuid) {
  const localUrls = [];
  for (const url of urls || []) {
    try {
      const fileId = fileIdFromUrl(url);
      const savePath = path.join(assetsDir(projectUuid), fileId);
      const localPath = await downloadMivoFile(fileId, savePath);
      localUrls.push(`/assets/${projectUuid}/${path.basename(localPath)}`);
    } catch (error) {
      console.error('download asset failed', url, error);
      localUrls.push(url);
    }
  }
  return localUrls;
}

function seedanceContent(params) {
  const mode = params.modeType || 't2v';
  const images = params.images || [];
  const textItem = { type: 'text', text: params.prompt || '' };
  if (mode === 'text2video' || mode === 't2v' || images.length === 0) return [textItem];
  if (mode === 'image2video' || mode === 'i2v') {
    return [textItem, { type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' }];
  }
  if (mode === 'keyframe') {
    const items = [textItem, { type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' }];
    if (images[1]) items.push({ type: 'image_url', image_url: { url: images[1] }, role: 'last_frame' });
    return items;
  }
  return [textItem, ...images.map((url) => ({ type: 'image_url', image_url: { url }, role: 'reference_image' }))];
}

async function submitSeedanceVideo(params) {
  requireLlmKey();
  const modelMap = {
    Seedance_2_0: 'doubao-seedance-2-0-260128',
    Seedance_2_0_Fast: 'doubao-seedance-2-0-fast-260128',
    'doubao-seedance-2-0-260128': 'doubao-seedance-2-0-260128',
    'doubao-seedance-2-0-fast-260128': 'doubao-seedance-2-0-fast-260128'
  };
  const body = {
    model: modelMap[params.model] || 'doubao-seedance-2-0-260128',
    content: seedanceContent(params),
    resolution: String(params.resolution || '720P').toLowerCase(),
    ratio: params.ratio === 'auto' ? '16:9' : params.ratio || '16:9',
    duration: Number(params.duration || 5),
    generate_audio: params.enableSound !== 'off',
    watermark: false
  };
  const response = await axios.post(`${llmBaseUrl}/volcengine/api/v3/contents/generations/tasks`, body, {
    headers: { Authorization: `Bearer ${config.llmApiKey}`, 'Content-Type': 'application/json' },
    timeout: 60_000
  });
  const taskId = response.data?.id || response.data?.task_id;
  if (!taskId) throw new Error(`Seedance 未返回 task_id: ${JSON.stringify(response.data)}`);
  return taskId;
}

function extractVideoUrl(data) {
  const content = data.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const videoUrl = content.video_url;
    if (typeof videoUrl === 'string' && videoUrl) return videoUrl;
    if (videoUrl && typeof videoUrl === 'object') return videoUrl.url || null;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'video_url') {
        if (typeof item.video_url === 'string' && item.video_url) return item.video_url;
        if (item.video_url && typeof item.video_url === 'object') return item.video_url.url || null;
      }
    }
  }
  const output = data.output;
  if (output && typeof output === 'object') {
    const videoUrl = output.video_url;
    if (typeof videoUrl === 'string' && videoUrl) return videoUrl;
    if (videoUrl && typeof videoUrl === 'object') return videoUrl.url || null;
  }
  return null;
}

async function pollSeedanceResult(taskId) {
  requireLlmKey();
  const response = await axios.get(`${llmBaseUrl}/volcengine/api/v3/contents/generations/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${config.llmApiKey}` },
    timeout: 30_000
  });
  const data = response.data || {};
  if (data.status === 'succeeded') {
    const videoUrl = extractVideoUrl(data);
    return { status: 2, progressPercent: 100, urls: videoUrl ? [videoUrl] : [] };
  }
  if (data.status === 'failed') {
    return { status: 3, progressPercent: 0, error: data.message || data.error || 'Seedance 任务失败' };
  }
  return { status: data.status === 'running' ? 1 : 0, progressPercent: 30 };
}

async function resolveImageUrlForLLM(url, projectUuid) {
  if (!url || !String(url).startsWith('/assets/')) return null;
  const localPath = path.join(assetsDir(projectUuid), path.basename(url));
  if (!fs.existsSync(localPath)) return null;
  const sharp = getSharp();
  try {
    if (sharp) {
      const buffer = await sharp(localPath).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }
  } catch {
    // Fall back to raw base64 below.
  }
  const buffer = fs.readFileSync(localPath);
  if (buffer.length > 1.5 * 1024 * 1024) return null;
  const ext = path.extname(localPath).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function* chatStream(messages, model, signal) {
  requireLlmKey();
  const payload = { model, messages, max_tokens: 4096, stream: true };
  if (!String(model).startsWith('gpt-5')) payload.temperature = 0.7;
  const response = await axios.post(`${llmBaseUrl}/v1/chat/completions`, payload, {
    headers: { Authorization: `Bearer ${config.llmApiKey}`, 'Content-Type': 'application/json' },
    responseType: 'stream',
    timeout: 300_000,
    signal
  });
  let buffer = '';
  for await (const chunk of response.data) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (raw === '[DONE]') return;
      try {
        const parsed = JSON.parse(raw);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) yield delta;
      } catch {
        // skip malformed chunks
      }
    }
  }
}

function pollAndStore(jobId, internalId, projectUuid, pollFn = pollMivoResult) {
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts += 1;
    if (attempts > 200) {
      clearInterval(interval);
      return;
    }
    try {
      const result = await pollFn(jobId);
      if (result.status === 2 && result.urls?.length) {
        clearInterval(interval);
        tasks[internalId] = { status: 2, progressPercent: 100, urls: await downloadToAssets(result.urls, projectUuid) };
      } else if (result.status === 3) {
        clearInterval(interval);
        tasks[internalId] = { status: 3, progressPercent: 0, error: result.error };
      } else {
        tasks[internalId] = { status: result.status, progressPercent: result.progressPercent };
      }
    } catch (error) {
      console.error('poll error', error);
    }
  }, 3000);
}

apiRouter.post('/generate/image', async (req, res) => {
  try {
    const { projectUuid, params } = req.body;
    const row = await getCanvasForUser(req, projectUuid);
    if (!row) return res.status(404).json({ error: '项目不存在' });
    const settings = params.settings || {};
    const imageList = params.imageList || [];
    const promptChips = params.promptChips || [];
    const refUrls = [...new Set([...imageList, ...promptChips].map((item) => item.url).filter(Boolean))];
    const images = (await Promise.all(refUrls.map((url) => resolveToMivoRef(url, projectUuid)))).filter(Boolean);
    const jobId = await submitGenImage({
      prompt: params.prompt || '',
      model: params.model,
      ratio: settings.ratio || '1:1',
      resolution: settings.resolution || '1K',
      quality: settings.quality || 'auto',
      count: Number(params.count || 1),
      images
    });
    const internalId = randomId();
    tasks[internalId] = { status: 1, progressPercent: 0 };
    pollAndStore(jobId, internalId, projectUuid);
    res.json({ jobId: internalId });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

apiRouter.post('/generate/video', async (req, res) => {
  try {
    const { projectUuid, params } = req.body;
    const row = await getCanvasForUser(req, projectUuid);
    if (!row) return res.status(404).json({ error: '项目不存在' });
    const settings = params.settings || {};
    const imageList = params.imageList || [];
    const images = (await Promise.all(imageList.filter((item) => item.url).map((item) => resolveImageUrlForLLM(item.url, projectUuid)))).filter(Boolean);
    const jobId = await submitSeedanceVideo({
      prompt: params.prompt || '',
      model: params.model,
      modeType: params.modeType || 't2v',
      ratio: settings.ratio || '16:9',
      duration: Number(settings.duration || 5),
      resolution: settings.resolution || '720P',
      enableSound: settings.enableSound || 'on',
      images
    });
    const internalId = randomId();
    tasks[internalId] = { status: 1, progressPercent: 0 };
    pollAndStore(jobId, internalId, projectUuid, pollSeedanceResult);
    res.json({ jobId: internalId });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

apiRouter.post('/generate/audio', async (req, res) => {
  try {
    const { projectUuid, params } = req.body;
    const row = await getCanvasForUser(req, projectUuid);
    if (!row) return res.status(404).json({ error: '项目不存在' });
    const jobId = await submitGenAudio(params || {});
    const internalId = randomId();
    tasks[internalId] = { status: 1, progressPercent: 0 };
    pollAndStore(jobId, internalId, projectUuid);
    res.json({ jobId: internalId });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

apiRouter.post('/generate/script', async (req, res) => {
  try {
    const prompt = req.body.params?.description || '';
    const client = await mivoHttp();
    const response = await client.post('/api/v1/translate', {
      text: `生成视频故事板JSON数组，包含字段 shot/sceneType/action/dialogue/duration，描述：${prompt}`,
      targetLang: 'en'
    });
    res.json({ text: response.data?.data?.translated || response.data?.translated || '' });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

apiRouter.post('/generate/translate', async (req, res) => {
  try {
    const client = await mivoHttp();
    const response = await client.post('/api/v1/translate', { text: req.body.text || '', targetLang: 'en' });
    res.json({ translated: response.data?.data?.translated || response.data?.translated || req.body.text || '' });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

apiRouter.post('/generate/llm', async (req, res) => {
  try {
    const { projectUuid, params } = req.body;
    const row = await getCanvasForUser(req, projectUuid);
    if (!row) return res.status(404).json({ error: '项目不存在' });
    const imageUrls = await Promise.all((params.imageList || []).filter((item) => item.url).map((item) => resolveImageUrlForLLM(item.url, projectUuid)));
    const videoUrls = await Promise.all((params.videoList || []).filter((item) => item.url).map((item) => resolveImageUrlForLLM(item.url, projectUuid)));
    const textContext = (params.textList || [])
      .filter((item) => item.content)
      .map((item, index) => `[引用文本${index + 1}]：${item.content}`)
      .join('\n');
    const content = [];
    if (textContext) content.push({ type: 'text', text: `${textContext}\n` });
    content.push(...imageUrls.flatMap((url) => (url ? [{ type: 'image_url', image_url: { url } }] : [])));
    content.push(...videoUrls.flatMap((url) => (url ? [{ type: 'image_url', image_url: { url } }] : [])));
    content.push({ type: 'text', text: params.prompt || '请根据上面的素材生成内容' });
    const messages = [
      { role: 'system', content: '你是创意助手，请根据用户的指令和提供的参考素材生成文字内容。' },
      { role: 'user', content }
    ];

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const abortController = new AbortController();
    res.on('close', () => abortController.abort());
    try {
      for await (const delta of chatStream(messages, params.model || 'gpt-5.5', abortController.signal)) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
    } catch (error) {
      if (error.name !== 'AbortError') res.write(`data: ${JSON.stringify({ error: error.message || String(error) })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message || String(error) });
  }
});

apiRouter.get('/tasks/:jobId', (req, res) => {
  const task = tasks[req.params.jobId];
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
});

function startToolJob(fn, id, projectUuid) {
  tasks[id] = { status: 1, progressPercent: 0 };
  fn()
    .then((jobId) => pollAndStore(jobId, id, projectUuid))
    .catch((error) => {
      tasks[id] = { status: 3, progressPercent: 0, error: error.message || String(error) };
    });
}

apiRouter.post('/toolbox/super-resolution', async (req, res) => {
  const id = randomId();
  startToolJob(async () => {
    const image = await resolveToMivoRef(req.body.imageUrl, req.body.projectUuid);
    const client = await mivoHttp();
    const response = await client.post('/api/v1/super-resolution', { image });
    return response.data?.data?.jobId || response.data?.jobId || response.data?.object_id;
  }, id, req.body.projectUuid);
  res.json({ jobId: id });
});

apiRouter.post('/toolbox/panorama', async (req, res) => {
  const id = randomId();
  startToolJob(async () => {
    const image = await resolveToMivoRef(req.body.imageUrl, req.body.projectUuid);
    const client = await mivoHttp();
    const response = await client.post('/api/v1/panorama', { image });
    return response.data?.data?.jobId || response.data?.jobId || response.data?.object_id;
  }, id, req.body.projectUuid);
  res.json({ jobId: id });
});

apiRouter.post('/toolbox/multi-angle', async (req, res) => {
  const id = randomId();
  startToolJob(async () => {
    const image = await resolveToMivoRef(req.body.imageUrl, req.body.projectUuid);
    return submitGenImage({
      prompt: '从不同角度重新生成，保持主体一致',
      images: [image],
      count: 4,
      model: 'gemini-3-pro-image-preview'
    });
  }, id, req.body.projectUuid);
  res.json({ jobId: id });
});

apiRouter.post('/toolbox/lighting', async (req, res) => {
  const id = randomId();
  startToolJob(async () => {
    const image = await resolveToMivoRef(req.body.imageUrl, req.body.projectUuid);
    const client = await mivoHttp();
    const response = await client.post('/api/v1/relighting', { image, style: req.body.style });
    return response.data?.data?.jobId || response.data?.jobId || response.data?.object_id;
  }, id, req.body.projectUuid);
  res.json({ jobId: id });
});

apiRouter.post('/toolbox/grid', (req, res) => {
  const id = randomId();
  startToolJob(async () => {
    const image = await resolveToMivoRef(req.body.imageUrl, req.body.projectUuid);
    return submitGenImage({
      prompt: `将图片排列为 ${req.body.cols || 3}x${req.body.cols || 3} 宫格`,
      images: [image],
      model: 'gemini-3-pro-image-preview'
    });
  }, id, req.body.projectUuid);
  res.json({ jobId: id });
});

apiRouter.post('/toolbox/split-grid', (req, res) => {
  const cols = Number(req.body.cols || 3);
  const rows = Number(req.body.rows || 3);
  res.json({ nodeKeys: Array.from({ length: cols * rows }, randomId) });
});

module.exports = {
  apiRouter,
  assetRouter
};
