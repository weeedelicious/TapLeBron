'use strict';

// Shared structured-error factory + billing/kill-switch gate helpers for the
// paid-generation pipeline (in-canvas Cindy panel AND the Ghost plugin path).
//
// Errors follow the same shape the existing PluginCanvasService/PluginUpload
// services use and that the global error handler in server/index.js surfaces:
//   error.statusCode  -> HTTP status (4xx returned to client with body below)
//   error.code        -> stable machine-readable errorCode
//   error.details     -> optional structured detail object
// The handler emits { error: message, errorCode: code, details? }.

const config = require('../config');

// Stable error codes from the hardening protocol (SKILL.md §7). Kept as a frozen
// map so callers reference GENERATION_ERROR_CODES.PLAN_STALE rather than literals.
const GENERATION_ERROR_CODES = Object.freeze({
  PROMPT_EMPTY: 'PROMPT_EMPTY',
  STORY_SOURCE_EMPTY: 'STORY_SOURCE_EMPTY',
  REFERENCE_MISSING: 'REFERENCE_MISSING',
  REFERENCE_TYPE_INVALID: 'REFERENCE_TYPE_INVALID',
  MODEL_SETTING_INVALID: 'MODEL_SETTING_INVALID',
  PLAN_EXPIRED: 'PLAN_EXPIRED',
  PLAN_STALE: 'PLAN_STALE',
  BILLING_CONFIRMATION_REQUIRED: 'BILLING_CONFIRMATION_REQUIRED',
  COST_LIMIT_EXCEEDED: 'COST_LIMIT_EXCEEDED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  CANVAS_REVISION_CONFLICT: 'CANVAS_REVISION_CONFLICT',
  NODE_VERSION_CONFLICT: 'NODE_VERSION_CONFLICT',
  TASK_NOT_ACCESSIBLE: 'TASK_NOT_ACCESSIBLE',
  DISPATCHER_DISABLED: 'DISPATCHER_DISABLED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  OUTPUT_PERSIST_FAILED: 'OUTPUT_PERSIST_FAILED',
  MERGE_CLIP_INVALID: 'MERGE_CLIP_INVALID',
  TASK_SUPERSEDED: 'TASK_SUPERSEDED',
});

function generationError(message, code, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

// Map a generation "dispatcher" to its config kill switch. `merge` covers
// video_merge (FFmpeg) rendering; `pipeline` covers multi-node runs.
function dispatcherEnabled(dispatcher, source) {
  const gen = config.generation || {};
  switch (dispatcher) {
    case 'merge':
    case 'video_merge':
      return Boolean(gen.mergeEnabled);
    case 'pipeline':
      return Boolean(gen.pipelineEnabled);
    default:
      // A regular billable generator (text/image/video/script): gate by the
      // calling surface. Cindy (in-canvas) and plugin (headless) have separate
      // switches so one can be enabled without the other.
      if (source === 'plugin') return Boolean(gen.pluginEnabled);
      if (source === 'cindy') return Boolean(gen.cindyEnabled);
      // Unknown source: require BOTH to be on (fail closed).
      return Boolean(gen.cindyEnabled && gen.pluginEnabled);
  }
}

// Throw DISPATCHER_DISABLED (503) unless the relevant kill switch is on.
function assertDispatcherEnabled(dispatcher, source, { stage = null } = {}) {
  if (dispatcherEnabled(dispatcher, source)) return;
  throw generationError(
    '该生成能力当前未开启',
    GENERATION_ERROR_CODES.DISPATCHER_DISABLED,
    503,
    { dispatcher, source, ...(stage ? { stage } : {}) },
  );
}

// Enforce the billing confirmation + hard cost cap BEFORE any side effect.
// `estimate` is the read-only plan estimate: { billable, billingUnit, quantity, cost? }.
// Throws BILLING_CONFIRMATION_REQUIRED (402) or COST_LIMIT_EXCEEDED (402) with
// zero side effects; returns silently when the request may proceed.
function assertBillingAllowed({ estimate, confirmBillable, maxCost, stage = null, nodeKey = null } = {}) {
  const billable = Boolean(estimate && estimate.billable);
  if (!billable) return; // non-billable (e.g. FFmpeg merge) needs no confirmation

  if (confirmBillable !== true) {
    throw generationError(
      '该操作会产生计费，需显式确认 confirmBillable: true',
      GENERATION_ERROR_CODES.BILLING_CONFIRMATION_REQUIRED,
      402,
      { estimate, ...(stage ? { stage } : {}), ...(nodeKey ? { nodeKey } : {}) },
    );
  }

  // Effective ceiling = min(caller maxCost, server maxCostPerRun>0). Either may be absent.
  const serverCap = Number(config.generation?.maxCostPerRun || 0) || 0;
  const callerCap = Number.isFinite(Number(maxCost)) && Number(maxCost) > 0 ? Number(maxCost) : Infinity;
  const effectiveCap = Math.min(callerCap, serverCap > 0 ? serverCap : Infinity);
  const estimatedCost = Number(estimate.cost);
  if (Number.isFinite(effectiveCap) && Number.isFinite(estimatedCost) && estimatedCost > effectiveCap) {
    throw generationError(
      '预计费用超过上限',
      GENERATION_ERROR_CODES.COST_LIMIT_EXCEEDED,
      402,
      { estimatedCost, maxCost: effectiveCap, ...(stage ? { stage } : {}), ...(nodeKey ? { nodeKey } : {}) },
    );
  }
}

module.exports = {
  GENERATION_ERROR_CODES,
  generationError,
  dispatcherEnabled,
  assertDispatcherEnabled,
  assertBillingAllowed,
};
