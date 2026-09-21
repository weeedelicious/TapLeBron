'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const FormData = require('form-data');

const SUPPORTED_MEDIA_TYPES = new Set(['image', 'video']);
const SUPPORTED_SCALES = new Set([2, 4]);
const SUPPORTED_ENHANCE_MODES = new Set(['faithful', 'generative', 'nvidia-vsr', 'flashvsr']);
const ENHANCE_IMPLEMENTATIONS = Object.freeze({
  faithful: Object.freeze({
    enhanceMode: 'faithful',
    provider: 'realsr-ncnn-vulkan',
    model: 'RealSR DF2K',
  }),
  generative: Object.freeze({
    enhanceMode: 'generative',
    provider: 'seedvr2',
    model: 'SeedVR2 7B Sharp FP8',
  }),
  'nvidia-vsr': Object.freeze({
    enhanceMode: 'nvidia-vsr',
    provider: 'nvidia-vfx',
    model: 'NVIDIA RTX Video Super Resolution',
  }),
  flashvsr: Object.freeze({
    enhanceMode: 'flashvsr',
    provider: 'flashvsr',
    model: 'FlashVSR v1.1 Tiny Long',
  }),
});
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_RETRY_LIMIT = 6;
const DEFAULT_POLL_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_POLL_RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_MAX_OUTPUT_PIXELS = 134_217_728;
const RETRYABLE_POLL_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_POLL_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_NETWORK',
  'ETIMEDOUT',
]);

function mediaEnhanceError(message, code = 'MEDIA_ENHANCE_FAILED', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function abortError() {
  const error = mediaEnhanceError('AI 高清增强已取消', 'ABORT_ERR', 499);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function normalizeServiceUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function workerHeaders(token, extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${String(token || '').trim()}`,
  };
}

function configuredOptions(options = {}) {
  const serviceUrl = normalizeServiceUrl(options.serviceUrl);
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl || !serviceToken) {
    throw mediaEnhanceError(
      'AI 高清增强服务尚未配置，请联系管理员设置 MEDIA_ENHANCE_SERVICE_URL 和令牌',
      'MEDIA_ENHANCE_NOT_CONFIGURED',
      503,
    );
  }
  return { serviceUrl, serviceToken };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function mediaEnhanceImplementation(value) {
  const enhanceMode = String(value || 'faithful').trim().toLowerCase();
  if (!SUPPORTED_ENHANCE_MODES.has(enhanceMode)) {
    throw mediaEnhanceError(
      '高清增强方式只能是忠实放大、NVIDIA RTX 视频超分、SeedVR2 或 FlashVSR',
      'MEDIA_ENHANCE_MODE_INVALID',
      400,
    );
  }
  return ENHANCE_IMPLEMENTATIONS[enhanceMode];
}

function validateMediaEnhanceRequest(input = {}) {
  const mediaType = String(input.mediaType || '').trim().toLowerCase();
  const scale = Number(input.scale);
  const implementation = mediaEnhanceImplementation(input.enhanceMode);
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
    throw mediaEnhanceError('只支持图片或视频高清增强', 'MEDIA_ENHANCE_TYPE_INVALID', 400);
  }
  if (['nvidia-vsr', 'flashvsr'].includes(implementation.enhanceMode) && mediaType !== 'video') {
    throw mediaEnhanceError(
      `${implementation.model}只支持视频节点`,
      'MEDIA_ENHANCE_MODE_TYPE_INVALID',
      400,
    );
  }
  if (!SUPPORTED_SCALES.has(scale)) {
    throw mediaEnhanceError('高清增强倍数只能是 2x 或 4x', 'MEDIA_ENHANCE_SCALE_INVALID', 400);
  }
  const width = positiveInteger(input.sourceMeta?.width);
  const height = positiveInteger(input.sourceMeta?.height);
  if (!width || !height) {
    throw mediaEnhanceError('无法读取源素材分辨率', 'MEDIA_ENHANCE_SOURCE_SIZE_UNKNOWN', 400);
  }
  const targetWidth = width * scale;
  const targetHeight = height * scale;
  const maxOutputPixels = positiveInteger(input.maxOutputPixels) || DEFAULT_MAX_OUTPUT_PIXELS;
  if (targetWidth * targetHeight > maxOutputPixels) {
    throw mediaEnhanceError(
      `输出分辨率 ${targetWidth}×${targetHeight} 超过高清增强上限`,
      'MEDIA_ENHANCE_OUTPUT_TOO_LARGE',
      400,
    );
  }
  if (mediaType === 'video') {
    if (!positiveNumber(input.sourceMeta?.fps)) {
      throw mediaEnhanceError('无法读取源视频帧率', 'MEDIA_ENHANCE_SOURCE_FPS_UNKNOWN', 400);
    }
    if (!positiveNumber(input.sourceMeta?.videoDurationSec || input.sourceMeta?.durationSec)) {
      throw mediaEnhanceError('无法读取源视频时长', 'MEDIA_ENHANCE_SOURCE_DURATION_UNKNOWN', 400);
    }
  }
  return {
    mediaType,
    scale,
    width,
    height,
    targetWidth,
    targetHeight,
    maxOutputPixels,
    ...implementation,
  };
}

function workerDetail(error) {
  const data = error?.response?.data;
  if (typeof data === 'string') return data.trim();
  if (typeof data?.detail === 'string') return data.detail.trim();
  if (Array.isArray(data?.detail)) {
    return data.detail.map((item) => item?.msg || item?.message).filter(Boolean).join('；');
  }
  return String(data?.error || error?.message || error || '').trim();
}

function normalizeWorkerError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ERR_CANCELED') {
    return abortError();
  }
  const status = Number(error?.response?.status || 0);
  const detail = workerDetail(error);
  if (status === 401 || status === 403) {
    return mediaEnhanceError('AI 高清增强服务鉴权失败，请联系管理员检查令牌', 'MEDIA_ENHANCE_AUTH_FAILED', 502);
  }
  if (status === 413) {
    return mediaEnhanceError('源素材超过 AI 高清增强服务的上传上限', 'MEDIA_ENHANCE_SOURCE_TOO_LARGE', 400);
  }
  if (status) {
    return mediaEnhanceError(`AI 高清增强服务返回 ${status}${detail ? `：${detail}` : ''}`, 'MEDIA_ENHANCE_WORKER_ERROR', 502);
  }
  return mediaEnhanceError(
    detail ? `AI 高清增强服务不可用：${detail}` : 'AI 高清增强服务不可用',
    'MEDIA_ENHANCE_WORKER_UNAVAILABLE',
    503,
  );
}

function isRetryableWorkerPollError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ERR_CANCELED') {
    return false;
  }
  const status = Number(error?.response?.status || 0);
  if (status) return RETRYABLE_POLL_HTTP_STATUS.has(status);
  const code = String(error?.code || '').trim().toUpperCase();
  if (RETRYABLE_POLL_ERROR_CODES.has(code)) return true;
  const detail = workerDetail(error).toLowerCase();
  return /socket hang up|connection reset|network error|timed?\s*out/.test(detail);
}

async function sleepWithSignal(ms, signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    setTimeout(() => signal.removeEventListener('abort', onAbort), ms + 1);
  });
}

async function createWorkerJob(inputPath, request, options = {}) {
  const { serviceUrl, serviceToken } = configuredOptions(options);
  throwIfAborted(options.signal);
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw mediaEnhanceError('源素材文件不存在，请重新导入', 'MEDIA_ENHANCE_SOURCE_FILE_MISSING', 400);
  }
  const form = new FormData();
  const stat = fs.statSync(inputPath);
  form.append('file', fs.createReadStream(inputPath), {
    filename: path.basename(inputPath),
    contentType: request.mediaType === 'video' ? 'video/mp4' : 'image/png',
    knownLength: stat.size,
  });
  form.append('scale', String(request.scale));
  form.append('media_type', request.mediaType);
  form.append('enhance_mode', request.enhanceMode);
  try {
    const response = await axios.post(`${serviceUrl}/v1/jobs`, form, {
      headers: workerHeaders(serviceToken, form.getHeaders()),
      timeout: Math.max(60_000, Math.min(Number(options.timeoutMs || 0) || 900_000, 900_000)),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      signal: options.signal,
    });
    const jobId = String(response.data?.jobId || '').trim();
    if (!jobId) throw mediaEnhanceError('AI 高清增强服务没有返回任务 ID', 'MEDIA_ENHANCE_JOB_ID_MISSING', 502);
    return { jobId, payload: response.data || {} };
  } catch (error) {
    if (error?.code?.startsWith?.('MEDIA_ENHANCE_')) throw error;
    throw normalizeWorkerError(error);
  }
}

async function getWorkerJob(jobId, options = {}) {
  const { serviceUrl, serviceToken } = configuredOptions(options);
  const retryLimitValue = Number(options.pollRetryLimit);
  const retryLimit = Number.isFinite(retryLimitValue)
    ? Math.max(0, Math.min(20, Math.floor(retryLimitValue)))
    : DEFAULT_POLL_RETRY_LIMIT;
  const baseDelayValue = Number(options.pollRetryBaseDelayMs);
  const baseDelayMs = Number.isFinite(baseDelayValue)
    ? Math.max(0, baseDelayValue)
    : DEFAULT_POLL_RETRY_BASE_DELAY_MS;
  const maxDelayValue = Number(options.pollRetryMaxDelayMs);
  const maxDelayMs = Number.isFinite(maxDelayValue)
    ? Math.max(baseDelayMs, maxDelayValue)
    : DEFAULT_POLL_RETRY_MAX_DELAY_MS;

  for (let retryCount = 0; ; retryCount += 1) {
    throwIfAborted(options.signal);
    try {
      const response = await axios.get(`${serviceUrl}/v1/jobs/${encodeURIComponent(jobId)}`, {
        headers: workerHeaders(serviceToken),
        timeout: 15_000,
        signal: options.signal,
      });
      return response.data || {};
    } catch (error) {
      if (!isRetryableWorkerPollError(error) || retryCount >= retryLimit) {
        throw normalizeWorkerError(error);
      }
      const retryDelayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** retryCount));
      console.warn(
        `[media-enhance] worker task ${jobId} status query failed; retry ${retryCount + 1}/${retryLimit} in ${retryDelayMs}ms:`,
        workerDetail(error),
      );
      await sleepWithSignal(retryDelayMs, options.signal);
    }
  }
}

async function deleteWorkerJob(jobId, options = {}) {
  if (!jobId) return false;
  let configured;
  try { configured = configuredOptions(options); } catch { return false; }
  try {
    await axios.delete(`${configured.serviceUrl}/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: workerHeaders(configured.serviceToken),
      timeout: 8_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function downloadWorkerResult(jobId, outputPath, options = {}) {
  const { serviceUrl, serviceToken } = configuredOptions(options);
  throwIfAborted(options.signal);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    const response = await axios.get(`${serviceUrl}/v1/jobs/${encodeURIComponent(jobId)}/result`, {
      headers: workerHeaders(serviceToken),
      responseType: 'stream',
      timeout: Math.max(60_000, Math.min(Number(options.timeoutMs || 0) || 900_000, 900_000)),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      signal: options.signal,
    });
    await pipeline(response.data, fs.createWriteStream(outputPath), { signal: options.signal });
  } catch (error) {
    try { fs.rmSync(outputPath, { force: true }); } catch { /* best effort */ }
    throw normalizeWorkerError(error);
  }
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1) {
    throw mediaEnhanceError('AI 高清增强没有生成有效文件', 'MEDIA_ENHANCE_RESULT_EMPTY', 502);
  }
  return outputPath;
}

async function enhanceMedia(options = {}) {
  const request = validateMediaEnhanceRequest(options);
  const timeoutMs = Math.max(60_000, Number(options.timeoutMs || 0) || 30 * 60_000);
  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS));
  const deadline = Date.now() + timeoutMs;
  let workerJobId = '';
  let completed = null;
  try {
    const created = await createWorkerJob(options.inputPath, request, options);
    workerJobId = created.jobId;
    options.onProgress?.(Math.max(1, Number(created.payload?.progressPercent || 1)), created.payload);
    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      const status = await getWorkerJob(workerJobId, options);
      const progress = Math.max(1, Math.min(99, Number(status.progressPercent || 0) || 1));
      options.onProgress?.(progress, status);
      if (status.status === 'succeeded') {
        completed = status;
        break;
      }
      if (status.status === 'failed') {
        throw mediaEnhanceError(String(status.error || 'AI 高清增强失败'), 'MEDIA_ENHANCE_PROCESSING_FAILED', 502);
      }
      if (status.status === 'cancelled') throw abortError();
      await sleepWithSignal(pollIntervalMs, options.signal);
    }
    if (!completed) {
      throw mediaEnhanceError('AI 高清增强处理超时', 'MEDIA_ENHANCE_TIMEOUT', 504);
    }
    options.onProgress?.(99, { ...completed, phase: 'downloading-result' });
    await downloadWorkerResult(workerJobId, options.outputPath, options);
    return {
      outputPath: options.outputPath,
      workerJobId,
      metadata: completed.metadata || {},
      resultMimeType: completed.resultMimeType || (request.mediaType === 'video' ? 'video/mp4' : 'image/png'),
    };
  } catch (error) {
    throw error?.code?.startsWith?.('MEDIA_ENHANCE_') || error?.name === 'AbortError'
      ? error
      : normalizeWorkerError(error);
  } finally {
    await deleteWorkerJob(workerJobId, options);
  }
}

function validateMediaEnhanceOutput(input = {}) {
  const request = validateMediaEnhanceRequest(input);
  const output = input.outputMeta || {};
  const worker = input.workerMetadata || {};
  if (positiveInteger(output.width) !== request.targetWidth || positiveInteger(output.height) !== request.targetHeight) {
    return `高清增强结果尺寸不是 ${request.targetWidth}×${request.targetHeight}`;
  }
  if (request.mediaType === 'image') {
    if (String(output.kind || '') !== 'image') return '高清增强结果不是可识别的图片';
    return '';
  }
  const formats = String(output.formatName || '').toLowerCase().split(',').map((item) => item.trim());
  if (!formats.includes('mp4') || String(output.codecName || '').toLowerCase() !== 'h264') {
    return '高清增强结果不是 RV 兼容的 H.264 MP4';
  }
  if (!['yuv420p', 'yuvj420p'].includes(String(output.pixelFormat || '').toLowerCase())) {
    return '高清增强结果不是 RV 兼容的 yuv420p 视频';
  }
  if (output.codecProfile && !/high/i.test(String(output.codecProfile))) {
    return '高清增强结果不是 H.264 High Profile';
  }
  const sourceFps = positiveNumber(input.sourceMeta?.fps);
  const outputFps = positiveNumber(output.fps);
  if (!outputFps || Math.abs(sourceFps - outputFps) > Math.max(0.05, sourceFps * 0.002)) {
    return '高清增强结果改变了源视频帧率';
  }
  const sourceDuration = positiveNumber(input.sourceMeta?.videoDurationSec || input.sourceMeta?.durationSec);
  const outputDuration = positiveNumber(output.videoDurationSec || output.durationSec);
  if (outputDuration && Math.abs(sourceDuration - outputDuration) > Math.max(0.3, sourceDuration * 0.03)) {
    return '高清增强结果改变了源视频时长';
  }
  if (input.sourceMeta?.audioCodecName && !output.audioCodecName) {
    return '高清增强结果丢失了源视频音轨';
  }
  if (worker.boundaryFramesVerified !== true) return '高清增强结果未通过首尾帧解码校验';
  const sourceFrames = positiveInteger(input.sourceMeta?.videoFrameCount);
  const outputFrames = positiveInteger(worker.frameCount);
  if (sourceFrames && outputFrames && sourceFrames !== outputFrames) return '高清增强结果改变了源视频帧数';
  return '';
}

async function health(options = {}) {
  const { serviceUrl, serviceToken } = configuredOptions(options);
  try {
    const response = await axios.get(`${serviceUrl}/health`, {
      headers: workerHeaders(serviceToken),
      timeout: 5_000,
    });
    return response.data || {};
  } catch (error) {
    throw normalizeWorkerError(error);
  }
}

module.exports = {
  DEFAULT_MAX_OUTPUT_PIXELS,
  DEFAULT_POLL_RETRY_LIMIT,
  SUPPORTED_MEDIA_TYPES,
  SUPPORTED_ENHANCE_MODES,
  SUPPORTED_SCALES,
  deleteWorkerJob,
  enhanceMedia,
  getWorkerJob,
  health,
  isRetryableWorkerPollError,
  mediaEnhanceImplementation,
  validateMediaEnhanceOutput,
  validateMediaEnhanceRequest,
};
