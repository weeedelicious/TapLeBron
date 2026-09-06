'use strict';

// Unit tests for the panorama (360°x180° HDR) feature's pure helpers in
// src/canvas/features/panorama/panorama.ts — recognition/parsing of the
// derivation payload plus the yaw/pitch/FOV rule helpers used by
// PanoramaViewerModal. Pure logic, no DB/provider/React/three.js.
//   node --test tests/panorama.test.js
//
// panorama.ts is a TypeScript ES module; Node's native type-stripping loader
// requires the nearest package.json to declare "type": "module" to parse
// `export` syntax, so a scoped package.json lives next to it
// (src/canvas/features/panorama/package.json) while this test file stays
// plain CommonJS and reaches it via a dynamic import().

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePromise = import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'canvas', 'features', 'panorama', 'panorama.ts'),
).href);

function validPanoramaData(overrides = {}) {
  return {
    generatorType: 'panorama-360x180',
    params: {
      advancedSettings: {
        panorama: {
          version: 1,
          kind: 'panorama-360x180',
          projection: 'equirectangular',
          sourceNodeId: 'node-1',
          sourceUrl: 'https://example.com/pano.jpg',
          sourceName: 'photo.jpg',
          engine: 'mivo-panorama',
          createdAtMs: 1700000000000,
          ...overrides,
        },
      },
    },
  };
}

test('readPanoramaDerivation parses a valid derivation payload', async () => {
  const svc = await modulePromise;
  const parsed = svc.readPanoramaDerivation(validPanoramaData());
  assert.ok(parsed);
  assert.strictEqual(parsed.kind, 'panorama-360x180');
  assert.strictEqual(parsed.projection, 'equirectangular');
  assert.strictEqual(parsed.sourceNodeId, 'node-1');
  assert.strictEqual(parsed.sourceUrl, 'https://example.com/pano.jpg');
  assert.strictEqual(parsed.engine, 'mivo-panorama');
  assert.strictEqual(parsed.createdAtMs, 1700000000000);
});

test('readPanoramaDerivation returns null for missing/malformed input', async () => {
  const svc = await modulePromise;
  assert.strictEqual(svc.readPanoramaDerivation(undefined), null);
  assert.strictEqual(svc.readPanoramaDerivation(null), null);
  assert.strictEqual(svc.readPanoramaDerivation({}), null);
  assert.strictEqual(svc.readPanoramaDerivation({ params: null }), null);
  assert.strictEqual(svc.readPanoramaDerivation({ params: { advancedSettings: null } }), null);
  assert.strictEqual(svc.readPanoramaDerivation({ params: { advancedSettings: { panorama: 'nope' } } }), null);
});

test('readPanoramaDerivation rejects wrong kind/projection', async () => {
  const svc = await modulePromise;
  const wrongKind = validPanoramaData();
  wrongKind.params.advancedSettings.panorama.kind = 'crop';
  assert.strictEqual(svc.readPanoramaDerivation(wrongKind), null);

  const wrongProjection = validPanoramaData();
  wrongProjection.params.advancedSettings.panorama.projection = 'cubemap';
  assert.strictEqual(svc.readPanoramaDerivation(wrongProjection), null);
});

test('readPanoramaDerivation rejects missing required fields', async () => {
  const svc = await modulePromise;
  const noSourceUrl = validPanoramaData();
  noSourceUrl.params.advancedSettings.panorama.sourceUrl = '';
  assert.strictEqual(svc.readPanoramaDerivation(noSourceUrl), null);

  const noSourceNodeId = validPanoramaData();
  noSourceNodeId.params.advancedSettings.panorama.sourceNodeId = '';
  assert.strictEqual(svc.readPanoramaDerivation(noSourceNodeId), null);

  const badCreatedAt = validPanoramaData();
  badCreatedAt.params.advancedSettings.panorama.createdAtMs = 0;
  assert.strictEqual(svc.readPanoramaDerivation(badCreatedAt), null);
});

test('isPanoramaNodeData recognizes a valid derivation and rejects everything else', async () => {
  const svc = await modulePromise;
  assert.strictEqual(svc.isPanoramaNodeData(validPanoramaData()), true);
  assert.strictEqual(svc.isPanoramaNodeData(undefined), false);
  assert.strictEqual(svc.isPanoramaNodeData({}), false);
  assert.strictEqual(svc.isPanoramaNodeData({ generatorType: 'panorama-360x180' }), false, 'generatorType alone without a valid derivation payload is not enough');
});

test('normalizePanoramaYaw wraps into (-180, 180]', async () => {
  const svc = await modulePromise;
  assert.strictEqual(svc.normalizePanoramaYaw(0), 0);
  assert.strictEqual(svc.normalizePanoramaYaw(180), -180);
  assert.strictEqual(svc.normalizePanoramaYaw(-180), -180);
  assert.strictEqual(svc.normalizePanoramaYaw(270), -90);
  assert.strictEqual(svc.normalizePanoramaYaw(-270), 90);
  assert.strictEqual(svc.normalizePanoramaYaw(720), 0);
  assert.strictEqual(svc.normalizePanoramaYaw(Number.NaN), 0);
});

test('clampPanoramaPitch bounds to +/-85 and falls back to 0', async () => {
  const svc = await modulePromise;
  assert.strictEqual(svc.clampPanoramaPitch(0), 0);
  assert.strictEqual(svc.clampPanoramaPitch(100), 85);
  assert.strictEqual(svc.clampPanoramaPitch(-100), -85);
  assert.strictEqual(svc.clampPanoramaPitch(Number.NaN), 0);
});

test('clampPanoramaFov bounds to [30, 100] and falls back to 75', async () => {
  const svc = await modulePromise;
  assert.strictEqual(svc.clampPanoramaFov(75), 75);
  assert.strictEqual(svc.clampPanoramaFov(10), 30);
  assert.strictEqual(svc.clampPanoramaFov(500), 100);
  assert.strictEqual(svc.clampPanoramaFov(Number.NaN), 75);
});

test('isTwoToOnePanorama detects ~2:1 aspect ratio within tolerance', async () => {
  const svc = await modulePromise;
  assert.strictEqual(svc.isTwoToOnePanorama(4096, 2048), true);
  assert.strictEqual(svc.isTwoToOnePanorama(4096, 2049), true, 'small rounding slack should pass');
  assert.strictEqual(svc.isTwoToOnePanorama(4096, 2160), false, 'clearly non-2:1 should fail');
  assert.strictEqual(svc.isTwoToOnePanorama(0, 2048), false);
  assert.strictEqual(svc.isTwoToOnePanorama(4096, 0), false);
  assert.strictEqual(svc.isTwoToOnePanorama(Number.NaN, 2048), false);
});
