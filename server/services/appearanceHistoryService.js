'use strict';

// Appearance-transfer history read model (Phase C) — faithful Node port of the
// Dexis history_service. The persisted generation ledger is AUTHORITATIVE:
// results are never inferred from canvas image nodes, positions, filenames or
// edges (the exact bug the source flags as previously-wrong).
//
// Source: the `generation_tasks` table (usage db). Appearance metadata is
// persisted by /generate/image at request_params.appearanceTransfer.* (a string
// map). Classification uses the EXPLICIT `appearanceLightingMode`; the manifest
// `mode` is only a legacy fallback. Isolation is by `appearanceProcessorNodeId`.
// preserve-scene and replace-background are returned interleaved (the client
// splits them). Quality warnings are metadata and never filter a result.

const { getUsagePool } = require('../db');

const PRESERVE_MODE = 'preserve-scene';
const REPLACE_MODE = 'replace-background';
const PRESERVE_MANIFEST_MODE = 'preserve-scene-relight';
const REPLACE_MANIFEST_MODE = 'replace-background-relight';

// Legacy reference-pixel method ids project to the 'reference-pixels' vocabulary
// for display only (read compatibility); everything else is 'semantic-generate'
// (this includes the direct-v1 manifest value 'ai-semantic').
const LEGACY_REFERENCE_PIXEL_METHODS = new Set([
  'reference-pixels-v1',
  'reference-pixels-cleaned-v1',
  'reference-pixels-fusion-v1',
  'reference-pose-v1',
]);

function decodeJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function classifyMode(settings) {
  const explicit = settings.appearanceLightingMode;
  if (explicit === PRESERVE_MODE) return PRESERVE_MODE;
  if (explicit === REPLACE_MODE) return REPLACE_MODE;
  const manifest = decodeJsonObject(settings.appearanceInputManifest);
  const manifestMode = manifest ? manifest.mode : null;
  if (manifestMode === PRESERVE_MANIFEST_MODE) return PRESERVE_MODE;
  if (manifestMode === REPLACE_MANIFEST_MODE) return REPLACE_MODE;
  return null;
}

function backgroundTransferMethod(settings) {
  return LEGACY_REFERENCE_PIXEL_METHODS.has(settings.appearanceBackgroundTransferMethod)
    ? 'reference-pixels'
    : 'semantic-generate';
}

function referencePersonAction(settings) {
  const value = settings.appearanceReferencePersonAction;
  if (value === 'remove-v1') return 'remove';
  if (value === 'replace-pose-v1') return 'replace-pose';
  return 'keep';
}

function boolSetting(value) {
  return value === true || value === 'true' || value === '1';
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function firstResultUrl(row) {
  const urls = decodeJsonObject(row.result_urls);
  if (Array.isArray(urls) && urls.length && typeof urls[0] === 'string') return urls[0];
  return null;
}

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

// Strip a localhost/127.0.0.1 origin before /assets/ so stored absolute URLs
// collapse to app-relative (mirrors the frontend normalizeProjectAssetUrl).
function normalizeAssetUrl(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?=\/assets\/)/i, '');
}

// Project one generation_tasks row to a history classification outcome:
//   { item }          -> a classified appearance result belonging to the node
//   { unclassified }  -> belongs to the node but not deterministically classifiable
//   { skip }          -> not an appearance result for this processor node
function projectHistoryRow(row, processorNodeId) {
  const requestParams = decodeJsonObject(row.request_params);
  if (!requestParams) return { skip: true };
  const settings = decodeJsonObject(requestParams.appearanceTransfer);
  if (!settings) return { skip: true };
  if (String(settings.appearanceProcessorNodeId || '') !== String(processorNodeId)) return { skip: true };

  const mode = classifyMode(settings);
  const url = firstResultUrl(row);
  if (!mode || !url) return { unclassified: true };

  return {
    item: {
      jobId: row.job_id,
      candidateNodeId: row.node_key || row.job_id,
      url: normalizeAssetUrl(url),
      mode,
      createdAt: settings.appearanceHistoryCreatedAt || toIso(row.completed_at) || toIso(row.created_at),
      backendId: settings.appearanceBackendId || row.model || null,
      confirmed: boolSetting(settings.appearanceConfirmed),
      width: positiveInt(settings.sourceImageWidth),
      height: positiveInt(settings.sourceImageHeight),
      referenceAttached: boolSetting(settings.appearanceReferenceAttached),
      backgroundTransferMethod: backgroundTransferMethod(settings),
      referencePersonAction: referencePersonAction(settings),
      warningMessage:
        typeof settings.appearanceWarningMessage === 'string' && settings.appearanceWarningMessage
          ? settings.appearanceWarningMessage
          : null,
    },
  };
}

// Pure page builder over already-fetched rows (newest-first). Items cap at
// `limit`; every belonging-but-unclassifiable row increments unclassifiedCount.
function buildHistoryPage(rows, processorNodeId, limit) {
  const items = [];
  let unclassifiedCount = 0;
  for (const row of rows) {
    const projected = projectHistoryRow(row, processorNodeId);
    if (projected.item) {
      if (items.length < limit) items.push(projected.item);
    } else if (projected.unclassified) {
      unclassifiedCount += 1;
    }
  }
  return { schemaVersion: 1, items, nextCursor: null, unclassifiedCount };
}

async function listHistory({ projectUuid, processorNodeId, limit = 50 }) {
  const cappedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const pool = getUsagePool();
  const [rows] = await pool.query(
    `SELECT job_id, node_key, model, request_params, result_urls, status,
            created_at, updated_at, completed_at
     FROM generation_tasks
     WHERE project_uuid = ?
       AND status = 'succeeded'
       AND task_type = 'image'
       AND JSON_UNQUOTE(JSON_EXTRACT(request_params, '$.appearanceTransfer.appearanceProcessorNodeId')) = ?
     ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
     LIMIT ?`,
    [String(projectUuid), String(processorNodeId), Math.max(cappedLimit * 2, 100)],
  );
  return buildHistoryPage(rows, processorNodeId, cappedLimit);
}

module.exports = {
  classifyMode,
  backgroundTransferMethod,
  referencePersonAction,
  normalizeAssetUrl,
  projectHistoryRow,
  buildHistoryPage,
  listHistory,
};
