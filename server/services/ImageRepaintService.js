const fs = require('fs');

function normalizeRepaintConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceUrl = String(value.sourceUrl || '').trim();
  const maskUrl = String(value.maskUrl || '').trim();
  if (!sourceUrl || !maskUrl) return null;
  const compositeOutput = value.compositeOutput !== false;
  return {
    version: Number(value.version || 1),
    contract: String(value.contract || 'hard-mask-v0.0.1'),
    sourceNodeId: String(value.sourceNodeId || ''),
    sourceUrl,
    sourceName: String(value.sourceName || 'image'),
    maskUrl,
    maskWidth: Math.max(1, Math.round(Number(value.maskWidth || 0) || 1)),
    maskHeight: Math.max(1, Math.round(Number(value.maskHeight || 0) || 1)),
    maskCoverage: Math.max(0, Math.min(1, Number(value.maskCoverage || 0) || 0)),
    commandCount: Math.max(0, Math.round(Number(value.commandCount || 0) || 0)),
    brushSize: Math.max(1, Math.round(Number(value.brushSize || 1) || 1)),
    providerBehavior: String(value.providerBehavior || ''),
    compositeOutput,
  };
}

function buildGeminiRepaintPrompt(prompt) {
  return [
    'Perform a local image repaint using the supplied source image and binary mask.',
    'Input image 1 is the source image.',
    'Input image 2 is the binary mask: transparent pixels are the editable repaint area; opaque pixels are protected and must remain unchanged.',
    'Generate content only for the transparent mask area. Preserve the subject identity, pose, composition, perspective, lighting continuity, texture, and all unmasked pixels.',
    'Do not crop, stretch, pad, zoom, or change the canvas size.',
    '',
    `Repaint instruction: ${String(prompt || '').trim()}`,
  ].join('\n');
}

function assertReadableImageInput(input, label) {
  if (!input?.filePath || !fs.existsSync(input.filePath)) {
    const error = new Error(`${label}无法读取，请重新打开局部重绘后再试。`);
    error.code = 'REPAINT_ASSET_UNAVAILABLE';
    throw error;
  }
}

async function hardCompositeRepaintBuffers({
  sharp,
  generatedBuffers,
  sourceInput,
  maskInput,
}) {
  if (!sharp) throw new Error('服务器缺少图片处理组件，无法完成局部重绘合成。');
  assertReadableImageInput(sourceInput, '局部重绘原图');
  assertReadableImageInput(maskInput, '局部重绘遮罩');

  const sourceBuffer = fs.readFileSync(sourceInput.filePath);
  const maskBuffer = fs.readFileSync(maskInput.filePath);
  const metadata = await sharp(sourceBuffer).metadata();
  const width = Math.max(1, Number(metadata.width || 0));
  const height = Math.max(1, Number(metadata.height || 0));
  if (!width || !height) throw new Error('无法读取局部重绘原图尺寸。');

  const maskAlpha = await sharp(maskBuffer)
    .resize(width, height, {
      fit: 'fill',
      kernel: sharp.kernel.nearest,
    })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();

  const source = await sharp(sourceBuffer)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer();

  const results = [];
  for (const generatedBuffer of generatedBuffers || []) {
    const generated = await sharp(generatedBuffer)
      .resize(width, height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const generatedAlphaIndex = pixel * 4 + 3;
      const editableAlpha = 255 - maskAlpha[pixel];
      generated[generatedAlphaIndex] = Math.round((generated[generatedAlphaIndex] * editableAlpha) / 255);
    }
    const composited = await sharp(source)
      .composite([{
        input: generated,
        raw: { width, height, channels: 4 },
        blend: 'over',
      }])
      .png()
      .toBuffer();
    results.push(composited);
  }
  return results;
}

module.exports = {
  normalizeRepaintConfig,
  buildGeminiRepaintPrompt,
  assertReadableImageInput,
  hardCompositeRepaintBuffers,
};
