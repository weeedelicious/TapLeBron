const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');
const service = require('./PanoramaErpTemplateService');

async function makeSource(filePath) {
  const width = 320;
  const height = 180;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      data[offset] = Math.round((x / (width - 1)) * 255);
      data[offset + 1] = Math.round((y / (height - 1)) * 255);
      data[offset + 2] = 80;
    }
  }
  await sharp(data, { raw: { width, height, channels: 3 } }).png().toFile(filePath);
}

test('builds a strict 2:1 ERP template with protected and missing pixels', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shotflow-erp-'));
  try {
    const sourcePath = path.join(directory, 'source.png');
    await makeSource(sourcePath);
    const result = await service.buildErpEditTemplate({ sourcePath, width: 512, height: 256 });
    const templateMeta = await sharp(result.templateBuffer).metadata();
    const mask = await sharp(result.maskBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(templateMeta.width, 512);
    assert.equal(templateMeta.height, 256);
    assert.ok(result.metadata.knownFraction > 0);
    assert.ok(result.metadata.knownFraction < 0.5);
    let opaque = 0;
    let transparent = 0;
    for (let offset = 3; offset < mask.data.length; offset += 4) {
      if (mask.data[offset] >= 128) opaque += 1;
      else transparent += 1;
    }
    assert.ok(opaque > 0);
    assert.ok(transparent > opaque);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restores protected source pixels after provider generation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shotflow-erp-'));
  try {
    const sourcePath = path.join(directory, 'source.png');
    const generatedPath = path.join(directory, 'generated.png');
    await makeSource(sourcePath);
    await sharp({ create: { width: 256, height: 128, channels: 4, background: '#1b5fe0' } }).png().toFile(generatedPath);
    const template = await service.buildErpEditTemplate({ sourcePath, width: 256, height: 128 });
    const restored = await service.restoreProtectedPixels({
      generatedPath,
      templateBuffer: template.templateBuffer,
      maskBuffer: template.maskBuffer,
    });
    assert.equal(restored.width, 256);
    assert.equal(restored.height, 128);
    assert.equal(restored.restoredFraction, template.metadata.knownFraction);
    const restoredMeta = await sharp(restored.buffer).metadata();
    assert.equal(restoredMeta.width / restoredMeta.height, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('center-crops a supported wide provider result before restoring a strict 2:1 ERP', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shotflow-erp-'));
  try {
    const sourcePath = path.join(directory, 'source.png');
    const generatedPath = path.join(directory, 'generated-16x9.png');
    await makeSource(sourcePath);
    await sharp({ create: { width: 1600, height: 900, channels: 4, background: '#205bd1' } }).png().toFile(generatedPath);
    const template = await service.buildErpEditTemplate({ sourcePath, width: 1024, height: 512 });
    const restored = await service.restoreProtectedPixels({
      generatedPath,
      templateBuffer: template.templateBuffer,
      maskBuffer: template.maskBuffer,
    });
    const restoredMeta = await sharp(restored.buffer).metadata();
    assert.equal(restoredMeta.width, 1024);
    assert.equal(restoredMeta.height, 512);
    assert.equal(restoredMeta.width / restoredMeta.height, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reports seam repair need without launching another generation', async () => {
  const width = 200;
  const height = 100;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      data[offset] = x < width / 2 ? 255 : 0;
      data[offset + 1] = 0;
      data[offset + 2] = x < width / 2 ? 0 : 255;
    }
  }
  const buffer = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const seam = await service.inspectErpSeam(buffer);
  assert.equal(seam.needsRepair, true);
  assert.ok(seam.score > seam.threshold);
});

test('chooses strict 2:1 template dimensions for every preset', () => {
  assert.deepEqual(service.templateDimensionsForResolution('1K'), { width: 1024, height: 512 });
  assert.deepEqual(service.templateDimensionsForResolution('2K'), { width: 2048, height: 1024 });
  assert.deepEqual(service.templateDimensionsForResolution('4K'), { width: 4096, height: 2048 });
  assert.deepEqual(service.templateDimensionsForResolution('2K', '1440x720'), { width: 1440, height: 720 });
});
