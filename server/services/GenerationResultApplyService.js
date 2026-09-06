const crypto = require('crypto');
const {
  getContentPool,
  getPool,
} = require('../db');
const { parseJsonDocument, saveCanvasData } = require('./CanvasService');
const { queueCanvasMutation } = require('./CanvasMutationQueue');
const { publishCanvasChange } = require('./CanvasRealtimeService');

function nodeList(data) {
  return Array.isArray(data?.nodeList) ? data.nodeList : [];
}

function nodeData(node) {
  if (!node) return {};
  if (node.data && typeof node.data === 'object') return { ...node.data };
  return parseJsonDocument(node.data, {});
}

async function applyGenerationResult({ jobId, task, ownership }) {
  const projectUuid = String(ownership?.projectUuid || ownership?.canvasId || '');
  const targetNodeKey = String(ownership?.nodeKey || '');
  if (!projectUuid || !targetNodeKey || !task || task.status !== 2 || !Array.isArray(task.urls) || !task.urls.length) {
    return { applied: false, reason: 'not_applicable' };
  }

  return queueCanvasMutation(projectUuid, async () => {
    const [rows] = await getPool().query(
      'SELECT id, owner_id, data FROM canvases WHERE id = ? LIMIT 1',
      [projectUuid]
    );
    const row = rows[0];
    if (!row) return { applied: false, reason: 'canvas_missing' };
    const data = parseJsonDocument(row.data, {});
    const nodes = nodeList(data);
    const index = nodes.findIndex((node) => String(node.nodeKey || nodeData(node).nodeKey || '') === targetNodeKey);
    if (index < 0) return { applied: false, reason: 'node_missing' };

    const current = nodes[index];
    const currentData = nodeData(current);
    const taskVersion = Number(task.meta?.generationVersion || 0);
    const currentVersion = Number(currentData._generationVersion || currentData.taskInfo?.generationVersion || 0);
    if (taskVersion && currentVersion && taskVersion < currentVersion) {
      return { applied: false, reason: 'superseded' };
    }

    const completedAtMs = Date.parse(String(task.meta?.updatedAt || '')) || Date.now();
    const urls = task.urls.map(String).filter(Boolean);
    const createdAtMap = { ...(currentData._assetCreatedAtMs || {}) };
    const generationMeta = { ...(currentData._assetGenerationMeta || {}) };
    for (const [outputIndex, url] of urls.entries()) {
      createdAtMap[url] = completedAtMs;
      const persisted = task.meta?.outputs?.find((output) => output.index === outputIndex || output.url === url);
      generationMeta[url] = {
        ...(persisted?.metadata || {}),
        model: persisted?.model || task.meta?.model,
        resolution: persisted?.resolution || task.meta?.resolution,
        createdAtMs: completedAtMs,
        taskId: jobId,
        generationVersion: taskVersion,
        outputIndex,
      };
    }

    const previousUrls = Array.isArray(currentData.url) ? currentData.url.filter(Boolean) : [];
    const mergedUrls = [...new Set([...previousUrls, ...urls])].slice(-30);
    const nextData = {
      ...currentData,
      url: mergedUrls,
      taskInfo: {
        ...(currentData.taskInfo || {}),
        taskId: jobId,
        generationVersion: taskVersion,
        applyStatus: 'applied',
        loading: false,
        status: 2,
        progressPercent: 100,
        quantity: Number(task.meta?.quantity || urls.length || 1),
        completedAtMs,
        model: task.meta?.model,
        taskKind: task.meta?.taskType,
      },
      _generationVersion: Math.max(currentVersion, taskVersion),
      _primaryAssetUrl: urls[0],
      _assetCreatedAtMs: createdAtMap,
      _assetGenerationMeta: generationMeta,
      _updatedAtMs: completedAtMs,
    };

    if (currentData.type === 'video') {
      const params = { ...(currentData.params || {}) };
      const oldHistory = Array.isArray(params.history) ? params.history : [];
      const history = urls.map((url, outputIndex) => ({
        id: `${jobId}-${outputIndex}`,
        timestamp: completedAtMs,
        url,
        prompt: params.prompt || '',
        promptHtml: params.promptHtml,
        promptChips: params.promptChips,
        model: task.meta?.model || params.model,
        modeType: task.meta?.mode || params.modeType,
        settings: { ...(params.settings || {}), resolution: task.meta?.resolution || params.settings?.resolution },
        imageList: [...(params.imageList || [])],
      }));
      nextData.params = { ...params, history: [...history, ...oldHistory].slice(0, 20) };
    }

    // 版本号要在落盘之前算出来并写进节点数据。原来先存节点、再单独按事件表 MAX+1 生成
    // 事件版本，节点的 _collabVersion 原样不动（{...currentData} 带过来的旧值），结果
    // 服务端乐观锁比的 _collabVersion 和客户端从事件流拿到的 node_version 永久错开：
    // 生成完再编辑这个节点就会 409，然后整个画布停止保存直到刷新。
    const [versionRows] = await getContentPool().query(
      'SELECT COALESCE(MAX(node_version), 0) AS version FROM canvas_node_events WHERE canvas_id = ? AND node_key = ?',
      [row.id, targetNodeKey]
    );
    const nodeVersion = Math.max(
      Number(versionRows[0]?.version || 0),
      Number(currentData._collabVersion || 0)
    ) + 1;
    nextData._collabVersion = nodeVersion;

    const next = { ...current, data: JSON.stringify(nextData), status: 1 };
    nodes[index] = next;
    data.nodeList = nodes;
    await saveCanvasData(projectUuid, data, {
      reason: 'generation_result',
      ownerId: row.owner_id,
      createdBy: ownership.userId || row.owner_id,
      cooldownMs: 0,
    });
    const [eventResult] = await getContentPool().query(
      `INSERT INTO canvas_node_events
        (canvas_id, node_key, node_version, event_type, node_snapshot, client_id, created_by)
       VALUES (?, ?, ?, 'upsert', ?, 'server-generation-result', ?)`,
      [row.id, targetNodeKey, nodeVersion, JSON.stringify(next), ownership.userId || row.owner_id]
    );
    const contentVersion = crypto.createHash('sha1').update(JSON.stringify(nodes)).digest('hex');
    publishCanvasChange({
      canvasId: row.id,
      source: 'generation_result',
      reason: 'generation_result',
      revision: contentVersion,
      contentVersion,
      changedAtMs: Date.now(),
      updatedBy: ownership.userId || row.owner_id,
      clientId: 'server-generation-result',
      changedNodeKeys: [targetNodeKey],
      eventCursor: Number(eventResult.insertId),
      nodeEvent: {
        id: Number(eventResult.insertId),
        nodeKey: targetNodeKey,
        nodeVersion,
        eventType: 'upsert',
        node: next,
      },
    });
    return { applied: true, node: next, nodeVersion, eventId: Number(eventResult.insertId) };
  });
}

module.exports = { applyGenerationResult };
