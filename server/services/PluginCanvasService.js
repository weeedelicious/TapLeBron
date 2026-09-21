const crypto = require('crypto');
const config = require('../config');
const imageRules = require('../../src/shared/image-model-rules.json');
const videoRules = require('../../src/shared/seedance-video-rules.json');
const { getPool } = require('../db');
const { getDefaultProjectCatalogRow, getProjectCatalogRowById } = require('../projectCatalog');
const { hydrateCanvasRow, parseJsonDocument, saveCanvasData } = require('./CanvasService');
const { queueCanvasMutation } = require('./CanvasMutationQueue');
const { publishCanvasChange } = require('./CanvasRealtimeService');

const NODE_TYPE_INT = Object.freeze({ text: 1, image: 2, video: 3, audio: 6 });
const NODE_LABELS = Object.freeze({ text: '文本', image: '图片', video: '视频', audio: '音频' });
const NODE_SIZE = Object.freeze({
  text: { width: 620, height: 350 },
  image: { width: 520, height: 520 },
  video: { width: 520, height: 520 },
  audio: { width: 520, height: 300 },
});
const MAX_NODE_BATCH = 20;
const MAX_CONNECTION_BATCH = 50;
const EDITABLE_NODE_FIELDS = new Set([
  'name',
  'prompt',
  'content',
  'model',
  'x',
  'y',
  'width',
  'height',
  'settings',
  'displayStyle',
]);

function serviceError(message, code, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanString(value, maxLength, fallback = '') {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maxLength);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(-1_000_000, Math.min(1_000_000, number)) : fallback;
}

function positiveSize(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(80, Math.min(4_000, number)) : fallback;
}

function parseNodeData(node) {
  try {
    const parsed = typeof node?.data === 'string' ? JSON.parse(node.data) : node?.data;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function canvasDataFromRow(row) {
  return parseJsonDocument(row?.data, {});
}

function nodeListFromData(data) {
  return Array.isArray(data?.nodeList) ? data.nodeList : [];
}

function canvasRevision(data) {
  return sha1(JSON.stringify(data || {}));
}

function defaultParams(type) {
  if (type === 'text') {
    return {
      content: '',
      model: config.defaultChatModel,
      thinkingMode: 'fast',
      performanceMode: 'highest',
      reasoningEffort: 'high',
      prompt: '',
      imageList: [],
      videoList: [],
      textList: [],
      displayStyle: { fontSize: 16, lineHeight: 1.75, color: '#f3f0ff' },
    };
  }
  if (type === 'image') {
    return {
      prompt: '',
      model: imageRules.defaults.model,
      count: imageRules.defaults.count,
      settings: {
        quality: imageRules.defaults.quality,
        ratio: imageRules.defaults.ratio,
        resolution: imageRules.defaults.resolution,
      },
      modeType: 'text2image',
      imageList: [],
      imageListOrder: [],
      videoList: [],
      audioList: [],
      textList: [],
    };
  }
  if (type === 'video') {
    return {
      prompt: '',
      model: videoRules.defaults.model,
      modeType: videoRules.defaults.mode,
      count: videoRules.defaults.count,
      imageList: [],
      imageListOrder: [],
      mixedList: [],
      mixedListOrder: [],
      videoList: [],
      audioList: [],
      textList: [],
      settings: {
        ratio: videoRules.defaults.ratio,
        resolution: videoRules.defaults.resolution,
        duration: videoRules.defaults.duration,
        enableSound: videoRules.defaults.enableSound,
      },
    };
  }
  return { type: 'tts', prompt: '', model: 'tts-default', voice: 'default', speed: 1 };
}

function nodeAction(type) {
  if (type === 'image') return 'image_generate';
  if (type === 'video') return 'video_generate';
  if (type === 'audio') return 'audio_generate';
  return 'text_node';
}

function cleanSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (['string', 'number', 'boolean'].includes(typeof item) || item === null) result[key] = item;
  }
  if (JSON.stringify(result).length > 8_000) {
    throw serviceError('Node settings are too large', 'PLUGIN_NODE_SETTINGS_TOO_LARGE');
  }
  return result;
}

function applySpecToNodeData(baseData, type, spec, nodeKey, projectUuid) {
  const data = {
    type,
    name: cleanString(spec.name ?? baseData.name, 160, NODE_LABELS[type]),
    url: Array.isArray(baseData.url) ? baseData.url : [],
    action: baseData.action || nodeAction(type),
    params: {
      ...defaultParams(type),
      ...(baseData.params && typeof baseData.params === 'object' && !Array.isArray(baseData.params)
        ? baseData.params
        : {}),
    },
    ...baseData,
    nodeKey,
    projectUuid: String(projectUuid),
  };
  data.type = type;
  data.name = cleanString(spec.name ?? data.name, 160, NODE_LABELS[type]);
  data.action = nodeAction(type);
  data.url = Array.isArray(data.url) ? data.url : [];

  const params = { ...(data.params || {}) };
  if (spec.prompt !== undefined) params.prompt = cleanString(spec.prompt, 20_000);
  if (type === 'text' && spec.content !== undefined) params.content = cleanString(spec.content, 100_000);
  if (spec.model !== undefined) params.model = cleanString(spec.model, 160, params.model || '');
  if (spec.settings !== undefined) {
    const settings = cleanSettings(spec.settings);
    if (settings) params.settings = { ...(params.settings || {}), ...settings };
  }
  if (type === 'text' && spec.displayStyle !== undefined) {
    const displayStyle = cleanSettings(spec.displayStyle);
    if (displayStyle) params.displayStyle = { ...(params.displayStyle || {}), ...displayStyle };
  }
  data.params = params;
  data._updatedAtMs = Date.now();
  return data;
}

function nodeType(node) {
  const data = parseNodeData(node);
  const type = String(data.type || '').trim();
  return NODE_TYPE_INT[type] ? type : null;
}

function summarizeNode(node) {
  const data = parseNodeData(node);
  const params = data.params && typeof data.params === 'object' ? data.params : {};
  const type = String(data.type || 'unknown');
  return {
    key: String(node.nodeKey || data.nodeKey || ''),
    type,
    name: String(data.name || node.name || ''),
    position: {
      x: Number(node.position?.positionX || 0),
      y: Number(node.position?.positionY || 0),
    },
    size: {
      width: Number(node.measured?.width || 0),
      height: Number(node.measured?.height || 0),
    },
    prompt: typeof params.prompt === 'string' ? params.prompt.slice(0, 2_000) : '',
    content: type === 'text' && typeof params.content === 'string' ? params.content.slice(0, 4_000) : '',
    model: typeof params.model === 'string' ? params.model : '',
    urls: Array.isArray(data.url) ? data.url.slice(0, 8).map(String) : [],
  };
}

function primaryOutputUrlFromNodeData(data) {
  const urls = Array.isArray(data?.url)
    ? data.url.filter((url) => typeof url === 'string' && url.trim())
    : [];
  const primary = typeof data?._primaryAssetUrl === 'string' ? data._primaryAssetUrl : '';
  return urls.includes(primary) ? primary : String(urls[0] || '');
}

function nodeKeyFromRecord(node) {
  const data = parseNodeData(node);
  return String(node?.nodeKey || data.nodeKey || '');
}

function resolveGenerationParams(rawParams, nodes) {
  const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
    ? jsonClone(rawParams)
    : {};
  const byKey = new Map();
  for (const node of nodes) {
    const key = nodeKeyFromRecord(node);
    if (key) byKey.set(key, node);
  }

  const liveUrls = new Map();
  const resolveMediaRefs = (value, mediaType) => (Array.isArray(value) ? value : [])
    .map((item) => {
      const ref = typeof item === 'string' ? { nodeId: item } : { ...(item || {}) };
      const nodeId = String(ref.nodeId || '');
      const sourceData = parseNodeData(byKey.get(nodeId));
      const liveUrl = primaryOutputUrlFromNodeData(sourceData);
      const fallbackUrl = typeof ref.url === 'string' ? ref.url : '';
      const url = liveUrl || fallbackUrl;
      if (nodeId && url) liveUrls.set(nodeId, url);
      return { ...ref, nodeId, url, ...(mediaType ? { mediaType } : {}) };
    })
    .filter((ref) => ref.nodeId || ref.url);

  params.imageList = resolveMediaRefs(params.imageList, 'image');
  params.videoList = resolveMediaRefs(params.videoList, 'video');
  params.audioList = resolveMediaRefs(params.audioList, 'audio');
  if (Array.isArray(params.mixedList)) params.mixedList = resolveMediaRefs(params.mixedList);

  if (Array.isArray(params.promptChips)) {
    params.promptChips = params.promptChips.map((item) => {
      const chip = { ...(item || {}) };
      const liveUrl = liveUrls.get(String(chip.nodeId || ''));
      return liveUrl ? { ...chip, url: liveUrl } : chip;
    });
  }

  if (!String(params.prompt || '').trim() && Array.isArray(params.textList)) {
    const seen = new Set();
    const chunks = [];
    for (const item of params.textList) {
      const ref = typeof item === 'string' ? { nodeId: item } : (item || {});
      const nodeId = String(ref.nodeId || '');
      if (!nodeId || seen.has(nodeId)) continue;
      seen.add(nodeId);
      const sourceData = parseNodeData(byKey.get(nodeId));
      const sourceParams = sourceData.params && typeof sourceData.params === 'object' ? sourceData.params : {};
      const text = String(sourceParams.content || sourceParams.prompt || ref.content || '').trim();
      if (text) chunks.push(text);
    }
    if (chunks.length) params.prompt = chunks.join('\n\n');
  }

  return params;
}

function connectionsFromNodes(nodes) {
  const knownKeys = new Set(nodes.map((node) => String(node.nodeKey || '')).filter(Boolean));
  const seen = new Set();
  const connections = [];
  for (const target of nodes) {
    const targetKey = String(target.nodeKey || '');
    const params = parseNodeData(target).params || {};
    for (const listKey of ['imageList', 'videoList', 'audioList', 'textList', 'mixedList']) {
      const refs = Array.isArray(params[listKey]) ? params[listKey] : [];
      for (const ref of refs) {
        const sourceKey = typeof ref === 'string' ? ref : String(ref?.nodeId || '');
        const pair = `${sourceKey}->${targetKey}`;
        if (!sourceKey || !targetKey || !knownKeys.has(sourceKey) || seen.has(pair)) continue;
        seen.add(pair);
        connections.push({ sourceNodeKey: sourceKey, targetNodeKey: targetKey });
      }
    }
  }
  return connections;
}

function canvasSummaryFromRow(row) {
  const data = canvasDataFromRow(row);
  const nodes = nodeListFromData(data);
  return {
    canvas: {
      id: String(row.id),
      name: row.title,
      nodeCount: nodes.length,
      assignedProjectId: row.project_id != null ? String(row.project_id) : null,
      assignedProjectName: row.project_name || null,
      updatedAt: new Date(row.content_updated_at || row.updated_at).toISOString(),
    },
    revision: canvasRevision(data),
    projectDraft: data.projectDraft || {},
    nodes: nodes.map(summarizeNode),
    connections: connectionsFromNodes(nodes),
  };
}

async function loadCanvasRow(userId, canvasId, options = {}) {
  const numericCanvasId = Number(canvasId);
  if (!Number.isFinite(numericCanvasId) || numericCanvasId <= 0) return null;
  const [rows] = await getPool().query(
    `SELECT
       c.id,
       c.owner_id,
       c.collection_id,
       c.project_id,
       c.title,
       c.data,
       c.cover_url,
       c.node_count,
       c.shared,
       c.canvas_role,
       c.created_at,
       c.updated_at,
       cp.name AS project_name
     FROM canvases c
     LEFT JOIN canvas_projects cp ON cp.id = c.project_id
     WHERE c.id = ?
       AND c.canvas_role = 'normal'
       AND ${options.write ? 'c.owner_id = ?' : '(c.owner_id = ? OR c.shared = 1)'}
     LIMIT 1`,
    [numericCanvasId, Number(userId)]
  );
  return hydrateCanvasRow(rows[0] || null);
}

async function listCanvasesForPlugin(userId, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 30));
  const search = cleanString(options.search, 160);
  const params = [Number(userId)];
  let where = "c.owner_id = ? AND c.canvas_role = 'normal'";
  if (search) {
    where += ' AND c.title LIKE ?';
    params.push(`%${search}%`);
  }
  params.push(limit);
  const [rows] = await getPool().query(
    `SELECT
       c.id,
       c.title,
       c.node_count,
       c.project_id,
       c.created_at,
       c.updated_at,
       cp.name AS project_name
     FROM canvases c
     LEFT JOIN canvas_projects cp ON cp.id = c.project_id
     WHERE ${where}
     ORDER BY c.updated_at DESC, c.id DESC
     LIMIT ?`,
    params
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: row.title,
    nodeCount: Number(row.node_count || 0),
    assignedProjectId: row.project_id != null ? String(row.project_id) : null,
    assignedProjectName: row.project_name || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

async function getCanvasSummary(userId, canvasId) {
  const row = await loadCanvasRow(userId, canvasId, { write: false });
  if (!row) throw serviceError('Canvas not found', 'PLUGIN_CANVAS_NOT_FOUND', 404);
  return canvasSummaryFromRow(row);
}

async function getGenerationNodeForPlugin(userId, canvasId, requestedNodeKey) {
  const row = await loadCanvasRow(userId, canvasId, { write: true });
  if (!row) throw serviceError('Canvas not found', 'PLUGIN_CANVAS_NOT_FOUND', 404);
  const data = canvasDataFromRow(row);
  const nodes = nodeListFromData(data);
  const node = nodes.find((item) =>
    String(item.nodeKey || parseNodeData(item).nodeKey || '') === String(requestedNodeKey || '')
  );
  if (!node) throw serviceError('Node not found', 'PLUGIN_NODE_NOT_FOUND', 404);
  const parsed = parseNodeData(node);
  const type = String(parsed.type || '');
  if (!['image', 'video'].includes(type)) {
    throw serviceError('Only image and video nodes can be generated from Cindy', 'PLUGIN_NODE_NOT_GENERATABLE', 400);
  }
  // The browser resolves connected node ids to each upstream node's current
  // primary output immediately before generation. Cindy has no open browser,
  // so do the same on the server; otherwise valid connections silently arrive
  // at the provider with empty URLs and spend credits on the wrong request.
  const params = resolveGenerationParams(parsed.params, nodes);
  const configHash = sha1(JSON.stringify({ type, params }));
  return {
    canvas: { id: String(row.id), name: row.title, ownerId: Number(row.owner_id) },
    node: {
      key: String(node.nodeKey || parsed.nodeKey || ''),
      type,
      name: String(parsed.name || node.name || ''),
      params,
      configHash,
    },
  };
}

async function uniqueCanvasName(userId, requestedName) {
  const base = cleanString(requestedName, 160, 'Cindy 画布');
  const [rows] = await getPool().query('SELECT title FROM canvases WHERE owner_id = ?', [Number(userId)]);
  const existing = new Set(rows.map((row) => String(row.title || '')));
  if (!existing.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${base.slice(0, 160 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw serviceError('Could not allocate a unique canvas name', 'PLUGIN_CANVAS_NAME_CONFLICT', 409);
}

async function createCanvasForPlugin(userId, options = {}) {
  const assignedProject = options.assignedProjectId
    ? await getProjectCatalogRowById(options.assignedProjectId)
    : await getDefaultProjectCatalogRow();
  if (!assignedProject) {
    throw serviceError('Assigned project not found', 'PLUGIN_ASSIGNED_PROJECT_NOT_FOUND', 404);
  }
  const name = await uniqueCanvasName(userId, options.name);
  const pendingData = {
    nodeList: [],
    projectDraft: {
      projectUuid: 'pending',
      viewportX: 0,
      viewportY: 0,
      viewportZoom: 1,
      canvasTextScale: 1,
      lastEditedAtMs: Date.now(),
    },
  };
  const [result] = await getPool().query(
    `INSERT INTO canvases
      (owner_id, collection_id, project_id, title, data, shared, canvas_role)
     VALUES (?, NULL, ?, ?, ?, 0, 'normal')`,
    [Number(userId), assignedProject.id, name, JSON.stringify(pendingData)]
  );
  const data = {
    ...pendingData,
    projectDraft: { ...pendingData.projectDraft, projectUuid: String(result.insertId) },
  };
  await saveCanvasData(result.insertId, data, {
    reason: 'plugin_create',
    ownerId: Number(userId),
    createdBy: Number(userId),
    cooldownMs: 0,
  });
  return getCanvasSummary(userId, result.insertId);
}

function requireExpectedRevision(expectedRevision) {
  const suppliedRevision = String(expectedRevision || '').trim();
  if (!suppliedRevision) {
    throw serviceError(
      'expectedRevision is required. Reload the canvas summary before editing.',
      'PLUGIN_CANVAS_REVISION_REQUIRED'
    );
  }
  if (!/^[a-f0-9]{40}$/.test(suppliedRevision)) {
    throw serviceError('expectedRevision is invalid', 'INVALID_PLUGIN_CANVAS_REVISION');
  }
  return suppliedRevision;
}

async function loadRevisionCheckedCanvas(userId, canvasId, expectedRevision) {
  const suppliedRevision = requireExpectedRevision(expectedRevision);
  const row = await loadCanvasRow(userId, canvasId, { write: true });
  if (!row) throw serviceError('Writable canvas not found', 'PLUGIN_CANVAS_NOT_WRITABLE', 404);
  const data = canvasDataFromRow(row);
  const revision = canvasRevision(data);
  if (suppliedRevision !== revision) {
    throw serviceError(
      'Canvas changed after it was read. Reload the summary before retrying.',
      'PLUGIN_CANVAS_REVISION_CONFLICT',
      409,
      { currentRevision: revision }
    );
  }
  return { data, revision, row };
}

async function assertCanvasRevisionForPlugin(userId, canvasId, expectedRevision) {
  const checked = await loadRevisionCheckedCanvas(userId, canvasId, expectedRevision);
  return { canvasId: String(checked.row.id), revision: checked.revision };
}

function mutationNodeKeys(result) {
  const keys = [];
  const add = (value) => {
    const key = String(value || '').trim();
    if (key) keys.push(key);
  };
  if (Array.isArray(result?.created)) result.created.forEach((item) => add(item?.nodeKey));
  else add(result?.created?.nodeKey);
  add(result?.updated?.key);
  if (Array.isArray(result?.added)) result.added.forEach((item) => add(item?.targetNodeKey));
  return [...new Set(keys)];
}

async function mutateCanvas(userId, canvasId, expectedRevision, reason, mutator) {
  return queueCanvasMutation(canvasId, async () => {
    const { data, row } = await loadRevisionCheckedCanvas(userId, canvasId, expectedRevision);

    const result = await mutator(data, row);
    const previousPluginEditAtMs = Number(data.projectDraft?.lastPluginEditAtMs || 0);
    const timestamp = Math.max(
      Date.now(),
      Number.isFinite(previousPluginEditAtMs) ? previousPluginEditAtMs + 1 : 0
    );
    data.projectDraft = {
      ...(data.projectDraft || {}),
      projectUuid: String(row.id),
      viewportX: Number(data.projectDraft?.viewportX || 0),
      viewportY: Number(data.projectDraft?.viewportY || 0),
      viewportZoom: Number(data.projectDraft?.viewportZoom || 1),
      canvasTextScale: Number(data.projectDraft?.canvasTextScale || 1),
      lastEditedAtMs: timestamp,
      lastPluginEditAtMs: timestamp,
    };
    data.lastClientNodeSaveAtMs = Math.max(Number(data.lastClientNodeSaveAtMs || 0), timestamp);
    await saveCanvasData(row.id, data, {
      reason,
      ownerId: row.owner_id,
      createdBy: Number(userId),
      cooldownMs: 0,
    });
    const updatedRow = await loadCanvasRow(userId, canvasId, { write: true });
    const summary = canvasSummaryFromRow(updatedRow);
    publishCanvasChange({
      canvasId: row.id,
      source: 'cindy_plugin',
      reason,
      revision: summary.revision,
      pluginEditAtMs: timestamp,
      changedAtMs: timestamp,
      updatedBy: userId,
      changedNodeKeys: mutationNodeKeys(result),
    });
    return { ...summary, mutation: result };
  });
}

function nextNodePosition(existingNodes, index, spec) {
  const maxRight = existingNodes.reduce((max, node) => {
    const x = Number(node.position?.positionX || 0);
    const width = Number(node.measured?.width || 520);
    return Math.max(max, x + width);
  }, -140);
  const originX = existingNodes.length > 0 ? maxRight + 140 : 0;
  const originY = existingNodes.reduce(
    (min, node) => Math.min(min, Number(node.position?.positionY || 0)),
    0
  );
  return {
    x: finiteNumber(spec.x, originX + (index % 3) * 680),
    y: finiteNumber(spec.y, originY + Math.floor(index / 3) * 500),
  };
}

async function addNodesForPlugin(userId, canvasId, options = {}) {
  const specs = Array.isArray(options.nodes) ? options.nodes : [];
  if (specs.length === 0 || specs.length > MAX_NODE_BATCH) {
    throw serviceError(`nodes must contain 1-${MAX_NODE_BATCH} items`, 'INVALID_PLUGIN_NODE_BATCH');
  }
  return mutateCanvas(userId, canvasId, options.expectedRevision, 'plugin_add_nodes', async (data, row) => {
    const existingNodes = nodeListFromData(data);
    const created = [];
    const nextNodes = [];
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index] && typeof specs[index] === 'object' ? specs[index] : {};
      const type = cleanString(spec.type, 20);
      if (!NODE_TYPE_INT[type]) {
        throw serviceError(`Unsupported node type: ${type || '(empty)'}`, 'INVALID_PLUGIN_NODE_TYPE');
      }
      const nodeKey = crypto.randomUUID();
      const position = nextNodePosition(existingNodes, index, spec);
      const size = NODE_SIZE[type];
      const nodeData = applySpecToNodeData({}, type, spec, nodeKey, row.id);
      const node = {
        nodeKey,
        projectUuid: String(row.id),
        type: NODE_TYPE_INT[type],
        name: nodeData.name,
        position: { positionX: position.x, positionY: position.y },
        measured: {
          width: positiveSize(spec.width, size.width),
          height: positiveSize(spec.height, size.height),
        },
        data: JSON.stringify(nodeData),
        status: 1,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      };
      nextNodes.push(node);
      created.push({ clientId: cleanString(spec.clientId, 120) || null, nodeKey, type, name: nodeData.name });
    }
    data.nodeList = [...existingNodes, ...nextNodes];
    return { created };
  });
}

function uploadResourceMeta(asset, createdAtMs) {
  const meta = asset?.meta && typeof asset.meta === 'object' ? asset.meta : {};
  const positive = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  };
  return {
    kind: cleanString(meta.kind, 20, 'image'),
    mimeType: cleanString(meta.mimeType, 160) || undefined,
    extension: cleanString(meta.extension, 20) || undefined,
    hashSha1: cleanString(asset?.sha1 || meta.sha1, 40) || undefined,
    displayUrl: cleanString(asset?.displayUrl || meta.displayUrl, 2_000) || undefined,
    originalUrl: cleanString(meta.originalUrl || asset?.url, 2_000) || undefined,
    displayByteSize: positive(meta.displayByteSize),
    displayWidth: positive(meta.displayWidth),
    displayHeight: positive(meta.displayHeight),
    displayDurationSec: positive(meta.displayDurationSec),
    byteSize: positive(meta.byteSize),
    width: positive(meta.width),
    height: positive(meta.height),
    durationSec: positive(meta.durationSec),
    createdAtMs,
  };
}

function uploadNodeName(requestedName, asset) {
  const originalName = cleanString(asset?.originalName, 255, '上传资源');
  const withoutExtension = originalName.replace(/\.[a-z0-9]{1,10}$/i, '');
  return cleanString(requestedName, 160, withoutExtension || '上传资源');
}

async function createUploadNodeForPlugin(userId, canvasId, options = {}) {
  if (typeof options.persistAsset !== 'function') {
    throw serviceError('Upload asset persistence is unavailable', 'PLUGIN_UPLOAD_PERSISTENCE_UNAVAILABLE', 503);
  }
  return mutateCanvas(userId, canvasId, options.expectedRevision, 'plugin_upload_asset', async (data, row) => {
    const asset = await options.persistAsset(row);
    if (!asset?.url) throw serviceError('Uploaded asset URL is missing', 'PLUGIN_UPLOAD_ASSET_INVALID', 500);

    const existingNodes = nodeListFromData(data);
    const nodeKey = crypto.randomUUID();
    const position = nextNodePosition(existingNodes, 0, options);
    const createdAtMs = Number(asset.meta?.createdAtMs) || Date.now();
    const resourceMeta = uploadResourceMeta(asset, createdAtMs);
    const nodeName = uploadNodeName(options.name, asset);
    const assetUrls = [asset.url, asset.thumbUrl, resourceMeta.displayUrl, resourceMeta.originalUrl].filter(Boolean);
    const nodeData = {
      type: 'upload',
      name: nodeName,
      action: 'image_resource',
      url: [asset.url],
      nodeKey,
      projectUuid: String(row.id),
      params: resourceMeta.kind === 'image'
        ? { thumbUrls: [asset.thumbUrl || asset.url] }
        : {},
      _resourceMeta: { items: [resourceMeta] },
      _assetCreatedAtMs: Object.fromEntries(assetUrls.map((url) => [url, createdAtMs])),
      _updatedAtMs: createdAtMs,
    };
    const node = {
      nodeKey,
      projectUuid: String(row.id),
      type: 8,
      name: nodeName,
      position: { positionX: position.x, positionY: position.y },
      measured: {
        width: positiveSize(options.width, 520),
        height: positiveSize(options.height, 420),
      },
      data: JSON.stringify(nodeData),
      status: 1,
      createdAtMs,
      updatedAtMs: createdAtMs,
    };
    data.nodeList = [...existingNodes, node];
    return {
      created: { nodeKey, type: 'upload', name: nodeName },
      asset: {
        url: asset.url,
        thumbUrl: asset.thumbUrl,
        displayUrl: asset.displayUrl,
        sha1: asset.sha1,
        kind: resourceMeta.kind,
      },
    };
  });
}

function addUniqueRef(params, listKey, ref) {
  const existing = Array.isArray(params[listKey]) ? params[listKey] : [];
  if (existing.some((item) => String(item?.nodeId || item || '') === ref.nodeId)) return false;
  params[listKey] = [...existing, ref];
  return true;
}

function textValueFromNodeData(data) {
  const params = data.params || {};
  return cleanString(params.content || params.prompt, 20_000);
}

async function connectNodesForPlugin(userId, canvasId, options = {}) {
  const connections = Array.isArray(options.connections) ? options.connections : [];
  if (connections.length === 0 || connections.length > MAX_CONNECTION_BATCH) {
    throw serviceError(
      `connections must contain 1-${MAX_CONNECTION_BATCH} items`,
      'INVALID_PLUGIN_CONNECTION_BATCH'
    );
  }
  return mutateCanvas(userId, canvasId, options.expectedRevision, 'plugin_connect_nodes', async (data) => {
    const nodes = nodeListFromData(data);
    const byKey = new Map(nodes.map((node) => [String(node.nodeKey || ''), node]));
    const added = [];
    const skipped = [];
    for (const item of connections) {
      const sourceNodeKey = cleanString(item?.sourceNodeKey, 120);
      const targetNodeKey = cleanString(item?.targetNodeKey, 120);
      const source = byKey.get(sourceNodeKey);
      const target = byKey.get(targetNodeKey);
      if (!source || !target || source === target) {
        throw serviceError(
          `Invalid connection ${sourceNodeKey || '(empty)'} -> ${targetNodeKey || '(empty)'}`,
          'INVALID_PLUGIN_CONNECTION'
        );
      }
      const sourceData = parseNodeData(source);
      const targetData = parseNodeData(target);
      const sourceType = String(sourceData.type || '');
      const params = { ...(targetData.params || {}) };
      const ref = {
        nodeId: sourceNodeKey,
        url: Array.isArray(sourceData.url) ? String(sourceData.url[0] || '') : '',
        mediaType: sourceType === 'video' ? 'video' : sourceType === 'audio' ? 'audio' : 'image',
      };
      let changed = false;
      if (sourceType === 'text') {
        const content = textValueFromNodeData(sourceData);
        changed = addUniqueRef(params, 'textList', content ? { ...ref, content } : ref);
        if (content && ['image', 'video'].includes(String(targetData.type)) && !cleanString(params.prompt, 20_000)) {
          params.prompt = content;
          changed = true;
        }
      } else if (sourceType === 'video') {
        changed = addUniqueRef(params, 'videoList', ref) || changed;
        changed = addUniqueRef(params, 'mixedList', ref) || changed;
        const order = Array.isArray(params.mixedListOrder) ? params.mixedListOrder.map(String) : [];
        if (!order.includes(sourceNodeKey)) {
          params.mixedListOrder = [...order, sourceNodeKey];
          changed = true;
        }
      } else if (sourceType === 'audio') {
        changed = addUniqueRef(params, 'audioList', ref);
      } else {
        changed = addUniqueRef(params, 'imageList', ref);
        const order = Array.isArray(params.imageListOrder) ? params.imageListOrder.map(String) : [];
        if (!order.includes(sourceNodeKey)) {
          params.imageListOrder = [...order, sourceNodeKey];
          changed = true;
        }
        if (String(targetData.type) !== 'video') params.modeType = 'image2image';
      }
      if (!changed) {
        skipped.push({ sourceNodeKey, targetNodeKey, reason: 'already_connected' });
        continue;
      }
      targetData.params = params;
      targetData._updatedAtMs = Date.now();
      target.data = JSON.stringify(targetData);
      target.updatedAtMs = Date.now();
      added.push({ sourceNodeKey, targetNodeKey });
    }
    data.nodeList = nodes;
    return { added, skipped };
  });
}

async function updateNodeForPlugin(userId, canvasId, nodeKey, options = {}) {
  const patch = options.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw serviceError('patch must be an object', 'INVALID_PLUGIN_NODE_PATCH');
  }
  if (!Object.keys(patch).some((key) => EDITABLE_NODE_FIELDS.has(key))) {
    throw serviceError('patch must include an editable node field', 'EMPTY_PLUGIN_NODE_PATCH');
  }

  return mutateCanvas(userId, canvasId, options.expectedRevision, 'plugin_update_node', async (data, row) => {
    const nodes = nodeListFromData(data);
    const node = nodes.find((item) => String(item.nodeKey || '') === String(nodeKey));
    if (!node) throw serviceError('Node not found', 'PLUGIN_NODE_NOT_FOUND', 404);
    const type = nodeType(node);
    if (!type) throw serviceError('Node type is not editable by this plugin', 'PLUGIN_NODE_TYPE_NOT_EDITABLE', 400);
    const nodeData = applySpecToNodeData(parseNodeData(node), type, options.patch || {}, node.nodeKey, row.id);
    node.name = nodeData.name;
    node.data = JSON.stringify(nodeData);
    node.updatedAtMs = Date.now();
    node.position = {
      positionX: finiteNumber(patch.x, Number(node.position?.positionX || 0)),
      positionY: finiteNumber(patch.y, Number(node.position?.positionY || 0)),
    };
    node.measured = {
      width: positiveSize(patch.width, Number(node.measured?.width || NODE_SIZE[type].width)),
      height: positiveSize(patch.height, Number(node.measured?.height || NODE_SIZE[type].height)),
    };
    data.nodeList = nodes;
    return { updated: summarizeNode(node) };
  });
}

module.exports = {
  addNodesForPlugin,
  assertCanvasRevisionForPlugin,
  connectNodesForPlugin,
  createCanvasForPlugin,
  createUploadNodeForPlugin,
  getCanvasSummary,
  getGenerationNodeForPlugin,
  listCanvasesForPlugin,
  updateNodeForPlugin,
  _resolveGenerationParams: resolveGenerationParams,
};
