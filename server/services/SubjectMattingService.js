const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');

const MODEL_ID = 'ZhengPeng7/BiRefNet';
const MODEL_REVISION = 'e2bf8e4';
const LOCAL_MODEL_ID = 'local-border-flood-fill';
const MAX_FALLBACK_EDGE = 1024;
const REMOTE_MIN_RELIABLE_COVERAGE = 0.015;
const REMOTE_MAX_RELIABLE_COVERAGE = 0.96;
const REMOTE_MAX_RELIABLE_BORDER_COVERAGE = 0.55;

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function colorDistance(data, index, color) {
  const dr = data[index] - color[0];
  const dg = data[index + 1] - color[1];
  const db = data[index + 2] - color[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function estimateBorderColor(data, width, height, channels) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 64));
  const add = (x, y) => {
    const index = (y * width + x) * channels;
    r += data[index];
    g += data[index + 1];
    b += data[index + 2];
    count += 1;
  };
  for (let x = 0; x < width; x += step) {
    add(x, 0);
    add(x, height - 1);
  }
  for (let y = 0; y < height; y += step) {
    add(0, y);
    add(width - 1, y);
  }
  return [r / Math.max(1, count), g / Math.max(1, count), b / Math.max(1, count)];
}

async function buildLocalFallbackSubjectMask(sourceBuffer) {
  const metadata = await sharp(sourceBuffer, { failOn: 'none' }).rotate().metadata();
  const originalWidth = Number(metadata.width || 0);
  const originalHeight = Number(metadata.height || 0);
  if (!originalWidth || !originalHeight) {
    throw new Error('Subject matting source image dimensions could not be read');
  }

  const scale = Math.min(1, MAX_FALLBACK_EDGE / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.round(originalWidth * scale));
  const height = Math.max(1, Math.round(originalHeight * scale));
  const { data, info } = await sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const bgColor = estimateBorderColor(data, width, height, channels);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const threshold = 54;
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = y * width + x;
    if (visited[offset]) return;
    const index = offset * channels;
    if (data[index + 3] < 8 || colorDistance(data, index, bgColor) <= threshold) {
      visited[offset] = 1;
      queue[tail] = offset;
      tail += 1;
    }
  };

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  while (head < tail) {
    const offset = queue[head];
    head += 1;
    const x = offset % width;
    const y = Math.floor(offset / width);
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  const mask = Buffer.alloc(width * height);
  let selected = 0;
  for (let index = 0; index < visited.length; index += 1) {
    const alpha = visited[index] ? 0 : 255;
    mask[index] = alpha;
    if (alpha) selected += 1;
  }
  let coverage = selected / Math.max(1, width * height);
  let maskPipeline = sharp(mask, { raw: { width, height, channels: 1 } });
  if (coverage < 0.025 || coverage > 0.96) {
    const svg = Buffer.from(`
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="black"/>
        <ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * 0.34}" ry="${height * 0.42}" fill="white"/>
      </svg>
    `);
    maskPipeline = sharp(svg);
    coverage = Math.PI * (width * 0.34) * (height * 0.42) / Math.max(1, width * height);
  }

  const maskBuffer = await maskPipeline
    .resize(originalWidth, originalHeight, { fit: 'fill', kernel: 'cubic' })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    provider: LOCAL_MODEL_ID,
    modelId: LOCAL_MODEL_ID,
    modelRevision: null,
    status: 'fallback',
    width: originalWidth,
    height: originalHeight,
    maskCoverage: coverage,
    maskBuffer,
    sha1: sha1(maskBuffer),
    warning: 'BiRefNet service unavailable; using local fallback mask.',
  };
}

function decodeRemoteImageAsset(asset, key) {
  if (!asset) throw new Error(`BiRefNet response is missing ${key}`);
  const payload = typeof asset === 'string' ? { data: asset } : asset;
  const base64 = String(payload.data || payload.base64 || '');
  if (!base64) throw new Error(`BiRefNet response ${key} has no data`);
  const clean = base64.includes(',') ? base64.split(',').pop() : base64;
  return Buffer.from(clean, 'base64');
}

function isReliableRemoteCoverage(value) {
  const coverage = Number(value);
  return Number.isFinite(coverage)
    && coverage >= REMOTE_MIN_RELIABLE_COVERAGE
    && coverage <= REMOTE_MAX_RELIABLE_COVERAGE;
}

async function analyzeMaskCoverage(maskBuffer, width, height) {
  const decodedWidth = Math.max(1, Number(width || 0));
  const decodedHeight = Math.max(1, Number(height || 0));
  if (!decodedWidth || !decodedHeight) return null;
  const { data, info } = await sharp(maskBuffer, { failOn: 'none' })
    .resize(decodedWidth, decodedHeight, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = Math.max(1, Number(info.channels || 1));
  let selected = 0;
  for (let index = 0; index < decodedWidth * decodedHeight; index += 1) {
    if (data[index * channels] > 16) selected += 1;
  }
  return selected / Math.max(1, decodedWidth * decodedHeight);
}

async function analyzeMaskReliability(maskBuffer, width, height) {
  const decodedWidth = Math.max(1, Number(width || 0));
  const decodedHeight = Math.max(1, Number(height || 0));
  if (!decodedWidth || !decodedHeight) {
    return { coverage: null, borderCoverage: null, reliable: false };
  }

  const { data, info } = await sharp(maskBuffer, { failOn: 'none' })
    .resize(decodedWidth, decodedHeight, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = Math.max(1, Number(info.channels || 1));
  const border = Math.max(8, Math.round(Math.min(decodedWidth, decodedHeight) * 0.035));
  let selected = 0;
  let borderSelected = 0;
  let borderTotal = 0;
  let minX = decodedWidth;
  let minY = decodedHeight;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < decodedHeight; y += 1) {
    for (let x = 0; x < decodedWidth; x += 1) {
      const value = data[(y * decodedWidth + x) * channels];
      const isSelected = value > 16;
      if (isSelected) {
        selected += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const isBorder = x < border
        || y < border
        || x >= decodedWidth - border
        || y >= decodedHeight - border;
      if (isBorder) {
        borderTotal += 1;
        if (isSelected) borderSelected += 1;
      }
    }
  }

  const coverage = selected / Math.max(1, decodedWidth * decodedHeight);
  const borderCoverage = borderSelected / Math.max(1, borderTotal);
  const touchedEdges = selected > 0
    ? [
      minX <= border,
      minY <= border,
      maxX >= decodedWidth - border - 1,
      maxY >= decodedHeight - border - 1,
    ].filter(Boolean).length
    : 0;
  const isFullFrameFlood = coverage > 0.92 && borderCoverage > 0.55;
  const isBorderFlood = coverage > 0.78 && borderCoverage > REMOTE_MAX_RELIABLE_BORDER_COVERAGE && touchedEdges >= 4;
  return {
    coverage,
    borderCoverage,
    touchedEdges,
    reliable: isReliableRemoteCoverage(coverage)
      && borderCoverage <= REMOTE_MAX_RELIABLE_BORDER_COVERAGE
      && !isFullFrameFlood
      && !isBorderFlood,
  };
}

async function buildRemoteSubjectMask(sourceBuffer, options = {}) {
  const serviceUrl = String(options.serviceUrl || '').trim().replace(/\/+$/, '');
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl || !serviceToken) throw new Error('BiRefNet subject matting service is not configured');

  const form = new FormData();
  form.append('file', sourceBuffer, {
    filename: 'subject-source.png',
    contentType: 'image/png',
    knownLength: sourceBuffer.length,
  });
  const response = await axios.post(`${serviceUrl}/v1/subject-mask`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${serviceToken}`,
    },
    timeout: Math.max(30_000, Number(options.timeoutMs || 180_000)),
    maxBodyLength: 96 * 1024 * 1024,
    maxContentLength: 96 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const payload = response.data || {};
  const maskBuffer = decodeRemoteImageAsset(payload.assets?.mask || payload.mask, 'mask');
  const width = Number(payload.width || 0);
  const height = Number(payload.height || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('BiRefNet response has invalid dimensions');
  }
  const reliability = await analyzeMaskReliability(maskBuffer, width, height);

  return {
    provider: 'birefnet-worker',
    modelId: payload.modelId || MODEL_ID,
    modelRevision: payload.modelRevision || MODEL_REVISION,
    status: 'ready',
    width,
    height,
    maskCoverage: reliability.coverage ?? (Number(payload.maskCoverage || 0) || null),
    maskBorderCoverage: reliability.borderCoverage,
    maskTouchedEdges: reliability.touchedEdges,
    maskReliable: reliability.reliable,
    maskBuffer,
    sha1: sha1(maskBuffer),
  };
}

async function buildRemoteSubjectCorrection(sourceBuffer, options = {}) {
  const serviceUrl = String(options.serviceUrl || '').trim().replace(/\/+$/, '');
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl || !serviceToken) throw new Error('SAM correction service is not configured');
  const promptType = String(options.promptType || '').trim();
  if (!['point', 'box'].includes(promptType)) throw new Error('Invalid SAM correction prompt type');

  const form = new FormData();
  form.append('file', sourceBuffer, {
    filename: 'subject-source.png',
    contentType: 'image/png',
    knownLength: sourceBuffer.length,
  });
  // A point correction must segment the clicked region; keep/exclude is applied by the web mask compositor.
  const workerIntent = promptType === 'point' ? 'keep' : String(options.intent || 'keep');
  form.append('intent', workerIntent);
  form.append('promptType', promptType);
  form.append('taskVersion', String(Number(options.taskVersion || 0)));
  if (options.point) {
    form.append('pointX', String(Number(options.point.x)));
    form.append('pointY', String(Number(options.point.y)));
  }
  if (options.box) {
    form.append('boxX', String(Number(options.box.x)));
    form.append('boxY', String(Number(options.box.y)));
    form.append('boxWidth', String(Number(options.box.width)));
    form.append('boxHeight', String(Number(options.box.height)));
  }
  const response = await axios.post(`${serviceUrl}/v1/subject-correction`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${serviceToken}`,
    },
    timeout: Math.max(30_000, Number(options.timeoutMs || 180_000)),
    maxBodyLength: 96 * 1024 * 1024,
    maxContentLength: 96 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const payload = response.data || {};
  const maskBuffer = decodeRemoteImageAsset(payload.assets?.mask || payload.mask, 'mask');
  const width = Number(payload.width || 0);
  const height = Number(payload.height || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('SAM correction response has invalid dimensions');
  }
  const maskCoverage = await analyzeMaskCoverage(maskBuffer, width, height);
  return {
    provider: 'sam-worker',
    modelId: payload.modelId || 'facebook/sam2.1-hiera-large',
    modelRevision: payload.modelRevision || '2.1',
    status: 'ready',
    width,
    height,
    maskCoverage,
    maskBuffer,
    sha1: sha1(maskBuffer),
    taskVersion: Number(payload.taskVersion || options.taskVersion || 0),
  };
}

async function buildSubjectMask(sourceBuffer, options = {}) {
  if (options.serviceUrl && options.serviceToken) {
    try {
      const remote = await buildRemoteSubjectMask(sourceBuffer, options);
      if (!remote.maskReliable) {
        const fallback = await buildLocalFallbackSubjectMask(sourceBuffer);
        const percent = Number.isFinite(Number(remote.maskCoverage))
          ? `${Math.round(Number(remote.maskCoverage) * 100)}%`
          : 'unknown';
        const borderPercent = Number.isFinite(Number(remote.maskBorderCoverage))
          ? `${Math.round(Number(remote.maskBorderCoverage) * 100)}%`
          : 'unknown';
        fallback.warning = `BiRefNet mask is abnormal (coverage ${percent}, border ${borderPercent}, edges ${remote.maskTouchedEdges ?? 'unknown'}); using local fallback mask.`;
        return fallback;
      }
      return remote;
    } catch (error) {
      if (options.allowLocalFallback === false) throw error;
      const fallback = await buildLocalFallbackSubjectMask(sourceBuffer);
      fallback.warning = `BiRefNet unavailable; using local fallback: ${error.message || error}`;
      return fallback;
    }
  }
  return buildLocalFallbackSubjectMask(sourceBuffer);
}

module.exports = {
  MODEL_ID,
  MODEL_REVISION,
  LOCAL_MODEL_ID,
  buildSubjectMask,
  buildRemoteSubjectMask,
  buildRemoteSubjectCorrection,
  buildLocalFallbackSubjectMask,
  isReliableRemoteCoverage,
};
