'use strict';

/**
 * 节点数据里的 `_assetImageVariants`：按原图地址记录服务端生成的派生图。
 *
 *   { [原图地址]: { previewUrl, viewerUrl?, width?, height? } }
 *
 * previewUrl 是画布节点显示的短边 360 WebP；viewerUrl 是全屏查看的短边 1080 WebP，
 * 原图短边不超过 1080 时没有这一项，查看器直接显示原图。width / height 是原图尺寸，
 * 节点和查看器里显示的“像素尺寸”、高清增强的输出尺寸都按它算，不按派生图算。
 */

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function cleanUrl(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** 从生成结果的 output（或上传返回的 meta）里取出派生图记录；没有 previewUrl 时返回 null。 */
function imageVariantsFromOutput(output) {
  if (!output || typeof output !== 'object') return null;
  const previewUrl = cleanUrl(output.previewUrl);
  if (!previewUrl) return null;
  const variants = { previewUrl };
  const viewerUrl = cleanUrl(output.viewerUrl);
  if (viewerUrl) variants.viewerUrl = viewerUrl;
  const width = positiveNumber(output.width);
  const height = positiveNumber(output.height);
  if (width && height) {
    variants.width = width;
    variants.height = height;
  }
  return variants;
}

/**
 * 把一批结果的派生图合并进节点已有的 `_assetImageVariants`。
 * 没有任何新记录时原样返回 current（可能是 undefined），避免给旧节点平白加字段。
 */
function mergeImageVariantsFromOutputs(current, urls, outputs) {
  const list = Array.isArray(urls) ? urls : [];
  const outputList = Array.isArray(outputs) ? outputs : [];
  let next = null;
  for (const [index, url] of list.entries()) {
    const key = cleanUrl(url);
    if (!key) continue;
    const output = outputList.find((item) => item && (item.url === key || item.index === index));
    const variants = imageVariantsFromOutput(output);
    if (!variants) continue;
    if (!next) next = { ...(current && typeof current === 'object' ? current : {}) };
    next[key] = variants;
  }
  return next || current;
}

module.exports = {
  imageVariantsFromOutput,
  mergeImageVariantsFromOutputs,
};
