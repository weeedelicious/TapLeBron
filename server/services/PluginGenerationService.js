'use strict';

const crypto = require('crypto');
const config = require('../config');
const { getUsagePool } = require('../db');
const imageRules = require('../../src/shared/image-model-rules.json');
const videoRules = require('../../src/shared/seedance-video-rules.json');
const { getGenerationNodeForPlugin } = require('./PluginCanvasService');
const { generationError, GENERATION_ERROR_CODES, assertDispatcherEnabled, assertBillingAllowed } = require('./generationErrors');
const idempotency = require('./IdempotencyService');
const jobService = require('./JobService');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanCount(value, fallback = 1) {
  return Math.max(1, Math.floor(Number(value) || fallback));
}

function referenceCount(params, key) {
  return Array.isArray(params?.[key]) ? params[key].filter((item) => item && item.url).length : 0;
}

function validateAndNormalize(node) {
  const params = node.params || {};
  const prompt = String(params.prompt || '').trim();
  if (!prompt) throw generationError('提示词不能为空', GENERATION_ERROR_CODES.PROMPT_EMPTY, 400, { nodeKey: node.key });

  if (node.type === 'image') {
    const model = String(params.model || imageRules.defaults.model);
    const rule = imageRules.models[model];
    if (!rule) throw generationError('图片模型无效', GENERATION_ERROR_CODES.MODEL_SETTING_INVALID, 400, { model });
    const settings = params.settings || {};
    const count = cleanCount(params.count, imageRules.defaults.count);
    if (count > Math.min(Number(rule.maxGenerationCount || 10), config.generation.maxGenerationUnits)) {
      throw generationError('生成数量超过上限', GENERATION_ERROR_CODES.MODEL_SETTING_INVALID, 400, { count });
    }
    const imageCount = referenceCount(params, 'imageList') + referenceCount(params, 'promptChips');
    if (imageCount > Number(rule.maxReferenceImages || 0)) {
      throw generationError('参考图数量超过模型上限', GENERATION_ERROR_CODES.MODEL_SETTING_INVALID, 400, { imageCount });
    }
    return {
      dispatcher: 'image',
      model,
      mode: imageCount > 0 ? 'image2image' : 'text2image',
      prompt,
      quantity: count,
      settings: {
        ratio: String(settings.ratio || imageRules.defaults.ratio),
        resolution: String(settings.resolution || imageRules.defaults.resolution),
        quality: String(settings.quality || imageRules.defaults.quality),
      },
      inputs: { images: imageCount, videos: 0, audios: 0 },
    };
  }

  const model = String(params.model || videoRules.defaults.model);
  const rule = videoRules.models[model];
  if (!rule) throw generationError('视频模型无效', GENERATION_ERROR_CODES.MODEL_SETTING_INVALID, 400, { model });
  const settings = params.settings || {};
  const count = cleanCount(params.count, videoRules.defaults.count);
  if (count > config.generation.maxGenerationUnits || (Array.isArray(rule.generationCounts) && !rule.generationCounts.includes(count))) {
    throw generationError('视频生成数量不受支持', GENERATION_ERROR_CODES.MODEL_SETTING_INVALID, 400, { count });
  }
  const mode = String(params.modeType || videoRules.defaults.mode);
  if (!Array.isArray(rule.modes) || !rule.modes.includes(mode)) {
    throw generationError('视频生成模式不受支持', GENERATION_ERROR_CODES.MODEL_SETTING_INVALID, 400, { model, mode });
  }
  return {
    dispatcher: 'video',
    model,
    mode,
    prompt,
    quantity: count,
    settings: {
      ratio: String(settings.ratio || videoRules.defaults.ratio),
      resolution: String(settings.resolution || videoRules.defaults.resolution),
      duration: Number(settings.duration || videoRules.defaults.duration),
      enableSound: String(settings.enableSound || videoRules.defaults.enableSound),
    },
    inputs: {
      images: referenceCount(params, 'imageList'),
      videos: referenceCount(params, 'videoList'),
      audios: referenceCount(params, 'audioList'),
    },
  };
}

function requiredScope(type) {
  return `generate:${type}`;
}

function hasScope(scopes, scope) {
  const granted = Array.isArray(scopes) ? scopes : [];
  return granted.includes(scope) || granted.includes('generate');
}

function assertScope(scopes, scope) {
  if (hasScope(scopes, scope)) return;
  throw generationError(`缺少生成权限 ${scope}`, 'PLUGIN_SCOPE_REQUIRED', 403, { requiredScopes: [scope] });
}

async function createPlan({ userId, tokenId, scopes, canvasId, nodeKey }) {
  assertDispatcherEnabled('generation', 'plugin');
  const loaded = await getGenerationNodeForPlugin(userId, canvasId, nodeKey);
  const scope = requiredScope(loaded.node.type);
  assertScope(scopes, scope);
  if (loaded.node.type === 'image' && !config.generation.imageEnabled) {
    throw generationError('图片生成当前未开启', GENERATION_ERROR_CODES.DISPATCHER_DISABLED, 503);
  }
  if (loaded.node.type === 'video' && !config.generation.videoEnabled) {
    throw generationError('视频生成当前未开启', GENERATION_ERROR_CODES.DISPATCHER_DISABLED, 503);
  }
  const normalizedPlan = validateAndNormalize(loaded.node);
  const estimate = {
    billable: true,
    billingUnit: loaded.node.type === 'video' ? 'video' : 'image',
    quantity: normalizedPlan.quantity,
    cost: null,
  };
  const planId = `sfp_plan_${crypto.randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + config.generation.planTtlSeconds * 1000);
  const planHash = sha256(stableStringify({
    canvasId: String(canvasId), nodeKey: loaded.node.key, configHash: loaded.node.configHash, normalizedPlan, estimate,
  }));
  await getUsagePool().query(
    `INSERT INTO plugin_generation_plans
      (plan_id, user_id, token_id, canvas_id, node_key, node_type, required_scope, config_hash, plan_hash, normalized_plan, estimate, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [planId, Number(userId), tokenId ? Number(tokenId) : null, Number(canvasId), loaded.node.key, loaded.node.type, scope,
      loaded.node.configHash, planHash, JSON.stringify(normalizedPlan), JSON.stringify(estimate), expiresAt]
  );
  return {
    ok: true, planId, planHash, expiresAt: expiresAt.toISOString(),
    canvas: loaded.canvas, node: { key: loaded.node.key, type: loaded.node.type, name: loaded.node.name },
    normalizedPlan, estimate, requiredScope: scope, billable: true, sideEffects: false,
  };
}

async function loadPlan(planId, userId) {
  const [rows] = await getUsagePool().query(
    'SELECT * FROM plugin_generation_plans WHERE plan_id = ? AND user_id = ? LIMIT 1',
    [String(planId || ''), Number(userId)]
  );
  return rows[0] || null;
}

async function prepareStart({ userId, tokenId, scopes, canvasId, nodeKey, planId, confirmBillable, idempotencyKey, maxCost }) {
  assertDispatcherEnabled('generation', 'plugin');
  const plan = await loadPlan(planId, userId);
  if (!plan || Number(plan.canvas_id) !== Number(canvasId) || String(plan.node_key) !== String(nodeKey)) {
    throw generationError('生成计划不存在或不属于该节点', GENERATION_ERROR_CODES.PLAN_EXPIRED, 404);
  }
  if (Date.parse(plan.expires_at) <= Date.now()) {
    throw generationError('生成计划已过期，请重新校验', GENERATION_ERROR_CODES.PLAN_EXPIRED, 409);
  }
  if (plan.token_id != null && tokenId != null && Number(plan.token_id) !== Number(tokenId)) {
    throw generationError('生成计划不属于当前连接', GENERATION_ERROR_CODES.PLAN_EXPIRED, 404);
  }
  assertScope(scopes, plan.required_scope);
  const loaded = await getGenerationNodeForPlugin(userId, canvasId, nodeKey);
  if (loaded.node.configHash !== plan.config_hash) {
    throw generationError('节点配置已变化，请重新校验后再生成', GENERATION_ERROR_CODES.PLAN_STALE, 409);
  }
  const estimate = parseJson(plan.estimate, {});
  assertBillingAllowed({ estimate, confirmBillable, maxCost, nodeKey: String(nodeKey) });
  const key = String(idempotencyKey || '').trim();
  if (!key) throw generationError('缺少 idempotencyKey', GENERATION_ERROR_CODES.IDEMPOTENCY_CONFLICT, 400);
  if (plan.consumed_idempotency_key && String(plan.consumed_idempotency_key) !== key) {
    throw generationError('该计划已用另一个幂等键执行', GENERATION_ERROR_CODES.IDEMPOTENCY_CONFLICT, 409);
  }
  const request = { planId: plan.plan_id, planHash: plan.plan_hash, configHash: plan.config_hash };
  const reservation = await idempotency.reserve({
    userId, canvasId, key, operation: `generate:${plan.node_type}`, request,
  });
  if (reservation.replay) {
    return { replay: true, response: reservation.response || (reservation.jobId ? { jobId: reservation.jobId } : null), reservation };
  }
  return {
    replay: false, reservation, idempotencyKey: key, plan, loaded,
    params: loaded.node.params, kind: loaded.node.type, estimate,
  };
}

async function completeStart({ userId, canvasId, planId, idempotencyKey, jobId, response }) {
  await idempotency.attachJob({ userId, canvasId, key: idempotencyKey, jobId });
  await idempotency.complete({ userId, canvasId, key: idempotencyKey, jobId, response });
  await getUsagePool().query(
    `UPDATE plugin_generation_plans
     SET consumed_idempotency_key = COALESCE(consumed_idempotency_key, ?),
         consumed_job_id = COALESCE(consumed_job_id, ?),
         consumed_at = COALESCE(consumed_at, CURRENT_TIMESTAMP)
     WHERE plan_id = ? AND user_id = ?`,
    [idempotencyKey, jobId, planId, Number(userId)]
  );
}

async function failStart({ userId, canvasId, idempotencyKey, errorCode }) {
  await idempotency.fail({ userId, canvasId, key: idempotencyKey, errorCode }).catch(() => null);
}

async function getJobForPlugin({ userId, canvasId, jobId }) {
  const ownership = await jobService.getTaskOwnership(jobId);
  if (!ownership || Number(ownership.userId) !== Number(userId) || String(ownership.projectUuid || ownership.canvasId || '') !== String(canvasId)) {
    throw generationError('任务不存在', GENERATION_ERROR_CODES.TASK_NOT_ACCESSIBLE, 404);
  }
  const task = await jobService.getTask(jobId);
  if (!task) throw generationError('任务不存在', GENERATION_ERROR_CODES.TASK_NOT_ACCESSIBLE, 404);
  return { ok: true, jobId: String(jobId), canvasId: String(canvasId), ...task };
}

module.exports = {
  createPlan, prepareStart, completeStart, failStart, getJobForPlugin, hasScope,
  _validateAndNormalize: validateAndNormalize,
};
