#!/usr/bin/env node
/**
 * 给现有画布里的图片补生成 360 / 1080 派生图（第一步：只生成文件，不改任何画布数据）。
 *
 * 生成规则、文件名、画质参数与 server/canvasRoutes.js 的 createImageVariants 完全一致：
 *   <原图名>_360.webp   短边 360，quality 80
 *   <原图名>_1080.webp  短边 1080，quality 86，只在原图短边大于 1080 时生成
 * 已存在的文件不重写。进度写在 tmp/image-variant-backfill/done.jsonl，中断后重跑会跳过已完成的。
 * 第二步（把结果写进节点 _assetImageVariants）读同一个 done.jsonl。
 *
 * 用法（在服务器工程根目录，用服务的身份跑、低优先级）：
 *   runuser -u tapflow -- nice -n 19 ionice -c3 node tools/image-variant-backfill.js
 *
 * 故意不 require canvasRoutes：那个模块加载时会顺带跑官方模板画布补齐，长时间脚本不该带副作用。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const config = require(path.join(ROOT, 'server/config'));
const { getAdminPool, closePools } = require(path.join(ROOT, 'server/db'));
const objectStore = require(path.join(ROOT, 'server/objectStore'));
const sharp = require(path.join(ROOT, 'node_modules/sharp'));

const PREVIEW_SHORT_EDGE = 360;
const VIEWER_SHORT_EDGE = 1080;
const SOURCE_EXT_RE = /\.(png|jpe?g|webp|bmp|tiff?|avif)$/i;
const VARIANT_NAME_RE = /_(?:360|1080)\.webp$/i;
const OUT_DIR = path.join(ROOT, 'tmp', 'image-variant-backfill');
const DONE_FILE = path.join(OUT_DIR, 'done.jsonl');
const SUMMARY_FILE = path.join(OUT_DIR, 'summary.json');

sharp.cache(false);
sharp.concurrency(1);

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function assetsDir(canvasId) {
  return path.join(config.projectsDir, String(canvasId), 'assets');
}

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function collectImageFiles() {
  const db = getAdminPool();
  const [ids] = await db.query('SELECT id FROM canvases ORDER BY id');
  const files = new Map();
  for (const { id } of ids) {
    const [rows] = await db.query('SELECT data FROM canvases WHERE id = ?', [id]);
    const data = parseJson(rows[0]?.data);
    const nodes = Array.isArray(data?.nodeList) ? data.nodeList : [];
    for (const node of nodes) {
      const nodeData = parseJson(node?.data);
      if (!nodeData || (nodeData.type !== 'image' && nodeData.type !== 'upload')) continue;
      for (const url of Array.isArray(nodeData.url) ? nodeData.url : []) {
        const match = String(url).match(/^\/assets\/([^/?#]+)\/([^/?#]+)$/);
        if (!match || !SOURCE_EXT_RE.test(match[2]) || VARIANT_NAME_RE.test(match[2])) continue;
        const key = `${match[1]}/${match[2]}`;
        if (!files.has(key)) files.set(key, { canvasId: match[1], storedName: decodeURIComponent(match[2]) });
      }
    }
  }
  return { canvasCount: ids.length, files: [...files.entries()] };
}

async function writeShortEdgeWebp(sourcePath, outputPath, shortEdge, landscape, quality) {
  const tmpOutput = `${outputPath}.backfill-${process.pid}.tmp`;
  try {
    await sharp(sourcePath, { failOn: 'none' })
      .rotate()
      .resize(landscape ? { height: shortEdge, withoutEnlargement: true } : { width: shortEdge, withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toFile(tmpOutput);
    fs.renameSync(tmpOutput, outputPath);
  } finally {
    fs.rmSync(tmpOutput, { force: true });
  }
}

async function mirror(canvasId, storedName, localPath) {
  if (!objectStore.isRemoteEnabled) return;
  await objectStore.uploadLocalFile(canvasId, storedName, localPath, 'image/webp');
}

async function createVariants(canvasId, storedName) {
  const sourcePath = path.join(assetsDir(canvasId), storedName);
  if (!fs.existsSync(sourcePath)) return { skipped: 'missing-local' };
  const metadata = await sharp(sourcePath, { failOn: 'none' }).metadata();
  if (Number(metadata.pages || 1) > 1) return { skipped: 'animated' };
  const rotated = Number(metadata.orientation) >= 5;
  const width = Number(rotated ? metadata.height : metadata.width) || 0;
  const height = Number(rotated ? metadata.width : metadata.height) || 0;
  if (!width || !height) return { skipped: 'no-size' };
  const landscape = width >= height;
  const base = path.parse(storedName).name;
  const variants = { width, height };
  const created = [];

  const previewName = `${base}_${PREVIEW_SHORT_EDGE}.webp`;
  const previewPath = path.join(assetsDir(canvasId), previewName);
  if (!fs.existsSync(previewPath)) {
    await writeShortEdgeWebp(sourcePath, previewPath, PREVIEW_SHORT_EDGE, landscape, 80);
    await mirror(canvasId, previewName, previewPath);
    created.push(previewName);
  }
  variants.previewUrl = `/assets/${canvasId}/${previewName}`;

  if (Math.min(width, height) > VIEWER_SHORT_EDGE) {
    const viewerName = `${base}_${VIEWER_SHORT_EDGE}.webp`;
    const viewerPath = path.join(assetsDir(canvasId), viewerName);
    if (!fs.existsSync(viewerPath)) {
      await writeShortEdgeWebp(sourcePath, viewerPath, VIEWER_SHORT_EDGE, landscape, 86);
      await mirror(canvasId, viewerName, viewerPath);
      created.push(viewerName);
    }
    variants.viewerUrl = `/assets/${canvasId}/${viewerName}`;
  }
  const bytes = created.reduce((sum, name) => sum + fs.statSync(path.join(assetsDir(canvasId), name)).size, 0);
  return { variants, created: created.length, bytes };
}

function loadDone() {
  const done = new Set();
  if (!fs.existsSync(DONE_FILE)) return done;
  for (const line of fs.readFileSync(DONE_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).key); } catch { /* 半行，忽略 */ }
  }
  return done;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const startedAt = Date.now();
  log('collecting image files from canvases…');
  const { canvasCount, files } = await collectImageFiles();
  const done = loadDone();
  // BACKFILL_LIMIT=20 先试跑几张
  const limit = Number(process.env.BACKFILL_LIMIT || 0);
  const pending = files.filter(([key]) => !done.has(key));
  const todo = limit > 0 ? pending.slice(0, limit) : pending;
  log(`canvases=${canvasCount} files=${files.length} alreadyDone=${done.size} todo=${todo.length} objectStore=${objectStore.isRemoteEnabled ? 'on' : 'off'}`);

  const counts = { ok: 0, skipped: 0, failed: 0, createdFiles: 0, bytes: 0 };
  const skippedReasons = {};
  const out = fs.openSync(DONE_FILE, 'a');
  for (const [index, [key, file]] of todo.entries()) {
    let record;
    try {
      const result = await createVariants(file.canvasId, file.storedName);
      if (result.skipped) {
        counts.skipped += 1;
        skippedReasons[result.skipped] = (skippedReasons[result.skipped] || 0) + 1;
        record = { key, skipped: result.skipped };
      } else {
        counts.ok += 1;
        counts.createdFiles += result.created;
        counts.bytes += result.bytes;
        record = { key, url: `/assets/${key}`, variants: result.variants };
      }
    } catch (error) {
      counts.failed += 1;
      record = { key, error: String(error?.message || error).slice(0, 300) };
    }
    fs.writeSync(out, `${JSON.stringify(record)}\n`);
    if ((index + 1) % 200 === 0) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = (index + 1) / elapsed;
      log(`progress ${index + 1}/${todo.length} ok=${counts.ok} skipped=${counts.skipped} failed=${counts.failed} written=${(counts.bytes / 1048576).toFixed(0)}MB eta=${Math.round((todo.length - index - 1) / rate / 60)}min`);
    }
    // 给线上服务让出 CPU
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fs.closeSync(out);
  const summary = {
    finishedAt: new Date().toISOString(),
    minutes: Math.round((Date.now() - startedAt) / 60000),
    canvasCount,
    files: files.length,
    previouslyDone: done.size,
    ...counts,
    writtenMB: Math.round(counts.bytes / 1048576),
    skippedReasons,
  };
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  log(`DONE ${JSON.stringify(summary)}`);
}

main()
  .catch((error) => {
    log(`FATAL ${error?.stack || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await closePools?.(); } catch { /* ignore */ }
    process.exit(process.exitCode || 0);
  });
