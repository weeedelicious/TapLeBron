const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const RESOLUTION_RANK = {
  '1K': 1,
  '2K': 2,
  '4K': 4,
};

function normalizeResolution(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return RESOLUTION_RANK[normalized] ? normalized : '1K';
}

function resolutionRankFromDimensions(dimensions) {
  const longEdge = Math.max(Number(dimensions?.width || 0), Number(dimensions?.height || 0));
  if (longEdge >= 3000) return 4;
  if (longEdge >= 1800) return 2;
  return 1;
}

function upscaleFactorForDimensions(dimensions, requestedResolution, fallbackConfig = {}) {
  const normalizedResolution = normalizeResolution(requestedResolution);
  const configuredRank = Number(fallbackConfig?.scaleFactors?.[normalizedResolution]);
  const requestedRank = configuredRank > 0 ? configuredRank : RESOLUTION_RANK[normalizedResolution];
  const currentRank = resolutionRankFromDimensions(dimensions);
  if (requestedRank <= currentRank) return 1;
  return requestedRank / currentRank;
}

function outputExtension(outputFormat) {
  const value = String(outputFormat || '').trim().toLowerCase();
  if (value === 'jpg' || value === 'jpeg') return 'jpg';
  if (value === 'webp') return 'webp';
  return 'png';
}

function ffmpegOutputArgs(outputPath, extension) {
  if (extension === 'jpg') return ['-q:v', '2', '-pix_fmt', 'yuvj444p', outputPath];
  if (extension === 'webp') return ['-quality', '95', outputPath];
  return ['-compression_level', '3', outputPath];
}

async function upscaleWithFfmpeg({ inputPath, outputPath, scaleFactor, timeoutMs }) {
  const extension = path.extname(outputPath).slice(1).toLowerCase();
  await execFileAsync(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-y',
    '-loglevel', 'error',
    '-i', inputPath,
    '-vf', `scale=iw*${scaleFactor}:ih*${scaleFactor}:flags=lanczos,setsar=1`,
    '-frames:v', '1',
    ...ffmpegOutputArgs(outputPath, extension),
  ], { timeout: timeoutMs });
  return 'ffmpeg-lanczos';
}

async function upscaleWithRealEsrgan({ inputPath, outputPath, scaleFactor, timeoutMs }) {
  const binary = String(process.env.REALESRGAN_BIN || '').trim();
  if (!binary) throw new Error('REALESRGAN_BIN is not configured');
  const model = scaleFactor === 2
    ? String(process.env.REALESRGAN_X2_MODEL || 'RealESRGAN_x2plus')
    : String(process.env.REALESRGAN_X4_MODEL || 'RealESRGAN_x4plus');
  await execFileAsync(binary, [
    '-i', inputPath,
    '-o', outputPath,
    '-n', model,
    '-s', String(scaleFactor),
  ], { timeout: timeoutMs });
  return `real-esrgan-${scaleFactor}x`;
}

async function upscaleOneBuffer({
  buffer,
  dimensions,
  requestedResolution,
  outputFormat,
  temporaryDirectory,
  id,
  fallbackConfig,
}) {
  const scaleFactor = upscaleFactorForDimensions(dimensions, requestedResolution, fallbackConfig);
  if (scaleFactor <= 1) {
    return {
      buffer,
      method: 'provider-native',
      scaleFactor: 1,
      sourceDimensions: dimensions,
      outputDimensions: dimensions,
    };
  }

  if (scaleFactor !== 2 && scaleFactor !== 4) {
    throw new Error(`Unsupported image upscale factor: ${scaleFactor}`);
  }

  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const extension = outputExtension(outputFormat);
  const inputPath = path.join(temporaryDirectory, `${id}-source.${extension}`);
  const outputPath = path.join(temporaryDirectory, `${id}-upscaled.${extension}`);
  const timeoutMs = Math.max(120_000, Number(process.env.IMAGE_UPSCALE_TIMEOUT_MS || 600_000));
  fs.writeFileSync(inputPath, buffer);

  let method;
  try {
    if (String(process.env.IMAGE_UPSCALER || '').trim().toLowerCase() === 'real-esrgan') {
      try {
        method = await upscaleWithRealEsrgan({ inputPath, outputPath, scaleFactor, timeoutMs });
      } catch (error) {
        console.warn(`Real-ESRGAN upscale failed; falling back to FFmpeg Lanczos: ${error.message}`);
        method = await upscaleWithFfmpeg({ inputPath, outputPath, scaleFactor, timeoutMs });
      }
    } else {
      method = await upscaleWithFfmpeg({ inputPath, outputPath, scaleFactor, timeoutMs });
    }

    const upscaledBuffer = fs.readFileSync(outputPath);
    return {
      buffer: upscaledBuffer,
      method,
      scaleFactor,
      sourceDimensions: dimensions,
      outputDimensions: {
        width: dimensions.width * scaleFactor,
        height: dimensions.height * scaleFactor,
      },
    };
  } finally {
    fs.rmSync(inputPath, { force: true });
    fs.rmSync(outputPath, { force: true });
  }
}

async function ensureRequestedResolution({
  buffers,
  requestedResolution,
  outputFormat,
  temporaryDirectory,
  getDimensions,
  createId,
  fallbackConfig = {},
}) {
  const normalizedResolution = normalizeResolution(requestedResolution);
  if (normalizedResolution === '1K') {
    return {
      buffers,
      details: (buffers || []).map(() => ({ method: 'provider-native', scaleFactor: 1 })),
    };
  }

  const results = [];
  for (const buffer of buffers || []) {
    const dimensions = await getDimensions(buffer);
    if (!dimensions?.width || !dimensions?.height) {
      throw new Error('Unable to read generated image dimensions before upscaling');
    }
    results.push(await upscaleOneBuffer({
      buffer,
      dimensions,
      requestedResolution: normalizedResolution,
      outputFormat,
      temporaryDirectory,
      id: createId(),
      fallbackConfig,
    }));
  }

  return {
    buffers: results.map((result) => result.buffer),
    details: results.map(({ buffer, ...detail }) => detail),
  };
}

module.exports = {
  ensureRequestedResolution,
  normalizeResolution,
  resolutionRankFromDimensions,
  upscaleFactorForDimensions,
};
