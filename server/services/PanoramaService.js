'use strict';

// Pure/testable helpers for the /toolbox/panorama pipeline: request validation,
// equirectangular (~2:1) aspect-ratio checking on the decoded output image, and
// building the Mivo submission payload + generation_task_outputs metadata.
// Kept dependency-free (no DB/network/fs/config access) so it can be unit
// tested in isolation, mirroring the style of ImageUpscaleService.js.
//
// Errors mirror the shape produced by services/generationErrors.js
// (`.message` / `.code` / `.statusCode` / `.details`) so the route can surface
// them the same way, but are constructed locally rather than importing that
// module: generationErrors.js pulls in ../config, which requires DB/session
// env vars at require time and would make this otherwise-pure module fail to
// even load in environments/tests that don't set them up.

// Local subset of the shared GENERATION_ERROR_CODES map (server/services/generationErrors.js)
// relevant to panorama validation/persistence failures. Kept as plain string
// literals (not re-exported from generationErrors.js) precisely so this file
// stays free of the config.js require chain described above.
const PANORAMA_ERROR_CODES = Object.freeze({
  REFERENCE_MISSING: 'REFERENCE_MISSING',
  OUTPUT_PERSIST_FAILED: 'OUTPUT_PERSIST_FAILED',
});

function panoramaError(message, code, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

// Equirectangular panoramas are conventionally 2:1 (width:height). Real
// provider output rarely lands on an exact ratio because of encoder rounding,
// so we allow a tolerance band around the target before treating the result
// as a malformed/non-panoramic image.
const DEFAULT_TARGET_ASPECT_RATIO = 2;
const DEFAULT_ASPECT_RATIO_TOLERANCE = 0.015;

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

// Validate the three required inputs for the panorama toolbox request. Throws
// a structured error (400) naming the first missing field; returns the
// trimmed { projectUuid, nodeKey, imageUrl } on success.
function validatePanoramaRequest({ projectUuid, nodeKey, imageUrl } = {}) {
  const normalizedProjectUuid = trimmedString(projectUuid);
  if (!normalizedProjectUuid) {
    throw panoramaError(
      '缺少画布 projectUuid，无法创建全景图任务',
      PANORAMA_ERROR_CODES.REFERENCE_MISSING,
      400,
      { field: 'projectUuid' },
    );
  }

  const normalizedNodeKey = trimmedString(nodeKey);
  if (!normalizedNodeKey) {
    throw panoramaError(
      '缺少节点 nodeKey，无法创建全景图任务',
      PANORAMA_ERROR_CODES.REFERENCE_MISSING,
      400,
      { field: 'nodeKey' },
    );
  }

  const normalizedImageUrl = trimmedString(imageUrl);
  if (!normalizedImageUrl) {
    throw panoramaError(
      '缺少源图 imageUrl，无法生成全景图',
      PANORAMA_ERROR_CODES.REFERENCE_MISSING,
      400,
      { field: 'imageUrl' },
    );
  }

  return {
    projectUuid: normalizedProjectUuid,
    nodeKey: normalizedNodeKey,
    imageUrl: normalizedImageUrl,
  };
}

// width/height -> ratio, or null when dimensions are unreadable/non-positive.
function panoramaAspectRatio(dimensions) {
  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

function isNearEquirectangular(dimensions, tolerance = DEFAULT_ASPECT_RATIO_TOLERANCE, targetRatio = DEFAULT_TARGET_ASPECT_RATIO) {
  const ratio = panoramaAspectRatio(dimensions);
  if (ratio === null) return false;
  return Math.abs(ratio - targetRatio) <= targetRatio * tolerance;
}

// Assert the decoded output image is close enough to the 2:1 equirectangular
// aspect ratio to be treated as a valid panorama. Throws a structured 502
// error (provider returned something unusable) rather than silently
// persisting a malformed result. Returns { width, height, ratio, targetRatio,
// tolerance } on success for callers that want to record the measurement.
function assertEquirectangularDimensions(dimensions, options = {}) {
  const targetRatio = Number(options.targetRatio) > 0 ? Number(options.targetRatio) : DEFAULT_TARGET_ASPECT_RATIO;
  const tolerance = Number.isFinite(Number(options.tolerance)) && Number(options.tolerance) >= 0
    ? Number(options.tolerance)
    : DEFAULT_ASPECT_RATIO_TOLERANCE;

  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw panoramaError(
      '无法读取全景图输出的图像尺寸，生成结果可能已损坏',
      PANORAMA_ERROR_CODES.OUTPUT_PERSIST_FAILED,
      502,
      { width: dimensions?.width ?? null, height: dimensions?.height ?? null },
    );
  }

  const ratio = width / height;
  if (Math.abs(ratio - targetRatio) > targetRatio * tolerance) {
    throw panoramaError(
      `全景图输出的宽高比 ${ratio.toFixed(3)} 偏离等距柱状投影所需的 ${targetRatio}:1，生成结果无效`,
      PANORAMA_ERROR_CODES.OUTPUT_PERSIST_FAILED,
      502,
      { width, height, ratio, targetRatio, tolerance },
    );
  }

  return { width, height, ratio, targetRatio, tolerance };
}

// Build the Mivo /api/v1/panorama request body from a resolved image
// reference (Mivo object id or absolute URL). Throws if the reference is
// missing so callers cannot silently submit an empty job.
function buildPanoramaSubmission({ image } = {}) {
  const normalizedImage = trimmedString(image);
  if (!normalizedImage) {
    throw panoramaError(
      '源图未能解析为可提交的引用，无法调用全景图生成接口',
      PANORAMA_ERROR_CODES.REFERENCE_MISSING,
      400,
      { field: 'image' },
    );
  }
  return { image: normalizedImage };
}

// Build a generation_task_outputs-shaped entry (see JobService.normalizeOutput)
// for a single panorama result, carrying the measured aspect ratio so it is
// queryable/inspectable later without re-decoding the asset.
function buildPanoramaOutputMetadata({
  url,
  assetId = null,
  mimeType = null,
  width,
  height,
  model = null,
  isPrimary = true,
  extra = {},
} = {}) {
  const normalizedUrl = trimmedString(url);
  if (!normalizedUrl) {
    throw panoramaError(
      '缺少全景图输出地址，无法记录生成结果',
      PANORAMA_ERROR_CODES.OUTPUT_PERSIST_FAILED,
      502,
      { field: 'url' },
    );
  }
  const ratio = panoramaAspectRatio({ width, height });
  return {
    url: normalizedUrl,
    assetId,
    mimeType,
    width: Number.isFinite(Number(width)) ? Number(width) : null,
    height: Number.isFinite(Number(height)) ? Number(height) : null,
    model,
    isPrimary,
    metadata: {
      kind: 'panorama',
      projection: 'equirectangular',
      aspectRatio: ratio,
      ...extra,
    },
  };
}

module.exports = {
  DEFAULT_TARGET_ASPECT_RATIO,
  DEFAULT_ASPECT_RATIO_TOLERANCE,
  validatePanoramaRequest,
  panoramaAspectRatio,
  isNearEquirectangular,
  assertEquirectangularDimensions,
  buildPanoramaSubmission,
  buildPanoramaOutputMetadata,
};
