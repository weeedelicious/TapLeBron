'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const FormData = require('form-data');

const PROVIDERS = Object.freeze({
  'video-depth-anything': Object.freeze({
    provider: 'video-depth-anything',
    label: 'Video Depth Anything',
    phaseLabel: 'Video Depth Anything',
    maxDurationSec: 180,
    encoders: Object.freeze({
      vits: 'Video Depth Anything Small',
      vitb: 'Video Depth Anything Base',
      vitl: 'Video Depth Anything Large',
    }),
    defaultEncoder: 'vitl',
  }),
  depthcrafter: Object.freeze({
    provider: 'depthcrafter',
    label: 'DepthCrafter',
    phaseLabel: 'DepthCrafter',
    maxDurationSec: 30,
    encoders: Object.freeze({ svd: 'DepthCrafter' }),
    defaultEncoder: 'svd',
  }),
});

const MAX_RES_BY_PRESET = Object.freeze({ 480: 854, 720: 1280 });

function depthError(message, code = 'VIDEO_DEPTH_INVALID', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'vda' || provider === 'video-depth-anything') return 'video-depth-anything';
  if (provider === 'dc' || provider === 'depthcrafter') return 'depthcrafter';
  return provider;
}

function normalizeNear(value) {
  const near = String(value || 'bright').trim().toLowerCase();
  if (near === 'dark' || near === 'far-bright' || near === 'invert') return 'dark';
  return 'bright';
}

function normalizeMaxRes(value) {
  const parsed = Math.round(finiteNumber(value));
  if (MAX_RES_BY_PRESET[parsed]) return MAX_RES_BY_PRESET[parsed];
  if (parsed === 854 || parsed === 1280) return parsed;
  return 0;
}

function validateDepthRequest(input = {}) {
  const provider = normalizeProvider(input.provider);
  if (provider === 'video-depth-anything') {
    throw depthError('Video Depth Anything 已停用，请使用转深度视频', 'VIDEO_DEPTH_PROVIDER_REMOVED');
  }
  const spec = PROVIDERS[provider];
  if (!spec) {
    throw depthError('深度方案无效，请使用转深度视频', 'VIDEO_DEPTH_PROVIDER_INVALID');
  }
  const encoderInput = String(input.encoder || spec.defaultEncoder).trim().toLowerCase();
  const encoder = spec.encoders[encoderInput] ? encoderInput : '';
  if (!encoder) {
    throw depthError(
      provider === 'depthcrafter' ? 'DepthCrafter 不需要再选规模' : 'Video Depth Anything 规模无效，可选 Small / Base / Large',
      'VIDEO_DEPTH_ENCODER_INVALID',
    );
  }
  const maxRes = normalizeMaxRes(input.maxRes ?? input.maxResPreset ?? input.resolution);
  if (!maxRes) throw depthError('输出清晰度无效，可选 480 / 720', 'VIDEO_DEPTH_RESOLUTION_INVALID');
  const durationSec = finiteNumber(input.durationSec ?? input.duration);
  if (!(durationSec > 0)) throw depthError('无法读取源视频时长，请重新导入视频后再试', 'VIDEO_SOURCE_DURATION_UNAVAILABLE');
  if (durationSec > spec.maxDurationSec + 0.05) {
    throw depthError(spec.label + ' 目前最长处理 ' + spec.maxDurationSec + ' 秒，请先剪短视频', 'VIDEO_DEPTH_DURATION_TOO_LONG');
  }
  const sourceFps = finiteNumber(input.sourceFps ?? input.fps);
  return {
    provider,
    encoder,
    model: spec.encoders[encoder],
    label: spec.label,
    phaseLabel: spec.phaseLabel,
    maxRes,
    near: normalizeNear(input.near),
    durationSec: Number(durationSec.toFixed(3)),
    sourceFps: sourceFps > 0 ? Number(sourceFps.toFixed(3)) : 0,
    maxDurationSec: spec.maxDurationSec,
  };
}

function validateDepthOutput(sourceMeta = {}, outputMeta = {}) {
  if (!(Number(outputMeta.width) > 0 && Number(outputMeta.height) > 0)) return '深度视频没有有效画面';
  const outputDuration = finiteNumber(outputMeta.videoDurationSec || outputMeta.durationSec);
  if (!(outputDuration > 0)) return '深度视频时长无效';
  const sourceDuration = finiteNumber(sourceMeta.videoDurationSec || sourceMeta.durationSec);
  if (sourceDuration > 0) {
    const delta = Math.abs(outputDuration - sourceDuration);
    if (delta > Math.max(1, sourceDuration * 0.2)) {
      return '深度视频时长和源视频差太多';
    }
  }
  return '';
}

function workerOptions(options = {}) {
  const serviceUrl = String(options.serviceUrl || '').trim().replace(/\/+$/, '');
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl || !serviceToken) {
    throw depthError('视频深度服务尚未配置，请联系管理员', 'VIDEO_DEPTH_WORKER_NOT_CONFIGURED', 503);
  }
  return { serviceUrl, serviceToken };
}

function workerHeaders(token, extra = {}) {
  return { ...extra, Authorization: 'Bearer ' + token };
}

function abortError() {
  const error = new Error('视频转深度已取消');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function normalizeWorkerError(error, label) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ERR_CANCELED') return abortError();
  const status = Number(error?.response?.status || 0);
  const data = error?.response?.data;
  const detail = typeof data === 'string' ? data : String(data?.detail || data?.error || error?.message || error || '').trim();
  if (status === 401 || status === 403) return depthError(label + ' 服务鉴权失败', 'VIDEO_DEPTH_WORKER_AUTH_FAILED', 502);
  if (status === 413) return depthError('源视频超过深度服务上传上限', 'VIDEO_DEPTH_SOURCE_TOO_LARGE', 400);
  return depthError(detail ? (label + ' 失败：' + detail) : (label + ' 服务不可用'), status ? 'VIDEO_DEPTH_WORKER_ERROR' : 'VIDEO_DEPTH_WORKER_UNAVAILABLE', status ? 502 : 503);
}

function reportProgress(onProgress, progressPercent) {
  if (typeof onProgress !== 'function') return;
  const parsed = finiteNumber(progressPercent);
  if (parsed > 0) onProgress(Math.max(1, Math.min(99, parsed)));
}

function sleepWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    setTimeout(() => signal.removeEventListener('abort', onAbort), ms + 1);
  });
}

async function deleteWorkerJob(jobId, options = {}) {
  if (!jobId) return;
  let configured;
  try { configured = workerOptions(options); } catch { return; }
  try {
    await axios.delete(configured.serviceUrl + '/v1/jobs/' + encodeURIComponent(jobId), {
      headers: workerHeaders(configured.serviceToken),
      timeout: 8000,
    });
  } catch { /* worker TTL also expires finished jobs */ }
}

async function renderDepthVideo(options = {}) {
  const request = validateDepthRequest(options);
  const inputPath = String(options.inputPath || '');
  const outputPath = String(options.outputPath || '');
  if (!inputPath || !fs.existsSync(inputPath)) throw depthError('源视频文件不存在，请重新导入视频', 'VIDEO_SOURCE_FILE_MISSING');
  if (!outputPath) throw depthError('深度视频输出路径无效', 'VIDEO_OUTPUT_PATH_INVALID');
  const configured = workerOptions(options);
  const timeoutMs = Math.max(60000, Number(options.timeoutMs || 0) || 6 * 60 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  const form = new FormData();
  const stat = fs.statSync(inputPath);
  form.append('file', fs.createReadStream(inputPath), { filename: path.basename(inputPath), contentType: 'video/mp4', knownLength: stat.size });
  form.append('provider', request.provider);
  form.append('encoder', request.encoder);
  form.append('max_res', String(request.maxRes));
  form.append('near', request.near);
  let workerJobId = '';
  try {
    const created = await axios.post(configured.serviceUrl + '/v1/depth-jobs', form, {
      headers: workerHeaders(configured.serviceToken, form.getHeaders()),
      timeout: Math.min(timeoutMs, 15 * 60 * 1000),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      signal: options.signal,
    });
    workerJobId = String(created.data?.jobId || '').trim();
    if (!workerJobId) throw depthError(request.label + ' 没有返回任务 ID', 'VIDEO_DEPTH_JOB_ID_MISSING', 502);
    reportProgress(options.onProgress, Math.max(1, Number(created.data?.progressPercent || 1)));
    let completed;
    let pollFailures = 0;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw abortError();
      let status;
      try {
        const response = await axios.get(configured.serviceUrl + '/v1/jobs/' + encodeURIComponent(workerJobId), {
          headers: workerHeaders(configured.serviceToken),
          timeout: 15000,
          signal: options.signal,
        });
        status = response.data || {};
        pollFailures = 0;
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') throw error;
        const httpStatus = Number(error?.response?.status || 0);
        if ((httpStatus > 0 && ![408, 425, 429, 500, 502, 503, 504].includes(httpStatus)) || pollFailures >= 6) {
          throw normalizeWorkerError(error, request.label);
        }
        pollFailures += 1;
        await sleepWithSignal(Math.min(5000, 500 * (2 ** (pollFailures - 1))), options.signal);
        continue;
      }
      reportProgress(options.onProgress, Math.max(1, Math.min(98, Number(status.progressPercent || 1))));
      if (status.status === 'succeeded') { completed = status; break; }
      if (status.status === 'failed') throw depthError(String(status.error || (request.label + ' 失败')), 'VIDEO_DEPTH_PROCESSING_FAILED', 502);
      if (status.status === 'cancelled') throw abortError();
      await sleepWithSignal(Math.max(500, Number(options.pollIntervalMs || 1000)), options.signal);
    }
    if (!completed) throw depthError(request.label + ' 处理超时', 'VIDEO_DEPTH_TIMEOUT', 504);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const response = await axios.get(configured.serviceUrl + '/v1/jobs/' + encodeURIComponent(workerJobId) + '/result', {
      headers: workerHeaders(configured.serviceToken),
      responseType: 'stream',
      timeout: Math.min(timeoutMs, 15 * 60 * 1000),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      signal: options.signal,
    });
    await pipeline(response.data, fs.createWriteStream(outputPath), { signal: options.signal });
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1) {
      throw depthError(request.label + ' 没有生成有效文件', 'VIDEO_DEPTH_RESULT_EMPTY', 502);
    }
    reportProgress(options.onProgress, 96);
    return { outputPath, workerJobId, ...request, metadata: completed.metadata || {} };
  } catch (error) {
    try { fs.rmSync(outputPath, { force: true }); } catch { /* best effort */ }
    if (error?.code?.startsWith?.('VIDEO_') || error?.name === 'AbortError') throw error;
    throw normalizeWorkerError(error, request.label);
  } finally {
    await deleteWorkerJob(workerJobId, options);
  }
}

module.exports = { MAX_RES_BY_PRESET, PROVIDERS, renderDepthVideo, validateDepthOutput, validateDepthRequest };

