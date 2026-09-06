const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');

const MODEL_ID = 'moge-2-vitb-normal';
const LOCAL_MODEL_ID = 'local-relief-v1';
const MAX_PREVIEW_SIDE = 1024;
const GEOMETRY_ASSET_VERSION = 4;
const LIGHT_MASK_ASSET_VERSION = 2;
const NORMAL_CONVENTION = 'opengl-object';
const DEFAULT_WORKER_HEALTH_TIMEOUT_MS = 2_500;
const WORKER_UNAVAILABLE_RETRY_MS = 60_000;

let workerUnavailableCache = {
  key: '',
  retryAtMs: 0,
  reason: '',
};

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const ANCHOR_VECTORS = {
  front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0],
  'front-left': [-1, 0, 1], 'front-right': [1, 0, 1], 'back-left': [-1, 0, -1], 'back-right': [1, 0, -1],
  'top-front': [0, 1, 1], 'top-back': [0, 1, -1], 'top-left': [-1, 1, 0], 'top-right': [1, 1, 0],
  'top-front-left': [-1, 1, 1], 'top-front-right': [1, 1, 1], 'top-back-left': [-1, 1, -1], 'top-back-right': [1, 1, -1],
  'bottom-front': [0, -1, 1], 'bottom-back': [0, -1, -1], 'bottom-left': [-1, -1, 0], 'bottom-right': [1, -1, 0],
  'bottom-front-left': [-1, -1, 1], 'bottom-front-right': [1, -1, 1],
};

function unitVector(anchor, rotation = {}) {
  const raw = ANCHOR_VECTORS[anchor] || ANCHOR_VECTORS.front;
  const length = Math.hypot(raw[0], raw[1], raw[2]) || 1;
  let x = raw[0] / length;
  let y = raw[1] / length;
  let z = raw[2] / length;
  const rx = Number(rotation.x || 0) * Math.PI / 180;
  const ry = Number(rotation.y || 0) * Math.PI / 180;
  const rz = Number(rotation.z || 0) * Math.PI / 180;
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  const rotatedLength = Math.hypot(x, y, z) || 1;
  return [x / rotatedLength, y / rotatedLength, z / rotatedLength];
}

function colorLuminance(color) {
  const hex = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? String(color) : '#ffffff';
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return clamp(r * 0.2126 + g * 0.7152 + b * 0.0722, 0, 1);
}

function attenuationRatio(light) {
  const value = Number(light?.attenuation);
  return clamp((Number.isFinite(value) ? value : 48) / 100, 0, 1);
}

function directionalFootprint(light, u, v) {
  const attenuation = clamp((Number.isFinite(Number(light?.attenuation)) ? Number(light.attenuation) : 22) / 100, 0, 1);
  if (attenuation <= 0.001) return 1;
  const vector = unitVector(light.anchor, light.rotation);
  const offset = light.offset || {};
  const centerX = 0.5 + Number(offset.x || 0) / 280;
  const centerY = 0.5 - Number(offset.y || 0) / 280;
  const axisX = vector[0];
  const axisY = -vector[1];
  const axisLength = Math.hypot(axisX, axisY);
  let lightSide = 0.5;
  if (axisLength > 0.025) {
    const signed = ((u - centerX) * axisX + (v - centerY) * axisY) / axisLength;
    lightSide = clamp(0.5 + signed / 0.72, 0, 1);
  } else {
    const distance = Math.hypot(u - centerX, v - centerY);
    lightSide = 1 - clamp(distance / 0.76, 0, 1);
  }
  const smoothLightSide = lightSide * lightSide * (3 - 2 * lightSide);
  const minimumReach = 1 - attenuation * 0.78;
  return clamp(minimumReach + (1 - minimumReach) * smoothLightSide, 0, 1);
}

function workerErrorMessage(error, fallback = 'MoGe-2 worker is unavailable') {
  const status = error?.response?.status;
  if (status) return `MoGe-2 worker health check failed with HTTP ${status}`;
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout|timed out/i.test(message)) {
    return 'MoGe-2 worker health check timed out';
  }
  if (code === 'ECONNREFUSED') return 'MoGe-2 worker port is not accepting connections';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'MoGe-2 worker host is unreachable';
  return message || fallback;
}

async function assertRemoteWorkerHealthy(serviceUrl, serviceToken, options = {}) {
  const cacheKey = `${serviceUrl}/health`;
  const now = Date.now();
  if (
    !options.bypassUnavailableCache
    && workerUnavailableCache.key === cacheKey
    && workerUnavailableCache.retryAtMs > now
    && workerUnavailableCache.reason
  ) {
    throw new Error(workerUnavailableCache.reason);
  }
  try {
    await axios.get(`${serviceUrl}/health`, {
      headers: {
        Authorization: `Bearer ${serviceToken}`,
      },
      timeout: Math.max(500, Number(options.healthTimeoutMs || DEFAULT_WORKER_HEALTH_TIMEOUT_MS)),
      validateStatus: (status) => status >= 200 && status < 300,
    });
    workerUnavailableCache = { key: cacheKey, retryAtMs: 0, reason: '' };
  } catch (error) {
    const reason = workerErrorMessage(error);
    workerUnavailableCache = {
      key: cacheKey,
      retryAtMs: now + WORKER_UNAVAILABLE_RETRY_MS,
      reason,
    };
    throw new Error(reason);
  }
}

function lightFootprint(light, u, v) {
  if (light.type === 'directional') return directionalFootprint(light, u, v);
  const vector = unitVector(light.anchor, light.rotation);
  const offset = light.offset || {};
  const centerX = clamp(0.5 + vector[0] * 0.18 + Number(offset.x || 0) / 250, 0, 1);
  const centerY = clamp(0.5 - vector[1] * 0.18 - Number(offset.y || 0) / 250, 0, 1);
  const dx = u - centerX;
  const dy = v - centerY;
  const attenuation = attenuationRatio(light);
  if (light.type === 'area') {
    const reachScale = 1.22 - attenuation * 0.64;
    const halfWidth = (0.12 + Number(light.width || 54) / 150) * reachScale;
    const halfHeight = (0.12 + Number(light.height || 54) / 150) * reachScale;
    const edge = Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
    const edgeLimit = 1.44 - attenuation * 0.58;
    const feather = Math.max(0.045, (0.15 + Number(light.softness || 0) / 125) * (1.12 - attenuation * 0.42));
    return clamp((edgeLimit - edge) / feather, 0, 1);
  }
  const distance = Math.hypot(dx, dy);
  if (light.type === 'spot') {
    const radius = (0.12 + Number(light.coneAngle || 42) / 150) * (1.22 - attenuation * 0.62);
    const feather = Math.max(0.025, (0.03 + Number(light.softness || 0) / 180) * (1.1 - attenuation * 0.35));
    return clamp((radius - distance) / feather, 0, 1);
  }
  const radius = 0.2 + (100 - Number(light.attenuation || 48)) / 120;
  return clamp(1 - distance / radius, 0, 1);
}

function lightContribution(light, nx, ny, nz, u, v) {
  if (!light?.enabled || Number(light.intensity || 0) <= 0) return 0;
  const vector = unitVector(light.anchor, light.rotation);
  const dot = Math.max(0, nx * vector[0] + ny * vector[1] + nz * vector[2]);
  const base = dot * (Number(light.intensity) / 100) * (0.55 + colorLuminance(light.color) * 0.45);
  return base * lightFootprint(light, u, v);
}

function maskStateSnapshot(state = {}) {
  return {
    main: state.main || {},
    fill: state.fill || {},
    ambient: state.ambient || {},
    rimLight: Boolean(state.rimLight),
  };
}

async function buildLightMaskAsset(normalBuffer, state = {}) {
  const { data: normal, info } = await sharp(normalBuffer, { failOn: 'none' })
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const output = Buffer.alloc(width * height);
  const ambient = state.ambient?.enabled
    ? (Number(state.ambient.intensity || 0) / 100) * (0.55 + colorLuminance(state.ambient.color) * 0.45)
    : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = (y * width + x) * channels;
      const nx = normal[sourceIndex] / 127.5 - 1;
      const ny = normal[sourceIndex + 1] / 127.5 - 1;
      const nz = normal[sourceIndex + 2] / 127.5 - 1;
      const u = x / Math.max(1, width - 1);
      const v = y / Math.max(1, height - 1);
      let value = ambient;
      value += lightContribution(state.main, nx, ny, nz, u, v);
      value += lightContribution(state.fill, nx, ny, nz, u, v);
      if (state.rimLight && (state.main?.enabled || state.fill?.enabled)) value += (1 - Math.abs(nz)) * 0.22;
      output[y * width + x] = Math.round(clamp(value, 0, 1) * 255);
    }
  }
  const buffer = await sharp(output, { raw: { width, height, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const normalHash = sha1(normalBuffer);
  const stateHash = sha1(Buffer.from(JSON.stringify(maskStateSnapshot(state))));
  return {
    key: 'mask',
    ext: 'png',
    mimeType: 'image/png',
    buffer,
    sha1: sha1(buffer),
    storedName: `light-stage-${normalHash.slice(0, 12)}-mask-v${LIGHT_MASK_ASSET_VERSION}-${stateHash.slice(0, 12)}.png`,
    width,
    height,
  };
}

function sobelNormal(depth, width, height) {
  const output = Buffer.alloc(width * height * 3);
  const at = (x, y) => depth[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
      ) / 1020;
      const dy = (
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
        - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
      ) / 1020;
      const nx = -dx * 1.75;
      const ny = -dy * 1.75;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz) || 1;
      const index = (y * width + x) * 3;
      output[index] = Math.round((nx / length * 0.5 + 0.5) * 255);
      output[index + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
      output[index + 2] = Math.round((nz / length * 0.5 + 0.5) * 255);
    }
  }
  return output;
}

function buildPseudoDepth(rgb, width, height) {
  const depth8 = Buffer.alloc(width * height);
  const depth16 = Buffer.alloc(width * height * 2);
  const mask = Buffer.alloc(width * height);
  const sampledPoints = [];
  const sampleStep = Math.max(8, Math.round(Math.max(width, height) / 80));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = (y * width + x) * 3;
      const luminance = rgb[sourceIndex] * 0.2126 + rgb[sourceIndex + 1] * 0.7152 + rgb[sourceIndex + 2] * 0.0722;
      const nx = (x / Math.max(1, width - 1)) * 2 - 1;
      const ny = (y / Math.max(1, height - 1)) * 2 - 1;
      const centerPrior = clamp(1 - Math.hypot(nx * 0.8, ny * 0.72), 0, 1);
      const value = clamp(Math.round(luminance * 0.38 + centerPrior * 157), 0, 255);
      const index = y * width + x;
      depth8[index] = value;
      depth16.writeUInt16LE(value * 257, index * 2);
      mask[index] = clamp(Math.round((centerPrior * 0.72 + luminance / 255 * 0.28) * 255), 0, 255);
      if (x % sampleStep === 0 && y % sampleStep === 0) {
        sampledPoints.push([
          Number(nx.toFixed(5)),
          Number((-ny).toFixed(5)),
          Number((value / 255).toFixed(5)),
        ]);
      }
    }
  }
  return { depth8, depth16, mask, sampledPoints };
}

async function buildLocalGeometryAssets(sourceBuffer, options = {}) {
  const sourceHash = sha1(sourceBuffer);
  const image = sharp(sourceBuffer, { failOn: 'none' }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Unable to read source image dimensions for Light Stage');

  const scale = Math.min(1, MAX_PREVIEW_SIDE / Math.max(metadata.width, metadata.height));
  const width = Math.max(2, Math.round(metadata.width * scale));
  const height = Math.max(2, Math.round(metadata.height * scale));
  const { data: rgb, info } = await image
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const actualWidth = info.width;
  const actualHeight = info.height;
  const { depth8, depth16, mask, sampledPoints } = buildPseudoDepth(rgb, actualWidth, actualHeight);
  const normal = sobelNormal(depth8, actualWidth, actualHeight);

  const diffuseBuffer = await sharp(rgb, { raw: { width: actualWidth, height: actualHeight, channels: 3 } })
    .modulate({ brightness: 1.04, saturation: 0.86 })
    .blur(0.55)
    .sharpen({ sigma: 0.55, m1: 0.7, m2: 0.3 })
    .png({ compressionLevel: 8 })
    .toBuffer();
  const normalBuffer = await sharp(normal, { raw: { width: actualWidth, height: actualHeight, channels: 3 } })
    .png({ compressionLevel: 8 })
    .toBuffer();
  const depthBuffer = await sharp(depth16, { raw: { width: actualWidth, height: actualHeight, channels: 1, depth: 'ushort' } })
    .png({ compressionLevel: 9, bitdepth: 16 })
    .toBuffer();
  const maskBuffer = await sharp(mask, { raw: { width: actualWidth, height: actualHeight, channels: 1 } })
    .blur(Math.max(1, Math.round(Math.max(actualWidth, actualHeight) / 180)))
    .png({ compressionLevel: 9 })
    .toBuffer();
  const previewBuffer = await sharp(sourceBuffer, { failOn: 'none' })
    .rotate()
    .resize({ width: actualWidth, height: actualHeight, fit: 'fill' })
    .webp({ quality: 88, effort: 4 })
    .toBuffer();

  const fov = 45;
  const focal = 0.5 * actualWidth / Math.tan((fov * Math.PI / 180) / 2);
  const intrinsics = [focal, 0, actualWidth / 2, 0, focal, actualHeight / 2, 0, 0, 1];
  const pointMapDocument = {
    version: 1,
    sourceHash,
    width: actualWidth,
    height: actualHeight,
    sampleStep: Math.max(8, Math.round(Math.max(actualWidth, actualHeight) / 80)),
    points: sampledPoints,
  };
  const pointMapBuffer = Buffer.from(JSON.stringify(pointMapDocument));

  const baseManifest = {
    version: GEOMETRY_ASSET_VERSION,
    geometryAssetVersion: GEOMETRY_ASSET_VERSION,
    normalConvention: NORMAL_CONVENTION,
    provider: options.provider || 'local-2.5d',
    modelId: options.provider === 'moge-2-vitb-normal' ? MODEL_ID : LOCAL_MODEL_ID,
    targetModelId: MODEL_ID,
    targetModelReference: 'Ruicheng/moge-2-vitb-normal/model.pt',
    sourceHash,
    sourceNodeId: options.sourceNodeId || null,
    width: actualWidth,
    height: actualHeight,
    fov,
    intrinsics,
    claims: {
      geometry: '2.5D visible-surface relief; not hidden-surface reconstruction',
      diffuse: 'bounded de-light approximation; not true albedo',
      mask: 'deterministic subject-biased lighting range; not semantic matting',
    },
    generatedAtMs: Date.now(),
  };

  const items = [
    { key: 'diffuse', ext: 'png', mimeType: 'image/png', buffer: diffuseBuffer },
    { key: 'normal', ext: 'png', mimeType: 'image/png', buffer: normalBuffer },
    { key: 'depth', ext: 'png', mimeType: 'image/png', buffer: depthBuffer },
    { key: 'mask', ext: 'png', mimeType: 'image/png', buffer: maskBuffer },
    { key: 'preview', ext: 'webp', mimeType: 'image/webp', buffer: previewBuffer },
    { key: 'pointMap', ext: 'json', mimeType: 'application/json', buffer: pointMapBuffer },
  ].map((item) => ({
    ...item,
    sha1: sha1(item.buffer),
    storedName: `light-stage-${sourceHash.slice(0, 16)}-v${GEOMETRY_ASSET_VERSION}-${item.key}.${item.ext}`,
  }));

  const manifest = {
    ...baseManifest,
    assets: Object.fromEntries(items.map((item) => [item.key, item.storedName])),
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
  items.push({
    key: 'manifest',
    ext: 'json',
    mimeType: 'application/json',
    buffer: manifestBuffer,
    sha1: sha1(manifestBuffer),
    storedName: `light-stage-${sourceHash.slice(0, 16)}-v${GEOMETRY_ASSET_VERSION}-manifest.json`,
  });

  return {
    provider: options.provider || 'local-2.5d',
    modelId: options.provider === 'moge-2-vitb-normal' ? MODEL_ID : LOCAL_MODEL_ID,
    status: options.provider === 'moge-2-vitb-normal' ? 'ready' : 'fallback',
    sourceHash,
    width: actualWidth,
    height: actualHeight,
    fov,
    intrinsics,
    assetVersion: GEOMETRY_ASSET_VERSION,
    normalConvention: NORMAL_CONVENTION,
    generatedAtMs: baseManifest.generatedAtMs,
    items,
  };
}

function remoteAssetExtension(key, mimeType) {
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/jpeg') return 'jpg';
  return 'png';
}

function decodeRemoteAsset(asset, key) {
  const encoded = String(asset?.data || '');
  if (!encoded) throw new Error(`MoGe-2 response is missing ${key} data`);
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length) throw new Error(`MoGe-2 response returned empty ${key} data`);
  return {
    key,
    mimeType: String(asset.mimeType || (key === 'pointMap' ? 'application/json' : 'image/png')),
    buffer,
  };
}

async function buildRemoteGeometryAssets(sourceBuffer, options = {}) {
  const serviceUrl = String(options.serviceUrl || '').trim().replace(/\/+$/, '');
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl || !serviceToken) throw new Error('MoGe-2 geometry service is not configured');
  await assertRemoteWorkerHealthy(serviceUrl, serviceToken, options);

  const form = new FormData();
  form.append('file', sourceBuffer, {
    filename: 'light-stage-source.png',
    contentType: 'image/png',
    knownLength: sourceBuffer.length,
  });
  const response = await axios.post(`${serviceUrl}/v1/geometry`, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${serviceToken}`,
    },
    timeout: Math.max(30_000, Number(options.timeoutMs || 180_000)),
    maxBodyLength: 64 * 1024 * 1024,
    maxContentLength: 64 * 1024 * 1024,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const payload = response.data || {};
  if (payload.modelId !== MODEL_ID) {
    throw new Error(`Unexpected geometry model: ${payload.modelId || 'unknown'}`);
  }
  const width = Number(payload.width);
  const height = Number(payload.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
    throw new Error('MoGe-2 response has invalid geometry dimensions');
  }

  const sourceHash = sha1(sourceBuffer);
  const assetKeys = ['diffuse', 'normal', 'depth', 'mask', 'preview', 'pointMap'];
  const items = assetKeys.map((key) => {
    const item = decodeRemoteAsset(payload.assets?.[key], key);
    const ext = remoteAssetExtension(key, item.mimeType);
    return {
      ...item,
      ext,
      sha1: sha1(item.buffer),
      storedName: `light-stage-${sourceHash.slice(0, 16)}-v${GEOMETRY_ASSET_VERSION}-${key}.${ext}`,
    };
  });

  const intrinsics = Array.isArray(payload.intrinsics)
    ? payload.intrinsics.map(Number).filter(Number.isFinite).slice(0, 9)
    : [];
  const normalConvention = payload.normalConvention === NORMAL_CONVENTION
    ? NORMAL_CONVENTION
    : 'camera-space';
  if (normalConvention !== NORMAL_CONVENTION) {
    throw new Error(`Unsupported MoGe-2 normal convention: ${normalConvention}`);
  }
  const manifest = {
    version: GEOMETRY_ASSET_VERSION,
    geometryAssetVersion: GEOMETRY_ASSET_VERSION,
    normalConvention,
    provider: MODEL_ID,
    modelId: MODEL_ID,
    modelReference: 'Ruicheng/moge-2-vitb-normal/model.pt',
    sourceHash,
    sourceNodeId: options.sourceNodeId || null,
    sourceWidth: Number(payload.sourceWidth || width),
    sourceHeight: Number(payload.sourceHeight || height),
    width,
    height,
    fov: Number(payload.fov || 45),
    intrinsics,
    inferenceMs: Number(payload.inferenceMs || 0),
    workerGeneratedAtMs: Number(payload.generatedAtMs || Date.now()),
    generatedAtMs: Date.now(),
    claims: {
      geometry: 'MoGe-2 visible-surface monocular geometry; not hidden-surface reconstruction',
      diffuse: 'bounded de-light approximation; not true albedo',
      mask: 'MoGe-2 valid-pixel mask; not semantic matting',
    },
    assets: Object.fromEntries(items.map((item) => [item.key, item.storedName])),
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
  items.push({
    key: 'manifest',
    ext: 'json',
    mimeType: 'application/json',
    buffer: manifestBuffer,
    sha1: sha1(manifestBuffer),
    storedName: `light-stage-${sourceHash.slice(0, 16)}-v${GEOMETRY_ASSET_VERSION}-manifest.json`,
  });

  return {
    provider: MODEL_ID,
    modelId: MODEL_ID,
    status: 'ready',
    sourceHash,
    width,
    height,
    fov: manifest.fov,
    intrinsics,
    assetVersion: GEOMETRY_ASSET_VERSION,
    normalConvention,
    generatedAtMs: manifest.generatedAtMs,
    items,
  };
}

async function buildGeometryAssets(sourceBuffer, options = {}) {
  if (options.provider === MODEL_ID && options.serviceUrl) {
    try {
      return await buildRemoteGeometryAssets(sourceBuffer, options);
    } catch (error) {
      if (options.allowLocalFallback === false) throw error;
      const fallback = await buildLocalGeometryAssets(sourceBuffer, {
        ...options,
        provider: 'local-2.5d',
      });
      fallback.warning = `MoGe-2 unavailable; using local 2.5D fallback: ${workerErrorMessage(error)}`;
      return fallback;
    }
  }
  return buildLocalGeometryAssets(sourceBuffer, {
    ...options,
    provider: 'local-2.5d',
  });
}

module.exports = {
  MODEL_ID,
  LOCAL_MODEL_ID,
  GEOMETRY_ASSET_VERSION,
  NORMAL_CONVENTION,
  buildGeometryAssets,
  buildRemoteGeometryAssets,
  buildLightMaskAsset,
  assertRemoteWorkerHealthy,
};
