const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');

const execFileAsync = promisify(execFile);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const KNOWN_GAME_IDS = { '\u706b\u70ac': 1, '\u5c0f\u9547': 2 };
const DEFAULT_GAME = '\u706b\u70ac';
const CATALOG_TTL_MS = 20000;
const HERO_ASSETS = [
  { code: 'c055_SelinaB', name: "人鱼2" },
  { code: 'c056_SelinaA', name: "人鱼1" },
  { code: 'c069_YoujiaA', name: "尤加1" },
  { code: 'c070_YoujiaB', name: "尤加3" },
  { code: 'c071_YuenvB', name: "月女3" },
  { code: 'c077_NanCiKe', name: "男刺客" },
];
// 英雄名字以 CGTeamWork「火炬之光_Film / 电影部_资产」的「局内代号」为准（m_asset.gamename），
// 由 tools/sync-cgtw-hero-names.py 同步成这个名单文件。文件改了不用重启：每次重建目录都会重新读。
// 名单读不到时退回上面这份写死的旧名字。
const HERO_NAMES_FILE = path.join(__dirname, '..', 'data', 'project-asset-heroes.json');
let heroNamesCache = null;

function heroDisplayName(gameName) {
  // 「英雄_时空见证者·尤加 Youga01」→「时空见证者·尤加 Youga01」；表里偶尔会把前缀填两遍
  return String(gameName || '').trim().replace(/^(?:英雄[_\s]*)+/, '').trim();
}

function currentHeroAssets() {
  try {
    const stat = fs.statSync(HERO_NAMES_FILE);
    if (heroNamesCache && heroNamesCache.mtimeMs === stat.mtimeMs) return heroNamesCache.heroes;
    const parsed = JSON.parse(fs.readFileSync(HERO_NAMES_FILE, 'utf8'));
    const heroes = (Array.isArray(parsed?.heroes) ? parsed.heroes : [])
      .map((item) => ({ code: String(item?.code || '').trim(), name: heroDisplayName(item?.gameName) }))
      .filter((item) => /^[A-Za-z0-9_]+$/.test(item.code) && item.name);
    if (!heroes.length) throw new Error('empty hero list');
    heroNamesCache = { mtimeMs: stat.mtimeMs, heroes };
    return heroes;
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('project asset hero names unavailable, using built-in list:', error.message);
    return HERO_ASSETS;
  }
}
const SHEET_ROWS = [
  { label: 'ss15\u8d5b\u5b63', projectCode: 'ss15_1', kind: 'Cha', name: '\u739b\u8482\u5c14\u8fbe', code: 'c073_Matilda', d2: 'X:\\projects2024\\TLI\\Asset\\Cha\\c073_Matilda\\Prodesign\\approved\\c073_Matilda.jpg', d3: 'X:\\projects2024\\TLI\\Asset\\Cha\\c073_Matilda\\LookDev\\work\\c073_Matilda_LookDev_003.png', atmosphere: 'X:\\projects2024\\TLI\\SS15_1\\00_Production_Guide\\04\u5f71\u521b\u7f8e\u672f\\\u6c1b\u56f4\u56fe' },
  { label: '', projectCode: '', kind: 'Cha', name: '\u827e\u5409\u5965', code: 'c074_Ezio', d2: 'X:\\projects2024\\TLI\\Asset\\Cha\\c074_Ezio\\Prodesign\\approved\\c074_Ezio.jpg', d3: 'X:\\projects2024\\TLI\\Asset\\Cha\\c074_Ezio\\LookDev\\work\\c074_Ezio_LookDev_006.png', atmosphere: '' },
  { label: '', projectCode: '', kind: 'Cha', name: '\u5723\u6bbf\u9a91\u58ebA', code: 'c075_QiShiA', d2: 'X:\\projects2024\\TLI\\Asset\\Cha\\c075_QiShiA\\Prodesign\\approved\\c075_QiShiA.jpg', d3: 'X:\\projects2024\\TLI\\Asset\\Cha\\c075_QiShiA\\LookDev\\work\\c075_QiShiA_LookDev_002.png', atmosphere: '' },
  { label: '', projectCode: '', kind: 'Cha', name: '\u5723\u6bbf\u9a91\u58ebB', code: 'c076_QiShiB', d2: 'X:\\projects2024\\TLI\\Asset\\Cha\\c076_QiShiB\\Prodesign\\approved\\c076_QiShiB.jpg', d3: 'X:\\projects2024\\TLI\\Asset\\Cha\\c076_QiShiB\\LookDev\\work\\c076_QiShiB_LookDev_002.png', atmosphere: '' },
  { label: '', projectCode: '', kind: 'Env', name: '\u6536\u85cf\u5927\u5385\u5185', code: 'e017_CollectionHallNei', d2: 'X:\\projects2024\\TLI\\Asset\\Env\\e017_CollectionHallNei\\Prodesign\\approved\\e017_CollectionHallNei.jpg', d3: 'X:\\projects2024\\TLI\\Asset\\Env\\e017_CollectionHallNei\\LookDev\\work\\e017_CollectionHallNei_LookDev_001.mov', atmosphere: '' },
  { label: '', projectCode: '', kind: 'Env', name: '\u6536\u85cf\u5927\u5385\u5916', code: 'e018_CollectionHallWai', d2: 'X:\\projects2024\\TLI\\Asset\\Env\\e018_CollectionHallWai\\Prodesign\\approved\\e018_CollectionHallWai.jpg', d3: 'X:\\projects2024\\TLI\\Asset\\Env\\e018_CollectionHallWai\\LookDev\\work\\e018_CollectionHallWai_LookDev_001.mov', atmosphere: '' },
  { label: 'ss15\u82f1\u96c4', projectCode: 'ss15_2', kind: 'Cha', name: '\u7537\u523a\u5ba2', code: 'c077_NanCiKe', d2: 'X:\\projects2024\\TLI\\Asset\\Cha\\c077_NanCiKe\\Prodesign\\approved\\c077_NanCiKe.jpg', d3: 'X:\\projects2024\\TLI\\Asset\\Cha\\c077_NanCiKe\\LookDev\\work\\c077_NanCiKe_LookDev_001.png', atmosphere: 'X:\\projects2024\\TLI\\SS15_2\\00_Production_Guide\\04\u5f71\u521b\u7f8e\u672f\\\u6c1b\u56f4\u56fe' },
  { label: '', projectCode: '', kind: 'Cha', name: '\u5f02\u9b54A', code: 'c078_YiMoA', d2: 'X:\\projects2024\\TLI\\Asset\\Cha\\c078_YiMoA\\Prodesign\\approved\\c078_YiMoB.jpg', d3: 'X:\\projects2024\\TLI\\Asset\\Cha\\c078_YiMoA\\LookDev\\work\\c078_YiMoA_LookDev_001.png', atmosphere: '' },
  { label: '', projectCode: '', kind: 'Cha', name: '\u5f02\u9b54B', code: 'c079_YiMoB', d2: 'X:\\projects2024\\TLI\\Asset\\Cha\\c079_YiMoB\\Prodesign\\approved\\c079_YiMoB.jpg', d3: '', atmosphere: '' },
  { label: '', projectCode: '', kind: 'Env', name: '\u9ed1\u9698\u53e3\u6218\u573a', code: 'e019_HeiAiKou', d2: 'X:\\projects2024\\TLI\\Asset\\Env\\e019_HeiAiKou\\Prodesign\\approved\\e019_HeiAiKou.jpg', d3: '', atmosphere: '' },
];
let catalogCache = null;

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function mapLocalProjectPath(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const normalized = value.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (match) return '/mnt/' + match[1].toLowerCase() + '/' + match[2];
  return normalized;
}

function gameIdFor(name) {
  if (KNOWN_GAME_IDS[name]) return KNOWN_GAME_IDS[name];
  let hash = 0;
  for (const char of String(name || '')) hash = (hash * 33 + char.codePointAt(0)) >>> 0;
  return 1000 + (hash % 8000);
}

function classifyLabel(value) {
  const text = String(value || '').trim();
  if (!text) return 'empty';
  if (Object.prototype.hasOwnProperty.call(KNOWN_GAME_IDS, text)) return 'game';
  if (/\u8d5b\u5b63|\u82f1\u96c4|pv/i.test(text) || /^ss\d/i.test(text)) return 'project';
  return 'game';
}

function mediaTypeOf(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return '';
}

function tokenFor(filePath) {
  return 'a' + crypto.createHash('sha1').update(String(filePath)).digest('hex').slice(0, 20);
}

function existingPath(raw, expectDirectory) {
  const mapped = mapLocalProjectPath(raw);
  if (!mapped) return null;
  try {
    const resolved = fs.realpathSync(mapped);
    const stat = fs.statSync(resolved);
    if (expectDirectory ? !stat.isDirectory() : !stat.isFile()) return null;
    return { filePath: resolved, stat };
  } catch {
    return null;
  }
}

function listAtmosphereFiles(dirPath, projectLabel) {
  const label = String(projectLabel || '').trim();
  const root = existingPath(dirPath, true);
  if (!root || !label) return [];
  const found = [];
  const walk = (current, depth) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('.') || entry.name.toLowerCase() === 'thumbs.db') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || mediaTypeOf(entry.name) !== 'image') continue;
      const file = existingPath(full, false);
      if (!file) continue;
      found.push({
        baseName: path.parse(entry.name).name,
        mediaType: 'image',
        filePath: file.filePath,
        mtimeMs: Number(file.stat.mtimeMs) || 0,
      });
    }
  };
  walk(root.filePath, 0);
  if (!found.length) return [];
  const cover = found.find((item) => item.baseName === '氛围图') || found[0];
  return [{
    name: label + '_氛围图',
    projectLabel: label,
    stage: 'atmosphere',
    assetType: '',
    mediaType: cover.mediaType,
    filePath: cover.filePath,
    mtimeMs: cover.mtimeMs,
  }];
}

function disambiguate(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  return items.map((item) => {
    if ((counts.get(item.name) || 0) < 2 || !item.projectLabel) return item;
    return { ...item, name: item.name + ' \u00b7 ' + item.projectLabel };
  });
}
function buildCatalog() {
  const heroes = currentHeroAssets();
  const heroByCode = new Map(heroes.map((item) => [item.code, item.name]));
  let game = DEFAULT_GAME;
  let projectLabel = '';
  const pending = [];
  const atmospheres = [];
  const seenAtmosphere = new Set();
  for (const row of SHEET_ROWS) {
    const kind = classifyLabel(row.label);
    if (kind === 'game') game = String(row.label).trim();
    else if (kind === 'project') projectLabel = String(row.label).trim();
    if (row.kind === 'Cha' || row.kind === 'Env') {
      const assetType = row.kind === 'Cha' ? 'character' : 'scene';
      const baseName = String(row.name || row.code || '\u672a\u547d\u540d').trim();
      for (const [stage, rawPath, suffix] of [['2d', row.d2, '2D'], ['3d', row.d3, '3D']]) {
        if (!rawPath) continue;
        const file = existingPath(rawPath, false);
        if (!file || !mediaTypeOf(file.filePath)) continue;
        pending.push({
          game,
          projectLabel,
          code: String(row.code || ''),
          hero: heroByCode.has(String(row.code || '')),
          name: ((heroByCode.get(String(row.code || '')) || baseName) + '_' + suffix),
          stage,
          assetType,
          mediaType: mediaTypeOf(file.filePath),
          filePath: file.filePath,
          mtimeMs: Number(file.stat.mtimeMs) || 0,
        });
      }
    }
    if (row.atmosphere) {
      const key = game + '\0' + row.atmosphere;
      if (seenAtmosphere.has(key)) continue;
      seenAtmosphere.add(key);
      for (const file of listAtmosphereFiles(row.atmosphere, projectLabel)) atmospheres.push({ ...file, game });
    }
  }
function heroAssetDir(code) {
  return 'X:\\projects2024\\TLI\\Asset\\Cha\\' + code;
}

function listHeroMedia(dirPath) {
  const root = existingPath(dirPath, true);
  if (!root) return [];
  let entries;
  try { entries = fs.readdirSync(root.filePath, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && mediaTypeOf(entry.name) && entry.name.toLowerCase() !== 'thumbs.db')
    .map((entry) => {
      const file = existingPath(path.join(root.filePath, entry.name), false);
      if (!file) return null;
      const version = Number((entry.name.match(/_(\\d+)\./) || [])[1] || 0);
      return { file, version, name: entry.name };
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version || a.name.localeCompare(b.name, 'en'));
}

function addMissingHeroAssets(pending, heroes = currentHeroAssets()) {
  const heroCodes = new Set(heroes.map((item) => item.code));
  const present = new Set(pending.filter((item) => item.code && heroCodes.has(item.code)).map((item) => item.code));
  for (const hero of heroes) {
    if (present.has(hero.code)) continue;
    const base = heroAssetDir(hero.code);
    const approved = listHeroMedia(base + '\\Prodesign\\approved').filter((item) => mediaTypeOf(item.name) === 'image');
    const lookdev = listHeroMedia(base + '\\LookDev\\work');
    const picks = [['2d', approved[0], '2D'], ['3d', lookdev.length ? lookdev[lookdev.length - 1] : null, '3D']];
    for (const [stage, picked, suffix] of picks) {
      if (!picked) continue;
      pending.push({
        game: DEFAULT_GAME,
        projectLabel: '',
        code: hero.code,
        name: hero.name + '_' + suffix,
        stage,
        assetType: 'character',
        hero: true,
        mediaType: mediaTypeOf(picked.file.filePath),
        filePath: picked.file.filePath,
        mtimeMs: Number(picked.file.stat.mtimeMs) || 0,
      });
    }
  }
}
addMissingHeroAssets(pending, heroes);
  const byGame = new Map();
  for (const item of pending.concat(atmospheres)) {
    if (!byGame.has(item.game)) byGame.set(item.game, []);
    byGame.get(item.game).push(item);
  }
  const games = [...byGame.entries()].map(([name, items]) => {
    const assets = disambiguate(items).map((item) => ({
      name: item.name,
      relativePath: tokenFor(item.filePath),
      mediaType: item.mediaType,
      stage: item.stage,
      assetType: item.assetType,
      hero: Boolean(item.hero),
      mtimeMs: item.mtimeMs,
      filePath: item.filePath,
    }));
    return { id: gameIdFor(name), name, assets };
  }).filter((item) => item.assets.length > 0).sort((a, b) => a.id - b.id || a.name.localeCompare(b.name, 'zh-CN'));
  const byToken = new Map();
  for (const item of games) {
    for (const asset of item.assets) byToken.set(item.id + ':' + asset.relativePath, asset);
  }
  return { games, byToken, at: Date.now() };
}

function getCatalog() {
  if (!catalogCache || Date.now() - catalogCache.at > CATALOG_TTL_MS) catalogCache = buildCatalog();
  return catalogCache;
}

function gamesForCatalog(catalog) {
  const games = catalog.games.slice();
  for (const [name, id] of Object.entries(KNOWN_GAME_IDS)) {
    if (!games.some((game) => game.id === id)) games.push({ id, name, assets: [] });
  }
  games.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name, 'zh-CN'));
  return games;
}

async function listProjectsWithPaths() {
  return gamesForCatalog(getCatalog()).map((game) => ({ id: game.id, name: game.name, available: true }));
}

async function listProjectModules(projectId) {
  const id = Number(projectId);
  const game = gamesForCatalog(getCatalog()).find((item) => item.id === id);
  if (!game) throw httpError(404, '\u6ca1\u6709\u8fd9\u4e2a\u6e38\u620f');
  return {
    project: { id: game.id, name: game.name },
    stages: [
      { id: 'all', label: '\u5168\u90e8' },
      { id: '2d', label: '2D\u7f8e\u672f' },
      { id: '3d', label: '3D\u7f8e\u672f' },
      { id: 'atmosphere', label: '\u6c1b\u56f4\u56fe' },
    ],
    assetTypes: [
      { id: 'all', label: '\u5168\u90e8' },
      { id: 'character', label: '\u89d2\u8272' },
      { id: 'scene', label: '\u573a\u666f' },
      { id: 'hero', label: "英雄" },
    ],
    assets: game.assets.map(({ filePath, ...asset }) => asset),
    modules: [],
  };
}

const THUMB_WIDTHS = new Set([240, 360, 480, 960]);
const thumbInFlight = new Map();
let sharpModule = null;
let sharpChecked = false;

function getSharp() {
  if (sharpChecked) return sharpModule;
  sharpChecked = true;
  try { sharpModule = require('sharp'); } catch (error) {
    console.warn('sharp is unavailable; project asset thumbs are disabled:', error.message);
    sharpModule = null;
  }
  return sharpModule;
}

function normalizeThumbWidth(value) {
  const width = Number(value);
  return THUMB_WIDTHS.has(width) ? width : 0;
}

function projectAssetThumbsDir() {
  return path.join(path.dirname(config.projectsDir), 'project-asset-thumbs');
}

function thumbFilePath(projectId, relativePath, width) {
  const hash = crypto.createHash('sha1').update(String(projectId) + '\0' + relativePath).digest('hex');
  return path.join(projectAssetThumbsDir(), String(projectId), hash + '-w' + width + '.webp');
}

function freshThumb(outPath, sourceFile) {
  try {
    if (!fs.existsSync(outPath)) return null;
    const srcStat = fs.statSync(sourceFile.filePath);
    const outStat = fs.statSync(outPath);
    if (outStat.size > 0 && outStat.mtimeMs >= srcStat.mtimeMs) {
      return { filePath: outPath, fileName: path.basename(outPath), mimeType: 'image/webp', cacheControl: 'private, max-age=86400' };
    }
  } catch { /* regenerate */ }
  return null;
}

async function ensureProjectAssetThumb(sourceFile, projectId, relativePath, width) {
  const outPath = thumbFilePath(projectId, relativePath, width);
  const cached = freshThumb(outPath, sourceFile);
  if (cached) return cached;
  const sharp = getSharp();
  if (!sharp) return null;
  const key = String(projectId) + ':' + relativePath + ':' + width;
  const pending = thumbInFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmpPath = outPath + '.tmp-' + process.pid + '-' + Date.now();
    try {
      await sharp(sourceFile.filePath, { failOn: 'none' }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 72 }).toFile(tmpPath);
      fs.renameSync(tmpPath, outPath);
      return { filePath: outPath, fileName: path.basename(outPath), mimeType: 'image/webp', cacheControl: 'private, max-age=86400' };
    } catch (error) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  })();
  thumbInFlight.set(key, work);
  try { return await work; } finally { thumbInFlight.delete(key); }
}

async function ensureVideoPoster(sourceFile, projectId, relativePath, width) {
  const outPath = thumbFilePath(projectId, relativePath, width);
  const cached = freshThumb(outPath, sourceFile);
  if (cached) return cached;
  const sharp = getSharp();
  if (!sharp) return null;
  const key = 'video:' + String(projectId) + ':' + relativePath + ':' + width;
  const pending = thumbInFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const framePath = outPath + '.frame-' + process.pid + '-' + Date.now() + '.jpg';
    const tmpPath = outPath + '.tmp-' + process.pid + '-' + Date.now();
    try {
      await execFileAsync('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-ss', '0', '-i', sourceFile.filePath, '-frames:v', '1', '-vf', 'scale=' + width + ':-2', framePath], { timeout: 60000 });
      await sharp(framePath, { failOn: 'none' }).webp({ quality: 72 }).toFile(tmpPath);
      fs.renameSync(tmpPath, outPath);
      return { filePath: outPath, fileName: path.basename(outPath), mimeType: 'image/webp', cacheControl: 'private, max-age=86400' };
    } catch (error) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      throw error;
    } finally {
      try { fs.rmSync(framePath, { force: true }); } catch { /* ignore */ }
    }
  })();
  thumbInFlight.set(key, work);
  try { return await work; } finally { thumbInFlight.delete(key); }
}

function mimeFromName(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

async function readProjectAssetFile(projectId, relativePath, width) {
  const id = Number(projectId);
  const token = String(relativePath || '').trim();
  if (!/^a[a-f0-9]{20}$/.test(token)) throw httpError(400, '\u65e0\u6548\u8d44\u6e90\u8def\u5f84');
  const asset = getCatalog().byToken.get(id + ':' + token);
  if (!asset || !fs.existsSync(asset.filePath)) throw httpError(404, '\u56fe\u7247\u4e0d\u5b58\u5728');
  const original = {
    filePath: asset.filePath,
    fileName: path.basename(asset.filePath),
    mimeType: mimeFromName(asset.filePath),
    cacheControl: 'private, max-age=60',
  };
  const thumbWidth = normalizeThumbWidth(width);
  if (!thumbWidth) return original;
  try {
    const thumb = asset.mediaType === 'video'
      ? await ensureVideoPoster(original, id, token, thumbWidth)
      : await ensureProjectAssetThumb(original, id, token, thumbWidth);
    if (thumb) return thumb;
  } catch (error) {
    console.warn('project asset thumb failed:', error && error.message ? error.message : error);
  }
  if (asset.mediaType === 'video') throw httpError(404, '\u89c6\u9891\u5c01\u9762\u751f\u6210\u5931\u8d25');
  return original;
}

module.exports = {
  currentHeroAssets,
  heroDisplayName,
  listProjectsWithPaths,
  listProjectModules,
  readProjectAssetFile,
};