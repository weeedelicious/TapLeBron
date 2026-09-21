'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const FormData = require('form-data');

/**
 * Video frame interpolation service.
 *
 * GPU methods run on the Windows 4090 worker: OpenFlowFrames drives its pinned
 * rife-ncnn-vulkan runtime with an exact target frame count; Video2X 6.4 makes
 * a lossless integer-multiple intermediate that the worker retimes exactly.
 * The server-side fallback remains FFmpeg's motion-compensated `minterpolate`.
 * The output contract is explicit:
 * keep source dimensions, use H.264 High/yuv420p in an MP4 container, and
 * encode at CRF 12 so the RV-compatible copy remains high quality.
 */

const DEFAULT_TARGET_FPS = 30;
const SUPPORTED_TARGET_FPS = Object.freeze([30, 60, 120]);
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MIN_SOURCE_FPS = 1;
const MAX_SOURCE_FPS = 240;
const MAX_TARGET_FPS = 120;
const SUPPORTED_METHODS = new Set(['quality', 'openflowframes', 'video2x']);
const METHOD_IMPLEMENTATIONS = Object.freeze({
  quality: Object.freeze({
    method: 'quality',
    provider: 'ffmpeg-minterpolate',
    model: 'FFmpeg MCI 光流',
  }),
  openflowframes: Object.freeze({
    method: 'openflowframes',
    provider: 'openflowframes',
    model: 'OpenFlowFrames · RIFE 4.26',
  }),
  video2x: Object.freeze({
    method: 'video2x',
    provider: 'video2x',
    model: 'Video2X 6.4 · RIFE 4.26',
  }),
});
const SAFE_PRESETS = new Set([
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow',
]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundFps(value) {
  const parsed = finiteNumber(value);
  return parsed > 0 ? Number(parsed.toFixed(3)) : 0;
}

function interpolationError(message, code = 'VIDEO_FRAME_INTERPOLATION_INVALID', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validateInterpolationRequest(input = {}) {
  const sourceFps = roundFps(input.sourceFps ?? input.fps);
  const targetFps = Math.round(finiteNumber(input.targetFps || DEFAULT_TARGET_FPS));
  const method = String(input.method || input.interpolationMethod || 'quality').trim().toLowerCase();

  if (!SUPPORTED_METHODS.has(method)) {
    throw interpolationError('补帧方法无效', 'VIDEO_FRAME_INTERPOLATION_METHOD_INVALID');
  }

  if (!(sourceFps >= MIN_SOURCE_FPS && sourceFps <= MAX_SOURCE_FPS)) {
    throw interpolationError('无法读取源视频帧率，请重新导入视频后再试', 'VIDEO_SOURCE_FPS_UNAVAILABLE');
  }
  if (!(targetFps >= 1 && targetFps <= MAX_TARGET_FPS)) {
    throw interpolationError(`目标帧率必须在 1-${MAX_TARGET_FPS}fps 之间`, 'VIDEO_TARGET_FPS_INVALID');
  }
  if (targetFps <= sourceFps + 0.01) {
    throw interpolationError(
      `目标帧率必须高于源视频（当前源视频约 ${sourceFps}fps）`,
      'VIDEO_TARGET_FPS_NOT_HIGHER',
    );
  }
  if (!SUPPORTED_TARGET_FPS.includes(targetFps)) {
    throw interpolationError(
      `暂不支持 ${targetFps}fps，当前可选 ${SUPPORTED_TARGET_FPS.join(' / ')}fps`,
      'VIDEO_TARGET_FPS_UNSUPPORTED',
    );
  }

  const durationSec = finiteNumber(input.durationSec ?? input.duration);
  if (durationSec < 0) {
    throw interpolationError('源视频时长无效', 'VIDEO_SOURCE_DURATION_INVALID');
  }

  return {
    sourceFps,
    targetFps,
    durationSec: durationSec > 0 ? Number(durationSec.toFixed(3)) : 0,
    ...METHOD_IMPLEMENTATIONS[method],
  };
}

function evenDimension(value) {
  const parsed = Math.max(2, Math.round(finiteNumber(value)));
  return parsed % 2 === 0 ? parsed : parsed + 1;
}

/** Pad odd dimensions by one pixel instead of scaling or resampling. */
function interpolationFilter(targetFps, options = {}) {
  const fps = Math.round(finiteNumber(targetFps));
  const durationSec = finiteNumber(options.durationSec);
  if (!(durationSec > 0)) {
    throw interpolationError('无法读取源视频时长，请重新导入视频后再试', 'VIDEO_SOURCE_DURATION_UNAVAILABLE');
  }
  const trimDuration = Number(durationSec.toFixed(6));
  return [
    // Normalize sources whose edit list starts after zero before interpolation.
    'setpts=PTS-STARTPTS',
    // minterpolate needs future frames to finish the last cadence interval.
    // Two cloned tail frames let it flush that interval without inventing
    // motion beyond the real final frame.
    'tpad=stop_mode=clone:stop=2',
    `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
    // Remove the cloned guard tail at the source video-track duration. The
    // last emitted target frame now samples the cloned real final frame.
    `trim=start=0:duration=${trimDuration}`,
    'setpts=PTS-STARTPTS',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
  ].join(',');
}

function safePreset(value) {
  const preset = String(value || 'medium').trim().toLowerCase();
  return SAFE_PRESETS.has(preset) ? preset : 'medium';
}

function buildFfmpegArgs(inputPath, outputPath, targetFps, options = {}) {
  const rawCrf = finiteNumber(options.crf, 12);
  const crf = Math.max(0, Math.min(51, Math.round(rawCrf)));
  const preset = safePreset(options.preset);
  const audioBitrateKbps = Math.max(64, Math.round(finiteNumber(options.audioBitrateKbps, 192)));
  const copyAudio = options.copyAudio === true;

  const args = [
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    String(inputPath),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    interpolationFilter(targetFps, options),
    // minterpolate already creates exact target timestamps. `-vsync 0` is
    // the FFmpeg-4-compatible spelling of passthrough (the production host
    // currently runs 4.4.x; newer `-fps_mode passthrough` is not recognized).
    // It avoids a second muxer-side duplicate/drop pass that can trim tail
    // frames.
    '-vsync',
    '0',
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-crf',
    String(crf),
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-tag:v',
    'avc1',
  ];

  // AAC is already RV/MP4 compatible. Remux it byte-for-byte instead of
  // introducing another lossy encode; other codecs are converted once.
  if (copyAudio) {
    args.push('-c:a', 'copy');
  } else {
    args.push(
      '-c:a', 'aac',
      '-b:a', `${audioBitrateKbps}k`,
      '-af', 'aresample=async=1:first_pts=0',
    );
  }

  args.push(
    // Do not use -shortest here: with interpolated video it can discard the
    // last one or two cadence slots. Keeping the mapped source audio preserves
    // both the complete video tail and the original audio packet timeline.
    '-map_metadata', '0',
    // Keep presentation timestamps at zero. `make_zero` shifts the whole MP4
    // forward to hide x264's normal negative B-frame DTS, leaving blank video
    // slots at the head in RV. MP4 edit lists safely carry the negative DTS.
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    String(outputPath),
  );
  return args;
}

function abortError() {
  const error = new Error('视频补帧已取消');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function timeoutError() {
  const error = new Error('视频补帧超时，请缩短视频后重试');
  error.code = 'VIDEO_FRAME_INTERPOLATION_TIMEOUT';
  error.statusCode = 504;
  return error;
}

function reportProgress(onProgress, value) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(value);
  } catch {
    // Progress reporting must never break a valid FFmpeg run.
  }
}

function parseProgressLines(buffer, state, durationSec, onProgress) {
  const lines = String(buffer || '').split(/\r?\n/);
  const remainder = lines.pop() || '';
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw < 0) continue;

    // FFmpeg uses microseconds for both keys (the `_ms` spelling is historic).
    state.outTimeSec = raw / 1_000_000;
    if (durationSec > 0) {
      const ratio = Math.max(0, Math.min(1, state.outTimeSec / durationSec));
      reportProgress(onProgress, Math.max(5, Math.min(92, Math.round(5 + ratio * 87))));
    }
  }
  return remainder;
}

function runFfmpeg(args, options = {}) {
  const durationSec = finiteNumber(options.durationSec);
  const timeoutMs = Math.max(10_000, finiteNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS));
  const signal = options.signal;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let child;
    try {
      child = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let requestedAbort = false;
    let requestedTimeout = false;
    let stderr = '';
    let progressBuffer = '';
    const progressState = { outTimeSec: 0 };
    let timeoutId;
    let killId;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (killId) clearTimeout(killId);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };

    const killChild = () => {
      if (!child || child.killed) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // The close event still resolves the process on platforms without SIGTERM.
      }
      killId = setTimeout(() => {
        if (!child || child.killed) return;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2500);
    };

    const onAbort = () => {
      requestedAbort = true;
      killChild();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    timeoutId = setTimeout(() => {
      requestedTimeout = true;
      killChild();
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      progressBuffer += String(chunk || '');
      progressBuffer = parseProgressLines(progressBuffer, progressState, durationSec, options.onProgress);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '');
      if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, closeSignal) => {
      if (requestedAbort) {
        finish(abortError());
        return;
      }
      if (requestedTimeout) {
        finish(timeoutError());
        return;
      }
      if (code === 0) {
        reportProgress(options.onProgress, 92);
        finish(null, { code, signal: closeSignal, stderr });
        return;
      }
      const detail = stderr.trim();
      const error = new Error(detail || `ffmpeg exited with code ${code ?? 'unknown'}`);
      error.code = 'VIDEO_FRAME_INTERPOLATION_FFMPEG_FAILED';
      error.exitCode = code;
      error.signal = closeSignal;
      finish(error);
    });
  });
}

async function interpolateVideoFfmpeg(options = {}) {
  const inputPath = String(options.inputPath || '');
  const outputPath = String(options.outputPath || '');
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw interpolationError('源视频文件不存在，请重新导入视频', 'VIDEO_SOURCE_FILE_MISSING');
  }
  if (!outputPath) {
    throw interpolationError('补帧输出路径无效', 'VIDEO_OUTPUT_PATH_INVALID');
  }

  const request = validateInterpolationRequest(options);
  const parent = path.dirname(outputPath);
  if (parent) fs.mkdirSync(parent, { recursive: true });
  const args = buildFfmpegArgs(inputPath, outputPath, request.targetFps, options);
  reportProgress(options.onProgress, 4);
  await runFfmpeg(args, {
    durationSec: request.durationSec,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) {
    throw new Error('FFmpeg 没有生成完整的补帧视频');
  }
  reportProgress(options.onProgress, 94);
  return {
    outputPath,
    sourceFps: request.sourceFps,
    targetFps: request.targetFps,
    durationSec: request.durationSec,
    provider: 'ffmpeg-minterpolate',
    qualityMode: 'quality',
    crf: Math.round(Math.max(0, Math.min(51, finiteNumber(options.crf, 12)))),
    preset: safePreset(options.preset),
  };
}

function workerOptions(options = {}) {
  const serviceUrl = String(options.serviceUrl || '').trim().replace(/\/+$/, '');
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl || !serviceToken) {
    throw interpolationError(
      'GPU 补帧服务尚未配置，请联系管理员',
      'VIDEO_FRAME_INTERPOLATION_WORKER_NOT_CONFIGURED',
      503,
    );
  }
  return { serviceUrl, serviceToken };
}

function workerHeaders(token, extra = {}) {
  return { ...extra, Authorization: `Bearer ${token}` };
}

function normalizeWorkerError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ERR_CANCELED') {
    return abortError();
  }
  const status = Number(error?.response?.status || 0);
  const data = error?.response?.data;
  const detail = typeof data === 'string'
    ? data
    : String(data?.detail || data?.error || error?.message || error || '').trim();
  if (status === 401 || status === 403) {
    return interpolationError('GPU 补帧服务鉴权失败', 'VIDEO_FRAME_INTERPOLATION_WORKER_AUTH_FAILED', 502);
  }
  if (status === 413) {
    return interpolationError('源视频超过 GPU 补帧服务上传上限', 'VIDEO_FRAME_INTERPOLATION_SOURCE_TOO_LARGE', 400);
  }
  return interpolationError(
    detail ? `GPU 补帧服务失败：${detail}` : 'GPU 补帧服务不可用',
    status ? 'VIDEO_FRAME_INTERPOLATION_WORKER_ERROR' : 'VIDEO_FRAME_INTERPOLATION_WORKER_UNAVAILABLE',
    status ? 502 : 503,
  );
}

function sleepWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
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

async function deleteWorkerJob(jobId, options = {}) {
  if (!jobId) return;
  let configured;
  try { configured = workerOptions(options); } catch { return; }
  try {
    await axios.delete(`${configured.serviceUrl}/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: workerHeaders(configured.serviceToken),
      timeout: 8_000,
    });
  } catch {
    // Best effort: the worker also expires finished jobs by TTL.
  }
}

async function interpolateVideoGpu(options = {}) {
  const request = validateInterpolationRequest(options);
  if (request.method === 'quality') return interpolateVideoFfmpeg(options);
  const inputPath = String(options.inputPath || '');
  const outputPath = String(options.outputPath || '');
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw interpolationError('源视频文件不存在，请重新导入视频', 'VIDEO_SOURCE_FILE_MISSING');
  }
  if (!outputPath) {
    throw interpolationError('补帧输出路径无效', 'VIDEO_OUTPUT_PATH_INVALID');
  }
  const configured = workerOptions(options);
  const timeoutMs = Math.max(60_000, Number(options.timeoutMs || 0) || 12 * 60 * 60_000);
  const deadline = Date.now() + timeoutMs;
  const form = new FormData();
  const stat = fs.statSync(inputPath);
  form.append('file', fs.createReadStream(inputPath), {
    filename: path.basename(inputPath),
    contentType: 'video/mp4',
    knownLength: stat.size,
  });
  form.append('target_fps', String(request.targetFps));
  form.append('interpolation_engine', request.method);
  let workerJobId = '';
  try {
    const created = await axios.post(`${configured.serviceUrl}/v1/interpolation-jobs`, form, {
      headers: workerHeaders(configured.serviceToken, form.getHeaders()),
      timeout: Math.min(timeoutMs, 15 * 60_000),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      signal: options.signal,
    });
    workerJobId = String(created.data?.jobId || '').trim();
    if (!workerJobId) {
      throw interpolationError('GPU 补帧服务没有返回任务 ID', 'VIDEO_FRAME_INTERPOLATION_JOB_ID_MISSING', 502);
    }
    reportProgress(options.onProgress, Math.max(1, Number(created.data?.progressPercent || 1)));
    let completed;
    let pollFailures = 0;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw abortError();
      let status;
      try {
        const response = await axios.get(
          `${configured.serviceUrl}/v1/jobs/${encodeURIComponent(workerJobId)}`,
          {
            headers: workerHeaders(configured.serviceToken),
            timeout: 15_000,
            signal: options.signal,
          },
        );
        status = response.data || {};
        pollFailures = 0;
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') throw error;
        const httpStatus = Number(error?.response?.status || 0);
        if ((httpStatus > 0 && ![408, 425, 429, 500, 502, 503, 504].includes(httpStatus)) || pollFailures >= 6) {
          throw normalizeWorkerError(error);
        }
        pollFailures += 1;
        await sleepWithSignal(Math.min(5_000, 500 * (2 ** (pollFailures - 1))), options.signal);
        continue;
      }
      reportProgress(options.onProgress, Math.max(1, Math.min(98, Number(status.progressPercent || 1))));
      if (status.status === 'succeeded') {
        completed = status;
        break;
      }
      if (status.status === 'failed') {
        throw interpolationError(
          String(status.error || 'GPU 补帧失败'),
          'VIDEO_FRAME_INTERPOLATION_PROCESSING_FAILED',
          502,
        );
      }
      if (status.status === 'cancelled') throw abortError();
      await sleepWithSignal(Math.max(250, Number(options.pollIntervalMs || 1_000)), options.signal);
    }
    if (!completed) {
      throw interpolationError('GPU 补帧处理超时', 'VIDEO_FRAME_INTERPOLATION_TIMEOUT', 504);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const response = await axios.get(
      `${configured.serviceUrl}/v1/jobs/${encodeURIComponent(workerJobId)}/result`,
      {
        headers: workerHeaders(configured.serviceToken),
        responseType: 'stream',
        timeout: Math.min(timeoutMs, 15 * 60_000),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        signal: options.signal,
      },
    );
    await pipeline(response.data, fs.createWriteStream(outputPath), { signal: options.signal });
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1) {
      throw interpolationError('GPU 补帧没有生成有效文件', 'VIDEO_FRAME_INTERPOLATION_RESULT_EMPTY', 502);
    }
    reportProgress(options.onProgress, 94);
    return {
      outputPath,
      workerJobId,
      sourceFps: request.sourceFps,
      targetFps: request.targetFps,
      durationSec: request.durationSec,
      provider: request.provider,
      model: request.model,
      method: request.method,
      metadata: completed.metadata || {},
      qualityMode: 'quality',
      crf: 12,
      preset: 'slow',
    };
  } catch (error) {
    try { fs.rmSync(outputPath, { force: true }); } catch { /* best effort */ }
    if (error?.code?.startsWith?.('VIDEO_') || error?.name === 'AbortError') throw error;
    throw normalizeWorkerError(error);
  } finally {
    await deleteWorkerJob(workerJobId, options);
  }
}

async function interpolateVideo(options = {}) {
  const request = validateInterpolationRequest(options);
  if (request.method === 'quality') return interpolateVideoFfmpeg(options);
  return interpolateVideoGpu({ ...options, ...request });
}

function compatibleFormat(meta = {}) {
  const formatNames = String(meta.formatName || '').toLowerCase().split(',').map((value) => value.trim());
  return String(meta.extension || '').toLowerCase() === 'mp4'
    && formatNames.includes('mp4')
    && String(meta.codecName || '').toLowerCase() === 'h264'
    && ['yuv420p', 'yuvj420p'].includes(String(meta.pixelFormat || '').toLowerCase())
    && (!meta.codecProfile || /high/i.test(String(meta.codecProfile)))
    && (!meta.audioCodecName || String(meta.audioCodecName).toLowerCase() === 'aac');
}

/** Validate the actual ffprobe result before it is written into the canvas. */
function validateInterpolationOutput(sourceMeta = {}, outputMeta = {}, targetFps) {
  if (!compatibleFormat(outputMeta)) {
    return '补帧结果不是 RV 兼容的 H.264/yuv420p MP4';
  }

  const sourceWidth = finiteNumber(sourceMeta.width);
  const sourceHeight = finiteNumber(sourceMeta.height);
  const expectedWidth = sourceWidth > 0 ? evenDimension(sourceWidth) : 0;
  const expectedHeight = sourceHeight > 0 ? evenDimension(sourceHeight) : 0;
  if (expectedWidth && finiteNumber(outputMeta.width) !== expectedWidth) {
    return '补帧结果改变了视频宽度';
  }
  if (expectedHeight && finiteNumber(outputMeta.height) !== expectedHeight) {
    return '补帧结果改变了视频高度';
  }

  const actualFps = finiteNumber(outputMeta.fps);
  const expectedFps = finiteNumber(targetFps);
  if (!(actualFps > 0) || !(expectedFps > 0) || Math.abs(actualFps - expectedFps) > Math.max(0.05, expectedFps * 0.002)) {
    return `补帧结果帧率不是 ${expectedFps}fps`;
  }

  const sourceDuration = finiteNumber(sourceMeta.durationSec);
  const outputDuration = finiteNumber(outputMeta.durationSec);
  if (sourceDuration > 0 && outputDuration > 0
      && Math.abs(sourceDuration - outputDuration) > Math.max(0.3, sourceDuration * 0.03)) {
    return '补帧结果改变了视频时长';
  }
  if (sourceMeta.audioCodecName && !outputMeta.audioCodecName) {
    return '补帧结果丢失了原视频音轨';
  }
  return '';
}

module.exports = {
  DEFAULT_TARGET_FPS,
  SUPPORTED_TARGET_FPS,
  SUPPORTED_METHODS,
  METHOD_IMPLEMENTATIONS,
  DEFAULT_TIMEOUT_MS,
  interpolationFilter,
  buildFfmpegArgs,
  validateInterpolationRequest,
  validateInterpolationOutput,
  compatibleFormat,
  runFfmpeg,
  interpolateVideoFfmpeg,
  interpolateVideoGpu,
  interpolateVideo,
};
