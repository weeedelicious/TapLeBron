const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureRequestedResolution,
  resolutionRankFromDimensions,
  upscaleFactorForDimensions,
} = require('./ImageUpscaleService');

function pngDimensions(buffer) {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

test('classifies returned image resolution from the actual long edge', () => {
  assert.equal(resolutionRankFromDimensions({ width: 1376, height: 768 }), 1);
  assert.equal(resolutionRankFromDimensions({ width: 2752, height: 1536 }), 2);
  assert.equal(resolutionRankFromDimensions({ width: 5504, height: 3072 }), 4);
});

test('upscales a 1K proxy response to the requested 2K or 4K class', () => {
  const dimensions = { width: 1376, height: 768 };
  assert.equal(upscaleFactorForDimensions(dimensions, '2K'), 2);
  assert.equal(upscaleFactorForDimensions(dimensions, '4K'), 4);
});

test('only doubles an already-2K image when 4K was requested', () => {
  assert.equal(upscaleFactorForDimensions({ width: 2752, height: 1536 }, '4K'), 2);
});

test('does not upscale an image that already reaches the requested class', () => {
  assert.equal(upscaleFactorForDimensions({ width: 3840, height: 2160 }, '4K'), 1);
  assert.equal(upscaleFactorForDimensions({ width: 2048, height: 1152 }, '2K'), 1);
});

test('reads requested scale factors from the shared model rule', () => {
  const fallbackConfig = { scaleFactors: { '2K': 4 } };
  assert.equal(upscaleFactorForDimensions({ width: 1024, height: 1024 }, '2K', fallbackConfig), 4);
});

test('writes an image with genuinely doubled pixel dimensions', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shotflow-upscale-test-'));
  const sourcePath = path.join(directory, 'source.png');
  try {
    try {
      execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-y',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', 'color=c=blue:s=64x36',
        '-frames:v', '1',
        sourcePath,
      ]);
    } catch {
      context.skip('ffmpeg is unavailable');
      return;
    }

    const sourceBuffer = fs.readFileSync(sourcePath);
    const result = await ensureRequestedResolution({
      buffers: [sourceBuffer],
      requestedResolution: '2K',
      outputFormat: 'png',
      temporaryDirectory: directory,
      getDimensions: async (buffer) => pngDimensions(buffer),
      createId: () => 'integration',
    });

    assert.deepEqual(pngDimensions(result.buffers[0]), { width: 128, height: 72 });
    assert.equal(result.details[0].scaleFactor, 2);
    assert.equal(result.details[0].method, 'ffmpeg-lanczos');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
