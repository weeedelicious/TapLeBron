'use strict';

const crypto = require('crypto');
const sharp = require('sharp');

const DEFAULT_HORIZONTAL_FOV_DEGREES = 80;
const DEFAULT_SEAM_THRESHOLD = 0.12;

function assertDimensions(width, height) {
  const normalizedWidth = Math.max(2, Math.round(Number(width || 0)));
  const normalizedHeight = Math.max(1, Math.round(Number(height || 0)));
  if (normalizedWidth !== normalizedHeight * 2) {
    const error = new Error(`ERP 模板尺寸必须为严格 2:1，收到 ${normalizedWidth}x${normalizedHeight}`);
    error.code = 'PANORAMA_TEMPLATE_DIMENSIONS_INVALID';
    throw error;
  }
  return { width: normalizedWidth, height: normalizedHeight };
}

function templateDimensionsForResolution(resolution = '2K', providerSize = '') {
  const match = String(providerSize || '').match(/^(\d+)x(\d+)$/i);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > 0 && height > 0 && Math.abs(width / height - 2) < 0.02) {
      const normalizedHeight = Math.max(1, Math.round(height));
      return { width: normalizedHeight * 2, height: normalizedHeight };
    }
  }
  const key = String(resolution || '2K').toUpperCase();
  if (key === '1K') return { width: 1024, height: 512 };
  if (key === '4K') return { width: 4096, height: 2048 };
  return { width: 2048, height: 1024 };
}

function bilinearSample(source, sourceWidth, sourceHeight, x, y, target, targetOffset) {
  const x0 = Math.max(0, Math.min(sourceWidth - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(sourceHeight - 1, Math.floor(y)));
  const x1 = Math.min(sourceWidth - 1, x0 + 1);
  const y1 = Math.min(sourceHeight - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const topLeft = (y0 * sourceWidth + x0) * 3;
  const topRight = (y0 * sourceWidth + x1) * 3;
  const bottomLeft = (y1 * sourceWidth + x0) * 3;
  const bottomRight = (y1 * sourceWidth + x1) * 3;
  for (let channel = 0; channel < 3; channel += 1) {
    const top = source[topLeft + channel] * (1 - tx) + source[topRight + channel] * tx;
    const bottom = source[bottomLeft + channel] * (1 - tx) + source[bottomRight + channel] * tx;
    target[targetOffset + channel] = Math.max(0, Math.min(255, Math.round(top * (1 - ty) + bottom * ty)));
  }
}

async function buildErpEditTemplate({
  sourcePath,
  width,
  height,
  horizontalFovDegrees = DEFAULT_HORIZONTAL_FOV_DEGREES,
} = {}) {
  if (!sourcePath) throw new Error('缺少 ERP 模板原图路径');
  const dimensions = assertDimensions(width, height);
  const hfovDegrees = Number(horizontalFovDegrees || DEFAULT_HORIZONTAL_FOV_DEGREES);
  if (!Number.isFinite(hfovDegrees) || hfovDegrees < 30 || hfovDegrees > 140) {
    throw new Error('ERP 模板水平视场角必须在 30° 到 140° 之间');
  }

  const decoded = await sharp(sourcePath)
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const source = decoded.data;
  const sourceWidth = decoded.info.width;
  const sourceHeight = decoded.info.height;
  if (!sourceWidth || !sourceHeight) throw new Error('无法读取 ERP 模板原图尺寸');

  const { width: outputWidth, height: outputHeight } = dimensions;
  const template = Buffer.alloc(outputWidth * outputHeight * 4);
  const mask = Buffer.alloc(outputWidth * outputHeight * 4);
  for (let pixel = 0; pixel < outputWidth * outputHeight; pixel += 1) {
    const offset = pixel * 4;
    template[offset] = 127;
    template[offset + 1] = 127;
    template[offset + 2] = 127;
    template[offset + 3] = 0;
    mask[offset] = 255;
    mask[offset + 1] = 255;
    mask[offset + 2] = 255;
    mask[offset + 3] = 0;
  }

  const sourceAspect = sourceWidth / sourceHeight;
  const hfov = (hfovDegrees * Math.PI) / 180;
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) / sourceAspect);
  const tanHalfH = Math.tan(hfov / 2);
  const tanHalfV = Math.tan(vfov / 2);
  const xMargin = Math.max(2, Math.ceil((outputWidth * hfovDegrees) / 720));
  const yMargin = Math.max(2, Math.ceil((outputHeight * (vfov * 180 / Math.PI)) / 360));
  const centerX = Math.floor(outputWidth / 2);
  const centerY = Math.floor(outputHeight / 2);
  const minX = Math.max(0, centerX - xMargin);
  const maxX = Math.min(outputWidth - 1, centerX + xMargin);
  const minY = Math.max(0, centerY - yMargin);
  const maxY = Math.min(outputHeight - 1, centerY + yMargin);
  let knownPixels = 0;

  for (let y = minY; y <= maxY; y += 1) {
    const latitude = (0.5 - (y + 0.5) / outputHeight) * Math.PI;
    const cosLatitude = Math.cos(latitude);
    const directionY = Math.sin(latitude);
    for (let x = minX; x <= maxX; x += 1) {
      const longitude = ((x + 0.5) / outputWidth - 0.5) * Math.PI * 2;
      const directionX = cosLatitude * Math.sin(longitude);
      const directionZ = cosLatitude * Math.cos(longitude);
      if (directionZ <= 0) continue;
      const normalizedX = directionX / (directionZ * tanHalfH);
      const normalizedY = directionY / (directionZ * tanHalfV);
      if (Math.abs(normalizedX) > 1 || Math.abs(normalizedY) > 1) continue;

      const sourceX = (normalizedX + 1) * 0.5 * (sourceWidth - 1);
      const sourceY = (1 - normalizedY) * 0.5 * (sourceHeight - 1);
      const targetOffset = (y * outputWidth + x) * 4;
      bilinearSample(source, sourceWidth, sourceHeight, sourceX, sourceY, template, targetOffset);
      template[targetOffset + 3] = 255;
      mask[targetOffset + 3] = 255;
      knownPixels += 1;
    }
  }

  const templateBuffer = await sharp(template, {
    raw: { width: outputWidth, height: outputHeight, channels: 4 },
  }).png().toBuffer();
  const maskBuffer = await sharp(mask, {
    raw: { width: outputWidth, height: outputHeight, channels: 4 },
  }).png().toBuffer();
  const sourceSha1 = crypto.createHash('sha1').update(source).digest('hex');

  return {
    templateBuffer,
    maskBuffer,
    metadata: {
      contract: 'erp-perspective-template-v1',
      width: outputWidth,
      height: outputHeight,
      projection: 'equirectangular',
      horizontalFovDegrees: hfovDegrees,
      verticalFovDegrees: Number((vfov * 180 / Math.PI).toFixed(4)),
      sourceWidth,
      sourceHeight,
      sourceSha1,
      knownPixels,
      knownFraction: Number((knownPixels / (outputWidth * outputHeight)).toFixed(6)),
      missingFraction: Number((1 - knownPixels / (outputWidth * outputHeight)).toFixed(6)),
      maskSemantics: 'opaque-protected-transparent-generate',
    },
  };
}

async function restoreProtectedPixels({ generatedPath, templateBuffer, maskBuffer } = {}) {
  if (!generatedPath || !templateBuffer || !maskBuffer) throw new Error('缺少 ERP 保护合成输入');
  const templateDecoded = await sharp(templateBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = templateDecoded.info.width;
  const height = templateDecoded.info.height;
  const maskDecoded = await sharp(maskBuffer)
    .resize(width, height, { fit: 'fill', kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const generatedMetadata = await sharp(generatedPath).metadata();
  const generatedWidth = Number(generatedMetadata.width || 0);
  const generatedHeight = Number(generatedMetadata.height || 0);
  if (!generatedWidth || !generatedHeight) throw new Error('无法读取 ERP 生成结果尺寸');
  const targetAspect = width / height;
  const generatedAspect = generatedWidth / generatedHeight;
  const cropToTarget = generatedAspect > targetAspect
    ? { width: Math.max(1, Math.round(generatedHeight * targetAspect)), height: generatedHeight }
    : { width: generatedWidth, height: Math.max(1, Math.round(generatedWidth / targetAspect)) };
  const generatedPipeline = sharp(generatedPath).rotate();
  if (cropToTarget.width !== generatedWidth || cropToTarget.height !== generatedHeight) {
    generatedPipeline.extract({
      left: Math.max(0, Math.floor((generatedWidth - cropToTarget.width) / 2)),
      top: Math.max(0, Math.floor((generatedHeight - cropToTarget.height) / 2)),
      width: cropToTarget.width,
      height: cropToTarget.height,
    });
  }
  const generatedDecoded = await generatedPipeline
    .resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.from(generatedDecoded.data);
  let restoredPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    if (maskDecoded.data[offset + 3] < 128) continue;
    output[offset] = templateDecoded.data[offset];
    output[offset + 1] = templateDecoded.data[offset + 1];
    output[offset + 2] = templateDecoded.data[offset + 2];
    output[offset + 3] = 255;
    restoredPixels += 1;
  }
  return {
    buffer: await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    width,
    height,
    restoredPixels,
    restoredFraction: Number((restoredPixels / (width * height)).toFixed(6)),
  };
}

async function inspectErpSeam(input, threshold = DEFAULT_SEAM_THRESHOLD) {
  const decoded = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = decoded.info;
  const stripWidth = Math.max(2, Math.min(Math.floor(width / 8), Math.round(width * 0.015)));
  let difference = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < stripWidth; x += 1) {
      const leftOffset = (y * width + x) * 3;
      const rightOffset = (y * width + (width - stripWidth + x)) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        difference += Math.abs(decoded.data[leftOffset + channel] - decoded.data[rightOffset + channel]);
        samples += 1;
      }
    }
  }
  const score = samples ? difference / (samples * 255) : 1;
  return {
    score: Number(score.toFixed(6)),
    threshold,
    needsRepair: score > threshold,
    stripWidth,
  };
}

module.exports = {
  DEFAULT_HORIZONTAL_FOV_DEGREES,
  DEFAULT_SEAM_THRESHOLD,
  templateDimensionsForResolution,
  buildErpEditTemplate,
  restoreProtectedPixels,
  inspectErpSeam,
};
