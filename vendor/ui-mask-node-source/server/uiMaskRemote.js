// Shotflow：把遮罩识别 / 导出放到 4090 GPU Worker 上跑（services/ui-mask-worker）。
//
// 线上服务器是 4 核、没有显卡，4K 视频识别 + 导出要 15~20 分钟。这里把任务目录里的
// 输入文件传给 4090，用同一份 ui_mask_worker.py 计算，进度轮询回来写进本地 status.json，
// 结束后整包取回任务目录。前端、任务格式、文件地址都不变。
// 环境变量：UI_MASK_REMOTE_URL（如 http://172.26.166.238:8094）、UI_MASK_REMOTE_TOKEN。
// 4090 连不上时自动回到本机计算，不让用户卡住。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const POLL_MS = 1000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export function remoteConfig() {
  const url = String(process.env.UI_MASK_REMOTE_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.UI_MASK_REMOTE_TOKEN || '').trim();
  return url && token ? { url, token } : null;
}

/** 只有不读别处文件的任务能远程算：识别、普通导出。实验、手画准备、模型草稿导出留在本机。 */
export function remoteEligible(request) {
  if (request.kind === 'analysis') return request.operation === 'detect';
  if (request.kind === 'export') return !request.modelBase;
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function atomic(file, data) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); }

async function call(config, method, route, { body, timeout = 30_000, raw = false } = {}) {
  const response = await fetch(config.url + route, {
    method,
    headers: { 'X-Worker-Token': config.token, ...(body && !(body instanceof Readable) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof Readable ? body : body ? JSON.stringify(body) : undefined,
    ...(body instanceof Readable ? { duplex: 'half' } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`4090 遮罩计算节点返回 ${response.status}${text ? '：' + text.slice(0, 200) : ''}`);
  }
  return raw ? response : response.json();
}

export async function remoteHealthy(config) {
  try { return Boolean((await call(config, 'GET', '/health', { timeout: 4000 })).ok); } catch { return false; }
}

async function upload(config, jobId, file, name) {
  await call(config, 'PUT', `/jobs/${jobId}/files/${name}`, { body: fs.createReadStream(file), timeout: UPLOAD_TIMEOUT_MS });
}

/** 原视频按大小判断 4090 上是否已有（同一个识别任务导出多次不重复传） */
async function uploadSource(config, jobId, file) {
  const have = await call(config, 'GET', `/jobs/${jobId}/inputs`);
  if (have['source.bin'] === fs.statSync(file).size) return;
  await upload(config, jobId, file, 'source.bin');
}

async function extractBundle(config, jobId, folder) {
  const response = await call(config, 'GET', `/jobs/${jobId}/bundle`, { timeout: UPLOAD_TIMEOUT_MS, raw: true });
  const tar = spawn('tar', ['-x', '-C', folder], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  tar.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => tar.on('close', resolve));
  await pipeline(Readable.fromWeb(response.body), tar.stdin);
  const code = await exited;
  if (code !== 0) throw new Error('取回 4090 计算结果失败：' + stderr.slice(0, 200));
}

/**
 * 远程跑一个任务。返回 { cancel, done }：cancel 发取消；done 在本地 status.json 写成终态后结束。
 * status.json 的终态必须在结果文件全部取回之后才写，前端看到 ready 时文件一定齐了。
 */
export function runRemote(config, { id, folder, request, onProgress }) {
  let cancelled = false;
  const statusFile = path.join(folder, 'status.json');
  const cancel = () => {
    cancelled = true;
    fs.writeFileSync(path.join(folder, 'cancel'), '');
    call(config, 'POST', `/jobs/${id}/cancel`).catch(() => {});
  };
  const done = (async () => {
    const write = (status) => { atomic(statusFile, status); onProgress?.(status); };
    try {
      write({ state: 'running', message: '上传到 4090 GPU 计算节点…', progress: 1 });
      await upload(config, id, path.join(folder, 'request.json'), 'request.json');
      if (request.kind === 'export') {
        await upload(config, id, path.join(folder, 'document.json'), 'document.json');
        const parentFolder = path.join(path.dirname(folder), request.parent);
        await upload(config, request.parent, path.join(parentFolder, 'request.json'), 'request.json');
        await uploadSource(config, request.parent, path.join(parentFolder, 'source.bin'));
      } else {
        await uploadSource(config, id, path.join(folder, 'source.bin'));
        const initial = path.join(folder, 'initial-document.json');
        if (fs.existsSync(initial)) await upload(config, id, initial, 'initial-document.json');
      }
      if (cancelled) throw new InterruptedError();
      await call(config, 'POST', `/jobs/${id}/start`);
      let last = '';
      let misses = 0;
      for (;;) {
        await sleep(POLL_MS);
        let remote;
        try {
          remote = await call(config, 'GET', `/jobs/${id}/status`, { timeout: 10_000 });
          misses = 0;
        } catch (error) {
          if (++misses >= 30) throw new Error('4090 遮罩计算节点连接中断，请重新运行：' + error.message);
          continue;
        }
        const status = remote.status;
        if (status && !remote.running && ['ready', 'failed', 'cancelled'].includes(status.state)) {
          if (status.state === 'ready') {
            await extractBundle(config, id, folder);
          }
          write({ ...status, message: status.message, computedOn: '4090' });
          return;
        }
        if (!remote.running && remote.exitCode != null) {
          write({ state: cancelled ? 'cancelled' : 'failed', message: `4090 上的任务已停止（${remote.exitCode}），可重新运行` });
          return;
        }
        const key = status ? JSON.stringify(status) : '';
        if (status && key !== last) {
          last = key;
          if (status.state === 'running') write({ ...status, message: `${status.message}（4090 GPU）` });
        }
      }
    } catch (error) {
      write({ state: cancelled ? 'cancelled' : 'failed', message: cancelled ? '已取消' : (error.message || '4090 遮罩计算失败，请重新运行') });
    }
  })();
  return { cancel, done };
}

class InterruptedError extends Error { constructor() { super('已取消'); } }
