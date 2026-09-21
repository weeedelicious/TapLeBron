const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'official-template-library.json');
const CATEGORY_ORDER = ['image', 'video', '3d'];
const CATEGORIES = new Set(CATEGORY_ORDER);
let writeQueue = Promise.resolve();

function text(value, maxLength = 200) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeNodes(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).map((node) => ({
    type: text(node?.type, 40) || 'image',
    label: text(node?.label, 60) || '节点',
  }));
}

function normalizeCategories(value) {
  const candidates = Array.isArray(value?.categories)
    ? value.categories.map((category) => text(category, 20))
    : [text(value?.category, 20)];
  if (!candidates.length || candidates.some((category) => !CATEGORIES.has(category))) {
    const error = new Error('分类至少选择一项，且只能是 image、video 或 3d');
    error.status = 400;
    throw error;
  }
  const selected = new Set(candidates);
  return CATEGORY_ORDER.filter((category) => selected.has(category));
}

function normalizeTemplate(value, previous = null) {
  const categories = normalizeCategories(value);
  const category = categories[0];
  const title = text(value?.title, 80);
  if (!title) {
    const error = new Error('标题不能为空');
    error.status = 400;
    throw error;
  }
  const canvasId = text(value?.canvasId, 64);
  if (canvasId && !/^[A-Za-z0-9_-]+$/.test(canvasId)) {
    const error = new Error('关联画布 ID 无效');
    error.status = 400;
    throw error;
  }
  const now = Date.now();
  return {
    id: previous?.id || text(value?.id, 80) || crypto.randomUUID(),
    category,
    categories,
    title,
    subtitle: text(value?.subtitle, 260),
    thumbnailUrl: text(value?.thumbnailUrl, 2048),
    method: text(value?.method, 120),
    canvasId,
    tone: /^#[0-9a-f]{6}$/i.test(text(value?.tone, 7))
      ? text(value.tone, 7)
      : previous?.tone || '#718d9d',
    nodes: normalizeNodes(value?.nodes?.length ? value.nodes : previous?.nodes),
    createdAtMs: Number(previous?.createdAtMs || now),
    updatedAtMs: Number(value?.updatedAtMs || previous?.updatedAtMs || now),
  };
}

async function readTemplates() {
  const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('官方模板 JSON 必须是数组');
  return parsed.map((item) => normalizeTemplate(item, item));
}

function writeTemplates(items) {
  writeQueue = writeQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.promises.writeFile(DATA_FILE, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  });
  return writeQueue;
}

async function listTemplates() {
  return readTemplates();
}

async function findTemplate(id) {
  const items = await readTemplates();
  return items.find((item) => item.id === String(id)) || null;
}

async function createTemplate(input) {
  const items = await readTemplates();
  const created = normalizeTemplate(input);
  if (items.some((item) => item.id === created.id)) created.id = crypto.randomUUID();
  items.push(created);
  await writeTemplates(items);
  return created;
}

async function updateTemplate(id, input) {
  const items = await readTemplates();
  const index = items.findIndex((item) => item.id === String(id));
  if (index < 0) return null;
  const merged = { ...items[index], ...input, updatedAtMs: Date.now() };
  // Keep compatibility with older clients that still submit one `category`.
  // Without this, an existing `categories` array would mask their update.
  if (!Object.prototype.hasOwnProperty.call(input || {}, 'categories')
    && Object.prototype.hasOwnProperty.call(input || {}, 'category')) {
    merged.categories = [input.category];
  }
  items[index] = normalizeTemplate(merged, items[index]);
  await writeTemplates(items);
  return items[index];
}

async function replaceTemplates(input) {
  const items = (Array.isArray(input) ? input : []).map((item) => normalizeTemplate(item, item));
  await writeTemplates(items);
  return items;
}

module.exports = {
  DATA_FILE,
  normalizeTemplate,
  listTemplates,
  findTemplate,
  createTemplate,
  updateTemplate,
  replaceTemplates,
};
