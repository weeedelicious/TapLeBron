const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const INPUT_PROFILES = new Set([
  'rec709',
  'arri-logc3',
  'arri-logc4',
  'sony-slog3',
  'panasonic-vlog',
  'canon-log2',
  'canon-log3',
  'red-log3g10',
]);

const LOOKS = new Set([
  'motion-picture',
  'daylight-50d',
  'tungsten-200t',
  'daylight-250d',
  'tungsten-500t',
  'kodak-portra-400',
  'kodak-ektachrome-100d',
  'kodak-2383-print',
  'fuji-eterna-250d',
  'fuji-eterna-500t',
  'fuji-velvia-50',
  'low-contrast',
  'black-and-white',
]);

function colorGradeError(message, code = 'VIDEO_COLOR_GRADE_FAILED', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function boundedNumber(value, fallback, min, max, field) {
  const number = value === '' || value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw colorGradeError(field + ' 超出允许范围', 'VIDEO_COLOR_GRADE_PARAMS_INVALID', 400);
  }
  return number;
}

function normalizeRequest(value = {}) {
  const inputProfile = String(value.inputProfile || 'rec709').trim().toLowerCase();
  const look = String(value.look || 'motion-picture').trim().toLowerCase();
  if (!INPUT_PROFILES.has(inputProfile)) {
    throw colorGradeError('输入相机色彩空间无效', 'VIDEO_COLOR_GRADE_PROFILE_INVALID', 400);
  }
  if (!LOOKS.has(look)) {
    throw colorGradeError('胶片 Look 无效', 'VIDEO_COLOR_GRADE_LOOK_INVALID', 400);
  }
  return {
    inputProfile,
    look,
    exposure: boundedNumber(value.exposure, 0, -4, 4, '曝光'),
    temperature: boundedNumber(value.temperature, 0, -100, 100, '色温'),
    tint: boundedNumber(value.tint, 0, -100, 100, 'Tint'),
    contrast: boundedNumber(value.contrast, 1, 0.5, 1.5, '对比度'),
    saturation: boundedNumber(value.saturation, 1, 0, 2, '饱和度'),
    lift: boundedNumber(value.lift, 0, -0.2, 0.2, 'Lift'),
    gamma: boundedNumber(value.gamma, 1, 0.5, 2, 'Gamma'),
    gain: boundedNumber(value.gain, 1, 0.5, 2, 'Gain'),
    grain: boundedNumber(value.grain, 0.12, 0, 1, '颗粒'),
    provider: 'opencolorio',
    model: 'OpenColorIO 2.4.2 + FFmpeg',
  };
}

function workerConfig(options = {}) {
  const serviceUrl = String(options.serviceUrl || '').replace(/\/+$/, '');
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl || !serviceToken) {
    throw colorGradeError('影视校色服务未配置', 'VIDEO_COLOR_GRADE_SERVICE_UNAVAILABLE', 503);
  }
  return { serviceUrl, serviceToken };
}

async function createWorkerJob(inputPath, request, options = {}) {
  const { serviceUrl, serviceToken } = workerConfig(options);
  const form = new FormData();
  const stat = fs.statSync(inputPath);
  form.append('file', fs.createReadStream(inputPath), {
    filename: path.basename(inputPath),
    contentType: 'video/mp4',
    knownLength: stat.size,
  });
  for (const field of [
    'inputProfile', 'look', 'exposure', 'temperature', 'tint', 'contrast',
    'saturation', 'lift', 'gamma', 'gain', 'grain',
  ]) {
    const formName = field.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
    form.append(formName, String(request[field]));
  }
  const response = await axios.post(serviceUrl + '/v1/color-grade-jobs', form, {
    headers: { Authorization: 'Bearer ' + serviceToken, ...form.getHeaders() },
    timeout: 900000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    signal: options.signal,
  });
  const jobId = String(response.data?.jobId || '').trim();
  if (!jobId) {
    throw colorGradeError('影视校色服务没有返回任务 ID', 'VIDEO_COLOR_GRADE_JOB_ID_MISSING', 502);
  }
  return { jobId, payload: response.data || {} };
}

async function getWorkerJob(jobId, options = {}) {
  const { serviceUrl, serviceToken } = workerConfig(options);
  const response = await axios.get(serviceUrl + '/v1/jobs/' + encodeURIComponent(jobId), {
    headers: { Authorization: 'Bearer ' + serviceToken },
    timeout: 15000,
    signal: options.signal,
  });
  return response.data || {};
}

async function downloadWorkerResult(jobId, outputPath, options = {}) {
  const { serviceUrl, serviceToken } = workerConfig(options);
  const response = await axios.get(serviceUrl + '/v1/jobs/' + encodeURIComponent(jobId) + '/result', {
    headers: { Authorization: 'Bearer ' + serviceToken },
    responseType: 'stream',
    timeout: 900000,
    signal: options.signal,
  });
  await new Promise((resolve, reject) => {
    const target = fs.createWriteStream(outputPath);
    response.data.pipe(target);
    target.on('finish', resolve);
    target.on('error', reject);
    response.data.on('error', reject);
  });
}

module.exports = {
  normalizeRequest,
  createWorkerJob,
  getWorkerJob,
  downloadWorkerResult,
};
