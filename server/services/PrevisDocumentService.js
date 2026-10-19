const crypto = require('crypto');

const MAX_PREVIS_BYTES = 12 * 1024 * 1024;

function previsError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function serializePrevisProject(project) {
  if (project == null || typeof project !== 'object' || Array.isArray(project)) {
    throw previsError('工程内容格式不正确', 400);
  }
  const serialized = JSON.stringify(project);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PREVIS_BYTES) {
    throw previsError('预演工程太大，无法保存', 413);
  }
  return serialized;
}

function presentPrevisDocument(row) {
  let project = null;
  if (row && row.payload) {
    try {
      project = JSON.parse(row.payload);
    } catch {
      project = null;
    }
  }
  return {
    documentId: row.document_key,
    revision: Number(row.revision) || 1,
    activeShotId: row.active_shot_id || '',
    project,
  };
}

async function ensurePrevisDocument({ canvasId, ownerId, nodeKey }) {
  const { getContentPool } = require('../db');
  const db = getContentPool();
  const [rows] = await db.query(
    'SELECT document_key, revision, active_shot_id, payload FROM previs_documents WHERE canvas_id = ? AND node_key = ? LIMIT 1',
    [canvasId, nodeKey],
  );
  if (rows[0]) return presentPrevisDocument(rows[0]);
  const documentKey = crypto.randomUUID();
  await db.query(
    'INSERT INTO previs_documents (document_key, canvas_id, node_key, owner_id, revision, payload) VALUES (?, ?, ?, ?, 1, NULL)',
    [documentKey, canvasId, nodeKey, ownerId],
  );
  return { documentId: documentKey, revision: 1, activeShotId: '', project: null };
}

async function readPrevisDocument(canvasId, documentId) {
  const { getContentPool } = require('../db');
  const [rows] = await getContentPool().query(
    'SELECT document_key, canvas_id, revision, active_shot_id, payload FROM previs_documents WHERE document_key = ? AND canvas_id = ? LIMIT 1',
    [documentId, canvasId],
  );
  return rows[0] ? presentPrevisDocument(rows[0]) : null;
}

async function savePrevisDocument(canvasId, documentId, { project, baseRevision, activeShotId }) {
  const { getContentPool } = require('../db');
  const serialized = serializePrevisProject(project);
  const shotId = String(activeShotId || project.activeShotId || '').slice(0, 64);
  const [result] = await getContentPool().query(
    'UPDATE previs_documents SET payload = ?, revision = revision + 1, active_shot_id = ? WHERE document_key = ? AND canvas_id = ? AND revision = ?',
    [serialized, shotId, documentId, canvasId, Number(baseRevision)],
  );
  if (!result.affectedRows) {
    throw previsError('预演工程已在其他地方更新，请重新打开', 409);
  }
  return {
    documentId,
    revision: Number(baseRevision) + 1,
    activeShotId: shotId,
    project,
  };
}

module.exports = {
  MAX_PREVIS_BYTES,
  serializePrevisProject,
  presentPrevisDocument,
  ensurePrevisDocument,
  readPrevisDocument,
  savePrevisDocument,
};
