'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const axios = require('axios');
const FormData = require('form-data');

function fail(message, code, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function configured(options = {}) {
  const serviceUrl = String(options.serviceUrl || '').trim().replace(/\/+$/, '');
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl || !serviceToken) throw fail('3D 模型转换服务尚未配置', 'DIRECTOR_STAGE_MODEL_NOT_CONFIGURED', 503);
  return { serviceUrl, serviceToken };
}

function detail(error) {
  const data = error?.response?.data;
  if (typeof data === 'string') return data.trim();
  if (typeof data?.detail === 'string') return data.detail.trim();
  return String(data?.error || error?.message || error || '').trim();
}

async function convertMaxToFbx(inputPath, options = {}) {
  const { serviceUrl, serviceToken } = configured(options);
  if (!inputPath || !fs.existsSync(inputPath)) throw fail('3ds Max 文件不存在', 'DIRECTOR_STAGE_MODEL_SOURCE_MISSING', 400);
  const form = new FormData();
  const stat = fs.statSync(inputPath);
  form.append('file', fs.createReadStream(inputPath), { filename: path.basename(inputPath), contentType: 'application/octet-stream', knownLength: stat.size });
  form.append('source_format', 'max');
  form.append('target_format', 'fbx');
  let created;
  try {
    created = await axios.post(serviceUrl + '/v1/3d-import-jobs', form, {
      headers: { ...form.getHeaders(), Authorization: 'Bearer ' + serviceToken },
      maxBodyLength: Infinity, maxContentLength: Infinity,
      timeout: Math.min(Number(options.requestTimeoutMs || 120000), 900000),
    });
  } catch (error) {
    throw fail('3D 模型转换服务提交失败：' + detail(error), 'DIRECTOR_STAGE_MODEL_WORKER_ERROR', 502);
  }
  const jobId = String(created.data?.jobId || '').trim();
  if (!jobId) throw fail('3D 模型转换服务未返回任务 ID', 'DIRECTOR_STAGE_MODEL_JOB_ID_MISSING', 502);
  const deadline = Date.now() + Math.max(60000, Number(options.timeoutMs || 30 * 60 * 1000));
  let status;
  while (Date.now() < deadline) {
    try {
      const response = await axios.get(serviceUrl + '/v1/jobs/' + encodeURIComponent(jobId), { headers: { Authorization: 'Bearer ' + serviceToken }, timeout: 30000 });
      status = response.data || {};
    } catch (error) {
      throw fail('3D 模型转换状态查询失败：' + detail(error), 'DIRECTOR_STAGE_MODEL_POLL_FAILED', 502);
    }
    if (status.status === 'succeeded') break;
    if (status.status === 'failed' || status.status === 'cancelled') throw fail(status.error || '3ds Max 转换失败', 'DIRECTOR_STAGE_MODEL_CONVERSION_FAILED', 422);
    await new Promise((resolve) => setTimeout(resolve, Math.max(500, Number(options.pollIntervalMs || 1500))));
  }
  if (status?.status !== 'succeeded') throw fail('3ds Max 转换超时', 'DIRECTOR_STAGE_MODEL_TIMEOUT', 504);
  if (!options.outputPath) throw fail('3D 模型转换缺少输出路径', 'DIRECTOR_STAGE_MODEL_OUTPUT_MISSING');
  try {
    const response = await axios.get(serviceUrl + '/v1/jobs/' + encodeURIComponent(jobId) + '/result', { headers: { Authorization: 'Bearer ' + serviceToken }, responseType: 'stream', timeout: 120000 });
    await pipeline(response.data, fs.createWriteStream(options.outputPath));
  } catch (error) {
    throw fail('3D 模型结果下载失败：' + detail(error), 'DIRECTOR_STAGE_MODEL_DOWNLOAD_FAILED', 502);
  }
  return { jobId, status, outputPath: options.outputPath };
}

module.exports = { convertMaxToFbx };
