const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validatePanoramaRequest,
  panoramaAspectRatio,
  isNearEquirectangular,
  assertEquirectangularDimensions,
  buildPanoramaSubmission,
  buildPanoramaOutputMetadata,
} = require('./PanoramaService');

test('validatePanoramaRequest trims and returns the three required fields', () => {
  const result = validatePanoramaRequest({
    projectUuid: '  canvas-1  ',
    nodeKey: ' node-1 ',
    imageUrl: ' /assets/canvas-1/source.png ',
  });
  assert.deepEqual(result, {
    projectUuid: 'canvas-1',
    nodeKey: 'node-1',
    imageUrl: '/assets/canvas-1/source.png',
  });
});

test('validatePanoramaRequest rejects a missing projectUuid', () => {
  assert.throws(
    () => validatePanoramaRequest({ nodeKey: 'node-1', imageUrl: '/assets/a.png' }),
    (error) => {
      assert.equal(error.code, 'REFERENCE_MISSING');
      assert.equal(error.statusCode, 400);
      assert.equal(error.details.field, 'projectUuid');
      return true;
    }
  );
});

test('validatePanoramaRequest rejects a missing nodeKey', () => {
  assert.throws(
    () => validatePanoramaRequest({ projectUuid: 'canvas-1', imageUrl: '/assets/a.png' }),
    (error) => {
      assert.equal(error.code, 'REFERENCE_MISSING');
      assert.equal(error.details.field, 'nodeKey');
      return true;
    }
  );
});

test('validatePanoramaRequest rejects a missing imageUrl', () => {
  assert.throws(
    () => validatePanoramaRequest({ projectUuid: 'canvas-1', nodeKey: 'node-1' }),
    (error) => {
      assert.equal(error.code, 'REFERENCE_MISSING');
      assert.equal(error.details.field, 'imageUrl');
      return true;
    }
  );
});

test('panoramaAspectRatio computes width/height and rejects bad input', () => {
  assert.equal(panoramaAspectRatio({ width: 4096, height: 2048 }), 2);
  assert.equal(panoramaAspectRatio({ width: 0, height: 2048 }), null);
  assert.equal(panoramaAspectRatio({ width: 4096, height: 0 }), null);
  assert.equal(panoramaAspectRatio({}), null);
});

test('isNearEquirectangular accepts an exact 2:1 image and rejects a square image', () => {
  assert.equal(isNearEquirectangular({ width: 4096, height: 2048 }), true);
  assert.equal(isNearEquirectangular({ width: 2048, height: 2048 }), false);
});

test('isNearEquirectangular tolerates small encoder rounding drift', () => {
  // Encoder rounding can shift a nominal 2:1 width by a few pixels.
  assert.equal(isNearEquirectangular({ width: 2050, height: 1024 }), true);
});

test('assertEquirectangularDimensions returns the measured ratio for a valid panorama', () => {
  const result = assertEquirectangularDimensions({ width: 5504, height: 2752 });
  assert.equal(result.width, 5504);
  assert.equal(result.height, 2752);
  assert.equal(result.ratio, 2);
  assert.equal(result.targetRatio, 2);
});

test('assertEquirectangularDimensions throws OUTPUT_PERSIST_FAILED for unreadable dimensions', () => {
  assert.throws(
    () => assertEquirectangularDimensions({ width: 0, height: 0 }),
    (error) => {
      assert.equal(error.code, 'OUTPUT_PERSIST_FAILED');
      assert.equal(error.statusCode, 502);
      return true;
    }
  );
});

test('assertEquirectangularDimensions throws for a square image outside tolerance', () => {
  assert.throws(
    () => assertEquirectangularDimensions({ width: 2048, height: 2048 }),
    (error) => {
      assert.equal(error.code, 'OUTPUT_PERSIST_FAILED');
      assert.equal(error.statusCode, 502);
      assert.equal(error.details.ratio, 1);
      assert.equal(error.details.targetRatio, 2);
      return true;
    }
  );
});

test('assertEquirectangularDimensions honors a custom tolerance/targetRatio', () => {
  // 3:1 would fail the default 2:1 target, but passes when the caller widens
  // the tolerance and target explicitly (e.g. a different projection).
  const result = assertEquirectangularDimensions({ width: 3072, height: 1024 }, { targetRatio: 3, tolerance: 0.05 });
  assert.equal(result.ratio, 3);
});

test('buildPanoramaSubmission wraps a resolved image reference', () => {
  assert.deepEqual(buildPanoramaSubmission({ image: ' 507f1f77bcf86cd799439011 ' }), {
    image: '507f1f77bcf86cd799439011',
  });
});

test('buildPanoramaSubmission rejects a missing image reference', () => {
  assert.throws(
    () => buildPanoramaSubmission({}),
    (error) => {
      assert.equal(error.code, 'REFERENCE_MISSING');
      assert.equal(error.statusCode, 400);
      return true;
    }
  );
});

test('buildPanoramaOutputMetadata builds a generation_task_outputs-shaped entry', () => {
  const output = buildPanoramaOutputMetadata({
    url: '/assets/canvas-1/panorama.png',
    assetId: 42,
    mimeType: 'image/png',
    width: 4096,
    height: 2048,
    model: 'mivo-panorama',
    extra: { targetRatio: 2, tolerance: 0.015 },
  });
  assert.equal(output.url, '/assets/canvas-1/panorama.png');
  assert.equal(output.assetId, 42);
  assert.equal(output.mimeType, 'image/png');
  assert.equal(output.width, 4096);
  assert.equal(output.height, 2048);
  assert.equal(output.model, 'mivo-panorama');
  assert.equal(output.isPrimary, true);
  assert.deepEqual(output.metadata, {
    kind: 'panorama',
    projection: 'equirectangular',
    aspectRatio: 2,
    targetRatio: 2,
    tolerance: 0.015,
  });
});

test('buildPanoramaOutputMetadata rejects a missing url', () => {
  assert.throws(
    () => buildPanoramaOutputMetadata({ width: 100, height: 50 }),
    (error) => {
      assert.equal(error.code, 'OUTPUT_PERSIST_FAILED');
      assert.equal(error.statusCode, 502);
      return true;
    }
  );
});
