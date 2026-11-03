const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const METHODS = {
  propainter: { provider: 'propainter', model: 'SAM 2 + ProPainter' },
  diffueraser: { provider: 'diffueraser', model: 'SAM 2 + DiffuEraser' },
};

function removalError(message, code = 'VIDEO_UI_REMOVAL_FAILED', statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  if (!METHODS[method]) throw removalError('去除 UI 方案无效', 'VIDEO_UI_REMOVAL_METHOD_INVALID', 400);
  return { method, ...METHODS[method] };
}

function workerConfig(options = {}) {
  const serviceUrl = String(options.serviceUrl || '').replace(/\/+$/, '');
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl || !serviceToken) throw removalError('去除 UI 服务未配置', 'VIDEO_UI_REMOVAL_SERVICE_UNAVAILABLE', 503);
  return { serviceUrl, serviceToken };
}

async function createWorkerJob(inputPath, request, options = {}) {
  const { serviceUrl, serviceToken } = workerConfig(options);
  const form = new FormData();
  const stat = require('fs').statSync(inputPath);
  form.append('file', fs.createReadStream(inputPath), { filename: path.basename(inputPath), contentType: 'video/mp4', knownLength: stat.size });
  form.append('method', request.method);
  const response = await axios.post(serviceUrl + '/v1/ui-removal-jobs', form, {
    headers: { Authorization: 'Bearer ' + serviceToken, ...form.getHeaders() },
    timeout: 900000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    signal: options.signal,
  });
  const jobId = String(response.data?.jobId || '').trim();
  if (!jobId) throw removalError('去除 UI 服务没有返回任务 ID', 'VIDEO_UI_REMOVAL_JOB_ID_MISSING', 502);
  return { jobId, payload: response.data || {} };
}

async function getWorkerJob(jobId, options = {}) {
  const { serviceUrl, serviceToken } = workerConfig(options);
  const response = await axios.get(serviceUrl + '/v1/jobs/' + encodeURIComponent(jobId), {
    headers: { Authorization: 'Bearer ' + serviceToken }, timeout: 15000, signal: options.signal,
  });
  return response.data || {};
}

async function downloadWorkerResult(jobId, outputPath, options = {}) {
  const { serviceUrl, serviceToken } = workerConfig(options);
  const response = await axios.get(serviceUrl + '/v1/jobs/' + encodeURIComponent(jobId) + '/result', {
    headers: { Authorization: 'Bearer ' + serviceToken }, responseType: 'stream', timeout: 900000, signal: options.signal,
  });
  await new Promise((resolve, reject) => {
    const target = fs.createWriteStream(outputPath);
    response.data.pipe(target);
    target.on('finish', resolve);
    target.on('error', reject);
    response.data.on('error', reject);
  });
}


async function previewMask(inputPath, options = {}) {
  const { serviceUrl, serviceToken } = workerConfig(options);
  const form = new FormData();
  const stat = fs.statSync(inputPath);
  form.append('file', fs.createReadStream(inputPath), { filename: path.basename(inputPath), contentType: 'video/mp4', knownLength: stat.size });
  try {
    const response = await axios.post(serviceUrl + '/v1/ui-removal-preview', form, {
      headers: { Authorization: 'Bearer ' + serviceToken, ...form.getHeaders() },
      responseType: 'stream', timeout: 300000, maxBodyLength: Infinity, maxContentLength: Infinity, signal: options.signal,
    });
    return { stream: response.data, coverage: response.headers['x-mask-coverage'] || '' };
  } catch (error) {
    let detail = '';
    const data = error && error.response && error.response.data;
    if (data && typeof data.on === 'function') {
      const chunks = [];
      await new Promise((resolve) => { data.on('data', (chunk) => chunks.push(chunk)); data.on('end', resolve); data.on('error', resolve); });
      const text = Buffer.concat(chunks).toString('utf8');
      try { const parsed = JSON.parse(text); detail = parsed.detail || parsed.error || text; } catch { detail = text; }
    }
    const statusCode = error && error.response && error.response.status ? error.response.status : 502;
    throw removalError(String(detail || error.message || 'mask preview failed').slice(0, 400), 'VIDEO_UI_REMOVAL_PREVIEW_FAILED', statusCode);
  }
}
module.exports = { normalizeMethod, createWorkerJob, getWorkerJob, downloadWorkerResult, previewMask };
