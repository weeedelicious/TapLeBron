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
// CGTW 资产标签（m_asset.gamename：火炬里叫「英雄」，RO 里叫「职业」），由服务器上的 tools/cgtw_server_sync.py
// 每 15 分钟同步到这个文件。有这个文件时，「英雄」/「职业」筛选只看 CGTW 标签：有值的才算；
// 文件读不到时退回旧逻辑（英雄名单文件 + 表里的局内代号）。文件改了不用重启。
const CGTW_TAGS_FILE = path.join(__dirname, '..', 'data', 'project-asset-cgtw-tags.json');
let cgtwTagsCache = null;

function currentCgtwTags() {
  try {
    const stat = fs.statSync(CGTW_TAGS_FILE);
    if (cgtwTagsCache && cgtwTagsCache.mtimeMs === stat.mtimeMs) return cgtwTagsCache.games;
    const parsed = JSON.parse(fs.readFileSync(CGTW_TAGS_FILE, 'utf8'));
    const games = {};
    for (const [game, info] of Object.entries(parsed?.games || {})) {
      const tags = new Map();
      for (const [code, value] of Object.entries(info?.tags || {})) {
        const text = String(value || '').trim();
        if (code && text) tags.set(String(code).trim().toLowerCase(), { code: String(code).trim(), value: text });
      }
      games[game] = { label: String(info?.label || '').trim(), tags };
    }
    cgtwTagsCache = { mtimeMs: stat.mtimeMs, games };
    return games;
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('project asset CGTW tags unavailable:', error.message);
    return cgtwTagsCache?.games || {};
  }
}

// 资产清单以各游戏的飞书「shotflow资产库」表为准（project-asset-sheet.json 的 sources，一个游戏一份），每行一个角色 / 场景：
//  - 2D美术：CGTW 资产任务 Prodesign 环节 approved 框（不取 history）
//  - 游戏美术：CGTW 资产任务 Predesign 环节 approved 框（不取 history）
//  - 3D美术：过往项目直接用表里的 LookDev 路径；进行中项目（liveProjects）取 LookDev 环节 work 框最大版本号
//  - 氛围图：项目「影创美术/氛围图」文件夹
// 表里写的文件不在了，就按同一规则到对应框里现找。文件改了不用重启：每次重建目录都会按 mtime 重读。
const SHEET_FILE = path.join(__dirname, 'project-asset-sheet.json');
// sources[].rowsFile：这一份清单由本机定时任务从 CGTW 同步（tools/sync_cgtw_hero_names.py 一起跑），
// 写在 server/data 下；文件在就用文件里的行（CGTW 多删少补），不在就用 sheet 里写死的 rows 兜底。
const SHEET_DATA_DIR = path.join(__dirname, '..', 'data');
let sheetCache = null;

function rowsFileMtime(name) {
  try { return fs.statSync(path.join(SHEET_DATA_DIR, path.basename(String(name)))).mtimeMs; } catch { return 0; }
}

function syncedRows(source) {
  if (!source?.rowsFile) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(SHEET_DATA_DIR, path.basename(String(source.rowsFile))), 'utf8'));
    return Array.isArray(parsed?.rows) && parsed.rows.length ? parsed.rows : null;
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('project asset rows file unavailable:', source.rowsFile, error.message);
    return null;
  }
}

function currentSheet() {
  try {
    const stat = fs.statSync(SHEET_FILE);
    const raw = fs.readFileSync(SHEET_FILE, 'utf8');
    const peek = JSON.parse(raw);
    const stamp = [stat.mtimeMs, ...(Array.isArray(peek?.sources) ? peek.sources : []).map((source) => (source?.rowsFile ? rowsFileMtime(source.rowsFile) : 0))].join(':');
    if (sheetCache && sheetCache.stamp === stamp) return sheetCache.sheet;
    const parsed = peek;
    // 每行带上所属游戏和该游戏的进行中项目，后面按行处理即可。
    // heroLabel：「英雄」筛选按钮在这个游戏叫什么（心动小镇叫 NPC）；heroCodes：表里没有局内代号时，按代号标记归到这个筛选的资产
    const rows = [];
    const games = {};
    for (const source of Array.isArray(parsed?.sources) ? parsed.sources : []) {
      const game = String(source?.game || '').trim() || DEFAULT_GAME;
      const liveProjects = (Array.isArray(source?.liveProjects) ? source.liveProjects : []).map((item) => String(item).toLowerCase());
      const heroCodes = new Set((Array.isArray(source?.heroCodes) ? source.heroCodes : []).map((item) => String(item).trim().toLowerCase()));
      games[game] = { heroLabel: String(source?.heroLabel || '').trim(), heroCodes };
      const sourceRows = syncedRows(source) || (Array.isArray(source?.rows) ? source.rows : []);
      for (const row of sourceRows) rows.push({ ...row, game, liveProjects, heroCodes });
    }
    const sheet = { rows, games };
    sheetCache = { stamp, sheet };
    return sheet;
  } catch (error) {
    console.warn('project asset sheet unavailable:', error.message);
    return sheetCache?.sheet || { rows: [], games: {} };
  }
}
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
        // History 里是换下来的旧版氛围图，跟其他环节「不取 history」一样不进资产库
        if (entry.name.toLowerCase() === 'history') continue;
        if (depth < 2) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !mediaTypeOf(entry.name)) continue;
      const file = existingPath(full, false);
      if (!file) continue;
      found.push({
        baseName: path.parse(entry.name).name,
        mediaType: mediaTypeOf(entry.name),
        filePath: file.filePath,
        mtimeMs: Number(file.stat.mtimeMs) || 0,
      });
    }
  };
  walk(root.filePath, 0);
  // 氛围图指认逻辑：项目「影创美术/氛围图」文件夹里有什么拾取什么（图片和视频都要，含子文件夹，History 除外），不再只挑一张封面
  return found.map((item) => ({
    name: item.baseName === '氛围图' ? label + '_氛围图' : label + '_氛围图_' + item.baseName,
    projectLabel: label,
    stage: 'atmosphere',
    assetType: '',
    mediaType: item.mediaType,
    filePath: item.filePath,
    mtimeMs: item.mtimeMs,
  }));
}

function disambiguate(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  return items.map((item) => {
    if ((counts.get(item.name) || 0) < 2 || !item.projectLabel) return item;
    return { ...item, name: item.name + ' \u00b7 ' + item.projectLabel };
  });
}
function assetBaseDir(kind, code) {
  return 'X:\\projects2024\\TLI\\Asset\\' + kind + '\\' + code;
}

// 「c073_Matilda_LookDev_003.png」「c009_Bin2_LookDev_v02（全身）.mp4」「..._LookDev_v003(2).mp4」→ 版本号；没有版本号算 0
function versionOf(fileName) {
  const match = String(fileName || '').match(/_v?(\d+)[^_\d]*\.[a-z0-9]+$/i);
  return match ? Number(match[1]) : 0;
}

// CGTW 文件框（approved / work）里的媒体文件，按版本号、修改时间从旧到新；history 等子文件夹不进
function listBoxMedia(dirPath) {
  const root = existingPath(dirPath, true);
  if (!root) return [];
  let entries;
  try { entries = fs.readdirSync(root.filePath, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isFile() && mediaTypeOf(entry.name) && entry.name.toLowerCase() !== 'thumbs.db')
    .map((entry) => {
      const file = existingPath(path.join(root.filePath, entry.name), false);
      if (!file) return null;
      return { file, version: versionOf(entry.name), name: entry.name };
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version || a.file.stat.mtimeMs - b.file.stat.mtimeMs || a.name.localeCompare(b.name, 'en'));
}

function latestInBox(dirPath) {
  const items = listBoxMedia(dirPath);
  return items.length ? items[items.length - 1].file : null;
}

// 资产文件夹（…\Asset\Cha\c013_Erica3）：优先从表里的路径取（文件夹名偶尔和代号不一样，如「c086_female cat」），
// 表里没写路径的才按代号拼
const ASSET_DIR_RE = /^(.*?\\Asset\\(?:Cha|Env|Props)\\[^\\]+)\\/i;
function assetDirOf(row) {
  // 清单直接给了资产文件夹（RO 这类没有飞书表、按 CGTW 资产列表生成的清单）就用它
  if (row.assetDir) return String(row.assetDir);
  for (const raw of [row.d2, row.d3]) {
    const match = String(raw || '').trim().replace(/^"+/, '').match(ASSET_DIR_RE);
    if (match) return match[1];
  }
  return assetBaseDir(row.kind, row.code);
}

// 表里「角色/场景」偶尔漏填，按路径里的 Asset\Cha / Asset\Env 判断
function rowKind(row) {
  if (row.kind === 'Cha' || row.kind === 'Env' || row.kind === 'Prop') return row.kind;
  const match = String(row.d2 || row.d3 || row.assetDir || '').match(/\\Asset\\(Cha|Env|Prop)\\/i);
  if (!match) return '';
  const kind = match[1].toLowerCase();
  return kind === 'env' ? 'Env' : kind === 'prop' ? 'Prop' : 'Cha';
}

function sheetFile(rawPath) {
  const file = existingPath(String(rawPath || '').trim().replace(/^"+|"+$/g, ''), false);
  return file && mediaTypeOf(file.filePath) ? file : null;
}

// 2D美术：表里的路径；不在了就到 Prodesign/approved 框里找和资产代号同名的图，再不行取第一张图
function pick2dFile(row) {
  const fromSheet = sheetFile(row.d2);
  if (fromSheet) return fromSheet;
  const code = String(row.code || '').trim().toLowerCase();
  const images = listBoxMedia(assetDirOf(row) +'\\Prodesign\\approved')
    .filter((item) => mediaTypeOf(item.name) === 'image');
  const named = images.find((item) => path.parse(item.name).name.toLowerCase() === code);
  return (named || images[0])?.file || null;
}

// 3D美术：进行中项目取 LookDev/work 最大版本号；过往项目用表里的路径，不在了再取 LookDev/approved、work 的最新一份
function pick3dFile(row, live) {
  const base = assetDirOf(row) +'\\LookDev';
  if (live) return latestInBox(base + '\\work') || sheetFile(row.d3);
  return sheetFile(row.d3) || latestInBox(base + '\\approved') || latestInBox(base + '\\work');
}

// 游戏美术：Predesign/approved 框里的定稿（每个资产目前一张，有多张取最新）
function pickGameArtFile(row) {
  return latestInBox(assetDirOf(row) + '\\Predesign\\approved');
}

// CGTW 英雄名单里有、但资产库表里没有的英雄，按同一规则补进来
function addMissingHeroAssets(pending, heroes) {
  const heroCodes = new Set(heroes.map((item) => item.code));
  const present = new Set(pending.filter((item) => item.code && heroCodes.has(item.code)).map((item) => item.code.toLowerCase()));
  for (const hero of heroes) {
    if (present.has(hero.code.toLowerCase())) continue;
    const row = { kind: 'Cha', code: hero.code, d2: '', d3: '' };
    for (const [stage, file, suffix] of [['game', pickGameArtFile(row), '游戏美术'], ['2d', pick2dFile(row), '2D'], ['3d', latestInBox(assetBaseDir('Cha', hero.code) + '\\LookDev\\work'), '3D']]) {
      if (!file) continue;
      pending.push({
        game: DEFAULT_GAME,
        projectLabel: '',
        code: hero.code,
        name: hero.name + '_' + suffix,
        stage,
        assetType: 'character',
        hero: true,
        mediaType: mediaTypeOf(file.filePath),
        filePath: file.filePath,
        mtimeMs: Number(file.stat.mtimeMs) || 0,
      });
    }
  }
}

function buildCatalog() {
  const cgtwTags = currentCgtwTags();
  // 火炬「英雄」：有 CGTW 标签时用标签里的英雄（也用它补表里没有的英雄），没有时退回旧名单
  const torchTags = cgtwTags[DEFAULT_GAME];
  const heroes = torchTags
    ? [...torchTags.tags.values()].map((item) => ({ code: item.code, name: heroDisplayName(item.value) })).filter((item) => item.name)
    : currentHeroAssets();
  const heroByCode = new Map(heroes.map((item) => [item.code.toLowerCase(), item.name]));
  let game = DEFAULT_GAME;
  let projectLabel = '';
  const pending = [];
  const atmospheres = [];
  const seenAtmosphere = new Set();
  const sheet = currentSheet();
  let projectCode = '';
  for (const row of sheet.rows) {
    if (row.game !== game) {
      game = row.game;
      projectLabel = '';
      projectCode = '';
    }
    if (classifyLabel(row.label) === 'project') {
      projectLabel = String(row.label).trim();
      projectCode = String(row.projectCode || '').trim().toLowerCase();
    }
    const assetKind = rowKind(row);
    if (assetKind) {
      const assetType = assetKind === 'Cha' ? 'character' : assetKind === 'Prop' ? 'prop' : 'scene';
      const code = String(row.code || '').trim();
      const baseName = String(row.name || code || '\u672a\u547d\u540d').trim();
      const live = Boolean(projectCode) && row.liveProjects.some((prefix) => projectCode.startsWith(prefix));
      const gameTags = cgtwTags[game];
      const tagValue = gameTags?.tags.get(code.toLowerCase())?.value || '';
      // 名字：火炬英雄按 CGTW 英雄标签起名；表里有局内代号的照旧用它（只影响名字，不影响筛选）
      const heroName = (game === DEFAULT_GAME ? heroByCode.get(code.toLowerCase()) : '') || heroDisplayName(row.gameName);
      // 筛选：这个游戏有 CGTW 标签数据时只看标签；没有时沿用旧规则（名单 / 局内代号 / heroCodes）
      const tagged = gameTags ? Boolean(tagValue) : (Boolean(heroName) || row.heroCodes.has(code.toLowerCase()));
      for (const [stage, file, suffix] of [['game', pickGameArtFile(row), '游戏美术'], ['2d', pick2dFile(row), '2D'], ['3d', pick3dFile(row, live), '3D']]) {
        if (!file) continue;
        pending.push({
          game,
          projectLabel,
          code,
          hero: tagged || (!gameTags && row.heroCodes.has(code.toLowerCase())),
          // RO 等「职业」标签的资产：名字前面加职业名（刺客_男刺客_2D）；火炬英雄的名字上面已按英雄标签起好
          name: (((game !== DEFAULT_GAME && tagValue ? tagValue + '_' : '') + (heroName || baseName)) + '_' + suffix),
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
    return { id: gameIdFor(name), name, heroLabel: sheet.games[name]?.heroLabel || cgtwTags[name]?.label || '', assets };
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

// 资产库「刷新」：不等 20 秒缓存过期，立刻按 CGTW 文件框重扫——文件没了就删、新出的就补
function refreshCatalog() {
  catalogCache = null;
  return getCatalog();
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
      { id: 'game', label: '\u6e38\u620f\u7f8e\u672f' },
      { id: '2d', label: '2D\u7f8e\u672f' },
      { id: '3d', label: '3D\u7f8e\u672f' },
      { id: 'atmosphere', label: '\u6c1b\u56f4\u56fe' },
    ],
    assetTypes: [
      { id: 'all', label: '\u5168\u90e8' },
      { id: 'character', label: '\u89d2\u8272' },
      { id: 'scene', label: '\u573a\u666f' },
      // 英雄 / NPC、道具：这个游戏里有才出按钮（RO 目前没有英雄标记）
      ...(game.assets.some((asset) => asset.hero) ? [{ id: 'hero', label: game.heroLabel || currentSheet().games[game.name]?.heroLabel || "英雄" }] : []),
      ...(game.assets.some((asset) => asset.assetType === 'prop') ? [{ id: 'prop', label: '道具' }] : []),
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

// 按短边缩（360P / 1080P）：列表小图和悬停预览用 360，「浏览大图」用 1080。
// 原图短边不超过目标时：360 档照样出一张 WebP（不放大），1080 档直接给原图。
const SHORT_EDGES = new Set([360, 1080]);

function normalizeShortEdge(value) {
  const edge = Number(value);
  return SHORT_EDGES.has(edge) ? edge : 0;
}

function projectAssetThumbsDir() {
  return path.join(path.dirname(config.projectsDir), 'project-asset-thumbs');
}

function thumbFilePath(projectId, relativePath, width, shortEdge = 0) {
  const hash = crypto.createHash('sha1').update(String(projectId) + '\0' + relativePath).digest('hex');
  const suffix = shortEdge ? '-s' + shortEdge : '-w' + width;
  return path.join(projectAssetThumbsDir(), String(projectId), hash + suffix + '.webp');
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

async function ensureProjectAssetThumb(sourceFile, projectId, relativePath, width, shortEdge = 0) {
  const outPath = thumbFilePath(projectId, relativePath, width, shortEdge);
  const cached = freshThumb(outPath, sourceFile);
  if (cached) return cached;
  const sharp = getSharp();
  if (!sharp) return null;
  const key = String(projectId) + ':' + relativePath + ':' + (shortEdge ? 's' + shortEdge : width);
  const pending = thumbInFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmpPath = outPath + '.tmp-' + process.pid + '-' + Date.now();
    try {
      let resize = { width, withoutEnlargement: true };
      if (shortEdge) {
        const metadata = await sharp(sourceFile.filePath, { failOn: 'none' }).metadata();
        const rotated = Number(metadata.orientation) >= 5;
        const w = Number(rotated ? metadata.height : metadata.width) || 0;
        const h = Number(rotated ? metadata.width : metadata.height) || 0;
        resize = w >= h ? { height: shortEdge, withoutEnlargement: true } : { width: shortEdge, withoutEnlargement: true };
      }
      await sharp(sourceFile.filePath, { failOn: 'none' }).rotate().resize(resize).webp({ quality: shortEdge >= 1080 ? 86 : 72 }).toFile(tmpPath);
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

async function ensureVideoPoster(sourceFile, projectId, relativePath, width, shortEdge = 0) {
  const outPath = thumbFilePath(projectId, relativePath, width, shortEdge);
  const cached = freshThumb(outPath, sourceFile);
  if (cached) return cached;
  const sharp = getSharp();
  if (!sharp) return null;
  const key = 'video:' + String(projectId) + ':' + relativePath + ':' + (shortEdge ? 's' + shortEdge : width);
  const pending = thumbInFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const framePath = outPath + '.frame-' + process.pid + '-' + Date.now() + '.jpg';
    const tmpPath = outPath + '.tmp-' + process.pid + '-' + Date.now();
    try {
      await execFileAsync('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-ss', '0', '-i', sourceFile.filePath, '-frames:v', '1', '-vf', shortEdge
        ? `scale='if(gte(iw,ih),-2,min(iw,${shortEdge}))':'if(gte(iw,ih),min(ih,${shortEdge}),-2)'`
        : 'scale=' + width + ':-2', framePath], { timeout: 60000 });
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

async function readProjectAssetFile(projectId, relativePath, width, shortEdgeValue) {
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
  const shortEdge = normalizeShortEdge(shortEdgeValue);
  const thumbWidth = shortEdge ? 0 : normalizeThumbWidth(width);
  if (!thumbWidth && !shortEdge) return original;
  try {
    if (shortEdge >= 1080 && asset.mediaType !== 'video') {
      const sharp = getSharp();
      const metadata = sharp ? await sharp(asset.filePath, { failOn: 'none' }).metadata() : null;
      // 原图短边不超过 1080：浏览大图直接看原图
      if (!metadata || Math.min(Number(metadata.width) || 0, Number(metadata.height) || 0) <= shortEdge) return original;
    }
    const thumb = asset.mediaType === 'video'
      ? await ensureVideoPoster(original, id, token, thumbWidth, shortEdge)
      : await ensureProjectAssetThumb(original, id, token, thumbWidth, shortEdge);
    if (thumb) return thumb;
  } catch (error) {
    console.warn('project asset thumb failed:', error && error.message ? error.message : error);
  }
  if (asset.mediaType === 'video') throw httpError(404, '\u89c6\u9891\u5c01\u9762\u751f\u6210\u5931\u8d25');
  return original;
}

module.exports = {
  refreshCatalog,
  currentHeroAssets,
  heroDisplayName,
  listProjectsWithPaths,
  listProjectModules,
  readProjectAssetFile,
};