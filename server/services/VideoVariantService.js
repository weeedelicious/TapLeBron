'use strict';
// 视频的 360P 预览版 / 1080P 查看版 / 封面图，和图片的 360 / 1080 是同一套规则：
//   节点里播放、悬停、小格子 → 预览版（短边 360，原帧率但最高 30 帧）
//   展开播放               → 查看版（短边 1080，原帧率；原片短边 ≤1080 且码率不高时直接播原片）
//   封面 / 缩略图轨道        → 封面图（第一帧，短边 360 的 WebP）
//   下载、生成参考、遮罩、补帧、合成、RV → 原片，不经过这里
//
// 转码优先交给 4090 GPU Worker（NVENC，见 services/ui-mask-worker），连不上才在本机用 libx264 算。
// 结果写在原片旁边：<名>_360.mp4、<名>_1080.mp4、<名>_poster.webp，记录在 <名>_variants.json。
// 只给上线之后产生的视频自动做（VIDEO_VARIANTS_SINCE_MS），旧视频以后统一补。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const VARIANT_VERSION = 1;
const PREVIEW_EDGE = 360;
const VIEWER_EDGE = 1080;
const PREVIEW_MAX_FPS = 30;
const VIEWER_BITRATE_THRESHOLD = 12_000_000;
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const DEFAULT_SINCE_MS = Date.parse('2026-11-04T11:30:00Z');
const MAX_PARALLEL = 2;

const VIDEO_VARIANT_NAME_RE = /_(?:360|1080)\.mp4$|_poster\.webp$|_variants\.json$/i;

function isVideoVariantName(storedName) {
  return VIDEO_VARIANT_NAME_RE.test(String(storedName || ''));
}

function sinceMs() {
  const value = process.env.VIDEO_VARIANTS_SINCE_MS;
  if (value === undefined || value === '') return DEFAULT_SINCE_MS;
  const number = Number(value);
  return Number.isFinite(number) ? number : DEFAULT_SINCE_MS;
}

function remoteConfig() {
  const url = String(process.env.VIDEO_VARIANT_REMOTE_URL || process.env.UI_MASK_REMOTE_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.VIDEO_VARIANT_REMOTE_TOKEN || process.env.UI_MASK_REMOTE_TOKEN || '').trim();
  return url && token ? { url, token } : null;
}

function fpsFromRate(rate) {
  const [num, den] = String(rate || '').split('/').map(Number);
  if (!num) return 0;
  return den ? num / den : num;
}

async function probe(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    // 线上 ffprobe 较老，不认 stream_side_data 这种细粒度写法；取整份 streams / format 自己挑
    '-show_streams', '-show_format',
    '-of', 'json', filePath,
  ], { timeout: 30_000 });
  const data = JSON.parse(stdout || '{}');
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) return null;
  const rotation = Math.abs(Number(
    video.side_data_list?.find((item) => item.rotation != null)?.rotation ?? video.tags?.rotate ?? 0,
  )) % 180;
  let width = Number(video.width) || 0;
  let height = Number(video.height) || 0;
  if (rotation === 90) [width, height] = [height, width];
  const fps = fpsFromRate(video.avg_frame_rate) || fpsFromRate(video.r_frame_rate);
  return {
    width,
    height,
    fps: fps ? Number(fps.toFixed(3)) : 0,
    durationSec: Number(Number(data.format?.duration || 0).toFixed(3)),
    bitRate: Number(data.format?.bit_rate || 0),
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  };
}

/** 按原片信息决定要做哪几份。返回 [{ key, name, shortEdge, fps, cq, crf, maxrateKbps, audioKbps }] */
function planOutputs(meta, base) {
  const shortEdge = Math.min(meta.width, meta.height);
  const outputs = [];
  const fastFps = meta.fps > PREVIEW_MAX_FPS + 0.5;
  const tinyAlready = shortEdge <= PREVIEW_EDGE && !fastFps && (!meta.bitRate || meta.bitRate <= 1_500_000);
  if (!tinyAlready) {
    outputs.push({
      key: 'preview', name: `${base}_${PREVIEW_EDGE}.mp4`, shortEdge: Math.min(PREVIEW_EDGE, shortEdge),
      fps: fastFps ? PREVIEW_MAX_FPS : null, cq: 30, crf: 30, maxrateKbps: 1200, audioKbps: 64,
    });
  }
  if (shortEdge > VIEWER_EDGE || meta.bitRate > VIEWER_BITRATE_THRESHOLD) {
    outputs.push({
      key: 'viewer', name: `${base}_${VIEWER_EDGE}.mp4`, shortEdge: Math.min(VIEWER_EDGE, shortEdge),
      fps: null, cq: 23, crf: 22, maxrateKbps: 12000, audioKbps: 128,
    });
  }
  return outputs;
}

function shortEdgeScale(edge) {
  return `scale='if(gte(iw,ih),-2,min(iw,${edge}))':'if(gte(iw,ih),min(ih,${edge}),-2)'`;
}

async function remoteCall(config, method, route, { body, timeout = 30_000, raw = false } = {}) {
  const isStream = body && typeof body.pipe === 'function';
  const response = await fetch(config.url + route, {
    method,
    headers: { 'X-Worker-Token': config.token, ...(body && !isStream ? { 'Content-Type': 'application/json' } : {}) },
    body: isStream ? body : body ? JSON.stringify(body) : undefined,
    ...(isStream ? { duplex: 'half' } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`4090 视频转码返回 ${response.status}${text ? '：' + text.slice(0, 300) : ''}`);
  }
  return raw ? response : response.json();
}

async function transcodeRemote(config, sourcePath, outputs, meta, folder) {
  const jobId = crypto.randomUUID();
  try {
    await remoteCall(config, 'PUT', `/video-variants/${jobId}/source`, { body: fs.createReadStream(sourcePath), timeout: 10 * 60_000 });
    const remoteNames = outputs.map((output) => ({ ...output, remoteName: `${output.key}.mp4` }));
    await remoteCall(config, 'POST', `/video-variants/${jobId}/run`, {
      timeout: 15 * 60_000,
      body: {
        hasAudio: meta.hasAudio,
        outputs: remoteNames.map((output) => ({
          name: output.remoteName, shortEdge: output.shortEdge, fps: output.fps,
          cq: output.cq, maxrateKbps: output.maxrateKbps, audioKbps: output.audioKbps,
        })),
      },
    });
    for (const output of remoteNames) {
      const response = await remoteCall(config, 'GET', `/video-variants/${jobId}/files/${output.remoteName}`, { timeout: 10 * 60_000, raw: true });
      const temporary = path.join(folder, `${output.name}.${process.pid}.${Date.now()}.part`);
      fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
      fs.renameSync(temporary, path.join(folder, output.name));
    }
  } finally {
    remoteCall(config, 'DELETE', `/video-variants/${jobId}`).catch(() => {});
  }
}

async function transcodeLocal(sourcePath, outputs, meta, folder) {
  for (const output of outputs) {
    const filters = [shortEdgeScale(output.shortEdge)];
    if (output.fps) filters.push(`fps=${output.fps}`);
    filters.push('format=yuv420p');
    const temporary = path.join(folder, `${output.name}.${process.pid}.${Date.now()}.part.mp4`);
    const args = ['-hide_banner', '-nostdin', '-y', '-i', sourcePath, '-map', '0:v:0', '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(output.crf), '-maxrate', `${output.maxrateKbps}k`,
      '-bufsize', `${output.maxrateKbps * 2}k`, '-threads', '2'];
    if (meta.hasAudio) args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', `${output.audioKbps}k`, '-ac', '2');
    else args.push('-an');
    args.push('-movflags', '+faststart', temporary);
    try {
      await execFileAsync('ffmpeg', args, { timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
      fs.renameSync(temporary, path.join(folder, output.name));
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
}

async function createPoster(sourcePath, posterPath, getSharp) {
  const frame = `${posterPath}.${process.pid}.${Date.now()}.png`;
  try {
    await execFileAsync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', sourcePath, '-frames:v', '1',
      '-vf', shortEdgeScale(PREVIEW_EDGE), frame], { timeout: 60_000 });
    const sharp = getSharp();
    if (sharp) await sharp(frame).webp({ quality: 80 }).toFile(posterPath);
    else fs.renameSync(frame, posterPath.replace(/\.webp$/, '.png'));
  } finally {
    fs.rmSync(frame, { force: true });
  }
}

function createVideoVariantService({ assetsDir, assetUrl, mirrorStoredAsset, getSharp }) {
  const inFlight = new Map();
  const waiting = [];
  let running = 0;

  const schedule = (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    pump();
  });
  function pump() {
    while (running < MAX_PARALLEL && waiting.length) {
      const next = waiting.shift();
      running += 1;
      Promise.resolve().then(next.task).then(next.resolve, next.reject).finally(() => { running -= 1; pump(); });
    }
  }

  function manifestPath(projectUuid, base) {
    return path.join(assetsDir(projectUuid), `${base}_variants.json`);
  }

  function readManifest(projectUuid, storedName) {
    const base = path.parse(storedName).name;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath(projectUuid, base), 'utf8'));
      return manifest?.version === VARIANT_VERSION ? manifest : null;
    } catch {
      return null;
    }
  }

  function variantsFromManifest(manifest) {
    if (!manifest) return null;
    const { version: _version, generatedAt: _at, computedOn: _on, ...variants } = manifest;
    return variants;
  }

  async function generate(projectUuid, storedName, sourcePath) {
    const folder = assetsDir(projectUuid);
    const base = path.parse(storedName).name;
    const meta = await probe(sourcePath);
    if (!meta || !meta.width || !meta.height) return null;
    const outputs = planOutputs(meta, base).filter((output) => !fs.existsSync(path.join(folder, output.name)));
    let computedOn = 'cached';
    if (outputs.length) {
      const remote = remoteConfig();
      computedOn = 'local';
      if (remote) {
        try {
          await transcodeRemote(remote, sourcePath, outputs, meta, folder);
          computedOn = '4090';
        } catch (error) {
          console.warn(`[video-variants] 4090 转码失败，改在本机算 ${projectUuid}/${storedName}:`, error.message);
          await transcodeLocal(sourcePath, outputs.filter((output) => !fs.existsSync(path.join(folder, output.name))), meta, folder);
        }
      } else {
        await transcodeLocal(sourcePath, outputs, meta, folder);
      }
    }
    const posterName = `${base}_poster.webp`;
    if (!fs.existsSync(path.join(folder, posterName))) {
      await createPoster(sourcePath, path.join(folder, posterName), getSharp).catch((error) => {
        console.warn(`[video-variants] 封面图失败 ${projectUuid}/${storedName}:`, error.message);
      });
    }
    const planned = planOutputs(meta, base);
    const variants = { width: meta.width, height: meta.height, fps: meta.fps, durationSec: meta.durationSec };
    const preview = planned.find((output) => output.key === 'preview');
    const viewer = planned.find((output) => output.key === 'viewer');
    variants.previewUrl = preview && fs.existsSync(path.join(folder, preview.name))
      ? assetUrl(projectUuid, preview.name)
      : assetUrl(projectUuid, storedName);
    if (viewer && fs.existsSync(path.join(folder, viewer.name))) variants.viewerUrl = assetUrl(projectUuid, viewer.name);
    if (fs.existsSync(path.join(folder, posterName))) variants.posterUrl = assetUrl(projectUuid, posterName);
    for (const output of planned) {
      const file = path.join(folder, output.name);
      if (fs.existsSync(file)) await mirrorStoredAsset(projectUuid, output.name, file, 'video/mp4');
    }
    if (variants.posterUrl) await mirrorStoredAsset(projectUuid, posterName, path.join(folder, posterName), 'image/webp');
    const manifest = { version: VARIANT_VERSION, generatedAt: Date.now(), computedOn, ...variants };
    const temporary = `${manifestPath(projectUuid, base)}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(manifest));
    fs.renameSync(temporary, manifestPath(projectUuid, base));
    console.info(`[video-variants] ${projectUuid}/${storedName} ${meta.width}x${meta.height}@${meta.fps} → ${planned.map((o) => o.key).join('+') || 'original'} (${computedOn})`);
    return variants;
  }

  /**
   * 确保这个视频有预览版。force=false 时只给 VIDEO_VARIANTS_SINCE_MS 之后的文件做。
   * 返回派生记录，或 null（不是视频 / 旧视频 / 失败）。
   */
  async function ensure(projectUuid, storedName, { force = false } = {}) {
    const name = String(storedName || '');
    if (!VIDEO_EXTS.has(path.extname(name).toLowerCase()) || isVideoVariantName(name) || /_display\.mp4$/i.test(name)) return null;
    const cached = variantsFromManifest(readManifest(projectUuid, name));
    if (cached) return cached;
    const sourcePath = path.join(assetsDir(projectUuid), name);
    if (!fs.existsSync(sourcePath)) return null;
    if (!force && fs.statSync(sourcePath).mtimeMs < sinceMs()) return null;
    const key = `${projectUuid}/${name}`;
    if (!inFlight.has(key)) {
      const job = schedule(() => generate(projectUuid, name, sourcePath))
        .catch((error) => {
          console.warn(`[video-variants] 失败 ${key}:`, error.message);
          return null;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    return inFlight.get(key);
  }

  /** 不等结果，只排进队列（上传 / 生成落盘时调用） */
  function kick(projectUuid, storedName) {
    ensure(projectUuid, storedName).catch(() => {});
  }

  return { ensure, kick, readManifest: (projectUuid, storedName) => variantsFromManifest(readManifest(projectUuid, storedName)) };
}

module.exports = { createVideoVariantService, isVideoVariantName, planOutputs };
