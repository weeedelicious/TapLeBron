/**
 * 纹理清晰化（精准修复 · 人物真实化）的服务层。
 *
 * 分工：
 *   TextureClarityFusion.js  纯数学，本地保护融合链（有单测）
 *   本文件                    语义分区 worker 调用、语义可视化、提示词编译、尺寸规范化、
 *                            sharp 编解码、资产命名
 *   canvasRoutes.js 的路由    编排：取源图、复用几何资产、单次生图、落资产、返回诊断
 *
 * 为什么编排放路由里而不是这里：资产落盘那一套（assetsDir / upsertAssetRecord /
 * mirrorStoredAsset / tryReuseLightStageGeometry / generateOpenAiImages）全是
 * canvasRoutes.js 的局部函数。把它们一个个导出来只为了给这里用，等于把那个文件的内部
 * 结构摊开，改动面反而更大。灯光重塑（light-stage）就是这个分法，跟着它走。
 */

'use strict';

const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');

const semantics = require('../../src/shared/texture-clarity-semantics.json');
const fusion = require('./TextureClarityFusion');

/** 资产版本。改了语义映射、融合算法或规范化口径都要 +1，否则会复用到旧口径的缓存。 */
const TEXTURE_CLARITY_ASSET_VERSION = 1;
const SEMANTIC_LABEL_SET = 'ATR-18';

const MAX_EDGE = Number(semantics.outputPolicy?.maxEdge || 2048);
const FUSION_POLICY = String(semantics.fusionPolicy || 'smart-blend-multiscale-v1');

/** 内部类别 id → 是否计入融合支持区。背景恒为 false。 */
function supportFlagTable() {
  const flags = new Uint8Array(256);
  for (const item of semantics.classes) {
    flags[item.id] = item.repairSupport ? 1 : 0;
  }
  return flags;
}

/** 原始 ATR 类别 id → 内部类别 id 的 256 查表。认不出来的归背景。 */
function atrLookupTable() {
  const table = new Uint8Array(256);
  for (let raw = 0; raw < 256; raw += 1) {
    const mapped = semantics.atrToInternal[String(raw)];
    table[raw] = Number.isInteger(mapped) ? mapped : 0;
  }
  return table;
}

const SUPPORT_FLAGS = supportFlagTable();
const ATR_LOOKUP = atrLookupTable();

const CLASS_COLORS = (() => {
  const table = new Uint8Array(256 * 3);
  for (const item of semantics.classes) {
    const hex = String(item.color || '#000000').replace('#', '');
    table[item.id * 3] = parseInt(hex.slice(0, 2), 16) || 0;
    table[item.id * 3 + 1] = parseInt(hex.slice(2, 4), 16) || 0;
    table[item.id * 3 + 2] = parseInt(hex.slice(4, 6), 16) || 0;
  }
  return table;
})();

/**
 * 输出尺寸规范化：最长边不超过 2K、保持比例、宽高对齐偶数。
 * 对齐偶数是给融合链的：多尺度模糊要反复取邻域，奇数尺寸在边界上更容易差半个像素。
 */
function normalizeTargetSize(width, height, maxEdge = MAX_EDGE) {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const longest = Math.max(safeWidth, safeHeight);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const even = (value) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(safeWidth), height: even(safeHeight), scale };
}

/**
 * 读图片尺寸。
 *
 * 存在的理由：canvasRoutes.js 里的 sharp 是懒加载的 getSharp()，没有顶层 sharp 绑定，
 * 在那边裸写 sharp(...) 会是个运行时 ReferenceError（node --check 抓不到）。
 * 需要尺寸的地方一律走这里。
 */
async function imageSize(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  return { width: Number(meta.width || 0), height: Number(meta.height || 0), format: String(meta.format || '') };
}

/** 把任意图片规范化成 ≤2K 的 PNG，并返回真实宽高。 */
async function normalizeSourceImage(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  const target = normalizeTargetSize(meta.width || 0, meta.height || 0);
  const png = await sharp(buffer, { failOn: 'none' })
    .resize(target.width, target.height, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .png()
    .toBuffer();
  return {
    buffer: png,
    width: target.width,
    height: target.height,
    scale: target.scale,
    originalWidth: meta.width || 0,
    originalHeight: meta.height || 0,
  };
}

/** 解出紧密排列的 RGB8。removeAlpha 是必须的 —— 融合链按 3 通道步进。 */
async function decodeRgb(buffer, width, height) {
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`期望 3 通道，实际 ${info.channels}`);
  return new Uint8Array(data.buffer, data.byteOffset, data.length);
}

/** 解出单通道类别图。不缩放 —— worker 返回的尺寸就等于规范化后的源图尺寸。 */
async function decodeClassMap(buffer, width, height) {
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) {
    throw new Error(`语义类别图尺寸 ${info.width}x${info.height} 与源图 ${width}x${height} 不一致`);
  }
  if (info.channels === 1) {
    return new Uint8Array(data.buffer, data.byteOffset, data.length);
  }
  // 万一 PNG 被存成了多通道，取第一通道 —— 类别值在每个通道里是一样的
  const out = new Uint8Array(info.width * info.height);
  for (let i = 0; i < out.length; i += 1) out[i] = data[i * info.channels];
  return out;
}

async function encodePng(rgb, width, height) {
  return sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length), {
    raw: { width, height, channels: 3 },
  }).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * 语义分区可视化图：给编辑器左栏看的分块颜色图。
 * 按内部类别 id 上色，颜色只是可视化编码 —— 判定一律用 id，绝不反解 RGB。
 */
async function buildSemanticVisualization(classMap, width, height) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < classMap.length; i += 1) {
    const internal = ATR_LOOKUP[classMap[i]] || 0;
    rgb[i * 3] = CLASS_COLORS[internal * 3];
    rgb[i * 3 + 1] = CLASS_COLORS[internal * 3 + 1];
    rgb[i * 3 + 2] = CLASS_COLORS[internal * 3 + 2];
  }
  return encodePng(rgb, width, height);
}

/** 按内部类别统计覆盖率，给左栏显示"切出了什么"。 */
function summarizeClasses(classMap) {
  const counts = new Map();
  for (let i = 0; i < classMap.length; i += 1) {
    const internal = ATR_LOOKUP[classMap[i]] || 0;
    counts.set(internal, (counts.get(internal) || 0) + 1);
  }
  const total = classMap.length || 1;
  return semantics.classes.map((item) => ({
    id: item.id,
    key: item.key,
    label: item.label,
    color: item.color,
    repairSupport: item.repairSupport,
    coverage: Number(((counts.get(item.id) || 0) / total).toFixed(5)),
  }));
}

/** 调语义分区 worker。它只回原始 ATR 类别 id 图，映射与上色都在这边做。 */
async function requestSemanticParts(sourceBuffer, options = {}) {
  const serviceUrl = String(options.serviceUrl || '').trim().replace(/\/+$/, '');
  const serviceToken = String(options.serviceToken || '').trim();
  if (!serviceUrl) throw new Error('语义分区服务未配置');

  const form = new FormData();
  form.append('file', sourceBuffer, { filename: 'source.png', contentType: 'image/png' });

  const headers = { ...form.getHeaders() };
  if (serviceToken) headers.Authorization = `Bearer ${serviceToken}`;

  const response = await axios.post(`${serviceUrl}/v1/semantic-parts`, form, {
    headers,
    timeout: Number(options.timeoutMs || 180_000),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const data = response.data || {};
  const encoded = data.assets?.classMap?.data;
  if (!encoded) throw new Error('语义分区服务没有返回类别图');
  if (String(data.labelSet || '') !== SEMANTIC_LABEL_SET) {
    // 标签表变了意味着映射表全部失效。宁可直接失败，也不要按旧映射算出一张错的支持区。
    throw new Error(`语义分区标签表是 ${data.labelSet}，本地映射按 ${SEMANTIC_LABEL_SET} 写的`);
  }
  return {
    classMapPng: Buffer.from(encoded, 'base64'),
    width: Number(data.width || 0),
    height: Number(data.height || 0),
    modelId: String(data.modelId || ''),
    modelRevision: String(data.modelRevision || ''),
    labelSet: String(data.labelSet || ''),
    labelCount: Number(data.labelCount || 0),
    elapsedSec: Number(data.elapsedSec || 0),
  };
}

/**
 * 提示词编译。按设计文档 FEATURE_DESIGN.md 3.2 的功能合同写死，不给用户拆成参数 ——
 * 「改动强度」这类含义模糊的旋钮文档明确不要。
 *
 * 参考图顺序是有意义的：原图第一，模型对首图的权重最高；语义图和几何图排在后面，
 * 并在文字里说明它们只是区域与结构说明、不是配色参考，否则模型会把伪彩色当画面抄进去。
 */
function buildRepairPrompt(context = {}) {
  const targets = (semantics.repairTargets || []).join('、');
  const classLegend = semantics.classes
    .filter((item) => item.repairSupport)
    .map((item) => `${item.label}(${item.color})`)
    .join('、');

  const lines = [
    'Photorealistic detail restoration on the FIRST reference image. Do not redesign the person.',
    '',
    'Reference images, in order:',
    '  1. SOURCE — the only ground truth for identity, pose, framing, lighting and background.',
    '  2. SEMANTIC PARTS — a flat colour region map that only tells you which area is what'
      + ` (${classLegend}). It is NOT a colour, style or lighting reference. Never copy its colours.`,
    '  3. Z-DEPTH — structure only. Never copy its greyscale into the picture.',
    '  4. NORMAL — surface direction only. Never copy its false colours into the picture.',
    '',
    `Improve, at the same time: ${targets}.`,
    'Add believable micro texture: skin pores and fine tonal variation, separated hair strands with',
    'readable layering, real fabric weave, leather grain and metal micro-relief, crisp but natural',
    'eyes, nose, mouth, ears, teeth and fingers.',
    '',
    'Hard constraints — breaking any of these makes the result unusable:',
    '  - Keep the identity. Same face, same age, same ethnicity, same makeup, same expression.',
    '  - Keep facial feature positions and proportions. Do not rearrange, enlarge or beautify them.',
    '  - Keep the pose, head direction, camera angle, focal length and crop exactly as in the source.',
    '  - Keep the garment silhouette and the background structure. Do not replace or re-imagine them.',
    '  - Do not smooth skin into plastic or wax. Do not add a uniform template face.',
    '  - Do not add or remove fingers, limbs, teeth, jewellery or text.',
    '  - Do not change the global colour grade, white balance or lighting direction.',
    '  - Return one single complete image at the same aspect ratio as the source. Image output only.',
  ];

  if (context.extraInstruction) {
    lines.push('', 'Additional operator note (must not override the constraints above):', String(context.extraInstruction).trim());
  }
  return lines.join('\n');
}

/** 资产命名。带源图哈希 + 资产版本，天然可缓存复用；版本一变就自然不撞旧文件。 */
function assetName(sourceHash, key, ext = 'png') {
  return `texture-clarity-${String(sourceHash || '').slice(0, 16)}-v${TEXTURE_CLARITY_ASSET_VERSION}-${key}.${ext}`;
}

/**
 * 跑融合链。这里只负责把缓冲准备好、把共享字典的查表塞进去，算法在
 * TextureClarityFusion.js 里（有单测）。
 */
async function fuseCandidate(input) {
  const { sourceBuffer, candidateBuffer, classMapPng, width, height, options = {} } = input;
  const source = await decodeRgb(sourceBuffer, width, height);
  const candidate = await decodeRgb(candidateBuffer, width, height);
  const classMap = await decodeClassMap(classMapPng, width, height);

  const result = fusion.fuseTextureClarity({
    source,
    candidate,
    classMap,
    width,
    height,
    lookup: ATR_LOOKUP,
    supportFlags: SUPPORT_FLAGS,
    options,
  });

  return {
    ...result,
    png: await encodePng(result.output, width, height),
  };
}

module.exports = {
  ATR_LOOKUP,
  FUSION_POLICY,
  MAX_EDGE,
  SEMANTIC_LABEL_SET,
  SUPPORT_FLAGS,
  TEXTURE_CLARITY_ASSET_VERSION,
  assetName,
  buildRepairPrompt,
  buildSemanticVisualization,
  decodeClassMap,
  decodeRgb,
  encodePng,
  fuseCandidate,
  imageSize,
  normalizeSourceImage,
  normalizeTargetSize,
  requestSemanticParts,
  summarizeClasses,
};
