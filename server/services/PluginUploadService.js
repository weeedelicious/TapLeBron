const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const objectStore = require('../objectStore');

const MAX_CINDY_UPLOAD_BYTES = 64 * 1024 * 1024;
const UPLOAD_INTENT_TTL_MS = 5 * 60 * 1000;
const uploadIntents = new Map();

function serviceError(message, code, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

function cleanString(value, maxLength, fallback = '') {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, maxLength);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(-1_000_000, Math.min(1_000_000, number)) : undefined;
}

function positiveSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(80, Math.min(4_000, number)) : undefined;
}

function tempKey(intentId) {
  const prefix = cleanString(objectStore.settings?.prefix, 200).replace(/^\/+|\/+$/g, '');
  return [prefix, '_plugin_uploads', intentId].filter(Boolean).join('/');
}

function removeExpiredIntents() {
  const now = Date.now();
  for (const [intentId, intent] of uploadIntents) {
    if (intent.expiresAtMs > now || intent.state === 'processing') continue;
    uploadIntents.delete(intentId);
    void objectStore.deleteKey(intent.objectKey).catch(() => {});
  }
}

function getOwnedIntent(userId, canvasId, intentId) {
  removeExpiredIntents();
  const intent = uploadIntents.get(String(intentId || ''));
  if (
    !intent ||
    intent.userId !== Number(userId) ||
    intent.canvasId !== String(canvasId) ||
    intent.expiresAtMs <= Date.now()
  ) {
    throw serviceError('Upload intent not found or expired', 'PLUGIN_UPLOAD_INTENT_NOT_FOUND', 404);
  }
  return intent;
}

async function createPluginUploadIntent(userId, canvasId, options = {}) {
  if (!objectStore.isRemoteEnabled) {
    throw serviceError('Object storage is unavailable', 'PLUGIN_UPLOAD_STORAGE_UNAVAILABLE', 503);
  }
  removeExpiredIntents();

  const intentId = crypto.randomUUID();
  const expiresAtMs = Date.now() + UPLOAD_INTENT_TTL_MS;
  const intent = {
    id: intentId,
    userId: Number(userId),
    canvasId: String(canvasId),
    expectedRevision: String(options.expectedRevision || ''),
    objectKey: tempKey(intentId),
    name: cleanString(options.name, 255, 'Cindy 上传资源'),
    x: finiteNumber(options.x),
    y: finiteNumber(options.y),
    width: positiveSize(options.width),
    height: positiveSize(options.height),
    expiresAtMs,
    state: 'pending',
  };

  const signed = await objectStore.createPresignedUpload(intent.objectKey, {
    expiresSeconds: Math.ceil(UPLOAD_INTENT_TTL_MS / 1000),
    maxBytes: MAX_CINDY_UPLOAD_BYTES,
  });
  const fields = Object.fromEntries(
    Object.entries(signed.fields || {}).map(([key, value]) => [String(key), String(value)])
  );
  if (Object.keys(fields).length > 8) {
    throw serviceError('Signed upload requires too many form fields', 'PLUGIN_UPLOAD_FORM_UNSUPPORTED', 503);
  }

  uploadIntents.set(intentId, intent);
  return {
    intentId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    upload: {
      url: signed.url,
      field: 'file',
      fields,
      maxBytes: MAX_CINDY_UPLOAD_BYTES,
    },
  };
}

async function preparePluginUploadIntent(userId, canvasId, intentId) {
  const intent = getOwnedIntent(userId, canvasId, intentId);
  if (intent.state === 'processing') {
    throw serviceError('Upload intent is already being completed', 'PLUGIN_UPLOAD_INTENT_BUSY', 409);
  }
  intent.state = 'processing';

  const localPath = path.join(config.projectsDir, '_tmp', `plugin-upload-${intent.id}`);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.rmSync(localPath, { force: true });

  try {
    const head = await objectStore.headKey(intent.objectKey);
    const byteSize = Number(head?.ContentLength || 0);
    if (!Number.isFinite(byteSize) || byteSize < 1) {
      throw serviceError('Uploaded file is empty', 'PLUGIN_UPLOAD_EMPTY');
    }
    if (byteSize > MAX_CINDY_UPLOAD_BYTES) {
      throw serviceError('Cindy attachments must be 64MB or smaller', 'PLUGIN_UPLOAD_TOO_LARGE', 413);
    }
    await objectStore.downloadKeyToLocal(intent.objectKey, localPath);
    return {
      intent,
      file: {
        path: localPath,
        originalname: intent.name,
        mimetype: String(head?.ContentType || 'application/octet-stream'),
        size: byteSize,
      },
    };
  } catch (error) {
    intent.state = 'pending';
    fs.rmSync(localPath, { force: true });
    if (error?.name === 'NotFound' || Number(error?.$metadata?.httpStatusCode) === 404) {
      throw serviceError('Uploaded file was not found', 'PLUGIN_UPLOAD_FILE_NOT_FOUND', 404);
    }
    throw error;
  }
}

async function finishPluginUploadIntent(intent) {
  if (!intent) return;
  uploadIntents.delete(intent.id);
  await objectStore.deleteKey(intent.objectKey).catch(() => {});
}

async function cancelPluginUploadIntent(userId, canvasId, intentId) {
  let intent;
  try {
    intent = getOwnedIntent(userId, canvasId, intentId);
  } catch (error) {
    if (error?.code === 'PLUGIN_UPLOAD_INTENT_NOT_FOUND') return { ok: true };
    throw error;
  }
  uploadIntents.delete(intent.id);
  await objectStore.deleteKey(intent.objectKey).catch(() => {});
  return { ok: true };
}

function resetPluginUploadIntent(intent) {
  if (intent && uploadIntents.get(intent.id) === intent) intent.state = 'pending';
}

module.exports = {
  MAX_CINDY_UPLOAD_BYTES,
  cancelPluginUploadIntent,
  createPluginUploadIntent,
  finishPluginUploadIntent,
  preparePluginUploadIntent,
  resetPluginUploadIntent,
};
