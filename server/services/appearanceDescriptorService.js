'use strict';

// Appearance-transfer lighting-descriptor service (pure logic).
//
// Faithful Node port of the Dexis frozen `descriptor.py` / `descriptor_service.py`:
// the vision model receives a reference image + a strict-JSON instruction and
// must return exactly one LightingDescriptorV1 object (camelCase). This module
// owns the parts that have NO host I/O so they can be unit-tested in isolation:
//   - the JSON schema advertised to the model,
//   - the exact instruction prompt (English, ported verbatim in spirit),
//   - strict parse + schema validation (reject fences / non-JSON / out-of-range),
//   - the canonical descriptor hash,
//   - the idempotent job signature,
//   - an in-memory, TTL-evicted job store satisfying the poll contract.
//
// The actual vision call + asset localization live inline in canvasRoutes.js,
// which owns the (module-private) LLM helpers `resolveVisionInputForLLM`,
// `postLlmChatCompletions`, `extractChatText`, `requireLlmKey`.

const crypto = require('crypto');

const DESCRIPTOR_SCHEMA_VERSION = 1;
const DESCRIPTOR_PROMPT_VERSION = 1;
const DESCRIPTOR_CAPABILITY_ID = 'lighting.reference-descriptor';

// Load-bearing enums (mirror descriptor.py Literal[...] unions verbatim).
const DIRECTION_CLASSES = [
  'front',
  'front-left',
  'front-right',
  'front-left-high',
  'front-right-high',
  'left',
  'right',
  'rear',
  'rear-left',
  'rear-right',
  'rear-left-high',
  'rear-right-high',
  'top',
  'overhead',
  'bottom',
  'diffuse',
  'unknown',
];
const SOURCE_TYPES = [
  'point',
  'small-area',
  'large-area',
  'window',
  'sky',
  'practical',
  'mixed',
  'unknown',
];
const EXPOSURE_STYLES = ['low-key', 'balanced', 'high-key'];
const HIGHLIGHT_ROLL_OFFS = ['soft', 'medium', 'hard', 'clipped'];
const TINT_CLASSES = [
  'neutral',
  'warm',
  'cool',
  'cyan',
  'magenta',
  'green',
  'amber',
  'mixed',
  'unknown',
];

const HEX_COLOR_PATTERN = '^#[0-9A-Fa-f]{6}$';
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

// JSON Schema advertised inside the prompt. Not required to byte-match pydantic's
// `model_json_schema(by_alias=True)`; it exists to communicate the exact contract
// (enums / ranges / hex / required) to the vision model.
const LIGHTING_DESCRIPTOR_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'confidence',
    'keyLight',
    'fillLight',
    'rimLight',
    'exposure',
    'color',
    'atmosphere',
    'globalMood',
  ],
  properties: {
    schemaVersion: { const: 1 },
    coordinateSystem: { const: 'camera' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    keyLight: {
      type: 'object',
      additionalProperties: false,
      required: ['directionClass', 'directionConfidence', 'sourceType', 'size', 'softness', 'intensity'],
      properties: {
        directionClass: { enum: DIRECTION_CLASSES },
        azimuthDeg: { type: ['number', 'null'], minimum: -180, maximum: 180 },
        elevationDeg: { type: ['number', 'null'], minimum: -90, maximum: 90 },
        directionConfidence: { type: 'number', minimum: 0, maximum: 1 },
        sourceType: { enum: SOURCE_TYPES },
        size: { type: 'number', minimum: 0, maximum: 1 },
        softness: { type: 'number', minimum: 0, maximum: 1 },
        intensity: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    fillLight: {
      type: 'object',
      additionalProperties: false,
      required: ['present', 'relativeIntensity', 'colorHex'],
      properties: {
        present: { type: 'boolean' },
        relativeIntensity: { type: 'number', minimum: 0, maximum: 1 },
        colorHex: { type: 'string', pattern: HEX_COLOR_PATTERN },
      },
    },
    rimLight: {
      type: 'object',
      additionalProperties: false,
      required: ['present', 'directionClass', 'intensity', 'colorHex'],
      properties: {
        present: { type: 'boolean' },
        directionClass: { enum: DIRECTION_CLASSES },
        intensity: { type: 'number', minimum: 0, maximum: 1 },
        colorHex: { type: 'string', pattern: HEX_COLOR_PATTERN },
      },
    },
    exposure: {
      type: 'object',
      additionalProperties: false,
      required: ['style', 'shadowAreaRatio', 'contrast', 'highlightRollOff', 'blackPoint', 'whitePoint'],
      properties: {
        style: { enum: EXPOSURE_STYLES },
        shadowAreaRatio: { type: 'number', minimum: 0, maximum: 1 },
        contrast: { type: 'number', minimum: 0, maximum: 1 },
        highlightRollOff: { enum: HIGHLIGHT_ROLL_OFFS },
        blackPoint: { type: 'number', minimum: 0, maximum: 1 },
        whitePoint: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    color: {
      type: 'object',
      additionalProperties: false,
      required: ['estimatedCctK', 'cctConfidence', 'tint', 'ambientColorHex', 'highlightColorHex'],
      properties: {
        estimatedCctK: { type: 'integer', minimum: 1000, maximum: 40000 },
        cctConfidence: { type: 'number', minimum: 0, maximum: 1 },
        tint: { enum: TINT_CLASSES },
        ambientColorHex: { type: 'string', pattern: HEX_COLOR_PATTERN },
        highlightColorHex: { type: 'string', pattern: HEX_COLOR_PATTERN },
      },
    },
    atmosphere: {
      type: 'object',
      additionalProperties: false,
      required: ['haze', 'aerialPerspective', 'bloom'],
      properties: {
        haze: { type: 'number', minimum: 0, maximum: 1 },
        aerialPerspective: { type: 'number', minimum: 0, maximum: 1 },
        bloom: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    globalMood: {
      type: 'object',
      additionalProperties: false,
      required: ['keywords', 'summary'],
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
        summary: { type: 'string', minLength: 1, maxLength: 320 },
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' }, maxItems: 12 },
  },
});

class DescriptorSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DescriptorSchemaError';
    this.code = 'descriptor_schema_invalid';
  }
}

// The strict instruction sent alongside the reference image. Ported from the
// frozen `_descriptor_prompt`: analyze only illumination, never describe scene
// content, return one raw JSON object (no markdown fences), schema appended.
function buildDescriptorInstruction(options = {}) {
  const retry = Boolean(options.retry);
  const schema = JSON.stringify(LIGHTING_DESCRIPTOR_JSON_SCHEMA);
  const parts = [
    'Analyze only the illumination visible in the single attached reference image.',
    retry ? 'The previous response was invalid. Return a corrected object.' : '',
    'Return exactly one raw JSON object. Do not use Markdown or code fences.',
    'Use camera coordinates. If a direction is uncertain, use the unknown enum or null angle and lower confidence.',
    'Do not describe or identify people, faces, clothing, buildings, signs, text, objects, scene layout, camera composition, or any content that could be copied into another image.',
    'The free-form globalMood fields may summarize light mood only; they must not contain reference-scene content.',
    `JSON Schema: ${schema}`,
  ];
  return parts.filter(Boolean).join('\n');
}

const DESCRIPTOR_SYSTEM_PROMPT =
  'You are a lighting-analysis engine. You receive one reference image and return exactly one raw JSON LightingDescriptorV1 object describing only its illumination. Never describe scene content. Never wrap the JSON in Markdown fences.';

// ---- strict validation helpers -------------------------------------------

function fail(message) {
  throw new DescriptorSchemaError(message);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function unitNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`);
  if (value < 0 || value > 1) fail(`${label} must be within [0, 1]`);
  return value;
}

function rangedNumber(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`);
  if (value < min || value > max) fail(`${label} must be within [${min}, ${max}]`);
  return value;
}

function optionalAngle(value, label, min, max) {
  if (value === null || value === undefined) return null;
  return rangedNumber(value, label, min, max);
}

function enumValue(value, label, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function hexColor(value, label) {
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) fail(`${label} must match ${HEX_COLOR_PATTERN}`);
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function stringList(value, label, minItems, maxItems) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length < minItems) fail(`${label} must have at least ${minItems} item(s)`);
  if (value.length > maxItems) fail(`${label} must have at most ${maxItems} item(s)`);
  return value.map((item, index) => {
    if (typeof item !== 'string') fail(`${label}[${index}] must be a string`);
    return item;
  });
}

// Validate + normalize into a clean camelCase LightingDescriptorV1. Unknown keys
// are dropped (not rejected) so a slightly chatty model still succeeds; every
// known field is strictly range/enum/pattern checked.
function validateDescriptor(payload) {
  const root = requireObject(payload, 'descriptor');

  const key = requireObject(root.keyLight, 'keyLight');
  const fill = requireObject(root.fillLight, 'fillLight');
  const rim = requireObject(root.rimLight, 'rimLight');
  const exposure = requireObject(root.exposure, 'exposure');
  const color = requireObject(root.color, 'color');
  const atmosphere = requireObject(root.atmosphere, 'atmosphere');
  const mood = requireObject(root.globalMood, 'globalMood');

  const estimatedCctKRaw = color.estimatedCctK;
  if (typeof estimatedCctKRaw !== 'number' || !Number.isFinite(estimatedCctKRaw)) {
    fail('color.estimatedCctK must be a number');
  }
  const estimatedCctK = Math.round(estimatedCctKRaw);
  if (estimatedCctK < 1000 || estimatedCctK > 40000) fail('color.estimatedCctK must be within [1000, 40000]');

  const uncertainties = root.uncertainties === undefined || root.uncertainties === null
    ? []
    : stringList(root.uncertainties, 'uncertainties', 0, 12);

  return {
    schemaVersion: 1,
    coordinateSystem: 'camera',
    confidence: unitNumber(root.confidence, 'confidence'),
    keyLight: {
      directionClass: enumValue(key.directionClass, 'keyLight.directionClass', DIRECTION_CLASSES),
      azimuthDeg: optionalAngle(key.azimuthDeg, 'keyLight.azimuthDeg', -180, 180),
      elevationDeg: optionalAngle(key.elevationDeg, 'keyLight.elevationDeg', -90, 90),
      directionConfidence: unitNumber(key.directionConfidence, 'keyLight.directionConfidence'),
      sourceType: enumValue(key.sourceType, 'keyLight.sourceType', SOURCE_TYPES),
      size: unitNumber(key.size, 'keyLight.size'),
      softness: unitNumber(key.softness, 'keyLight.softness'),
      intensity: unitNumber(key.intensity, 'keyLight.intensity'),
    },
    fillLight: {
      present: boolean(fill.present, 'fillLight.present'),
      relativeIntensity: unitNumber(fill.relativeIntensity, 'fillLight.relativeIntensity'),
      colorHex: hexColor(fill.colorHex, 'fillLight.colorHex'),
    },
    rimLight: {
      present: boolean(rim.present, 'rimLight.present'),
      directionClass: enumValue(rim.directionClass, 'rimLight.directionClass', DIRECTION_CLASSES),
      intensity: unitNumber(rim.intensity, 'rimLight.intensity'),
      colorHex: hexColor(rim.colorHex, 'rimLight.colorHex'),
    },
    exposure: {
      style: enumValue(exposure.style, 'exposure.style', EXPOSURE_STYLES),
      shadowAreaRatio: unitNumber(exposure.shadowAreaRatio, 'exposure.shadowAreaRatio'),
      contrast: unitNumber(exposure.contrast, 'exposure.contrast'),
      highlightRollOff: enumValue(exposure.highlightRollOff, 'exposure.highlightRollOff', HIGHLIGHT_ROLL_OFFS),
      blackPoint: unitNumber(exposure.blackPoint, 'exposure.blackPoint'),
      whitePoint: unitNumber(exposure.whitePoint, 'exposure.whitePoint'),
    },
    color: {
      estimatedCctK,
      cctConfidence: unitNumber(color.cctConfidence, 'color.cctConfidence'),
      tint: enumValue(color.tint, 'color.tint', TINT_CLASSES),
      ambientColorHex: hexColor(color.ambientColorHex, 'color.ambientColorHex'),
      highlightColorHex: hexColor(color.highlightColorHex, 'color.highlightColorHex'),
    },
    atmosphere: {
      haze: unitNumber(atmosphere.haze, 'atmosphere.haze'),
      aerialPerspective: unitNumber(atmosphere.aerialPerspective, 'atmosphere.aerialPerspective'),
      bloom: unitNumber(atmosphere.bloom, 'atmosphere.bloom'),
    },
    globalMood: {
      keywords: stringList(mood.keywords, 'globalMood.keywords', 1, 8),
      summary: (() => {
        if (typeof mood.summary !== 'string') fail('globalMood.summary must be a string');
        const trimmed = mood.summary.trim();
        if (trimmed.length < 1 || trimmed.length > 320) fail('globalMood.summary must be 1-320 chars');
        return trimmed;
      })(),
    },
    uncertainties,
  };
}

// Strict parse: reject fenced / non-JSON output outright (matches the frozen
// `parse_descriptor_response`), then schema-validate.
function parseDescriptorResponse(raw) {
  const stripped = typeof raw === 'string' ? raw.trim() : '';
  if (!stripped || stripped.startsWith('```') || stripped.endsWith('```')) {
    fail('descriptor response is not raw JSON');
  }
  let payload;
  try {
    payload = JSON.parse(stripped);
  } catch (error) {
    fail('descriptor response is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('descriptor response must be a JSON object');
  }
  return validateDescriptor(payload);
}

// ---- hashing / signature ---------------------------------------------------

// Stable JSON with recursively sorted keys + compact separators, mirroring the
// frozen `sort_keys=True, separators=(",", ":")` canonicalization.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function computeDescriptorHash(descriptor) {
  return crypto.createHash('sha256').update(canonicalJson(descriptor)).digest('hex');
}

// Idempotent job id: same reference bytes + model + schema/prompt version ->
// same job. Mirrors the frozen `appearance-descriptor-{signature[:24]}` scheme.
function computeDescriptorJobId({ referenceHash, requestedModel, resolvedModel }) {
  const signature = crypto
    .createHash('sha256')
    .update(
      [
        String(referenceHash || ''),
        String(requestedModel || ''),
        String(resolvedModel || requestedModel || ''),
        String(DESCRIPTOR_SCHEMA_VERSION),
        String(DESCRIPTOR_PROMPT_VERSION),
      ].join(' '),
    )
    .digest('hex');
  return { jobId: `appearance-descriptor-${signature.slice(0, 24)}`, signature };
}

// ---- in-memory job store ---------------------------------------------------
//
// Satisfies the poll contract cheaply without a DB table. A succeeded/failed job
// is retained for TTL so repeat opens of the editor reuse it (idempotency).

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 512;

class DescriptorJobStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxJobs = MAX_JOBS, now = () => Date.now() } = {}) {
    this._ttlMs = ttlMs;
    this._maxJobs = maxJobs;
    this._now = now;
    this._jobs = new Map();
  }

  _evict() {
    const now = this._now();
    for (const [id, job] of this._jobs) {
      if (job._expiresAt && job._expiresAt <= now) this._jobs.delete(id);
    }
    while (this._jobs.size > this._maxJobs) {
      const oldest = this._jobs.keys().next().value;
      if (oldest === undefined) break;
      this._jobs.delete(oldest);
    }
  }

  get(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return null;
    if (job._expiresAt && job._expiresAt <= this._now()) {
      this._jobs.delete(jobId);
      return null;
    }
    return job;
  }

  set(job) {
    this._evict();
    const expiresAt =
      job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled'
        ? this._now() + this._ttlMs
        : null;
    // Re-insert last so eviction order is roughly LRU by write.
    this._jobs.delete(job.jobId);
    this._jobs.set(job.jobId, { ...job, _expiresAt: expiresAt });
    return this._jobs.get(job.jobId);
  }
}

module.exports = {
  DESCRIPTOR_SCHEMA_VERSION,
  DESCRIPTOR_PROMPT_VERSION,
  DESCRIPTOR_CAPABILITY_ID,
  DIRECTION_CLASSES,
  SOURCE_TYPES,
  EXPOSURE_STYLES,
  HIGHLIGHT_ROLL_OFFS,
  TINT_CLASSES,
  LIGHTING_DESCRIPTOR_JSON_SCHEMA,
  DESCRIPTOR_SYSTEM_PROMPT,
  DescriptorSchemaError,
  buildDescriptorInstruction,
  validateDescriptor,
  parseDescriptorResponse,
  canonicalJson,
  computeDescriptorHash,
  computeDescriptorJobId,
  DescriptorJobStore,
};
