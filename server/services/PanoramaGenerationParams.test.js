const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PANORAMA_DEFAULT_MODEL,
  PANORAMA_DEFAULT_RESOLUTION,
  PANORAMA_MODE_ERP_TEMPLATE,
  PANORAMA_MODE_STANDARD,
  PANORAMA_MODE_STYLE_REDRAW,
  PANORAMA_REQUEST_RATIO,
  panoramaGenerationParams,
  panoramaPrompt,
} = require('./PanoramaGenerationParams');

test('builds default Gateway image parameters', () => {
  const params = panoramaGenerationParams({ sourceUrl: '/assets/p/source.png', sourceName: 'source' });
  assert.equal(params.model, PANORAMA_DEFAULT_MODEL);
  assert.equal(params.resolution, PANORAMA_DEFAULT_RESOLUTION);
  assert.equal(params.generationMode, PANORAMA_MODE_STANDARD);
  assert.equal(params.count, 1);
  assert.equal(params.ratio, PANORAMA_REQUEST_RATIO);
  assert.equal(params.mode, 'image2image');
  assert.equal(params.providerCalls, 1);
  assert.deepEqual(params.images, ['/assets/p/source.png']);
  assert.match(params.prompt, /360-degree by 180-degree/);
  assert.match(params.prompt, /2:1 spherical environment/);
});

test('accepts Nano A1 and preserves additional description', () => {
  const params = panoramaGenerationParams({
    sourceUrl: '/assets/p/source.png',
    model: 'gemini-3-pro-image',
    resolution: '4K',
    generationMode: PANORAMA_MODE_STANDARD,
    description: 'Continue the neon night market.',
  });
  assert.equal(params.model, 'gemini-3-pro-image');
  assert.equal(params.resolution, '4K');
  assert.match(params.prompt, /A1 panorama expansion/i);
  assert.match(params.prompt, /roughly 270 degrees/i);
  assert.match(params.prompt, /Continue the neon night market/);
});

test('builds GPT style redraw prompt', () => {
  const prompt = panoramaPrompt({
    model: 'gpt-image-2',
    generationMode: PANORAMA_MODE_STYLE_REDRAW,
  });
  assert.match(prompt, /Repaint the complete panorama/i);
  assert.match(prompt, /Local details may change slightly/i);
});

test('builds ERP template first-pass prompt', () => {
  const params = panoramaGenerationParams({
    sourceUrl: '/assets/p/source.png',
    model: 'gpt-image-2',
    generationMode: PANORAMA_MODE_ERP_TEMPLATE,
  });
  assert.match(params.prompt, /ERP editing template/i);
  assert.match(params.prompt, /first experimental ERP completion pass/i);
  assert.equal(params.providerCalls, 1);
});

test('rejects style redraw for Nano Banana Pro', () => {
  assert.throws(() => panoramaGenerationParams({
    sourceUrl: '/assets/p/source.png',
    model: 'gemini-3-pro-image',
    generationMode: PANORAMA_MODE_STYLE_REDRAW,
  }), /仅支持 GPT Image 2/);
});

test('rejects unsupported model, resolution, and mode', () => {
  assert.throws(() => panoramaGenerationParams({ sourceUrl: 'x', model: 'other-model' }), /model不受支持/);
  assert.throws(() => panoramaGenerationParams({ sourceUrl: 'x', resolution: '8K' }), /resolution不受支持/);
  assert.throws(() => panoramaGenerationParams({ sourceUrl: 'x', generationMode: 'automatic-retry' }), /generationMode不受支持/);
});

test('rejects an empty source image', () => {
  assert.throws(() => panoramaGenerationParams({}), /缺少全景参考原图/);
});

test('prompt forbids padding, collages, and stretching', () => {
  const prompt = panoramaPrompt({ model: 'gpt-image-2', generationMode: PANORAMA_MODE_STANDARD });
  assert.match(prompt, /no UI/i);
  assert.match(prompt, /multi-view collage/i);
  assert.match(prompt, /stretched flat image/i);
  assert.match(prompt, /continuous left\/right seam/i);
});
