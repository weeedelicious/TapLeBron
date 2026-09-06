'use strict';

// Unit tests for the appearance-transfer lighting-descriptor service.
// Pure logic, no DB/provider — runnable with the built-in runner:
//   node --test tests/appearance-descriptor.test.js
//
// Covers: strict parse (reject fences / non-JSON / out-of-range / bad enum /
// bad hex / missing section / CCT range+rounding / keyword bounds), canonical
// hash stability (key-order independent), idempotent job id, TTL job store,
// and the instruction prompt contract.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const svc = require(path.join(__dirname, '..', 'server', 'services', 'appearanceDescriptorService'));

function validDescriptor() {
  return {
    schemaVersion: 1,
    coordinateSystem: 'camera',
    confidence: 0.82,
    keyLight: {
      directionClass: 'front-left-high',
      azimuthDeg: -35,
      elevationDeg: 40,
      directionConfidence: 0.7,
      sourceType: 'window',
      size: 0.4,
      softness: 0.6,
      intensity: 0.9,
    },
    fillLight: { present: true, relativeIntensity: 0.35, colorHex: '#8899AA' },
    rimLight: { present: false, directionClass: 'rear', intensity: 0.1, colorHex: '#FFFFFF' },
    exposure: {
      style: 'balanced',
      shadowAreaRatio: 0.4,
      contrast: 0.5,
      highlightRollOff: 'soft',
      blackPoint: 0.02,
      whitePoint: 0.98,
    },
    color: {
      estimatedCctK: 5200,
      cctConfidence: 0.6,
      tint: 'warm',
      ambientColorHex: '#332211',
      highlightColorHex: '#FFEEDD',
    },
    atmosphere: { haze: 0.2, aerialPerspective: 0.1, bloom: 0.05 },
    globalMood: { keywords: ['warm', 'soft'], summary: 'Warm soft window light.' },
    uncertainties: ['azimuth approximate'],
  };
}

function expectSchemaError(fn, label) {
  assert.throws(fn, (err) => err instanceof svc.DescriptorSchemaError && err.code === 'descriptor_schema_invalid', label);
}

test('parses a valid descriptor and normalizes constants', () => {
  const parsed = svc.parseDescriptorResponse(JSON.stringify(validDescriptor()));
  assert.strictEqual(parsed.schemaVersion, 1);
  assert.strictEqual(parsed.coordinateSystem, 'camera');
  assert.strictEqual(parsed.keyLight.azimuthDeg, -35);
  assert.strictEqual(parsed.color.estimatedCctK, 5200);
  assert.deepStrictEqual(parsed.globalMood.keywords, ['warm', 'soft']);
});

test('accepts null key-light angles', () => {
  const d = validDescriptor();
  d.keyLight.azimuthDeg = null;
  d.keyLight.elevationDeg = null;
  const parsed = svc.parseDescriptorResponse(JSON.stringify(d));
  assert.strictEqual(parsed.keyLight.azimuthDeg, null);
  assert.strictEqual(parsed.keyLight.elevationDeg, null);
});

test('drops unknown top-level keys instead of failing', () => {
  const d = validDescriptor();
  d.somethingExtra = { chatty: true };
  const parsed = svc.parseDescriptorResponse(JSON.stringify(d));
  assert.strictEqual(parsed.somethingExtra, undefined);
});

test('rejects fenced output', () => {
  const fenced = '```json\n' + JSON.stringify(validDescriptor()) + '\n```';
  expectSchemaError(() => svc.parseDescriptorResponse(fenced), 'fenced should throw');
});

test('rejects non-JSON and non-object', () => {
  expectSchemaError(() => svc.parseDescriptorResponse('not json at all'), 'garbage');
  expectSchemaError(() => svc.parseDescriptorResponse('[1,2,3]'), 'array');
  expectSchemaError(() => svc.parseDescriptorResponse(''), 'empty');
});

test('rejects out-of-range unit values', () => {
  const d = validDescriptor();
  d.confidence = 1.5;
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(d)), 'confidence>1');
});

test('rejects bad enums', () => {
  const d = validDescriptor();
  d.keyLight.directionClass = 'sideways';
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(d)), 'bad directionClass');

  const d2 = validDescriptor();
  d2.exposure.style = 'medium-key';
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(d2)), 'bad exposure.style');
});

test('rejects bad hex colors', () => {
  const d = validDescriptor();
  d.fillLight.colorHex = 'red';
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(d)), 'named color');

  const d2 = validDescriptor();
  d2.color.ambientColorHex = '#ABC';
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(d2)), 'short hex');
});

test('rejects a missing required section', () => {
  const d = validDescriptor();
  delete d.exposure;
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(d)), 'missing exposure');
});

test('rejects out-of-range azimuth', () => {
  const d = validDescriptor();
  d.keyLight.azimuthDeg = 200;
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(d)), 'azimuth>180');
});

test('CCT: rounds floats and enforces range', () => {
  const d = validDescriptor();
  d.color.estimatedCctK = 5200.7;
  assert.strictEqual(svc.parseDescriptorResponse(JSON.stringify(d)).color.estimatedCctK, 5201);

  const low = validDescriptor();
  low.color.estimatedCctK = 500;
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(low)), 'CCT too low');

  const high = validDescriptor();
  high.color.estimatedCctK = 44000;
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(high)), 'CCT too high');
});

test('globalMood keyword bounds', () => {
  const empty = validDescriptor();
  empty.globalMood.keywords = [];
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(empty)), 'no keywords');

  const tooMany = validDescriptor();
  tooMany.globalMood.keywords = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  expectSchemaError(() => svc.parseDescriptorResponse(JSON.stringify(tooMany)), '>8 keywords');
});

test('descriptor hash is stable and key-order independent', () => {
  const a = svc.parseDescriptorResponse(JSON.stringify(validDescriptor()));
  const reordered = JSON.parse(JSON.stringify(a, Object.keys(a).sort().reverse()));
  // Rebuild a fully reordered clone by round-tripping with shuffled keys.
  const shuffled = {};
  for (const key of Object.keys(a).reverse()) shuffled[key] = a[key];
  assert.strictEqual(svc.computeDescriptorHash(a), svc.computeDescriptorHash(shuffled));

  const b = svc.parseDescriptorResponse(JSON.stringify(validDescriptor()));
  b.confidence = 0.5;
  assert.notStrictEqual(svc.computeDescriptorHash(a), svc.computeDescriptorHash(b));
  void reordered;
});

test('job id is deterministic, prefixed, and input-sensitive', () => {
  const one = svc.computeDescriptorJobId({ referenceHash: 'abc', requestedModel: 'm', resolvedModel: 'm' });
  const same = svc.computeDescriptorJobId({ referenceHash: 'abc', requestedModel: 'm', resolvedModel: 'm' });
  const diff = svc.computeDescriptorJobId({ referenceHash: 'xyz', requestedModel: 'm', resolvedModel: 'm' });
  assert.ok(one.jobId.startsWith('appearance-descriptor-'));
  assert.strictEqual(one.jobId.length, 'appearance-descriptor-'.length + 24);
  assert.strictEqual(one.jobId, same.jobId);
  assert.notStrictEqual(one.jobId, diff.jobId);
});

test('job store: set/get and TTL eviction', () => {
  let now = 0;
  const store = new svc.DescriptorJobStore({ ttlMs: 1000, now: () => now });
  store.set({ jobId: 'j1', status: 'succeeded' });
  assert.strictEqual(store.get('j1').status, 'succeeded');
  now = 1500;
  assert.strictEqual(store.get('j1'), null, 'expired after TTL');
  assert.strictEqual(store.get('missing'), null);

  // A running job carries no expiry until it reaches a terminal state.
  now = 0;
  store.set({ jobId: 'j2', status: 'running' });
  now = 10_000;
  assert.strictEqual(store.get('j2').status, 'running');
});

test('instruction prompt contract', () => {
  const base = svc.buildDescriptorInstruction({ retry: false });
  assert.match(base, /Return exactly one raw JSON object\./);
  assert.match(base, /Do not use Markdown or code fences\./);
  assert.match(base, /JSON Schema:/);
  assert.doesNotMatch(base, /previous response was invalid/i);

  const retry = svc.buildDescriptorInstruction({ retry: true });
  assert.match(retry, /The previous response was invalid\. Return a corrected object\./);
});
