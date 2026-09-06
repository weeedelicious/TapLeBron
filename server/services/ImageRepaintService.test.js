const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const repaintService = require('./ImageRepaintService');

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shotflow-repaint-'));
  const sourcePath = path.join(directory, 'source.png');
  const maskPath = path.join(directory, 'mask.png');
  try {
    await sharp({
      create: {
        width: 4,
        height: 2,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    }).png().toFile(sourcePath);

    const maskPixels = Buffer.alloc(4 * 2 * 4, 255);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        maskPixels[(y * 4 + x) * 4 + 3] = 0;
      }
    }
    await sharp(maskPixels, { raw: { width: 4, height: 2, channels: 4 } }).png().toFile(maskPath);

    const generated = await sharp({
      create: {
        width: 4,
        height: 2,
        channels: 4,
        background: { r: 0, g: 0, b: 255, alpha: 1 },
      },
    }).png().toBuffer();

    const [result] = await repaintService.hardCompositeRepaintBuffers({
      sharp,
      generatedBuffers: [generated],
      sourceInput: { filePath: sourcePath },
      maskInput: { filePath: maskPath },
    });
    const { data } = await sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepStrictEqual(Array.from(data.subarray(0, 4)), [0, 0, 255, 255]);
    assert.deepStrictEqual(Array.from(data.subarray(3 * 4, 3 * 4 + 4)), [255, 0, 0, 255]);
    console.log('ImageRepaintService hard-mask composite test passed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
