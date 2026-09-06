const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const express = require('express');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');
const { getUserApiKeyByExternalId } = require('./userCatalog');
const {
  getContentPool,
  getPool,
  getUsagePool,
} = require('./db');
const {
  hydrateCanvasRow,
  hydrateCanvasRows,
  isSeparateContentDatabase,
  parseJsonDocument,
  saveCanvasData,
} = require('./services/CanvasService');
const { queueCanvasMutation } = require('./services/CanvasMutationQueue');
const { mergeNodeSnapshots } = require('./services/CanvasCollaborationService');
const {
  conflictSafeDeletions,
  inferredDeleteLimit,
  rescueUndeclaredNodeRemovals,
} = require('./services/CanvasNodeDeleteGuard');
const { isResumableGenerationTask } = require('./services/GenerationTaskRecovery');
const {
  enterCanvasSession,
  leaveCanvasSession,
  requireCanvasSession,
  tokenFromRequest,
  validateCanvasSession,
} = require('./services/CanvasAccessSessionService');
const {
  canvasChangedNodeKeysSince,
  publishCanvasChange,
  recentCanvasChangesSince,
  subscribeCanvasChanges,
} = require('./services/CanvasRealtimeService');
const assetService = require('./services/AssetService');
const objectStore = assetService.objectStore;
const imageUpscaleService = require('./services/ImageUpscaleService');
const imageRepaintService = require('./services/ImageRepaintService');
const panoramaService = require('./services/PanoramaService');
const lightStageGeometryService = require('./services/LightStageGeometryService');
const textureClarityService = require('./services/TextureClarityService');
const subjectMattingService = require('./services/SubjectMattingService');
const jobService = require('./services/JobService');
const {
  createProjectInCatalog,
  getDefaultProjectCatalogRow,
  getProjectCatalogRowById,
  listProjectCatalogRows,
  listShotflowCategoryRows,
  syncProjectCatalogCache,
} = require('./projectCatalog');
const {
  normalizeVideoMode,
  normalizeVideoRatio,
  normalizeVideoResolution,
  normalizeVideoDuration,
  normalizeVideoCount,
  getVideoModelRule,
  seedanceOmniReferenceTaskType,
  seedanceOmniPrompt,
  validateVideoCapabilities,
} = require('./providers/SeedanceProvider');
const openAIImageProvider = require('./providers/OpenAIImageProvider');
const { addLog, canAddLog, listLogs, updateLog } = require('./logStore');
const {
  createPaidUsageLog,
  createVideoTaskDetail,
  updatePaidUsageLog,
  updateVideoTaskDetail,
} = require('./services/UsageService');
const {
  recordGenerationTaskFailure,
  recordNodeGenerationError,
} = require('./services/ErrorService');
const {
  FAVORITE_ITEM_TYPES,
  favoriteFromRow,
  normalizeFavoritePayload,
  normalizeFavoriteSourceProject,
  normalizeFavoriteSourceRoot,
  normalizeFavoriteTags,
} = require('./services/LibraryService');
const appearanceDescriptorService = require('./services/appearanceDescriptorService');
const appearanceHistoryService = require('./services/appearanceHistoryService');
const panoramaGenerationParams = require('./services/PanoramaGenerationParams');
const panoramaErpTemplateService = require('./services/PanoramaErpTemplateService');

const execFileAsync = promisify(execFile);

const apiRouter = express.Router();

// Express 4 不会接 async handler 的 Promise 拒绝：没人捕获就是 unhandledRejection，
// 而 Node 15+ 的默认行为是**直接退出进程**。
// 2026-08-14 后端一天崩了 41 次，全部来自这一类：一个会话已失效的页面在轮询
// /tasks/:jobId，requireCanvasSession 抛 428 CANVAS_ACCESS_SESSION_REQUIRED，
// 路由里既没有 try 也没有 next，于是整个服务被一个人的过期页面打死——
// 崩溃时间戳成串出现（19:14:34 / :44 / :56 / 19:15:09），每 10 秒一次。
// 别的路由都写了 try { } catch (error) { next(error) }，漏掉的这几个用这个包装器补上。
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const assetRouter = express.Router();

// Per-request effective API key for llm-proxy calls: a user who has their own
// sd2 api_key generates on their key; otherwise the public default is used.
// Held in AsyncLocalStorage so detached generation promises and background
// polling spawned within a request inherit it. Mivo calls keep the default key
// (the sd2 api_key is an llm-proxy key and is rejected by Mivo).
const apiKeyStore = new AsyncLocalStorage();
function currentUserApiKey() {
  const store = apiKeyStore.getStore();
  return store && store.userKey ? store.userKey : null;
}
function currentLlmKey() { return currentUserApiKey() || config.llmApiKey; }
function currentOpenaiKey() { return currentUserApiKey() || config.openaiApiKey; }

apiRouter.use(async (req, res, next) => {
  let userKey = null;
  try {
    userKey = await getUserApiKeyByExternalId(req.user && req.user.external_user_id);
  } catch {
    userKey = null;
  }
  apiKeyStore.run({ userKey: userKey || null }, () => next());
});
const DEFAULT_IMAGE_MODEL = openAIImageProvider.DEFAULT_IMAGE_MODEL;
const MAX_VIDEO_UPLOAD_BYTES = 200 * 1024 * 1024;
const DEFAULT_SEEDANCE_MODEL_RULE = getVideoModelRule('Seedance_2_0');
const DEFAULT_SEEDANCE_REFERENCE_RULE = DEFAULT_SEEDANCE_MODEL_RULE.referenceVideo;
const SEEDANCE_REFERENCE_VIDEO_MAX_BYTES = DEFAULT_SEEDANCE_REFERENCE_RULE.maxBytes;
const SEEDANCE_REFERENCE_VIDEO_TARGET_BYTES = Math.floor(SEEDANCE_REFERENCE_VIDEO_MAX_BYTES * DEFAULT_SEEDANCE_REFERENCE_RULE.targetBytesRatio);
const SEEDANCE_REFERENCE_MIN_PIXELS = DEFAULT_SEEDANCE_REFERENCE_RULE.minPixels;
const SEEDANCE_REFERENCE_MAX_PIXELS = DEFAULT_SEEDANCE_REFERENCE_RULE.maxPixels;
const SEEDANCE_REFERENCE_MIN_DURATION_SEC = DEFAULT_SEEDANCE_REFERENCE_RULE.minDurationSec;
const SEEDANCE_REFERENCE_MAX_DURATION_SEC = DEFAULT_SEEDANCE_REFERENCE_RULE.maxDurationSec;
const SEEDANCE_REFERENCE_MAX_TOTAL_DURATION_SEC = DEFAULT_SEEDANCE_REFERENCE_RULE.maxTotalDurationSec;
const SEEDANCE_REFERENCE_MAX_COUNT = DEFAULT_SEEDANCE_REFERENCE_RULE.maxCount;
const FAVORITE_LIBRARY_PAGE_SIZE = 30;
let sharpModule = null;
let sharpChecked = false;
const mirroredLocalAssetKeys = new Set();
const generationAbortControllers = new Map();
const activeNonResumableGenerations = new Map();
const activeProviderSubmissions = new Map();
const activePollOperations = new Map();
const generationPollers = new Map();
const generatedVideoRvTranscodeLimit = Math.max(
  1,
  Math.min(4, Math.floor(Number(process.env.GENERATED_VIDEO_RV_TRANSCODE_CONCURRENCY || 1) || 1))
);
const generatedVideoRvTranscodeWaiters = [];
let activeGeneratedVideoRvTranscodes = 0;
let generationRuntimeDraining = false;

async function withGeneratedVideoRvTranscodeSlot(work) {
  if (activeGeneratedVideoRvTranscodes < generatedVideoRvTranscodeLimit) {
    activeGeneratedVideoRvTranscodes += 1;
  } else {
    await new Promise((resolve) => generatedVideoRvTranscodeWaiters.push(resolve));
  }
  try {
    return await work();
  } finally {
    activeGeneratedVideoRvTranscodes = Math.max(0, activeGeneratedVideoRvTranscodes - 1);
    const next = generatedVideoRvTranscodeWaiters.shift();
    if (next) {
      // 先占住刚释放的槽位再唤醒，避免同一事件循环里新的请求抢进来导致超限。
      activeGeneratedVideoRvTranscodes += 1;
      next();
    }
  }
}

function referenceRuleForVideoModel(model) {
  return getVideoModelRule(model)?.referenceVideo || DEFAULT_SEEDANCE_REFERENCE_RULE;
}

const LIGHT_STAGE_GEOMETRY_CACHE_VERSION = lightStageGeometryService.GEOMETRY_ASSET_VERSION || 4;
const LIGHT_STAGE_GEOMETRY_CACHE_NORMAL = lightStageGeometryService.NORMAL_CONVENTION || 'opengl-object';
const MIN_CROP_SIZE_PX = 32;
const CANVAS_PROJECT_STATUS_LABELS = {
  not_started: '闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；闁绘劗鍎ら崑瀣煟濡崵婀介柍褜鍏涚欢姘嚕閹绢喖顫呴柍鈺佸暞閻濇洟姊绘担钘壭撻柨姘亜閿旇鏋ょ紒杈ㄦ瀵挳鎮㈤搹鍦闂備焦鐪归崹钘夘焽瑜嶉悺顓㈡⒒娴ｇ懓顕滄繛鎻掔箻瀹曟劕螖閸涱厾鍔﹀銈嗗笂缁€渚€宕甸鍕厱闁挎繂绻掔粔顔尖攽閳╁啯灏︾€规洏鍔戝鍫曞箣閻橀潧骞€婵犵數濮伴崹鐓庘枖濞戙垺鍎斿┑鍌氭啞閸庡﹪鏌涢銈呮灁缂佲檧鍋撻梻浣圭湽閸ㄨ棄顭囪閻☆參姊绘担渚劸闁挎洏鍊楃槐鐐寸節閸屾粍娈鹃梺瑙勫劶婵倝宕愮紒妯圭箚妞ゆ牜鍋炲▍婊呯磼閵婎煈鍤欐い顏勫暣婵″爼宕卞Δ鈧〖缂傚倷鐒﹁ぐ鍐╂櫠閻ｅ苯鍨濋柛顐熸噰閸嬫捇鏁愭惔鈩冪亶闂佺粯鎸荤粙鎾诲焵椤掆偓閸樻粓宕戦幘缁樼厓鐟滄粓宕滈悢椋庢殾濞村吋娼欑粻濠氭偣閸ヮ亜鐨洪柛鏃撶畱椤啴濡堕崱妤冪懆闂佺锕ょ紞濠傤嚕閹惰棄鐓涢柛灞久肩花璇差渻閵堝棙灏甸柛瀣枑閺呰泛鈽夊杈╋紲闂佺鏈粙鎴澝归鈧弻鈩冩媴缁嬫寧娈婚悗瑙勬礃鐢帡鍩ユ径濠庢僵妞ゆ巻鍋撶紒?',
  in_progress: '闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁惧墽鎳撻—鍐偓锝庝簼閹癸綁鏌ｉ鐐搭棞闁靛棙甯掗～婵嬫晲閸涱剙顥氬┑掳鍊楁慨鐑藉磻閻愮儤鍋嬮柣妯荤湽閳ь兛绶氬鏉戭潩鏉堚敩銏ゆ⒒娴ｈ鍋犻柛搴㈡そ瀹曟粓鏁冮崒姘€梺鍛婂姦閸犳鎮￠妷鈺傜厸闁搞儺鐓堝▓鏂棵瑰鍫㈢暫婵﹤鎼晥闁搞儜鈧崑鎾澄旈崨顓狅紱闂佽宕橀崺鏍х暦閸欏绡€闂傚牊绋掑婵堢磼閳锯偓閸嬫捇姊绘担渚劸闁哄牜鍓涚划娆撳箣濠靛啯鐎洪悷婊勬煥椤繘宕崝鍊熸閹风娀骞撻幒鏃戝晥闂傚倷娴囧畷鐢稿疮閸ф鐤鹃柣妯烘▕閸ゆ洖鈹戦悩瀹犲闁诲繑濞婇弻鐔革紣娴ｄ警妲梺璇″枟閸ㄥ潡寮婚悢鍏煎殐闁冲搫濯绘径鎰厓鐟滄粓宕滃▎鎴濐棜妞ゆ挶鍩勯弫濠傤熆閼搁潧濮堥柍閿嬪笒閵嗘帒顫濋敐鍛闂備線鈧偛鑻晶浼存煕鐎ｎ偆娲撮柟宕囧枛椤㈡盯鎮欓幓鎺戜憾闂備礁鎲＄缓鍧楀磿瀹曞洤顥氬┑鍌氭啞閻撶娀鏌熼梻瀵稿妽婵炴嚪鍥ㄧ厱婵犻潧娲﹂妵婵嬫煛瀹€瀣埌闁宠棄顦靛畷锟犳倷鐎甸晲澹曢梻鍌欑窔閳ь剛鍋涢懟顖涙櫠閸撗呯＝鐎广儱鎳忛ˉ銏⑩偓瑙勬礃濠㈡鐏冮梺鍛婁緱閸橀箖鏁嶅▎鎰箚闁绘劕妯婇崕蹇旂箾閺夋垵妲婚摶鐐淬亜閺嶎偄浠﹂柣鎾跺枑娣囧﹪濡堕崒姘闂備胶绮幐鎼佹偉婵傚摜宓侀悗锝庡枟閺呮粓鏌﹀Ο渚Т闁?',
  completed: '闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧湱鈧懓瀚崳纾嬨亹閹烘垹鍊炲銈嗗笒椤︿即寮查鍫熷仭婵犲﹤鍟版晥濠电姭鍋撳〒姘ｅ亾婵﹨娅ｇ槐鎺懳熼搹閫涚礃婵犵妲呴崑鍕偓姘煎枤閸掓帗绻濆顓炰汗缂傚倷鐒﹂…鍥储閻㈠憡鈷戠痪顓炴媼濞兼劙鏌涢弮鎾剁暤鐎规洟娼ч埢搴ㄥ箣閻樼绱查梻浣虹帛閿曘垹顭囪瀵鈽夊▎鎰伎婵犵數濮抽懗鍫曟儗濞嗘垟鍋撶憴鍕闁绘牕銈搁妴浣肝旈崨顓犲姦濡炪倖甯婄欢锟犲绩娴煎瓨鈷掗柛灞剧懅椤︼附绻濋埀顒佹綇閵婏附鐝峰┑掳鍊愰崑鎾淬亜椤撶偟浠㈤摶锝夋煠濞村娅囬柣鎺戙偢濮婃椽宕ㄦ繝鍌氼潊闂佸搫鍊搁崐鍦矉瀹ュ拋鐓ラ柛顐ゅ枔閸樻悂姊洪崨濠傚闁告柨绉靛鍕礋椤戝彞绨婚梺闈涱槶閸庡搫危閹间焦顥嗗鑸靛姈閻撶喐鎱ㄥ璇蹭壕濠电偘鍖犻崨顔芥闂佺厧鎽滈崑锝嗙濠婂嫨浜滈煫鍥ㄦ尭椤忊晠鏌￠崱顓犲埌闁宠鍨块崹鎯х暦閸パ呭幗闁诲氦顫夊ú鏍х暦椤掑啰浜欓梻浣告啞閸旓附绂嶅┑瀣棷妞ゆ牜鍋為埛鎺懨归敐鍥╂憘闁搞倖鐟╅幃妤€鈽夐幒鎾寸彋閻庤娲橀悷銊╁Φ閹版澘绠抽柟瀵稿濡茶埖绻濋悽闈涗沪闁搞劌鐖奸幊婵囥偅閸愩劌鐎?',
};

function getSharp() {
  if (sharpChecked) return sharpModule;
  sharpChecked = true;
  try {
    sharpModule = require('sharp');
  } catch (error) {
    console.warn('sharp is unavailable; image thumbnails and compression are disabled:', error.message);
    sharpModule = null;
  }
  return sharpModule;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function projectDir(projectUuid) {
  return path.join(config.projectsDir, String(projectUuid));
}

function assetsDir(projectUuid) {
  const dir = path.join(projectDir(projectUuid), 'assets');
  ensureDir(dir);
  return dir;
}

function ensureProjectScaffold(projectUuid) {
  ensureDir(projectDir(projectUuid));
  ensureDir(path.join(projectDir(projectUuid), 'assets'));
}

function removeProjectScaffold(projectUuid) {
  fs.rmSync(projectDir(projectUuid), { recursive: true, force: true });
}

function tmpDir() {
  const dir = path.join(config.projectsDir, '_tmp');
  ensureDir(dir);
  return dir;
}

function assetRelativePath(projectUuid, storedName) {
  return path.posix.join(String(projectUuid), 'assets', storedName);
}

const LIGHT_STAGE_GEOMETRY_ITEM_SPECS = [
  { key: 'diffuse', ext: 'png', mimeType: 'image/png' },
  { key: 'normal', ext: 'png', mimeType: 'image/png' },
  { key: 'depth', ext: 'png', mimeType: 'image/png' },
  { key: 'mask', ext: 'png', mimeType: 'image/png' },
  { key: 'preview', ext: 'webp', mimeType: 'image/webp' },
  { key: 'pointMap', ext: 'json', mimeType: 'application/json' },
  { key: 'manifest', ext: 'json', mimeType: 'application/json' },
];

function lightStageGeometryStoredName(sourceHash, key, ext) {
  return `light-stage-${String(sourceHash || '').slice(0, 16)}-v${LIGHT_STAGE_GEOMETRY_CACHE_VERSION}-${key}.${ext}`;
}

async function tryReuseLightStageGeometry(projectUuid, sourceHash, options = {}) {
  const dir = assetsDir(projectUuid);
  const manifestStoredName = lightStageGeometryStoredName(sourceHash, 'manifest', 'json');
  const manifestPath = path.join(dir, manifestStoredName);
  if (!fs.existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }

  const manifestVersion = Number(manifest.geometryAssetVersion || manifest.version || 0);
  if (manifestVersion !== LIGHT_STAGE_GEOMETRY_CACHE_VERSION) return null;
  if (String(manifest.normalConvention || '') !== LIGHT_STAGE_GEOMETRY_CACHE_NORMAL) return null;
  if (manifest.sourceHash && String(manifest.sourceHash) !== String(sourceHash)) return null;

  const provider = String(manifest.provider || '').trim() === lightStageGeometryService.MODEL_ID
    ? lightStageGeometryService.MODEL_ID
    : 'local-2.5d';
  const modelId = String(manifest.modelId || '').trim()
    || (provider === lightStageGeometryService.MODEL_ID
      ? lightStageGeometryService.MODEL_ID
      : lightStageGeometryService.LOCAL_MODEL_ID);
  const assetMap = manifest.assets || {};
  const items = [];
  for (const spec of LIGHT_STAGE_GEOMETRY_ITEM_SPECS) {
    const storedName = String(assetMap[spec.key] || lightStageGeometryStoredName(sourceHash, spec.key, spec.ext));
    const fullPath = await ensureAssetLocalPath(projectUuid, storedName);
    if (!fs.existsSync(fullPath)) return null;
    items.push({
      key: spec.key,
      ext: spec.ext,
      mimeType: spec.mimeType,
      storedName,
      sha1: sha1File(fullPath),
    });
  }

  if (
    provider !== lightStageGeometryService.MODEL_ID
    && options.serviceUrl
    && options.serviceToken
  ) {
    try {
      await lightStageGeometryService.assertRemoteWorkerHealthy(options.serviceUrl, options.serviceToken, {
        healthTimeoutMs: options.healthTimeoutMs,
        bypassUnavailableCache: true,
      });
      return null;
    } catch {
      // Keep the cached 2.5D fallback only while MoGe-2 is still unhealthy.
    }
  }

  return {
    provider,
    modelId,
    status: provider === lightStageGeometryService.MODEL_ID ? 'ready' : 'fallback',
    sourceHash,
    width: Number(manifest.width || 0),
    height: Number(manifest.height || 0),
    fov: Number(manifest.fov || 45),
    intrinsics: Array.isArray(manifest.intrinsics)
      ? manifest.intrinsics.map(Number).filter(Number.isFinite).slice(0, 9)
      : [],
    assetVersion: manifestVersion,
    normalConvention: LIGHT_STAGE_GEOMETRY_CACHE_NORMAL,
    generatedAtMs: Number(manifest.generatedAtMs || Date.now()),
    items,
    warning: provider === lightStageGeometryService.MODEL_ID
      ? undefined
      : 'MoGe-2 unavailable; using local 2.5D fallback',
    cached: true,
  };
}

async function mirrorStoredAsset(projectUuid, storedName, localPath, mimeType) {
  if (!objectStore.isRemoteEnabled) return;
  if (!fs.existsSync(localPath)) return;
  await objectStore.uploadLocalFile(projectUuid, storedName, localPath, mimeType || mimeTypeFromName(storedName));
}

async function maybeMirrorLocalAsset(projectUuid, storedName, localPath, mimeType) {
  if (!objectStore.isRemoteEnabled || !objectStore.settings.autoMirrorLocalAssets) return;
  if (!fs.existsSync(localPath)) return;
  const assetKey = `${projectUuid}/${storedName}`;
  if (mirroredLocalAssetKeys.has(assetKey)) return;
  mirroredLocalAssetKeys.add(assetKey);
  try {
    await mirrorStoredAsset(projectUuid, storedName, localPath, mimeType);
  } catch (error) {
    mirroredLocalAssetKeys.delete(assetKey);
    console.warn(`lazy mirror asset failed for ${assetKey}:`, error.message);
  }
}

async function ensureAssetLocalPath(projectUuid, storedName) {
  const localPath = path.join(assetsDir(projectUuid), storedName);
  if (fs.existsSync(localPath)) {
    void maybeMirrorLocalAsset(projectUuid, storedName, localPath, mimeTypeFromName(storedName));
    return localPath;
  }
  if (objectStore.isRemoteEnabled) {
    try {
      const restored = await objectStore.restoreAssetToLocal(projectUuid, storedName, localPath);
      if (restored && fs.existsSync(localPath)) return localPath;
    } catch (error) {
      console.warn(`restore asset failed for ${projectUuid}/${storedName}:`, error.message);
    }
  }
  return localPath;
}

async function removeProjectStoredAssets(projectUuid) {
  if (objectStore.isRemoteEnabled) {
    try {
      await objectStore.deleteProjectAssets(projectUuid);
    } catch (error) {
      console.warn(`delete project assets from object store failed for ${projectUuid}:`, error.message);
    }
  }
}

function safeOriginalName(name, fallback = 'file') {
  const value = path.basename(String(name || '').trim());
  return (value || fallback).slice(0, 255);
}

function mimeTypeFromName(name) {
  switch (path.extname(String(name || '')).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    case '.avi':
      return 'video/x-msvideo';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.aac':
      return 'audio/aac';
    case '.m4a':
      return 'audio/mp4';
    case '.ogg':
      return 'audio/ogg';
    default:
      return 'application/octet-stream';
  }
}

function assetKindFromMime(mimeType, name = '') {
  const mime = String(mimeType || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const inferredMime = mimeTypeFromName(name);
  if (inferredMime.startsWith('image/')) return 'image';
  if (inferredMime.startsWith('video/')) return 'video';
  if (inferredMime.startsWith('audio/')) return 'audio';
  return 'file';
}

function fileExtension(name) {
  return path.extname(String(name || '')).replace(/^\./, '').toLowerCase();
}

function isVideoMimeType(mimeType, name = '') {
  const kind = assetKindFromMime(mimeType, name);
  return kind === 'video';
}

function extensionFromMimeType(mimeType) {
  switch (String(mimeType || '').toLowerCase()) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'image/bmp': return '.bmp';
    case 'image/tiff': return '.tiff';
    case 'video/quicktime': return '.mov';
    case 'video/webm': return '.webm';
    case 'video/x-matroska': return '.mkv';
    case 'video/x-msvideo': return '.avi';
    case 'video/mp4': return '.mp4';
    case 'audio/mpeg': return '.mp3';
    case 'audio/wav': return '.wav';
    case 'audio/aac': return '.aac';
    case 'audio/mp4': return '.m4a';
    case 'audio/ogg': return '.ogg';
    default: return '.bin';
  }
}

async function detectUploadedMimeType(filePath, declaredMimeType, originalName) {
  const declared = String(declaredMimeType || '').trim().toLowerCase();
  if (/^(image|video|audio)\//.test(declared)) return declared;

  const inferred = mimeTypeFromName(originalName);
  if (inferred !== 'application/octet-stream') return inferred;

  const descriptor = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(16);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const bytes = header.subarray(0, bytesRead);
  const ascii = bytes.toString('ascii');
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('BM')) return 'image/bmp';
  if (ascii.startsWith('II*\u0000') || ascii.startsWith('MM\u0000*')) return 'image/tiff';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (ascii.startsWith('ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';

  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type:format=format_name', '-of', 'json', filePath],
      { timeout: 30_000 }
    );
    const payload = JSON.parse(stdout || '{}');
    const streamTypes = new Set((payload.streams || []).map((stream) => String(stream?.codec_type || '')));
    const formatName = String(payload?.format?.format_name || '');
    if (streamTypes.has('video')) {
      if (formatName.includes('webm')) return 'video/webm';
      if (formatName.includes('matroska')) return 'video/x-matroska';
      if (formatName.includes('mov') && !formatName.includes('mp4')) return 'video/quicktime';
      return 'video/mp4';
    }
    if (streamTypes.has('audio')) {
      if (formatName.includes('ogg')) return 'audio/ogg';
      if (formatName.includes('wav')) return 'audio/wav';
      if (formatName.includes('mp3')) return 'audio/mpeg';
      if (formatName.includes('mov') || formatName.includes('mp4')) return 'audio/mp4';
    }
  } catch {
    // Unknown files remain available as generic uploads.
  }

  return declared || 'application/octet-stream';
}

function assetUrl(projectUuid, storedName) {
  return `/assets/${projectUuid}/${storedName}`;
}

/** `/assets/{画布id}/{文件名}`。参考图已经按这个解析，参考视频之前只认当前画布目录。 */
function parseLocalAssetUrl(url) {
  const match = String(url || '').trim().match(/^\/assets\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { projectUuid: match[1], storedName: match[2] };
}

async function resolveLocalAssetProject(req, url, fallbackProjectUuid) {
  const parsed = parseLocalAssetUrl(url);
  const fallbackName = path.basename(String(url || ''));
  if (!parsed) {
    return { projectUuid: fallbackProjectUuid, storedName: fallbackName };
  }
  if (String(parsed.projectUuid) === String(fallbackProjectUuid)) return parsed;
  if (!req) {
    const error = new Error(`参考素材属于画布 ${parsed.projectUuid}，当前请求无法读取该画布`);
    error.statusCode = 403;
    throw error;
  }
  const readable = await getReadableCanvasForUser(req, parsed.projectUuid);
  if (!readable) {
    const error = new Error(`参考素材属于画布 ${parsed.projectUuid}，当前账号没有该画布的读取权限`);
    error.statusCode = 403;
    throw error;
  }
  return parsed;
}

/**
 * 参考视频的 ffmpeg 滤镜。走到这里就说明确实超限了，但**也只削超出的那部分**。
 *
 * 两点刻意的选择：
 *   - 缩放只缩到刚好卡进上限（min(sqrt(maxPixels*iw/ih), iw)），不会一刀切到某个固定档；
 *   - `fps=24` **只在源帧率高于 24 时才加**。原来是无条件加的，于是一个只是像素略微超限的
 *     60fps 素材会连帧率一起被削掉（2026-08-24 修）。降帧确实能帮着压体积，
 *     但源本来就 ≤24fps 时再写一遍只会多一次重采样，白掉一点画质。
 *
 * 放大那一半（max(sqrt(minPixels*...)…）留着：真有低于下限的素材走到这里时（比如它是因为
 * 体积或容器超限进来的），provider 那边有下限要求，该垫还得垫。
 */
function ffmpegReferenceVideoFilter(referenceRule = DEFAULT_SEEDANCE_REFERENCE_RULE, sourceMeta = {}) {
  const minPixels = Number(referenceRule.minPixels || DEFAULT_SEEDANCE_REFERENCE_RULE.minPixels);
  const maxPixels = Number(referenceRule.maxPixels || DEFAULT_SEEDANCE_REFERENCE_RULE.maxPixels);
  const sourceFps = Number(sourceMeta?.fps || sourceMeta?.frameRate || 0);
  // 读不出帧率时按老行为兜底降到 24：读不出通常意味着元数据不全，宁可保守
  const needsFpsCap = !Number.isFinite(sourceFps) || sourceFps <= 0 || sourceFps > 24.5;
  const scale = [
    `scale=w='trunc(max(sqrt(${minPixels}*iw/ih),min(sqrt(${maxPixels}*iw/ih),iw))/2)*2'`,
    `h='trunc(max(sqrt(${minPixels}*ih/iw),min(sqrt(${maxPixels}*ih/iw),ih))/2)*2'`,
  ].join(':');
  return needsFpsCap ? `${scale},fps=24` : scale;
}

function ffmpegVideoFilter(kind = 'display') {
  if (kind === 'reference') {
    return ffmpegReferenceVideoFilter();
  }
  return "scale='if(gte(iw,ih),min(iw,960),-2)':'if(gte(iw,ih),-2,min(ih,960))',fps=24";
}

async function transcodeVideo(inputPath, outputPath, options = {}) {
  const {
    filter = ffmpegVideoFilter('display'),
    crf = 32,
    targetBytes = 0,
    durationSec = 0,
    audioBitrateKbps = 96,
    preset = 'veryfast',
    videoProfile = '',
    videoTag = '',
    copyAudio = false,
    signal = undefined,
    timeout = 10 * 60_000,
  } = options;

  const bitrates = [];
  if (targetBytes && durationSec > 0) {
    const totalKbps = Math.floor((targetBytes * 8) / durationSec / 1000);
    const videoKbps = Math.max(900, Math.min(12_000, totalKbps - audioBitrateKbps));
    bitrates.push(videoKbps, Math.floor(videoKbps * 0.72), Math.floor(videoKbps * 0.52), Math.floor(videoKbps * 0.36));
  } else {
    bitrates.push(null);
  }

  let lastError = null;
  let hasCompleteOutput = false;
  for (const bitrateKbps of bitrates) {
    fs.rmSync(outputPath, { force: true });
    hasCompleteOutput = false;
    const args = [
      '-nostdin',
      '-y',
      '-loglevel', 'error',
      '-i', inputPath,
      '-vf', filter,
      '-c:v', 'libx264',
      '-preset', preset,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
    ];

    if (copyAudio) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', `${audioBitrateKbps}k`);

    if (videoProfile) args.push('-profile:v', videoProfile);
    if (videoTag) args.push('-tag:v', videoTag);

    if (bitrateKbps) {
      args.push('-b:v', `${bitrateKbps}k`, '-maxrate', `${Math.floor(bitrateKbps * 1.25)}k`, '-bufsize', `${Math.floor(bitrateKbps * 2)}k`);
    } else {
      args.push('-crf', String(crf));
    }

    args.push(outputPath);

    try {
      await execFileAsync('ffmpeg', args, { timeout, signal });
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) {
        throw new Error('ffmpeg did not create a complete output');
      }
      hasCompleteOutput = true;
      if (!targetBytes || fs.statSync(outputPath).size <= targetBytes) return outputPath;
    } catch (error) {
      // ffmpeg 在超时/报错时也可能留下一个有 MP4 头、但帧不完整的残片。绝不能因为
      // “文件存在”就把这种残片当正式资产。
      fs.rmSync(outputPath, { force: true });
      hasCompleteOutput = false;
      lastError = error;
    }
  }

  if (hasCompleteOutput && fs.existsSync(outputPath)) return outputPath;
  throw lastError || new Error('video transcode failed');
}

function mp4UploadFileName(name) {
  const safeName = safeOriginalName(name, 'video.webm');
  const extension = path.extname(safeName);
  const baseName = path.basename(safeName, extension) || 'video';
  return `${baseName}.mp4`;
}

function videoCompareMp4TranscodeOptions() {
  return {
    // MediaRecorder 的画布宽高通常已经是偶数；这里只在奇数边长时补 1px，避免
    // yuv420p / H.264 因尺寸不合法而失败，不缩放用户的对比画面。
    filter: 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    crf: 18,
    audioBitrateKbps: 128,
    timeout: 20 * 60_000,
  };
}

function isH264Mp4Probe(payload) {
  const formatName = String(payload?.format?.format_name || '').toLowerCase();
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  return formatName.split(',').includes('mp4')
    && streams.some((stream) => stream?.codec_type === 'video' && stream?.codec_name === 'h264');
}

function generatedVideoRvTranscodeOptions() {
  return {
    // 不缩放、不裁切、不改帧率；只有奇数边长时补 1px，满足 H.264 yuv420p 的偶数尺寸要求。
    filter: 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    // Seedance 的 4K/1080P 原片可能是 10-bit HEVC。RV 2022 最稳妥的交付格式是
    // 8-bit H.264；画质优先使用 CRF 12，尽量保住生成片的细纹理和渐变，
    // 同时永久保留 provider 原片作为归档。
    crf: 12,
    preset: 'medium',
    videoProfile: 'high',
    videoTag: 'avc1',
    audioBitrateKbps: 192,
    timeout: 15 * 60_000,
  };
}

function isRvCompatibleGeneratedVideo(meta = {}) {
  const formats = String(meta.formatName || '')
    .toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const pixelFormat = String(meta.pixelFormat || '').toLowerCase();
  const audioCodecName = String(meta.audioCodecName || '').toLowerCase();
  return String(meta.extension || '').toLowerCase() === 'mp4'
    && formats.includes('mp4')
    && String(meta.codecName || '').toLowerCase() === 'h264'
    && (pixelFormat === 'yuv420p' || pixelFormat === 'yuvj420p')
    && (!audioCodecName || audioCodecName === 'aac');
}

function generatedVideoRvValidationError(sourceMeta = {}, outputMeta = {}) {
  if (!isRvCompatibleGeneratedVideo(outputMeta)) {
    return '转码结果不是 RV 兼容的 H.264/yuv420p MP4';
  }

  const sourceWidth = Number(sourceMeta.width || 0);
  const sourceHeight = Number(sourceMeta.height || 0);
  const outputWidth = Number(outputMeta.width || 0);
  const outputHeight = Number(outputMeta.height || 0);
  const expectedWidth = sourceWidth > 0 ? Math.ceil(sourceWidth / 2) * 2 : 0;
  const expectedHeight = sourceHeight > 0 ? Math.ceil(sourceHeight / 2) * 2 : 0;
  if (expectedWidth > 0 && outputWidth <= 0) return '无法读取 RV 兼容版宽度';
  if (expectedHeight > 0 && outputHeight <= 0) return '无法读取 RV 兼容版高度';
  if (expectedWidth > 0 && outputWidth !== expectedWidth) return 'RV 兼容版宽度与原片不一致';
  if (expectedHeight > 0 && outputHeight !== expectedHeight) return 'RV 兼容版高度与原片不一致';

  const sourceFps = Number(sourceMeta.fps || 0);
  const outputFps = Number(outputMeta.fps || 0);
  if (sourceFps > 0 && outputFps <= 0) return '无法读取 RV 兼容版帧率';
  if (sourceFps > 0 && outputFps > 0) {
    const tolerance = Math.max(0.05, sourceFps * 0.002);
    if (Math.abs(sourceFps - outputFps) > tolerance) return 'RV 兼容版帧率与原片不一致';
  }

  const sourceDuration = Number(sourceMeta.durationSec || 0);
  const outputDuration = Number(outputMeta.durationSec || 0);
  if (sourceDuration > 0 && outputDuration <= 0) return '无法读取 RV 兼容版时长';
  if (sourceDuration > 0 && outputDuration > 0) {
    const tolerance = Math.max(0.15, sourceDuration * 0.01);
    if (Math.abs(sourceDuration - outputDuration) > tolerance) return 'RV 兼容版时长与原片不一致';
  }
  if (sourceMeta.audioCodecName && !outputMeta.audioCodecName) return 'RV 兼容版丢失了原片音轨';
  return '';
}

async function transcodeGeneratedVideoForRv(inputPath, knownSourceMeta = null) {
  const sourceMeta = knownSourceMeta
    || await probeMediaMetadata(inputPath, mimeTypeFromName(inputPath), path.basename(inputPath));
  const outputPath = path.join(tmpDir(), `generated-rv-${randomId()}.mp4`);
  return withGeneratedVideoRvTranscodeSlot(async () => {
    try {
      await transcodeVideo(inputPath, outputPath, {
        ...generatedVideoRvTranscodeOptions(),
        copyAudio: sourceMeta.audioCodecName === 'aac',
      });
      const outputMeta = await probeMediaMetadata(outputPath, 'video/mp4', path.basename(outputPath));
      const validationError = generatedVideoRvValidationError(sourceMeta, outputMeta);
      if (validationError) throw new Error(validationError);
      return { filePath: outputPath, sourceMeta, outputMeta };
    } catch (error) {
      fs.rmSync(outputPath, { force: true });
      const wrapped = new Error(`生成视频转为 RV 兼容 MP4 失败：${error?.message || error}`);
      wrapped.cause = error;
      throw wrapped;
    }
  });
}

async function transcodeVideoCompareUploadToMp4(inputPath) {
  const outputPath = path.join(tmpDir(), `video-compare-${randomId()}.mp4`);
  try {
    await transcodeVideo(inputPath, outputPath, videoCompareMp4TranscodeOptions());
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=format_name:stream=codec_type,codec_name',
        '-of', 'json',
        outputPath,
      ],
      { timeout: 30_000 }
    );
    const probe = JSON.parse(stdout || '{}');
    if (!isH264Mp4Probe(probe)) {
      throw new Error('ffmpeg output is not an H.264 MP4 video');
    }
    return outputPath;
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    const wrapped = new Error('视频转为 MP4 失败，请重试');
    wrapped.cause = error;
    throw wrapped;
  }
}

async function createDisplayVideoAsset(projectUuid, sha1, sourcePath, sourceMimeType) {
  const sourceStat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
  if (!sourceStat) return null;

  const storedName = `${sha1}_display.mp4`;
  const outputPath = path.join(assetsDir(projectUuid), storedName);

  try {
    if (!fs.existsSync(outputPath)) {
      const tmpOutput = path.join(tmpDir(), `${sha1}_display-${randomId()}.mp4`);
      await transcodeVideo(sourcePath, tmpOutput, {
        filter: ffmpegVideoFilter('display'),
        crf: 34,
        audioBitrateKbps: 64,
        timeout: 12 * 60_000,
      });
      const outputStat = fs.statSync(tmpOutput);
      if (outputStat.size < sourceStat.size) fs.renameSync(tmpOutput, outputPath);
      else fs.rmSync(tmpOutput, { force: true });
    }

    if (!fs.existsSync(outputPath)) return null;
    await mirrorStoredAsset(projectUuid, storedName, outputPath, 'video/mp4');
    const meta = await probeMediaMetadata(outputPath, 'video/mp4', storedName);
    return {
      url: assetUrl(projectUuid, storedName),
      byteSize: fs.statSync(outputPath).size,
      meta,
      sourceMimeType,
    };
  } catch (error) {
    console.warn(`display video compression failed for ${projectUuid}/${sha1}:`, error.message);
    return null;
  }
}

function seedanceReferenceSpec(meta, referenceRule = DEFAULT_SEEDANCE_REFERENCE_RULE) {
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  const byteSize = Number(meta?.byteSize);
  const durationSec = Number(meta?.durationSec);
  const ratio = width > 0 && height > 0 ? width / height : 1;
  const pixels = width > 0 && height > 0 ? width * height : 0;
  const extension = String(meta?.extension || '').toLowerCase();

  const minPixels = Number(referenceRule.minPixels || DEFAULT_SEEDANCE_REFERENCE_RULE.minPixels);
  const maxPixels = Number(referenceRule.maxPixels || DEFAULT_SEEDANCE_REFERENCE_RULE.maxPixels);
  const maxBytes = Number(referenceRule.maxBytes || DEFAULT_SEEDANCE_REFERENCE_RULE.maxBytes);
  const minAspectRatio = Number(referenceRule.minAspectRatio || DEFAULT_SEEDANCE_REFERENCE_RULE.minAspectRatio || 0.4);
  const maxAspectRatio = Number(referenceRule.maxAspectRatio || DEFAULT_SEEDANCE_REFERENCE_RULE.maxAspectRatio || 2.5);

  return {
    extension,
    width,
    height,
    byteSize,
    durationSec,
    ratio,
    pixels,
    validExtension: !extension || extension === 'mp4' || extension === 'mov',
    validRatio: !Number.isFinite(ratio) || (ratio >= minAspectRatio && ratio <= maxAspectRatio),
    validPixels: !pixels || (pixels >= minPixels && pixels <= maxPixels),
    validBytes: !Number.isFinite(byteSize) || byteSize <= maxBytes,
  };
}

/**
 * 参考视频要不要重新编码。**没超上限的一律原样用，一帧都不动**（2026-08-24 用户要求）。
 *
 * 只在重编码**真能解决问题**时才动它：
 *   - 容器不是 mp4/mov → 必须转，provider 只认这两种；
 *   - 像素**超过上限** → 必须缩；
 *   - 体积超过上限 → 必须降码率。
 *
 * 刻意**不**因为「像素低于下限」而重编码：那种情况 ffmpeg 只能把画面放大，
 * 放大加不回细节，只多叠一层压缩伤害 —— 纯亏。这是这次修掉的两个问题之一，
 * 原来用的是 `!spec.validPixels`，而那个标志同时管上下限。
 */
function shouldPrepareSeedanceReference(meta, referenceRule = DEFAULT_SEEDANCE_REFERENCE_RULE) {
  const spec = seedanceReferenceSpec(meta, referenceRule);
  const maxPixels = Number(referenceRule.maxPixels || DEFAULT_SEEDANCE_REFERENCE_RULE.maxPixels);
  const overPixels = spec.pixels > 0 && spec.pixels > maxPixels;
  return !spec.validExtension || overPixels || !spec.validBytes;
}

async function probeMediaMetadata(filePath, fallbackMimeType = '', fallbackName = '', options = {}) {
  const safePath = String(filePath || '');
  const safeName = String(fallbackName || path.basename(safePath));
  const mimeType = fallbackMimeType || mimeTypeFromName(safeName || safePath);
  const kind = assetKindFromMime(mimeType, safeName || safePath);
  const stat = fs.existsSync(safePath) ? fs.statSync(safePath) : null;
  const meta = {
    kind,
    mimeType,
    byteSize: stat?.size || 0,
    extension: fileExtension(safeName || safePath),
  };

  if (!safePath || !fs.existsSync(safePath)) return meta;

  if (kind === 'image') {
    const sharp = getSharp();
    if (sharp) {
      try {
        const imageMeta = await sharp(safePath).metadata();
        if (Number.isFinite(imageMeta.width) && imageMeta.width > 0) meta.width = Number(imageMeta.width);
        if (Number.isFinite(imageMeta.height) && imageMeta.height > 0) meta.height = Number(imageMeta.height);
      } catch {
        // ignore probing failure
      }
    }
    return meta;
  }

  if (kind === 'video' || kind === 'audio' || options.probeAv === true) {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v', 'error',
          // avg_frame_rate 是给「参考视频要不要降帧」用的：源本来就 <=24fps 就不该再重采样
          '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate',
          '-of', 'json',
          safePath,
        ],
        { timeout: 30_000 }
      );
      const payload = JSON.parse(stdout || '{}');
      const formatName = String(payload?.format?.format_name || '').trim();
      if (formatName) meta.formatName = formatName;
      const durationSec = Number(payload?.format?.duration);
      if (Number.isFinite(durationSec) && durationSec > 0) {
        meta.durationSec = Number(durationSec.toFixed(3));
      }
      const videoStream = Array.isArray(payload?.streams)
        ? payload.streams.find((stream) => stream?.codec_type === 'video')
        : null;
      if (videoStream) {
        meta.kind = 'video';
        if (String(meta.mimeType || '').toLowerCase() === 'application/octet-stream') {
          meta.mimeType = formatName.toLowerCase().split(',').includes('mp4')
            ? 'video/mp4'
            : mimeTypeFromName(safeName || safePath);
        }
        const codecName = String(videoStream.codec_name || '').trim().toLowerCase();
        const codecProfile = String(videoStream.profile || '').trim();
        const pixelFormat = String(videoStream.pix_fmt || '').trim().toLowerCase();
        if (codecName) meta.codecName = codecName;
        if (codecProfile) meta.codecProfile = codecProfile;
        if (pixelFormat) meta.pixelFormat = pixelFormat;
        const width = Number(videoStream.width);
        const height = Number(videoStream.height);
        if (Number.isFinite(width) && width > 0) meta.width = width;
        if (Number.isFinite(height) && height > 0) meta.height = height;
        // ffprobe 给的是 "30000/1001" 这种分数式，自己算成小数；算不出就不写这个字段，
        // 下游会按"读不出帧率"保守处理。
        const [num, den] = String(videoStream.avg_frame_rate || '').split('/');
        const fps = Number(den) > 0 ? Number(num) / Number(den) : Number(num);
        if (Number.isFinite(fps) && fps > 0) meta.fps = Number(fps.toFixed(3));
      }
      const audioStream = Array.isArray(payload?.streams)
        ? payload.streams.find((stream) => stream?.codec_type === 'audio')
        : null;
      if (audioStream) {
        if (!videoStream) meta.kind = 'audio';
        const audioCodecName = String(audioStream.codec_name || '').trim().toLowerCase();
        if (audioCodecName) meta.audioCodecName = audioCodecName;
      }
    } catch {
      // ignore probing failure
    }
  }

  return meta;
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.get('host') || '')
    .split(',')[0]
    .trim();
  if (!forwardedHost) return '';
  return `${forwardedProto || 'http'}://${forwardedHost}`;
}

function absoluteUrlFromRequest(req, url) {
  const value = String(url || '').trim();
  if (!value || /^[a-z]+:/i.test(value)) return value;
  const origin = requestOrigin(req);
  if (!origin) return value;
  try {
    return new URL(value.startsWith('/') ? value : `/${value}`, origin).toString();
  } catch {
    return value;
  }
}

async function resolveAssetPublicUrlForExternalUse(req, url, projectUuid) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;

  if (value.startsWith('/assets/')) {
    const source = await resolveLocalAssetProject(req, value, projectUuid);
    const storedName = source.storedName;
    const localPath = await ensureAssetLocalPath(source.projectUuid, storedName);
    if (objectStore.isRemoteEnabled && objectStore.publicBaseUrl) {
      if (!fs.existsSync(localPath)) {
        throw new Error(`闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬⒑閻熸澘鈷旂紒顕呭灦瀹曟垿骞囬悧鍫㈠幈闂佸綊鍋婇崹鎵閿曞倹鐓熼柕蹇曞閻撳吋鎱ㄦ繝鍕笡缂佹鍠栭崺鈧い鎺嗗亾妞ゎ厼娲╅ˇ褰掓寠濠靛洢浜滈柟鏉垮閻ｉ亶鏌ｉ妶鍥т壕缂佺粯鐩獮瀣倷鐠轰警妫熸俊鐐€戦崕鎻掔暆閹间礁钃熼柨婵嗩槹閸嬪嫮绱掔€ｎ偄顕滈柣婵堟暬閹嘲顭ㄩ崨顓ф毉闁汇埄鍨遍〃濠傜暦閹达箑绠涙い鏃傛嚀娴滈箖鏌ｉ悢鍛婄凡妞ゃ儱绻橀弻娑㈡偐瀹曞洤鈷岄悗瑙勬礃缁秶鈧絻鍋愰埀顒佺⊕鑿ら柟鐤缁辨捇宕掑▎鎴濆闂佹寧姘ㄧ槐鎺懳旀担鍛婅癁闂佸搫鐭夌紞鈧紒鐘崇洴瀵剟宕归鑺ュ殘婵犵數濮烽。顔炬閺囥垹鏋侀悹鍥皺閺嗭箓鏌ｉ弮鍌楁嫛闁轰礁绉甸幈銊ヮ潨閳ь剛娑甸幖浣歌埞婵炲樊浜濋埛鎺懨归敐鍫燁仩闁靛棗锕弻娑㈠箻鐎靛摜鐤勬繝纰夌磿閺佸骞冨▎鎴斿亾闂堟稒鎲哥憸浼寸畺濮婃椽宕崟顒€鍋嶉梺鎼炲妽濡炰粙宕哄☉銏犵闁圭偨鍔岀紞濠囧极閹版澘宸濇い鏂垮悑濞堟﹢姊绘担鐑樺殌鐎殿喖鐖奸獮鍐磼閻愯尪鎽曞┑鐐村灟閸ㄦ椽宕戦幇鐗堢厱闁归偊鍘肩徊缁樸亜椤愩垻肖缂佽鲸鎸婚幏鍛喆閸曘劍瀚介梻浣告憸婵敻鎮ч弴銏″仼闁绘垼妫勭涵鈧梺缁樺姀閺呮粓鎮楁繝姘棅妞ゆ劑鍨烘径鍕煙閸濄儱浜剧紒鍌氱У鐎佃偐鈧稒菤閹风粯绻涙潏鍓ф偧妞ゎ厼鐗撹棢闊洦绋掗悡鏇㈡倵閿濆簼绨奸柛锝勭矙閺岀喖鐛崹顔句紙閻庤娲滈崰鏍€佸☉姗嗘僵妞ゆ搫绱曢崣鎴︽⒒閸屾瑨鍏岀痪顓炵埣瀹曟粌鈹戦崼銏㈢厯闂佸湱鍎ら〃鍡涘磻閸岀偞鐓涢柛銉ｅ劚閻忣亪鏌ｉ幘瀵告创闁哄本鐩俊鐑芥晲閸涱厼顫撳┑鐘殿暜缁辨洟宕㈣濠€浣糕攽閻樿宸ラ柟鍐插缁傛帒顭ㄩ崼鐔稿殙闂佸搫绋侀崢浠嬫偂閻旈晲绻嗘い鏍ㄧ閹牏绱掗悪娆忔处閻撴洟鏌ｅΟ璇茬亣闁硅揪绠戠粻鐐烘煏婵犲繐顩紒鈾€鍋撻梻浣规偠閸庮噣寮插┑鍫㈢幓婵°倕鎳忛埛鎴︽⒒閸喓鈯曞璺哄閺屾盯寮埀顒勬偡閳哄懏鍋樻い鏇楀亾妤犵偞甯掕灃闁逞屽墰缁鏁愰崱娆戠槇婵犵數濮撮崐鎼佸汲閻愮儤鐓熼幖娣€栭悵顏嗙磼缂佹绠為柟顔荤矙濡啫鈽夊Δ鍐╁礋闂傚倷绀侀浠嬪级閸噮鐎烽梻浣告啞鐢鏁Δ鍛畾闁哄啫鐗嗘儫闂侀潧锛忓鍥ц€块梻鍌氬€风欢姘焽瑜旈幃褔宕卞ù鏉挎喘椤㈡稑顭ㄩ崨顒傜憹闂備礁鎼粙渚€宕戦埀顒勬煕鐎ｎ偅宕岄柟顔惧厴瀵泛鈻庨崣銉ф／婵犵數濮伴崹濠氬箠閹炬椿鏁勫璺侯煬閸ゆ洟鏌曟繝蹇擃洭妞も晝鍏橀幃妤呮晲鎼粹€茬盎闂侀€炲苯澧伴柡浣割煼瀵濡搁妷銏℃杸闂佺硶鍓濇笟妤呭焵椤掍緡娈旈棁澶嬬節婵犲倸顏柣顓熷浮閺岋紕浠﹂悾灞濄儲銇勮缁舵岸寮诲☉銏犵閻庨潧鎲￠崳浼存⒑鐠団€虫灍闁挎碍銇勯锝囩畺婵炵厧绻樻俊鎼佸Ψ閵壯冩惛婵犵數濮烽弫鎼佸磻閻愬搫鍨傛い鏍仜閸ㄥ倿鏌涢敂璇插箻濞戞挸绉归弻銊モ攽閸♀晜效闂佺粯鎸鹃崰鏍蓟閻旇　鍋撳☉娆樼劷缂佺姵鐗楅妵鍕Ψ閿旂偓鍣伴梺鍝勭焿缂嶄焦淇婇悜绛嬫晩闁煎鍊楀▔鎸庝繆閻愵亜鈧倖绂嶅鍫濈柈閻庢稒眉缁诲棝鏌涢锝嗙鐎瑰憡绻冮妵鍕冀閵娧呯厾闂佸摜鍋涢悥鐓庮潖閾忚瀚氶柟缁樺俯閸斿绱掗悙顒佺凡缂佸缍婇悰顕€宕橀鑲╋紲闂佺粯鍔樼亸娆撴偪閸ヮ剚鈷戦悷娆忓缁€鍐┿亜閺囧棗鎳愭稉宥吤归崗鍏肩稇缂佺姴缍婇幃妤€鈽夊▎妯煎姺闂佸磭顑曢崕宕囨閹烘惟闁靛鍠氶崥瀣攽閳藉棗浜滈柟铏耿閵嗕線寮撮姀鐙€娼婇梺鐐藉劜閸撴艾危闁秵鈷掑ù锝囧劋閸も偓闂佺濮ょ划鎾崇暦閹达箑绠婚悹鍥皺閺屟囨煟閻樿崵绱伴柕鍡忓亾濠碘剝褰冮悧鎾诲蓟閺囷紕鐤€闁靛／鍜冪吹闂?{storedName}`);
      }
      await mirrorStoredAsset(source.projectUuid, storedName, localPath, mimeTypeFromName(storedName));
      const publicUrl = objectStore.publicUrlForAsset(source.projectUuid, storedName);
      if (publicUrl) return publicUrl;
    }
  }

  return absoluteUrlFromRequest(req, value);
}

async function probeSeedanceReferenceVideo(url, projectUuid, req = null) {
  const value = String(url || '').trim();
  if (!value) return null;

  let filePath = '';
  let cleanup = false;
  let fallbackName = path.basename(value);
  let fallbackMimeType = mimeTypeFromName(fallbackName);

  try {
    if (/^https?:\/\//i.test(value)) {
      const tmpBase = path.join(tmpDir(), `${randomId()}-seedance-ref`);
      const downloaded = await downloadRemoteAsset(value, tmpBase);
      filePath = downloaded.filePath;
      cleanup = true;
      fallbackName = path.basename(downloaded.filePath);
      fallbackMimeType = downloaded.contentType || mimeTypeFromName(fallbackName);
    } else if (value.startsWith('/assets/')) {
      const source = await resolveLocalAssetProject(req, value, projectUuid);
      const storedName = source.storedName;
      filePath = await ensureAssetLocalPath(source.projectUuid, storedName);
      fallbackName = storedName;
      fallbackMimeType = mimeTypeFromName(storedName);
    } else if (fs.existsSync(value)) {
      filePath = value;
      fallbackName = path.basename(value);
      fallbackMimeType = mimeTypeFromName(fallbackName);
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return {
        kind: 'video',
        mimeType: fallbackMimeType,
        extension: fileExtension(fallbackName || value),
      };
    }

    return await probeMediaMetadata(filePath, fallbackMimeType, fallbackName || filePath);
  } finally {
    if (cleanup && filePath) fs.rmSync(filePath, { force: true });
  }
}

async function validateSeedanceReferenceVideos(urls, projectUuid) {
  const refs = (urls || []).filter(Boolean);
  const allowedDimensions = new Set([480, 720]);
  if (refs.length > SEEDANCE_REFERENCE_MAX_COUNT) {
    throw new Error('闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬⒑閻熸澘鈷旂紒顕呭灦瀹曟垿骞囬悧鍫㈠幈闂佸綊鍋婇崹鎵閿曞倹鐓熼柕蹇曞閻撳吋鎱ㄦ繝鍕笡缂佹鍠栭崺鈧い鎺嗗亾妞ゎ厼娲╅ˇ褰掓寠濠靛洢浜滈柟鏉垮閻ｉ亶鏌ｉ妶鍥т壕缂佺粯鐩獮瀣倷鐠轰警妫熸俊鐐€戦崕鎻掔暆閹间礁钃熼柨婵嗩槹閸嬪嫮绱掔€ｎ偄顕滈柣婵堟暬閹嘲顭ㄩ崨顓ф毉闁汇埄鍨遍〃濠傜暦閹达箑绠涙い鏃傛嚀娴滈箖鏌ｉ悢鍛婄凡妞ゃ儱绻橀弻娑㈡偐瀹曞洤鈷岄悗瑙勬礃缁秶鈧絻鍋愰埀顒佺⊕鑿ら柟鐤缁辨捇宕掑▎鎴濆闂佹寧姘ㄧ槐鎺懳旀担鍛婅癁闂佸搫鐭夌紞鈧紒鐘崇洴瀵剟宕归鑺ュ殘婵犵數濮烽。顔炬閺囥垹鏋侀悹鍥皺閺嗭箓鏌ｉ弮鍌楁嫛闁轰礁绉甸幈銊ヮ潨閳ь剛娑甸幖浣歌埞婵炲樊浜濋埛鎺懨归敐鍫燁仩闁靛棗锕弻娑㈠箻鐎靛摜鐤勬繝纰夌磿閺佸骞冨▎鎴斿亾闂堟稒鎲哥憸浼寸畺濮婃椽宕崟顒€鍋嶉梺鎼炲妽濡炰粙宕哄☉銏犵闁圭偨鍔岀紞濠囧极閹版澘宸濇い鏂垮悑濞堟﹢姊绘担鐑樺殌鐎殿喖鐖奸獮鍐磼閻愯尪鎽曞┑鐐村灟閸ㄦ椽宕戦幇鐗堢厱闁归偊鍘肩徊缁樸亜椤愩垻肖缂佽鲸鎸婚幏鍛存惞閻熸壆顐肩紓鍌欑椤戝棛鏁悙鍝勭闁靛繒濮弨浠嬫倵閿濆簼绨介柛濠勫仱濮婃椽妫冨☉杈╁彋闂傚倸瀚€氫即骞冮悽绋跨闁兼亽鍎幏缁樼箾鏉堝墽绉繛鍜冪悼閺侇喖鈽夐姀锛勫幈闂佸搫鍟犻崑鎾淬亜閵娿儻韬┑鈩冩尦瀹曟帒鈽夊鍏肩カ闂佽鍑界紞鍡樼閻愮儤鏅繛鎴欏灪閳锋垿鏌ｉ悢鍛婄凡闁抽攱姊荤槐鎺楊敋閸涱厾浠搁悗娈垮枟閻撯€愁嚕婵犳艾唯闁靛／灞芥櫍缂傚倸鍊风欢锟犲窗閺嶎厼鍌ㄦ繝濠傜墕绾惧鏌熼幑鎰靛殭缂佺姷鏁婚弻鐔兼倻濡偐鐣哄銈冨劵缁辨洜妲愰幘璇茬＜婵﹩鍏橀崑鎾诲箹娴ｅ摜锛欓梺缁樺灱婵倝宕愰崸妤佺叆闁哄洨鍋涢埀顒佹倐閹虫粏銇愰幒鎾跺幘婵犳鍠楅崝鏇㈠焵椤掍緡娈樼紒顔肩墛缁绘繈宕掑Ο宄颁壕闁圭儤鍩堝鈺呮煥濠靛棙鍣稿瑙勬礋閺岋絾鎯旈姀鈺佹櫛闂佸摜濮甸悧鐘诲灳閿曞倹鍊婚柦妯侯槺閻ｆ椽姊洪棃娑氱疄闁搞劍妞藉畷鎴濐潨閳ь剟寮诲澶娢ㄩ柕澶堝劚缁楊厽绻濋姀锝庢綈婵炶尙鍠庨～蹇涘传閸曟嚪鍥х倞鐟滃繑绂掗幆褜娓婚柕鍫濇閳锋劙鏌ｅΔ鍐ㄢ枅妤犵偛鍟撮幃娆撳传閸曨厾鏆版俊鐐€ら崗姗€鍩€椤掆偓绾绢厾绮斿ú顏呯厵妞ゆ洖鎳嶉柇顖溾偓瑙勬磸閸旀垿銆佸☉姗嗙叆闁告洦鍓﹂崯鍛存⒒閸屾艾鈧悂宕愮粙妫垫椽濡舵竟锕€娲幃鐣岀矙閼愁垱鎲伴梻浣瑰缁诲倿骞夊鈧幃銏ゆ倻濡櫣锛忛梻渚€娼ч敃銉╁礉閺嶎偄鍨濈€广儱顦闂佸憡娲﹂崰姘舵偪閳ь剟姊虹憴鍕婵炲鐩妴鍌炴偨閸涘ň鎷洪梻渚囧亞閸嬫盯鎳熼娑欐珷闁告挆鍛紲闂佺粯顭堝▍鏇犱焊椤撱垺鐓熼柨婵嗩樈濡垹绱掗鐣屾噮闁归濞€閹瑩顢楁担鍙夊闂備胶鎳撻崲鏌ュ箠濡櫣鏆﹂柕濠忓缁♀偓闂佸憡娲﹂崜姘辨椤撱垺鈷掗柛灞捐壘閳ь剚鎮傚畷鎰版倻閼恒儱鈧潡鏌ㄩ弴鐐测偓褰掑磿閹寸姵鍠愰柣妤€鐗嗙粭鎺楁煕閵娿儱鈧湱鎹㈠☉姗嗗晠妞ゆ梻绮崰姘舵⒑鏉炴壆顦﹂柨鏇ㄤ邯瀵鍨鹃幇浣告倯闁硅偐琛ラ埀顒€纾鎰節濞堝灝鏋︽い顐㈩樀閹繝鏁撻悩鑼舵憰闂侀潧艌閺呮粓宕戦崟顖涚厱婵犻潧妫楅悵鏃堟煥濠靛棭妲归柣鎾冲暣濮婃椽宕归鍛壈闂佽绻愰顓㈠焵椤掍緡鍟忛柛鐘崇墵閹儲绺界粙璺ㄧ暫濠电偛妫欓幐鍝ョ棯瑜旈弻鐔煎箹椤撶偛绠哄銈冨劚椤戝顫忓ú顏呭殥闁靛牆鎲涢敐澶嬬厱闁哄啠鍋撻悽顖椻偓宕囨殾闁跨喓濮寸粻顕€鏌﹀Ο渚Ъ闁硅姤娲栭埞鎴︽倷閺夋垹浠ч梺鎼炲妽濡炶棄顕ｉ弻銉ヨ摕闁靛／鍐ㄧ导闂備焦鎮堕崕顖炲礉瀹ュ洨鐭嗛柛顐犲灪閸嬫牠鏌ㄩ弴鐐测偓褰掑煕?3 濠?');
  }

  let totalDuration = 0;
  for (let index = 0; index < refs.length; index += 1) {
    const meta = await probeSeedanceReferenceVideo(refs[index], projectUuid);
    const extension = String(meta?.extension || '').toLowerCase();
    if (extension && !['mp4', 'mov'].includes(extension)) {
      throw new Error(`闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬⒑閻熸澘鈷旂紒顕呭灦瀹曟垿骞囬悧鍫㈠幈闂佸綊鍋婇崹鎵閿曞倹鐓熼柕蹇曞閻撳吋鎱ㄦ繝鍕笡缂佹鍠栭崺鈧い鎺嗗亾妞ゎ厼娲╅ˇ褰掓寠濠靛洢浜滈柟鏉垮閻ｉ亶鏌ｉ妶鍥т壕缂佺粯鐩獮瀣倷鐠轰警妫熸俊鐐€戦崕鎻掔暆閹间礁钃熼柨婵嗩槹閸嬪嫮绱掔€ｎ偄顕滈柣婵堟暬閹嘲顭ㄩ崨顓ф毉闁汇埄鍨遍〃濠傜暦閹达箑绠涙い鏃傛嚀娴滈箖鏌ｉ悢鍛婄凡妞ゃ儱绻橀弻娑㈡偐瀹曞洤鈷岄悗瑙勬礃缁秶鈧絻鍋愰埀顒佺⊕鑿ら柟鐤缁辨捇宕掑▎鎴濆闂佹寧姘ㄧ槐鎺懳旀担鍛婅癁闂佸搫鐭夌紞鈧紒鐘崇洴瀵剟宕归鑺ュ殘婵犵數濮烽。顔炬閺囥垹鏋侀悹鍥皺閺嗭箓鏌ｉ弮鍌楁嫛闁轰礁绉甸幈銊ヮ潨閳ь剛娑甸幖浣歌埞婵炲樊浜濋埛鎺懨归敐鍫燁仩闁靛棗锕弻娑㈠箻鐎靛摜鐤勬繝纰夌磿閺佸骞冨▎鎴斿亾闂堟稒鎲哥憸浼寸畺濮婃椽宕崟顒€鍋嶉梺鎼炲妽濡炰粙宕哄☉銏犵闁圭偨鍔岀紞濠囧极閹版澘宸濇い鏂垮悑濞堟﹢姊绘担鐑樺殌鐎殿喖鐖奸獮鍐磼閻愯尪鎽曞┑鐐村灟閸ㄦ椽宕戦幇鐗堢厱闁归偊鍘肩徊缁樸亜椤愩垻肖缂佽鲸鎸婚幏鍛存惞閻熸壆顐肩紓鍌欑椤戝棛鏁悙鍝勭闁靛繒濮弨浠嬫倵閿濆簼绨介柛濠勫仱濮婃椽妫冨☉杈╁彋闂傚倸瀚€氫即骞冮悽绋跨闁兼亽鍎幏缁樼箾鏉堝墽绉繛鍜冪悼閺侇喖鈽夐姀锛勫幈闂佸搫鍟犻崑鎾淬亜閵娿儻韬┑鈩冩尦瀹曟帒鈽夊鍏肩カ闂佽鍑界紞鍡樼閻愮儤鏅繛鎴欏灪閳锋垿鏌ｉ悢鍛婄凡闁抽攱姊荤槐鎺楊敋閸涱厾浠搁悗娈垮枟閻撯€愁嚕婵犳艾唯闁靛／灞芥櫍缂傚倸鍊风欢锟犲窗閺嶎厼鍌ㄦ繝濠傜墕绾惧鏌熼幑鎰靛殭缂佺姷鏁婚弻鐔兼倻濡偐鐣哄銈冨劵缁辨洜妲?${index + 1} 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣閿濆棭妫勯梺鍝勵儎缁舵岸寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閹冣挃缂侇噮鍨抽幑銏犫槈閵忕姷顓哄┑鐐叉缁绘帡宕濋幘顔解拺閺夌偞澹嗛ˇ锔姐亜閹存繃顥㈠┑锛勬暬瀹曠喖顢涘槌栧晪闂佽崵濮惧▍锝夊磿閵堝鍊靛Δ锝呭暞閳锋垿鏌涘☉姗堝姛闁瑰啿鍟扮槐鎺旂磼濮楀牐鈧法鈧鍠栭…鐑藉箖閵忋倖鎯為柛锔诲弿缁辨煡姊绘笟鈧褏鎹㈤幒鎾村弿闁汇垹鎲￠崐鍫曟煕椤愮姴鐏痪鎹愭闇夐柨婵嗘噺閹牓宕崨濠勭瘈闁汇垽娼ф禍褰掓煕鐎ｎ偅宕屾慨濠呮缁辨帒螣缂佹ê鍓梻浣侯焾椤戝懘鏁冮妶澶嬪仼闁绘垼妫勯柋鍥煛閸モ晛鈧綁鍩￠崘鈺佹瀾婵犮垼娉涜癌闁挎繂顦柋鍥煏婢舵稖鍚傞柟閿嬫そ濮婃椽宕ㄦ繝鍕暤闁诲孩姘ㄩ崗妯虹暦閺囩喐鍎熼柕濠忓閸樹粙姊虹涵鍛仩闁稿鍠栭幃楣冩濞戞帗鏂€闂佹寧绋戠€氼參寮抽鍌楀亾鐟欏嫭绀堥柛鐘崇墵閵嗕礁鈽夊鍡樺兊濡炪倖宸婚崑鎾剁磼娓氬洤鏋熺紒缁樼箓椤曘儵鏌ㄧ€ｎ偆鍑￠梺閫炲苯澧柛鏃€鐟ラ悾鐑藉箣閿曗偓缁犲鎮洪幒宥堝厡闁硅櫕鎹囬垾锕傚Ω閳轰胶顦板銈嗗姂閸ㄧ顣介梻?mp4 / mov`);
    }

    const width = Number(meta?.width);
    const height = Number(meta?.height);
    if (
      Number.isFinite(width) &&
      width > 0 &&
      Number.isFinite(height) &&
      height > 0 &&
      !allowedDimensions.has(width) &&
      !allowedDimensions.has(height)
    ) {
      throw new Error(`闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬⒑閻熸澘鈷旂紒顕呭灦瀹曟垿骞囬悧鍫㈠幈闂佸綊鍋婇崹鎵閿曞倹鐓熼柕蹇曞閻撳吋鎱ㄦ繝鍕笡缂佹鍠栭崺鈧い鎺嗗亾妞ゎ厼娲╅ˇ褰掓寠濠靛洢浜滈柟鏉垮閻ｉ亶鏌ｉ妶鍥т壕缂佺粯鐩獮瀣倷鐠轰警妫熸俊鐐€戦崕鎻掔暆閹间礁钃熼柨婵嗩槹閸嬪嫮绱掔€ｎ偄顕滈柣婵堟暬閹嘲顭ㄩ崨顓ф毉闁汇埄鍨遍〃濠傜暦閹达箑绠涙い鏃傛嚀娴滈箖鏌ｉ悢鍛婄凡妞ゃ儱绻橀弻娑㈡偐瀹曞洤鈷岄悗瑙勬礃缁秶鈧絻鍋愰埀顒佺⊕鑿ら柟鐤缁辨捇宕掑▎鎴濆闂佹寧姘ㄧ槐鎺懳旀担鍛婅癁闂佸搫鐭夌紞鈧紒鐘崇洴瀵剟宕归鑺ュ殘婵犵數濮烽。顔炬閺囥垹鏋侀悹鍥皺閺嗭箓鏌ｉ弮鍌楁嫛闁轰礁绉甸幈銊ヮ潨閳ь剛娑甸幖浣歌埞婵炲樊浜濋埛鎺懨归敐鍫燁仩闁靛棗锕弻娑㈠箻鐎靛摜鐤勬繝纰夌磿閺佸骞冨▎鎴斿亾闂堟稒鎲哥憸浼寸畺濮婃椽宕崟顒€鍋嶉梺鎼炲妽濡炰粙宕哄☉銏犵闁圭偨鍔岀紞濠囧极閹版澘宸濇い鏂垮悑濞堟﹢姊绘担鐑樺殌鐎殿喖鐖奸獮鍐磼閻愯尪鎽曞┑鐐村灟閸ㄦ椽宕戦幇鐗堢厱闁归偊鍘肩徊缁樸亜椤愩垻肖缂佽鲸鎸婚幏鍛存惞閻熸壆顐肩紓鍌欑椤戝棛鏁悙鍝勭闁靛繒濮弨浠嬫倵閿濆簼绨介柛濠勫仱濮婃椽妫冨☉杈╁彋闂傚倸瀚€氫即骞冮悽绋跨闁兼亽鍎幏缁樼箾鏉堝墽绉繛鍜冪悼閺侇喖鈽夐姀锛勫幈闂佸搫鍟犻崑鎾淬亜閵娿儻韬┑鈩冩尦瀹曟帒鈽夊鍏肩カ闂佽鍑界紞鍡樼閻愮儤鏅繛鎴欏灪閳锋垿鏌ｉ悢鍛婄凡闁抽攱姊荤槐鎺楊敋閸涱厾浠搁悗娈垮枟閻撯€愁嚕婵犳艾唯闁靛／灞芥櫍缂傚倸鍊风欢锟犲窗閺嶎厼鍌ㄦ繝濠傜墕绾惧鏌熼幑鎰靛殭缂佺姷鏁婚弻鐔兼倻濡偐鐣哄銈冨劵缁辨洜妲?${index + 1} 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬倵楠炲灝鍔氭い锔诲灣缁牏鈧綆鍋佹禍婊堟煙閸濆嫮肖闁告柨绉甸妵鍕棘閹稿骸鏋犲┑顔硷功缁垶骞忛崨鏉戝窛濠电姴鎳愰、鍛存⒒娴ｄ警鐒剧紒銊︽そ瀹曟劕鈹戦崱娆愭闂佹眹鍨归幉锟犲疾濠靛鐓冪憸婊堝礈閻旂厧鏄ラ柕澶涚畱缁剁偛鈹戦悩鎻掝劉鐎点倖妞藉铏瑰寲閺囩偛鈷夐梺鑽ゅ枂閸庨亶顢氶敐澶婄闁兼亽鍎幏缁樼箾鏉堝墽鍒伴柟璇х節瀹曨垶鎮欑€靛摜顔曢梺鍦帛鐢偞鏅ラ柣搴㈩問閸犳銇愰崘顔肩厺閹兼番鍔岀粻锝嗙節闂堟稒顥犲ù婊€鍗冲缁樻媴閻戞ê娈屾繝鈷€鍛珪闁告帗甯￠、娑㈡倷閼碱剙骞堥梻浣烘嚀椤曨厽鎱ㄩ悽绋跨獥闁规壆澧楅悡鐔镐繆閵堝倸浜鹃梺缁橆殔濡稓鍒掗鐑嗘僵闁煎摜鏁搁崣鍡椻攽閻愭潙鐏﹂柤褰掔畺瀵鈽夐姀锛勫幐閻庡厜鍋撻悗锝庡墰琚︽俊銈囧Х閸嬬偟鏁敓鐘茬畺婵炲棙鎸婚崑銊╂煕椤垵浜濇い鏃€鎹囧铏规嫚閸欏鏀銈庡亜椤︻垳鍙呭┑顔姐仜閸嬫挾鈧娲栫紞濠囧箖閻ｅ瞼鐭欓悹鎭掑妼楠炲姊绘担鐑樺殌妞ゆ洦鍘介幈銊╊敇閵忕姷锛涢梺鐟板⒔缁垶寮查弻銉ョ缂侇喖鍘滈崑鎾绘嚑椤掍焦娅﹂梻鍌氬€风粈渚€骞夐敓鐘虫櫇闁靛骏绱曢々鏌ユ偣鏉炴媽顒熸繛鍏肩墬缁绘稑顔忛鑽ゅ嚬濡炪們鍎遍悧濠勬崲濞戙垹绠ｉ柨婵嗩槸閹界敻姊哄畷鍥╁笡闁圭懓娲ら～蹇撁洪鍕炊闂侀潧顦崕娑㈡晲婢跺鍘藉┑掳鍊撶欢鈥斥枔濠婂應鍋撳▓鍨灍闁绘挴鈧磭鏆﹀┑鍌滎焾閸楁娊鏌曟繝蹇涙婵炲懏鐗楃换婵嗏枔閸喗鐝紓鍌氱Т濡繂鐣烽姀銈嗗殐闁冲搫鍟伴ˇ顖涚節閻㈤潧孝婵炲眰鍊楃划濠氬冀椤撶喓鍘撻梺鍛婄箓鐎氼剟寮抽悙鐑樼厵妞ゆ牗锚閸旀岸鏌曢崱妯虹瑨妞ゎ偅绻堥、妤佹媴閾忕懓骞€闂傚倸鍊风欢锟犲矗鎼淬劌鍨傞柛顐ｆ礀閽?480p / 720p / 1080p`);
    }

    const durationSec = Number(meta?.durationSec);
    if (Number.isFinite(durationSec)) {
      if (durationSec < 2 || durationSec > 15) {
        throw new Error('Reference video duration must be between 2 and 15 seconds');
      }
      totalDuration += durationSec;
    }
  }

  if (totalDuration > 15.01) {
    throw new Error('闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬⒑閻熸澘鈷旂紒顕呭灦瀹曟垿骞囬悧鍫㈠幈闂佸綊鍋婇崹鎵閿曞倹鐓熼柕蹇曞閻撳吋鎱ㄦ繝鍕笡缂佹鍠栭崺鈧い鎺嗗亾妞ゎ厼娲╅ˇ褰掓寠濠靛洢浜滈柟鏉垮閻ｉ亶鏌ｉ妶鍥т壕缂佺粯鐩獮瀣倷鐠轰警妫熸俊鐐€戦崕鎻掔暆閹间礁钃熼柨婵嗩槹閸嬪嫮绱掔€ｎ偄顕滈柣婵堟暬閹嘲顭ㄩ崨顓ф毉闁汇埄鍨遍〃濠傜暦閹达箑绠涙い鏃傛嚀娴滈箖鏌ｉ悢鍛婄凡妞ゃ儱绻橀弻娑㈡偐瀹曞洤鈷岄悗瑙勬礃缁秶鈧絻鍋愰埀顒佺⊕鑿ら柟鐤缁辨捇宕掑▎鎴濆闂佹寧姘ㄧ槐鎺懳旀担鍛婅癁闂佸搫鐭夌紞鈧紒鐘崇洴瀵剟宕归鑺ュ殘婵犵數濮烽。顔炬閺囥垹鏋侀悹鍥皺閺嗭箓鏌ｉ弮鍌楁嫛闁轰礁绉甸幈銊ヮ潨閳ь剛娑甸幖浣歌埞婵炲樊浜濋埛鎺懨归敐鍫燁仩闁靛棗锕弻娑㈠箻鐎靛摜鐤勬繝纰夌磿閺佸骞冨▎鎴斿亾闂堟稒鎲哥憸浼寸畺濮婃椽宕崟顒€鍋嶉梺鎼炲妽濡炰粙宕哄☉銏犵闁圭偨鍔岀紞濠囧极閹版澘宸濇い鏂垮悑濞堟﹢姊绘担鐑樺殌鐎殿喖鐖奸獮鍐磼閻愯尪鎽曞┑鐐村灟閸ㄦ椽宕戦幇鐗堢厱闁归偊鍘肩徊缁樸亜椤愩垻肖缂佽鲸鎸婚幏鍛存惞閻熸壆顐肩紓鍌欑椤戝棛鏁悙鍝勭闁靛繒濮弨浠嬫倵閿濆簼绨介柛濠勫仱濮婃椽妫冨☉杈╁彋闂傚倸瀚€氫即骞冮悽绋跨闁兼亽鍎幏缁樼箾鏉堝墽绉繛鍜冪悼閺侇喖鈽夐姀锛勫幈闂佸搫鍟犻崑鎾淬亜閵娿儻韬┑鈩冩尦瀹曟帒鈽夊鍏肩カ闂佽鍑界紞鍡樼閻愮儤鏅繛鎴欏灪閳锋垿鏌ｉ悢鍛婄凡闁抽攱姊荤槐鎺楊敋閸涱厾浠搁悗娈垮枟閻撯€愁嚕婵犳艾唯闁靛／灞芥櫍缂傚倸鍊风欢锟犲窗閺嶎厼鍌ㄦ繝濠傜墕绾惧鏌熼幑鎰靛殭缂佺姷鏁婚弻鐔兼倻濡偐鐣哄銈冨劵缁辨洜妲愰幘璇茬＜婵﹩鍏橀崑鎾诲箹娴ｅ摜锛欓梺缁樺灱婵倝宕愰崸妤佺叆闁哄洨鍋涢埀顒佹倐閹虫粏銇愰幒鎾跺幘婵犳鍠楅崝鏇㈠焵椤掍緡娈樼紒顔肩墛缁绘繈宕掑Ο宄颁壕闁圭儤鍩堝鈺呮煥濠靛棙鍣稿瑙勬礋閺岋絾鎯旈姀鈺佹櫛闂佸摜濮甸悧鐘诲灳閿曞倹鍊婚柦妯侯槺閻ｆ椽姊洪棃娑氱疄闁搞劍妞藉畷鎴濐潨閳ь剟寮诲澶娢ㄩ柕澶堝劚缁楊厽绻濋姀锝庢綈婵炶尙鍠庨～蹇涘传閸曟嚪鍥х倞鐟滃繑绂掗幆褜娓婚柕鍫濇閳锋劙鏌ｅΔ鍐ㄢ枅妤犵偛鍟撮幃娆撳传閸曨厾鏆版俊鐐€ら崜銊ф閺囥垹绠犻柟鍓у劦閳ь剨绠撴俊鎼佸煛娴ｄ警妲版俊鐐€曠换鎰板蓟婵犲洤惟闁冲搫鍊甸幏娲⒑閸涘﹦绠撻悗姘煎幖閿曘垽骞嶉鍓э紲闁诲函缍嗛崑鍛暦瀹€鍕厱闁宠鍎虫禍鐐繆閻愵亜鈧牜鏁幒妤佹櫇闁挎柨澧介惌鎾绘煟閵忕姵鍟為柣鎾存礋閹鏁愭惔婵堝嚬闂侀潻缍€濡嫰婀佸┑鐘诧工鐎氼參宕愰幇鐗堢厵妞ゆ棁宕甸惌娆撴煙椤旇崵鐭欓柟顔炬櫕閸犲﹥寰勭仦鐣屽搸闂傚倸鍊风粈渚€骞栭位鍥敍閻愭潙浜遍梺鍛婃处閸ㄦ壆绮堟径灞稿亾閸忓浜鹃梺閫炲苯澧伴柛鎺撳浮椤㈡﹢濮€閻樻鍞烘繝寰锋澘鈧捇鎮為敃鍌氬惞濠㈣埖鍔栭埛鎴︽煙缁嬫寧鎹ｇ紒鐘虫尰娣囧﹪顢曢敐鍥モ偓鎺旂磼椤斿墽甯涢柕鍫秮瀹曟﹢鍩￠崘銊ョ缂傚倷鑳堕崑鎾愁熆濡櫣鏆︽い鎺嶇劍濞呯姴霉閻撳海鎽犻柛瀣ㄥ妽閵囧嫰寮介妸褋鈧帡鏌曢崱妯烘诞闁哄瞼鍠栭、姘跺川椤撶喓浠屾俊鐐€х粻鎺楋綖婢舵劕绠為柕濠忓缁♀偓闂佺琚崐妤呭触鐎ｎ喗鍊甸悷娆忓缁€鍐偨椤栨稑娴柨婵堝仜閳规垹鈧絽鐏氶弲鐐烘⒑閼恒儍顏埶囬鐣岀彾闁哄洢鍨洪埛鎴犳喐閻楀牆绗氶柨娑氬枔缁辨帡鍩€椤掍焦濯撮柛婵嗗濡粓鎮峰鍛暭閻㈩垱顨婇幃锟犳偄閸忚偐鍘棅顐㈡搐椤戝懘鎮炲ú顏呯厽闁圭儤鍨甸埛鏃堟煟閵夘喕閭鐐叉椤т線鏌ｉ幘鐐藉仮闁哄备鈧磭鏆嗛柍褜鍓熷畷浼村冀椤撶偟鐣哄┑鐐叉閹尖晠寮崱娑欑厓鐟滄粓宕滃璺虹柧闁割偅娲﹂弫宥夋煟閹邦剦鍤熼柛妯圭矙濮婃椽宕崟顐熷亾閸︻厸鍋撶粭娑樻硽婢舵劕顫呴柕鍫濇閸橀潧顪冮妶鍡橆梿闁稿鍔楃划鏂棵洪鍛幍闂佺粯鎸稿ù椋庣矓濞差亝鐓欐い鏃€鍎抽崢瀵糕偓娈垮枛閻栫厧鐣疯ぐ鎺濇晪闁告侗鍨崑鎾绘焼瀹ュ棌鎷婚梺绋挎湰閻熴劑宕楀畝鍕厵闁惧浚鍋呯亸顓熴亜閺囶亞绉€规洖銈稿鎾倷閻㈠灚姣囬梻鍌欒兌椤牓鎯夋總绋跨；婵炴垯鍨虹€氬懘鏌ｉ弬鍨倯闁绘挶鍎茬换婵嬫濞戞瑱绱炲┑鈩冨絻缂嶅﹪寮诲☉姘ｅ亾閿濆簼绨绘い蹇ｅ弮閺岋紕浠﹂崜褉妲堥梺瀹狀潐閸ㄥ灝鐣烽悢纰辨晝闁靛繒濮岄幋锔解拻濞达絽婀卞﹢浠嬫煕婵犲啯绀堥柍褜鍓氱喊宥咁熆濮椻偓閿濈偠绠涢幘浣规そ椤㈡棃宕熼鍡欏€為梻鍌欑閹测€趁洪敃鍌氶棷妞ゆ梻鈷堥悞浠嬫煕椤愶絾绀冮柍閿嬪灩缁辨帞鈧綆浜滈惃锟犳煛閳ь剟鎳￠妶鍥╋紲闁荤姴娲﹁ぐ鍐焵椤掆偓濞硷繝鐛崘顔肩畾鐟滃繘寮崇€ｎ喗鐓欓梺鍨儐閳锋帡鏌涢悩鍐插缂傚倹鎸荤粋鎺斺偓锝庡亜閻у嫭绻濋姀锝嗙【妞ゆ垵鐗忓☉鐢稿焵椤掑嫭鈷掑〒姘ｅ亾闁逞屽墰閸嬫盯鎳熼娑欐珷闁告挆鍛紳閻庡箍鍎遍幊蹇浰夐悙鐢电＜闁稿本姘ㄥ瓭闂佸疇顕ч柊锝夌嵁閸ヮ剦鏁婇柟顖嗗洨宕曢梻鍌氬€风粈渚€骞栭鈷氭椽濮€閵堝懎鐎┑鐐叉▕娴滄粓鎮￠弴銏＄厵閻庣數顭堝暩缂佺偓宕樺Λ鍕箒闂佹寧绻傞悧鍡樼濡ゅ懏鐓欓弶鍫濆⒔閻ｉ亶鏌ｉ幘瀛樼闁哄瞼鍠栭幃婊兾熺拠鍙夋缂傚倷鑳舵繛鈧紒鐘崇墵瀵鎮㈤搹鍦紲濠碘槅鍨靛▍锝夋偡閺屻儲鈷戦柟鑲╁仜閳ь剚娲栫叅闁靛牆顦悡姗€鏌熸潏鎯х槣闁轰礁锕弻锝夋偄绾拌鲸娈ユ繝銏ｎ潐濞茬喎顫忔繝姘＜婵炲棙鍨归悰銏犫攽閻愭澘灏冮柛銉ｅ妼娴滈亶姊虹化鏇炲⒉缂佸鍨圭划濠氭偐缂佹鍘甸梻渚囧弿缁犳垵顕ｉ悙顒傜?15 缂?');
  }
}

async function storeSeedanceReferenceVideoAsset(projectUuid, canvasRow, sourceFilePath, originalName, sourceMeta = {}, referenceRule = DEFAULT_SEEDANCE_REFERENCE_RULE) {
  const sourceSha1 = sha1File(sourceFilePath);
  const maxBytes = Number(referenceRule.maxBytes || DEFAULT_SEEDANCE_REFERENCE_RULE.maxBytes);
  const targetBytes = Math.floor(maxBytes * Number(referenceRule.targetBytesRatio || DEFAULT_SEEDANCE_REFERENCE_RULE.targetBytesRatio || 0.9));
  const profileSuffix = maxBytes > Number(DEFAULT_SEEDANCE_REFERENCE_RULE.maxBytes || 0) ? '_sd25' : '';
  const storedName = `${sourceSha1}${profileSuffix}_seedance_ref.mp4`;
  const dest = path.join(assetsDir(projectUuid), storedName);

  if (!fs.existsSync(dest)) {
    const tmpOutput = path.join(tmpDir(), `${sourceSha1}_seedance_ref-${randomId()}.mp4`);
    await transcodeVideo(sourceFilePath, tmpOutput, {
      filter: ffmpegReferenceVideoFilter(referenceRule, sourceMeta),
      targetBytes,
      durationSec: Number(sourceMeta.durationSec || 0),
      audioBitrateKbps: 96,
      timeout: 15 * 60_000,
    });
    const outputSize = fs.statSync(tmpOutput).size;
    if (outputSize > maxBytes) {
      fs.rmSync(tmpOutput, { force: true });
      throw new Error(`Reference video compression still exceeds ${Math.round(maxBytes / 1024 / 1024)}MB`);
    }
    fs.renameSync(tmpOutput, dest);
  }

  await mirrorStoredAsset(projectUuid, storedName, dest, 'video/mp4');

  const compressedSha1 = sha1File(dest);
  const stat = fs.statSync(dest);
  if (canvasRow) {
    await upsertAssetRecord(canvasRow, {
      originalName: derivedVideoOriginalName(originalName, 'seedance-ref'),
      storedName,
      relativePath: assetRelativePath(projectUuid, storedName),
      mimeType: 'video/mp4',
      byteSize: stat.size,
      sha1: compressedSha1,
      sourceType: 'reference',
    });
  }

  const meta = await probeMediaMetadata(dest, 'video/mp4', storedName);
  return {
    url: assetUrl(projectUuid, storedName),
    sha1: compressedSha1,
    meta,
  };
}

async function createDisplayImageAsset(projectUuid, storedName, sourcePath) {
  const sharp = getSharp();
  if (!sharp || !fs.existsSync(sourcePath)) return null;

  const previewName = `${path.parse(storedName).name}_thumb.webp`;
  const outputPath = path.join(assetsDir(projectUuid), previewName);
  try {
    if (!fs.existsSync(outputPath)) {
      const tmpOutput = path.join(tmpDir(), `${previewName}-${randomId()}.webp`);
      await sharp(sourcePath)
        .resize({ width: 960, withoutEnlargement: true })
        .webp({ quality: 78, effort: 3 })
        .toFile(tmpOutput);
      fs.renameSync(tmpOutput, outputPath);
    }
    await mirrorStoredAsset(projectUuid, previewName, outputPath, 'image/webp');
    return assetUrl(projectUuid, previewName);
  } catch (error) {
    console.warn(`display image thumbnail failed for ${projectUuid}/${storedName}:`, error.message);
    return null;
  }
}

async function storeExternalVideoAsset(projectUuid, canvasRow, sourceFilePath, originalName, mimeType = 'video/mp4', sourceType = 'reference') {
  const sourceSha1 = sha1File(sourceFilePath);
  const rawExt = path.extname(String(originalName || '')) || path.extname(String(sourceFilePath || '')) || '.mp4';
  const ext = rawExt.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase() || '.mp4';
  const storedName = `${sourceSha1}${ext}`;
  const dest = path.join(assetsDir(projectUuid), storedName);
  const finalMimeType = mimeType || mimeTypeFromName(storedName);

  if (!fs.existsSync(dest)) {
    fs.copyFileSync(sourceFilePath, dest);
  }

  await mirrorStoredAsset(projectUuid, storedName, dest, finalMimeType);

  const stat = fs.statSync(dest);
  if (canvasRow) {
    await upsertAssetRecord(canvasRow, {
      originalName: safeOriginalName(originalName, storedName),
      storedName,
      relativePath: assetRelativePath(projectUuid, storedName),
      mimeType: finalMimeType,
      byteSize: stat.size,
      sha1: sourceSha1,
      sourceType,
    });
  }

  const meta = await probeMediaMetadata(dest, finalMimeType, storedName);
  return {
    url: assetUrl(projectUuid, storedName),
    sha1: sourceSha1,
    meta,
  };
}

async function prepareSeedanceReferenceVideos(req, urls, projectUuid, canvasRow, model) {
  const refs = (urls || []).filter(Boolean);
  const referenceRule = referenceRuleForVideoModel(model);
  const maxCount = Number(referenceRule.maxCount || SEEDANCE_REFERENCE_MAX_COUNT);
  const minDurationSec = Number(referenceRule.minDurationSec || SEEDANCE_REFERENCE_MIN_DURATION_SEC);
  const maxDurationSec = Number(referenceRule.maxDurationSec || SEEDANCE_REFERENCE_MAX_DURATION_SEC);
  const maxTotalDurationSec = Number(referenceRule.maxTotalDurationSec || SEEDANCE_REFERENCE_MAX_TOTAL_DURATION_SEC);
  if (refs.length > maxCount) {
    throw new Error(`参考视频最多支持 ${maxCount} 个`);
  }

  const preparedUrls = [];
  let totalDuration = 0;

  for (let index = 0; index < refs.length; index += 1) {
    let source = null;
    try {
      source = await resolveVideoTrimSource(refs[index], projectUuid, req);
      const meta = await probeMediaMetadata(source.filePath, source.mimeType, source.originalName);
      const stat = fs.existsSync(source.filePath) ? fs.statSync(source.filePath) : null;
      if (stat && !meta.byteSize) meta.byteSize = stat.size;

      const spec = seedanceReferenceSpec(meta, referenceRule);
      if (!spec.validRatio) {
        throw new Error(`参考视频 ${index + 1} 宽高比需在 0.4 到 2.5 之间`);
      }

      if (Number.isFinite(spec.durationSec)) {
        if (
          spec.durationSec < minDurationSec ||
          spec.durationSec > maxDurationSec
        ) {
          throw new Error(
            `参考视频 ${index + 1} 时长需在 ${minDurationSec}-${maxDurationSec} 秒之间`
          );
        }
        totalDuration += spec.durationSec;
      }

      const originalReferenceUrl = String(refs[index] || '');
      const useCompressedReference = shouldPrepareSeedanceReference(meta, referenceRule);
      const shouldInternalizeReference = /^https?:\/\//i.test(originalReferenceUrl);
      const referenceUrl = useCompressedReference
        ? (await storeSeedanceReferenceVideoAsset(projectUuid, canvasRow, source.filePath, source.originalName, meta, referenceRule)).url
        : shouldInternalizeReference
          ? (await storeExternalVideoAsset(projectUuid, canvasRow, source.filePath, source.originalName, source.mimeType, 'reference')).url
          : originalReferenceUrl;

      preparedUrls.push(await resolveAssetPublicUrlForExternalUse(req, referenceUrl, projectUuid));
    } catch (error) {
      if (/^https?:\/\//i.test(String(refs[index] || ''))) {
        throw new Error(downloadAssetErrorMessage(error));
      }
      throw error;
    } finally {
      for (const cleanupFile of source?.cleanupFiles || []) {
        fs.rmSync(cleanupFile, { force: true });
      }
    }
  }

  if (totalDuration > maxTotalDurationSec + 0.01) {
    throw new Error(`参考视频总时长不能超过 ${maxTotalDurationSec} 秒`);
  }

  return preparedUrls;
}

function assetResponse(projectUuid, row) {
  return {
    url: `/assets/${projectUuid}/${row.stored_name}`,
    name: row.original_name || row.stored_name,
    originalName: row.original_name || row.stored_name,
    storedName: row.stored_name,
    relativePath: row.relative_path,
    mimeType: row.mime_type || '',
    sha1: row.sha1 || path.parse(row.stored_name).name,
    byteSize: Number(row.byte_size || 0),
    kind: assetKindFromMime(row.mime_type, row.stored_name),
    sourceType: row.source_type || 'upload',
    createdAtMs: dateMs(row.created_at)
  };
}

async function upsertAssetRecord(canvasRow, asset) {
  await getContentPool().query(
    `INSERT INTO canvas_assets
      (canvas_id, owner_id, kind, original_name, stored_name, relative_path, mime_type, byte_size, sha1, source_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      kind = VALUES(kind),
      original_name = VALUES(original_name),
      relative_path = VALUES(relative_path),
      mime_type = VALUES(mime_type),
      byte_size = VALUES(byte_size),
      sha1 = VALUES(sha1),
      source_type = VALUES(source_type),
      updated_at = CURRENT_TIMESTAMP`,
    [
      canvasRow.id,
      canvasRow.owner_id,
      assetKindFromMime(asset.mimeType, asset.storedName),
      safeOriginalName(asset.originalName, asset.storedName),
      asset.storedName,
      asset.relativePath || assetRelativePath(canvasRow.id, asset.storedName),
      asset.mimeType || mimeTypeFromName(asset.storedName),
      Number(asset.byteSize || 0),
      String(asset.sha1 || path.parse(asset.storedName).name),
      asset.sourceType || 'upload'
    ]
  );
}

async function migrateLegacyAssetRecords(canvasRow) {
  if (!isSeparateContentDatabase()) return;
  const [legacyRows] = await getPool().query(
    `SELECT original_name, stored_name, relative_path, mime_type, byte_size, sha1, source_type, created_at
     FROM canvas_assets
     WHERE canvas_id = ?
     ORDER BY id ASC`,
    [canvasRow.id]
  );
  for (const legacyRow of legacyRows) {
    await upsertAssetRecord(canvasRow, {
      originalName: legacyRow.original_name,
      storedName: legacyRow.stored_name,
      relativePath: legacyRow.relative_path,
      mimeType: legacyRow.mime_type,
      byteSize: Number(legacyRow.byte_size || 0),
      sha1: legacyRow.sha1,
      sourceType: legacyRow.source_type || 'upload',
      createdAt: legacyRow.created_at,
    });
  }
}

async function backfillAssetRecords(canvasRow) {
  ensureProjectScaffold(canvasRow.id);
  await migrateLegacyAssetRecords(canvasRow);
  const [existingRows] = await getContentPool().query('SELECT stored_name FROM canvas_assets WHERE canvas_id = ?', [canvasRow.id]);
  const existingNames = new Set(existingRows.map((row) => row.stored_name));
  const files = fs.readdirSync(assetsDir(canvasRow.id)).filter((file) => !file.endsWith('_thumb.webp'));

  for (const file of files) {
    if (existingNames.has(file)) continue;
    const fullPath = path.join(assetsDir(canvasRow.id), file);
    const stat = fs.statSync(fullPath);
    await upsertAssetRecord(canvasRow, {
      originalName: file,
      storedName: file,
      relativePath: assetRelativePath(canvasRow.id, file),
      mimeType: mimeTypeFromName(file),
      byteSize: stat.size,
      sha1: path.parse(file).name,
      sourceType: 'backfill'
    });
    void maybeMirrorLocalAsset(canvasRow.id, file, fullPath, mimeTypeFromName(file));
  }
}

async function listAssetsInCanvas(canvasRow) {
  await backfillAssetRecords(canvasRow);
  const [rows] = await getContentPool().query(
    `SELECT stored_name, original_name, relative_path, mime_type, byte_size, sha1, source_type, created_at
     FROM canvas_assets
     WHERE canvas_id = ?
     ORDER BY created_at DESC, id DESC`,
    [canvasRow.id]
  );
  // RV 兼容转码会双份保存：provider 原片用于无损归档，H.264 版才是用户正式资产。
  // 原片仍有资产记录且会跟随画布复制，只是不在素材库里显示成一个重复视频。
  return rows
    .filter((row) => String(row.source_type || '') !== 'generated-original')
    .map((row) => assetResponse(canvasRow.id, row));
}

function sha1File(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function sha1FileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function usageUserFromRequest(req) {
  return {
    userId: req.user?.id,
    username: req.user?.username || 'unknown',
    userRole: req.user?.role || '',
  };
}

function usageBaseFromCanvas(req, row, extra = {}) {
  return {
    ...usageUserFromRequest(req),
    canvasId: row?.id || null,
    projectUuid: extra.projectUuid || row?.uuid || null,
    canvasTitle: row?.title || null,
    nodeKey: extra.nodeKey || null,
  };
}

function trackGenerationPromise(collection, jobId, promise) {
  const tracked = Promise.resolve(promise);
  collection.set(jobId, tracked);
  tracked.then(
    () => {
      if (collection.get(jobId) === tracked) collection.delete(jobId);
    },
    (error) => {
      if (collection.get(jobId) === tracked) collection.delete(jobId);
      console.error(`background generation ${jobId} failed:`, error);
    }
  );
  return tracked;
}

function clearGenerationPoller(jobId, timer = null) {
  const current = generationPollers.get(jobId);
  if (!current || (timer && current !== timer)) return false;
  clearInterval(current);
  generationPollers.delete(jobId);
  return true;
}

function registerGenerationPoller(jobId, timer) {
  clearGenerationPoller(jobId);
  if (generationRuntimeDraining) {
    clearInterval(timer);
    return false;
  }
  generationPollers.set(jobId, timer);
  return true;
}

function pauseGenerationPollers() {
  generationRuntimeDraining = true;
  for (const [jobId, timer] of generationPollers.entries()) {
    clearInterval(timer);
    generationPollers.delete(jobId);
  }
}

function generationRuntimeState() {
  return {
    draining: generationRuntimeDraining,
    nonResumableCount: activeNonResumableGenerations.size,
    providerSubmissionCount: activeProviderSubmissions.size,
    activePollCount: activePollOperations.size,
    pollerCount: generationPollers.size,
    rvTranscodeActiveCount: activeGeneratedVideoRvTranscodes,
    rvTranscodeQueuedCount: generatedVideoRvTranscodeWaiters.length,
  };
}

async function waitForGenerationDrain(timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
  while (
    activeNonResumableGenerations.size > 0 ||
    activeProviderSubmissions.size > 0 ||
    activePollOperations.size > 0
  ) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return {
        drained: false,
        ...generationRuntimeState(),
      };
    }
    const batch = [
      ...activeNonResumableGenerations.values(),
      ...activeProviderSubmissions.values(),
      ...activePollOperations.values(),
    ];
    await Promise.race([
      Promise.allSettled(batch),
      new Promise((resolve) => setTimeout(resolve, Math.min(remainingMs, 500))),
    ]);
  }
  return {
    drained: true,
    ...generationRuntimeState(),
  };
}

function generationTaskBaseFromCanvas(req, row, extra = {}) {
  return {
    ...usageBaseFromCanvas(req, row, extra),
    projectUuid: extra.projectUuid || row?.uuid || null,
  };
}

function compactGenerationRequestParams(params = {}, overrides = {}) {
  const inputCounts = usageInputCounts(params);
  return {
    prompt: String(params.prompt || params.description || '').slice(0, 12000),
    model: params.model || params.textModel || params.llmModel || null,
    modeType: params.modeType || null,
    count: params.count || null,
    settings: params.settings || null,
    inputCounts,
    ...overrides,
  };
}

async function safeCreateUsageLog(req, row, entry) {
  try {
    return await createPaidUsageLog({
      ...usageBaseFromCanvas(req, row, entry),
      ...entry,
    });
  } catch (error) {
    console.warn('paid usage log create failed:', error.message);
    return null;
  }
}

async function safeUpdateUsageLog(logId, patch) {
  if (!logId) return;
  try {
    await updatePaidUsageLog(logId, patch);
  } catch (error) {
    console.warn('paid usage log update failed:', error.message);
  }
}

async function safeCreateVideoTaskDetail(req, row, entry) {
  try {
    return await createVideoTaskDetail({
      ...usageBaseFromCanvas(req, row, entry),
      ...entry,
    });
  } catch (error) {
    console.warn('video task detail create failed:', error.message);
    return null;
  }
}

async function safeUpdateVideoTaskDetail(detailId, patch) {
  if (!detailId) return;
  try {
    await updateVideoTaskDetail(detailId, patch);
  } catch (error) {
    console.warn('video task detail update failed:', error.message);
  }
}

function usagePromptPreview(...parts) {
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join('\n\n').slice(0, 4000);
}

function usageInputCounts(params = {}) {
  return {
    images: Array.isArray(params.imageList) ? params.imageList.filter((item) => item?.url).length : 0,
    videos: Array.isArray(params.videoList) ? params.videoList.filter((item) => item?.url).length : 0,
    audios: Array.isArray(params.audioList) ? params.audioList.filter((item) => item?.url).length : 0,
    texts: Array.isArray(params.textList) ? params.textList.filter((item) => item?.content).length : 0,
  };
}

function usageDetailText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function usageReferenceUrl(value) {
  const text = usageDetailText(value, 900);
  if (!text) return null;
  return text;
}

function usageReferenceNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function summarizeVideoReferenceMaterial(type, item = {}, index = 0, source = 'reference') {
  return {
    type,
    index: index + 1,
    source,
    id: usageDetailText(item.id || item.nodeId || item.nodeKey || item.key || '', 160) || null,
    title:
      usageDetailText(item.name || item.title || item.label || item.assetLabel || item.fileName || item.originalName || '', 180) ||
      `${type}${index + 1}`,
    url: usageReferenceUrl(item.url || item.originalUrl || item.previewUrl || item.thumbnailUrl),
    mimeType: usageDetailText(item.mimeType || item.imageMimeType || item.type || '', 120) || null,
    width: usageReferenceNumber(item.width, item.imageWidth, item.meta?.width),
    height: usageReferenceNumber(item.height, item.imageHeight, item.meta?.height),
    durationSec: usageReferenceNumber(item.durationSec, item.duration, item.meta?.durationSec),
    sizeBytes: usageReferenceNumber(item.sizeBytes, item.fileSize, item.byteSize, item.meta?.sizeBytes),
  };
}

function summarizeVideoReferences(params = {}, lists = {}) {
  const seen = new Set();
  const addUnique = (items, type, source) => {
    const normalized = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item) continue;
      const key = `${type}:${item.id || item.nodeId || item.nodeKey || item.url || item.content || normalized.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(summarizeVideoReferenceMaterial(type, item, normalized.length, source));
    }
    return normalized;
  };

  return [
    ...addUnique(lists.imageList || params.imageList, 'image', 'imageList'),
    ...addUnique(lists.videoList || params.videoList, 'video', 'videoList'),
    ...addUnique(lists.audioList || params.audioList, 'audio', 'audioList'),
    ...addUnique(params.textList, 'text', 'textList'),
    ...addUnique(params.promptChips, 'prompt', 'promptChips'),
  ];
}

function readCanvasData(row) {
  if (!row) return {};
  return parseJsonDocument(row.data, {});
}

function dateMs(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Date.now();
}

function defaultProjectDraft(projectUuid, data = {}) {
  const viewport = data.viewport || {};
  return {
    projectUuid: String(projectUuid),
    viewportX: Number(data.projectDraft?.viewportX ?? viewport.x ?? 0),
    viewportY: Number(data.projectDraft?.viewportY ?? viewport.y ?? 0),
    viewportZoom: Number(data.projectDraft?.viewportZoom ?? viewport.zoom ?? 1),
    canvasTextScale: Number(data.projectDraft?.canvasTextScale ?? 1),
    lastEditedAtMs: Date.now(),
    lastPluginEditAtMs: Number(data.projectDraft?.lastPluginEditAtMs || 0),
    lastClientNodeSaveAtMs: Number(data.lastClientNodeSaveAtMs || data.projectDraft?.lastClientNodeSaveAtMs || 0),
  };
}

function legacyNodeToCanvasNode(node, projectUuid) {
  const kind = node?.data?.kind || node?.data?.type || 'text';
  const supported = ['text', 'image', 'video', 'audio'].includes(kind) ? kind : 'text';
  const nodeKey = String(node.id || randomId());
  const name = node?.data?.label || node?.data?.name || `${supported} node`;
  const data = {
    type: supported,
    name,
    url: [],
    action:
      supported === 'image'
        ? 'image_generate'
        : supported === 'video'
          ? 'video_generate'
          : supported === 'audio'
            ? 'audio_generate'
            : 'text_node',
    params:
      supported === 'image'
        ? {
            prompt: node?.data?.description || '',
            model: DEFAULT_IMAGE_MODEL,
            count: 1,
            settings: { quality: 'high', ratio: '16:9', resolution: '1K' },
            modeType: 'text2image',
            imageList: [],
            imageListOrder: [],
            videoList: [],
            audioList: [],
            textList: []
          }
        : supported === 'video'
          ? {
              prompt: node?.data?.description || '',
              model: 'Seedance_2_0',
              modeType: 'text2video',
              count: 1,
              imageList: [],
              imageListOrder: [],
              mixedList: [],
              mixedListOrder: [],
              videoList: [],
              audioList: [],
              textList: [],
              settings: { ratio: '16:9', resolution: '720P', duration: 5, enableSound: 'on' }
            }
          : supported === 'audio'
            ? { type: 'tts', prompt: node?.data?.description || '', model: 'tts-default', voice: 'default', speed: 1 }
            : {
                content: node?.data?.description || '',
                model: config.defaultChatModel,
                performanceMode: 'highest',
                reasoningEffort: 'high',
                prompt: '',
                imageList: [],
                videoList: [],
                textList: []
              }
  };

  return {
    nodeKey,
    projectUuid: String(projectUuid),
    type: supported === 'text' ? 1 : supported === 'image' ? 2 : supported === 'video' ? 3 : 6,
    name,
    position: {
      positionX: Number(node?.position?.x ?? 0),
      positionY: Number(node?.position?.y ?? 0)
    },
    measured: {
      width: Number(node?.width ?? node?.measured?.width ?? 520),
      height: Number(node?.height ?? node?.measured?.height ?? 320)
    },
    data: JSON.stringify(data),
    status: 1
  };
}

function nodeListFromData(data, projectUuid) {
  if (Array.isArray(data.nodeList)) return data.nodeList;
  if (Array.isArray(data.nodes)) return data.nodes.map((node) => legacyNodeToCanvasNode(node, projectUuid));
  return [];
}

function coverFromNodeList(nodeList) {
  for (const node of nodeList) {
    try {
      const data = typeof node.data === 'string' ? JSON.parse(node.data) : node.data;
      if ((data.type === 'image' || data.type === 'upload' || data.type === 'video') && Array.isArray(data.url) && data.url[0]) {
        return data.url[0];
      }
    } catch {
      // ignore malformed node data
    }
  }
  return undefined;
}

function nodeMediaUrls(nodeList) {
  const urls = new Set();
  for (const node of nodeList) {
    try {
      const data = typeof node.data === 'string' ? JSON.parse(node.data) : node.data;
      if (Array.isArray(data?.url)) {
        data.url.forEach((url) => {
          if (url) urls.add(String(url));
        });
      }
    } catch {
      // ignore malformed node data
    }
  }
  return urls;
}

function effectiveCoverUrl(data, nodeList) {
  const derivedCoverUrl = coverFromNodeList(nodeList);
  const customCoverUrl = String(data?.customCoverUrl || '').trim();
  const legacyCoverUrl = String(data?.coverUrl || '').trim();
  if (customCoverUrl) return customCoverUrl;
  if (derivedCoverUrl) return derivedCoverUrl;
  return legacyCoverUrl;
}

function projectAccessForUser(req, row) {
  const isOwner = Number(row.owner_id) === Number(req.user.id);
  const isAdmin = req.user.role === 'admin';
  const isShared = Boolean(row.shared);
  const isPersonalShared = Boolean(row.personal_shared);
  return {
    isOwner,
    isShared,
    isPersonalShared,
    canManage: isOwner || isAdmin,
    canWrite: isOwner || isAdmin || isShared
  };
}

function normalizeCanvasRole(row) {
  return String(row?.canvas_role || 'normal') === 'template' ? 'template' : 'normal';
}

function collectionFromRow(row) {
  return {
    id: String(row.id),
    name: row.name,
    canvasCount: Number(row.canvas_count || 0),
    ownerId: Number(row.owner_id),
    ownerName: row.owner_name || undefined,
    sortOrder: Number(row.sort_order || 0),
    createdAtMs: dateMs(row.created_at),
    updatedAtMs: dateMs(row.updated_at)
  };
}

/**
 * 把某个人的"我的分类"对齐成 sd2 项目管理页那份 shotflow 画布分类。
 *
 *   - 缺的分类补上，顺序按 sd2 的 sort_order（测试在最上面）；
 *   - 不在名单里的旧分类：先把里面的画布挪到第一个分类（测试），再删掉空分类。
 *
 * 安全边界（画布绝对不能丢）：
 *   - 只动 canvases.collection_id，从不 DELETE canvases；
 *   - 读不到 sd2 分类（外部目录没开 / 库连不上 / 表没建）就整个跳过，什么都不删；
 *   - 挪画布和删分类在一个事务里，挪失败就不删。
 * 出错只记日志、不往外抛：这个函数挂在列表接口前面，不该让画布管理页打不开。
 */
async function syncShotflowCategoryCollections(ownerId) {
  const numericOwnerId = Number(ownerId);
  if (!Number.isFinite(numericOwnerId) || numericOwnerId <= 0) return;
  let categories;
  try {
    categories = await listShotflowCategoryRows();
  } catch (error) {
    console.error('[collections] 读取 shotflow 画布分类失败，跳过对齐:', error.message);
    return;
  }
  if (!Array.isArray(categories) || categories.length === 0) return;

  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query(
      'SELECT id, name, sort_order FROM canvas_collections WHERE owner_id = ? FOR UPDATE',
      [numericOwnerId]
    );
    const byName = new Map(existing.map((row) => [String(row.name || '').trim(), row]));

    // 1. 补齐 / 校正顺序
    const categoryIdsByName = new Map();
    for (const category of categories) {
      const current = byName.get(category.name);
      if (current) {
        categoryIdsByName.set(category.name, Number(current.id));
        if (Number(current.sort_order || 0) !== category.sortOrder) {
          await connection.query('UPDATE canvas_collections SET sort_order = ? WHERE id = ?', [
            category.sortOrder,
            current.id
          ]);
        }
        continue;
      }
      const [inserted] = await connection.query(
        'INSERT INTO canvas_collections (owner_id, name, sort_order) VALUES (?, ?, ?)',
        [numericOwnerId, category.name, category.sortOrder]
      );
      categoryIdsByName.set(category.name, Number(inserted.insertId));
    }

    // 2. 名单外的旧分类：画布先挪到第一个分类，再删空壳
    const fallbackId = categoryIdsByName.get(categories[0].name);
    const validNames = new Set(categories.map((category) => category.name));
    const strayIds = existing
      .filter((row) => !validNames.has(String(row.name || '').trim()))
      .map((row) => Number(row.id));
    if (strayIds.length > 0 && fallbackId) {
      await connection.query(
        'UPDATE canvases SET collection_id = ? WHERE collection_id IN (?) AND owner_id = ?',
        [fallbackId, strayIds, numericOwnerId]
      );
      // 别人的画布万一挂在这个分类上（历史数据），也先解引用再删，绝不靠外键去 SET NULL
      await connection.query('UPDATE canvases SET collection_id = ? WHERE collection_id IN (?)', [
        fallbackId,
        strayIds
      ]);
      await connection.query('DELETE FROM canvas_collections WHERE id IN (?) AND owner_id = ?', [
        strayIds,
        numericOwnerId
      ]);
    }
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch { /* 回滚失败没有别的办法，交给下面的日志 */ }
    console.error('[collections] 对齐 shotflow 画布分类失败:', error.message);
  } finally {
    connection.release();
  }
}

function canvasProjectStatusLabel(status) {
  return CANVAS_PROJECT_STATUS_LABELS[String(status || '')] || '闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；闁绘劗鍎ら崑瀣煟濡崵婀介柍褜鍏涚欢姘嚕閹绢喖顫呴柍鈺佸暞閻濇洟姊绘担钘壭撻柨姘亜閿旇鏋ょ紒杈ㄦ瀵挳鎮㈤搹鍦闂備焦鐪归崹钘夘焽瑜嶉悺顓㈡⒒娴ｇ懓顕滄繛鎻掔箻瀹曟劕螖閸涱厾鍔﹀銈嗗笂缁€渚€宕甸鍕厱闁挎繂绻掔粔顔尖攽閳╁啯灏︾€规洏鍔戝鍫曞箣閻橀潧骞€婵犵數濮伴崹鐓庘枖濞戙垺鍎斿┑鍌氭啞閸庡﹪鏌涢銈呮灁缂佲檧鍋撻梻浣圭湽閸ㄨ棄顭囪閻☆參姊绘担渚劸闁挎洏鍊楃槐鐐寸節閸屾粍娈鹃梺瑙勫劶婵倝宕愮紒妯圭箚妞ゆ牜鍋炲▍婊呯磼閵婎煈鍤欐い顏勫暣婵″爼宕卞Δ鈧〖缂傚倷鐒﹁ぐ鍐╂櫠閻ｅ苯鍨濋柛顐熸噰閸嬫捇鏁愭惔鈩冪亶闂佺粯鎸荤粙鎾诲焵椤掆偓閸樻粓宕戦幘缁樼厓鐟滄粓宕滈悢椋庢殾濞村吋娼欑粻濠氭偣閸ヮ亜鐨洪柛鏃撶畱椤啴濡堕崱妤冪懆闂佺锕ょ紞濠傤嚕閹惰棄鐓涢柛灞久肩花璇差渻閵堝棙灏甸柛瀣枑閺呰泛鈽夊杈╋紲闂佺鏈粙鎴澝归鈧弻鈩冩媴缁嬫寧娈婚悗瑙勬礃鐢帡鍩ユ径濠庢僵妞ゆ巻鍋撶紒?';
}

function canvasProjectFromRow(row) {
  return {
    id: String(row.id),
    name: row.name,
    status: row.status,
    shotflowApplicable: row.shotflow_applicable == null ? true : Boolean(row.shotflow_applicable),
    // sd2 项目管理页给这个项目选的 shotflow 画布分类 id（没选是 null）
    shotflowCategoryId: row.shotflow_category_id == null ? null : Number(row.shotflow_category_id),
    statusLabel: canvasProjectStatusLabel(row.status),
    createdAtMs: dateMs(row.created_at),
    updatedAtMs: dateMs(row.updated_at)
  };
}

function projectFromCanvasRow(row) {
  const data = readCanvasData(row);
  const nodeList = nodeListFromData(data, row.id);
  const createdAtMs = dateMs(row.created_at);
  const updatedAtMs = dateMs(row.content_updated_at || row.updated_at);
  return {
    projectMeta: {
      uuid: String(row.id),
      name: row.title,
      coverUrl: effectiveCoverUrl(data, nodeList),
      collectionId: row.collection_id != null ? String(row.collection_id) : null,
      collectionName: row.collection_name || undefined,
      assignedProjectId: row.project_id != null ? String(row.project_id) : null,
      assignedProjectName: row.project_name || undefined,
      assignedProjectStatus: row.project_status || undefined,
      assignedProjectStatusLabel: row.project_status ? canvasProjectStatusLabel(row.project_status) : undefined,
      ownerId: row.owner_id,
      ownerName: row.owner_name || undefined,
      isShared: Boolean(row.shared),
      personalShareCount: Number(row.personal_share_count || 0),
      canvasRole: normalizeCanvasRole(row),
      isTemplate: normalizeCanvasRole(row) === 'template',
      templateSourceCanvasId:
        row.template_source_canvas_id != null ? String(row.template_source_canvas_id) : undefined,
      templateSourceOwnerId:
        row.template_source_owner_id != null ? Number(row.template_source_owner_id) : undefined,
      createdAtMs,
      updatedAtMs,
      contentVersion: crypto.createHash('sha1').update(JSON.stringify(nodeList)).digest('hex'),
      contentUpdatedBy: row.content_updated_by == null ? null : Number(row.content_updated_by)
    },
    projectDraft: defaultProjectDraft(row.id, data),
    nodeList
  };
}

function projectFromCanvasRowForUser(req, row) {
  const project = projectFromCanvasRow(row);
  return {
    ...project,
    projectMeta: {
      ...project.projectMeta,
      ...projectAccessForUser(req, row)
    }
  };
}

function projectIndexFromCanvasRowForUser(req, row) {
  const createdAtMs = dateMs(row.created_at);
  const updatedAtMs = dateMs(row.content_updated_at || row.updated_at);
  const coverUrl = String(row.cover_url || '').trim();
  return {
    uuid: String(row.id),
    name: row.title,
    coverUrl: coverUrl || undefined,
    collectionId: row.collection_id != null ? String(row.collection_id) : null,
    collectionName: row.collection_name || undefined,
    assignedProjectId: row.project_id != null ? String(row.project_id) : null,
    assignedProjectName: row.project_name || undefined,
    assignedProjectStatus: row.project_status || undefined,
    assignedProjectStatusLabel: row.project_status ? canvasProjectStatusLabel(row.project_status) : undefined,
    createdAtMs,
    updatedAtMs,
    nodeCount: Number(row.node_count || 0),
    ownerId: row.owner_id,
    ownerName: row.owner_name || undefined,
    personalShareCount: Number(row.personal_share_count || 0),
    canvasRole: normalizeCanvasRole(row),
    isTemplate: normalizeCanvasRole(row) === 'template',
    templateSourceCanvasId:
      row.template_source_canvas_id != null ? String(row.template_source_canvas_id) : undefined,
    templateSourceOwnerId:
      row.template_source_owner_id != null ? Number(row.template_source_owner_id) : undefined,
    ...projectAccessForUser(req, row)
  };
}

async function getReadableCanvasForUser(req, canvasId) {
  await syncProjectCatalogCache();
  const [rows] = await getPool().query(
    `SELECT
       c.id,
       c.owner_id,
       c.collection_id,
       c.project_id,
       c.title,
       c.data,
       c.cover_url,
       c.node_count,
       c.summary_updated_at,
       c.shared,
       EXISTS (
         SELECT 1
         FROM canvas_user_shares readable_share
         WHERE readable_share.canvas_id = c.id
           AND readable_share.target_user_id = ?
       ) AS personal_shared,
       (SELECT COUNT(*)
        FROM canvas_user_shares share_count
        WHERE share_count.canvas_id = c.id) AS personal_share_count,
       c.canvas_role,
       c.template_source_canvas_id,
       c.template_source_owner_id,
       c.created_at,
       c.updated_at,
       u.username AS owner_name,
       cc.name AS collection_name,
       cp.name AS project_name,
       cp.status AS project_status
     FROM canvases c
     INNER JOIN users u ON u.id = c.owner_id
     LEFT JOIN canvas_collections cc ON cc.id = c.collection_id
     LEFT JOIN canvas_projects cp ON cp.id = c.project_id
     WHERE c.id = ? AND (
       c.owner_id = ?
       OR ? = ?
       OR c.shared = 1
       OR c.canvas_role = 'template'
       OR EXISTS (
         SELECT 1
         FROM canvas_user_shares readable_share
         WHERE readable_share.canvas_id = c.id
           AND readable_share.target_user_id = ?
       )
     )
     LIMIT 1`,
    [req.user.id, canvasId, req.user.id, req.user.role, 'admin', req.user.id]
  );
  const row = await hydrateCanvasRow(rows[0] || null);
  if (row) ensureProjectScaffold(row.id);
  return row;
}

async function getWritableCanvasForUser(req, canvasId) {
  const row = await getReadableCanvasForUser(req, canvasId);
  return row && projectAccessForUser(req, row).canWrite ? row : null;
}

async function getManageableCanvasForUser(req, canvasId) {
  const row = await getReadableCanvasForUser(req, canvasId);
  return row && projectAccessForUser(req, row).canManage ? row : null;
}

async function getSessionReadableCanvasForUser(req, res, canvasId, options = {}) {
  const row = await getReadableCanvasForUser(req, canvasId);
  if (!row) return null;
  const session = await requireCanvasSession(req, res, row.id, options);
  return session ? row : null;
}

async function getSessionWritableCanvasForUser(req, res, canvasId, options = {}) {
  const row = await getWritableCanvasForUser(req, canvasId);
  if (!row) return null;
  const session = await requireCanvasSession(req, res, row.id, options);
  return session ? row : null;
}

async function getManageableCollectionForUser(req, collectionId) {
  const [rows] = await getPool().query(
    `SELECT
       cc.id,
       cc.owner_id,
       cc.name,
       cc.created_at,
       cc.updated_at,
       u.username AS owner_name,
       COUNT(c.id) AS canvas_count
     FROM canvas_collections cc
     INNER JOIN users u ON u.id = cc.owner_id
     LEFT JOIN canvases c ON c.collection_id = cc.id AND c.canvas_role = 'normal'
     WHERE cc.id = ? AND (cc.owner_id = ? OR ? = ?)
     GROUP BY cc.id, cc.owner_id, cc.name, cc.created_at, cc.updated_at, u.username
     LIMIT 1`,
    [collectionId, req.user.id, req.user.role, 'admin']
  );
  return rows[0] || null;
}

async function getCanvasProjectById(projectId) {
  const numericId = Number(projectId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  const [rows] = await getPool().query(
    `SELECT id, name, status, shotflow_applicable, created_at, updated_at
     FROM canvas_projects
     WHERE id = ?
     LIMIT 1`,
    [numericId]
  );
  return rows[0] || null;
}

async function getDefaultCanvasProject() {
  const [rows] = await getPool().query(
    `SELECT id, name, status, shotflow_applicable, created_at, updated_at
     FROM canvas_projects
     ORDER BY created_at ASC, id ASC
     LIMIT 1`
  );
  return rows[0] || null;
}

async function listCanvasProjects() {
  const [rows] = await getPool().query(
    `SELECT id, name, status, shotflow_applicable, created_at, updated_at
     FROM canvas_projects
     ORDER BY created_at ASC, id ASC`
  );
  return rows.map(canvasProjectFromRow);
}

// Override local project-table helpers with the shared catalog-backed versions.
async function getCanvasProjectById(projectId) {
  return getProjectCatalogRowById(projectId);
}

async function getDefaultCanvasProject() {
  return getDefaultProjectCatalogRow();
}

async function listCanvasProjects() {
  const rows = await listProjectCatalogRows();
  return rows.map(canvasProjectFromRow);
}

function cleanProjectName(name) {
  const value = String(name || '').trim();
  return value ? value.slice(0, 160) : '闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；闁绘劗鍎ら崑瀣煟濡崵婀介柍褜鍏涚欢姘嚕閹绢喖顫呴柍鈺佸暞閻濇洟姊绘担钘壭撻柨姘亜閿旇鏋ょ紒杈ㄦ瀵挳鎮㈤搹鍦闂備焦鐪归崹钘夘焽瑜嶉悺顓㈡⒒娴ｇ懓顕滄繛鎻掔箻瀹曟劕螖閸涱厾鍔﹀銈嗗笂缁€渚€宕甸鍕厱闁挎繂绻掔粔顔尖攽閳╁啯灏︾€规洏鍔戝鍫曞箣閻橀潧骞€婵犵數濮伴崹鐓庘枖濞戙垺鍎斿┑鍌氭啞閸庡﹪鏌涢銈呮灁缂佲檧鍋撻梻浣圭湽閸ㄨ棄顭囪閻☆參姊绘担渚劸闁挎洩濡囬崚鎺楊敍閻愯尙鏌ч梺鍓插亝濞叉牠宕￠幎鑺ョ厽婵☆垰鍚嬮弳鈺呮煥濞戞瑧鐭掓慨濠呮缁辨帒顫滈崼锝傚亾閹稿海绠惧ù锝呭暱濞层倝鎮″┑瀣厱妞ゆ劗濮撮崝婊堟煟閹惧娲撮柟顔斤耿閹瑦锛愬┑鍡橆唲濠电姵顔栭崰鏍磹閸ф钃熼柣鏃傗拡閺佸﹪鏌涘┑鍡楊伀濞寸厧鐗撻幃妤冩喆閸曨剙顦╅梺绋款儏閿曘倝鎮鹃悜鑺ュ亜闁绘挸娴烽鍝勨攽閻愬弶顥滅紒缁樺笚鐎靛ジ宕奸妷锔规嫼闁荤姴娲犻埀顒冩珪閻忓牓姊洪幖鐐茬仾闁绘搫绻濆畷娲閳╁啫鍔呴梺鎶芥暜閸嬫捇鏌＄€ｎ亪鍙勯柣鎿冨亰瀹曡埖顦版惔锛╂垿姊洪崫銉バｉ柨鏇樺灩椤繒绱掑Ο鑲╂嚌闂侀€炲苯澧撮柛鈹惧亾濡炪倖甯掗崐鍛婄濠婂牊鐓犳繛鑼额嚙閻忥繝鏌￠崨顓犲煟妞ゃ垺鐟╁畷婊嗩槾闁挎稒绮撳铏圭磼濮楀棛鍔搁柣蹇撶箲閻燂箓寮查妷鈺傜厽閹兼番鍊ゅ鎰箾閸欏顏嗗弲闂佺粯妫冮ˉ鎾诲汲閿曞倹鐓ラ柣鏂挎惈鏍￠梺绋匡工婢у海妲愰幘瀛樺闁兼祴鍓濋崹鎸庝繆闂堟稈鏀介悗锝庡亞閸樺憡绻涙潏鍓ф偧妞ゎ厼鐗撳鎶芥晲閸ワ絽浜鹃悷娆忓缁€鍐偨椤栨稑娴柨婵堝仜閳规垹鈧絽鐏氶弲锝夋⒑閹稿海鈽夐悗姘煎墲閵囨劙宕掑锝嗘杸闂佺粯锚閻忔岸寮抽埡鍛厱閻庯綆鍋嗗ú瀛樸亜閵忊€冲摵妞ゃ垺锕㈡慨鈧柣妯诲絻娴滃爼鏌ｉ悢鍝ョ煁婵☆偄鍟撮悰顕€宕橀…瀣そ椤㈡棃宕熸惔妯绘珚闁哄苯绉靛顏堝箯鐏炶棄甯梻?';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitProjectNameSuffix(name) {
  const value = String(name || '');
  const match = value.match(/^(.*?)(\d{2,})$/);
  if (!match) return { stem: value, suffix: '' };
  return { stem: match[1], suffix: match[2] };
}

function trimProjectStem(stem, suffixLength = 0) {
  const available = Math.max(1, 160 - suffixLength);
  return String(stem || '').slice(0, available);
}

async function ensureUniqueProjectName(ownerId, desiredName, excludeCanvasId = null) {
  const cleanedName = cleanProjectName(desiredName);
  const params = [Number(ownerId)];
  let sql = 'SELECT title FROM canvases WHERE owner_id = ?';

  if (excludeCanvasId !== null && excludeCanvasId !== undefined) {
    sql += ' AND id <> ?';
    params.push(Number(excludeCanvasId));
  }

  const [rows] = await getPool().query(sql, params);
  const existingTitles = new Set(
    rows
      .map((row) => String(row.title || '').trim())
      .filter(Boolean)
  );

  if (!existingTitles.has(cleanedName)) return cleanedName;

  const { stem: rawStem } = splitProjectNameSuffix(cleanedName);
  const baseStem = trimProjectStem(rawStem || cleanedName);
  const suffixPattern = new RegExp(`^${escapeRegExp(baseStem)}(\\d{2,})$`);
  const usedIndexes = new Set();

  for (const title of existingTitles) {
    if (title === baseStem) {
      usedIndexes.add(0);
      continue;
    }
    const match = title.match(suffixPattern);
    if (!match) continue;
    usedIndexes.add(Number(match[1]));
  }

  let nextIndex = 1;
  while (usedIndexes.has(nextIndex)) {
    nextIndex += 1;
  }

  while (true) {
    const suffix = String(nextIndex).padStart(2, '0');
    const candidate = `${trimProjectStem(baseStem, suffix.length)}${suffix}`;
    if (!existingTitles.has(candidate)) return candidate;
    nextIndex += 1;
  }
}

function cleanCollectionName(name) {
  const value = String(name || '').trim();
  return value ? value.slice(0, 160) : '闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；闁绘劗鍎ら崑瀣煟濡崵婀介柍褜鍏涚欢姘嚕閹绢喖顫呴柍鈺佸暞閻濇洟姊绘担钘壭撻柨姘亜閿旇鏋ょ紒杈ㄦ瀵挳鎮㈤搹鍦闂備焦鐪归崹钘夘焽瑜嶉悺顓㈡⒒娴ｇ懓顕滄繛鎻掔箻瀹曟劕螖閸涱厾鍔﹀銈嗗笂缁€渚€宕甸鍕厱闁挎繂绻掔粔顔尖攽閳╁啯灏︾€规洏鍔戝鍫曞箣閻橀潧骞€婵犵數濮伴崹鐓庘枖濞戙垺鍎斿┑鍌氭啞閸庡﹪鏌涢銈呮灁缂佲檧鍋撻梻浣圭湽閸ㄨ棄顭囪閻☆參姊绘担渚劸闁挎洩濡囬崚鎺楊敍閻愯尙鏌ч梺鍓插亝濞叉牠宕￠幎鑺ョ厽婵☆垰鍚嬮弳鈺呮煥濞戞瑧鐭掓慨濠呮缁辨帒顫滈崼锝傚亾閹稿海绠惧ù锝呭暱濞层倝鎮″┑瀣厱妞ゆ劗濮撮崝婊堟煟閹惧娲撮柟顔斤耿閹瑦锛愬┑鍡橆唲濠电姵顔栭崰鏍磹閸ф钃熼柣鏃傗拡閺佸﹪鏌涘┑鍡楊伀濞寸厧鐗撻幃妤冩喆閸曨剙顦╅梺绋款儏閿曘倝鎮鹃悜鑺ュ亜闁绘挸娴烽鍝勨攽閻愬弶顥滅紒缁樺笚鐎靛ジ宕奸妷锔规嫼闁荤姴娲犻埀顒冩珪閻忓牓姊洪幖鐐茬仾闁绘搫绻濆畷娲閳╁啫鍔呴梺鎶芥暜閸嬫捇鏌＄€ｎ亪鍙勯柣鎿冨亰瀹曡埖顦版惔锛╂垿姊洪崫銉バｉ柨鏇樺灩椤繒绱掑Ο鑲╂嚌闂侀€炲苯澧撮柛鈹惧亾濡炪倖甯掗崐鍛婄濠婂牊鐓犳繛鑼额嚙閻忥繝鏌￠崨顓犲煟妞ゃ垺鐟╁畷婊嗩槾闁挎稒绮撳铏圭磼濮楀棛鍔搁柣蹇撶箲閻燂箓寮查妷鈺傜厽閹兼番鍊ゅ鎰箾閸欏顏嗗弲闂佺粯姊婚崢褔鎷戦悢鍏肩厱闁斥晛鍠氬▓銏ゆ煕濮橆剦鍎旈柡灞剧☉閳藉宕￠悙鍏稿寲闂備礁鎼鍛村疮閺夋埈娼栨繛宸簼閸嬶繝鏌℃径瀣嚋闁稿鍨跺鐑樺濞嗘垹校婵炲瓨绮犳禍婊堟偩瀹勬壋鏀介柛鈾€鏅涢幃鎴炵節閵忥絾纭鹃柨鏇畵閺佸秴鈻庨幘绮规嫼濠殿喚鎳撳ú銈夋倶閳哄懏鐓欓悹鍥囧懐鐦堥梺璇″櫙缁绘繈骞冮埡浼卞湱鈧綆鍋呴弶鍛婁繆閻愵亜鈧牕螞娴ｈ倽娑㈠礋椤掍礁寮块梺鎼炲労閸撴岸鎮￠崘顏呭枑婵犲﹤鐗嗙粈鍫熸叏濡法鍫柍褜鍓欓崯鏉戠暦婵傚憡鍋勯柧蹇曟嚀妤?';
}

async function touchCollectionTimestamp(collectionId) {
  if (!collectionId) return;
  await getPool().query('UPDATE canvas_collections SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [collectionId]);
}

function isExternalHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function projectDataFor(projectUuid, patch = {}) {
  return {
    nodeList: [],
    projectDraft: defaultProjectDraft(projectUuid),
    ...patch
  };
}

function rewriteProjectAssetUrlsInString(value, sourceProjectUuid, targetProjectUuid) {
  return String(value).split(`/assets/${sourceProjectUuid}/`).join(`/assets/${targetProjectUuid}/`);
}

function deepRewriteProjectAssetUrls(value, sourceProjectUuid, targetProjectUuid) {
  if (typeof value === 'string') {
    return rewriteProjectAssetUrlsInString(value, sourceProjectUuid, targetProjectUuid);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRewriteProjectAssetUrls(item, sourceProjectUuid, targetProjectUuid));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepRewriteProjectAssetUrls(item, sourceProjectUuid, targetProjectUuid)])
    );
  }
  return value;
}

function duplicateNodeListForProject(nodeList, sourceProjectUuid, targetProjectUuid) {
  return (Array.isArray(nodeList) ? nodeList : []).map((node) => {
    const nextNode = { ...node, projectUuid: String(targetProjectUuid) };
    try {
      const parsedData = typeof node.data === 'string' ? JSON.parse(node.data) : node.data;
      const nextData = deepRewriteProjectAssetUrls(parsedData, sourceProjectUuid, targetProjectUuid);
      nextData.projectUuid = String(targetProjectUuid);
      nextNode.data = JSON.stringify(nextData);
    } catch {
      nextNode.data = rewriteProjectAssetUrlsInString(node.data, sourceProjectUuid, targetProjectUuid);
    }
    return nextNode;
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * 跨画布资产引用（2026-08-26 排查「共享画布复制到本地后别人丢图」时发现）
 *
 * 现象：邓星豪从画布 273 跨画布粘贴了 37 个节点到 297，粘贴不会把资产搬过来，
 * 于是 297 里有 43 个地址指向 `/assets/273/...`。而 273 是未共享画布，
 * `/assets/:canvasId/:filename` 是按**那个画布**鉴权的（读不到就 404）。
 * 结果：admin 看什么都正常，普通用户（徐子婷、孟蓉）那 43 张全 404。
 *
 * 复制到本地并不能解决 —— 原来的 `rewriteProjectAssetUrlsInString` 只改写
 * `/assets/<源画布>/`，指向第三个画布的引用原样保留，副本继续依赖一个
 * 使用者从来没被授权的画布。全站扫过：170 个画布里 45 个带跨画布引用，
 * 其中 28 个指向未共享画布。
 *
 * 所以复制时要把**所有**外部画布的资产也拉进副本，让副本自带全部素材。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 资产地址的形状：`/assets/<画布id>/<文件名>`。 */
const PROJECT_ASSET_URL_RE = /\/assets\/(\d+)\/([A-Za-z0-9._-]+)/g;

/**
 * 找出这份画布数据里所有**指向别的画布**的资产引用。纯函数。
 *
 * `node.data` 在库里是一段 JSON 字符串（字符串里还套着地址），所以这里直接对
 * 序列化后的整体做扫描 —— 比逐层解析可靠，也不会漏掉将来新增的字段。
 */
function collectForeignAssetRefs(value, targetCanvasId) {
  const target = String(targetCanvasId);
  const seen = new Set();
  const refs = [];
  let serialized;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return refs;
  }
  for (const match of String(serialized || '').matchAll(PROJECT_ASSET_URL_RE)) {
    const canvasId = match[1];
    const storedName = match[2];
    if (canvasId === target) continue;
    // 缩略图是派生物，跟着正片一起复制，不单独算一条
    if (storedName.endsWith('_thumb.webp')) continue;
    const key = `${canvasId}/${storedName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ canvasId, storedName });
  }
  return refs;
}

/**
 * 把指定的几条外部引用改写到目标画布名下。纯函数。
 *
 * `localized` 只包含**确实复制成功**的那些（key 是 `<画布id>/<文件名>`）。
 * 没复制成功的绝不改写 —— 那样会把「一部分人 404」变成「所有人 404」，更糟。
 */
function rewriteForeignAssetRefs(value, targetCanvasId, localized) {
  if (!localized || localized.size === 0) return value;
  const target = String(targetCanvasId);
  const rewriteString = (input) => String(input).replace(
    PROJECT_ASSET_URL_RE,
    (whole, canvasId, storedName) => (
      localized.has(`${canvasId}/${storedName}`) ? `/assets/${target}/${storedName}` : whole
    ),
  );
  const walk = (node) => {
    if (typeof node === 'string') return rewriteString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };
  return walk(value);
}

/**
 * 把外部画布的资产复制进目标画布，并改写地址，让这份数据自带全部素材。
 *
 * 返回改写后的数据。复制不到的（源文件已删）保持原样不动。
 */
async function localizeForeignAssets(data, targetCanvasRow) {
  const refs = collectForeignAssetRefs(data, targetCanvasRow.id);
  if (refs.length === 0) return { data, localized: 0, skipped: 0 };

  ensureProjectScaffold(targetCanvasRow.id);
  const localized = new Set();
  let skipped = 0;

  for (const { canvasId, storedName } of refs) {
    try {
      const destPath = path.join(assetsDir(targetCanvasRow.id), storedName);
      if (!fs.existsSync(destPath)) {
        // 源文件可能只在对象存储里，ensureAssetLocalPath 会先拉回本地
        const srcPath = await ensureAssetLocalPath(canvasId, storedName);
        if (!fs.existsSync(srcPath)) {
          skipped++;
          continue;
        }
        fs.copyFileSync(srcPath, destPath);
      }
      const stat = fs.statSync(destPath);
      const mimeType = mimeTypeFromName(storedName);
      await mirrorStoredAsset(targetCanvasRow.id, storedName, destPath, mimeType).catch(() => {});
      await upsertAssetRecord(targetCanvasRow, {
        originalName: storedName,
        storedName,
        relativePath: assetRelativePath(targetCanvasRow.id, storedName),
        mimeType,
        byteSize: stat.size,
        sha1: '',
        sourceType: 'duplicate',
      });
      localized.add(`${canvasId}/${storedName}`);
    } catch (error) {
      skipped++;
      console.warn(`localize foreign asset failed for ${canvasId}/${storedName} → ${targetCanvasRow.id}:`, error.message);
    }
  }

  if (skipped > 0) {
    console.warn(`[duplicate] canvas ${targetCanvasRow.id}: 跨画布资产 ${refs.length} 个，成功 ${localized.size}，源文件已不存在 ${skipped}`);
  }
  return {
    data: rewriteForeignAssetRefs(data, targetCanvasRow.id, localized),
    localized: localized.size,
    skipped,
  };
}

async function duplicateProjectAssets(sourceCanvasRow, targetCanvasRow) {
  ensureProjectScaffold(sourceCanvasRow.id);
  ensureProjectScaffold(targetCanvasRow.id);
  for (const file of fs.readdirSync(assetsDir(sourceCanvasRow.id))) {
    const src = path.join(assetsDir(sourceCanvasRow.id), file);
    const dest = path.join(assetsDir(targetCanvasRow.id), file);
    if (fs.statSync(src).isFile() && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }

  await backfillAssetRecords(sourceCanvasRow);
  const [assetRows] = await getContentPool().query(
    `SELECT original_name, stored_name, mime_type, byte_size, sha1, source_type
     FROM canvas_assets
     WHERE canvas_id = ?
     ORDER BY id ASC`,
    [sourceCanvasRow.id]
  );
  for (const assetRow of assetRows) {
    if (objectStore.isRemoteEnabled) {
      await objectStore.copyAsset(sourceCanvasRow.id, assetRow.stored_name, targetCanvasRow.id, assetRow.stored_name).catch(async () => {
        const srcLocalPath = await ensureAssetLocalPath(sourceCanvasRow.id, assetRow.stored_name);
        if (fs.existsSync(srcLocalPath)) {
          await mirrorStoredAsset(targetCanvasRow.id, assetRow.stored_name, srcLocalPath, assetRow.mime_type);
        }
      });
    }
    await upsertAssetRecord(targetCanvasRow, {
      originalName: assetRow.original_name,
      storedName: assetRow.stored_name,
      relativePath: assetRelativePath(targetCanvasRow.id, assetRow.stored_name),
      mimeType: assetRow.mime_type,
      byteSize: Number(assetRow.byte_size || 0),
      sha1: assetRow.sha1,
      sourceType: assetRow.source_type || 'upload'
    });
  }
}

async function listCanvasRowsByIdsInOrder(ids) {
  const orderedIds = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  if (orderedIds.length === 0) return [];
  const placeholders = orderedIds.map(() => '?').join(', ');
  const [rows] = await getPool().query(
    `SELECT
       c.id,
       c.owner_id,
       c.collection_id,
       c.project_id,
       c.title,
       c.cover_url,
       c.node_count,
       c.summary_updated_at,
       c.shared,
       (SELECT COUNT(*)
        FROM canvas_user_shares share_count
        WHERE share_count.canvas_id = c.id) AS personal_share_count,
       c.canvas_role,
       c.template_source_canvas_id,
       c.template_source_owner_id,
       c.created_at,
       c.updated_at,
       u.username AS owner_name,
       cc.name AS collection_name,
       cp.name AS project_name,
       cp.status AS project_status
     FROM canvases c
     INNER JOIN users u ON u.id = c.owner_id
     LEFT JOIN canvas_collections cc ON cc.id = c.collection_id
     LEFT JOIN canvas_projects cp ON cp.id = c.project_id
     WHERE c.id IN (${placeholders})`,
    orderedIds
  );
  const order = new Map(orderedIds.map((id, index) => [id, index]));
  return rows.sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0));
}

async function listCanvasRowsForOwnerSortedByCreatedAt(ownerId) {
  const [idRows] = await getPool().query(
    `SELECT id
     FROM canvases
     WHERE owner_id = ? AND canvas_role = 'normal'
     ORDER BY created_at ASC, id ASC`,
    [ownerId]
  );
  return listCanvasRowsByIdsInOrder(idRows.map((row) => row.id));
}

async function listSharedCanvasRowsSortedByCreatedAt() {
  const [idRows] = await getPool().query(
    `SELECT id
     FROM canvases
     WHERE shared = 1 AND canvas_role = 'normal'
     ORDER BY created_at ASC, id ASC`
  );
  return listCanvasRowsByIdsInOrder(idRows.map((row) => row.id));
}

async function listPersonalSharedCanvasRowsSortedByShareTime(userId) {
  const [rows] = await getPool().query(
    `SELECT
       c.id,
       c.owner_id,
       c.collection_id,
       c.project_id,
       c.title,
       c.cover_url,
       c.node_count,
       c.summary_updated_at,
       c.shared,
       1 AS personal_shared,
       (SELECT COUNT(*)
        FROM canvas_user_shares share_count
        WHERE share_count.canvas_id = c.id) AS personal_share_count,
       c.canvas_role,
       c.template_source_canvas_id,
       c.template_source_owner_id,
       c.created_at,
       c.updated_at,
       u.username AS owner_name,
       cc.name AS collection_name,
       cp.name AS project_name,
       cp.status AS project_status
     FROM canvas_user_shares cus
     INNER JOIN canvases c ON c.id = cus.canvas_id
     INNER JOIN users u ON u.id = c.owner_id
     LEFT JOIN canvas_collections cc ON cc.id = c.collection_id
     LEFT JOIN canvas_projects cp ON cp.id = c.project_id
     WHERE cus.target_user_id = ?
       AND c.canvas_role = 'normal'
       AND c.owner_id <> ?
     ORDER BY cus.updated_at DESC, cus.id DESC`,
    [userId, userId]
  );
  return hydrateCanvasRows(rows);
}

async function listTemplateCanvasRowsSortedByCreatedAt() {
  const [idRows] = await getPool().query(
    `SELECT id
     FROM canvases
     WHERE canvas_role = 'template'
     ORDER BY created_at DESC, id DESC`
  );
  return listCanvasRowsByIdsInOrder(idRows.map((row) => row.id));
}

apiRouter.get('/projects', async (req, res, next) => {
  try {
    await syncProjectCatalogCache();
    const isAdmin = req.user.role === 'admin';
    let selectedOwnerId = Number(req.user.id);
    let canvasOwners = undefined;
    if (isAdmin) {
      const [ownerRows] = await getPool().query(
        `SELECT
           u.id,
           u.username,
           u.role,
           COUNT(c.id) AS canvas_count
         FROM users u
         LEFT JOIN canvases c ON c.owner_id = u.id AND c.canvas_role = 'normal'
         WHERE u.active = 1
         GROUP BY u.id, u.username, u.role, u.created_at
         ORDER BY u.created_at ASC, u.id ASC`
      );
      canvasOwners = ownerRows.map((row) => ({
        id: String(row.id),
        username: row.username,
        role: row.role,
        canvasCount: Number(row.canvas_count || 0)
      }));

      const requestedOwnerId = Number(req.query.ownerId);
      if (Number.isFinite(requestedOwnerId) && requestedOwnerId > 0) {
        const hasOwner = canvasOwners.some((owner) => Number(owner.id) === requestedOwnerId);
        if (hasOwner) selectedOwnerId = requestedOwnerId;
      }
    }

    // 画布管理页右栏那几块是可折叠的，收起时不该为它们干活：每一组都是一次查询 +
    // 每行一次 ensureProjectScaffold（按画布建目录的文件系统操作）+ 一次行转换。
    // skip 不传就返回全部 —— Cindy 插件和其它调用方都不带这个参数，行为一字不变。
    // 跳过 scaffold 是安全的：复制路径自己会 ensureProjectScaffold(源, 目标)
    // （见 duplicateProjectAssets），单画布访问路径也会，不靠这个列表接口兜底。
    const skipGroups = new Set(
      String(req.query.skip || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    );
    const ownRows = await listCanvasRowsForOwnerSortedByCreatedAt(selectedOwnerId);
    const templateRows = skipGroups.has('templates')
      ? []
      : await listTemplateCanvasRowsSortedByCreatedAt();
    const sharedRows = skipGroups.has('shared')
      ? []
      : await listSharedCanvasRowsSortedByCreatedAt();
    const personalSharedRows = skipGroups.has('personalShared')
      ? []
      : await listPersonalSharedCanvasRowsSortedByShareTime(req.user.id);
    // 分类以 sd2 项目管理页那份为准：进页面先对齐一次（读不到就原样跳过，不删任何东西）
    await syncShotflowCategoryCollections(selectedOwnerId);
    const [collectionRows] = await getPool().query(
      `SELECT
         cc.id,
         cc.owner_id,
         cc.name,
         cc.sort_order,
         cc.created_at,
         cc.updated_at,
         u.username AS owner_name,
         COUNT(c.id) AS canvas_count
       FROM canvas_collections cc
       INNER JOIN users u ON u.id = cc.owner_id
       LEFT JOIN canvases c ON c.collection_id = cc.id AND c.canvas_role = 'normal'
       WHERE cc.owner_id = ?
       GROUP BY cc.id, cc.owner_id, cc.name, cc.sort_order, cc.created_at, cc.updated_at, u.username
       ORDER BY cc.sort_order ASC, cc.id ASC`,
      [selectedOwnerId]
    );
    const availableProjects = await listCanvasProjects();
    // 分类块里"新建画布"的项目下拉要按分类过滤，前端得知道分类名 → 分类 id 的对应
    const shotflowCategories = (await listShotflowCategoryRows()).map((category) => ({
      id: category.id,
      name: category.name,
      sortOrder: category.sortOrder
    }));
    ownRows.forEach((row) => ensureProjectScaffold(row.id));
    templateRows.forEach((row) => ensureProjectScaffold(row.id));
    sharedRows.forEach((row) => ensureProjectScaffold(row.id));
    personalSharedRows.forEach((row) => ensureProjectScaffold(row.id));
    res.json({
      ownCanvases: ownRows.map((row) => projectIndexFromCanvasRowForUser(req, row)),
      templateCanvases: templateRows.map((row) => projectIndexFromCanvasRowForUser(req, row)),
      sharedCanvases: sharedRows.map((row) => projectIndexFromCanvasRowForUser(req, row)),
      personalSharedCanvases: personalSharedRows.map((row) => projectIndexFromCanvasRowForUser(req, row)),
      ownCollections: collectionRows.map(collectionFromRow),
      shotflowCategories,
      availableProjects,
      canvasOwners,
      selectedOwnerId: String(selectedOwnerId),
      currentUserId: String(req.user.id)
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects', async (req, res, next) => {
  try {
    const name = await ensureUniqueProjectName(req.user.id, req.body.name);
    const requestedCollectionId =
      req.body.collectionId === null || req.body.collectionId === undefined || req.body.collectionId === ''
        ? null
        : Number(req.body.collectionId);
    const requestedCanvasProjectIdRaw =
      req.body.assignedProjectId !== undefined ? req.body.assignedProjectId : req.body.projectId;
    const requestedCanvasProjectId =
      requestedCanvasProjectIdRaw === null || requestedCanvasProjectIdRaw === undefined || requestedCanvasProjectIdRaw === ''
        ? null
        : Number(requestedCanvasProjectIdRaw);
    if (requestedCollectionId !== null && !Number.isFinite(requestedCollectionId)) {
      res.status(400).json({ error: 'invalid collection id' });
      return;
    }
    if (requestedCanvasProjectId !== null && !Number.isFinite(requestedCanvasProjectId)) {
      res.status(400).json({ error: 'invalid project id' });
      return;
    }
    const collectionRow =
      requestedCollectionId === null ? null : await getManageableCollectionForUser(req, requestedCollectionId);
    if (requestedCollectionId !== null && !collectionRow) {
      res.status(404).json({ error: 'collection not found' });
      return;
    }
    const canvasProjectRow =
      requestedCanvasProjectId === null
        ? await getDefaultCanvasProject()
        : await getCanvasProjectById(requestedCanvasProjectId);
    if (!canvasProjectRow) {
      res.status(404).json({ error: 'assigned project not found' });
      return;
    }
    const [result] = await getPool().query(
      "INSERT INTO canvases (owner_id, collection_id, project_id, title, data, shared, canvas_role) VALUES (?, ?, ?, ?, ?, 0, 'normal')",
      [req.user.id, requestedCollectionId, canvasProjectRow.id, name, JSON.stringify(projectDataFor('pending'))]
    );
    ensureProjectScaffold(result.insertId);
    const data = projectDataFor(result.insertId);
    await saveCanvasData(result.insertId, data, {
      reason: 'project_create',
      ownerId: req.user.id,
      createdBy: req.user.id,
      cooldownMs: 0,
    });
    if (requestedCollectionId !== null) {
      await touchCollectionTimestamp(requestedCollectionId);
    }
    const row = await getManageableCanvasForUser(req, result.insertId);
    res.status(201).json(projectFromCanvasRowForUser(req, row));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects/:uuid/duplicate', async (req, res, next) => {
  try {
    const sourceRow = await getReadableCanvasForUser(req, req.params.uuid);
    if (!sourceRow) {
      res.status(404).json({ error: 'project not found' });
      return;
    }

    const sourceData = readCanvasData(sourceRow);
    const name = await ensureUniqueProjectName(req.user.id, req.body.name || `${sourceRow.title} - Copy`);
    const targetCollectionId =
      Number(sourceRow.owner_id) === Number(req.user.id) && sourceRow.collection_id != null
        ? Number(sourceRow.collection_id)
        : null;
    const defaultCanvasProject = sourceRow.project_id == null ? await getDefaultCanvasProject() : null;
    const targetAssignedProjectId = sourceRow.project_id != null ? Number(sourceRow.project_id) : defaultCanvasProject?.id || null;
    const [result] = await getPool().query(
      "INSERT INTO canvases (owner_id, collection_id, project_id, title, data, shared, canvas_role, template_source_canvas_id, template_source_owner_id) VALUES (?, ?, ?, ?, ?, 0, 'normal', NULL, NULL)",
      [req.user.id, targetCollectionId, targetAssignedProjectId, name, JSON.stringify(projectDataFor('pending'))]
    );

    ensureProjectScaffold(result.insertId);
    const duplicatedData = deepRewriteProjectAssetUrls(sourceData, String(sourceRow.id), String(result.insertId));
    duplicatedData.nodeList = duplicateNodeListForProject(sourceData.nodeList, String(sourceRow.id), String(result.insertId));
    duplicatedData.projectDraft = {
      ...defaultProjectDraft(result.insertId, duplicatedData),
      ...(sourceData.projectDraft || {}),
      projectUuid: String(result.insertId),
      lastEditedAtMs: Date.now()
    };

    /*
     * 源画布里可能还有指向**第三个画布**的资产引用（跨画布粘贴留下的）。
     * 上面那两行只改写 `/assets/<源画布>/`，所以这些引用会原样留在副本里，
     * 让副本依赖一个使用者可能根本没权限的画布 —— 那就是「复制到本地后别人丢图」的原因。
     * 这里把它们一并拉进副本，让副本自带全部素材。必须在 saveCanvasData 之前做，
     * 改写后的地址才会落库。
     */
    const localizeResult = await localizeForeignAssets(duplicatedData, {
      id: result.insertId,
      owner_id: req.user.id,
    });

    await saveCanvasData(result.insertId, localizeResult.data, {
      reason: 'duplicate',
      ownerId: req.user.id,
      createdBy: req.user.id,
      cooldownMs: 0,
    });
    const duplicatedRow = await getManageableCanvasForUser(req, result.insertId);
    if (!duplicatedRow) {
      res.status(500).json({ error: 'failed to load duplicated project' });
      return;
    }
    await duplicateProjectAssets(sourceRow, duplicatedRow);
    if (targetCollectionId !== null) {
      await touchCollectionTimestamp(targetCollectionId);
    }
    res.status(201).json(projectFromCanvasRowForUser(req, duplicatedRow));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects/:uuid/template', async (req, res, next) => {
  try {
    const sourceRow = await getReadableCanvasForUser(req, req.params.uuid);
    if (!sourceRow) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const sourceData = readCanvasData(sourceRow);
    const name = await ensureUniqueProjectName(req.user.id, req.body.name || `${sourceRow.title} 模板`);
    const defaultCanvasProject = sourceRow.project_id == null ? await getDefaultCanvasProject() : null;
    const targetAssignedProjectId = sourceRow.project_id != null ? Number(sourceRow.project_id) : defaultCanvasProject?.id || null;
    const [result] = await getPool().query(
      "INSERT INTO canvases (owner_id, collection_id, project_id, title, data, shared, canvas_role, template_source_canvas_id, template_source_owner_id) VALUES (?, NULL, ?, ?, ?, 0, 'template', ?, ?)",
      [
        req.user.id,
        targetAssignedProjectId,
        name,
        JSON.stringify(projectDataFor('pending')),
        sourceRow.id,
        sourceRow.owner_id
      ]
    );

    ensureProjectScaffold(result.insertId);
    const duplicatedData = deepRewriteProjectAssetUrls(sourceData, String(sourceRow.id), String(result.insertId));
    duplicatedData.nodeList = duplicateNodeListForProject(sourceData.nodeList, String(sourceRow.id), String(result.insertId));
    duplicatedData.projectDraft = {
      ...defaultProjectDraft(result.insertId, duplicatedData),
      ...(sourceData.projectDraft || {}),
      projectUuid: String(result.insertId),
      lastEditedAtMs: Date.now()
    };

    // 和复制同理：指向第三个画布的资产也要拉进来，否则模板对别人是缺图的
    const localizeResult = await localizeForeignAssets(duplicatedData, {
      id: result.insertId,
      owner_id: req.user.id,
    });

    await saveCanvasData(result.insertId, localizeResult.data, {
      reason: 'template_create',
      ownerId: req.user.id,
      createdBy: req.user.id,
      cooldownMs: 0,
    });
    const templateRow = await getManageableCanvasForUser(req, result.insertId);
    if (!templateRow) {
      res.status(500).json({ error: 'failed to load template canvas' });
      return;
    }
    await duplicateProjectAssets(sourceRow, templateRow);
    res.status(201).json(projectFromCanvasRowForUser(req, templateRow));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects/:uuid/access-session/enter', async (req, res, next) => {
  try {
    const row = await getReadableCanvasForUser(req, req.params.uuid);
    if (!row) return res.status(404).json({ error: 'canvas not found' });
    const session = await enterCanvasSession({
      canvasId: row.id,
      userId: req.user.id,
      clientId: req.body?.clientId,
    });
    const hydratedRow = await localizeCanvasExternalMedia(row);
    const project = projectFromCanvasRowForUser(req, hydratedRow);
    publishCanvasChange({
      canvasId: row.id,
      source: 'access_session',
      reason: 'access_session_replaced',
      clientId: req.body?.clientId,
      changedAtMs: Date.now(),
      updatedBy: req.user.id,
      accessSessionEpoch: session.epoch,
    });
    res.json({
      token: session.token,
      epoch: session.epoch,
      project,
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects/:uuid/access-session/heartbeat', async (req, res, next) => {
  try {
    const row = await getReadableCanvasForUser(req, req.params.uuid);
    if (!row) return res.status(404).json({ error: 'canvas not found' });
    const session = await requireCanvasSession(req, res, row.id, { touch: true });
    if (!session) return;
    res.json({ ok: true, epoch: Number(session.session_epoch || 0) });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects/:uuid/access-session/leave', async (req, res, next) => {
  try {
    const row = await getReadableCanvasForUser(req, req.params.uuid);
    if (!row) return res.status(404).json({ error: 'canvas not found' });
    const left = await leaveCanvasSession({
      canvasId: row.id,
      token: tokenFromRequest(req),
      userId: req.user.id,
    });
    res.json({ ok: true, left });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/projects/:uuid', async (req, res, next) => {
  try {
    const isPreview = req.query.preview === '1' || req.get('x-shotflow-canvas-preview') === '1';
    const row = isPreview
      ? await getReadableCanvasForUser(req, req.params.uuid)
      : await getSessionReadableCanvasForUser(req, res, req.params.uuid, { touch: true });
    if (!row) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    const hydratedRow = req.query.realtime === '1'
      ? row
      : await localizeCanvasExternalMedia(row);
    const project = projectFromCanvasRowForUser(req, hydratedRow);
    if (isPreview) {
      project.nodeList = project.nodeList.slice(0, 80).map((node) => {
        const data = parseCanvasNodeData(node);
        return {
          ...node,
          data: JSON.stringify({
            type: data.type,
            name: data.name,
            url: Array.isArray(data.url) ? data.url.slice(0, 1) : [],
            action: data.action,
            nodeKey: data.nodeKey,
            projectUuid: data.projectUuid,
          }),
        };
      });
    }
    res.json(project);
  } catch (error) {
    next(error);
  }
});

function parseCanvasNodeData(node) {
  if (!node) return {};
  if (typeof node.data === 'object' && node.data) return { ...node.data };
  try { return JSON.parse(node.data || '{}'); } catch { return {}; }
}

function nodeEventSnapshot(node) {
  return node ? {
    ...node,
    data: typeof node.data === 'string' ? node.data : JSON.stringify(node.data || {}),
  } : null;
}

function nodeEventVersion(node) {
  const data = parseCanvasNodeData(node);
  return Math.max(0, Number(data._collabVersion || 0));
}

// —— 节点删除护栏 ————————————————————————————————————————————————
// 2026-08-12 canvas 220（n=3 → 0）和 2026-08-13 canvas 238（n=3 → 2 → 1 → 0）两次节点
// 丢失是同一个形态：网页手里的节点表比服务端少，整表保存上来，服务端照抄。前端根因在
// syncProject 会丢掉自己不认识的远端节点，但服务端也有责任——它把"客户端列表里没有"
// 当成了删除意图。
//
// 这里原来写的前提是"真实删除从来都走显式接口"，那是错的：线上网页删节点只是在整表
// 保存里少带一个节点，delete / delete-v2 一次都没被调用过（2026-08-14 查 nginx 两个
// 日志周期，删除接口调用数 0）。于是"缺失一律保留"把每一次正常删除都撤销了——用户删
// 完刷新，节点又回来了。
//
// 所以规则按客户端能力分档，判据是"这个节点客户端到底见过没有"：
//
//   1. 客户端带了 deletedNodeKeys 字段（新协议，删除走 delete-v2）→ 整表保存里缺失
//      一律不算删除，只认显式声明；
//   2. 客户端没有这个字段（线上老网页，删除靠整表保存缺失）→ 只保留**客户端基准版本里
//      压根没有**的节点。它们是客户端不可能见过、更不可能删过的，缺失只能是 bug；
//      基准里有、客户端主动去掉的，按真实删除放行。
//   3. 节点级删除必须带 intent='user_delete'，并对"清空画布""短时间内批量删"额外要确认。
//
// 第 2 条为什么仍然挡得住原来的丢失：syncProject 丢的恰好是"本地没有的远端节点"，而
// 基准版本就是本地上一次认到的服务端状态——所以被它丢掉的节点几乎必然落在基准之外。
// canvas 232 就是这个形态：网页卡在 409 死循环里、基准停在几小时前，期间生成结果和
// Cindy 往画布里写的节点全在基准之外，照样会被保留。
// 兜底方向始终是"宁可节点刷新后回来，也不能悄悄没了"，但它不该以"谁都删不掉东西"为代价。
// 找客户端基准快照时回看多少个 revision、每批取几个（分批命中即停，见 nodes/batch）
const BASE_REVISION_LOOKBACK = 400;
const BASE_REVISION_BATCH = 8;

const NODE_DELETE_BURST_WINDOW_MS = 15_000;
// 15 秒内允许多少次"未声明批量"的单节点删除。
//
// 原来是 8，那个数字是给"从整表保存里推断出来的删除"设的——那种删除没有意图，所以宁可
// 拦早一点。现在删除都走 delete-v2 并且必须带 intent='user_delete'，意图本身已经是判据，
// 这道护栏只剩"挡住失控循环"一个作用，而 8 太低会挡住正常清理：一个一个删、15 秒内删到
// 第 9 个就被拒（第 9 个删不掉、刷新后又回来）。
//
// 40 的取法：失控循环每秒能打几十次，一两秒就撞上限；人手点删除大约每秒 2 次，要连续
// 15 秒不停才够 40 次。框选删多个不受影响——客户端会带 bulkDeleteConfirmed 直接跳过这道。
const NODE_DELETE_BURST_LIMIT = 40;
const nodeDeleteBurstByCanvas = new Map();

function nodeDeleteBurstCount(canvasId) {
  const key = String(canvasId);
  const cutoff = Date.now() - NODE_DELETE_BURST_WINDOW_MS;
  const stamps = (nodeDeleteBurstByCanvas.get(key) || []).filter((at) => at > cutoff);
  if (stamps.length) nodeDeleteBurstByCanvas.set(key, stamps);
  else nodeDeleteBurstByCanvas.delete(key);
  return stamps.length;
}

function recordNodeDelete(canvasId) {
  const key = String(canvasId);
  const stamps = nodeDeleteBurstByCanvas.get(key) || [];
  stamps.push(Date.now());
  nodeDeleteBurstByCanvas.set(key, stamps);
  if (nodeDeleteBurstByCanvas.size > 200) {
    const cutoff = Date.now() - NODE_DELETE_BURST_WINDOW_MS;
    for (const [canvas, list] of nodeDeleteBurstByCanvas) {
      if (!list.some((at) => at > cutoff)) nodeDeleteBurstByCanvas.delete(canvas);
    }
  }
}

// 整表保存的删除护栏在 services/CanvasNodeDeleteGuard.js（顶部 require），
// 单独成文件是为了能被 tests/canvas-node-delete-guard.test.ts 直接测到。


apiRouter.get('/projects/:uuid/node-events', async (req, res, next) => {
  try {
    const row = await getSessionReadableCanvasForUser(req, res, req.params.uuid);
    if (!row) return res.status(404).json({ error: 'canvas not found' });
    const afterId = Number(req.query.afterId || 0);
    const [rows] = await getContentPool().query(
      `SELECT id, node_key, node_version, event_type, node_snapshot, client_id, created_by, created_at
       FROM canvas_node_events
       WHERE canvas_id = ? AND id > ?
       ORDER BY id ASC LIMIT 500`,
      [row.id, Number.isFinite(afterId) && afterId > 0 ? afterId : 0]
    );
    res.json({ events: rows.map((event) => ({
      id: Number(event.id),
      nodeKey: event.node_key,
      nodeVersion: Number(event.node_version || 0),
      eventType: event.event_type,
      node: event.node_snapshot ? parseJsonDocument(event.node_snapshot, null) : null,
      clientId: event.client_id,
      updatedBy: event.created_by == null ? null : Number(event.created_by),
      createdAt: event.created_at,
    })) });
  } catch (error) { next(error); }
});

apiRouter.post('/projects/:uuid/nodes/upsert', async (req, res, next) => {
  try {
    await queueCanvasMutation(req.params.uuid, async () => {
      const row = await getSessionWritableCanvasForUser(req, res, req.params.uuid);
      if (!row) return res.status(404).json({ error: 'canvas not found' });
      const incoming = req.body?.node;
      const nodeKey = String(incoming?.nodeKey || incoming?.id || '').trim();
      if (!nodeKey || !incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'node is required' });
      const data = readCanvasData(row);
      const nodes = nodeListFromData(data, req.params.uuid);
      const index = nodes.findIndex((node) => String(node.nodeKey) === nodeKey);
      const current = index >= 0 ? nodes[index] : null;
      const expectedVersion = Math.max(0, Number(req.body?.expectedVersion || 0));
      const currentVersion = nodeEventVersion(current);
      if (current && expectedVersion !== currentVersion) {
        return res.status(409).json({ error: '节点已被其他页面更新', errorCode: 'CANVAS_NODE_VERSION_CONFLICT', currentVersion, node: nodeEventSnapshot(current) });
      }
      const next = {
        data: typeof incoming.data === 'string' ? incoming.data : JSON.stringify(incoming.data || {}),
        name: incoming.name || parseCanvasNodeData(incoming).name || current?.name || '节点',
        type: Number(incoming.type || current?.type || 2),
        status: Number(incoming.status || current?.status || 1),
        nodeKey,
        measured: incoming.measured || current?.measured || { width: 520, height: 350 },
        position: incoming.position || current?.position || { positionX: 0, positionY: 0 },
        projectUuid: String(req.params.uuid),
      };
      const nextData = parseCanvasNodeData(next);
      nextData._collabVersion = currentVersion + 1;
      next.data = JSON.stringify(nextData);
      if (index >= 0) nodes[index] = next; else nodes.push(next);
      data.nodeList = nodes;
      await saveCanvasData(req.params.uuid, data, { reason: 'node_upsert', ownerId: row.owner_id, createdBy: req.user.id, cooldownMs: 0 });
      const [result] = await getContentPool().query(`INSERT INTO canvas_node_events (canvas_id,node_key,node_version,event_type,node_snapshot,client_id,created_by) VALUES (?,?,?,?,?,?,?)`, [row.id,nodeKey,currentVersion+1,'upsert',JSON.stringify(next),String(req.body?.clientId || ''),req.user.id]);
      const contentVersion = crypto.createHash('sha1').update(JSON.stringify(nodes)).digest('hex');
      publishCanvasChange({ canvasId: req.params.uuid, source: 'node_collab', reason: 'node_upsert', revision: contentVersion, contentVersion, changedAtMs: Date.now(), updatedBy: req.user.id, clientId: req.body?.clientId, changedNodeKeys: [nodeKey], eventCursor: Number(result.insertId), nodeEvent: { id: Number(result.insertId), nodeKey, nodeVersion: currentVersion + 1, eventType: 'upsert', node: next } });
      res.json({ ok: true, node: next, nodeVersion: currentVersion + 1, contentVersion, eventId: Number(result.insertId) });
    });
  } catch (error) { next(error); }
});

apiRouter.post('/projects/:uuid/nodes/delete-v2', async (req, res, next) => {
  try {
    await queueCanvasMutation(req.params.uuid, async () => {
      const row = await getSessionWritableCanvasForUser(req, res, req.params.uuid);
      if (!row) return res.status(404).json({ error: 'canvas not found' });
      const nodeKey = String(req.body?.nodeKey || '').trim();
      if (!nodeKey) return res.status(400).json({ error: 'nodeKey is required' });
      // 只接受"人点了删除"的请求。从本地状态推断出来的消失不许删服务端数据。
      if (String(req.body?.intent || '').trim() !== 'user_delete') {
        return res.status(428).json({
          error: '删除节点缺少用户操作意图，已阻止',
          errorCode: 'CANVAS_DELETE_INTENT_REQUIRED',
        });
      }
      const data = readCanvasData(row);
      const nodes = nodeListFromData(data, req.params.uuid);
      const index = nodes.findIndex((node) => String(node.nodeKey) === nodeKey);
      if (index < 0) return res.json({ ok: true, deleted: false });
      if (nodes.length === 1 && req.body?.allowClearCanvas !== true) {
        return res.status(409).json({
          error: '这是画布最后一个节点，未确认清空画布，已阻止删除',
          errorCode: 'CANVAS_CLEAR_GUARD',
        });
      }
      if (req.body?.bulkDeleteConfirmed !== true && nodeDeleteBurstCount(row.id) >= NODE_DELETE_BURST_LIMIT) {
        return res.status(409).json({
          error: '短时间内连续删除节点过多，已阻止；请刷新页面确认画布状态',
          errorCode: 'CANVAS_DELETE_BURST_GUARD',
          windowMs: NODE_DELETE_BURST_WINDOW_MS,
        });
      }
      const currentVersion = nodeEventVersion(nodes[index]);
      const expectedVersion = Math.max(0, Number(req.body?.expectedVersion || 0));
      if (expectedVersion !== currentVersion) return res.status(409).json({ error: '节点已被其他页面更新', errorCode: 'CANVAS_NODE_VERSION_CONFLICT', currentVersion });
      nodes.splice(index, 1); data.nodeList = nodes;
      recordNodeDelete(row.id);
      await saveCanvasData(req.params.uuid, data, { reason: 'node_delete', ownerId: row.owner_id, createdBy: req.user.id, cooldownMs: 0 });
      const [result] = await getContentPool().query(`INSERT INTO canvas_node_events (canvas_id,node_key,node_version,event_type,node_snapshot,client_id,created_by) VALUES (?,?,?,?,?,?,?)`, [row.id,nodeKey,currentVersion+1,'delete',null,String(req.body?.clientId || ''),req.user.id]);
      const contentVersion = crypto.createHash('sha1').update(JSON.stringify(nodes)).digest('hex');
      publishCanvasChange({ canvasId: req.params.uuid, source: 'node_collab', reason: 'node_delete', revision: contentVersion, contentVersion, changedAtMs: Date.now(), updatedBy: req.user.id, clientId: req.body?.clientId, deletedNodeKeys: [nodeKey], eventCursor: Number(result.insertId), nodeEvent: { id: Number(result.insertId), nodeKey, nodeVersion: currentVersion + 1, eventType: 'delete' } });
      res.json({ ok: true, deleted: true, nodeVersion: currentVersion + 1, contentVersion, eventId: Number(result.insertId) });
    });
  } catch (error) { next(error); }
});

apiRouter.get('/projects/:uuid/events', async (req, res, next) => {
  try {
    const row = await getSessionReadableCanvasForUser(req, res, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: 'canvas not found' });
      return;
    }

    const canvasId = String(row.id);
    const data = readCanvasData(row);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event) => {
      if (res.destroyed) return;
      if (event.id) res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const sessionToken = tokenFromRequest(req);
    const sessionEpoch = Number(req.canvasAccessSession?.epoch || 0);
    const unsubscribe = subscribeCanvasChanges(canvasId, send);
    const heartbeat = setInterval(async () => {
      if (res.destroyed) return;
      try {
        const validation = await validateCanvasSession({
          canvasId,
          token: sessionToken,
          userId: req.user.id,
          touch: true,
        });
        if (!validation.ok || Number(validation.state?.session_epoch || 0) !== sessionEpoch) {
          send({
            type: 'access_session_revoked',
            canvasId,
            accessSessionEpoch: Number(validation.state?.session_epoch || 0) || null,
            errorCode: 'CANVAS_ACCESS_SESSION_REVOKED',
          });
          res.end();
          return;
        }
        res.write(': ping\n\n');
      } catch {
        res.end();
      }
    }, 5_000);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    send({
      id: `ready-${Date.now()}`,
      type: 'ready',
      canvasId,
      pluginEditAtMs: Number(data.projectDraft?.lastPluginEditAtMs || 0),
      changedNodeKeys: canvasChangedNodeKeysSince(canvasId, req.query.knownPluginEditAtMs),
    });
    req.on('close', close);
    res.on('close', close);
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/projects/:uuid', async (req, res, next) => {
  try {
    const row = await getManageableCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    const name = await ensureUniqueProjectName(row.owner_id, req.body.name, row.id);
    await getPool().query('UPDATE canvases SET title = ? WHERE id = ?', [name, req.params.uuid]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/projects/:uuid/collection', async (req, res, next) => {
  try {
    const row = await getManageableCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: 'project not found' });
      return;
    }

    const nextCollectionId =
      req.body.collectionId === null || req.body.collectionId === undefined || req.body.collectionId === ''
        ? null
        : Number(req.body.collectionId);
    if (nextCollectionId !== null && !Number.isFinite(nextCollectionId)) {
      res.status(400).json({ error: 'invalid collection id' });
      return;
    }

    if (nextCollectionId !== null) {
      const collectionRow = await getManageableCollectionForUser(req, nextCollectionId);
      if (!collectionRow) {
        res.status(404).json({ error: 'collection not found' });
        return;
      }
    }

    const previousCollectionId = row.collection_id != null ? Number(row.collection_id) : null;
    await getPool().query('UPDATE canvases SET collection_id = ? WHERE id = ?', [nextCollectionId, req.params.uuid]);
    if (previousCollectionId !== null && previousCollectionId !== nextCollectionId) {
      await touchCollectionTimestamp(previousCollectionId);
    }
    if (nextCollectionId !== null && nextCollectionId !== previousCollectionId) {
      await touchCollectionTimestamp(nextCollectionId);
    }

    const updatedRow = await getManageableCanvasForUser(req, req.params.uuid);
    res.json(projectFromCanvasRowForUser(req, updatedRow));
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/projects/:uuid/project', async (req, res, next) => {
  try {
    const row = await getManageableCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: 'project not found' });
      return;
    }

    const nextAssignedProjectIdRaw =
      req.body.assignedProjectId !== undefined ? req.body.assignedProjectId : req.body.projectId;
    const nextAssignedProjectId =
      nextAssignedProjectIdRaw === null || nextAssignedProjectIdRaw === undefined || nextAssignedProjectIdRaw === ''
        ? null
        : Number(nextAssignedProjectIdRaw);
    if (nextAssignedProjectId !== null && !Number.isFinite(nextAssignedProjectId)) {
      res.status(400).json({ error: 'invalid project id' });
      return;
    }

    const canvasProjectRow =
      nextAssignedProjectId === null ? await getDefaultCanvasProject() : await getCanvasProjectById(nextAssignedProjectId);
    if (!canvasProjectRow) {
      res.status(404).json({ error: 'assigned project not found' });
      return;
    }

    await getPool().query('UPDATE canvases SET project_id = ? WHERE id = ?', [canvasProjectRow.id, req.params.uuid]);
    const updatedRow = await getManageableCanvasForUser(req, req.params.uuid);
    res.json(projectFromCanvasRowForUser(req, updatedRow));
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/projects/:uuid', async (req, res, next) => {
  try {
    const row = await getManageableCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    const [result] = await getPool().query('DELETE FROM canvases WHERE id = ?', [req.params.uuid]);
    if (!result.affectedRows) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    if (row.collection_id != null) {
      await touchCollectionTimestamp(row.collection_id);
    }
    await removeProjectStoredAssets(row.id);
    removeProjectScaffold(row.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/canvas-collections', async (req, res, next) => {
  try {
    const name = cleanCollectionName(req.body.name);
    const [result] = await getPool().query('INSERT INTO canvas_collections (owner_id, name) VALUES (?, ?)', [
      req.user.id,
      name
    ]);
    const row = await getManageableCollectionForUser(req, result.insertId);
    res.status(201).json({ collection: collectionFromRow(row) });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/canvas-collections/:id', async (req, res, next) => {
  try {
    const row = await getManageableCollectionForUser(req, req.params.id);
    if (!row) {
      res.status(404).json({ error: 'collection not found' });
      return;
    }
    const name = cleanCollectionName(req.body.name);
    await getPool().query('UPDATE canvas_collections SET name = ? WHERE id = ?', [name, req.params.id]);
    const updatedRow = await getManageableCollectionForUser(req, req.params.id);
    res.json({ collection: collectionFromRow(updatedRow) });
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/canvas-collections/:id', async (req, res, next) => {
  try {
    const row = await getManageableCollectionForUser(req, req.params.id);
    if (!row) {
      res.status(404).json({ error: 'collection not found' });
      return;
    }
    await getPool().query('DELETE FROM canvas_collections WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/projects/:uuid/cover', async (req, res, next) => {
  try {
    const row = await getManageableCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    const data = readCanvasData(row);
    data.customCoverUrl = String(req.body.coverUrl || '');
    data.coverUrl = '';
    await saveCanvasData(req.params.uuid, data, {
      reason: 'cover_update',
      ownerId: row.owner_id,
      createdBy: req.user.id,
      cooldownMs: 0,
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/projects/:uuid/share', async (req, res, next) => {
  try {
    const row = await getManageableCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    const shared = req.body.shared ? 1 : 0;
    await getPool().query('UPDATE canvases SET shared = ? WHERE id = ?', [shared, req.params.uuid]);
    const updatedRow = await getManageableCanvasForUser(req, req.params.uuid);
    res.json(projectFromCanvasRowForUser(req, updatedRow));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/projects/:uuid/user-shares', async (req, res, next) => {
  try {
    const row = await getManageableCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: 'project not found' });
      return;
    }

    const [userRows] = await getPool().query(
      `SELECT id, username, role
       FROM users
       WHERE active = 1 AND id <> ?
       ORDER BY username ASC, id ASC`,
      [row.owner_id]
    );
    const [shareRows] = await getPool().query(
      `SELECT target_user_id
       FROM canvas_user_shares
       WHERE canvas_id = ?
       ORDER BY created_at ASC, id ASC`,
      [row.id]
    );

    res.json({
      users: userRows.map((userRow) => ({
        id: String(userRow.id),
        username: userRow.username,
        role: userRow.role === 'admin' ? 'admin' : 'user'
      })),
      sharedUserIds: shareRows.map((shareRow) => String(shareRow.target_user_id))
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/projects/:uuid/user-shares', async (req, res, next) => {
  try {
    const row = await getManageableCanvasForUser(req, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: 'project not found' });
      return;
    }

    const requestedIds = Array.isArray(req.body.userIds) ? req.body.userIds : [];
    const uniqueRequestedIds = Array.from(
      new Set(
        requestedIds
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0 && id !== Number(row.owner_id))
      )
    );

    let validIds = [];
    if (uniqueRequestedIds.length) {
      const placeholders = uniqueRequestedIds.map(() => '?').join(',');
      const [validRows] = await getPool().query(
        `SELECT id
         FROM users
         WHERE active = 1
           AND id <> ?
           AND id IN (${placeholders})`,
        [row.owner_id, ...uniqueRequestedIds]
      );
      validIds = validRows.map((validRow) => Number(validRow.id));
    }

    const pool = getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM canvas_user_shares WHERE canvas_id = ?', [row.id]);
      if (validIds.length) {
        await connection.query(
          'INSERT INTO canvas_user_shares (canvas_id, owner_id, target_user_id, shared_by_user_id) VALUES ?',
          [validIds.map((targetUserId) => [row.id, row.owner_id, targetUserId, req.user.id])]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    res.json({
      ok: true,
      sharedUserIds: validIds.map((id) => String(id))
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.patch('/projects/:uuid/draft', async (req, res, next) => {
  try {
    const row = await getSessionWritableCanvasForUser(req, res, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    const data = readCanvasData(row);
    data.projectDraft = {
      ...defaultProjectDraft(req.params.uuid, data),
      ...req.body,
      projectUuid: String(req.params.uuid),
      lastEditedAtMs: Date.now()
    };
    await saveCanvasData(req.params.uuid, data, {
      skipRevision: true,
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// 比较节点内容时必须把 _collabVersion 排除掉：客户端整表保存会把它当初加载到的
// 旧版本号一起发回来，如果拿它参与比较，"什么都没改"也会被判定成有变化——
// 于是每次自动保存都给所有节点 +1（canvas 232 一天内 0→13，内容一个字没动），
// 事件表和 contentVersion 跟着一起空转。
// 必须与键顺序无关：canvases.data 是 MySQL JSON 列，MySQL 读回来时会重排对象的键，
// 所以"库里的节点"和"客户端发上来的同一个节点"用 JSON.stringify 逐字节比永远不相等。
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function nodeContentSignature(node) {
  if (!node) return '';
  const data = parseCanvasNodeData(node);
  delete data._collabVersion;
  const rest = { ...node };
  delete rest.data;
  return stableStringify({ ...rest, data });
}

async function appendCanvasNodeEventsFromSnapshot({ canvasId, previousNodes, nextNodes, clientId, createdBy }) {
  const previousByKey = new Map((previousNodes || []).map((node) => [String(node.nodeKey), node]));
  const nextByKey = new Map((nextNodes || []).map((node) => [String(node.nodeKey), node]));
  const events = [];
  for (const [nodeKey, node] of nextByKey) {
    const previous = previousByKey.get(nodeKey);
    const currentVersion = nodeEventVersion(previous);
    const nodeData = parseCanvasNodeData(node);
    if (previous && nodeContentSignature(previous) === nodeContentSignature(node)) {
      // 内容没变：保留服务端当前的版本号，别让客户端带上来的旧值把它冲回去，
      // 也不写事件。
      nodeData._collabVersion = currentVersion;
      node.data = JSON.stringify(nodeData);
      continue;
    }
    // 版本号必须同时写回将要落盘的节点。原来只写进事件快照，于是库里的节点
    // _collabVersion 长期停在 0、事件表却一路涨到 8——服务端乐观锁比前者、客户端
    // 从事件流取后者，生成完再编辑就必然 409 并停掉整个画布的保存。
    nodeData._collabVersion = currentVersion + 1;
    node.data = JSON.stringify(nodeData);
    const snapshot = nodeEventSnapshot(node);
    const [result] = await getContentPool().query(`INSERT INTO canvas_node_events (canvas_id,node_key,node_version,event_type,node_snapshot,client_id,created_by) VALUES (?,?,?,?,?,?,?)`, [canvasId,nodeKey,currentVersion+1,'upsert',JSON.stringify(snapshot),String(clientId || ''),createdBy]);
    events.push({ id: Number(result.insertId), nodeKey, nodeVersion: currentVersion + 1, eventType: 'upsert', node: snapshot });
  }
  for (const [nodeKey, node] of previousByKey) {
    if (nextByKey.has(nodeKey)) continue;
    const version = nodeEventVersion(node) + 1;
    const [result] = await getContentPool().query(`INSERT INTO canvas_node_events (canvas_id,node_key,node_version,event_type,node_snapshot,client_id,created_by) VALUES (?,?,?,?,?,?,?)`, [canvasId,nodeKey,version,'delete',null,String(clientId || ''),createdBy]);
    events.push({ id: Number(result.insertId), nodeKey, nodeVersion: version, eventType: 'delete' });
  }
  return events;
}

apiRouter.post('/projects/:uuid/nodes/batch', async (req, res, next) => {
  try {
    await queueCanvasMutation(req.params.uuid, async () => {
    const row = await getSessionWritableCanvasForUser(req, res, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    if (!Array.isArray(req.body.nodes)) {
      res.status(400).json({ error: 'nodes must be array' });
      return;
    }
    const clientVersion = String(req.body.clientVersion || '').trim();
    if (clientVersion !== 'collab-20260810') {
      res.status(428).json({
        error: '当前页面版本已过期，请刷新页面后再保存',
        errorCode: 'CANVAS_CLIENT_VERSION_REQUIRED',
      });
      return;
    }
    const data = readCanvasData(row);
    const baseContentVersion = String(req.body.baseContentVersion || '').trim();
    const currentContentVersion = crypto.createHash('sha1').update(JSON.stringify(nodeListFromData(data, req.params.uuid))).digest('hex');
    if (!baseContentVersion) {
      res.status(428).json({
        error: '画布保存缺少内容版本，请刷新页面后重试',
        errorCode: 'CANVAS_CONTENT_VERSION_REQUIRED',
        currentContentVersion,
      });
      return;
    }
    let incomingNodes = req.body.nodes;
    // 客户端这次保存的基准版本里有哪些节点。删除护栏靠它区分"客户端见过、主动删掉的"
    // 和"客户端压根没见过、只能是 bug 弄丢的"。base 和 current 相等时基准就是当前服务端
    // 状态；不相等时在下面解析出 baseData 之后覆盖。
    let baseNodeKeys = new Set(
      nodeListFromData(data, req.params.uuid).map((node) => String(node.nodeKey))
    );
    if (baseContentVersion !== currentContentVersion) {
      // 必须先只排 id、再按 id 取 snapshot：snapshot 是 JSON 列，大画布单条就有 1MB+，
      // 而 canvas_revisions 上没有 (canvas_id, id) 索引，`ORDER BY id DESC` 会走 filesort
      // 并把大字段一起塞进 sort buffer（线上只有 256KB）→ 直接抛
      // "Out of sort memory"，整个保存返回 500。canvas 115（249 节点 / 1.48MB）
      // 2026-08-14 因此连续失败 2600 次，一次都没存上。
      const [revisionIdRows] = await getContentPool().query(
        `SELECT id FROM canvas_revisions WHERE canvas_id = ? ORDER BY id DESC LIMIT ?`,
        [row.id, BASE_REVISION_LOOKBACK]
      );
      const revisionIds = revisionIdRows.map((entry) => Number(entry.id)).filter(Number.isFinite);
      // 按批取快照并命中即停。以前是一条 IN(...) 把 100 个快照全拉进内存——canvas 115
      // 单个快照 1.47MB，100 个就是 ~147MB 一次性进 Node 堆，而基准几乎总是在最新的
      // 几个里面。分批之后既省内存，也才敢把回看范围放大：整表保存的 revision 冷却是
      // 5 秒，只回看 100 个等于只有 8 分钟历史，客户端基准稍微旧一点就永远找不回来，
      // 整个保存（包括用户的删除）连着被丢掉，只能靠刷新页面跳出。
      let baseData = null;
      for (let i = 0; i < revisionIds.length && !baseData; i += BASE_REVISION_BATCH) {
        const chunk = revisionIds.slice(i, i + BASE_REVISION_BATCH);
        const [snapshotRows] = await getContentPool().query(
          `SELECT id, snapshot FROM canvas_revisions WHERE id IN (${chunk.map(() => '?').join(',')})`,
          chunk
        );
        const byId = new Map(snapshotRows.map((entry) => [Number(entry.id), entry]));
        for (const id of chunk) {
          const revision = byId.get(id);
          if (!revision) continue;
          const candidate = parseJsonDocument(revision.snapshot, {});
          const candidateVersion = crypto.createHash('sha1')
            .update(JSON.stringify(nodeListFromData(candidate, req.params.uuid)))
            .digest('hex');
          if (candidateVersion === baseContentVersion) {
            baseData = candidate;
            break;
          }
        }
      }
      if (!baseData) {
        res.status(409).json({
          error: '画布基准版本已过期，无法安全合并',
          errorCode: 'CANVAS_CONTENT_VERSION_CONFLICT',
          currentContentVersion,
        });
        return;
      }
      baseNodeKeys = new Set(
        nodeListFromData(baseData, req.params.uuid).map((node) => String(node.nodeKey))
      );
      const merge = mergeNodeSnapshots(
        nodeListFromData(baseData, req.params.uuid),
        req.body.nodes,
        nodeListFromData(data, req.params.uuid)
      );
      if (!merge.merged) {
        // 一个节点冲突不该连坐整批。服务端**从没见过**的节点不可能冲突，
        // 拒绝它们没有任何道理——2026-08-13 canvas 232 就是这样：一个视频节点被
        // 生成结果反复改写、客户端又一直重发自己的版本，永久冲突，同批次里 13 个
        // 全新节点连着两天、7300 次保存全部陪葬，用户以为一直在正常保存。
        // 这里把全新节点单独落盘，冲突节点保持原样、仍然回 409（语义不变）。
        // 存过一次之后它们就不再是"新"的，重试不会重复写。
        const baseNodes = nodeListFromData(baseData, req.params.uuid);
        const currentNodes = nodeListFromData(data, req.params.uuid);
        const knownKeys = new Set([
          ...currentNodes.map((node) => String(node.nodeKey)),
          ...baseNodes.map((node) => String(node.nodeKey)),
        ]);
        const brandNewNodes = (Array.isArray(req.body.nodes) ? req.body.nodes : [])
          .filter((node) => node && node.nodeKey && !knownKeys.has(String(node.nodeKey)));
        // 删除同样不该被冲突连坐。冲突的是别的节点，用户删掉的那个跟它们没关系，
        // 可是 409 在删除逻辑之前就 return 了，于是整个保存被丢掉——用户删完刷新，
        // 节点又回来了，表现为"一半情况删不掉"。这些画布正卡在自锁的冲突环里
        // （基准过期 → 冲突 → 409 → isDirty 一直为真 → 前端拒绝 syncProject → 基准永不更新），
        // 只有刷新能跳出，期间所有删除全部作废。
        //
        // 放行条件卡死三条：客户端基准里有这个节点（它见过）、这个节点自己不在冲突名单里、
        // 且这次去掉的数量不超上限（一次去掉一大片是节点丢失，不是删除，见 CanvasNodeDeleteGuard）。
        const deletions = conflictSafeDeletions({
          baseNodes,
          incomingNodes: req.body.nodes,
          currentNodes,
          conflictNodeKeys: merge.conflictNodeKeys,
        });
        const appliedDeletedNodeKeys = deletions.appliedKeys;
        if (deletions.overLimit) {
          console.warn(
            `[canvas ${req.params.uuid}] 保存冲突，且一次要去掉 ${deletions.droppedKeys.length} 个节点，超过上限`
            + ` ${deletions.limit}（画布 ${currentNodes.length} 节点），删除一律不执行（疑似节点丢失）`
            + ` client=${req.body.clientId || '-'} user=${req.user.id}`
          );
        }
        let rescuedNewNodeKeys = [];
        if (brandNewNodes.length || appliedDeletedNodeKeys.length) {
          const deletedSet = new Set(appliedDeletedNodeKeys);
          const keptNodes = deletedSet.size
            ? currentNodes.filter((node) => !deletedSet.has(String(node.nodeKey)))
            : currentNodes;
          const nextNodeList = [...keptNodes, ...brandNewNodes];
          const partialEvents = await appendCanvasNodeEventsFromSnapshot({
            canvasId: row.id,
            previousNodes: currentNodes,
            nextNodes: nextNodeList,
            clientId: req.body.clientId,
            createdBy: req.user.id,
          });
          data.nodeList = nextNodeList;
          data.projectDraft = defaultProjectDraft(req.params.uuid, data);
          await saveCanvasData(req.params.uuid, data, {
            reason: appliedDeletedNodeKeys.length ? 'nodes_batch_partial' : 'nodes_batch_new_only',
            ownerId: row.owner_id,
            createdBy: req.user.id,
            cooldownMs: 0,
          });
          rescuedNewNodeKeys = brandNewNodes.map((node) => String(node.nodeKey));
          console.warn(
            `[canvas ${req.params.uuid}] 保存冲突，但已单独落盘：保住 ${rescuedNewNodeKeys.length} 个全新节点、`
            + `执行 ${appliedDeletedNodeKeys.length} 个删除`
            + ` client=${req.body.clientId || '-'} user=${req.user.id}`
            + ` conflict=${(merge.conflictNodeKeys || []).join(',')} new=${rescuedNewNodeKeys.join(',')}`
            + ` deleted=${appliedDeletedNodeKeys.join(',')}`
          );
          const savedRow = await getReadableCanvasForUser(req, req.params.uuid);
          const savedVersion = crypto.createHash('sha1')
            .update(JSON.stringify(nodeListFromData(readCanvasData(savedRow), req.params.uuid)))
            .digest('hex');
          const changedAtMs = Date.now();
          for (const nodeEvent of partialEvents) {
            publishCanvasChange({
              canvasId: req.params.uuid,
              source: 'legacy_snapshot_bridge',
              reason: nodeEvent.eventType === 'delete' ? 'node_delete' : 'node_upsert',
              revision: savedVersion,
              contentVersion: savedVersion,
              changedAtMs,
              updatedBy: req.user.id,
              clientId: req.body.clientId,
              changedNodeKeys: nodeEvent.eventType === 'upsert' ? [nodeEvent.nodeKey] : [],
              deletedNodeKeys: nodeEvent.eventType === 'delete' ? [nodeEvent.nodeKey] : [],
              eventCursor: nodeEvent.id,
              nodeEvent,
            });
          }
        }
        res.status(409).json({
          error: '同一个节点已在其他页面修改，已阻止覆盖',
          errorCode: 'CANVAS_NODE_VERSION_CONFLICT',
          currentContentVersion,
          changedNodeKeys: merge.conflictNodeKeys,
          rescuedNewNodeKeys,
          appliedDeletedNodeKeys,
        });
        return;
      }
      incomingNodes = merge.nodes;
    }
    const hasKnownPluginEditAtMs = Object.prototype.hasOwnProperty.call(req.body, 'knownPluginEditAtMs');
    const incomingKnownPluginEditAtMs = Number(req.body.knownPluginEditAtMs || 0);
    const currentPluginEditAtMs = Number(data.projectDraft?.lastPluginEditAtMs || 0);
    if (hasKnownPluginEditAtMs && (!Number.isFinite(incomingKnownPluginEditAtMs) || incomingKnownPluginEditAtMs < 0)) {
      res.status(400).json({ error: 'knownPluginEditAtMs must be a non-negative number' });
      return;
    }
    if (hasKnownPluginEditAtMs && incomingKnownPluginEditAtMs !== currentPluginEditAtMs) {
      res.status(409).json({
        error: '画布已被 Cindy 更新，正在同步最新节点',
        errorCode: 'CANVAS_PLUGIN_REVISION_CONFLICT',
        currentPluginEditAtMs,
        changedNodeKeys: canvasChangedNodeKeysSince(req.params.uuid, incomingKnownPluginEditAtMs),
      });
      return;
    }
    const incomingClientSaveAtMs = Number(req.body.clientSaveAtMs || 0);
    const currentClientSaveAtMs = Number(data.lastClientNodeSaveAtMs || data.projectDraft?.lastClientNodeSaveAtMs || 0);
    if (
      Number.isFinite(incomingClientSaveAtMs)
      && Number.isFinite(currentClientSaveAtMs)
      && incomingClientSaveAtMs > 0
      && currentClientSaveAtMs > 0
      && incomingClientSaveAtMs < currentClientSaveAtMs
    ) {
      res.json({ ok: true, skipped: 'stale_node_save' });
      return;
    }
    const previousNodeList = nodeListFromData(data, req.params.uuid);
    // 客户端列表里少了的节点，除非显式声明删除，一律留下（见上方护栏说明）。
    const rescue = rescueUndeclaredNodeRemovals({
      canvasUuid: req.params.uuid,
      currentNodes: previousNodeList,
      incomingNodes,
      declaredDeletedKeys: req.body.deletedNodeKeys,
      baseNodeKeys,
      declaresDeletions: Array.isArray(req.body.deletedNodeKeys),
      clientId: req.body.clientId,
      userId: req.user.id,
    });
    incomingNodes = rescue.nodes;
    // 先写节点事件：它会把 _collabVersion 写回 incomingNodes 里的节点对象，
    // 必须在 saveCanvasData 之前跑，落盘的节点才带着正确版本号。
    const nodeEvents = await appendCanvasNodeEventsFromSnapshot({
      canvasId: row.id,
      previousNodes: previousNodeList,
      nextNodes: incomingNodes,
      clientId: req.body.clientId,
      createdBy: req.user.id,
    });
    data.nodeList = incomingNodes;
    if (Number.isFinite(incomingClientSaveAtMs) && incomingClientSaveAtMs > 0) {
      data.lastClientNodeSaveAtMs = incomingClientSaveAtMs;
    }
    data.projectDraft = defaultProjectDraft(req.params.uuid, data);
    if (Number.isFinite(incomingClientSaveAtMs) && incomingClientSaveAtMs > 0) {
      data.projectDraft.lastClientNodeSaveAtMs = incomingClientSaveAtMs;
    }
    await saveCanvasData(req.params.uuid, data, {
      reason: 'nodes_batch',
      ownerId: row.owner_id,
      createdBy: req.user.id,
      cooldownMs: 5000,
    });
    const savedRow = await getReadableCanvasForUser(req, req.params.uuid);
    const savedData = readCanvasData(savedRow);
    const contentVersion = crypto.createHash('sha1').update(JSON.stringify(nodeListFromData(savedData, req.params.uuid))).digest('hex');
    const changedNodeKeys = [];
    const changedAtMs = Math.max(Date.now(), Number(data.projectDraft?.lastPluginEditAtMs || 0) + 1);
    publishCanvasChange({
      canvasId: req.params.uuid,
      source: 'web_canvas',
      reason: 'nodes_batch',
      revision: contentVersion,
      contentVersion,
      pluginEditAtMs: changedAtMs,
      changedAtMs,
      updatedBy: req.user.id,
      clientId: req.body.clientId,
      fullSnapshot: true,
      changedNodeKeys,
    });
    for (const nodeEvent of nodeEvents) {
      publishCanvasChange({
        canvasId: req.params.uuid,
        source: 'legacy_snapshot_bridge',
        reason: nodeEvent.eventType === 'delete' ? 'node_delete' : 'node_upsert',
        revision: contentVersion,
        contentVersion,
        changedAtMs,
        updatedBy: req.user.id,
        clientId: req.body.clientId,
        changedNodeKeys: nodeEvent.eventType === 'upsert' ? [nodeEvent.nodeKey] : [],
        deletedNodeKeys: nodeEvent.eventType === 'delete' ? [nodeEvent.nodeKey] : [],
        eventCursor: nodeEvent.id,
        nodeEvent,
      });
    }
    res.json({ ok: true, contentVersion, nodeEvents, rescuedNodeKeys: rescue.rescuedKeys });
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/projects/:uuid/nodes/delete', async (req, res, next) => {
  try {
    await queueCanvasMutation(req.params.uuid, async () => {
    const row = await getSessionWritableCanvasForUser(req, res, req.params.uuid);
    if (!row) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    const nodeKeys = Array.isArray(req.body.nodeKeys) ? req.body.nodeKeys.map(String) : [];
    const data = readCanvasData(row);
    const baseContentVersion = String(req.body.baseContentVersion || '').trim();
    const currentContentVersion = crypto.createHash('sha1').update(JSON.stringify(nodeListFromData(data, req.params.uuid))).digest('hex');
    if (!baseContentVersion || baseContentVersion !== currentContentVersion) {
      res.status(baseContentVersion ? 409 : 428).json({
        error: baseContentVersion
          ? '画布已在其他页面更新，已阻止旧页面删除最新节点'
          : '画布删除缺少内容版本，请刷新页面后重试',
        errorCode: baseContentVersion ? 'CANVAS_CONTENT_VERSION_CONFLICT' : 'CANVAS_CONTENT_VERSION_REQUIRED',
        currentContentVersion,
      });
      return;
    }
    data.nodeList = nodeListFromData(data, req.params.uuid).filter((node) => !nodeKeys.includes(String(node.nodeKey)));
    await saveCanvasData(req.params.uuid, data, {
      reason: 'nodes_delete',
      ownerId: row.owner_id,
      createdBy: req.user.id,
      cooldownMs: 0,
    });
    const contentVersion = crypto.createHash('sha1').update(JSON.stringify(data.nodeList)).digest('hex');
    const changedAtMs = Math.max(Date.now(), Number(data.projectDraft?.lastPluginEditAtMs || 0) + 1);
    publishCanvasChange({
      canvasId: req.params.uuid,
      source: 'web_canvas',
      reason: 'nodes_delete',
      revision: contentVersion,
      contentVersion,
      pluginEditAtMs: changedAtMs,
      changedAtMs,
      updatedBy: req.user.id,
      clientId: req.body.clientId,
      deletedNodeKeys: nodeKeys,
    });
    res.json({ ok: true, contentVersion });
    });
  } catch (error) {
    next(error);
  }
});

const upload = multer({
  dest: tmpDir(),
  limits: { fileSize: MAX_VIDEO_UPLOAD_BYTES },
});
const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff']);

async function persistUploadedAsset(canvasRow, file, options = {}) {
  if (!canvasRow || !file?.path || !fs.existsSync(file.path)) {
    throw new Error('A valid canvas and uploaded file are required');
  }

  const projectUuid = String(options.projectUuid || canvasRow.id || '');
  if (!projectUuid || (canvasRow.id != null && String(canvasRow.id) !== projectUuid)) {
    fs.rmSync(file.path, { force: true });
    throw new Error('Uploaded asset canvas does not match');
  }

  let sourcePath = file.path;
  try {
    let requestedName = safeOriginalName(options.originalName || file.originalname, 'upload');
    let uploadMimeType = await detectUploadedMimeType(sourcePath, file.mimetype, requestedName);
    const isVideoUpload = isVideoMimeType(uploadMimeType, requestedName);
    if (isVideoUpload && fs.statSync(sourcePath).size > MAX_VIDEO_UPLOAD_BYTES) {
      throw Object.assign(new Error(`Video files must be smaller than ${Math.round(MAX_VIDEO_UPLOAD_BYTES / 1024 / 1024)}MB`), { statusCode: 413 });
    }

    if (options.normalizeVideoToMp4) {
      if (!isVideoUpload) {
        throw Object.assign(new Error('Only video uploads can be converted to MP4'), { statusCode: 400 });
      }
      const mp4Path = await transcodeVideoCompareUploadToMp4(sourcePath);
      fs.rmSync(sourcePath, { force: true });
      sourcePath = mp4Path;
      requestedName = mp4UploadFileName(requestedName);
      uploadMimeType = 'video/mp4';
      if (fs.statSync(sourcePath).size > MAX_VIDEO_UPLOAD_BYTES) {
        throw Object.assign(new Error(`MP4 files must be smaller than ${Math.round(MAX_VIDEO_UPLOAD_BYTES / 1024 / 1024)}MB`), { statusCode: 413 });
      }
    }

    const sha1 = sha1File(sourcePath);
    const requestedExt = path.extname(requestedName);
    const inferredExt = extensionFromMimeType(uploadMimeType);
    const ext = requestedExt && mimeTypeFromName(requestedName) !== 'application/octet-stream'
      ? requestedExt
      : inferredExt;
    const safeExt = String(ext || '.bin').replace(/[^a-zA-Z0-9.]/g, '') || '.bin';
    const originalName = requestedExt && requestedExt.toLowerCase() === safeExt.toLowerCase()
      ? requestedName
      : `${path.basename(requestedName, requestedExt || undefined)}${safeExt}`;
    const storedName = `${sha1}${safeExt}`;
    const dest = path.join(assetsDir(projectUuid), storedName);

    if (!fs.existsSync(dest)) fs.renameSync(sourcePath, dest);
    else fs.rmSync(sourcePath, { force: true });
    sourcePath = '';

    await mirrorStoredAsset(projectUuid, storedName, dest, uploadMimeType);

    const byteSize = fs.statSync(dest).size;
    await upsertAssetRecord(canvasRow, {
      originalName,
      storedName,
      relativePath: assetRelativePath(projectUuid, storedName),
      mimeType: uploadMimeType,
      byteSize,
      sha1,
      sourceType: String(options.sourceType || 'upload'),
    });

    const url = `/assets/${projectUuid}/${storedName}`;
    let thumbUrl = url;
    if (imageExts.has(safeExt.toLowerCase())) {
      const thumbDest = path.join(assetsDir(projectUuid), `${sha1}_thumb.webp`);
      const sharp = getSharp();
      if (sharp && !fs.existsSync(thumbDest)) {
        await sharp(dest).resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 85 }).toFile(thumbDest).catch(() => null);
      }
      if (fs.existsSync(thumbDest)) {
        await mirrorStoredAsset(projectUuid, `${sha1}_thumb.webp`, thumbDest, 'image/webp');
        thumbUrl = `/assets/${projectUuid}/${sha1}_thumb.webp`;
      }
    }

    const meta = await probeMediaMetadata(dest, uploadMimeType, storedName);
    meta.sha1 = sha1;
    meta.originalUrl = url;
    meta.createdAtMs = Date.now();

    if (isVideoUpload) {
      const display = await createDisplayVideoAsset(projectUuid, sha1, dest, uploadMimeType);
      if (display?.url) {
        meta.displayUrl = display.url;
        meta.displayByteSize = display.byteSize;
        if (display.meta?.width) meta.displayWidth = display.meta.width;
        if (display.meta?.height) meta.displayHeight = display.meta.height;
        if (display.meta?.durationSec) meta.displayDurationSec = display.meta.durationSec;
      }
    }

    return { url, thumbUrl, displayUrl: meta.displayUrl, sha1, meta, originalName };
  } finally {
    if (sourcePath) fs.rmSync(sourcePath, { force: true });
  }
}

apiRouter.post('/assets/upload', upload.single('file'), async (req, res, next) => {
  try {
    const projectUuid = String(req.body.projectUuid || '');
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!req.file || !row) {
      if (req.file?.path) fs.rmSync(req.file.path, { force: true });
      res.status(400).json({ error: 'missing file or projectUuid' });
      return;
    }
    res.json(await persistUploadedAsset(row, req.file, {
      projectUuid,
      sourceType: String(req.body.sourceType || 'upload'),
      normalizeVideoToMp4: String(req.body.normalizeVideoToMp4 || '') === '1',
    }));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/assets/copy', async (req, res, next) => {
  try {
    const projectUuid = String(req.body.projectUuid || '');
    const sourceUrl = String(req.body.sourceUrl || '');
    const dest = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!dest) return;
    const parsed = parseLocalAssetUrl(sourceUrl);
    if (!parsed) {
      res.status(400).json({ error: 'sourceUrl 必须是 /assets/{画布}/{文件}' });
      return;
    }
    if (String(parsed.projectUuid) === String(projectUuid)) {
      res.json({ url: `/assets/${projectUuid}/${parsed.storedName}`, copied: false });
      return;
    }
    const readable = await getReadableCanvasForUser(req, parsed.projectUuid);
    if (!readable) {
      res.status(403).json({ error: `没有画布 ${parsed.projectUuid} 的读取权限` });
      return;
    }
    const sourcePath = await ensureAssetLocalPath(parsed.projectUuid, parsed.storedName);
    if (!fs.existsSync(sourcePath)) {
      res.status(404).json({ error: '源素材文件不存在' });
      return;
    }
    const destPath = path.join(assetsDir(projectUuid), parsed.storedName);
    if (!fs.existsSync(destPath)) fs.copyFileSync(sourcePath, destPath);
    const mimeType = mimeTypeFromName(parsed.storedName);
    const byteSize = fs.statSync(destPath).size;
    const sha1 = sha1File(destPath);
    await mirrorStoredAsset(projectUuid, parsed.storedName, destPath, mimeType);
    await upsertAssetRecord(dest, {
      originalName: parsed.storedName,
      storedName: parsed.storedName,
      relativePath: assetRelativePath(projectUuid, parsed.storedName),
      mimeType,
      byteSize,
      sha1,
      sourceType: 'copy',
    });
    res.json({ url: `/assets/${projectUuid}/${parsed.storedName}`, copied: true });
  } catch (error) {
    next(error);
  }
});

function permanentHistoryKind(mimeType, url) {
  if (String(mimeType || '').startsWith('video/') || /\.(mp4|mov|webm)(?:$|\?)/i.test(String(url || ''))) return 'video';
  if (String(mimeType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)(?:$|\?)/i.test(String(url || ''))) return 'image';
  return null;
}

apiRouter.get('/projects/:projectUuid/history-assets', async (req, res, next) => {
  try {
    const row = await getSessionReadableCanvasForUser(req, res, req.params.projectUuid);
    if (!row) return res.status(404).json({ error: 'canvas not found' });
    await backfillAssetRecords(row);
    const items = new Map();
    const push = (item) => {
      if (!item?.url || !item?.kind) return;
      const key = `${item.kind}:${item.url}`;
      const previous = items.get(key);
      if (!previous || Number(item.timestamp || 0) >= Number(previous.timestamp || 0)) items.set(key, item);
    };
    const [assetRows] = await getContentPool().query(
      `SELECT stored_name, original_name, mime_type, byte_size, sha1, source_type, created_at, updated_at
       FROM canvas_assets WHERE canvas_id = ? ORDER BY created_at ASC, id ASC`,
      [row.id]
    );
    for (const asset of assetRows) {
      const url = `/assets/${row.id}/${asset.stored_name}`;
      const kind = permanentHistoryKind(asset.mime_type, url);
      if (
        !kind
        || String(asset.stored_name).includes('_display.')
        || String(asset.source_type || '') === 'generated-original'
      ) continue;
      push({ id: `asset:${asset.sha1 || asset.stored_name}`, url, kind, name: asset.original_name || asset.stored_name, timestamp: dateMs(asset.created_at), sourceType: asset.source_type || 'upload', meta: { mimeType: asset.mime_type, byteSize: Number(asset.byte_size || 0), hashSha1: asset.sha1, originalUrl: url, createdAtMs: dateMs(asset.created_at) } });
    }
    const [taskRows] = await getUsagePool().query(
      `SELECT t.job_id, t.node_key, t.task_type, t.model, t.resolution, t.generation_version,
              t.result_urls, t.completed_at, t.updated_at, o.output_index, o.asset_url, o.mime_type,
              o.width, o.height, o.duration_sec, o.metadata
       FROM generation_tasks t
       LEFT JOIN generation_task_outputs o ON o.job_id = t.job_id
       WHERE t.project_uuid = ? AND t.status = 'succeeded'
       ORDER BY t.completed_at ASC, t.id ASC, o.output_index ASC`,
      [String(row.id)]
    );
    for (const task of taskRows) {
      const urls = task.asset_url ? [task.asset_url] : parseJsonDocument(task.result_urls, []);
      for (const [index, url] of (Array.isArray(urls) ? urls : []).entries()) {
        const mimeType = task.mime_type || mimeTypeFromName(url);
        const kind = permanentHistoryKind(mimeType, url);
        if (!kind) continue;
        const timestamp = dateMs(task.completed_at || task.updated_at);
        push({ id: `task:${task.job_id}:${task.output_index ?? index}`, url: String(url), kind, name: kind === 'video' ? '生成视频' : '生成图片', timestamp, sourceType: 'generated', nodeKey: task.node_key, taskId: task.job_id, generationVersion: Number(task.generation_version || 0), meta: { mimeType, width: task.width == null ? undefined : Number(task.width), height: task.height == null ? undefined : Number(task.height), durationSec: task.duration_sec == null ? undefined : Number(task.duration_sec), model: task.model, resolution: task.resolution, createdAtMs: timestamp, ...(parseJsonDocument(task.metadata, {}) || {}) } });
      }
    }
    const [hiddenRows] = await getContentPool().query(
      'SELECT asset_url_hash FROM canvas_history_hidden_assets WHERE canvas_id = ? AND user_id = ?',
      [row.id, req.user.id]
    );
    const hidden = new Set(hiddenRows.map((item) => item.asset_url_hash));
    const history = [...items.values()]
      .filter((item) => !hidden.has(crypto.createHash('sha256').update(String(item.url)).digest('hex')))
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    res.json({ items: history });
  } catch (error) { next(error); }
});

apiRouter.post('/projects/:projectUuid/history-assets/hide', async (req, res, next) => {
  try {
    const row = await getSessionReadableCanvasForUser(req, res, req.params.projectUuid);
    if (!row) return res.status(404).json({ error: 'canvas not found' });
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    await getContentPool().query(
      `INSERT INTO canvas_history_hidden_assets (canvas_id, user_id, asset_url_hash, asset_url)
       VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE hidden_at = CURRENT_TIMESTAMP`,
      [row.id, req.user.id, hash, url]
    );
    res.json({ ok: true });
  } catch (error) { next(error); }
});

apiRouter.get('/assets/:projectUuid', async (req, res, next) => {
  try {
    const row = await getSessionReadableCanvasForUser(req, res, req.params.projectUuid);
    if (!row) {
      res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }
    res.json(await listAssetsInCanvas(row));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/assets', async (req, res, next) => {
  try {
    const [rows] = await getPool().query(
      'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE owner_id = ? ORDER BY updated_at DESC',
      [req.user.id]
    );
    const all = [];
    for (const row of rows) {
      const assets = await listAssetsInCanvas(row);
      all.push(...assets.map((asset) => ({ ...asset, projectUuid: String(row.id) })));
    }
    res.json(all);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/backup/export', async (req, res, next) => {
  try {
    await syncProjectCatalogCache();
    const [rows] = await getPool().query(
      `SELECT
         c.id,
         c.owner_id,
         c.collection_id,
         c.project_id,
         c.title,
         c.data,
         c.shared,
         c.canvas_role,
         c.template_source_canvas_id,
         c.template_source_owner_id,
         c.created_at,
         c.updated_at,
         cc.name AS collection_name,
         cp.name AS project_name,
         cp.status AS project_status
       FROM canvases c
       LEFT JOIN canvas_collections cc ON cc.id = c.collection_id
       LEFT JOIN canvas_projects cp ON cp.id = c.project_id
       WHERE c.owner_id = ?
       ORDER BY c.updated_at DESC`,
      [req.user.id]
    );
    const hydratedRows = await hydrateCanvasRows(rows);
    const [collectionRows] = await getPool().query(
      `SELECT
         cc.id,
         cc.owner_id,
         cc.name,
         cc.created_at,
         cc.updated_at,
         u.username AS owner_name,
         COUNT(c.id) AS canvas_count
       FROM canvas_collections cc
       INNER JOIN users u ON u.id = cc.owner_id
       LEFT JOIN canvases c ON c.collection_id = cc.id AND c.canvas_role = 'normal'
       WHERE cc.owner_id = ?
       GROUP BY cc.id, cc.owner_id, cc.name, cc.created_at, cc.updated_at, u.username
       ORDER BY cc.updated_at DESC`,
      [req.user.id]
    );
    const availableProjects = await listCanvasProjects();
    const payload = {
      version: 3,
      exportedAt: new Date().toISOString(),
      canvasProjects: availableProjects,
      collections: collectionRows.map(collectionFromRow),
      projects: hydratedRows.map(projectFromCanvasRow)
    };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tapflow-backup-${timestamp}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/backup/import', upload.single('backup'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'backup file is required' });
      return;
    }
    const raw = fs.readFileSync(req.file.path, 'utf8');
    fs.rmSync(req.file.path, { force: true });
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.status(400).json({ error: 'backup file must be valid JSON' });
      return;
    }
    const collections = Array.isArray(payload.collections) ? payload.collections : [];
    const collectionIdMap = new Map();
    const availableProjects = await listCanvasProjects();
    const projectIdMap = new Map();
    const existingProjectsByName = new Map(availableProjects.map((project) => [String(project.name), project]));

    for (const projectEntry of Array.isArray(payload.canvasProjects) ? payload.canvasProjects : []) {
      const sourceProjectId = projectEntry?.id;
      const projectName = String(projectEntry?.name || '').trim();
      if (!projectName) continue;
      let targetProject = existingProjectsByName.get(projectName);
      if (!targetProject) {
        const insertedStatus = ['not_started', 'in_progress', 'completed'].includes(String(projectEntry?.status))
          ? String(projectEntry.status)
          : 'not_started';
        const createdProject = await createProjectInCatalog(projectName.slice(0, 160), insertedStatus);
        targetProject = createdProject ? canvasProjectFromRow(createdProject) : null;
        if (targetProject) {
          existingProjectsByName.set(projectName, targetProject);
        }
      }
      if (sourceProjectId != null && targetProject) {
        projectIdMap.set(String(sourceProjectId), Number(targetProject.id));
      }
    }

    const defaultCanvasProject = await getDefaultCanvasProject();
    for (const collection of collections) {
      const sourceCollectionId = collection?.id;
      const name = cleanCollectionName(collection?.name || 'Imported collection');
      const [collectionResult] = await getPool().query(
        'INSERT INTO canvas_collections (owner_id, name) VALUES (?, ?)',
        [req.user.id, name]
      );
      if (sourceCollectionId != null) {
        collectionIdMap.set(String(sourceCollectionId), collectionResult.insertId);
      }
    }

    const projects = Array.isArray(payload.projects) ? payload.projects : [];
    let imported = 0;
    for (const project of projects) {
      const name = await ensureUniqueProjectName(req.user.id, String(project.projectMeta?.name || 'Imported canvas') + ' - Imported');
      const data = projectDataFor('pending', {
        nodeList: Array.isArray(project.nodeList) ? project.nodeList : [],
        projectDraft: project.projectDraft || defaultProjectDraft('pending'),
        coverUrl: project.projectMeta?.coverUrl || ''
      });
      const sourceCollectionId = project?.projectMeta?.collectionId;
      const mappedCollectionId =
        sourceCollectionId != null && collectionIdMap.has(String(sourceCollectionId))
          ? collectionIdMap.get(String(sourceCollectionId))
          : null;
      const sourceAssignedProjectId = project?.projectMeta?.assignedProjectId;
      const mappedAssignedProjectId =
        sourceAssignedProjectId != null && projectIdMap.has(String(sourceAssignedProjectId))
          ? projectIdMap.get(String(sourceAssignedProjectId))
          : defaultCanvasProject
            ? Number(defaultCanvasProject.id)
            : null;
      const [result] = await getPool().query(
        'INSERT INTO canvases (owner_id, collection_id, project_id, title, data) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, mappedCollectionId, mappedAssignedProjectId, name, JSON.stringify(data)]
      );
      ensureProjectScaffold(result.insertId);
      data.projectDraft = { ...defaultProjectDraft(result.insertId, data), projectUuid: String(result.insertId) };
      data.nodeList = data.nodeList.map((node) => ({ ...node, projectUuid: String(result.insertId) }));
      await saveCanvasData(result.insertId, data, {
        reason: 'import',
        ownerId: req.user.id,
        createdBy: req.user.id,
        cooldownMs: 0,
      });
      if (mappedCollectionId != null) {
        await touchCollectionTimestamp(mappedCollectionId);
      }
      imported += 1;
    }
    res.json({ message: `闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧湱鈧懓瀚崳纾嬨亹閹烘垹鍊炲銈嗗笒椤︿即寮查鍫熷仭婵犲﹤鍟版晥濠电姭鍋撳〒姘ｅ亾婵﹨娅ｇ槐鎺懳熼搹閫涚礃婵犵妲呴崑鍕偓姘煎枤閸掓帗绻濆顓炰汗缂傚倷鐒﹂…鍥储閻㈠憡鈷戠痪顓炴媼濞兼劙鏌涢弮鎾剁暤鐎规洟娼ч埢搴ㄥ箣閻樼绱查梻浣虹帛閿曘垹顭囪瀵鈽夊▎鎰伎婵犵數濮抽懗鍫曟儗濞嗘垟鍋撶憴鍕闁绘牕銈搁妴浣肝旈崨顓犲姦濡炪倖甯婄欢锟犲绩娴煎瓨鈷掗柛灞剧懅椤︼附绻濋埀顒佹綇閵婏附鐝峰┑掳鍊愰崑鎾淬亜椤撶偟浠㈤摶锝夋煠濞村娅囬柣鎺戙偢濮婃椽宕ㄦ繝鍌氼潊闂佸搫鍊搁崐鍦矉瀹ュ拋鐓ラ柛顐ゅ枔閸樻悂姊洪幖鐐插姉闁哄懏绋掔粋鎺楁晝閸屾稓鍘遍梺鎸庣箓濡瑩濡靛┑瀣厸鐎光偓鐎ｎ剛鐦堥悗瑙勬处娴滄繈骞忛崨瀛樺€婚柦妯侯槷缁絽鈹戦悩鎰佸晱闁哥姵鐗犻弫鍐晜閹冪亰濡炪倖鐗楃划搴ｇ不閺冨牊鐓熼柡鍐ㄥ€哥敮鍫曟煟閹邦剨鍔熼柟鑼焾椤撳吋寰勫☉姘扁棨闂備礁鍟块幖顐﹀疮閹殿喖顥氶柦妯侯棦瑜版帗鏅查柛娑卞弾濡苯鈹戦埄鍐ㄧ祷闁硅绻濇俊鐢稿礋椤栨艾宓嗛梺闈涱焾閸庤京绮绘繝姘拺?${imported} 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣閿濆棭妫勯梺鍝勵儎缁舵岸寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閻愵剙鍔ゆい顓犲厴瀵鏁愭径濠勭杸濡炪倖甯婇悞锕傚磿閹剧粯鈷戦柟鑲╁仜婵″ジ鏌涙繝鍌涘仴鐎殿喛顕ч埥澶愬閳哄倹娅囬梻浣瑰缁诲倸螞濞戔懞鍥Ψ瑜忕壕钘壝归敐鍛儓鐎涙繄绱撻崒姘毙㈤柨鏇ㄤ簻椤曪絿鎷犲顔兼倯婵犮垼娉涢敃锝囨閸洘鈷戦柛娑橈攻婢跺嫰鏌涚€Ｑ冧壕闂備胶顭堥鍡涘箰閼姐倖宕叉繝闈涙－濞尖晠鏌曟径鍫濈仼濞存粓绠栭弻娑樷槈濞嗘劗绋囬梺钘夊暟閸犳牠寮婚弴鐔风窞婵炴垶锕╁ú顓㈡⒑閸涘⊕鑲╁垝濞嗗浚娼栧Δ锕侊骏娴滃綊鏌熼悜妯虹仯闁哥姴锕娲川婵犲啫闉嶉悗鍏夊亾闁归棿鑳跺畵渚€鏌涢埄鍐槈闂佸崬娲弻鏇熷緞濞戞﹩娲梺鍛娚戦幃鍌炲蓟閿濆棙鍎熸い鏍ㄧ矊閻繈姊洪崫鍕櫤缂佽瀚崚鎺楁晲婢跺﹦鐫勯梺鍓插亞閸犳捇宕㈤幖浣圭厽闊洦娲栨禒婊冾熆瑜戝Λ鍕弲闁诲孩绋掗敃鈺佲枔娴犲鐓熼柟閭﹀枟閻撳繑銇勮箛鎾村窛濞存粍鐟╁缁樼瑹閳ь剟鍩€椤掑倸浠滈柤娲诲灡閺呰埖瀵肩€涙鍘撻悷婊勭矒瀹曟粌顫濈捄铏诡槱閻熸粎澧楃敮鎺楀磼閵娿儮鏀介柛灞剧矤閻掗箖鏌ｉ幘瀵哥疄闁哄瞼鍠栭幃娆擃敆娴ｈ櫣鈻忔俊鐐€栧ú鐔哥閸洖绠栨俊銈傚亾闁宠棄顦埢宥嗘綇閵娿儱鎽靛Δ?` });
  } catch (error) {
    next(error);
  }
});

// ── 封面缩略图（派生图）──────────────────────────────────────────────────
/**
 * 画布卡片封面以前直接用资产原图：线上实测持有 25 张画布的人，22 个封面合计 71.91 MB，
 * 图片中位数 2037 KB、最大 9654 KB，还有一个 16.56 MB 的 mp4 被前端 <video> 元素实时取帧
 * —— 而卡片只有 176px 宽。现在 ?w=<宽> 让服务端生成一次静态 webp 落盘缓存，
 * 视频封面用 ffmpeg 抽第一帧变成静态图，页面上再没有 <video>。
 *
 * 只认白名单宽度：否则别人拿 ?w=99999 就能把 CPU 和磁盘打满。
 */
const DERIVED_WIDTHS = new Set([176, 352, 704]);
const DERIVED_VIDEO_NAME_RE = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
/** 同一个派生文件只生成一次：一屏 20 多张卡首次访问会并发打进来 */
const derivedInFlight = new Map();

/**
 * 派生目录故意放在 projectDir 下、**不放进 assets/**：
 * duplicateProjectAssets 会 readdirSync(assets) 把每一项当文件复制，
 * 里面多一个子目录就会炸；backfillAssetRecords 也在扫那一层。
 */
function derivedAssetsDir(projectUuid) {
  return path.join(projectDir(projectUuid), '_derived');
}

function normalizeDerivedWidth(value) {
  const width = Number(value);
  return DERIVED_WIDTHS.has(width) ? width : 0;
}

async function buildDerivedCover(sourcePath, outPath, width, isVideo) {
  const tmpPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  const framePath = `${tmpPath}.png`;
  try {
    if (isVideo) {
      // -ss 放在 -i 前面是关键帧快进，几十毫秒就能出这一帧；放后面会解码到那个时间点。
      await execFileAsync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-ss', '0.05', '-i', sourcePath,
        '-frames:v', '1', '-vf', `scale=${width}:-2`,
        framePath,
      ], { timeout: 60_000 });
      if (!fs.existsSync(framePath)) throw new Error('ffmpeg did not create frame');
      await getSharp()(framePath).webp({ quality: 78 }).toFile(tmpPath);
    } else {
      await getSharp()(sourcePath)
        .rotate() // 按 EXIF 转正，否则手机拍的封面会躺着
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(tmpPath);
    }
    // 先写临时文件再改名：并发读不会读到半个文件
    fs.renameSync(tmpPath, outPath);
    return outPath;
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  } finally {
    fs.rmSync(framePath, { force: true });
  }
}

async function ensureDerivedCover(projectUuid, storedName, width) {
  const outName = `${storedName}.w${width}.webp`;
  const outPath = path.join(derivedAssetsDir(projectUuid), outName);
  if (fs.existsSync(outPath)) return outPath;
  const key = `${projectUuid}/${outName}`;
  const pending = derivedInFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    const sourcePath = await ensureAssetLocalPath(projectUuid, storedName);
    if (!fs.existsSync(sourcePath)) throw new Error('source asset missing');
    ensureDir(derivedAssetsDir(projectUuid));
    return buildDerivedCover(sourcePath, outPath, width, DERIVED_VIDEO_NAME_RE.test(storedName));
  })();
  derivedInFlight.set(key, work);
  try {
    return await work;
  } finally {
    derivedInFlight.delete(key);
  }
}

assetRouter.get('/:projectUuid/:filename', async (req, res, next) => {
  try {
    const row = await getReadableCanvasForUser(req, req.params.projectUuid);
    if (!row) {
      res.status(404).end();
      return;
    }
    const storedName = path.basename(req.params.filename);
    const derivedWidth = normalizeDerivedWidth(req.query.w);
    if (derivedWidth) {
      try {
        const derivedPath = await ensureDerivedCover(req.params.projectUuid, storedName, derivedWidth);
        // 内容由「原资产 + 宽度」唯一决定，而宽度已经写进文件名，所以可以永久缓存。
        // 原资产那条路径的缓存头保持原样不动（它可能被覆盖）。
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.sendFile(derivedPath);
        return;
      } catch (error) {
        // 生成失败绝不让封面变空白：退回发原图。
        console.warn(`derived cover failed for ${req.params.projectUuid}/${storedName}:`, error.message);
      }
    }
    const filePath = await ensureAssetLocalPath(req.params.projectUuid, storedName);
    if (!fs.existsSync(filePath)) {
      res.status(404).end();
      return;
    }
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

let cachedMivoToken = null;
let mivoTokenPromise = null;
const mivoBaseUrl = config.mivoBaseUrl || 'https://aigc.xindong.com';
const openaiBaseUrl = config.openaiBaseUrl || 'https://api.openai.com/v1';
const llmBaseUrl = config.llmBaseUrl || 'https://llm-proxy.tapsvc.com';

function requireMivoKey() {
  if (!config.mivoApiKey) throw new Error('闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚敐澶婄闁挎繂鎲涢幘缁樼厱濠电姴鍊归崑銉╂煛鐏炶濮傜€殿喗鎸抽幃娆徝圭€ｎ亙澹曢梺鍛婄缚閸庤櫕绋夊澶嬬厸鐎广儱楠搁獮妤呮煟閹惧瓨绀冮柕鍥у楠炲洭宕滄担鑽锋垹绱撴担鎻掍壕闂侀€炲苯澧扮紒杈ㄥ浮閹瑩顢楅埀顒勫礉閵堝棛绠鹃悘蹇旂墤閸嬫捇骞囨担鍛婎吙闂備礁澹婇崑鍛洪弽顓熺厑闁搞儯鍔庣粻楣冩煙鐎甸晲绱虫い蹇撶墐閳ь剚鐗楀鍕箾閻愵剚鏉搁梻浣虹帛閸旀洖顕ｉ崼鏇為棷闁芥ê顦弨浠嬫煟閹般劍娅呭ù婊堢畺濮婄粯鎷呴崨濠冨創闁荤偞鍑归崑濠傜暦閹邦兘鏀介悗锝庡墮缁侊附绻涢幘鏉戠劰闁稿鎸婚〃銉╂倷閺夋垶璇炲Δ鐘靛仜椤戝懘鍩為幋锕€骞㈤柍鍝勫€圭粭搴♀攽?闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閻愵剙鍔ょ紓宥咃躬瀵鎮㈤崗灏栨嫽闁诲酣娼ф竟濠偽ｉ鍓х＜闁绘劦鍓欓崝銈囩磽瀹ュ拑韬€殿喖顭烽幃銏ゅ礂鐏忔牗瀚介梺璇叉捣閺佹悂鈥﹂崼鐔剁箚濞寸姴顑嗛埛鎴︽煕濠靛棗顏柛锝堟缁辨帞鎷犻懠顒€鈪甸悗娈垮枛椤嘲顕ｉ幘顔藉亜濡炲娴烽悰顔界節閻㈤潧浠﹂柛銊ョ埣閺佸啴鍩℃导杈ㄦそ椤㈡﹢鎮╅悽纰夌闯濠电偠鎻徊浠嬪箹椤愶絿澧￠梻鍌欒兌椤牏鈧稈鏅滅换娑欑節閸パ勬К闂佺粯鍔曢幖顐ょ不閿濆鐓ラ柡鍐ㄦ处椤ュ霉濠婂啰绉烘慨濠冩そ瀹曘劍绻濋崟顒€娅戞俊鐐€х€靛矂宕圭捄铏规殾闁瑰瓨绻嶉崥瀣熆鐠轰警鍎岄柟閿嬫そ濮婄粯绗熼崶褌绨介梺绋款儐閻╊垶骞婇悢纰辨晬婵炴垶鐟﹂悵宄邦渻閵堝棙纾甸柛瀣崌閺岋紕浠﹂崜褉濮囩紓浣虹帛缁诲牆鐣烽幒鎴叆闁逞屽墴閹艰鎯旈妸锔规嫼婵炴潙鍚嬮悷褏绮旈鈧弻锟犲焵椤掍焦缍囬柍鍝勫暟婢跺嫰姊烘导娆戝埌闁活剙銈搁幆灞解枎閹惧鍘卞銈庡幗閸ㄧ敻寮稿☉姘辩＜濞撴艾娲ゅ▍宥嗘叏婵犲嫮甯涢柟宄版嚇閹煎綊鎮烽幍顕呭仹濠电姷顣藉Σ鍛村磻閸屾粎鐭嗗〒姘ｅ亾濠碘剝鎸抽獮鎺懳旈埀顒勫箲閼哥偣浜滈柟鎹愭硾鍟搁梺鎸庣⊕缁诲牆顫忓ú顏呭仭闁哄绨遍幐鍐磽娓氬洤娅橀柛銊ョ埣瀹曞搫鈽夐姀鐘殿唺闂佸湱鍋ㄩ崝宀€绱炴繝鍥ф瀬闁圭増婢橀柋鍥煟閺囨碍顦烽柛婵囶殜濮婂搫效閸パ呭姶闂佹悶鍔忔禍顒傚垝濞嗘挸绠虫俊銈傚亾缂佺姷鍋ら弻鏇熺節韫囨搩娲紓浣叉閸嬫捇姊绘担渚劸閻炴凹鍋婂畷鎰旈崨顓⌒曢柣搴秵閸犳鍩涢幋锔界厽闁归偊鍨遍ˉ澶愭煕閺冨倹鏆╃紒杈ㄥ浮閹晠鎼归銏㈩暡闂備椒绱紞渚€寮ㄦ潏鈺冪处闁伙絽鐬奸惌娆撴偣閸ワ箑瀚庨柛鏃€鍨垮濠氬Ω閳轰礁宓嗗┑掳鍊愰崑鎾趁瑰鍫㈢暫婵﹥妞介弻鍛存倷閼艰泛顏繝鈷€灞芥珝闁哄矉缍佸鍊燁槹闁稿鍨婚埀顒侇問閸犳盯顢氳閸┿儲寰勯幇顒夋綂闂佺粯蓱閻楁捇宕濆澶娢﹂柛鏇ㄥ灠缁秹鏌涚仦鎹愬濞寸姵锚椤啴濡舵惔鈥茶埅婵炲瓨绮犳禍婊堬綖韫囨拋娲敂閸曨収鍞撮梻浣稿悑娴滀粙宕曢弻銉ユ辈闁绘绮悡鐔兼煏韫囧﹥娅呴柣蹇氬皺缁辨帞绱掑Ο鑲╃暤濡炪倖娲╃徊鍧楀箯閻樿鍦偓锝庡亽濞兼棃姊绘笟鈧褏鎹㈤幒鎾村弿闁割偁鍎辨儫闂佹寧妫佸銊ц姳婵犳碍鈷戦柛婵嗗琚梺鍛婃煥闁帮綁骞嗙仦鍓х瘈闁搞儯鍔庨崢閬嶆⒑鐎圭姵銆冮柣鎺炵畱閿曘垽骞嶉鍓э紲缂傚倷鐒﹂…鍥Υ閹烘鐓冪憸婊堝礈濮樿京鐭欓柟鐑樸仜閳ь剨绠撳畷鍫曨敆娴ｇ澹掗梻浣告贡閸庛倕顫忛懡銈咁棜濠靛倸鎲￠悡鐔镐繆椤栨繃顏犻柨娑樼Т椤儻顦撮柡浣规倐閸┾偓妞ゆ帊绶￠崯蹇涙煕閻樺磭澧甸柍銉畵閹粓鎸婃径瀣偓顒勬⒑瑜版帒浜伴柛妯垮亹濞嗐垽鎮欓悜妯衡偓鐢告煥濠靛棛鍑圭紒銊╊棑缁辨帡濡搁妷顔惧悑濠殿喖锕︾划顖炲箯閸涙潙宸濆┑鐘插€瑰▓妯肩磽閸屾瑧顦︽い鎴濇瀹曞綊宕稿Δ鈧弸渚€鏌涢幇闈涙灍闁哄懏绻堥弻娑氫沪閸撗€濮囧┑鐐叉噺閻楁洟鍩為幋锔藉€烽柡澶嬪灩娴犵鈹戦瑙掓粓宕濇惔銏㈢彾闁哄洢鍨虹€电姴顭跨憴鍕畵缂傚秴锕顐﹀箛閺夊灝鑰垮┑掳鍊曢崯浼村Χ瀹勬壋鏀介柣鎰皺閹界姷绱掗濂稿弰鐎规洘鍨块獮姗€鎳滈棃娑樼哎婵犵數鍋為崹鍫曟偡閿斿墽绀婇柛銉墯閻撴洟鏌熼悙顒夋當闁瑰弶绋戦…銊╁礃閿濆棙鏉搁梻浣虹帛閸旀瑥顭囪閺侇噣鎳滈悙閫涚盎濡炪倖鎸炬慨鎾储鐎涙﹩娈介柣鎰嚋闊剚顨ラ悙鎼劷闁归濞€閹崇娀顢楁径濠冩毆闂傚倷绀佸﹢閬嶅储瑜旈幃娲Ω瑜忛惌娆撴煙闁箑鏋﹀┑顔煎暱閳规垿鎮╁畷鍥舵殹濡炪們鍎遍敃銉╁Φ閸曨垰绠涢柍杞拌兌娴犵偓绻濋姀锝嗙【閻庢矮鍗冲濠氭偄閻撳簼绱堕梺闈涱槶閸庣増绔熼弴銏♀拺闁告繂瀚崳褰掓煟閺嶎偄甯舵い鏇秮楠炴﹢顢欑喊杈ㄧ秱闂備胶鍋ㄩ崕鏌ュ几婵傜纾婚柟鎹愵嚙閸ㄥ倹銇勯幇鍓佸埌鐎殿喖鐏濋埞鎴︻敊缁涘鐣跺┑鈽嗗亝椤ㄥ棝寮查崜浣虹＜婵☆垰婀辩粻姘舵⒑閸涘﹦鎳冩い锔垮嵆婵￠潧鈹戠€ｎ偆鍘搁柣蹇曞仧閺咁偄鏆╂俊鐐紘閸屾粎鐛㈤梺鍝勬湰閻╊垶鐛Ο灏栧亾闂堟稒鍟為柛锝庡枤缁辨挻绗熼崶褎鐏曞銈嗘肠閸ヨ埖鏅ｉ梺绋跨箳閸樠呮閻愭祴鏀介柣妯诲絻椤忕數绱掓潏鈺傛毈婵﹤顭峰畷鎺戔枎閹达絿鐛ラ梻浣告啞閹稿鎮疯閸掓帡寮崒妤€浜鹃梻鍫熺⊕閹茬鈽夐幘宕囆ч柡宀嬬到铻ｆ繛鍡樺劤濞堫厾绱撴担鍝勑㈢紓宥咃躬瀵鎮㈤崫鍕€抽梺鍛婎殘閸嬫稓绮绘繝姘拺闁告稑顭€閹寸姴鍨濋幖杈剧稻椤洟鏌熼悙顒€澧柛姘儔閺屾盯鍩勯崘顏呭櫑闂佸啿鍢查惌鍌氼潖濞差亜浼犻柛鏇ㄥ墯閹峰崬鈹戦悙璺虹毢闁哥姴閰ｉ幃楣冩倻閼恒儱浜楅柟鐓庣摠钃遍柡鍌楀亾闂傚倷绀佺紞濠囧磻婵犲洤鍌ㄦ繝濠傛－濡嫬鈹?.env 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閻愵剙鍔ょ紓宥咃躬瀵鏁愭径濠勵吅闂佹寧绻傞幉娑㈠箻缂佹鍘辨繝鐢靛Т閸婂綊宕戦妷鈺傜厸閻忕偠顕ф慨鍌溾偓娈垮枟濞兼瑨鐏冮梺閫炲苯澧紒鍌氱Ч楠炲棜顧佹繛鎾愁煼閺屾洟宕煎┑瀣碘偓妤侇殽閻愬澧甸柡宀嬬秬缁犳盯寮崒婊呮毎闂備浇顕х换鎴犳暜閳ユ剚娼栨繛宸簻缁€鍌炴煠濞村鏉洪柛瀣仱濮婃椽宕崟顒€娅ょ紓浣筋嚙閻楁捇鐛崘顔芥櫖闁告洏鍔屾禍楣冩煥濠靛棝顎楅柡瀣枛閺屽秹鏌ㄧ€ｎ亞浼岄梺鍝勬湰閻╊垶鐛鈧鍫曞箣閻樼偣鍋℃繝鐢靛仜閻°劎鍒掑鍥ㄥ床闁告劦浜濆畷鍙夌箾閹存瑥鐏╅柣顓燁殔椤潡鎳滈悽娈跨伇闂侀€炲苯澧叉繛澶嬫礋閸┾偓?MIVO_API_KEY');
}

function requireOpenAiKey() {
  if (!config.openaiApiKey) throw new Error('GPT image 2.0 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閻愵剙鍔ょ紓宥咃躬瀵鎮㈤崗灏栨嫽闁诲酣娼ф竟濠偽ｉ鍓х＜闁绘劦鍓欓崝銈嗙節閳ь剚娼忛埡鍌ゆ綗闂佸湱鍎ら弻锟犲磻閹剧粯鏅查幖绮光偓鎻掝棜缂傚倷鐒︽晶搴ㄥ疾濠婂懏宕叉繛鎴烇供閸熷懏銇勯弮鍥у惞闁告垵缍婂铏圭矙濞嗘儳鍓遍梺鍛婃⒐閻熲晠鐛崘顓滀汗闁圭儤鍨归崐鐐差渻閵堝懐绠伴悗姘煎枛琚欓柕蹇嬪€栭埛鎴︽煙缁嬫寧鎹ｉ柍顖涙礋閺岋綁鍩℃繝鍌滀哗濡炪値鍋勭换鎰弲濡炪倕绻愰幊搴㈢椤撱垺鈷戦柛婵嗗濡插摜绱掗妸鈺€鎲炬鐐村姍瀹曟﹢顢旈崱娆欑闯濠电偞鎸婚懝鎯洪妶鍛瀺婵せ鍋撻柡灞剧洴婵℃悂濡搁敂淇扁偓鎰版⒑娴兼瑧鎮奸柛蹇旓耿閻涱喚鈧綆鍠楅弲婊堟煠閹帒鍔滄い蹇曞枛濮婄粯鎷呴搹鐟扮闂佹寧姘ㄩ惀顏嗙磼閵忕姴绫嶉悗瑙勬磸閸ㄤ粙鐛弽銊﹀闁稿繐顦扮€氬ジ姊绘担渚敯闁稿鍔欏畷鎴濃槈閵忕姷顦┑顔姐仜閸嬫捇鏌＄仦鍓ф创鐎殿噮鍓涢幑鍕Ω閹板苯娲﹂悡娆愩亜閺嶃劏澹橀柡鍡稻椤ㄣ儵鎮欏顔煎壎闂佽鍠楅悷鈺呫€侀弮鍫濈妞ゅ繐妫欓弲銊╂⒒閸屾艾鈧兘鎮為敂閿亾缁楁稑娲ら拑鐔兼煏婵炵偓娅呴崶瀵哥磽娴ｅ壊鍎愭い鎴炵懇閹鎳滈悙閫涚盎闂佸搫鍊搁悘婵嬪煕閺冨倻妫柟瑙勫姇娴滃湱绱掓潏銊﹀鞍闁瑰嘲鎳愰幏鐘绘晬閸曨偄楔缂傚倸鍊烽懗鑸垫叏閻戣棄纾婚柕鍫濐槸閽冪喐绻涢幋娆忕仼闁绘挻锕㈤弻鐔碱敍閸℃鈧悂藟濮橆厾绡€缁炬澘顦辩壕鍧楁煕鐎ｎ偄鐏寸€规洘鍔欏浠嬵敃閿濆棙顔囬梻浣告贡閸庛倝寮婚敓鐘茬；闁圭偓鍓氬鈺呮煕濡ゅ啫浠滄鐐差儔閹鈻撻崹顔界彯闂佺顑呴敃銈夋偩閻戣棄绠虫俊銈勭閳ь剛鍏橀幃妤呮偨濞堣法鍔稿Δ鐘靛仜閻楀﹥绌辨繝鍥ㄥ€锋い蹇撳閸嬫捇寮介鐐殿槷閻熸粌绻愰銉︾節閸曨剙纾梺闈浤涢崒婊呮喒闂傚倷鑳堕幊鎾存櫠閻ｅ苯鍨濇い鏍仦閸嬪倿鏌ｉ弬鎸庢喐缂佲檧鍋撻梻鍌氬€搁悧濠勭矙閹烘梻鐭堟い鎰堕檮閻撶娀鏌℃径瀣嚋闁稿鍎甸弻鈥崇暆閳ь剟宕伴弽顓溾偓浣糕枎閹寸娀鈹忛柣搴秵閸嬪棝寮惰ぐ鎺撯拻濞达綀娅ｇ敮娑樸€掑顓ф疁鐎规洘濞婇弫鎰板川椤栨稒顔曢柣鐔哥矌婢ф鏁埡鍛瀬濠电姴娲﹂悡鐔兼煙閹冩毐闁伙负鍔嶇换娑㈠礂閼测晜鍒涘┑顔硷工椤嘲鐣烽幒鎴旀瀻闁圭儤鍨电敮顖炴⒒娴ｄ警鏀版繛鍛礋楠炴垿宕惰閺嗭附銇勯弽顐粶闂佽￥鍊栨穱濠囧Χ閸曨喖鍘￠梺鍛娚戦崝娆忣潖濞差亜绠伴幖杈剧悼閻ｉ潧顪冮妶蹇曠窗闁告鍟块锝夊蓟閵夈儴鎽曢梺闈涱檧婵″洭宕㈡禒瀣拺鐟滅増甯掓禍浼存煕閹炬潙鍝烘鐐叉瀹曞ジ濡烽妷褍鈧偤鏌ｆ惔銏⑩姇妞ゎ厼娲ㄥ褔鍩€椤掑嫭鈷戦梻鍫熺洴閻涙粎绱掗幓鎺戔挃婵炴垹鏁婚幃娆擃敄閸欍儳鐩庨梻浣烘嚀閻°劎鎹㈤崘顔肩獥婵☆垰鐨烽崑?.env 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閻愵剙鍔ょ紓宥咃躬瀵鏁愭径濠勵吅闂佹寧绻傞幉娑㈠箻缂佹鍘辨繝鐢靛Т閸婂綊宕戦妷鈺傜厸閻忕偠顕ф慨鍌溾偓娈垮枟濞兼瑨鐏冮梺閫炲苯澧紒鍌氱Ч楠炲棜顧佹繛鎾愁煼閺屾洟宕煎┑瀣碘偓妤侇殽閻愬澧甸柡宀嬬秬缁犳盯寮崒婊呮毎闂備浇顕х换鎴犳暜閳ユ剚娼栨繛宸簻缁€鍌炴煠濞村鏉洪柛瀣仱濮婃椽宕崟顒€娅ょ紓浣筋嚙閻楁捇鐛崘顔芥櫖闁告洏鍔屾禍楣冩煥濠靛棝顎楅柡瀣枛閺屽秹鏌ㄧ€ｎ亞浼岄梺鍝勬湰閻╊垶鐛鈧鍫曞箣閻樼偣鍋℃繝鐢靛仜閻°劎鍒掑鍥ㄥ床闁告劦浜濆畷鍙夌箾閹存瑥鐏╅柣顓燁殔椤潡鎳滈悽娈跨伇闂侀€炲苯澧叉繛澶嬫礋閸┾偓?OPENAI_API_KEY 闂?LLM_API_KEY');
}

function requireLlmKey() {
  if (!config.llmApiKey) throw new Error('闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳婀遍埀顒傛嚀鐎氼參宕崇壕瀣ㄤ汗闁圭儤鍨归崐鐐烘偡濠婂啰绠荤€殿喗濞婇弫鍐磼濞戞艾骞楅梻渚€娼х换鍫ュ春閸曨垱鍊块柛鎾楀懐锛滈梺褰掑亰閸欏骸鈻撳鍫熺厸鐎光偓閳ь剟宕伴弽顓犲祦鐎广儱顦介弫濠勭棯閹峰矂鍝烘慨锝咁樀濮婄粯鎷呮笟顖滃姼濡炪倖鍨堕崹褰掑箲閵忕姭鏀介悗锝庝海閹芥洟姊洪崫鍕窛闁哥姴娴峰▎銏ゆ倷閻戞鍘卞銈嗗姧缁茶法绮婚幘鎰佺唵閻熸瑥瀚悡銉╂煃鐟欏嫬鐏撮柟顔界懇瀵爼骞嬮悩杈敇闂備浇澹堥敓銉╁磹濠靛钃熼柨鐔哄Т閻掑灚銇勯幒宥堝厡妞も晝鍏橀幃妤呮晲鎼粹€茬盎闂侀€炲苯澧伴柡浣割煼瀵濡搁妷銏℃杸闂佺硶鍓濋〃鍡椻枔椤撶喓绡€缁炬澘顦辩壕鍧楁煕韫囨棑鑰跨€?闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；闁绘劗鍎ら崑瀣煟濡崵婀介柍褜鍏涚欢姘嚕閹绢喖顫呴柍鈺佸暞閻濇牠姊绘笟鈧埀顒傚仜閼活垱鏅堕弶娆剧唵閻熸瑥瀚粈瀣偓瑙勬礈閸忔﹢銆佸鈧幃鈺冨枈婢跺苯绨ラ梻鍌欐祰椤曆囧礄閻ｅ瞼绀婇柛鈩冪☉绾惧鏌熼幑鎰厫妞ゎ偅娲熼弻宥夊传閸曨偀鍋撻懡銈囦笉闁告挆鈧崑鎾绘偡閺夋妫岄梺鍝ュУ濞叉粓鎳炴潏銊ч檮闁告稑锕﹂崢鎼佹⒑閸涘﹣绶遍柛鐘虫皑缁鎮欓悜妯煎幐闁诲繒鍋熼弲顐㈡毄婵＄偑浼囬崒婊呯崲闂佸搫鏈惄顖炵嵁濡吋宕夐柣鎴烆焽娴滎亪鏌ｆ惔銏╁晱闁革綆鍣ｅ畷鎴炵節閸屾粍娈惧┑顔姐仜閸嬫挻銇勯姀锛勬噮闁哥姴锕ュ蹇涘Ω瑜忚ⅸ闂傚倸鍊搁崐鐑芥嚄閸洖纾婚柕濞炬櫅绾惧潡鏌＄仦璇插姎缂佲偓閸喐鍙忔俊顖涘绾箖鏌涘顒傜Ш闁哄本娲熷畷鐓庘攽閹邦厜褔姊虹紒妯诲暗闁哥姵鐗犻悰顕€寮介‖銉ラ叄椤㈡鍩€椤掑嫭鍊舵い鏇楀亾闁哄苯绉归、娑樷槈濞嗘埈妲归梻浣告惈鐞氼偊宕濆畝鍕剁稏婵犻潧顑愰弫鍕煟閹邦垰鐨虹紒澶嬫そ閺岀喖顢欑憴鍕彋闂佸湱鍘х紞濠囥€侀弴銏″亹閺夊牜鍋呴妤佺節閻㈤潧校妞ゆ梹鐗犲畷浼村冀椤撶喐娅囬梺闈涱焾閸庮噣寮稿澶嬬叆婵犻潧妫欐径鍕亜椤愶絾绀嬮柡宀€鍠栭幃婊兾熼悜姗嗗晭闂備胶绮弻銊╁触鐎ｎ喖纾瑰┑鐘崇閻撳啴鏌涘┑鍡楊仼闁逞屽墯閹倿銆侀弮鍫濅紶闁告洏鍔嶉弬鈧梻浣瑰缁嬫垹鈧凹鍓氱粋宥嗙附閸涘﹦鍘辨繝鐢靛仜閻忔繈鍩€椤掍胶绠撻柣锝囧厴婵偓闁挎稑瀚板顕€姊洪崨濠勨槈闁挎洏鍊栫粋宥夋焼瀹ュ棌鎷洪柣鐔哥懃鐎氼剛绮堥崘鈹夸簻闁哄洤妫楅幊鎰▔瀹ュ鐓涚€广儱鍟俊浠嬫煕濞嗗繒绠插ǎ鍥э躬閹瑦锛愬┑鍡橆唲濠电偛鐡ㄧ划鎾剁不閺嶎厼绠栨俊銈呭暞閸犲棝鏌涢弴銊ュ妞わ负鍎靛铏圭磼濡厧鈪归梺闈涚墛閹倹淇婄€涙ɑ濯撮柤鍙夌箖濮婂綊骞忛崨瀛樺仭闂侇叏鑵归崑鎾诲箻缂佹ǚ鎷洪梺鍛婄☉閿曪箓骞婇崘鈹夸簻闁挎棁顕ч悘锔姐亜閵忊剝鐓ラ悡銈嗐亜韫囨挻鍣抽柟宄邦煼濮婅櫣绮欓幐搴㈡嫳闂佽崵鍟欓崶褏顦悗骞垮劚椤︿即鎮″▎鎰╀簻闁哄啫娲ゆ禍褰掓煕閳哄鎮奸柍褜鍓濋～澶娒哄Ο濂芥椽鎮㈤悡搴ｇ枃闂佽法鍠撴慨鏉戞纯闂備礁鎲℃笟妤呭垂閹惰姤鍋ゆ慨妞诲亾婵﹦绮幏鍛矙閹稿骸鈧垱绻涚€涙鐭嗙紒顔界懃閻ｇ兘寮撮姀鐘殿唴婵犳鍠楅崝蹇涘磻閹捐宸濋柡澶嬪灩椤斿矂姊洪悷鎵暛闁告柨绉磋灋闁告劦鍠栭弸渚€鏌熼悧鍫熺凡鐎瑰憡绻冮妵鍕箻鐠虹儤鐎惧銈嗘煥椤﹂潧顫忕紒妯诲闁惧繒鎳撶粭锟犳⒑鐟欏嫭鍊愮紒鐘崇墪閻ｉ攱瀵奸弶鎴濆敤濡炪倖鎸鹃崑鐘诲箺閺囥垺鈷戦柟绋挎捣缁犳挻銇勯敂璇茬仩閾荤偞鎱ㄥ璇蹭壕闂佸搫鐬奸崰鎾跺垝濞嗘挸閿ゆ俊銈吪堥崑鎾澄旈崨顔惧幐闂佺硶鍓濋〃鍫熸櫠閵忋垻纾奸弶鍫涘妼濞搭噣鏌熼鐣屾噰妞ゃ垺顨婇崺鈧い鎺戝€婚惌鍡涙煕閹板吀绨撮柛瀣尵閹叉挳宕熼鍌ゆФ闂備浇妗ㄩ懗鍫曗€﹂崼婵嗙カ闂備礁婀辨晶妤€顭垮Ο鑲╀笉闁惧浚鍋傜换鍡涙煏閸繂鈧憡绂嶆ィ鍐┾拺缂備焦锚缁楁帡鏌ｈ箛鏂垮摵濠碉紕鏁诲畷鐔碱敍濮橀硸鍞洪柣搴＄畭閸庡崬煤閵堝棔绻嗛柤鎭掑劤缁♀偓濠电偛鐗嗛悘婵嬫倶閿熺姵鐓欑紒瀣仢閺嗚鲸銇勯銏㈢缂佺粯绻傞～婵嬵敆閸曨偅鏆┑鐘愁問閸犳鏁冮埡鍛偍濞寸姴顑嗛崑鐔镐繆閵堝懏鍣洪柍閿嬪灴濮婃椽顢曢妶鍛捕闂佸吋妞块崹閬嶅疾閸洦鏁嶉柣鎰綑閳ь剛鏁哥槐鎺懳旀担琛℃濠电偛鐪伴崐鏍€佹繝鍥ㄢ拻濞达絽鎲￠崯鐐寸箾鐠囇呯暤鐎规洘婢橀～婵嬫嚋闂堟稐鐥梻渚€鈧偛鑻晶瀛樻叏婵犲懏顏犻柟鍙夋尦瀹曠喖顢曢妶搴⑿炲┑鐘垫暩閸嬫盯藝娴煎瓨鍎庢い鏍仜杩濋梺绋挎湰椤曘垹煤椤忓秵鏅滈梺鍛婁緱閸ㄤ即鐛Δ鍛拺闁荤喐婢橀幃鎴︽煟閿濆簼閭€规洖缍婂畷妤呮嚃閳哄啫楠勬繝纰樻閸ㄩ亶鎯囩憴鍕洸婵犲﹤鐗婇悡銉╂煛閸モ晛浠滈柍褜鍓涢崗姗€鐛径瀣ㄥ亝闁告劏鏅濋崢閬嶆⒑鐎圭媭娼愰柛搴ゆ珪缁傚秹鎮欓璺ㄧ畾闂佺粯鍔︽禍婊堝焵椤掍胶澧い鏂跨箲缁绘繂顫濋鍌︾幢闂備浇顫夐崕铏櫠鎼达絽顥氬┑鍌氭啞閻撶喐淇婇姘变虎闁汇劍妞藉顐﹀醇閵夛箑鈧敻鎮峰▎蹇擃仾缂佲偓閸愨晝绠鹃柤纰卞墮閺嬫稓鈧鍠栭…宄扮暦閸楃倣鏃€绻濋崒娑樷偓顖炴⒒娴ｅ憡鍟炲〒姘殜瀹曞綊骞庨挊澶婂殤闂佸憡鍔﹂崰妤呭煕閹达附鐓熼柣鏂挎啞缁舵煡鏌熼钘夌伌闁哄瞼鍠栭、娑橆潩鏉堚晛濮遍梻浣筋嚃閸犳帡宕滃┑鍡╁殫闁告洦鍋嗛弳鍡涙煃瑜滈崜娑氬垝閸喓绡€闁搞儯鍔庨崢鎼佹倵楠炲灝鍔氬Δ鐘虫倐閻涱喖螖閸涱喚鍘介梺瑙勫劤绾绢厾绮绘繝姘厸閻忕偛澧藉ú瀛樸亜閵忊剝绀嬮柡浣瑰姍瀹曞爼鍩℃繝鍌涘€繝鐢靛Х椤ｄ粙宕滃┑濞夸汗闁告劦浜炵粈濠傗攽閻樺弶鎼愰柦?.env 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閻愵剙鍔ょ紓宥咃躬瀵鏁愭径濠勵吅闂佹寧绻傞幉娑㈠箻缂佹鍘辨繝鐢靛Т閸婂綊宕戦妷鈺傜厸閻忕偠顕ф慨鍌溾偓娈垮枟濞兼瑨鐏冮梺閫炲苯澧紒鍌氱Ч楠炲棜顧佹繛鎾愁煼閺屾洟宕煎┑瀣碘偓妤侇殽閻愬澧甸柡宀嬬秬缁犳盯寮崒婊呮毎闂備浇顕х换鎴犳暜閳ユ剚娼栨繛宸簻缁€鍌炴煠濞村鏉洪柛瀣仱濮婃椽宕崟顒€娅ょ紓浣筋嚙閻楁捇鐛崘顔芥櫖闁告洏鍔屾禍楣冩煥濠靛棝顎楅柡瀣枛閺屽秹鏌ㄧ€ｎ亞浼岄梺鍝勬湰閻╊垶鐛鈧鍫曞箣閻樼偣鍋℃繝鐢靛仜閻°劎鍒掑鍥ㄥ床闁告劦浜濆畷鍙夌箾閹存瑥鐏╅柣顓燁殔椤潡鎳滈悽娈跨伇闂侀€炲苯澧叉繛澶嬫礋閸┾偓?LLM_API_KEY');
}

function errorMessageFrom(error) {
  const payload = error?.response?.data;
  if (payload?.error?.code === 'invalid_api_key') return 'OpenAI API key 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；闁绘劗鍎ら崑瀣煟濡崵婀介柍褜鍏涚欢姘嚕閹绢喖顫呴柍鈺佸暞閻濇牠姊绘笟鈧埀顒傚仜閼活垱鏅堕幘顔界厵妞ゆ柨鍚嬮崑銉︺亜閵忊€冲摵闁糕斁鍋撳銈嗗笒鐎氼剟鎷戦悢鍏肩叆婵犻潧妫欓崯鎺楁煛閸愩劎澧曢柣鎺戠仛閵囧嫰骞掗幋婵愪痪闂佺顑呴鍛村煘閹达附鍋愰柛娆忣槹閹瑩姊哄ú璇插箺妞ゃ劌锕幃锟狀敃閿曗偓閻愬﹪鏌曟繛褉鍋撳┑顔兼喘濮婅櫣绱掑Ο璇叉殫闂佸摜濮甸悧鐘差嚕婵犳艾鍗抽柨娑樺閺夋悂鏌ｆ惔顖滅У濞存粎鍋ゅ畷婵嬪箻椤旇В鎷虹紓鍌欑劍閿氭繛鎼枤缁辨帡鎮╁畷鍥р拰閻庢鍠栭…鐑藉极閹邦厼绶炲┑鐐╂媰閸愬墽鍞甸柣鐘荤細濞咃綁鎮橀柆宥嗙厸闁糕檧鏅涙禍鐗堟叏婵犲啯銇濈€规洦鍋婂畷鐔碱敆娴ｇ懓顏板┑鐘垫暩閸嬫稑顕ｉ崼鏇熸櫔婵＄偑鍊栧ú蹇涘磿闂堟稓鏆﹂柣鏃傗拡閺佸秵鎱ㄥ鍡楀⒉闁逞屽墮閻忔繈鍩為幋锕€鐓￠柛鈩冾殘娴犳挳鎮楃憴鍕；缂佹彃顭锋俊鐢稿箛閺夊灝鑰垮┑鐐村灦閻熴垽骞忕紒妯肩閺夊牆澧介崚浼存煙鐠囇呯瘈妤犵偛妫濆畷濂稿Ψ閿旀儳骞嶉柣搴ｆ嚀鐎氫即宕戞繝鍥х？闁哄啫鍊甸崑鎾舵喆閸曨剛顦ㄧ紓渚囧枛閻倿宕洪妷锕€绶為柟閭﹀墻濞煎﹪姊虹紒姗堣€挎繛浣冲嫭鍙忛柨鏃€鍨濈换鍡涙煟閹板吀绨婚柍褜鍓氶悧鏇㈩敊韫囨梻绡€婵﹩鍓涢敍娑㈡⒑閻熸澘鈷旂紒顕呭灦閹繝寮撮悢鍓佺畾濡炪倖鐗楃换鍌炲触瑜版帗鐓熸い鎾跺枎缁椦囨煃瑜滈崜婵嬶綖婢跺⊕鍝勵潨閳ь剙鐣疯ぐ鎺戦敜婵°倕鍟粊锕€鈹戦埥鍡楃仴闁稿鍔楁竟鏇㈠礂闂傚绠氬銈嗙墬缁瞼鏁懜娈挎闁绘劘灏欐晶锔芥叏婵犲嫮甯涢柟宄版嚇瀹曨偊濡烽‖顔哄姂濮婅櫣绮欏▎鎯у壈闂佹寧娲︽禍婊堟偩閻戣棄顫呴柨娑樺濡绢喚绱撴担鍓插創婵炲娲熻棟妞ゆ洍鍋撴慨濠冩そ濡啫鈽夊顒夋毇婵犵妲呴崑鍛矙閹捐泛鍨濈紓浣骨滈崑鍛存煕閹般劍娅囬柛妯哄船椤啴濡堕崱妤€顫囬梺绋匡攻濞茬喎顕ｉ崨濠冨劅闁挎繂娲ㄩ敍婊堟⒑閸︻厾甯涢悽顖楁櫊閹剝绺介崨濠勫幐闁诲繒鍋熼弲顐ュ€撮梻浣烘嚀瀵爼骞愰崘鑼殾闁绘梻鈷堥弫鍐煏閸繂顏紒鈧径鎰拻闁稿本鐟ㄩ崗宀€鐥鐐靛煟鐎殿噮鍓熷畷鎺楁倷閼碱剨绱甸梻鍌氬€搁悧濠勭矙閹捐姹查柨鏇炲€归悡鏇熶繆閵堝懎鏆欓柛鎾归哺缁绘盯骞橀幇浣哄悑闂佸搫鏈惄顖炵嵁濡綍鏃堝焵椤掑嫬绠犻幖娣妽閸嬪倿鏌涢幇闈涙灍闁抽攱甯￠弻娑氫沪閹规劕顥濋梺閫炲苯澧伴柛蹇旓耿楠炲﹤螖閸涱參鍞堕梺鍝勬处閵囨盯宕戦幘缁樻櫇闁稿本宀搁崬鍫曟⒑闂堟侗妯堥柛鐘愁殜瀵煡鎮欓悜妯锋嫼缂備緡鍨卞ú鏍ㄦ櫠閼碱剛纾奸悗锝庡亜閻忊晝绱掗纰辩吋鐎殿喖顭锋俊鐑芥晜閹冪疄闂傚倷绶氬褔藝娴犲绐楅柡宥冨妽濞呯姵銇勯弴妤€浜鹃梺?OPENAI_API_KEY / LLM_API_KEY';
  if (payload?.detail === 'API Key invalid') return 'MIVO_API_KEY is invalid';
  if (payload?.error?.message) return payload.error.message;
  if (payload?.detail) return payload.detail;
  if (payload?.message) return payload.message;
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  return stringifyUnknownError(parsedPayload, stringifyUnknownError(error, '请求失败'));
}

function parseEmbeddedJson(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) candidates.push(trimmed.slice(firstBrace));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // ignore and continue
    }
  }

  return null;
}

function isClaudeModel(model) {
  return String(model || '').trim().toLowerCase().startsWith('claude');
}

function isGpt5Model(model) {
  // 同时认 codex/ 前缀：网关里 Sol 只有 codex/gpt-5.6-sol 这一条路由。只按
  // startsWith('gpt-5') 判会把它当成非推理模型 —— 结果是给它发 temperature、
  // 不发 reasoning_effort，「高性能 / 深度思考」这一档对它静默失效。
  const normalized = String(model || '').trim().toLowerCase().replace(/^codex\//, '');
  return normalized.startsWith('gpt-5');
}

function applyLlmPerformanceOptions(payload, model, options = {}, defaultTemperature = 0.7) {
  if (isClaudeModel(model)) return payload;
  const performanceMode = options.performanceMode || 'highest';
  const reasoningEffort = options.reasoningEffort || (performanceMode === 'highest' ? 'high' : undefined);
  payload.max_tokens = performanceMode === 'highest' ? 8192 : 4096;
  if (!isGpt5Model(model)) payload.temperature = defaultTemperature;
  if (isGpt5Model(model) && reasoningEffort) payload.reasoning_effort = reasoningEffort;
  return payload;
}

function shouldRetryWithoutReasoningEffort(error) {
  if (error?.response?.status !== 400) return false;
  const raw = [
    typeof error?.response?.data === 'string' ? error.response.data : '',
    error?.response?.data?.error?.message,
    error?.response?.data?.message,
    error?.message
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return raw.includes('reasoning_effort') || raw.includes('unknown parameter') || raw.includes('unrecognized') || raw.includes('unsupported');
}

async function postLlmChatCompletions(payload, requestOptions = {}) {
  const axiosOptions = {
    headers: { Authorization: `Bearer ${currentLlmKey()}`, 'Content-Type': 'application/json' },
    timeout: 300_000,
    ...requestOptions
  };
  try {
    return await axios.post(`${llmBaseUrl}/v1/chat/completions`, payload, axiosOptions);
  } catch (error) {
    if (!payload.reasoning_effort || !shouldRetryWithoutReasoningEffort(error)) throw error;
    const fallbackPayload = { ...payload };
    delete fallbackPayload.reasoning_effort;
    return axios.post(`${llmBaseUrl}/v1/chat/completions`, fallbackPayload, axiosOptions);
  }
}

function llmErrorMessageFrom(error, model) {
  const payload = error?.response?.data;
  const parsedPayload =
    (payload && typeof payload === 'object' ? payload : null) ||
    parseEmbeddedJson(typeof payload === 'string' ? payload : '') ||
    parseEmbeddedJson(error?.message || '');
  const rawMessage = [
    typeof payload === 'string' ? payload : '',
    typeof parsedPayload?.detail === 'string' ? parsedPayload.detail : '',
    typeof parsedPayload?.message === 'string' ? parsedPayload.message : '',
    typeof parsedPayload?.error?.message === 'string' ? parsedPayload.error.message : '',
    error?.message || ''
  ]
    .filter(Boolean)
    .join(' ');

  if (isClaudeModel(model)) {
    if (/temperature.+deprecated/i.test(rawMessage) || /maxtokens:\s*extra inputs are not permitted/i.test(rawMessage)) {
      return 'Claude Opus 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧湱鈧懓瀚崳纾嬨亹閹烘垹鍊為悷婊冪箻瀵娊鏁冮崒娑氬幗闂侀潧绻堥崺鍕倿閸撗呯＜闁归偊鍙庡▓婊堟煛瀹€鈧崰鏍蓟閸ヮ剚鏅濋柍褜鍓熷绋库槈閵忥紕鍘遍梺闈涱煭婵″洨绮婚悙鎼闁绘劕顕晶顏堟嚕閹邦厹浜滈柟鍝勬娴滈箖姊虹拠鍙夌濞存粍绻勯幑銏犫槈閵忕姴绐涘銈嗙墬椤曟挳鏁愰崥鍐查叄瀹曟儼顧傞棅顒夊墮閳规垿鍨惧畷鍥х厽閻庤娲忛崝鎴︺€佸▎鎾崇缁炬澘褰夐崫妤冪磽閸屾艾鈧悂宕愰悜鑺ュ殑闁肩鐏氶崣蹇涙煙閹増顥夌痪顓涘亾闂備浇顫夐崕鐓幬涢崟顖涘珔闁绘柨鎽滅粻楣冩煙鐎电鈧垵顫濋鈺嬬秮瀹曞ジ鎮㈢粙鍨紟婵犲痉鏉库偓鎰板磻閹剧粯鐓熸俊銈傚亾闁挎洦浜滈锝夘敃閿曗偓缁犳氨鎲告径鎰哗濞寸姴顑嗛悡鐔兼煙闁箑澧紒鐙欏洦鐓曢柨婵嗙墛椤ュ鏌嶇憴鍕伌闁诡喗鐟╅崺鈩冩媴瀹勯偊妫滈梻鍌氬€搁崐椋庣矆娓氣偓楠炴牠顢曢敂钘夊壒婵犮垼娉涢懟顖滄閵堝鐓曞┑鐘插閺嬫柨霉濠娾偓缁瑥顫忕紒妯诲缂佸瀵ч崐顖滅磽娴ｉ鍔嶉柟绋垮暱椤曪綁骞撻幒鍡橆潔濠殿喗顭堟禍顒勬偩閸洘鈷戦悹鎭掑妼閺嬫柨鈹戦鐐毈闁糕晜鐩獮瀣偐閻㈢绱冲┑鐐舵彧缁蹭粙锝為弽顓ф晜闁糕剝鐟ч悾鍫曟偡濠婂啰绠虫俊鍙夊姍楠炴帒螖婵犲啯娅旈梻浣告啞娓氭宕㈤悙顒傤浄缂佸顕抽弮鍫熷亹闂傚牊绋愮划鍫曟⒑缂佹﹩娈曢柟鍝ョ帛缁岃鲸绻濋崶褏顔愭繛杈剧秬閸婁粙濡搁埡浣侯啇闁哄鐗嗘晶浠嬪礆娴煎瓨鐓涢悗锝庡亞濞叉挳鏌″畝鈧崰鏍箖閳╁啯鍎熼柨婵嗘肠閵娾晜鈷戦悹鍥ｂ偓宕囦哗闂佺锕ら悘婵嬫偩閻戠瓔鏁冮柨鏇楀亾閸烆垶鎮峰鍕煀閸楅亶鏌涘┑鍕姢缁惧彞绮欓弻娑氫沪閹规劕顥濋梺閫炲苯澧柟顔煎€搁悾鐑藉箛閻楀牆鈧鏌ら幁鎺戝姎婵炲牊鍨垮娲嚃閳哄﹦鍔搁梺璇茬箲瀹€绋跨暦閿濆牏鐤€婵炴垶鐟ч崢浠嬫⒑闂堟稓绠冲┑顔炬暬瀹曨垶鎮欓悜妯煎幈闁诲函缍嗘禍鍫曞磿閺冨牊鐓涚€光偓鐎ｎ剙鍩岄柧浼欑秮閺岋綁骞嬮悙鍐╁哺瀵鈻庨幘绮规嫼闂佺鍋愰崑娑㈠焵椤掍胶澧悡銈夋煟閺冨倸甯堕柦鍐枑缁绘盯骞嬪▎蹇曞姶闂佽桨绀侀崯鎾蓟閵娿儮鏀介柛鈩冿供濡倕顪冮妶蹇氱闁稿酣娼ч～蹇涙惞閸︻厾锛滃┑鈽嗗灥椤曆囨瀹ュ鈷戦柣鎴旀櫆濞呮捇鏌涢妸銊︾【妞ゆ洩绲块幏鐘裁圭€ｎ偒娼旀繝娈垮枟閿曗晠宕戦崨鏉戠闁告劦鍠楅埛鎴︽煕濞戞﹫鏀婚悗鍨懇閺屾稑鈽夐崡鐐典哗闁汇埄鍨辩敮鈥愁潖婵犳艾纾兼繛鍡樺灩閻涖垹鈹戦悙璺侯棈鐎规洟娼ч銉︾節閸愵亞鐦堝┑顔斤供閸撴盯鏁嶉悢鍏尖拻闁稿本姘ㄦ晶娑樸€掑顓ф當妞ゎ厼娲浠嬵敃閵堝浄绱冲┑鐐舵彧缂嶁偓闁稿鍊块獮瀣倷閹绘帞浜栭梺璇查叄濞佳囧箺濠婂懎顥氬┑鍌氭啞閸婄敻鏌ㄥ┑鍡涱€楁鐐搭殘閻ヮ亪顢橀埄鍐€愰柧缁樼墵閺岋絽螣閸濆嫮楠囬悗鐟版啞缁诲嫮妲愰幒鎾寸秶闁靛绠戦棄宥囩磽娴ｈ娈橀柛鐘崇墪閻ｇ兘骞嗛柇锔叫梻浣筋嚙缁绘劙鎮ц箛鏇燁潟闁规儳鐡ㄦ刊鎾煕閹惧啿绾х粭鎴濃攽閻橆偅濯伴柛鎰靛枛瀵即鎮楃憴鍕鐎光偓閹间胶宓侀柟鐑橆殔濡﹢鏌涘┑鍡楊仹濠㈣娲熷娲箰鎼达絿鐣垫俊銈囧У閹倸顕ｇ粙搴撴婵浜敍婊堟⒑缂佹﹩鐒介柛搴涘€濋幃鐢割敂閸曞嫬閰ｅ畷鎯邦檪闂婎剦鍓欓埞鎴﹀灳瀹曞洤鐓熼悗瑙勬礈閸犳牠銆佸鈧幃娆忣啅椤旈敮鍋撻弶鎴旀斀闁绘ê鐏氶弳鈺呮煕鐎ｎ偆娲存鐐诧龚缁犳盯寮撮悙鑼喊闂備礁婀遍崑鎾诲礈濮橆剦鐒介柡宥冨妿缁犲墽鈧懓澹婇崰鏇犺姳閼姐倗纾奸柣妯垮皺缁夋椽鏌″畝瀣М妤犵偛娲、姗€鎮欓悽鐐瑰仭婵犵數濮甸鏍窗閺嶎厽鍎楅柛灞惧嚬濞兼牗绻涘顔荤盎鐎瑰憡绻傞埞鎴︽偐閹绘帗娈堕梺鍛婄懃濡繂顫忛崫鍔借櫣鎷犻幓鎺旑啇闂備胶顭堥敃銈夋倶濠靛鍋╃€瑰嫭鍣村ú顏嶆晜闁告洦鍘兼慨锔戒繆閻愵亜鈧牜鏁繝鍥ㄢ挃鐎广儱妫涢々鍙夌節婵犲倻澧涢柣鎾寸懇閺岋綁骞嬮悘娲讳邯閹﹢濡烽埡鍌滃帗閻熸粍绮撳畷婊冣枎閹惧磭鐤呴梺鎸庣☉鐎氼噣鎯屾径鎰厵闁绘垶蓱鐏忔壆绱撳鍛枠闁哄本娲樼换婵婄疀閺囩姵娈搁柣搴㈩問閸犳鈧瑳鍛床婵犻潧顑嗛崑銊╂⒒閸喎鍨侀柕蹇嬪€栭悡鏇㈡倵閿濆簼绨兼い銉ｅ灲閺岀喖顢氶崱娆戠槇闂佺娅曢悧鐘诲春閻愬搫绠氱憸灞剧珶閺囥垺鐓熼柣鏂挎憸閹冲啴鎮楀鐓庡箻缂侇喖鐗撻崺鈧い鎺戝閳锋垹绱撴担璇＄劷濠⒀屼邯閺屾洟宕奸姀鈺冨姼濡炪倖娲╃紞渚€銆侀弴銏℃櫇闁逞屽墰缁鈽夐姀锛勫幐婵犮垼娉涢敃锔界閵忋垻纾奸柟閭﹀幘閳藉銇勯鍕殻濠碘€崇埣瀹曞崬螖閳ь剙顭囬幋锔解拺缂佸顑欓崕鎰版煙缁嬫鐓煎┑锛勬暬瀹曠喖顢涘В绗哄姂閺屻劑寮村Δ鈧禍楣冩⒑閸涘﹦绠橀柛搴涘€濋獮鍫ュΩ閿斿墽鐦堥梺鍛婃处閸樿偐绮敓鐘斥拺闁荤喐婢樺Σ濠氭煙閾忣偓鑰挎鐐村姈缁绘繈宕橀妸褏鐛┑鐘垫暩婵挳宕锕€绀夐柟鐑橆殕閳锋帡鏌涚仦鍓ф噮妞わ讣绠撻弻鐔兼嚍閵壯呯厑闂侀€涚┒閸旀垿骞冮悾宀€鐭欓悹渚厛濡茬兘姊绘担鍛婃儓婵炲眰鍔嶉幈銊╁级閹搭厼娈ㄩ梺鍝勮閸庢煡鍩涢幒鎳ㄥ綊鏁愰崶褍濡洪梺鎼炲€愰崑鎾绘⒒娴ｅ壊鍚旈柡澶婄仢椤鈹戦悙鍙夘棑闁搞劋绮欓獮鍐锤濡ゅ﹥鏅┑鈽嗗灥椤鎯堣箛娑欌拻濞达絽鎲＄拹锟犳煕鎼存稑鈧繂鐣风涵鍛汗闁圭儤鍨归敍娆撴⒑缂佹ê濮囨俊顖氾工閵嗘帗绻濆顓犲帾闂佸壊鍋呯换鍐夊鍛＜婵°倐鍋撻柛濠傛健瀵鏁愭径濠勵唺闂佺粯鍔楅弫鎼佸汲閵堝鍊甸悷娆忓婢跺嫰鏌涢妸銉у煟闁绘侗鍣ｉ獮鎺楀箠閾忣偅鈷愰柟宄版嚇瀹曨偊宕熼銈庡晥闂傚倸鍊烽懗鍫曞箠閹捐瑙﹂悗锝庡枛缁犳氨鈧厜鍋撻柛鏇ㄥ亜閻庮參鎮楃憴鍕婵炲眰鍔戦幆宀勫箻缂佹鍘介梺闈涚箳婵敻宕悙鐑樼厽闁规儳鐡ㄧ粈瀣煛瀹€瀣埌閾伙綁鏌ц箛鏇燁仧缂佽京鍋炵换婵嬪煕閳ь剟宕遍弴鐐村創缂傚倷娴囨ご鍝ユ暜閿熺姰鈧礁鈻庨幘鏉戞異闂佸疇妗ㄧ拋鏌ュ矗濞差亝鐓熼幖娣€ゅ鎰箾閸欏鐒介柡渚囧櫍閺佹捇鎮╅懠顒傛毇婵犵數鍋涘Λ娆撳垂閻旂厧纾婚柟鍓х帛閸嬨劍绻涢崼锝嗙《闁告梻顭堣灃闁绘﹢娼ф禒锔姐亜閵娿儻宸ユい顐㈢箳缁辨帒螣鐠囧樊鈧挾绱撴担鍦槈妞ゆ垵妫涚槐鐐哄醇閵夛腹鎷虹紓浣割儏閻忔繈顢楅姀鐘斀闁绘劘顕滃銉╂煟閿濆洤鍘存い銏＄洴閹瑩寮婚妷锔芥當濠电姴鐥夐弶搴撳亾閹惧墎鐭嗗〒姘ｅ亾鐎规洘绮撴俊鎼佸煛閸屾瀚奸梻鍌氬€搁悧濠囧础閺囥垹閱囬柕澶堝劤閺屟冣攽閻樿宸ラ柣妤€锕畷鎴﹀磼閻愬鍘搁梺鎼炲劘閸庨亶鎮橀鍫熺厽闁规崘娉涢弸娑㈡煛瀹€瀣瘈鐎规洘锕㈡俊姝岊槻妞ゃ倐鍋撻梻鍌欐祰濡椼劎娆㈠顓狀洸闁割偅娲栭拑鐔哥箾閹存瑥鐏柛瀣姉缁辨帒鈽夊鍏兼暞闂侀€炲苯澧繛纭风節瀵鍨惧畷鍥ㄦ畷闁诲函缍嗛崜娑㈡晬閻斿摜绠鹃悗鐢殿焾椤庢挾绱掗悩铏碍闁伙絽鍢查…銊╁幢閳哄倐銉︾節绾版ê澧茬憸鏉垮暣閹囧箻閹颁焦缍庨梺鎯х箰閸樻粓宕戦幘璇叉嵍妞ゆ挾鍎愰埀顒€鐭傞弻娑㈠Χ閸℃瑦鍣梺閫涚┒閸斿矂锝炲鍫濋唶婵犲灚鍔栭崰妯肩磽閸屾瑧璐伴柛鐘崇洴椤㈡俺顦归柛鈹垮劜瀵板嫰骞囬澶嬬秱闂備胶绮摫妞ゆ梹鐗犲畷顖溾偓锝庡亗缁诲棝鏌ｉ幇鍏哥盎闁逞屽墯閻楃娀骞冭铻栭柛娑卞枛閸撶懓顪冮妶鍡樷拻闁哄拋鍋婇幃鐢稿醇閺囩喓鍘搁梺鎼炲劘閸庨亶鎮橀鍫熺厱閻庯急鍐ㄢ拤缂備胶绮换鍐崲濠靛纾兼繛鎴炆戦鐘充繆閻愵亜鈧呭緤娴犲围闁归棿绀佺粻鏍归悩宸剾闁轰礁绉电换娑㈠箣閻戝棛鍔烽梺鑽ゅ枂閸旀垿寮婚埄鍐╁闁告縿鍎遍埅鐢告⒑閸濆嫮鐒跨紒杈ㄦ礃缁傛帡鏁傞悙顒€鐝伴梺鍦帛鐢帡锝炲鑸碘拻濞达綀娅ｇ敮娑㈡煙閹间胶鐣虹€规洑鍗冲浠嬵敇閻愯埖鎲伴梻浣芥硶閸犳挻鎱ㄧ€靛摜鐭嗛柛鎰靛枟閻撳繐鈹戦悙鑼虎闁告梹顨婇弻娑氣偓锝庡亝瀹曞瞼鈧娲﹂崑濠冧繆閻戣姤鏅滈柤鎭掑労閸炲爼姊婚崒娆戭槮濠㈢懓锕畷鎴﹀川椤掔厧鎼～婊堝焵椤掑嫬绠栭柨鐔哄Т閸楁娊鏌曡箛銉х？闁告鏁诲娲偂鎼粹槅妫岄梺鍛婃尰閻燂附绌辨繝鍥ㄥ亗妤犵偟鍠撻幊鎾烩€﹂妸鈺侀唶闁靛繈鍨哄В鍥ㄧ節濞堝灝鏋涢柨鏇樺€濋垾锕€鐣￠幍顔芥闂佸湱鍎ら崹鐔煎几鎼淬劍鐓欓柣鎴灻悘銉╂偨椤栵絽鐏ｇ紒杈ㄦ崌瀹曟帒鈻庨幋锝囩崶闂備線娼荤紞鍡涘闯閿濆懐鏆︾憸鐗堝笒闁卞洭鏌￠崶鈺佇㈢紒渚婄畵濮婇缚銇愰幒鎴滃枈闂佸摜濮靛畝鎼佸箚鐏炶В鏋庨柟閭︿簽缁犳艾顪冮妶鍡楀Ё缂佽鲸娲滅划濠囨煥鐎ｃ劋绨诲銈嗗姂閸╁嫬螣閳ь剟鏌﹀Ο鑽ょ疄闁哄矉绲借灃闁逞屽墴閹勭節閸パ咃紵闂佺粯鏌ㄩ崥瀣偂韫囨稓鍙撻柛銉ｅ妽缁€鈧悗娑欑箓铻栭柣姗€娼ф禒锕傛煕閵娿儳浠㈡い顐㈢箳缁辨帒螣閼测晜鍤岄梻渚€鈧偛鑻晶鎾煕閳规儳浜炬俊鐐€栫敮鎺楀磹閸涘﹦顩锋繝濠傜墛閻撶姵绻涢懠棰濆殭闁诲骏绻濋弻锟犲川椤撶儐鏆㈤梺閫炲苯澧紒瀣笩閹筋偊姊洪崨濠勬噧缂佺粯鍔欓崺鐐哄箣閿旇棄浜归梺鍦帛鐢鈻撻弻銉︹拺闂傚牊绋掓径鍕磼鐠囨彃鏆ｉ柕鍡楀暣婵＄兘鍩￠崒姘ｅ亾閻戣姤鐓涘璺侯儏閻忋儲銇勯銏⑿ф慨濠呮閹风娀鍨惧畷鍥︾敾婵犵妲呴崑鍕疮閺夋埈鍤曟い鎰剁畱缁犳盯鏌℃径搴㈢《闁挎稒绮岄埞鎴︽倷閺夋垹浼囨俊鐐存綑閹芥粎妲愰悙鑼殕闁告洦鍏橀幏濠氭⒑缁嬫寧婀伴柤褰掔畺閸┾偓妞ゆ帒鍊搁崢鎾煙椤旀儳浠遍柡浣稿暣閸┾偓妞ゆ帒瀚ч埀顒佹瀹曟﹢顢欐總鍛婃殔婵犲痉鏉库偓鎰板磻閹剧粯鐓曢悘鐐额嚙婵倿鏌＄仦鐔锋閻も偓濠殿喗锚閸氬绱為崼婵愭富闁靛牆妫楁慨灞解攽椤斿搫鈧繈鐛崼銉ノ╅柕澶婃捣閸犳捇骞戦崟顖毼╅柕澹喚娼介梻鍌氬€风欢姘跺焵椤掑倸浠滈柤娲诲灦瀹曘垽宕妷褏锛滈梺閫炲苯澧紒妤冨枛閸┾偓妞ゆ帒瀚弲鏌ユ煟閹邦厾銈撮柡鈧禒瀣厱闁靛鏅╁Λ鎴︽煟椤撶噥娈旈柍瑙勫灴閹晝绱掑Ο濠氭暘婵犵數鍋犻婊呯不閹达箑鐓濈€广儱鎳愰弳鍡涙煕閺囥劌鍘撮柟椋庣帛缁绘稒娼忛崜褍鍩岄梺纭咁嚋缁绘繂鐣烽鐐村€烽悗闈涙憸椤旀洟鏌ｉ悩鍙夊巶闁告侗鍨卞▓濂告煟鎼淬値娼愭繛鍙夘焽閸掓帒鐣濋崟顐ゅ弨婵犮垼鍩栭崝鏇綖閸涘瓨鐓熸俊顖濐嚙缁茶霉濠婂啰鍩ｆ慨濠勭帛閹峰懘宕ㄦ繝鍛攨闂備胶顭堢花娲磹濠靛违闁告劦鍠栭獮銏＄箾閹寸儐鐒介柨娑欑懇濮婃椽宕滈懠顒€甯ラ梺绋款儐鐢帡鍩㈤幘瀵割浄閻庯綆鍋嗛崢浠嬫⒑瑜版帒浜伴柛銊ゅ嵆閹啴宕崝钘夌秺閹晠顢欓懖鈺€绱欓梻浣告惈閺堫剟鎯勯姘煎殨妞ゆ洍鍋撻柛鈹惧亾濡炪倖宸婚崑鎾绘煟閿濆棛绠炴鐐寸墬閹峰懎顫㈢仦鐐暫闂傚倷鐒︾€笛呮崲閸岀偛绠熸慨妞诲亾鐎殿噮鍣ｅ畷鐓庘攽閸繂袝濠碉紕鍋戦崐鏍暜閹烘纾归柣鐔稿閺嗭箓鏌＄仦璇插姕闁绘挻鐟╁娲敇閵娧呮殸婵犫拃灞芥灓缂佽鲸甯楃粭鐔煎炊瑜岄崰濠傗攽椤旂》鍔熺紒顕呭灦楠炲繘宕ㄩ弶鎴滅炊闂侀潧顦介悘婵嬪Ω閵夈垺鏂€闂佸疇妫勫Λ妤佺濠婂嫮绠剧痪顓㈩棑缁♀偓濡ょ姷鍋涢崯鎾箖濞嗘挻鍊绘俊顖滅帛閻濇牠姊绘担渚劸闁哄牜鍓涚划娆撳箣閻愭娲?';
    }
    if (/bedrockexception/i.test(rawMessage)) {
      return 'Claude Opus 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳婀遍埀顒傛嚀鐎氼參宕崇壕瀣ㄤ汗闁圭儤鍨归崐鐐烘偡濠婂啰绠荤€殿喗濞婇弫鍐磼濞戞艾骞堟俊鐐€ら崢浠嬪垂閸偆顩叉繝闈涱儐閻撴洘绻涢崱妤冪缂佺姴顭烽弻锛勪沪缁嬪灝鈷夐悗鍨緲鐎氼噣鍩€椤掑﹦绉靛ù婊勭箞椤㈡瑩宕ㄩ娑欐杸闂佺粯鍔曞鍫曞煝閺囩伝鐟邦煥閸愵亜鐓熼悗娈垮櫘閸嬪﹤鐣烽崼鏇ㄦ晢濞达絽鎼敮楣冩⒒婵犲骸浜滄繛璇х畱鐓ら柡宓嫭鐦庨梻鍌氬€风粈渚€骞夐敍鍕床闁告劦鍠撻埀顒€鍟换婵嬪磼閵堝棛绋佺紓鍌氬€烽悞锕傗€﹂崶顒佸仭鐟滅増甯楅悡鏇㈡煏婢跺鐏ラ柛鐘宠壘椤洭鎳￠妶鍥╋紳闂佺鏈悷褔藝閿斿浜滈柨鏇炲€烽幉鍓р偓娈垮櫘閸嬪棝骞忛悩缁樺殤妞ゆ帊鐒﹂鏇㈡⒒娴ｅ憡鎯堟繛灞傚灲瀹曞綊宕烽鐘辩瑝闂佹寧绻傞ˇ浼存偂閵夆晜鐓涢柛鎰╁妼閳ь剛鎳撻埢宥夊即閵忥紕鍘卞┑顔姐仜閸嬫挻绻涙担鍐叉搐閻撴﹢鏌熸潏楣冩闁稿﹦鍏橀弻銈囧枈閸楃偛顫╁銈忕稻濡炶棄顫忛搹瑙勫珰闁肩⒈鍓涢澶岀磽娴ｇ瓔鍤欓柣妤€妫濋、姘舵晲婢跺﹦顔愭繛杈剧悼閹虫挻绂嶅鍫熲拺缂佸娉曠粻娲煕鐎ｎ偄濮嶇€规洏鍨介弻鍡楊吋閸℃瑥骞楅梺鐟板悑閹矂宕瑰畷鍥╃煋闁汇垹鎲￠悡鏇㈡倵閿濆簼绨兼い銉у仱閺岋繝宕ㄩ鐘茬厽濡炪們鍨洪〃濠傜暦閻旂⒈鏁嗛柛灞捐壘婵″洭姊婚崒娆戝妽闁诡喖鐖煎畷鏇烆煥閸繄顦ㄩ梺鍛婄懀閸庡磭澹曢幆褉鏀介幒鎶藉磹濡や焦鍙忛柣鎴ｆ绾剧粯绻涢幋鐐╂（婵炲樊浜堕弫鍥煟閺傚灝顣崇紒鐘冲哺濮婇缚銇愰幒鎿勭吹缂備讲鍋撳〒姘ｅ亾闁挎繄鍋ゅ畷銊р偓娑欘焽閸樿棄鈹戦埥鍡楃仩闁圭⒈鍋婇幊婊呮喆閸曗晙绨婚梺闈涱檧缁犳垿宕悜妯诲弿濠电姴瀚敮娑㈡煙瀹勭増鍤囬柟顔惧厴瀵爼宕归褎鍨剁换婵嬫偨闂堟稐绮堕梺瀹︽澘濡奸柣锝嗙箘缁瑧鎹勯妸锔筋啎闂備胶顢婇幓顏嗙不閹存繍鍟呮繝闈涙储娴滄粓鏌熼幆褜鍤熼柍顖涙礋閺岋綀绠涙惔锝囩崲濠殿喖锕ュ钘壩涢崘顭嬪綊濡烽妷褍鈪甸悗娈垮枟瑜板啴鈥﹂妸鈺侀唶婵犻潧鐗嗛獮鍫ユ⒒娴ｅ憡璐￠柛搴涘€濆畷闈涱潩閻愭垝姹楅梺鍦劋閹歌鈻嶅鍫熲拺闁告挻褰冩禍鐐烘煕閿濆啫鍔氶摶鐐烘煕閺囥劌鐏￠柍閿嬪灴閺屾稑鈽夊鍫ョ反婵犮垼顫夐…鍥╂閹炬剚鍚嬮柛婊冨暢閸氼偊鎮楀▓鍨灕妞ゆ泦鍥х叀濠㈣泛顭鈺呮煥濠靛棙鍣稿瑙勬礋濮婃椽骞愭惔锝囩暤婵°倗濮撮幉锛勭矉瀹ュ鍊烽柣鎴烆焽閸樻捇姊洪懞銉冾亪藝閽樺）鐔煎焵椤掑嫭鈷戠痪顓炴噺椤ュ鏌ｉ弽褋鍋㈡鐐插暙閳诲酣骞嬮弬澶稿闂傚倸鐗婄粙鎺楀箟閸涘浜滈柡鍐ｅ亾婵炶尙鍠庨～蹇撁洪鍛画闂備緡鍙忕粻鎴濃枔閸洘鈷戠紒瀣儥閸庢垿鏌涚€ｃ劌鈧繈鐛崱娑樼妞ゆ棁鍋愰娲⒑缂佹﹩鐒介柡浣规倐閺佸秴顭ㄩ崼鐔叉嫼闂備緡鍋嗛崑娑㈡嚐椤栨稒娅犳い鏍ㄧ矌绾捐偐绱撴担璇＄劷缂佺姷鍋熼埀顒冾潐濞叉鏁埄鍐х箚闁割偅娲栭悙濠勬喐鎼淬劌姹查柍鍝勬噺閳锋帡鏌涚仦鍓ф噮妞わ讣绠撻弻娑橆潩椤掑鍓跺Δ鐘靛仜閸熸潙鐣烽幒鎴僵闁兼祴鏅涙慨娲煟閻斿摜鐭婇梺甯秮閻涱噣宕奸妷銉庘晠鏌嶆潪鎷屽厡闁稿﹦鍋ゅ娲礃閸欏鍎撻梺鍝ュ枍閸楁娊寮鍜佺叆闁割偆鍟块幏娲⒒娓氬洤浜為柛瀣洴閹崇喖顢涘☉娆愮彿闁诲海鏁哥涵鍫曞磻閹捐埖鍠嗛柛鏇ㄥ墰椤︺劑鏌ｉ姀鈺佺伈缂佺粯绻堥悰顕€宕橀妸銏＄€婚梺鐟扮摠閺屻劍绂嶆ィ鍐╃厽闁靛繆妲呴崯蹇涙煟閹烘垵鈷旈柍褜鍓氶鏍窗閺囥垹纭€闁告劕妯婂鏍磽娴ｈ鐒界紒鈾€鍋撻梺纭呭亹鐞涖儵鍩€椤掑啫鐨洪柣鈺佸缁绘繈鎮介棃娑楁勃濠电偛鍚嬮悷褔鍩€椤掍礁鍤柛鐘崇墵椤㈡岸濡烽敂鍓х槇闂佹悶鍎崝灞解枔閻斿吋鈷戦梻鍫熷喕缁憋繝鎮橀悙铏圭暫闁轰焦绮岄埞鎴︽偐閸偅姣勬繝娈垮枟閹告娊寮崘顔嘉у璺侯儏娴滆鲸绻濋悽闈浶㈡繛璇х畵瀹曟垿宕掗悙瀵稿幗闂佸搫鍊圭€笛囧箟閸濄儳纾奸柍閿亾闁稿鎹囧濠氬磼濮橆兘鍋撻幖浣瑰亱濠电姴瀚惌娆撴煙閻戞ɑ灏紒鍓佸仱閺屾盯寮撮妸銉ョ缂佺偓鍎抽妶鎼佸蓟瀹ュ牜妾ㄩ梺鍛婃尵閸犲酣鎮鹃柨瀣檮缂佸顑欏濠囨⒑闂堟稒绂嬫繝顫兌濡叉劙寮婚妷锔规嫼闂佸憡绻傜€氬嘲危閹间焦鐓熸俊銈傚亾閻庢碍婢橀悾宄扳攽閸♀晛鎮戦梺鎼炲劵婵″洭宕滈妸锔剧閻庣數顭堢敮鍫曟煟鎺抽崝鎴﹀箖閳ユ枼鏋庨柟瀛樻煥娴滈箖鏌ｉ悢鍛婄凡妞ゅ浚鍋勯…鑳槼妞ゃ劌锕ら悾鐑芥偨缁嬭法鍊為梺瀹狀潐閸庤櫕绂嶆ィ鍐╁仭婵炲棗绻愰顏嗙磼閳ь剟宕奸妷锔惧幈闂婎偄娲﹀Λ鎴︽嚀閸ф鐓忛柛鈩冩礈椤︼附銇勯锝囩煉闁糕斁鍋撳銈嗗笒鐎氼剛绮婚弽顓熺厓闁告繂瀚崳褰掓煕閵娿儱鈧綊濡甸崟顖氱疀闁告挷鑳舵牎闂備礁鎽滈崰搴ㄥ箠閹邦喗顫曢柟鎹愵嚙绾惧吋鎱ㄥ鍡楀幋闁稿鎹囬獮鏍ㄦ媴閸濄儻绱梻浣哥秺濡法绮堟担鍝勵棜闁荤喖鍋婂〒濠氭倵閿濆簼绨绘い鎺嬪灪閵囧嫰骞囬鍡欑厯闂佸搫琚崝鎴﹀箖閵忋倕浼犻柛鏇熷煀缂嶄線寮诲☉姘ｅ亾閿濆簼绨婚柍褜鍓氶幃鍌炲灳閿旂偓宕夐柕濠忕畱绾绢垶姊虹紒妯虹仸閽冮亶鏌熼悜鎴掓喚闁诡喗顨堥幉鎾礋椤掑偆妲柣搴㈩問閸犳牗鏅舵惔銊ョ闁靛繒濮弨浠嬫倵閿濆骸浜芥俊顐㈠暙閳规垿鎮欓弶鎴犱淮閻庤娲﹂崜鐔风暦濠婂嫬顕遍悗娑櫱氶幏娲⒑閸涘﹦绠撻悗姘卞厴瀹曟洘鎯旈妸锔惧幘闂佸憡鍔樼亸娆撳春閿濆鐓曢柍瑙勫劤娴滅偓淇婇悙顏勨偓鏍ь啅婵犳艾纾婚柟鎯у绾惧ジ鏌ｅΟ鍨毢閺佸牓鎮楃憴鍕婵炶尙鍠栧濠氬幢濡ゅ﹤鎮戦梺鍛婁緱閸ㄦ娊寮搁崘顔解拻濞达絽鎲＄拹鈥愁熆瑜庨〃鍛粹€﹂崹顔ョ喖鎯勯幑顒€娲ら拑鐔兼煏婢舵稑顩柛姗€浜跺娲棘閵夛附鐝旈梺鍝ュ枍閸楁娊宕烘繝鍥у嵆闁靛骏绱曢崢浠嬫⒑鐟欏嫬鍔ら柣掳鍔庣划鍫⑩偓锝庡枟閻撴稓鈧厜鍋撻柍褜鍓熷畷浼村冀椤撶偠鎽曢梺鎼炲労閸撴岸寮插┑瀣厓鐟滄粓宕滈悢鍏煎仒妞ゆ洍鍋撶€殿喕绮欓、姗€鎮㈤崫鍕疄闂傚倷绀侀幖顐﹀磹娴犲鏁嬬憸鏃堝春閳ь剚銇勯幒宥堝厡濠⒀囦憾閺岀喖鐛崹顔句患闂佸疇妫勯ˇ鍨叏閳ь剟鏌ｅΟ娆惧殭闁轰礁缍婂缁樻媴閻熼偊鍤嬬紓浣筋嚙閸婂潡鐛繝鍥х疀妞ゆ埈鍋呯敮鈩冩叏閳ь剟鏌曡箛瀣伄闁挎稒绻冪换娑欐綇閸撗冾嚤缂備緡鍠楅悷鈺佺暦椤愨挌娲敂閸涱垰骞嶇紓鍌欑椤戝棝顢栧▎鎾村亗闁稿繒鈷堝▓浠嬫煟閹邦垰鐨虹紒鐘哄吹閳ь剝顫夊ú蹇涘礉閹存繍鍤曢柛顐ｆ礀缁狅綁鏌ｅ▎灞戒壕濠碘剝褰冮悥鐓庮潖缂佹ɑ濯撮柛娑橈龚绾偓缂傚倷绶￠崳顕€宕归幎钘夋瀬妞ゆ洍鍋撴鐐村浮楠炴﹢宕滄担鎼佺崕闂傚倷绀佹竟濠囧磻娓氣偓瀹曞綊鎳￠妶鍜佹婵炲濮撮鍡涙偂閺囥垺鍊堕柣鎰絻閳锋棃鏌熼崘鍙夊櫤闁靛洤瀚伴弫鍌涚附閸涘鈧秹姊洪棃娑欐悙閻庢矮鍗冲顐﹀磼閻愭彃鐎銈嗘閸嬫劙濡堕鎴掔箚闁靛牆娲ゅ暩闂佺顑囬崑銈呯暦濠靛棌鏋庨柟鎹愭硾缁侊箓鏌熼崗鑲╂殬闁告柨绉瑰畷鎴﹀煛閸涱喖鈧爼鏌ｉ幇顒備粵婵炲懏娲熼弻鏇㈠醇椤掑倻鏆ゅ┑顔硷功缁垶骞忛崨鏉戝窛濠电姴鍊瑰▓姗€姊绘担鍛婂暈婵﹤缍婂畷褰掑垂椤旂偓娈惧┑鐘诧工閻楁粓寮€ｎ喗鐓冪憸婊堝礈濞嗘搩鏁嬮柨婵嗩樈閺佸鏌嶈閸撴瑩鎮鹃悜鑺ュ亗閹煎瓨蓱閺傗偓闂備胶纭堕崜婵嬫偡瑜嶉悾鐑藉传閸曘劍鏂€闂佹寧绋戠€氼剚绂嶆總鍛婄厱濠电姴鍟版晶顏呫亜椤愩垻绠洪柕鍥ㄥ姍楠炴帡骞嬮悪鍛惞闂佽姘﹂～澶娒洪弽顬℃椽鏁冮崒姘緢濠电姴锕ら悧濠囨偂濞嗘挻鐓曢柟鐐殔閹冲海绮敓鐘斥拺缂備焦蓱鐏忕敻鏌涢悩宕囧⒌闁绘侗鍣ｅ浠嬪Ω閿斿墽肖闂備礁鎲￠幐鍡涘椽閸愵亜鎯為梻鍌氬€峰鎺旀椤斿墽绀婇柛鈩冪☉閻鏌涢幇闈涙灈闁藉啰鍠愮换娑㈠箣閻愬灚鍣梺绋挎捣閸犳牠寮婚弴鐔虹闁割煈鍠掗崑鎾诲冀椤撶偟鐛ュ┑顔筋焾閸╂牠鍩涢幋锔藉仯闁搞儻绲洪崑鎾绘惞椤愶綆鍞查梻鍌欒兌绾爼宕滃┑瀣仭鐟滄柨顕ｉ崼鏇炵濞达絽鍘滈幏娲⒑闂堚晛鐦滈柛妯哄悑缁傚秵銈ｉ崘鈺冨幈闂佸搫鍊婚崑娑㈠箠閹邦喚鐭嗗┑鐘插€堕埀顒佸笒椤繈鏁愰崨顒€顥氶梻鍌欒兌缁垱绗熷Δ鍛棷闁挎繂鎷嬮崵鏇灻归悩宸剰閹喖姊洪幐搴㈢５闁稿鎸婚妵鍕償閵忊€崇３濠殿喖锕ュ钘壩涢崘顔肩厸濞达絿鍎よ闂傚倷绀侀幉锟犫€﹂崶顒€鍌ㄧ憸鏃堛€佸鑸垫櫜濠㈣泛顑嗛崕顏勵渻閵堝棗濮傞柛濠冾殜閹線宕奸妷锔规嫼濠殿喚鎳撳ú銈夋倶閸欏绠惧ù锝呭暱鐎氼噣銆呴悜鑺ョ叆闁哄洨鍋涢埀顒€缍婇幃锟犲即閵忥紕鍘繝鐢靛仜閻忔繈宕濋妶澶嬬厱闁冲搫顑囩粔顕€鏌″畝鈧崰鏍€佸▎鎾村€锋い鎺戝€告慨鑺ヤ繆閻愵亜鈧呯不閹寸姷绀婂┑鐘叉搐閽冪喐绻涢幋娆忕仼闁绘挻锕㈤弻娑⑩€﹂幋婵囩亪婵犳鍠楀ú鐔煎箖濡ゅ懎鍨傛い鎰剁悼閸戯繝鏌ｆ惔銏犲毈闁革綇缍佸畷娲焵椤掍降浜滈柟鐑樺煀閸旂喓绱掓担鍝勫幋闁哄本鐩顒€鈻庨幆褍澹嬮梻浣搞偢缂傛碍銇旈崫銉﹀床婵犻潧妫鈺傘亜閹惧鈯曢悗姘偢濮婅櫣鎷犻弻銉偓妤佺節閳ь剚娼忛妸銉ョ亖濡炪倖鎸堕崹褰掑触瑜版帗鐓曢柟浼存涧閺嬬喖鏌ｉ幘瀛樼濞ｅ洤锕、娑橆煥閸愩劋绮梺姹囧焺閸ㄤ即鎮ユ總绋跨畺闁跨喓濮村洿婵犮垼娉涢鍥储椤忓牊鈷戦柛鎾村絻娴滄繄绱掔拠鑼㈤崡閬嶆煕濠靛嫬鍔ょ痪鎯с偢閺屽秷顧侀柛鎾跺枎閻ｇ兘鎮㈢喊杈ㄦ櫖濠电偞鍨堕懝楣冪嵁濡や胶绡€缁剧増蓱椤﹪鏌涢妸鈺傛锭闁宠绉归弫鎰緞鐎ｎ偅鐝柣搴＄畭閸庡崬煤閵娧冾棜濠靛倸鎲￠悡鍐⒑濞嗘儳鐏犲ù婊堢畺濮婅櫣绮欏▎鎯у壉闂佺懓鎲￠幃鍌炲春閻愬搫绠ｉ柨鏃囨娴滃綊姊洪崜鑼帥闁稿鎳庤闁告洦鍓涚弧鈧┑鐐茬墕閻忔繈寮搁悢鍏肩厵缂佸鐏濋弳閬嶆煟閿濆洤鍘存鐐叉喘瀵墎鎹勯…鎴濇櫍婵犵數鍋為幐濠氭嚌閹灐娲晝閸屾氨鏌у┑鐘诧工閻楀﹪鍩涢幋锔界厱闁归偊鍓欑痪褔鏌熼姘卞ⅵ闁哄瞼鍠栧畷姗€鎳犻鍌ゅ晪闂備浇顕栭崳顖滄崲濠靛绠栭柕蹇嬪€曠粈鍌炴煠濞村娅呯€殿喗濞婂缁樻媴閸涘﹥鍎撻梺鍝ュ櫏閸嬪嫰婀侀梺绋跨灱閸嬫盯宕ョ憴鍕闁糕剝蓱鐏忎即鏌ｉ幘瀵告创闁诡喗顨婇弫鎰板礃閵娿儺鐎抽梻渚€鈧偛鑻晶顖涖亜閵娿儳澧曢崡閬嶆煙閻楀牊绶茬紒鐘冲▕閺岀喖骞嗚閸ょ喓绱掓径濠勫煟婵﹥妞藉Λ鍐ㄢ槈鏉堚晛褰嬬紓鍌欒兌婵敻宕归崹顔ユ盯宕熼顐㈡倯闂佹悶鍎弲婵嬫晬濠靛洨绠鹃弶鍫濆⒔缁夘剚銇勯弴鐔哄ⅹ闁崇粯鎸搁～婊堝焵椤掑嫬钃熸繛鎴欏灪閸嬫劗鈧娲栧ú銈夊焻瑜版帗鈷戝ù鍏肩懅閹ジ鏌涜箛鏃撹€块柣娑卞櫍瀹曞崬鈽夊▎鎴濆Ш闂備焦瀵ч弻銊ㄣ亹閵娾晛鐓涢柛鎰典簽閿涙繈姊虹粙鎸庢拱闁荤喆鍔戝畷妤冧沪鐟欙絾鏂€濡炪倖姊婚埛鍫ュ吹閻旇櫣纾奸弶鍫氭櫅娴狅妇绱掔紒妯肩疄鐎规洘甯℃俊鍫曞幢濞嗘垟鏋嗘繝鐢靛Х閺佹悂宕戝☉妯滅喐绻濋崘顏嶆锤濠电娀娼ч悷銈嗗緞閹邦剟鍞堕梺缁樻濞咃綁顢欓弴銏♀拺闁荤喖鍋婇崵鐔兼煕鐎ｎ剙鏋涙鐐诧躬瀹曟﹢鍩炴径鍝ョ泿闂備焦瀵уΛ渚€锝炴径濞炬瀺濠电姴鍟崣蹇撯攽閻樻彃鏆為柕鍥ㄧ箖椤ㄣ儵鎮欑€电鈷岄梺璇″枟閻熲晠鐛幘璇茬婵犻潧鐗冮崑鎾崇暦閸モ晝锛濋梺绋挎湰閼归箖鍩€椤掆偓閹芥粎鍒掗弮鍫濈妞ゆ棁濮ゅ▍鍥ь渻閵堝懐绠伴柣妤€锕畷鎴澪熷Ч鍥︾盎闂佸搫鍟ú锔炬兜閸洘鐓熼柕鍫濆€告禍鎯р攽閻樻剚鍟忛柛鐘愁殙瑜扮娀姊虹粙鍨劉婵犮垺蓱閺呫儱鈹戞幊閸婃洟骞婅箛娑樼厱闁硅揪闄勯悡鏇㈡煥閺冨浂鍤欐鐐寸墵閺屾盯寮▎鎯у壎闂佸搫鏈惄顖涗繆閹壆鐤€闁哄洨濮靛▓鐓庘攽閻樻鏆柛鎾寸箞楠炲啴宕掗悙鍙夌€梺绋挎湰缁嬫帗鎱ㄥ鍫熺厵婵炲牆鐏濋弸銈嗙箾婢跺﹥鍋ユ慨濠傤煼瀹曟帒鈻庨幋顓熜滈梻浣告贡閳峰牓宕戦崱娆忓灊闁哄啫鐗嗛拑鐔兼煏婢跺牆鍔ゆい锔诲櫍閺岀喖宕楅懖鈺傛闂佸憡鏌ㄧ粔鐟扮暦閺囩倣鏃堝川椤斿皷鍋撻崼鏇熺厽闁归偊鍘界欢鏌ユ倵濮橆剟顎楅棁澶嬬節婵犲倸顏柣顓熷浮閺岋紕浠︾拠鎻掝潎閻庢鍣崳锝呯暦閸撲焦宕夐柣鎴烇供閸炴彃鈹戦悩鍨毄闁稿鐩獮濠冩償閿濆洨鐓嬮梺姹囧灮椤牏绮婚悙鐑樼厪濠电姴绻愰々顒傜磼閳锯偓閸嬫捇姊绘担鍛婂暈闁告柨绻樺顒勫磼濞戞凹娴勯梺闈涚箞閸婃牠鍩涢幋锔藉仯闁搞儻绲洪崑鎾绘惞椤愩倓澹曢梻鍌欒兌椤牏鎹㈤幋锔芥櫇闁靛繈鍊栭崑妯汇亜閺冨倵鎷￠柛姘儏椤潡鎳滈惉顏呭灴瀵煡鍩￠崨顔规嫼闂佺绻樺Λ鍧楁嚋椤忓牊鐓曢幖娣妺閹插墽鈧鍠氶…鍫ュ煡婢舵劕顫呴柍閿亾闁瑰嘲顭峰铏圭矙閹稿孩鎷遍梺鑽ゅ暀閸パ咁槷閻庡箍鍎遍ˇ浼存偂濞嗘劑浜滈柡鍐ㄦ搐娴滃綊鏌涢埡瀣偧闁逞屽墲椤煤濡吋宕查柛鏇ㄥ灠閻掑灚銇勯幒鎴姛缂佸鏁婚弻娑㈠箻鐎靛憡鍣┑鐐叉閸ㄨ姤淇婇崼鏇炲窛妞ゅ繐鎳忛弶鎼佹⒒娴ｈ櫣甯涢柨姘舵煟閵堝懏澶勭紒鏃傚枎铻ｅ〒姘煎灡缁傚棝姊洪崨濠勨槈闁宦板姂閸╂盯骞嬮敂鐣屽幈闂佹寧妫侀褔鐛弽銊ｄ簻闁挎繂鎳庨幃鎴犵磼缂佹绠炲┑顔瑰亾闂佸疇妫勯幊鎾诲焵椤掆偓濞硷繝寮婚悢纰辨晬婵ê鍟块顓㈡煣缂佹澧甸柡灞界Х椤т線鏌涢幘璺烘灈闁搞劑绠栭弫鍌炴倷椤掆偓绾绢垶姊洪棃娑辩叚缂佺姵鍨规竟鏇㈩敍閻愮补鎷洪梺璇″瀻閸涱垼鍞舵繝鐢靛Л閸嬫捇姊洪鈧粔瀵哥矆婢跺瞼纾奸悗锝庝簽濮樸劑鏌￠埀顒佺鐎ｎ偆鍘介梺褰掑亰閸撴盯骞楅悩鐢电＝鐎广儱妫楅悘鎾煙椤旂瓔娈旀い顐ｇ箞椤㈡﹢鎮㈤崫鍕濠碉紕鍋戦崐銈夊磻閸曨厽宕查柟閭﹀枛瀵弶淇婇悙顏勨偓鏇犳崲閹版澘绠悗锝庘偓顓熺洴瀹曟﹢濡搁姀鈩冩澑闂備胶绮崝鏍ь焽濞嗘挻鍊堕柕澹懏锛忕紓鍌欓檷閸ㄥ綊鐛Ο鑽ょ闁瑰濮甸弳顒勬煕閳规儳浜炬俊鐐€栫敮鎺斺偓姘煎弮閸╂盯骞掗幊銊ョ秺閺佹劙宕ㄩ鍏兼畼闂備礁鎽滈崰鎾诲磻閻愬灚宕叉繛鎴炵鐎氭氨鎲歌箛娑欏仼闁汇垻顣介崑鎾舵喆閸曨剛顦ㄩ梺鎼炲妼閻忔繈鎮鹃悜钘夌闁绘劏鏅滈～宥呪攽閳藉棗鐏犻柟纰卞亝缁傚秹宕奸弴鐔叉嫼闂佸憡绻傜€氬嘲危閹间焦鐓熸俊銈傚亾闁哥喐娼欓锝夊箵閹哄棙鏂€闂佸壊鍋呯换宥呂涘鍕閻庣數顭堝瓭濡炪倖鍨靛Λ婵嬪箖閿熺姴鍗抽柕蹇娾偓鏂ュ亾閸洘鐓熼柟閭﹀幗缂嶆垹绱掗埀顒勫礃椤垹鍞甸柣鐔哥懃鐎氭悂鎳撻崸妤佺厸閻忕偟鏅暩濡炪伇鍌滅獢闁哄本鐩獮妯兼崉閻戞浜梺鑺ヮ焽閸犳牠寮婚悢鍏煎€锋い鎺嶈兌娴煎洭姊洪崫鍕靛剰闂佸府缍佸濠氬即閿涘嫮鏉搁柣搴秵娴滄牠宕戦幘璇插唨妞ゆ挾鍋熼弻褔姊鸿ぐ鎺擄紵闁绘帪绠撻幃锟犳偄闂€鎰畾濡炪倖鐗楃换宥夊吹濞嗘垹纾奸柟缁樺俯閻撳ジ鏌＄仦鍓с€掗柍褜鍓ㄧ紞鍡樼閻愬瓨娅忓┑鐘愁問閸犳牠鏁冮妸銉㈡瀺闁挎繂娲ら崹婵囩箾閸℃ê鐏︾€规洖顦甸弻鏇熺箾瑜嶉懟顖炲极瑜版帗鈷掗柛灞剧懅椤︼箓鏌熺拠褏绡€闁硅櫕绻冮妶锝夊礃閻愵剚娅堝┑鐘灱濞夋盯鏁冮敃鍌氭辈闁挎洖鍊归悡娑㈡煕閵夛絽鍔氶柣蹇ｄ邯閺屾稓鈧綆浜滈顓㈡煛鐏炲墽鈽夐柍瑙勫灴瀹曠喖顢曢姀鐘樻垿姊绘担椋庝覆缂佺姵鍨块幃褎绻濋崟顒€搴婂┑鐘绘涧椤戝棝宕戦妸鈺傗拻闁割偆鍠庨崹渚€鏌曡箛瀣偓鏍偂閺囩偐鏀介柣妯诲絻閺嗙偤鏌涙繝鍐ㄥ闁靛洤瀚版慨鈧柍鈺佸枤濡啫顪冮妶鍐ㄧ仾婵☆偄鍟悾鐑芥偄閻撳宫鈺呮煥閺冨洤袚婵犮垺鍨甸埞鎴︽晬閸曨偂鏉梺绋匡攻閻楃娀骞冭铻栭柛鎰典簽閻撴捇姊洪崷顓炲妺闁哄睙鍥ㄥ€垮┑鐘叉处閻撱儵鏌￠崶鈺佷粶闁逞屽墮缂嶅﹪骞冮垾鏂ユ婵﹫绲芥禍楣冩煕韫囨搩妲稿ù婊堢畺閺岋絾鎯旈婊呅ｉ梺鍛婃尰閻熲晛鐣烽崫鍕殕闁告洦鍓涢崣鍕箾閺夋垵鎮戦柣鐔濆懐鐭撴い鏇楀亾闁哄备鈧磭鏆嗛悗锝庡墰琚︽俊銈囧Х閸嬫盯顢栨径鎰畺婵炲棙鎸哥粈鍐煃鏉炴壆顦﹂柟鐣屾暬閹鈻撻崹顔界亾濡炪値鍘奸悧鎾诲春閵忊剝鍎熼柕濞垮劤椤旀帞绱撴笟鍥ф灕妞ゎ偄顦遍埀顒佽壘閵堢顫忕紒妯诲濞撴凹鍨遍弫顖炴⒑缁嬫鍎愰柛鏃€鐟ラ悾鐑藉箣濠靛啯顫嶉梺闈涚箳婵兘宕濋敃鈧—鍐Χ閸℃鐟愮紓浣哥亪閳ь剚鏋奸弸鏃堟煛閸モ晛啸缁炬崘鍋愮槐鎾存媴鐠囷紕鍔峰┑鐐插级閹告娊寮诲☉銏犵厴闁诡垎鍌氼棜婵犵绱曢崑鎴﹀磹閺嶎偅鏆滈柟鐑樻煛閸嬫挸顫濋悡搴＄睄闂佽鍠掗埀顒佹灱濡插牊鎱ㄥ鍫㈠埌濞存粓绠栭弻娑滅疀閹垮啯笑婵炲瓨绮撶粻鏍ь潖濞差亝鐒婚柣鎰蔼鐎氭澘顭胯椤曨參鍩€椤掑喚娼愭繛鍙夊灴瀹曪繝宕樺顔兼婵炲濮撮鎰板极閸ヮ剚鐓熸俊顖氱仢閻ㄦ椽鏌曢崼顒傜暠闁宠鍨块幃娆戔偓娑櫭棄宥夋⒑缁洘娅呴柛鐔告綑閻ｇ兘骞嬮敃鈧粻濠氭煙绾板崬骞楁い鏃€妫冨铏圭磼濡搫顫嶅┑鐐插悑閻熴儵婀佸銈嗘⒒閻℃柨鈻撴禒瀣厽闁归偊鍓氶埢鏇㈡煕鎼达紕绠婚柡灞界Ф閹叉挳宕熼銈勭礉闁诲氦顫夊ú鎴﹀础閹惰棄绠栫憸鏂跨暦婵傚憡鍋勯梺鍨儐椤斿倻绱撻崒姘偓宄懊归崶銊ｄ粓闁归棿绀佺粻鏌ユ煕閵夋垵鎳忓▓楣冩⒑閸︻厼鍔嬮柛銊у枛瀵憡鎯旈妸锔惧幍闂佺粯鍨堕敋闁诲繈鍎甸幃浠嬵敍閿濆懐浠紓浣介哺閹瑰洤鐣烽幒鎴旀瀻闁硅揪绲块悰銉╂⒒娓氣偓濞艰崵绱為崱娑橀棷闁挎繂鎳愰弳锔炬喐閻楀牆绗掗梺鍗炴喘閺岋繝宕堕埡浣锋埛闂佷紮绲惧浠嬪箖瀹勯偊鐓ラ柛鎰碘偓顖樺劦閺岋綀绠涢幘铏濠殿喖锕ュ钘夌暦閵婏妇绡€闁稿本顕撮弴鐔虹閻庢稒顭囬惌宀勬煕鐎ｃ劌鈧繈鐛崘顔芥櫢闁绘灏欓鎺楁煟鎼淬劍娑ч柟鑺ョ矒閹線宕奸妷锔规嫼闂傚倸鐗婇惄顖炴偘濠婂懐纾奸棅顐幘閻瑩鏌熼鍡欑瘈妤犵偛娲幃褔宕奸姀鐘茬疄闂傚倷绀侀幖顐﹀疮椤栫偛绠板Δ锝呭暞閸嬧晠鏌ｉ姀銏╂毌闁稿鎸搁埢鎾诲垂椤旂晫褰梻浣侯焾椤戝懘鏁冮妶澶嬪仼闁绘垼妫勭粻铏繆閵堝嫮顦﹂柍褜鍓涢崗姗€骞冨Δ鍛仺婵炲牐娉曢崝绋课旈悩闈涗粶闁绘锕﹂幑銏犫攽閸″繑鐏侀梺鍓茬厛閸犳鎮樺澶嬬厾闁割煉绠戝ú锕傛偂閺囥垹绠规繛锝庡墮婵℃椽鏌熼幓鎺戔挃闁逞屽墲椤煤濡吋宕查柛宀€鍋涢悡婵嬪箹濞ｎ剙濡肩紒鐙呯秮閺岋絽螣绾拌鲸娈扮紓浣介哺閻撯€愁潖缂佹ɑ濯撮柟鑲╁仜娴狀噣姊洪崫鍕殌閻忓繑鐟ラ銉︾節閸曨厾锛滃┑鈽嗗灥閸嬫劘銇愰幆褉鏀芥い鏂款潟娴犳粓鏌涚€ｎ偅宕岄柡灞糕偓宕囨殕閻庯綆鍓涜ⅵ闂備浇妗ㄩ悞锕傚礉濞嗗繒鏆﹂柟顖炲亰濡茶螖閻橀潧浠滄い鎴濐樀楠炲啫螖閸愨晛鏋傞梺鍛婃处閸撴盯藝椤撱垺鈷戠紒瀣硶缁犳煡鏌ㄩ弴妯虹伈濠碘€崇摠閹峰懘鎳栧┑鍫濇灁闁诡喕鍗抽崺鍕礃閻愵剛绉炬繝鐢靛Х椤ｈ棄危閸涙潙鍨傞柟鎯版缁犵娀鏌熼幆褍娈哄璺侯煬濞尖晠鏌ら崫銉毌闁归绮换娑欐綇閸撗勫仹闂佺娅曢幑鍥€佸顒夌叆闁告侗鍨抽敍婊堟煟閻樺弶澶勭憸鏉垮暣閸┾偓妞ゆ巻鍋撶紓宥咃躬婵℃挳宕橀鍢夈劑鏌嶆潪鎵槮缂佹劖绋掔换婵嬫偨闂堟刀銏ゆ煕閻曚礁鐏﹂柟顕€娼ч悾锟犳焽閿旇棄鐦滈梻渚€娼ч悧鍡椢涘☉娆愭珷闂侇剙绉甸悡鏇㈡倵閿濆骸澧ù鐘讳憾閺岀喖顢氶崱娆戠槇闂佽鍠撻崹钘夌暦濡ゅ懏鍤冮柍杞扮濮规彃鈹戦悩鍨毄濠电偐鍋撳┑鐐板尃閸忕偓鐩、姗€鎮欏蹇曠М闁诡喗绮撻幊鐐哄Ψ瑜嶉獮宥夋⒒娴ｅ憡鎯堥悶姘煎亰瀹曟洟骞庨懞銉ヤ患濠电偛妯婃禍婵嬫偂濞戞埃鍋撻崗澶婁壕闁诲函缍嗛崜娑㈡晬閻斿摜绠鹃悗鐢殿焾椤庢挾绱掗悩铏碍闁伙絽鍢查…銊╁幢閳哄偆鈧洭姊绘担绛嬪殭缂佺粯顨嗙粋宥夘敆閸屾侗娼熼梺瑙勫劤閻°劍鍒婇幘顔界厱婵犻潧妫楅悵鏃堟煥濠靛棭妲归柣鎾跺枛閺屽秹宕崟璺轰紣闂佽绻掓慨鐢稿Φ閸曨垰鍗虫い蹇撴琚︽俊銈囧Х閸嬬偤鏁冮姀銈冣偓浣糕枎閹炬潙鐧勬繝銏ｆ硾濡绂嶆ィ鍐╃厽闁硅揪绲借濡炪們鍎遍敃銉╁Φ閸曨垰绠涢梻鍫熺◥缁ㄨ螖閻橀潧浠﹂柨鏇樺灲楠炲啯绂掔€ｅ灚鏅┑鐐村灦閸╁啫危閸儲鈷戦悗鍦濞兼劙鏌涢妸銉﹀仴鐎殿噮鍋勯鍏煎緞婵犲嫷妲规俊鐐€栭崝蹇涘礈濠靛棭鐔嗛柍褜鍓熷濠氬磼濞嗘帒鍘″銈庡幖閻楁捇寮崘顔嘉ㄩ柍鍝勫€告禍閬嶆⒑閸濆嫭绁╂繝顫兌缁辩偤寮介鐘插絼闂佹悶鍎崝宀勫箹缁嬫５鐟邦煥閸愵亞楔闂佸搫鐬奸崰鏍箖濠婂吘鐔兼惞闁稒鍋呭┑锛勫亼閸娧呪偓闈涚焸瀹曚即寮介鐐靛幋闂佺鎻梽鍕磹閻戣姤鐓曟繛鍡楁禋濡牊淇婇銈呬户缂佽鲸鎸婚幏鍛存惞閻熸壆顐奸梺姹囧焺閸亪鍩€椤掍礁澧柛銈嗘礋閺岀喖骞嗛弶鍟冩捇鏌￠崨顔剧疄闁哄本绋撴禒锕傚礈瑜嬮埀顒佸浮閺屾稑鈻庤箛鏃戞闂佸疇顫夐崹鍧楀箖閳哄啰纾兼俊顖氼煼閺侇亝绻濈喊妯活潑闁稿甯″畷銏ゆ偂鎼达紕銈梻鍌欑閹诧紕缂撻崸妤€纾块柛鎰棘濞戙埄鏁嶉柣鎰嚟閸橀潧顪冮妶鍡欏ⅹ婵☆偅顨婂畷顖烆敍閻愯尙锛欏銈嗙墬缁海澹曢挊澹濆綊鏁愰崼鐕佷哗闁汇埄鍨遍惄顖炲蓟閿濆鐓涘┑鐘插€绘禒鎼佹⒑缂佹ü绶遍柛鐘冲哺閸┾偓妞ゆ帒锕︾粔鐢告煕閻樻剚娈滅€规洘鍔欓幃婊堟嚍閵壯冨箞婵＄偑鍊ら崢浠嬪垂閸偆顩叉繝濠傚缁犻箖鏌涘☉鍗炴珮婵炲牊娲栬彁闁搞儜宥堝惈闂佽鍠楅悷鈺呫€侀弮鍫濈闁靛鍎版竟鏇㈡⒑閸濆嫮鈻夐柛妯恒偢閹锋垿鎮㈤崗鑲╁帾婵犵數鍊崘鈺佹闂佺粯鎸搁澶婎潖濞差亝鍤掗柕鍫濇噺閻忓牓姊虹粙娆惧剰闁挎洏鍊濋垾?';
    }
  }

  return errorMessageFrom(error);
}

function moderationBlockedMessage(errorPayload) {
  const moderation = errorPayload?.error?.moderation_details || errorPayload?.moderation_details || {};
  const categories = Array.isArray(moderation.categories) ? moderation.categories : [];

  if (categories.includes('public_figure')) {
    return 'GPT image 2.0 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳婀遍埀顒傛嚀鐎氼參宕崇壕瀣ㄤ汗闁圭儤鍨归崐鐐烘偡濠婂啰绠荤€殿喗濞婇弫鍐磼濞戞艾骞楅梻渚€娼х换鍫ュ春閸曨垱鍊块柛鎾楀懏锛忛梺璇″瀻瀹€鈧崥瀣⒑閸濆嫮鐒跨紓宥勭窔閻涱噣宕堕澶嬫櫌婵炶揪绲块幊鎾诲礈閻㈢數纾介柛灞剧懆椤斿鏌涚€ｎ偅宕岄柡灞剧洴瀵挳濡搁妷銉ь啈闂備礁鎽滄慨鐢稿礉濞嗘挸钃熼柨婵嗘啒閺冨牆鐒垫い鎺戝閸嬪鏌涢埄鍐噮缂佺姵妫冮弻鐔兼倻濡儵鎷诲┑鈽嗗亽閸ㄥ爼寮婚悢纰辨晬闁糕剝顨堥悘閬嶆煕濮橆剦鍎旀慨濠冩そ瀹曨偊宕熼浣瑰闂備胶鍎甸弲鈺呭垂娴兼惌鏁嬮柨婵嗩槸缁犵粯銇勯弬鎸庮潔闁冲搫鎳忛悡蹇擃熆鐠団€崇仩闁稿﹤顭峰顐ｃ偅閸愨斁鎷婚梺绋挎湰閻熴劑宕楃仦淇变簻妞ゆ挾鍋熸晶锔姐亜閵忥紕澧电€规洘甯￠幃娆撴嚑椤掍胶鍙勯梻鍌欒兌缁垶鈥﹂崼銉晪鐟滄棃骞忛幋锔藉亜闁稿繗鍋愰崢鎼佹⒑閹肩偛鍔楅柡鍛洴瀵悂寮崒婊咃紲闂佺粯顭堝畷鐢告偩濞差亝鐓涚€光偓鐎ｎ剛袦濡ょ姷鍋涘ú顓炍涢崘銊㈡婵妫欏ù鍥⒒閸屾瑨鍏岀紒顕呭灣閹广垽宕橀…鎴炵稁闂佺厧顫曢崐鏍綖閺囥垺鐓欓柟顖嗗懏鎲兼繝娈垮灡閹告娊寮婚悢铏圭＜婵☆垵娅ｉ悷鎰節閵忥綆娼愭繛鑼枎椤繒绱掑Ο璇差€撴繛鎾村嚬閸ㄦ娊宕濋幖浣光拺婵炶尪顕ф晶顕€鏌曢崼銏╃劸闁伙絿鍏橀獮瀣晜閽樺鍋撻悜鑺ョ厽闁瑰浼濋鍛洸婵°倕鎳忛ˉ濠冦亜閹扳晛鐏璺哄閺岀喖宕ㄦ繝鍐ㄥ攭閻庢鍠撻崝宥囩矉閹烘柡鍋撻敐搴′簽闁告ü绮欏楦裤亹閹烘垳鍠婇梺鍛娒妶鎼佸箖濮椻偓婵＄兘鍩￠崒婊冨箞闂備胶绮ú鎴犵矆娓氣偓閹﹢鏁傞柨顖氫壕閻熸瑥瀚粈鈧梺鍝ュ枙濞夋洟宕ｉ崨顓ф富闁靛牆鎳愮粻浼存煙閾忣偄濮嶇€规洏鍨介幃浠嬪川婵炵偓瀚奸梻浣告啞缁嬫垿鏁冮敃鍌氱疇闁告劏鏂傛禍婊堟煥閺傝法浠㈢€规挸妫涢埀顒冾潐濞叉﹢宕濆▎鎾跺祦闁搞儺鍓﹂弫鍥煟閺傚灝妲诲ù鐓庨閳规垿鎮╅崹顐ｆ瘎婵犳鍠栭顓㈠焵椤掍礁鍤柛鎾跺枎閻ｅ嘲鈹戦崼姘壕闁挎繂楠搁弸鐔兼煕婵犲嫭鏆柡宀嬬秮婵偓闁靛牆妫欓柨顓㈡煟閵忊晛鐏犻柣鏍с偢瀵顓奸崶銊ョ彴闂佸搫琚崕鍗烆嚕閺夎鏃堟偐闂堟稐绮跺銈嗗灥椤︾敻鐛崘顔肩厸闁告粈鐒﹂弲鈺呮⒒閸屾艾鈧悂顢氶銏犳瀬濡わ絽鍟埛鎺楁煕鐏炴崘澹橀柍褜鍓氶幃鍌氱暦閹扮増鍊婚柤鎭掑劚濞堟垿姊洪崜鎻掍簼婵炴彃绉归崺鈧い鎺戯功閻ｇ數鈧娲滈崢褔鍩為幋锕€绠涙い鎾跺仜閸樼偤姊婚崒娆戝妽閻庣瑳鍥ц摕闁靛鍔婃禍褰掓煟閹邦喖鍔嬮柛濠傜仢閳规垿鎮╅幓鎺撴缂備胶濞€缁犳牠寮诲☉銏犵労闁稿繆鏅滈崹瑙勭閹间緡鏁囬柕蹇ョ磿閸樹粙姊洪崷顓炲妺闁搞劏顫夌粋鎺戔槈閵忥紕鍘梺鎼炲劀閸愬彞绱旀俊銈囧Х閸嬬偟鏁幒妤婃晣濠靛倻顭堥悙濠囨煠閸涘﹥娅曟繝濠傜墛閳锋帒霉閿濆洤鍔嬮柛銈傚亾闂備礁鎲￠懝楣冾敄婢舵劗宓侀柛鎰靛枛绾惧ジ鏌ｉ幇顖氳敿闁硅姤娲栭埞鎴︽倷閺夋垹浠搁梺鑽ゅ暀閸涱厼袣闂侀€炲苯澧存慨濠冩そ瀹曘劍绻濋崒姣挎洘绻涚€涙鐭岄柛瀣ㄥ€濋獮鍐锤濡も偓缁€瀣亜閺嶃劎鈻撻柟鐤缁辨捇宕掑▎鎴濆闁活亜顦辩槐鎺楀醇閺囨碍鍠氶梺鍝勬湰閻╊垶骞冮埡鍛闁圭粯甯楅幊娆撴⒒娴ｈ櫣銆婇柡鍌欑窔瀹曟垿骞橀幇浣瑰瘜闂侀潧鐗嗗Λ妤冪箔閹烘鐓ラ柡鍥朵簻椤╊剛绱掗鑺ヮ棃闁诡喕绮欏畷銊︾節閸曨偄绠為梻鍌欑劍鐎笛呮崲閸屾侗娈界紒瀣氨閺嬪秶鈧箍鍎卞ú鐘诲磻閹炬枼鏋旈柛顭戝枟閻濐噣姊虹粙娆惧剰闁挎洏鍊濋幃楣冩倻閽樺顔婂┑掳鍊撶粈渚€鍩€椤掑倸鍘撮柡灞诲€楅崰濠囧础閻愭祴鎷婚梻浣告憸閸犲骸煤椤撶儐娼栨繛宸簻娴肩娀鏌涢弴鐐典粵缁楁垿姊绘担铏瑰笡妞ゃ劌鎳庤灋婵炲棙鎸搁悿楣冩煠閸濄儲鏆╂い鈺冨厴閹鏁愭惔婵堟晼闂佷紮绲块崕銈囨崲濠靛顥堟繛鎴炃氶崑鎾诲箹娴ｅ摜鐤呴梺璺ㄥ枔婵敻宕戦崒鐐寸厽闁哄倹瀵ч幉鍝ョ磼閻樿崵鐣洪柡宀€鍠撻埀顒傛暩椤牊绂掕椤儻顧佸ù婊庝邯瀵鈽夐姀鐘电潉闂佽鍎虫晶搴ㄥ汲閵堝鈷戦柛婵嗗閻忛亶鏌涢悩宕囧⒌闁靛棔绀侀埢搴ㄥ箻閺夋垳绨甸梺纭呭亹鐞涖儵骞婇敐澶婄厸濞撴艾娲︾€靛矂姊洪棃娑氬濡ょ姵鎮傞悰顕€骞嬮敂鐣屽幈闂佸搫鍟犻崑鎾绘煕閵娧勬毈闁诡噣绠栭幃婊堟寠婢光斁鏅犻弻宥夊传閸曡埖鏁鹃梺鍝勬嫅缂嶄線骞冨畡閭︾叆闁告劦鍣埀顒侇殘閹喖鈻庤箛锝囧數闂佸吋鎮傚褎鎱ㄩ崼銉︾厓闂佸灝顑呯粭鎺楁婢舵劖鐓ユ繝闈涙閸ｆ椽鏌涢悢鍝勪槐闁诡喖缍婇獮鍥Ω閵夈儮鎷ら梻渚€娼уú銈団偓姘嵆閵嗕礁顫滈埀顒勫箖濞嗘挻顥堟繛鎴炲笒瀵板秴鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬⒑閻熸澘鈷旂紒顕呭灦瀹曟垿骞囬悧鍫㈠幘缂佺偓婢樺畷顒佹櫠椤栫偞鐓熼柟鍨缁夘喗鎱ㄦ繝鍕笡闁瑰嘲鎳愮划娆忊枎閻愵剦妫忛梻鍌欒兌椤牓顢栭崨鏉戠疇閹艰揪绲藉鍙夌節濞堝灝鏋熼柕鍥ㄧ洴瀹曟垿骞橀崹娑樹壕閻熸瑥瀚粈鍐煕閵娿儲鍋ラ柣娑卞櫍瀹曞爼顢楁担闀愮綍闂備礁澹婇崑鍛崲閳ь剟鏌涢弽銊у⒌婵﹦绮幏鍛喆閸曨偂鍝楅梻浣侯焾濞寸兘宕曢妶鍥╃焿鐎广儱鎷嬮悡銉╂煕椤愩倕鏋庨柛鎿冨弮濮婅櫣绱掑Ο铏逛桓闁煎灕鍏犵懓顭ㄩ崟顓犵厜闂佸搫鐭夌换婵嗙暦閹烘垟鏀介柛銉㈡杺閳ь剙锕铏圭磼濡櫣鐟ㄩ梺纭咁嚋缁绘繈鐛崼銉ノ╅柨鏂垮⒔閻﹀牓姊洪幖鐐插姉闁哄懏绻勭划锝呂旈崨顔规嫼闂傚倸鐗婄粙鎺撳緞閸曨垱鐓曢柡鍐ｅ亾闁荤啿鏅犻幃浼搭敋閳ь剟鐛幒鎳虫棃鍩€椤掑倻涓嶉柨婵嗘缁♀偓婵犵數濮撮崐鎼佸汲閻愮儤鐓熼幖娣灩閳绘洘鎱ㄦ繝鍌ょ吋鐎规洘甯掗埢搴ㄥ箣椤撶啘婊堟⒒娴ｄ警鏀板┑顔哄€楅崚鎺戭吋婢跺﹦鐤勯梺闈浥堥弲婊堝磻閵娧呯＜閻庯綆鍘界涵鑸点亜閺傛寧鍠樻慨濠冩そ閹剝鎯旈鐣岀◥闂備胶顭堥敃銉┿€冩繝鍥х畾閻忕偞鍎崇欢鐐烘煙闁箑骞橀柛妯兼暬濮婅櫣绱掑Ο铏逛桓闂佹寧宀搁弻锝堢疀閹剧紟锝吳庨崶褝韬鐐存崌楠炴帡寮惔鎾冲緧闂傚倷绀侀幖顐﹀嫉椤掆偓鐓ゆ繝闈涚墢娑撳秵绻涢幋鐐垫噮缂佺娀绠栭弻鐔碱敍閸℃鈧悂藟濮樿埖鈷掑ù锝勮閻掑墽绱掔紒妯哄妤犵偛锕ラ幆鏃堟晲閸屾矮澹曢梺鍓茬厛閸嬪棝宕ｉ埀顒€鈹戦纭峰伐妞ゎ厼鍢查悾鐑藉箳閹存梹鐎婚梺鐟扮摠缁诲倿鈥栨径鎰拻濞达絿鐡旈崵鍐煕閻樺磭澧甸柟顔哄劦閹剝鎯旈敐鍡橆啎闂備礁鎼ú銊╁磿閹扮増鍋傞柕澶嗘櫆閻撴洘銇勯幇鍓佹偧缂佺姵鎸剧槐鎺楀箛椤撶姵鍒涘┑顔硷攻濡炶棄鐣烽妸锔剧瘈闁告洦鍘鹃崢鎰版⒒娴ｅ憡鎲搁柛鐘冲姈缁旂喖宕卞▎蹇撶亰闂佸搫鍟悧婊堝极鐎ｎ喗鐓冪憸婊堝礈閻斿鍤曞┑鐘崇閺咁剟鏌涢弴銊ょ凹闁告洖鍟村娲川婵犲啫鐦烽梺鍛婃处閸嬪嫰鎮橀埄鍐瘈闁汇垽娼у暩濡炪倧绲肩划娆忕暦濠婂啠鏀介悗锝庝簽閻ｆ椽姊虹粙璺ㄧ伇闁稿鐩鍛婄瑹閳ь剟寮婚悢鍏煎亱闁割偆鍠撻崙锟犳倵閻熺増鍟炵紒璇插暣婵＄敻宕熼姘鳖啋濠德板€愰崑鎾绘倵濮樼厧鏋ょ紒顔芥閹粙宕ㄦ繛鐐濠电偠鎻徊鍧楁偤閺冨牆鍚规繛鍡樺姈閸欏繑鎱ㄥΔ鈧悧蹇涙偩閻㈠憡鐓ユ繝闈涚墕娴狅妇鈧灚婢樼€氼厾鎹㈠☉銏犵闁圭偓鐣禒銏ゆ⒑缁洘娅旂紒缁樼箓閻ｅ嘲顫滈埀顒勩€侀弮鍫濆耿闁冲搫鍊愰敂鐣岀瘈闁汇垽娼ф禒鈺呮煙濞茶绨界€垫澘锕ョ粋鎺斺偓锝庝簽椤旀垵鈹戦悩璇у伐闁绘妫楁晥闁哄被鍎查悡銉╂煛閸モ晛浠滈柍褜鍓欑紞濠囧箖閳ユ枼鏋庨柟鎯ь嚟閸樹粙姊洪悷閭﹀殶濞村吋绻堥、鏃堝醇閻斿皝鍋撻崜浣插亾楠炲灝鍔氭い锔垮嵆閹€斥槈閵忥紕鍘撻悷婊勭矒瀹曟粌顫濇潏鈺冪効闂佸湱鍎ら弻锟犲磻閹剧粯鏅查幖绮光偓鑼晼闂備礁鎲￠敃銏＄鐠轰警娼栭柧蹇氼潐閸犲棝鏌涢弴銊ヤ航婵☆偄閰ｅ娲传閸曨剙娅ょ紓浣割儐鐢绮氭潏銊х瘈闁搞儜鍌滅倞闂備礁鎲″ú婊堝极閹间礁鑸归柣銏犳啞閻撶喖鏌ｉ弬鎸庢喐闁瑰啿鍟撮幃妤€顫濋悡搴＄缂備緡鍠栭悧蹇涘焵椤掑﹦绉甸柛瀣嚇瀹曪綀绠涢幘顖涙杸闂佺粯蓱瑜板啴寮抽悙鐑樼厪闁搞儯鍔庣粻姗€鏌嶈閸撴繈锝炴径濞掗缚绠涘☉妯碱槷閻庡箍鍎卞ú锕€鐣烽崣澶岀瘈闂傚牊渚楅崕蹇曠棯閹冩倯闁逛究鍔岃灒闁告繂瀚崐顖滅磽閸屾氨孝婵☆偅绻傞～蹇旂節濮橆剛锛滃┑鐐叉閸╁牆危椤曗偓濮婅櫣娑甸崪浣告疂缂備胶绮换鍌烆敋閿濆棛绡€婵﹩鍎甸埡鍐╁枑闊洦绋掗崕妤呮煙閸撗呭笡闁绘挻娲熼弻鐔煎箲閹邦剛姣㈠銈忚缁犳捇寮诲☉銏犖╅柨鏂垮⒔閻ゅ嫰姊虹拠鈥虫灍妞ゃ劌锕顐﹀箛椤撶喎鍔呴梺鏂ユ櫅閸熺増绂嶉鍫熲拻闁稿本鐟чˇ锔锯偓瑙勬处閸撴瑧鍙呭銈嗘尪閸ㄥ綊鎷戦悢鍏肩叆婵犻潧妫Σ鍝ョ磼椤愩垻效闁哄本鐩俊鐑筋敊閹冨紬濠电偛顕慨顓㈠疾濞戔懇鈧棃宕橀鍢壯囨煕閳╁叇姘跺箯閻熸壋鏀介柣鎰硾閻ㄦ椽鏌涢悩鏌ュ弰闁挎繄鍋犵粻娑㈠箻娴ｈ銇濇い銏℃瀹曘劑顢樺┑鍫熸毎闂傚倸鍊峰ù鍥綖婢舵劦鏁婇柡宥庡幖缁愭淇婇妶鍛櫣缂佺姷鍠栭弻銈吤圭€ｎ偅鐝栫紒鐐礃濡嫰婀侀梺鎸庣箓濞层劑骞楅崒鐐寸厱闁靛牆妫涢幊鍛磼鏉堛劌绗氱€垫澘瀚埀顒婄秵閸嬪棛绮欓崶顒佸€甸悷娆忓鐏忣參鎮楀顓熺凡妞ゎ偄绻愮叅妞ゅ繐瀚粣娑欑節閻㈤潧孝閻庢凹鍠氬Σ鎰鐎涙ǚ鎷虹紓浣割儏閻忔繈鎯侀妸鈺傜厱闁挎繂绻掗崚浼存煟閿濆洤鍘存鐐差儔閺佸啴鍩€椤掑倻涓嶅┑鐘崇閻撴盯鏌涚仦涔咁亪宕濆鍫熺厽闊洤娴风粣鏃€鎱ㄦ繝鍐┿仢鐎规洘绮撻幊鐘活敆閳ь剛鏁妷鈺傗拺闁告縿鍎辨牎濡炪們鍔岄敃顏堢嵁閸愵煈娼ㄩ柍褜鍓熼悰顔嘉熼懖鈺冿紲濠碘槅鍨堕弨杈┾偓姘冲亹缁辨捇宕掑▎鎴М濡炪倖鍨甸悧鍡涘煝閺冨牆鍗抽柣妯哄悁缁楀姊洪崫鍕潶闁稿孩鐓￠幃锟犲Ψ閿旇棄寮垮┑鈽嗗灠閻忔繈鎮￠幇鐗堢厽闁规崘娉涢弸娑㈡煛鐏炶濡奸柍瑙勫灴瀹曞崬螣閻戞﹩浠╁┑鐘殿暯閸撴繆銇愰崘顔光偓锕傛倻閽樺顔戦梺鍓插亝濞叉牠宕橀埀顒€顪冮妶鍡樺暗闁哥姵鎹囧畷銏ゅ础閻愨晜鏂€闂佺粯蓱婢х娀宕奸妷銉э紱闂佺懓澧界划顖炴偂閻斿吋鐓欓柧蹇曟嚀娴犙囨煟閿濆洦鏆╅柍褜鍓氶鏍窗濡ゅ懏鍋傞柨鐔哄Т缁犳牗绻涢崱妯诲鞍闁稿﹦绮穱濠囶敍濠婂啫浠樺Δ鐘靛仦椤ㄥ﹤顫忕紒妯诲闁惧繒鎳撶粭锟犳⒑閹稿骸鍝洪柡灞剧☉铻ｉ柤濮愬€曢埛宀勬⒑绾懏鐝紒顔芥崌閵嗕線寮崼婵嬪敹闂佺粯鏌ㄩ幖顐︾嵁閸儲鈷掑ù锝呮啞閹牓鏌涙繝鍛棄闁崇粯妫冨鎾偐閸忓摜鐟濋梻浣哄帶椤洟宕愰幇鏉跨；闁规崘鍩栭崰鍡涙煕閺囥劌澧版い锔哄妼閳规垿鏁嶉崟顐＄钵缂備緡鍠楅悷鈺呮偘椤曗偓瀹曟﹢濡搁姀锛勨偓濠氭⒑閻熸壆鎽犻柡灞诲妽缁傚秵銈ｉ崘鈹炬嫽闂佸壊鍋嗛崰鎾诲煀閺囥垺鐓欓柟缁樺笚閸熺偤鏌曢崶褍顏€殿噮鍣ｉ崺鈧い鎺嗗亾閻撱倝鏌ｉ弮鍌氬付闁藉啰鍠栭弻銊モ攽閸℃﹩妫￠梺绋挎捣閸犳牠寮婚弴锛勭杸濠电姴鍟▍姘節濞堝灝鏋涙繛灞傚€濋垾鏃堝礃椤斿槈褔骞栫划鍏夊亾瀹曞浂鍟囧┑鐘垫暩閸嬫稑螣婵犲洤鐭楅柛鎰靛枤瀹撲線鏌涢埄鍐噥婵炲矈浜弻锝夊箛闂堟稑顫╅梺鍛婃煥閹虫ê顫忓ú顏咁棃婵炴垶姘ㄩ悿鍕⒑閹肩偛濡兼い顓犲厴閵嗕礁鈻庨幘鍐插祮闂侀潧绻嗗褔骞忓ú顏呪拺闁告稑锕﹂埥澶愭煥閺囶亞鐣甸柟顖氭湰缁绘繈宕堕妸褍骞堥梻浣虹帛濮婂鈥﹂崼銉嬪鈧綆鍓涚壕鍏笺亜閺冨倹娅曢柟鍐插缁辨帞绱掑Ο鑲╃暤濡炪値鍋呯换鍫ャ€佸鈧幃鈺呭箵閹烘棏鍞堕梻鍌氬€搁崐椋庣矆娓氣偓楠炲鍩勯崘顏嗘嚌濠德板€曢幊搴ㄥ磼閵娿儙鏃堟晲閸涱厽娈梺鍝勫閸庣敻寮婚妸銉㈡斀闁糕剝顭囬ˇ閬嶆⒑缁嬫鍎愰柟鎼佺畺楠炲骞橀鑲╊槹濡炪倖甯掗崑鍡椢ｉ懜鍏哥箚闁绘劦浜滈埀顑惧€濆畷銏＄附閸涘﹤浜遍梺瑙勫婢ф宕愰崼鏇熺厱闁硅埇鍔嶅▍鍥╃磼閻樿崵鐣虹€殿喖鐖煎畷鐓庘攽閸″繑瀵栫紓鍌欑椤︿粙宕滃璺何﹂柛鏇ㄥ灱閺佸啴鏌曡箛濠冩珕闁宠鐗撳铏规嫚閳ヨ櫕鐏撻梺杞扮椤兘濡存笟鈧鎾閳╁啯鐝曢梺鑽ゅ枑閻熻京寰婇崜褉鍋撳顑惧仮婵﹥妞介幊锟犲Χ閸涘懌鍨虹换娑樏圭€ｎ偅鐝栨繛瀛樼矌椤牓鍩㈡惔銊ョ闁绘浜悷婵嬫⒒娴ｇ瓔娼愰柛搴″悑閹便劑濡舵径瀣簵闂佸搫娲㈤崹娲磹閻㈠憡鐓ユ繝闈涙椤庢顭胯閸ｏ綁寮婚敍鍕ㄥ亾閿濆骸浜為柕鍡樺浮閺屽秷顧侀柛鎾寸箞閿濈偞寰勬繛鎺戞惈椤粓鍩€椤掆偓閻ｇ柉銇愰幒鎴︽暅濠德板€曢崯顐ょ矈閿曗偓閳规垿鍩ラ崱妤冧淮闂佺顑嗛崝妤佺珶閺囥垹绀傞梻鍌氼嚟缁犳艾顪冮妶鍡欏缂侇喖娴烽弫顔尖槈濞嗗秳绨婚棅顐㈡处濞叉牠寮稿☉娆愬弿濠电姴瀚敮娑氱磼濡ゅ啫鏋涢柛鈹惧亾濡炪倖宸婚崑鎾淬亜椤撶偞绌挎い锕€婀卞褔骞樼紒妯煎帗閻熸粍绮撳畷婊冣枎閹惧磭鍘撮梺纭呮彧缁犳垿鎮橀幎鑺ョ叄闊浄绲芥禍婊呯磼閹邦厾銆掔紒杈ㄦ尰缁楃喖宕惰閻忓牆顪冮妶搴″箻闁稿繑锕㈤幃浼搭敋閳ь剙鐣烽崡鐑嗘僵闁稿繒鈷堥埀顒€娲缁樻媴閾忕懓绗￠梺鍝勮閸斿矁鐏嬪┑鐘绘涧椤戝懐绮婚弽顓熷仭婵炲棗绻愰顏勨攽椤旂晫鐭掗柡宀€鍠庨悾锟犲箥椤旀儳濮奸梻浣告啞閺屻劑骞婂Ο渚綎闁惧繐婀遍惌娆撴煕椤垵娅橀柛鏂款樀濮婃椽宕ㄦ繝鍐ｆ嫻濡炪們鍔岄悧鍡楀祫闂佸湱澧楀妯肩不閾忣偂绻嗛柕鍫濆€告禍楣冩⒑缂佹ê绗掗柣蹇斿哺婵＄敻宕熼姘鳖唺闂佺懓鐡ㄧ换宥嗙婵傚憡鈷掑ù锝囶焾閼歌绻涘顔煎籍鐎殿喖顭峰鎾偄妞嬪海鐛繝鐢靛仦閸ㄥ爼鏁冮埡浼辨椽顢橀姀鈾€鎷洪梺鍛婄☉閳洟顢旈崼婵堢枀闂佹寧绋戠€氼厼鐣烽崣澶岀闁瑰鍋熼幊鍕磽瀹ュ懏鍠橀柡灞剧洴楠炴ê螖閳ь剟骞夊☉姗嗘僵妞ゆ帒顦扮€靛矂姊洪棃娑氬濡ょ姴鎲＄粋宥咁煥閸曗晙绨婚梺鎸庢椤曆囨倶閿曞倹鐓欐い鏃€鍎虫禍鐐亜閿旀儳顣奸柟顖涙煥閳规垿宕惰椤庡繒绱撻崒姘偓鎼佸磹閻戣姤鈷旂€广儱顦崹鍌涚箾瀹割喕鎲鹃柡浣革躬閺岋繝宕橀妸褍顤€闂佹娊鏀遍崹鍦閹惧瓨濯村┑顔藉焾娴滄繈骞堥妸鈺佺倞闁靛鍊楃粻姘渻閵堝棛澧柣鏃戝墴閻擃剟顢楅崒妤€浜鹃悷娆忓缁€鍐╃箾閼碱剙鏋庢い鏇秮椤㈡岸鍩€椤掑嫬鏄ラ柍褜鍓氶妵鍕箳閹存繍浠撮梺閫炲苯澧柛鐔风摠娣囧﹪鎮滈挊澶屽幐闂佺鏈崺鍐磻閹剧粯鍊婚柤鎭掑劤閸樺崬鈹戦悙鍙夘棞婵炲瓨鑹惧嵄闁归棿鐒﹂悡娑㈡倵閿濆骸澧柍璇茬墛閹便劍绻濋崨顕呬哗闂佸憡鐗楅悧鐘差嚕閹绢喗鍋勯柛婵勫劚缁插潡姊婚崒娆掑厡妞ゎ厼鐗撻、鏍礃椤旇偐锛欏┑鐘绘涧椤戝棝宕戝Ο姹囦簻闁哄洦顨呮禍楣冩倵鐟欏嫭绀€鐎规洦鍓熼敐鐐测攽鐎ｎ亞顦ф繝銏ｆ硾缁犲秹宕濆畝鍕厴闁硅揪闄勯崑鎰亜閺冨洤浜瑰ù鐓庢搐椤啴濡舵惔鈥茬盎濡炪倧瀵岄崹鎶藉矗閸涘瓨鈷戠紓浣股戦悡銉︺亜閵娿儵顎楁い顓炴喘瀵粙顢橀悢鍝勫及闂傚鍋勫ú锕傚箰閼姐倖瀚婚柨鐔哄У閻撶喐銇勯幘璺烘灁闁瑰啿娲弻鈥崇暆閳ь剟宕伴幘璺哄灊婵炲棙鎸搁崹鍌涖亜閺囩偞鍣瑰┑锛勫厴濮婄粯鎷呴崨濠呯闂佸搫鑻ˇ鎵矉瀹ュ鏁嗛柛灞句緱濞肩喖姊虹憴鍕姢闁宦板妽閸掑﹦鈧潧鎽滅壕鍏肩箾閹寸儑渚涢柛搴＄箲缁绘盯宕奸銏犵缂備浇椴搁幐濠氬箯閸涙潙绀堥柛娆忥紞閵娾晜鈷戠痪顓炴噺閻濐亪鏌熼悷鐗堝枠妤犵偛鍟妶锝夊礃閳轰讲鍋撴繝姘厾闁诡厽甯掗崝姘归悩铏仢婵﹥妞藉畷銊︾節閸曘劍顫嶉梻浣瑰濞插繘宕愬┑瀣槬闁逞屽墯閵囧嫰骞掗幋婵冨亾閹间礁鍌ㄩ柟缁㈠枟閻撴稓鈧厜鍋撻悗锝庡墰琚︽俊銈囧Х閸嬫盯顢栨径鎰畺婵犲﹤鐗嗛獮銏＄箾閸℃绠板Δ鏃堟⒒閸屾艾鈧绮堟笟鈧獮澶愭闁圭瓔鍋婂铏规嫚閳ヨ櫕鐏堥梺绋匡攻閹倿鏁愰悙鍓佺杸闁瑰彞鐒﹀浠嬨€侀弮鍫濆窛妞ゆ牗鑹惧暩闂傚倸鍊烽懗鍓佸垝椤栫偛绀夋俊顖炴？閻掑﹥銇勮箛鎾搭棏闁稿鎸搁～婵嬵敇閻斿搫鍤掓俊鐐€ら崣鈧柛搴☆煼钘濋梺顒€绉甸悡鏇熶繆閵堝嫮顦﹂柍缁樻礈閳ь剚顔栭崰鏍€﹂悜钘夌畺闁靛繈鍊栭崑鍌炲箹鏉堝墽鎮奸柛姗嗗墮閳规垿鎮╅鑲╀紘濠电偛顦伴惄顖炪€侀弽顓炲窛闁哄鍨奸崺鐐寸節閵忥絽鐓愰柛鏃€鐗犲畷鎰版偨閸涘﹤浠┑鐐叉缁绘劙顢旈鍡欑＜闁逞屽墴瀹曞ジ濡烽敂鎯у箞闂備胶绮敋缁剧虎鍘介弲鍫曟偨閸涘﹦鍘梺绯曞墲濞叉粎绮ｉ弮鍌楀亾濞堝灝鏋熼柟姝屾珪閹便劑鍩€椤掑嫭鐓熸俊顖濆吹閸ㄥ綊鏌涢妷锝呭闁告﹢浜跺娲传閸曨剙鍋嶉梺鍛婃煥閺堫剟寮查崼鏇ㄦ晬婵犙勫劤娴滈箖鎮峰▎蹇擃仾缂佲偓閸愩劉鏀介柣鎰嚋瀹搞儲銇勯銏㈢缂佺粯绻傞～婵嬵敆閸岋妇搴婂┑鐘愁問閸犳鏁冮埡鍛婵せ鍋撶€规洘鍨块獮妯兼嫚閼碱剦鍟囧┑鐐舵彧缁蹭粙骞楀鍫熸櫖婵炲棙鎸婚埛鎴犳喐閻楀牆绗氶柨娑氬枔缁辨帡鍩€椤掍焦濯撮柛婵嗗濡粓鎮峰鍛暭閻㈩垱顨婇幃鈥斥枎閹剧补鎷婚梺绋挎湰閸戝綊宕甸悢鍏肩厱闁哄倽娉曟晥闂佸搫鏈粙鎾诲焵椤掑﹦绉靛ù婊冪埣瀹曟洟寮崼鐔哄幗闂佺懓鐏濋崯顐ｇ閹殿喒鍋撶憴鍕闁绘牕鍚嬫穱濠傤潰瀹€濠冃ユ繝纰樺墲瑜板啴鎮ц箛鏇燁潟闁圭儤顨呯粻姘辨喐瀹ュ鐓曢柡鍐ㄥ€荤壕鍏笺亜閺囩偞鍣归柣蹇ョ秮閺岀喖鐛崹顔句患闂佸疇妫勯ˇ鍨叏閳ь剟鏌ｅΟ娲诲晱闁告艾鎳忕换婵嬫偨闂堟稐绮跺┑鈽嗗亝椤ㄥ牓骞戦姀銈呯闁归箖顤傚ù鍕節闂堟稑鈧悂骞夐敓鐘茬厱闁瑰鍋熺粻楣冩煠婵傚壊鏉洪柛銈嗙懄椤ㄣ儵鎮欓幖顓熺暦闂侀潧娲ょ€氱増淇婇幖浣肝ㄦい鏍ㄧ箓閹牓鏌ｆ惔銏╁晱闁哥姵鐗犻垾锕傛倻閽樺鐎梺鐟板⒔缁垶宕戦幇鐗堢厾缁炬澘宕晶顕€鏌嶈閸撴盯宕戦妶鍜佹綎闁惧繐鍘滈崑鎾诲捶椤撶倫锝夋煏閸℃鏆ｉ柡宀嬬秮楠炴帡鎮欓悽鍨闂備浇顕栭崰妤呫€冮崼銉ョ闁绘ê妯婇崯鍛亜閺冨洦顥夐柣锔界矒濮婄粯绗熼埀顒€顭囪閹囧幢濡炪垺绋戦埢搴ㄥ箣閻樼數鍔跺┑鐘灱濞夋盯鈥﹂鈧妴鎺撶節濮橆厾鍘告繝銏ｆ硾椤戝懘鎮橀敃鍌涚厱闁绘柨鎼禒褏绱掓潏銊ョ瑨闁伙絾绻堝畷姗€顢欓崗鍏煎殘缂傚倸鍊烽懗鍓佸垝椤栨粍宕查柛顐ｇ箘閺嗭箓鏌涢锝嗙閹喖姊洪棃娑辨Ф闁搞劏顫夌粋宥嗐偅閸愨晝鍘介梺纭呮彧缁插€燁暱闂備焦濞婇弨杈╂暜閿熺姴钃熸繛鎴欏焺閺佸啴鏌曢崼婵囧櫤闁诲繋绶氬鍝勭暦閸ヨ泛鍔嗛梺绋块叄娴滃爼鍨鹃敂鐐磯闁靛绠戦弸鍌炴⒑閸涘﹥澶勯柛鎾寸洴钘濋柡澶婄氨閺€鑺ャ亜閺冨倶鈧顔忛妷鈺傜厵缁炬澘宕禍鐐烘煕濞嗗繑鍤囬柡宀嬬秮閹晜娼忛埡濠冃滅紓浣稿⒔閾忓酣宕ｉ崘顔肩疇婵°倕鎳忛幆鐐烘煕閿旇骞橀柨娑欑箖缁绘盯骞樼壕瀣棟濠电偛鐪伴崐婵嗩嚕閹间焦鍋勯柛蹇氬亹閸樹粙姊虹紒妯荤叆鐎殿喛娉涢埢宥夊川椤旇桨绨婚梺鍝勬祩娴滅偟绮欓懡銈囩＜缂備焦顭囩粻鎾淬亜椤愶絿绠炴い銏★耿閹垽宕妷銉ь槮闂傚倸鍊搁崐椋庣矆娓氣偓楠炲鏁嶉崟顐㈢亰闂佸壊鍋侀崕鏌ュ磹閸ф鐓ラ柡鍐ㄧ墛閺嗘粓鏌涚€ｎ偅宕屾俊顐㈠暙閳藉顫濋崣妯肩缂傚倸鍊峰ù鍥ㄣ仈閹间礁绠查柛銉戝懏娈鹃梺鍦劋閸ㄧ喖寮告惔銊︾厵閻庢稒顭囩粻鎾淬亜椤掆偓椤﹂潧顫忓ú顏呭癄濠㈣泛锕ュ▓缁樼箾鐎涙鐭婇柣鏍帶椤曪絾绻濆顓熸珳闂佸憡渚楁禍婵嬪棘閳ь剟姊绘担瑙勫仩闁稿孩妞介幃锟犲醇濠㈩亝鐩畷姗€濡搁姀鈩冩澑婵＄偑鍊栧濠氬Υ鐎ｎ喖缁╃紓浣姑肩换鍡涙煟閹邦垰鐓愭い銉ヮ樀閺岋綁鏁愰崶褍骞嬪銈冨灪濞茬喖寮崘顔肩劦妞ゆ巻鍋撻柡渚囧櫍濮婄粯绗熼埀顒€顭囪钘濇い鎾卞灩绾捐淇婇妶鍛櫣缂佺姵鐓￠弻锟犲炊閳轰焦鐎虹紓浣筋嚙濡繈寮婚敐澶婄疀闁稿繐鎽滈惄搴ㄦ⒑闁偛鑻晶顖炴煟濡や焦绀堥柛娆忔嚇濮婃椽骞愭惔銏㈩槬闂佺锕ラ幃鍌炲箚鐏炶娇鏃堝川椤旀儳骞堥梻渚€鈧稑宓嗘繛浣冲洤鍑犳繛鎴欏灪閻撴盯鏌涢弴妤佹珔闁告棑绠撻弻锛勪沪閻ｅ睗銉︺亜瑜岀欢姘跺蓟濞戙垹绠婚柡澶嬪灥閹藉灚绻濈喊澶岀？闁轰浇顕ч悾鐑芥偄绾拌鲸鏅┑顔斤耿绾悂宕ú顏呪拻濞达綀娅ｉ妴濠囨煕閹惧绠炲┑锛勬暬閹瑧鈧潧鎽滆ぐ楣冩⒑閸濆嫭宸濋柛鐘虫尵瀵囧焵椤掑嫭鈷戞慨鐟版搐閻忓弶绻涙担鍐叉閸欐挳姊婚崒娆掑厡妞ゎ厼鐗撻、鏍幢濞戞顔夐梺鎼炲劀鐏炲墽绋佹繝鐢靛仜濡﹥绂嶉崼鏇炴瀬闁糕剝绋掗悡鍐喐濠婂牆绀堟繛鎴炶壘閸ㄦ繈鏌￠崘銊モ偓鐢稿磻閹剧粯顥堟繛鎴炵懄閸犳劖绻涢幋鐐村碍缂佸缍婂濠氭晲閸涘倻鍠栭幊鏍煛娴ｄ警鍋ч梻鍌欒兌缁垶骞愭繝姘仭闁冲搫鎳庨拑鐔兼煟閺冨倸鍔嬮柛鐘叉閺屾盯寮撮妸銉ょ盎閻炴碍绻堝缁樻媴鐟欏嫬浠╅梺绋匡攻閻楃娀骞冮悿顖ｆЬ濠碘€冲级閸旀瑩鐛幒鎳虫梹鎷呴梹鎰潖闂佽姘﹂～澶娒洪弽顬℃椽濡舵径娑氱◤閻熸粌娴烽幑銏犫槈閵忊剝娅滈梺鍛婁緱閸犳骞冨▎鎾粹拺闁圭瀛╂径鍕瑰鍕畺缂佸矁椴哥换婵嬪炊瑜旈崬鍫曟⒑閸濆嫭宸濋柛瀣〒缁絽鈽夊鍡樺瘜闂侀潧鐗嗗Λ娆撴偂閵夆晜鐓曟慨姗嗗墻閸庢梹銇勯姀鈩冾棃闁诡喒鏅犻幃浠嬫偨绾板闂梻鍌欒兌椤牓寮甸鍕仭闁靛ň鏅╅弫濠傤熆閼搁潧濮堥柣鎾存礋閹鏁愭惔鈥茬凹閻庤娲栭惌鍌炲蓟閿涘嫪娌柛鎾楀嫬鍨辨俊銈囧Х閸嬫稑煤椤撶偟鏆︽俊銈呮噹娴肩娀鏌曟径娑氱暠闁伙箑顭峰濠氬磼濞嗘帒鍘″銈庡幖閻楁捇銆侀弽顓炲耿婵炴垶顭囬澶愭⒑閹肩偛鍔撮柛鎾村哺瀹曟垵螣濮瑰洣绨婚梺鍝勬处椤ㄥ懏绂嶆ィ鍐╁€甸悷娆忓缁€鈧紓鍌氱Т閿曨亪濡存担绯曟瀻闁圭偓娼欐禍妤呮煙閸忓吋鍎楅柛鐘愁殘缁辩偤骞樼紒妯锋嫽闂佺鏈懝楣冨焵椤掑倸鍘撮柟铏殜瀹曟粍鎷呯粙璺ㄤ喊婵＄偑鍊栭悧婊堝磻閹达箑鐒垫い鎺嗗亾闁哥喐娼欓悾鐑藉Ω閳哄﹥鏅┑鐐村灦閿氱紒銊ｅ劦濮婄粯鎷呴崫銉ㄩ梺绋款儏閿曨亜鐣峰鍐ｆ瀻闁瑰濮烽悞鎯ь渻閵堝棗濮ч梻鍕閸╂盯骞掗幊銊ョ秺閺佹劙宕ㄩ钘夋瀾缂傚倷绀侀ˇ閬嶅磿閵堝棛鈹嶅┑鐘叉祩閺佸啴鏌曡箛濞惧亾閸忓懏妯婇梻鍌欐祰椤曟牠宕板璺虹；闁靛牆顦弸渚€鏌涢幇闈涙灈缁炬儳鍚嬬换娑㈠箣閻忔槒鍋愰懞?';
  }

  return 'GPT image 2.0 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳婀遍埀顒傛嚀鐎氼參宕崇壕瀣ㄤ汗闁圭儤鍨归崐鐐烘偡濠婂啰绠荤€殿喗濞婇弫鍐磼濞戞艾骞楅梻渚€娼х换鍫ュ春閸曨垱鍊块柛鎾楀懏锛忛梺璇″瀻瀹€鈧崥瀣⒑閸濆嫮鐒跨紓宥勭窔閻涱噣宕堕澶嬫櫌婵炶揪绲块幊鎾诲礈閻㈢數纾介柛灞剧懆椤斿鏌涚€ｎ偅宕岄柡灞剧洴瀵挳濡搁妷銉ь啈闂備礁鎽滄慨鐢稿礉濞嗘挸钃熼柨婵嗘啒閺冨牆鐒垫い鎺戝閸嬪鏌涢埄鍐噮缂佺姵妫冮弻鐔兼倻濡儵鎷诲┑鈽嗗亽閸ㄥ爼寮婚悢纰辨晬闁糕剝顨堥悘閬嶆煕濮橆剦鍎旀慨濠冩そ瀹曨偊宕熼浣瑰闂備胶鍎甸弲鈺呭垂娴兼惌鏁嬮柨婵嗩槸缁犵粯銇勯弬鎸庮潔闁冲搫鎳忛悡蹇擃熆鐠団€崇仩闁稿﹤顭峰顐ｃ偅閸愨斁鎷婚梺绋挎湰閻熴劑宕楃仦淇变簻妞ゆ挾鍋熸晶锔姐亜閵忥紕澧电€规洘甯￠幃娆撴嚑椤掍胶鍙勯梻鍌欒兌缁垶鈥﹂崼銉晪鐟滄棃骞忛幋锔藉亜闁稿繗鍋愰崢鎼佹⒑閹肩偛鍔楅柡鍛洴瀵悂寮崒婊咃紲闂佺粯顭堝畷鐢告偩濞差亝鐓涚€光偓鐎ｎ剛袦濡ょ姷鍋涘ú顓炍涢崘銊㈡婵妫欏ù鍥⒒閸屾瑨鍏岀紒顕呭灣閹广垽宕橀…鎴炵稁闂佺厧顫曢崐鏍綖閺囥垺鐓欓柟顖嗗懏鎲兼繝娈垮灡閹告娊寮婚悢铏圭＜婵☆垵娅ｉ悷鎰節閵忥綆娼愭繛鑼枎椤繒绱掑Ο璇差€撴繛鎾村嚬閸ㄦ娊宕濋幖浣光拺婵炶尪顕ф晶顕€鏌曢崼銏╃劸闁伙絿鍏橀獮瀣晜閽樺鍋撻悜鑺ョ厽闁瑰浼濋鍛洸婵°倕鎳忛ˉ濠冦亜閹扳晛鐏璺哄閺岀喖宕ㄦ繝鍐ㄥ攭閻庢鍠撻崝宥囩矉閹烘柡鍋撻敐搴′簽闁告ü绮欏楦裤亹閹烘垳鍠婇梺鍛娒妶鎼佸箖濮椻偓婵＄兘鍩￠崒婊冨箞闂備胶绮ú鎴犵矆娓氣偓閹﹢鏁傞柨顖氫壕閻熸瑥瀚粈鈧梺鍝ュ枙濞夋洟宕ｉ崨顓ф富闁靛牆鎳愮粻浼存煙閾忣偄濮嶇€规洏鍨介幃浠嬪川婵炵偓瀚奸梻浣告啞缁嬫垿鏁冮敃鍌氱疇闁告劏鏂傛禍婊堟煥閺傝法浠㈢€规挸妫涢埀顒冾潐濞叉﹢宕濆▎鎾跺祦闁搞儺鍓﹂弫鍥煟閺傚灝妲诲ù鐓庨閳规垿鎮╅崹顐ｆ瘎婵犳鍠栭顓㈠焵椤掍礁鍤柛鎾跺枎閻ｅ嘲鈹戦崼姘壕闁挎繂楠搁弸鐔兼煕婵犲嫭鏆柡宀嬬秮婵偓闁靛牆妫欓柨顓㈡煟閵忊晛鐏犻柣鏍с偢瀵顓奸崶銊ョ彴闂佸搫琚崕鍗烆嚕閺夎鏃堟偐闂堟稐绮跺銈嗗灥椤︾敻鐛崘顔肩厸闁告粈鐒﹂弲鈺呮⒒閸屾艾鈧悂顢氶銏犳瀬濡わ絽鍟埛鎺楁煕鐏炴崘澹橀柍褜鍓氶幃鍌氱暦閹扮増鍊婚柤鎭掑劚濞堟垿姊洪崜鎻掍簼婵炴彃绉归崺鈧い鎺戯功閻ｇ數鈧娲滈崢褔鍩為幋锕€绠涙い鎾跺仜閸樼偤姊婚崒娆戝妽閻庣瑳鍥ц摕闁靛鍔婃禍褰掓煟閹邦喖鍔嬮柛濠傜仢閳规垿鎮╅幓鎺撴缂備胶濞€缁犳牠寮诲☉銏犵労闁稿繆鏅滈崹瑙勭閹间緡鏁囬柕蹇ョ磿閸樹粙姊洪崷顓炲妺闁搞劏顫夌粋鎺戔槈閵忥紕鍘梺鎼炲劀閸愬彞绱旀俊銈囧Х閸嬬偟鏁幒妤婃晣濠靛倻顭堥悙濠囨煠閸涘﹥娅曟繝濠傜墛閳锋帒霉閿濆洤鍔嬮柛銈傚亾闂備礁鎲￠懝楣冾敄婢舵劗宓侀柛鎰靛枛绾惧ジ鏌ｉ幇顖氳敿闁硅姤娲栭埞鎴︽倷閺夋垹浠搁梺鑽ゅ暀閸涱厼袣闂侀€炲苯澧存慨濠冩そ瀹曘劍绻濋崒姣挎洘绻涚€涙鐭岄柛瀣ㄥ€濋獮鍐锤濡も偓缁€瀣亜閺嶃劎鈻撻柟鐤缁辨捇宕掑▎鎴濆闁活亜顦辩槐鎺楀醇閺囨碍鍠氶梺鍝勬湰閻╊垶骞冮埡鍛闁圭粯甯楅幊娆撴⒒娴ｈ櫣銆婇柡鍌欑窔瀹曟垿骞橀幇浣瑰瘜闂侀潧鐗嗗Λ妤冪箔閹烘鐓ラ柡鍥朵簻椤╊剛绱掗鑺ヮ棃闁诡喕绮欏畷銊︾節閸曨偄绠為梻鍌欑劍鐎笛呮崲閸屾侗娈界紒瀣氨閺嬪秶鈧箍鍎卞ú鐘诲磻閹炬枼鏋旈柛顭戝枟閻濐噣姊虹粙娆惧剰闁挎洏鍊濋幃楣冩倻閽樺顔婂┑掳鍊撶粈渚€鍩€椤掑倸鍘撮柡灞诲€楅崰濠囧础閻愭祴鎷婚梻浣告憸閸犲骸煤椤撶儐娼栨繛宸簻娴肩娀鏌涢弴鐐典粵缁楁垿姊绘担铏瑰笡妞ゃ劌鎳庤灋婵炲棙鎸搁悿楣冩煠閸濄儲鏆╂い鈺冨厴閹鏁愭惔婵堟晼闂佷紮绲块崕銈囨崲濠靛顥堟繛鎴炃氶崑鎾诲箹娴ｅ摜鐤呴梺璺ㄥ枔婵敻宕戦崒鐐寸厽闁哄倹瀵ч幉鍝ョ磼閻樿崵鐣洪柡宀€鍠撻埀顒傛暩椤牊绂掕椤儻顧佸ù婊庝邯瀵鈽夐姀鐘电潉闂佽鍎虫晶搴ㄥ汲閵堝鈷戦柛婵嗗閻忛亶鏌涢悩宕囧⒌闁靛棔绀侀埢搴ㄥ箻閺夋垳绨甸梺纭呭亹鐞涖儵骞婇敐澶婄厸濞撴艾娲︾€靛矂姊洪棃娑氬濡ょ姵鎮傞悰顕€骞嬮敂鐣屽幈闂佸搫鍟犻崑鎾绘煕閵娧勬毈闁诡噣绠栭幃婊堟寠婢光斁鏅犻弻宥夊传閸曡埖鏁鹃梺鍝勬嫅缂嶄線骞冨畡閭︾叆闁告劦鍣埀顒侇殘閹喖鈻庤箛锝囧數闂佸吋鎮傚褎鎱ㄩ崼銉︾厓闂佸灝顑呯粭鎺楁婢舵劖鐓ユ繝闈涙閸ｆ椽鏌涢悢鍝勪槐闁诡喖缍婇獮鍥Ω閵夈儮鎷ら梻渚€娼уú銈団偓姘嵆閵嗕礁顫滈埀顒勫箖濞嗘挻顥堟繛鎴炲笒瀵板秴鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬⒑閻熸澘鈷旂紒顕呭灦瀹曟垿骞囬悧鍫㈠幘缂佺偓婢樺畷顒佹櫠椤栫偞鐓熼柟鍨缁夘喗鎱ㄦ繝鍕笡闁瑰嘲鎳愮划娆忊枎閻愵剦妫忛梻鍌欒兌椤牓顢栭崨鏉戠疇閹艰揪绲藉鍙夌節濞堝灝鏋熼柕鍥ㄧ洴瀹曟垿骞橀崹娑樹壕閻熸瑥瀚粈鍐煕閵娿儲鍋ラ柣娑卞櫍瀹曞爼顢楁担闀愮綍闂備礁澹婇崑鍛崲閳ь剟鏌涢弽銊у⒌婵﹦绮幏鍛喆閸曨偂鍝楅梻浣侯焾濞寸兘宕曢妶鍥╃焿鐎广儱鎷嬮悡銉╂煕椤愩倕鏋庨柛鎿冨弮濮婅櫣绱掑Ο铏逛桓闁煎灕鍏犵懓顭ㄩ崟顓犵厜闂佸搫鐭夌换婵嗙暦閹烘垟鏀介柛銉㈡杺閳ь剙锕铏圭磼濡櫣鐟ㄩ梺纭咁嚋缁绘繈鐛崼銉ノ╅柨鏂垮⒔閻﹀牓姊洪幖鐐插姉闁哄懏绻勭划锝呂旈崨顔规嫼闂傚倸鐗婄粙鎺撳緞閸曨垱鐓曢柡鍐ｅ亾闁荤啿鏅犻幃浼搭敋閳ь剟鐛幒鎳虫棃鍩€椤掑倻涓嶉柨婵嗘缁♀偓婵犵數濮撮崐鎼佸汲閻愮儤鐓熼幖娣灩閳绘洘鎱ㄦ繝鍌ょ吋鐎规洘甯掗埢搴ㄥ箣椤撶啘婊堟⒒娴ｄ警鏀板┑顔哄€楅崚鎺戭吋婢跺﹦鐤勯梺闈浥堥弲婊堝磻閵娧呯＜閻庯綆鍘界涵鑸点亜閺傛寧鍠樻慨濠冩そ閹剝鎯旈鐣岀◥闂備胶顭堥敃銉┿€冩繝鍥х畾閻忕偞鍎崇欢鐐烘煙闁箑骞橀柛妯兼暬濮婅櫣绱掑Ο铏逛桓闂佹寧宀搁弻锝堢疀閹剧紟锝吳庨崶褝韬鐐存崌楠炴帡寮惔鎾冲緧闂傚倷绀侀幖顐﹀嫉椤掆偓鐓ゆ繝闈涚墢娑撳秵绻涢幋鐐垫噮缂佺娀绠栭弻鐔碱敍閸℃鈧悂藟濮樿埖鈷掑ù锝勮閻掑墽绱掔紒妯哄妤犵偛锕ラ幆鏃堟晲閸屾矮澹曢梺鍓茬厛閸嬪棝宕ｉ埀顒€鈹戦纭峰伐妞ゎ厼鍢查悾鐑藉箳閹存梹鐎婚梺鐟扮摠缁诲倿鈥栨径鎰拻濞达絿鐡旈崵鍐煕閻樺磭澧甸柟顔哄劦閹剝鎯旈敐鍡橆啎闂備礁鎼ú銊╁磿閹扮増鍋傞柕澶嗘櫆閻撴洘銇勯幇鍓佹偧缂佺姵鎸剧槐鎺楀箛椤撶姵鍒涘┑顔硷攻濡炶棄鐣烽妸锔剧瘈闁告洦鍘鹃崢鎰版⒒娴ｅ憡鎲搁柛鐘冲姈缁旂喖宕卞▎蹇撶亰闂佸搫鍟悧婊堝极鐎ｎ喗鐓冪憸婊堝礈閻斿鍤曞┑鐘崇閺咁剟鏌涢弴銊ょ凹闁告洖鍟村娲川婵犲啫鐦烽梺鍛婃处閸嬪嫰鎮橀埄鍐瘈闁汇垽娼у暩濡炪倧绲肩划娆忕暦濠婂啠鏀介悗锝庝簽閻ｆ椽姊虹粙璺ㄧ伇闁稿鐩鍛婄瑹閳ь剟寮婚悢鍏煎亱闁割偆鍠撻崙锟犳倵閻熺増鍟炵紒璇插暣婵＄敻宕熼姘鳖啋濠德板€愰崑鎾绘倵濮樼厧鏋ょ紒顔芥閹粙宕ㄦ繛鐐濠电偠鎻徊鍧楁偤閺冨牆鍚规繛鍡樺姈閸欏繑鎱ㄥΔ鈧悧蹇涙偩閻㈠憡鐓ユ繝闈涚墕娴狅妇鈧灚婢樼€氼厾鎹㈠☉銏犵闁圭偓鐣禒銏ゆ⒑缁洘娅旂紒缁樼箓閻ｅ嘲顫滈埀顒勩€侀弮鍫濆耿闁冲搫鍊愰敂鐣岀瘈闁汇垽娼ф禒鈺呮煙濞茶绨界€垫澘锕ョ粋鎺斺偓锝庝簽椤旀垵鈹戦悩璇у伐闁绘妫楁晥闁哄被鍎查悡銉╂煛閸モ晛浠滈柍褜鍓欑紞濠囧箖閳ユ枼鏋庨柟鎯ь嚟閸樹粙姊洪悷閭﹀殶濞村吋绻堥、鏃堝醇閻斿皝鍋撻崜浣插亾楠炲灝鍔氭い锔垮嵆閹€斥槈閵忥紕鍘撻悷婊勭矒瀹曟粌顫濇潏鈺冪効闂佸湱鍎ら弻锟犲磻閹剧粯鏅查幖绮光偓鑼晼闂備礁鎲￠敃銏＄鐠轰警娼栭柧蹇氼潐閸犲棝鏌涢弴銊ヤ航婵☆偄閰ｅ娲传閸曨剙娅ょ紓浣割儐鐢绮氭潏銊х瘈闁搞儜鍌滅倞闂備礁鎲″ú婊堝极閹间礁鑸归柣銏犳啞閻撶喖鏌ｉ弬鎸庢喐闁瑰啿鍟撮幃妤€顫濋悡搴＄缂備緡鍠栭悧蹇涘焵椤掑﹦绉甸柛瀣嚇瀹曪綀绠涢幘顖涙杸闂佺粯蓱瑜板啴寮抽悙鐑樼厪闁搞儯鍔庣粻姗€鏌嶈閸撴繈锝炴径濞掗缚绠涘☉妯碱槷閻庡箍鍎卞ú锕€鐣烽崣澶岀瘈闂傚牊渚楅崕蹇曠棯閹冩倯闁逛究鍔岃灒闁告繂瀚崐顖滅磽閸屾氨孝婵☆偅绻傞～蹇旂節濮橆剛锛滃┑鐐叉閸╁牆危椤曗偓濮婅櫣娑甸崪浣告疂缂備胶绮换鍌烆敋閿濆棛绡€婵﹩鍎甸埡鍐╁枑闊洦绋掗崕妤呮煙閸撗呭笡闁绘挻娲熼弻鐔煎箲閹邦剛姣㈠銈忚缁犳捇寮诲☉銏犖╅柨鏂垮⒔閻ゅ嫰姊虹拠鈥虫灍妞ゃ劌锕顐﹀箛椤撶喎鍔呴梺鏂ユ櫅閸熺増绂嶉鍫熲拻闁稿本鐟чˇ锔锯偓瑙勬处閸撴瑧鍙呭銈嗘尪閸ㄥ綊鎷戦悢鍏肩厸闁搞儮鏅涢弸搴ｇ磼閸撲礁浠︾紒缁樼洴楠炲鎮滈崶锔捐繑婵犵數鍋涘Ο濠囧矗閸愵煈娼栨繛宸簻瀹告繂鈹戦悙鏉戜刊濞存粍绮撻幃楣冩倻缁涘鏅㈤梺鍛婃处閸嬪棝宕㈤幘顔解拺缁绢厼鎳忚ぐ褔姊婚崟顐㈩伃鐎规洘鍔欓幃婊堟嚍閵壯冨箰濠电姰鍨煎▔娑㈩敄閸涘瓨鍊堕柍杞版€ヨぐ鎺撳亹闁惧浚鍋勯埀顒佸姈閹便劍绻濋崘鈹夸虎闂佸湱顒茬换婵囦繆閸洖宸濇い鏃堟暜閸嬫捇顢橀姀鈾€鎷虹紓浣割儐鐎笛囧箲閿濆鐓涘ù锝呭閻撳ジ鏌ｅ☉鍗炴珝鐎规洘锕㈡俊鍛婃償閿濆懏鐏堥梺鍦劜缁绘繃淇婇崼鏇炵倞闁冲搫鍋嗗鎾绘⒒閸屾艾鈧兘鎮為敃鍌氱畺闁割偅娲栫壕鎸庛亜閺嶎偄浠滅紒鈧径鎰婵烇綆鍓欐俊濂告煕鐏炶濡奸摶鏍煥濠靛棙鍣归柡鍡欏仱閺屽秹鏌ㄧ€ｎ亞浼岄梺鍝勬湰閻╊垶鐛鈧幃鐑藉箥椤旂瓔鍤勯梻鍌欑閹猜ゆ懌闂佺儵鏅╅崹璺侯嚕鐠囨祴妲堟慨姗堢到娴滈箖鏌ㄥ┑鍡欏嚬缂併劎绮妵鍕疀閿濆懎绫嶉梺鍝勭灱閸犳牠銆佸▎鎾虫闁靛牆鐗冮崑鎾诲锤濡や胶鍘告繛杈剧悼椤牓鍩€椤掆偓閻忔繈鎮惧畡閭︾叆闁糕檧鏅滈瀷闂傚倷鐒︾€笛呯矙閹烘柨鍨濋柟鐐墯濞兼牠鏌ц箛鎾磋础闁活厽鐟╅弻鐔虹矙閸噮鍔夐梺鐟板槻瀹曨剟鍩為幋锔绘晩閻熸瑦甯楃划鎾崇暦濠靛棭鍚嬪璺猴功閺屟囨⒑闂堟侗妲撮柡鍛矒閹繝鎮㈤悡搴ｎ啇濠电儑缍嗛崜娆撳焵椤戞儳鈧洟鈥﹂崶顒€绠涙い鎾跺Х椤旀洟姊洪崨濠勬噧妞わ箒椴搁弲鍫曨敂閸喓鍘介梺鎸庣箓濞层倝宕㈢€涙ǜ浜滈柕蹇婃濞堟粎鈧娲橀敃銏ゃ€侀弮鍫濈妞ゅ繐娲ら崢顓㈡⒒閸屾艾鈧悂宕愰幖浣哥９濡炲瀛╅鑺ユ叏濡寧纭鹃柣鎺戠仛閵囧嫰骞掗幋婵冨亾閸涘﹦顩锋繝濠傜墛閻撶姵绻涢懠棰濆殭闁诲骏绻濋弻锟犲川椤撶儐鏆㈤梺閫炲苯澧伴柡浣告憸濞戠敻宕奸弴鐐碉紱闂佸湱鍋撻弸濂稿几閺冨牊鐓曟い顓熷灥閺嬬喖鏌ｅ┑鎰珝婵﹨娅ｇ划娆忊枎閹冨闂備焦瀵уú蹇涘磹濠靛绠栧Δ锝呭暞閻撱儵鎮楅敐搴″⒋婵＄虎鍠氱槐鎾存媴閸撴彃鍓伴梺璇茬箲缁诲倿鎮鹃悽绋垮耿婵炴垶鐟㈤幏铏圭磽閸屾瑧鍔嶉拑閬嶆煟閹惧崬鍔﹂柡宀嬬秮婵℃悂鏁傞崜褏鏉介柣搴ゎ潐濞叉﹢宕归崸妤冨祦婵☆垵鍋愮壕鍏间繆椤栨繃銆冪紓鍌涙崌濮婄粯鎷呴崨濠傛殘缂備礁顑嗛崹鍧楀极閸愵喗鏅濋柛灞捐壘閸嬪秹姊绘笟鍥у缂佸鏁婚崺娑㈠箣閿旂晫鍘电紓浣割儏閻忔繈顢楅姀掳浜滈柕澶堝劜椤ョ偤鏌曢崶褍顏€殿喗鎸冲畷鍗炍旀担鍝ョ崺闁诲氦顫夐幐鐑芥倿閿旂晫鈹嶅┑鐘叉搐鍥撮梺鍛婁緱閸犳牕鈻嶉妶澶嬧拺缂備焦蓱鐏忕増绻涢懠顒€鏋涚€殿喖顭峰鎾閻樿鏁规繝鐢靛█濞佳兾涘畝鍕；闁规崘顕у婵嗏攽閻樻彃顏存繛鍙夋倐濮婅櫣鎷犻垾宕団偓濠氭煃瑜滈崜鐔奉嚕閵婏妇顩烽悗锝庡亞閸欏棗鈹戦悙鏉戠仸闁挎碍銇勮箛濠冩珔闂囧绻濇繝鍌氭殧闁稿鍨介弻锛勪沪閸撗€濮囩紓浣虹帛缁诲牆鐣峰鈧、鏃堝礋閵婏箑顏繝寰锋澘鈧鎱ㄩ悜钘夌；闁绘劕鎼粈澶愭煛瀹ュ骸浜濈€规洖寮剁换婵嬫濞戞瑱绱炲┑鐐茬毞閺呮粓濡甸崟顖氱闁瑰瓨绺鹃崑鎾寸節濮橆剚杈堝銈嗗姧闂勫嫰鍩涢幒鎳ㄥ綊鏁愰崟顕呭妳闂佺粯甯＄粻鏍蓟閿熺姴閱囨い鎰╁灩閳峰鎮楃憴鍕闁荤喆鍔戞俊鐢稿箛閺夎法顔婇梺鐟扮摠缁诲啴宕曢鍫熲拻濞达絽鎲￠幆鍫熺箾鐏炲倸濡介悗鐢靛帶閳规垶绻涙径鍛婄潖闂備礁婀遍崕銈夊箰閸涘﹦顩茬憸鐗堝笚閸婄敻鏌ｉ悢鍛婄凡妞ゃ儱绻橀弻娑㈡偐瀹曞洤鈷岄悗瑙勬礃缁挸鐣烽敓鐘冲€婚柛鈩兠惁婊堟⒒娓氣偓濞佳囨偋閸℃稑鐤い鎰剁畱缁€澶嬫叏濡灝鐓愰柣鎾跺枑娣囧﹪濡堕崟顓炲閻庤娲栭惉濂稿焵椤掍緡鍟忛柛鐘崇洴椤㈡俺顦规い銏★耿瀹曟鎮℃惔锝囩嵁濠电姷鏁告慨鎶芥嚄閸洘鍊峰┑鐘叉处閳锋帒霉閿濆懏鍟為柛鐔哄仦缁绘稓鎷犺閻ｇ數鈧娲橀崹鍨暦閵娾晩鏁囨繛鎴炵懅娴滄牠姊洪懡銈呅俊妞煎妿閹峰啴鏁冮埀顒勫Υ閹烘挾绡€婵﹩鍘鹃崢顏堟⒑閸撴彃浜濈紒璇插缁粯瀵肩€涙鍘介梺鎸庢⒒閺咁偊鎯岄幒妤佺厸閻忕偛澧藉ú鎾煛娴ｇ懓濮岀紒鐘崇洴瀵挳鎮欓懠顒€甯撴繝纰夌磿閸嬫垿宕愰妶澶婄；闁告洦鍘藉畷鏌ユ煙闁箑鏋涚€殿喖寮舵穱濠囨倷椤忓嫧鍋撻弴鐘冲床闁归偊鍠掗崑鎾愁潩闂傚鏁栧┑鈥冲级閸旀瑥鐣锋總绋垮嵆闁绘柨寮剁€氬ジ姊绘担鍛婂暈缂佸鍨块弫鍐Ψ閿曗偓缁剁偤鏌涢弴銊ョ仭闁绘挻娲熼幃妤呮晲鎼存繄鍑归梺闈╃到缂嶅﹪寮诲鍥╃＜婵☆垵顕х壕鎶芥⒑绾懏鐝紒顔芥崌楠炲啯绂掔€ｎ偄浠洪梺姹囧灩閻忔岸锝炵仦瑙ｆ斀闁绘ê鐏氶弳鈺呮煕鐎ｎ偆娲撮柟顔ㄥ洤骞㈡繛鎴炵懃閳ь剝鍩栫换婵嬫濞戝崬鍓伴梺鍛婂灩婵炩偓闁哄本娲熷畷鐓庘攽閹邦厜褔姊虹紒妯诲鞍缂佸鍨垮﹢渚€姊洪幐搴ｇ畵閻庢凹鍨堕、妤呮偄閸忚偐鍘介梺鍦劋椤ㄥ牓鎮惧ú顏呯厸閻忕偟鏅晥闂佸湱顭堥敃銉ヮ嚗閸曨倠鐔兼倻閳哄倻鈧即姊婚崒娆愮グ妞ゆ洘鐗犲畷鏉款潩鐠鸿櫣鏌у銈嗗姂閸婃洟宕瑰┑鍥╃闁糕剝蓱鐏忣參姊虹憗銈呪偓鏍ㄧ┍婵犲洤围闁稿本鐭竟鏇㈡⒒娴ｈ姤銆冪紒鈧担铏圭濠电姴鍋嗗鏍磽娴ｈ偂鎴炲垔閹绢喗鐓曟繛鎴烇公閺€濠氭煕鎼淬垺灏柍瑙勫灴閹瑩鎳犻浣稿瑎闂備礁鎲″褰掑垂閻㈠憡鍋╅柣鎴ｅГ閸嬪鏌涢銈呮瀻闁告柨鎳樺娲濞戞氨鐤勯梺绯曟櫅鐎氼剟婀侀梺鍛婃处閸嬧偓闁衡偓娴犲鐓熼柟閭﹀墮缁狙囨煃缂佹ɑ绀€闂囧绻濇繝鍌氼伀缂佺姷鍋ら弻娑㈠煛閸屾粍鍒涘Δ鐘靛仜椤戝骞冮埡鍛仺缁炬澘顦遍梻顖涚節閻㈤潧浠╅柟娲讳簽缁辩偤鍩€椤掑嫭鐓曢悗锝庝簻閳ь剙娼￠悰顔锯偓锝庡枟閺呮繈鏌嶈閸撶喖骞冮敓鐘插嵆闁靛骏绱曢崢鐢告⒑缂佹ê鐏﹂拑閬嶆倶韫囷絼绨婚棁澶嬬節婵犲倸顏柣顓烆儔閺屾洟宕惰椤忣厽顨ラ悙鎼劷闁圭懓瀚顏堟偋閸繄鍘卞┑鐘垫暩婵參骞忛崘顭戝悑闁搞儮鏅滃▓濂告⒒娴ｅ憡鎯堥柣顒€銈稿畷浼村冀椤撴壕鍋撴担绯曟瀻闁规崘娅曢ˉ婵嬫⒑闂堟稓澧曢柣妤€鍟村畷鎴﹀箻閼搁潧纾梺闈涱焾閸ㄨ绂嶆ィ鍐╁仭婵炲棗绻愰顏嗙磼閳ь剟鍩€椤掑嫭鈷戠紓浣诡焽婢ь亪鏌曢崼鐔稿€愬┑鈥崇摠閹峰懘鎳栧┑鍥ㄢ拹闁瑰嘲鎳橀幃鐑芥焽閿旂懓浜鹃柟鍓х帛閳锋垿鏌涘☉姗堝姛缂佺姵鎹囬幃妤€顫濋悡搴☆潽婵烇絽娲ら敃顏勭暦閸洦鏁嗗ù锝呭级鐎氫粙姊绘担渚劸闁哄牜鍓熼幃鐑藉Ω閳轰胶顦ч悗鍏夊亾闁逞屽墴閹偓妞ゅ繐鐗滈弫鍥煟閹扮増娑ч柣鎾跺枛閹鎲撮崟顒傤槰缂備緡鍠栭惌鍌炲春閻愬搫绠ｉ柣姗嗗亜娴滈箖鏌ㄥ┑鍡楁殭濠碉紕鍏橀弻娑氣偓锝庡亝瀹曞瞼鈧娲橀敃銏ゃ€佸▎鎾村亗閹艰揪绲垮畷娲⒒閸屾瑧顦﹂柟纰卞亰钘濆ù鍏兼綑閸ㄥ倻鎲搁悧鍫濈瑨缂佲偓婢舵劖鐓ラ柡鍥殔娴滄儳顪冮妶搴濈盎闁哥喎鐡ㄦ穱濠囧醇閺囩偛鑰垮┑掳鍊曢崯鈺冩濡崵绡€闁汇垽娼ф禒婊勩亜閿旇姤绶查悡銈夋煟閺冨倸甯剁紒鐘冲哺閹﹢鎮欑紓搴㈠浮瀵憡鎯旈妸锔惧幍闂侀€涚祷濞呮洖鈻嶉崘顏嗙＜闁靛鍎洪悡鍏兼叏婵犲啯銇濇俊顐㈠暙閳藉顫濇潏鈺傛瘞闂傚倷绶氶埀顒傚仜閼活垱鏅堕鈧弻娑㈡偄闁垮浠村Δ鐘靛仦椤ㄥ﹤螞閸愩劉妲堥弶鍫涘妼閻︽粓姊绘笟鈧褔鎮ч崱娑樼柈妞ゆ劧闄勯崐鑸点亜韫囨挻鍣峰ù婊勭矒閺屾洘绻涢崹顔煎Х閻庤鎮堕崕鐢稿蓟閿濆鏅查柛銉戝啫绠ｆ俊銈囧Х閸嬬偟鏁敓鐘靛祦閻庯綆鍠栫猾宥夋煃瑜滈崜鐔兼晲閻愬樊鍚嬮柛娑变簼閺傗偓婵＄偑鍊栧濠氭偤閺傚簱鏋旈柡鍐ｅ亾濞ｅ洤锕、鏇㈡晲閸♀晜顥堟俊銈囧Х閸嬫盯宕幘顔兼瀬闁归偊鍘肩欢鐐烘倵閿涘崬瀚娲⒒閸屾瑨鍏屾い顓炵墦瀵敻顢楅崟顒€浠悷婊勬濡喖姊洪幐搴㈢闁稿﹤缍婇幃鈥斥枎閹炬潙浠梺鎼炲劚濞层倝骞婇幇鐗堝剨闁割偁鍎查崐鐢告偡濞嗗繐顏紒鈧崘顏嗙＜閻犲洤寮堕ˉ鐘电磼椤旀鍤欓柍钘夘槸铻ｉ梺鍨儛濞兼梹绻濈喊妯活潑闁搞劋鍗冲畷銉р偓锝庡枟閸嬪倿鏌ㄥ┑鍡橆棤缂佲檧鍋撻梻浣圭湽閸ㄨ棄顭囪閻☆參姊绘担鐟邦嚋婵炴彃绻樺畷鎰攽閸℃瑦娈惧銈嗙墱閸嬬偤宕戦幇鐗堝仯闁搞儯鍔岀徊濠氭煕閵堝棗鐏存慨濠冩そ瀹曨偊宕熼鐔蜂壕闁告縿鍎存慨鎶芥⒑椤掆偓缁夊绱掗埡浼卞綊鎮╁顔煎壉闂佺粯鎸鹃崰鎰┍婵犲浂鏁嶆繝闈涙祩娴犫晠姊洪幐搴ｂ槈缂佸鏁绘俊鐢稿礋椤栨稒娅滈梺绯曞墲閻熴儱顕ｉ妸鈺傗拺闁告繂瀚悞璺ㄧ磽瀹ュ嫮绐旈柣娑卞枛铻ｉ悘蹇旂墪娴滅偓绻涢幋鐐垫噽闁绘帟濮ら妵鍕晜閸喖绁┑顔硷攻濡炶棄鐣烽锕€绀嬫い鎾跺С缁辨﹢姊绘担鍛婃喐濠殿喚鏁婚幃褔鎮╁顔兼婵犵數濮甸懝楣冩倷婵犲啨浜滈柟鍝勭Ф閸斿秵绻涢崨顓熷枠婵﹥妞介弻鍛存倷閼艰泛顏繝鈷€灞界仸闁哄矉绻濆畷銊╊敇閻樿尙鍘芥俊鐐€戦崹娲儎椤栫偛绠栨繛鍡樺灍閸嬫捇鎮藉▓璺ㄥ姼濡ょ姷鍋涢悧鎾愁潖缂佹ɑ濯撮柣鐔煎亰閸ゅ绱撴担绛嬪殭闁稿﹤娼￠獮鍐槻妞ゎ厹鍔戝畷姗€宕滆婵椽姊绘担绛嬫綈濠㈢懓妫欓弲璺何旈崨顔间簵闂婎偄娲︾粙鎺楁偂閺囥垺鐓忓璺侯儏閻忋儵鏌涢悩宕囶暡閻庨潧銈稿畷姗€顢欓挊澶嗗亾閸偆绠鹃柛顐ｇ箘娴犮垺绻涢崨顕嗚€块柡灞剧洴閺佹劘绠涢弴鐘樻粓鎮楃憴鍕婵＄偘绮欏畷娲焵椤掍降浜滈柟鍝勭Ч濡惧嘲霉濠婂嫮鐭掗柡宀€鍠栭幃婊兾熼搹閫涙樊婵＄偑鍊曠换鍡涘疾濠靛牊顫曢柟鐑橆殔閻掑灚銇勯幒宥囶槮缂佸墎鍋ら幃妤呮晲鎼粹€愁潾濡炪倖姊瑰ú鐔奉潖閾忕懓瀵查柡鍥╁仜閳峰顪冮妶鍐ㄥ闁绘绻掗崚鎺撶節濮橆剛顔呴梺鍏间航閸庢娊宕㈤幖浣光拺缂侇垱娲橀～濠囨煕濮椻偓缁犳牠骞冩ィ鍐╁仺闁告稑锕﹂崢鎼佹煟韫囨洖浠ч柛瀣尵缁牓宕橀浣镐壕闁割煈鍋呯欢鏌ユ倵濮樼厧澧撮柛鈹垮劜瀵板嫰骞囬澶嬬秱闂備礁鐤囧Λ鍕涘畝鍕；闁圭偓鍓氶崥瀣熆鐠轰警鍎岄柟鐤缁辨挻鎷呴崜鎻掑壉闁诲海鐟抽崶褏顔夐梺鎸庣箓椤︿即鎮￠弴銏＄厽婵☆垵娅ｉ敍宥咁熆瑜忛弫鎼佸焵椤掍緡鍟忛柛鐘崇洴椤㈡俺顦规い銏★耿瀹曟鎮℃惔锝囩嵁濠电姷鏁搁崕鎰焽閸ф绀夐柟杈剧畱閽冪喖鏌￠崶鈺佹灁缂佲檧鍋撻梻濠庡亜濞诧箓骞栭埡浼辨椽顢橀姀鈥充画濠电姴锕ょ€氼剚鍎梻浣告啞閸斞呭緤妤ｅ啫妫橀柍褜鍓熷缁樻媴閾忕懓绗￠梺鍛婃⒐濞叉牠顢氶敐澶婇唶闁哄洨鍋ゅΛ鐑芥偡濠婂懎顣奸悽顖涱殜閹繝寮撮姀锛勫幗闂佸搫鍊圭€笛囧疮閻愮儤鍊堕煫鍥ュ劚椤╊剟鏌嶈閸撴岸顢欓弽顓炵獥闁哄稁鍘搁埀顒婄畵閹粓鎸婃径瀣偓顒勬⒑瑜版帒浜伴柛妯垮亹濞嗐垽鎮欓悜妯衡偓鐢告煥濠靛棛鍑圭紒銊╂敱閹便劎鎲撮崟鍨杹濠殿喖锕︾划顖炲箯閸涙潙宸濆┑鐘插€瑰▓姗€姊绘担钘夊惞闁哥姴妫濆畷鏇熸媴閸愨晩妫ㄥ┑锛勫亼閸婃牠鎮у鍫濈９婵炴垯鍨归悙濠冦亜閹哄棗浜鹃梺缁樻尰缁嬫垿婀侀梺鎸庣箓閹冲海鐥閺岋繝宕掑Δ鈧禍楣冩⒒閸屾艾鈧兘鎳楅崜浣稿灊妞ゆ牜鍋涚粈澶愭煛瀹擃喖鐬奸崝宄扳攽閻愬弶顥為柛銊ф暩濞嗐垽濡舵径瀣幘婵犳鍠楅崝鏇㈠焵椤掍緡娈樺瑙勬礋閹虫牠鍩￠崘顏庣闯濠电偠鎻徊鍨枍閵忋倕绀傛い鎺戝閻撶娀鏌熷畡鐗堟拱缁绢厼鐖奸弻宥堫檨闁告挻绻堥敐鐐村緞婵炴帒鎼灒濞撴凹鍨辩€靛本绻涚€电孝妞ゆ垵鎳樺浼村Ψ閳哄倻鍘?';
}

function errorMessageFrom(error) {
  const payload = error?.response?.data;
  const parsedPayload =
    (payload && typeof payload === 'object' ? payload : null) ||
    parseEmbeddedJson(typeof payload === 'string' ? payload : '') ||
    parseEmbeddedJson(error?.message || '');
  const rawMessage = [
    typeof payload === 'string' ? payload : '',
    typeof parsedPayload?.detail === 'string' ? parsedPayload.detail : '',
    typeof parsedPayload?.message === 'string' ? parsedPayload.message : '',
    typeof parsedPayload?.error?.message === 'string' ? parsedPayload.error.message : '',
    error?.message || ''
  ].filter(Boolean).join(' ');

  if (parsedPayload?.error?.code === 'invalid_api_key') return 'OpenAI API key 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閹冣挃闁硅櫕鎹囬垾鏃堝礃椤忎礁浜鹃柨婵嗙凹缁ㄥジ鏌熼惂鍝ョМ闁哄矉缍侀、姗€鎮欓幖顓燁棧闂備線娼уΛ娆戞暜閹烘缍栨繝闈涱儐閺呮煡鏌涘☉鍗炲妞ゃ儲鑹鹃埞鎴炲箠闁稿﹥顨嗛幈銊╂倻閽樺锛涢梺缁樺姉閸庛倝宕戠€ｎ喗鐓熸俊顖濆吹濠€浠嬫煃瑜滈崗娑氭濮橆剦鍤曢柟缁㈠枛椤懘鏌嶉埡浣告殲闁绘繃鐗犲缁樼瑹閳ь剟鍩€椤掑倸浠滈柤娲诲灡閺呭爼骞橀鐣屽幍濡炪倖鏌ㄩ崥瀣磻閵夛负浜滈柕蹇娾偓鍐叉懙闂佺硶鏂侀崑鎾愁渻閵堝棗绗掗悗姘煎墴閹锋垿鎮㈤崗鑲╁弳濠电娀娼уΛ娆撳疮閹烘鐓涢柛鎰╁妿婢ф洟鏌ｉ幒鎴犱粵闁靛洤瀚伴獮鎺楀箣濠垫劒鐥梻浣侯焾椤戝懘顢栭崨鏉戠厴闁硅揪闄勯崑鎰版煕濞嗗浚妲归柟顔界懇濮婂搫煤鐠囨彃绠哄銈冨妼閿曨亪骞冮敓鐙€鏁冮柨鏇楀亾闁绘劕锕弻鏇熺箾瑜夐崑鎾斥攽椤斿吋鍠樻慨濠呮缁辨帒螣鐠囧弶娈梻浣告憸婵敻鎮ч悩宸殨濠电姵鑹鹃崡鎶芥煥濞戞ê顏柡澶嬫倐閺岋絾鎯旈婊呅ｆ繛瀛樼矌閸嬨倕鐣峰┑瀣妞ゆ棁袙閹疯櫣绱撻崒娆戝妽闁挎碍绻涢幖顓炴灓缂佽鲸甯￠幃鈺佺暦閸パ€鎷伴柣搴㈩問閸犳牠鈥﹂悜钘夋瀬闁归偊鍘肩欢鐐测攽閻愨晜濯伴柛鎰⒔閸炵敻鏌ｉ悩鑽ょ窗婵炲拑缍侀幃姗€鏌嗗鍡欏幐闂佺硶妾ч弲娑欑閻楀牊鍙忓┑鐘插暞閵囨繄鈧娲﹂崑濠傜暦閻旂⒈鏁嗗ù锝囨嚀椤忔澘鈹戦悩鍨毄闁稿绋戦锝夊醇閺囩喐娅斿┑锛勫亼閸婃牕煤韫囨稑纾块梻鍫熺〒閺嗭箓鏌ｉ弮鍌楁嫛闁轰礁绉甸幈銊ヮ潨閸℃鈷夐梺閫炲苯澧柣蹇旂箞閸╃偤骞嬮敃鈧悡锟犳煕閳╁喚娈樺ù鐘虫尦閹鎲撮崟顒傦紱缂備焦褰冮…閿嬩繆閻㈢绠涢柡澶婄仢閼板灝鈹戦悙鏉戠仸闁荤喆鍨介獮蹇曠磼濡偐顔曢柡澶婄墕婢т粙宕氭导瀛樼厵閻犲泧鍛槇濡ょ姷鍋涘Λ婵嗙暦婵傜唯闁挎梹鍎抽獮宥夋煟鎼达絾鍤€閻庢矮鍗冲畷鎴炵節閸パ咃紵闂佸搫鍟崐鐢稿磻閹捐埖鍠嗛柛鏇ㄥ墰椤︺劎绱撴笟鍥ф灈闁活厼鍊垮畷娲Ψ閿曗偓缁剁偤鏌熼柇锕€澧绘繛鐓庯躬濮婅櫣绱掑鍫ｂ偓鎸庣箾娴ｅ啿瀚崣蹇涙煥閺冣偓閸ㄦ繄鎹㈤崱娑欑厽闁规澘鍚€缁ㄥ鏌嶈閸撴岸鎮ч弴銏╂晩闊洦姊荤弧鈧┑顔斤供閸撴盯鏁嶅☉銏♀拺闁荤喐婢橀埛鏃傜磼椤曞懎鐏﹂柟顕嗙節瀵挳鎮㈤崜浣虹暰婵＄偑鍊栭悧妤冩崲閸岀偛瑙︾憸鐗堝笚閻撶喐銇勯幘璺烘瀻缂佹う鍥ㄧ厓鐟滄粓宕滃┑瀣剁稏濠㈣泛鈯曢崫鍕垫建闁逞屽墮閻ｇ柉銇愰幒鎴︽暅濠德板€曢崯顐ょ矈閿曗偓閳规垿鍩ラ崱妤冧淮闂佺顑嗛崝妤佺珶閺囥垹绀傞梻鍌氼嚟缁犳艾顪冮妶鍡欏缂侇喖鐬奸弫顕€鎳滃▓鎸庮啍闂佺粯鍔樼亸娆愭櫠閿旇姤鍙忓┑鐘插鐢盯鏌熷畡鐗堝殗鐎规洦鍋婃俊鐑解€栭鍝勫婵﹨娅ｇ划娆忊枎閹冨闂備焦瀵уú锔界濠婂牊鍋╅柣鎴ｆ椤懘鏌ㄥ☉妯侯伃婵＄虎鍠氱槐鎾存媴閸撴彃鍓靛┑鐐差槹濞茬喕妫熷銈嗘磵閸嬫挻鎱ㄦ繝鍐┿仢婵☆偄鍟埥澶婎潩椤掑姣囧┑鐘殿暯濡插懘宕戦崨顖滅煓闁规崘娉涢崹婵堢磽娴ｉ婊堝磻閸涘瓨鐓曢柟鑸妽濞呭洭鏌涘Ο鍝勮埞妞ゎ亜鍟存俊鍫曞幢濡も偓椤洭姊虹粙鍖℃敾婵炶尙鍠庨锝夊川婵犲啫鍔呴梺鎸庣箓濞层劑鏁嶅鍫熲拺闁革富鍘剧敮娑㈡偨椤栨娅婇柟顔瑰墲缁轰粙宕ㄦ繝鍕箰闂佽绻掗崑鐔煎疾椤愩儱鈧挳姊绘担鐑樺殌鐎殿喖鐖奸獮鎰板礃閼碱剚娈鹃梺缁樻⒒閳峰牓寮崘顔界厪闁割偅绻傞顐ょ磼閳ь剚寰勯幇顓涙嫽闂佺鏈悷銊╁礂瀹€鈧惀顏堫敇閻愰潧鐓熼悗娈垮櫘閸撶喎鐣烽幒妤佸€烽柤纰卞墾缁辩敻姊婚崒姘偓鎼佹偋婵犲嫮鐭欓柟鎹愵嚙濮规煡鏌ㄩ弴鐐测偓褰掓偂閺囩喍绻嗛柕鍫濇噹閺嗘瑩鏌涢幘褰掑摵缂佺粯鐩獮姗€骞囨担鍝勬倯闂備礁鎼張顒勬儎椤栫偟宓佹俊顖欑秿閺冨牆鐒垫い鎺戝缁犵娀骞栧ǎ顒€濡介柛瀣€块弻娑㈠箛闂堟稒鐏嶉梺鎶芥敱鐢繝寮诲☉姘勃闁硅鍔曢ˉ婵嬫⒑闁偛鑻晶浼存煕韫囨棑鑰挎鐐诧工铻栭柛娑卞弮閸炲爼姊洪崫鍕闁靛洦鐩畷鎴﹀箻缂佹ɑ娅囬梺绋挎湰瀹€鎼佸船閸洘鈷戦梻鍫熶緱濡牓鏌涢悩鎰佹疁鐎殿喗鐓￠幃娆撴倻濡攱瀚肩紓鍌欑贰閸ㄥ崬煤閺嶃劍娅犻柤纰卞墰绾惧ジ鎮楅敐搴′簻闁诲繆鏅濈槐鎺楊敊绾拌京鍚嬮悗娈垮枛椤攱淇婇悜鑺ユ櫆闁诡垎鍐杽闂傚倸鍊风欢姘焽瑜旇棟濞寸姴顑呯粣妤呮煛瀹ュ啫濡芥繛鍛У閵囧嫰寮村Δ鈧禍楣冩⒑?OPENAI_API_KEY / LLM_API_KEY';
  if (parsedPayload?.detail === 'API Key invalid') return 'MIVO_API_KEY is invalid';
  if (parsedPayload?.error?.code === 'moderation_blocked') return moderationBlockedMessage(parsedPayload);
  if (/public[_ ]figure/i.test(rawMessage)) return 'GPT image 2.0 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳婀遍埀顒傛嚀鐎氼參宕崇壕瀣ㄤ汗闁圭儤鍨归崐鐐烘偡濠婂啰绠荤€殿喗濞婇弫鍐磼濞戞艾骞楅梻渚€娼х换鍫ュ春閸曨垱鍊块柛鎾楀懏锛忛梺璇″瀻瀹€鈧崥瀣⒑閸濆嫮鐒跨紓宥勭窔閻涱噣宕堕澶嬫櫌婵炶揪绲块幊鎾诲礈閻㈢數纾介柛灞剧懆椤斿鏌涚€ｎ偅宕岄柡灞剧洴瀵挳濡搁妷銉ь啈闂備礁鎽滄慨鐢稿礉濞嗘挸钃熼柨婵嗘啒閺冨牆鐒垫い鎺戝閸嬪鏌涢埄鍐噮缂佺姵妫冮弻鐔兼倻濡儵鎷诲┑鈽嗗亽閸ㄥ爼寮婚悢纰辨晬闁糕剝顨堥悘閬嶆煕濮橆剦鍎旀慨濠冩そ瀹曨偊宕熼浣瑰闂備胶鍎甸弲鈺呭垂娴兼惌鏁嬮柨婵嗩槸缁犵粯銇勯弬鎸庮潔闁冲搫鎳忛悡蹇擃熆鐠団€崇仩闁稿﹤顭峰顐ｃ偅閸愨斁鎷婚梺绋挎湰閻熴劑宕楃仦淇变簻妞ゆ挾鍋熸晶锔姐亜閵忥紕澧电€规洘甯￠幃娆撴嚑椤掍胶鍙勯梻鍌欒兌缁垶鈥﹂崼銉晪鐟滄棃骞忛幋锔藉亜闁稿繗鍋愰崢鎼佹⒑閹肩偛鍔楅柡鍛洴瀵悂寮崒婊咃紲闂佺粯顭堝畷鐢告偩濞差亝鐓涚€光偓鐎ｎ剛袦濡ょ姷鍋涘ú顓炍涢崘銊㈡婵妫欏ù鍥⒒閸屾瑨鍏岀紒顕呭灣閹广垽宕橀…鎴炵稁闂佺厧顫曢崐鏍綖閺囥垺鐓欓柟顖嗗懏鎲兼繝娈垮灡閹告娊寮婚悢铏圭＜婵☆垵娅ｉ悷鎰節閵忥綆娼愭繛鑼枎椤繒绱掑Ο璇差€撴繛鎾村嚬閸ㄦ娊宕濋幖浣光拺婵炶尪顕ф晶顕€鏌曢崼銏╃劸闁伙絿鍏橀獮瀣晜閽樺鍋撻悜鑺ョ厽闁瑰浼濋鍛洸婵°倕鎳忛ˉ濠冦亜閹扳晛鐏璺哄閺岀喖宕ㄦ繝鍐ㄥ攭閻庢鍠撻崝宥囩矉閹烘柡鍋撻敐搴′簽闁告ü绮欏楦裤亹閹烘垳鍠婇梺鍛娒妶鎼佸箖濮椻偓婵＄兘鍩￠崒婊冨箞闂備胶绮ú鎴犵矆娓氣偓閹﹢鏁傞柨顖氫壕閻熸瑥瀚粈鈧梺鍝ュ枙濞夋洟宕ｉ崨顓ф富闁靛牆鎳愮粻浼存煙閾忣偄濮嶇€规洏鍨介幃浠嬪川婵炵偓瀚奸梻浣告啞缁嬫垿鏁冮敃鍌氱疇闁告劏鏂傛禍婊堟煥閺傝法浠㈢€规挸妫涢埀顒冾潐濞叉﹢宕濆▎鎾跺祦闁搞儺鍓﹂弫鍥煟閺傚灝妲诲ù鐓庨閳规垿鎮╅崹顐ｆ瘎婵犳鍠栭顓㈠焵椤掍礁鍤柛鎾跺枎閻ｅ嘲鈹戦崼姘壕闁挎繂楠搁弸鐔兼煕婵犲嫭鏆柡宀嬬秮婵偓闁靛牆妫欓柨顓㈡煟閵忊晛鐏犻柣鏍с偢瀵顓奸崶銊ョ彴闂佸搫琚崕鍗烆嚕閺夎鏃堟偐闂堟稐绮跺銈嗗灥椤︾敻鐛崘顔肩厸闁告粈鐒﹂弲鈺呮⒒閸屾艾鈧悂顢氶銏犳瀬濡わ絽鍟埛鎺楁煕鐏炴崘澹橀柍褜鍓氶幃鍌氱暦閹扮増鍊婚柤鎭掑劚濞堟垿姊洪崜鎻掍簼婵炴彃绉归崺鈧い鎺戯功閻ｇ數鈧娲滈崢褔鍩為幋锕€绠涙い鎾跺仜閸樼偤姊婚崒娆戝妽閻庣瑳鍥ц摕闁靛鍔婃禍褰掓煟閹邦喖鍔嬮柛濠傜仢閳规垿鎮╅幓鎺撴缂備胶濞€缁犳牠寮诲☉銏犵労闁稿繆鏅滈崹瑙勭閹间緡鏁囬柕蹇ョ磿閸樹粙姊洪崷顓炲妺闁搞劏顫夌粋鎺戔槈閵忥紕鍘梺鎼炲劀閸愬彞绱旀俊銈囧Х閸嬬偟鏁幒妤婃晣濠靛倻顭堥悙濠囨煠閸涘﹥娅曟繝濠傜墛閳锋帒霉閿濆洤鍔嬮柛銈傚亾闂備礁鎲￠懝楣冾敄婢舵劗宓侀柛鎰靛枛绾惧ジ鏌ｉ幇顖氳敿闁硅姤娲栭埞鎴︽倷閺夋垹浠搁梺鑽ゅ暀閸涱厼袣闂侀€炲苯澧存慨濠冩そ瀹曘劍绻濋崒姣挎洘绻涚€涙鐭岄柛瀣ㄥ€濋獮鍐锤濡も偓缁€瀣亜閺嶃劎鈻撻柟鐤缁辨捇宕掑▎鎴濆闁活亜顦辩槐鎺楀醇閺囨碍鍠氶梺鍝勬湰閻╊垶骞冮埡鍛闁圭粯甯楅幊娆撴⒒娴ｈ櫣銆婇柡鍌欑窔瀹曟垿骞橀幇浣瑰瘜闂侀潧鐗嗗Λ妤冪箔閹烘鐓ラ柡鍥朵簻椤╊剛绱掗鑺ヮ棃闁诡喕绮欏畷銊︾節閸曨偄绠為梻鍌欑劍鐎笛呮崲閸屾侗娈界紒瀣氨閺嬪秶鈧箍鍎卞ú鐘诲磻閹炬枼鏋旈柛顭戝枟閻濐噣姊虹粙娆惧剰闁挎洏鍊濋幃楣冩倻閽樺顔婂┑掳鍊撶粈渚€鍩€椤掑倸鍘撮柡灞诲€楅崰濠囧础閻愭祴鎷婚梻浣告憸閸犲骸煤椤撶儐娼栨繛宸簻娴肩娀鏌涢弴鐐典粵缁楁垿姊绘担铏瑰笡妞ゃ劌鎳庤灋婵炲棙鎸搁悿楣冩煠閸濄儲鏆╂い鈺冨厴閹鏁愭惔婵堟晼闂佷紮绲块崕銈囨崲濠靛顥堟繛鎴炃氶崑鎾诲箹娴ｅ摜鐤呴梺璺ㄥ枔婵敻宕戦崒鐐寸厽闁哄倹瀵ч幉鍝ョ磼閻樿崵鐣洪柡宀€鍠撻埀顒傛暩椤牊绂掕椤儻顧佸ù婊庝邯瀵鈽夐姀鐘电潉闂佽鍎虫晶搴ㄥ汲閵堝鈷戦柛婵嗗閻忛亶鏌涢悩宕囧⒌闁靛棔绀侀埢搴ㄥ箻閺夋垳绨甸梺纭呭亹鐞涖儵骞婇敐澶婄厸濞撴艾娲︾€靛矂姊洪棃娑氬濡ょ姵鎮傞悰顕€骞嬮敂鐣屽幈闂佸搫鍟犻崑鎾绘煕閵娧勬毈闁诡噣绠栭幃婊堟寠婢光斁鏅犻弻宥夊传閸曡埖鏁鹃梺鍝勬嫅缂嶄線骞冨畡閭︾叆闁告劦鍣埀顒侇殘閹喖鈻庤箛锝囧數闂佸吋鎮傚褎鎱ㄩ崼銉︾厓闂佸灝顑呯粭鎺楁婢舵劖鐓ユ繝闈涙閸ｆ椽鏌涢悢鍝勪槐闁诡喖缍婇獮鍥Ω閵夈儮鎷ら梻渚€娼уú銈団偓姘嵆閵嗕礁顫滈埀顒勫箖濞嗘挻顥堟繛鎴炲笒瀵板秴鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬⒑閻熸澘鈷旂紒顕呭灦瀹曟垿骞囬悧鍫㈠幘缂佺偓婢樺畷顒佹櫠椤栫偞鐓熼柟鍨缁夘喗鎱ㄦ繝鍕笡闁瑰嘲鎳愮划娆忊枎閻愵剦妫忛梻鍌欒兌椤牓顢栭崨鏉戠疇閹艰揪绲藉鍙夌節濞堝灝鏋熼柕鍥ㄧ洴瀹曟垿骞橀崹娑樹壕閻熸瑥瀚粈鍐煕閵娿儲鍋ラ柣娑卞櫍瀹曞爼顢楁担闀愮綍闂備礁澹婇崑鍛崲閳ь剟鏌涢弽銊у⒌婵﹦绮幏鍛喆閸曨偂鍝楅梻浣侯焾濞寸兘宕曢妶鍥╃焿鐎广儱鎷嬮悡銉╂煕椤愩倕鏋庨柛鎿冨弮濮婅櫣绱掑Ο铏逛桓闁煎灕鍏犵懓顭ㄩ崟顓犵厜闂佸搫鐭夌换婵嗙暦閹烘垟鏀介柛銉㈡杺閳ь剙锕铏圭磼濡櫣鐟ㄩ梺纭咁嚋缁绘繈鐛崼銉ノ╅柨鏂垮⒔閻﹀牓姊洪幖鐐插姉闁哄懏绻勭划锝呂旈崨顔规嫼闂傚倸鐗婄粙鎺撳緞閸曨垱鐓曢柡鍐ｅ亾闁荤啿鏅犻幃浼搭敋閳ь剟鐛幒鎳虫棃鍩€椤掑倻涓嶉柨婵嗘缁♀偓婵犵數濮撮崐鎼佸汲閻愮儤鐓熼幖娣灩閳绘洘鎱ㄦ繝鍌ょ吋鐎规洘甯掗埢搴ㄥ箣椤撶啘婊堟⒒娴ｄ警鏀板┑顔哄€楅崚鎺戭吋婢跺﹦鐤勯梺闈浥堥弲婊堝磻閵娧呯＜閻庯綆鍘界涵鑸点亜閺傛寧鍠樻慨濠冩そ閹剝鎯旈鐣岀◥闂備胶顭堥敃銉┿€冩繝鍥х畾閻忕偞鍎崇欢鐐烘煙闁箑骞橀柛妯兼暬濮婅櫣绱掑Ο铏逛桓闂佹寧宀搁弻锝堢疀閹剧紟锝吳庨崶褝韬鐐存崌楠炴帡寮惔鎾冲緧闂傚倷绀侀幖顐﹀嫉椤掆偓鐓ゆ繝闈涚墢娑撳秵绻涢幋鐐垫噮缂佺娀绠栭弻鐔碱敍閸℃鈧悂藟濮樿埖鈷掑ù锝勮閻掑墽绱掔紒妯哄妤犵偛锕ラ幆鏃堟晲閸屾矮澹曢梺鍓茬厛閸嬪棝宕ｉ埀顒€鈹戦纭峰伐妞ゎ厼鍢查悾鐑藉箳閹存梹鐎婚梺鐟扮摠缁诲倿鈥栨径鎰拻濞达絿鐡旈崵鍐煕閻樺磭澧甸柟顔哄劦閹剝鎯旈敐鍡橆啎闂備礁鎼ú銊╁磿閹扮増鍋傞柕澶嗘櫆閻撴洘銇勯幇鍓佹偧缂佺姵鎸剧槐鎺楀箛椤撶姵鍒涘┑顔硷攻濡炶棄鐣烽妸锔剧瘈闁告洦鍘鹃崢鎰版⒒娴ｅ憡鎲搁柛鐘冲姈缁旂喖宕卞▎蹇撶亰闂佸搫鍟悧婊堝极鐎ｎ喗鐓冪憸婊堝礈閻斿鍤曞┑鐘崇閺咁剟鏌涢弴銊ょ凹闁告洖鍟村娲川婵犲啫鐦烽梺鍛婃处閸嬪嫰鎮橀埄鍐瘈闁汇垽娼у暩濡炪倧绲肩划娆忕暦濠婂啠鏀介悗锝庝簽閻ｆ椽姊虹粙璺ㄧ伇闁稿鐩鍛婄瑹閳ь剟寮婚悢鍏煎亱闁割偆鍠撻崙锟犳倵閻熺増鍟炵紒璇插暣婵＄敻宕熼姘鳖啋濠德板€愰崑鎾绘倵濮樼厧鏋ょ紒顔芥閹粙宕ㄦ繛鐐濠电偠鎻徊鍧楁偤閺冨牆鍚规繛鍡樺姈閸欏繑鎱ㄥΔ鈧悧蹇涙偩閻㈠憡鐓ユ繝闈涚墕娴狅妇鈧灚婢樼€氼厾鎹㈠☉銏犵闁圭偓鐣禒銏ゆ⒑缁洘娅旂紒缁樼箓閻ｅ嘲顫滈埀顒勩€侀弮鍫濆耿闁冲搫鍊愰敂鐣岀瘈闁汇垽娼ф禒鈺呮煙濞茶绨界€垫澘锕ョ粋鎺斺偓锝庝簽椤旀垵鈹戦悩璇у伐闁绘妫楁晥闁哄被鍎查悡銉╂煛閸モ晛浠滈柍褜鍓欑紞濠囧箖閳ユ枼鏋庨柟鎯ь嚟閸樹粙姊洪悷閭﹀殶濞村吋绻堥、鏃堝醇閻斿皝鍋撻崜浣插亾楠炲灝鍔氭い锔垮嵆閹€斥槈閵忥紕鍘撻悷婊勭矒瀹曟粌顫濇潏鈺冪効闂佸湱鍎ら弻锟犲磻閹剧粯鏅查幖绮光偓鑼晼闂備礁鎲￠敃銏＄鐠轰警娼栭柧蹇氼潐閸犲棝鏌涢弴銊ヤ航婵☆偄閰ｅ娲传閸曨剙娅ょ紓浣割儐鐢绮氭潏銊х瘈闁搞儜鍌滅倞闂備礁鎲″ú婊堝极閹间礁鑸归柣銏犳啞閻撶喖鏌ｉ弬鎸庢喐闁瑰啿鍟撮幃妤€顫濋悡搴＄缂備緡鍠栭悧蹇涘焵椤掑﹦绉甸柛瀣嚇瀹曪綀绠涢幘顖涙杸闂佺粯蓱瑜板啴寮抽悙鐑樼厪闁搞儯鍔庣粻姗€鏌嶈閸撴繈锝炴径濞掗缚绠涘☉妯碱槷閻庡箍鍎卞ú锕€鐣烽崣澶岀瘈闂傚牊渚楅崕蹇曠棯閹冩倯闁逛究鍔岃灒闁告繂瀚崐顖滅磽閸屾氨孝婵☆偅绻傞～蹇旂節濮橆剛锛滃┑鐐叉閸╁牆危椤曗偓濮婅櫣娑甸崪浣告疂缂備胶绮换鍌烆敋閿濆棛绡€婵﹩鍎甸埡鍐╁枑闊洦绋掗崕妤呮煙閸撗呭笡闁绘挻娲熼弻鐔煎箲閹邦剛姣㈠銈忚缁犳捇寮诲☉銏犖╅柨鏂垮⒔閻ゅ嫰姊虹拠鈥虫灍妞ゃ劌锕顐﹀箛椤撶喎鍔呴梺鏂ユ櫅閸熺増绂嶉鍫熲拻闁稿本鐟чˇ锔锯偓瑙勬处閸撴瑧鍙呭銈嗘尪閸ㄥ綊鎷戦悢鍏肩叆婵犻潧妫Σ鍝ョ磼椤愩垻效闁哄本鐩俊鐑筋敊閹冨紬濠电偛顕慨顓㈠疾濞戔懇鈧棃宕橀鍢壯囨煕閳╁叇姘跺箯閻熸壋鏀介柣鎰硾閻ㄦ椽鏌涢悩鏌ュ弰闁挎繄鍋犵粻娑㈠箻娴ｈ銇濇い銏℃瀹曘劑顢樺┑鍫熸毎闂傚倸鍊峰ù鍥綖婢舵劦鏁婇柡宥庡幖缁愭淇婇妶鍛櫣缂佺姷鍠栭弻銈吤圭€ｎ偅鐝栫紒鐐礃濡嫰婀侀梺鎸庣箓濞层劑骞楅崒鐐寸厱闁靛牆妫涢幊鍛磼鏉堛劌绗氱€垫澘瀚埀顒婄秵閸嬪棛绮欓崶顒佸€甸悷娆忓鐏忣參鎮楀顓熺凡妞ゎ偄绻愮叅妞ゅ繐瀚粣娑欑節閻㈤潧孝閻庢凹鍠氬Σ鎰鐎涙ǚ鎷虹紓浣割儏閻忔繈鎯侀妸鈺傜厱闁挎繂绻掗崚浼存煟閿濆洤鍘存鐐差儔閺佸啴鍩€椤掑倻涓嶅┑鐘崇閻撴盯鏌涚仦涔咁亪宕濆鍫熺厽闊洤娴风粣鏃€鎱ㄦ繝鍐┿仢鐎规洘绮撻幊鐘活敆閳ь剛鏁妷鈺傗拺闁告縿鍎辨牎濡炪們鍔岄敃顏堢嵁閸愵煈娼ㄩ柍褜鍓熼悰顔嘉熼懖鈺冿紲濠碘槅鍨堕弨杈┾偓姘冲亹缁辨捇宕掑▎鎴М濡炪倖鍨甸悧鍡涘煝閺冨牆鍗抽柣妯哄悁缁楀姊洪崫鍕潶闁稿孩鐓￠幃锟犲Ψ閿旇棄寮垮┑鈽嗗灠閻忔繈鎮￠幇鐗堢厽闁规崘娉涢弸娑㈡煛鐏炶濡奸柍瑙勫灴瀹曞崬螣閻戞﹩浠╁┑鐘殿暯閸撴繆銇愰崘顔光偓锕傛倻閽樺顔戦梺鍓插亝濞叉牠宕橀埀顒€顪冮妶鍡樺暗闁哥姵鎹囧畷銏ゅ础閻愨晜鏂€闂佺粯蓱婢х娀宕奸妷銉э紱闂佺懓澧界划顖炴偂閻斿吋鐓欓柧蹇曟嚀娴犙囨煟閿濆洦鏆╅柍褜鍓氶鏍窗濡ゅ懏鍋傞柨鐔哄Т缁犳牗绻涢崱妯诲鞍闁稿﹦绮穱濠囶敍濠婂啫浠樺Δ鐘靛仦椤ㄥ﹤顫忕紒妯诲闁惧繒鎳撶粭锟犳⒑閹稿骸鍝洪柡灞剧☉铻ｉ柤濮愬€曢埛宀勬⒑绾懏鐝紒顔芥崌閵嗕線寮崼婵嬪敹闂佺粯鏌ㄩ幖顐︾嵁閸儲鈷掑ù锝呮啞閹牓鏌涙繝鍛棄闁崇粯妫冨鎾偐閸忓摜鐟濋梻浣哄帶椤洟宕愰幇鏉跨；闁规崘鍩栭崰鍡涙煕閺囥劌澧版い锔哄妼閳规垿鏁嶉崟顐＄钵缂備緡鍠楅悷鈺呮偘椤曗偓瀹曟﹢濡搁姀锛勨偓濠氭⒑閻熸壆鎽犻柡灞诲妽缁傚秵銈ｉ崘鈹炬嫽闂佸壊鍋嗛崰鎾诲煀閺囥垺鐓欓柟缁樺笚閸熺偤鏌曢崶褍顏€殿噮鍣ｉ崺鈧い鎺嗗亾閻撱倝鏌ｉ弮鍌氬付闁藉啰鍠栭弻銊モ攽閸℃﹩妫￠梺绋挎捣閸犳牠寮婚弴锛勭杸濠电姴鍟▍姘節濞堝灝鏋涙繛灞傚€濋垾鏃堝礃椤斿槈褔骞栫划鍏夊亾瀹曞浂鍟囧┑鐘垫暩閸嬫稑螣婵犲洤鐭楅柛鎰靛枤瀹撲線鏌涢埄鍐噥婵炲矈浜弻锝夊箛闂堟稑顫╅梺鍛婃煥閹虫ê顫忓ú顏咁棃婵炴垶姘ㄩ悿鍕⒑閹肩偛濡兼い顓犲厴閵嗕礁鈻庨幘鍐插祮闂侀潧绻嗗褔骞忓ú顏呪拺闁告稑锕﹂埥澶愭煥閺囶亞鐣甸柟顖氭湰缁绘繈宕堕妸褍骞堥梻浣虹帛濮婂鈥﹂崼銉嬪鈧綆鍓涚壕鍏笺亜閺冨倹娅曢柟鍐插缁辨帞绱掑Ο鑲╃暤濡炪値鍋呯换鍫ャ€佸鈧幃鈺呭箵閹烘棏鍞堕梻鍌氬€搁崐椋庣矆娓氣偓楠炲鍩勯崘顏嗘嚌濠德板€曢幊搴ㄥ磼閵娿儙鏃堟晲閸涱厽娈梺鍝勫閸庣敻寮婚妸銉㈡斀闁糕剝顭囬ˇ閬嶆⒑缁嬫鍎愰柟鎼佺畺楠炲骞橀鑲╊槹濡炪倖甯掗崑鍡椢ｉ懜鍏哥箚闁绘劦浜滈埀顑惧€濆畷銏＄附閸涘﹤浜遍梺瑙勫婢ф宕愰崼鏇熺厱闁硅埇鍔嶅▍鍥╃磼閻樿崵鐣虹€殿喖鐖煎畷鐓庘攽閸″繑瀵栫紓鍌欑椤︿粙宕滃璺何﹂柛鏇ㄥ灱閺佸啴鏌曡箛濠冩珕闁宠鐗撳铏规嫚閳ヨ櫕鐏撻梺杞扮椤兘濡存笟鈧鎾閳╁啯鐝曢梺鑽ゅ枑閻熻京寰婇崜褉鍋撳顑惧仮婵﹥妞介幊锟犲Χ閸涘懌鍨虹换娑樏圭€ｎ偅鐝栨繛瀛樼矌椤牓鍩㈡惔銊ョ闁绘浜悷婵嬫⒒娴ｇ瓔娼愰柛搴″悑閹便劑濡舵径瀣簵闂佸搫娲㈤崹娲磹閻㈠憡鐓ユ繝闈涙椤庢顭胯閸ｏ綁寮婚敍鍕ㄥ亾閿濆骸浜為柕鍡樺浮閺屽秷顧侀柛鎾寸箞閿濈偞寰勬繛鎺戞惈椤粓鍩€椤掆偓閻ｇ柉銇愰幒鎴︽暅濠德板€曢崯顐ょ矈閿曗偓閳规垿鍩ラ崱妤冧淮闂佺顑嗛崝妤佺珶閺囥垹绀傞梻鍌氼嚟缁犳艾顪冮妶鍡欏缂侇喖娴烽弫顔尖槈濞嗗秳绨婚棅顐㈡处濞叉牠寮稿☉娆愬弿濠电姴瀚敮娑氱磼濡ゅ啫鏋涢柛鈹惧亾濡炪倖宸婚崑鎾淬亜椤撶偞绌挎い锕€婀卞褔骞樼紒妯煎帗閻熸粍绮撳畷婊冣枎閹惧磭鍘撮梺纭呮彧缁犳垿鎮橀幎鑺ョ叄闊浄绲芥禍婊呯磼閹邦厾銆掔紒杈ㄦ尰缁楃喖宕惰閻忓牆顪冮妶搴″箻闁稿繑锕㈤幃浼搭敋閳ь剙鐣烽崡鐑嗘僵闁稿繒鈷堥埀顒€娲缁樻媴閾忕懓绗￠梺鍝勮閸斿矁鐏嬪┑鐘绘涧椤戝懐绮婚弽顓熷仭婵炲棗绻愰顏勨攽椤旂晫鐭掗柡宀€鍠庨悾锟犲箥椤旀儳濮奸梻浣告啞閺屻劑骞婂Ο渚綎闁惧繐婀遍惌娆撴煕椤垵娅橀柛鏂款樀濮婃椽宕ㄦ繝鍐ｆ嫻濡炪們鍔岄悧鍡楀祫闂佸湱澧楀妯肩不閾忣偂绻嗛柕鍫濆€告禍楣冩⒑缂佹ê绗掗柣蹇斿哺婵＄敻宕熼姘鳖唺闂佺懓鐡ㄧ换宥嗙婵傚憡鈷掑ù锝囶焾閼歌绻涘顔煎籍鐎殿喖顭峰鎾偄妞嬪海鐛繝鐢靛仦閸ㄥ爼鏁冮埡浼辨椽顢橀姀鈾€鎷洪梺鍛婄☉閳洟顢旈崼婵堢枀闂佹寧绋戠€氼厼鐣烽崣澶岀闁瑰鍋熼幊鍕磽瀹ュ懏鍠橀柡灞剧洴楠炴ê螖閳ь剟骞夊☉姗嗘僵妞ゆ帒顦扮€靛矂姊洪棃娑氬濡ょ姴鎲＄粋宥咁煥閸曗晙绨婚梺鎸庢椤曆囨倶閿曞倹鐓欐い鏃€鍎虫禍鐐亜閿旀儳顣奸柟顖涙煥閳规垿宕惰椤庡繒绱撻崒姘偓鎼佸磹閻戣姤鈷旂€广儱顦崹鍌涚箾瀹割喕鎲鹃柡浣革躬閺岋繝宕橀妸褍顤€闂佹娊鏀遍崹鍦閹惧瓨濯村┑顔藉焾娴滄繈骞堥妸鈺佺倞闁靛鍊楃粻姘渻閵堝棛澧柣鏃戝墴閻擃剟顢楅崒妤€浜鹃悷娆忓缁€鍐╃箾閼碱剙鏋庢い鏇秮椤㈡岸鍩€椤掑嫬鏄ラ柍褜鍓氶妵鍕箳閹存繍浠撮梺閫炲苯澧柛鐔风摠娣囧﹪鎮滈挊澶屽幐闂佺鏈崺鍐磻閹剧粯鍊婚柤鎭掑劤閸樺崬鈹戦悙鍙夘棞婵炲瓨鑹惧嵄闁归棿鐒﹂悡娑㈡倵閿濆骸澧柍璇茬墛閹便劍绻濋崨顕呬哗闂佸憡鐗楅悧鐘差嚕閹绢喗鍋勯柛婵勫劚缁插潡姊婚崒娆掑厡妞ゎ厼鐗撻、鏍礃椤旇偐锛欏┑鐘绘涧椤戝棝宕戝Ο姹囦簻闁哄洦顨呮禍楣冩倵鐟欏嫭绀€鐎规洦鍓熼敐鐐测攽鐎ｎ亞顦ф繝銏ｆ硾缁犲秹宕濆畝鍕厴闁硅揪闄勯崑鎰亜閺冨洤浜瑰ù鐓庢搐椤啴濡舵惔鈥茬盎濡炪倧瀵岄崹鎶藉矗閸涘瓨鈷戠紓浣股戦悡銉︺亜閵娿儵顎楁い顓炴喘瀵粙顢橀悢鍝勫及闂傚鍋勫ú锕傚箰閼姐倖瀚婚柨鐔哄У閻撶喐銇勯幘璺烘灁闁瑰啿娲弻鈥崇暆閳ь剟宕伴幘璺哄灊婵炲棙鎸搁崹鍌涖亜閺囩偞鍣瑰┑锛勫厴濮婄粯鎷呴崨濠呯闂佸搫鑻ˇ鎵矉瀹ュ鏁嗛柛灞句緱濞肩喖姊虹憴鍕姢闁宦板妽閸掑﹦鈧潧鎽滅壕鍏肩箾閹寸儑渚涢柛搴＄箲缁绘盯宕奸銏犵缂備浇椴搁幐濠氬箯閸涙潙绀堥柛娆忥紞閵娾晜鈷戠痪顓炴噺閻濐亪鏌熼悷鐗堝枠妤犵偛鍟妶锝夊礃閳轰讲鍋撴繝姘厾闁诡厽甯掗崝姘归悩铏仢婵﹥妞藉畷銊︾節閸曘劍顫嶉梻浣瑰濞插繘宕愬┑瀣槬闁逞屽墯閵囧嫰骞掗幋婵冨亾閹间礁鍌ㄩ柟缁㈠枟閻撴稓鈧厜鍋撻悗锝庡墰琚︽俊銈囧Х閸嬫盯顢栨径鎰畺婵犲﹤鐗嗛獮銏＄箾閸℃绠板Δ鏃堟⒒閸屾艾鈧绮堟笟鈧獮澶愭闁圭瓔鍋婂铏规嫚閳ヨ櫕鐏堥梺绋匡攻閹倿鏁愰悙鍓佺杸闁瑰彞鐒﹀浠嬨€侀弮鍫濆窛妞ゆ牗鑹惧暩闂傚倸鍊烽懗鍓佸垝椤栫偛绀夋俊顖炴？閻掑﹥銇勮箛鎾搭棏闁稿鎸搁～婵嬵敇閻斿搫鍤掓俊鐐€ら崣鈧柛搴☆煼钘濋梺顒€绉甸悡鏇熶繆閵堝嫮顦﹂柍缁樻礈閳ь剚顔栭崰鏍€﹂悜钘夌畺闁靛繈鍊栭崑鍌炲箹鏉堝墽鎮奸柛姗嗗墮閳规垿鎮╅鑲╀紘濠电偛顦伴惄顖炪€侀弽顓炲窛闁哄鍨奸崺鐐寸節閵忥絽鐓愰柛鏃€鐗犲畷鎰版偨閸涘﹤浠┑鐐叉缁绘劙顢旈鍡欑＜闁逞屽墴瀹曞ジ濡烽敂鎯у箞闂備胶绮敋缁剧虎鍘介弲鍫曟偨閸涘﹦鍘梺绯曞墲濞叉粎绮ｉ弮鍌楀亾濞堝灝鏋熼柟姝屾珪閹便劑鍩€椤掑嫭鐓熸俊顖濆吹閸ㄥ綊鏌涢妷锝呭闁告﹢浜跺娲传閸曨剙鍋嶉梺鍛婃煥閺堫剟寮查崼鏇ㄦ晬婵犙勫劤娴滈箖鎮峰▎蹇擃仾缂佲偓閸愩劉鏀介柣鎰嚋瀹搞儲銇勯銏㈢缂佺粯绻傞～婵嬵敆閸岋妇搴婂┑鐘愁問閸犳鏁冮埡鍛婵せ鍋撶€规洘鍨块獮妯兼嫚閼碱剦鍟囧┑鐐舵彧缁蹭粙骞楀鍫熸櫖婵炲棙鎸婚埛鎴犳喐閻楀牆绗氶柨娑氬枔缁辨帡鍩€椤掍焦濯撮柛婵嗗濡粓鎮峰鍛暭閻㈩垱顨婇幃鈥斥枎閹剧补鎷婚梺绋挎湰閸戝綊宕甸悢鍏肩厱闁哄倽娉曟晥闂佸搫鏈粙鎾诲焵椤掑﹦绉靛ù婊冪埣瀹曟洟寮崼鐔哄幗闂佺懓鐏濋崯顐ｇ閹殿喒鍋撶憴鍕闁绘牕鍚嬫穱濠傤潰瀹€濠冃ユ繝纰樺墲瑜板啴鎮ц箛鏇燁潟闁圭儤顨呯粻姘辨喐瀹ュ鐓曢柡鍐ㄥ€荤壕鍏笺亜閺囩偞鍣归柣蹇ョ秮閺岀喖鐛崹顔句患闂佸疇妫勯ˇ鍨叏閳ь剟鏌ｅΟ娲诲晱闁告艾鎳忕换婵嬫偨闂堟稐绮跺┑鈽嗗亝椤ㄥ牓骞戦姀銈呯闁归箖顤傚ù鍕節闂堟稑鈧悂骞夐敓鐘茬厱闁瑰鍋熺粻楣冩煠婵傚壊鏉洪柛銈嗙懄椤ㄣ儵鎮欓幖顓熺暦闂侀潧娲ょ€氱増淇婇幖浣肝ㄦい鏍ㄧ箓閹牓鏌ｆ惔銏╁晱闁哥姵鐗犻垾锕傛倻閽樺鐎梺鐟板⒔缁垶宕戦幇鐗堢厾缁炬澘宕晶顕€鏌嶈閸撴盯宕戦妶鍜佹綎闁惧繐鍘滈崑鎾诲捶椤撶倫锝夋煏閸℃鏆ｉ柡宀嬬秮楠炴帡鎮欓悽鍨闂備浇顕栭崰妤呫€冮崼銉ョ闁绘ê妯婇崯鍛亜閺冨洦顥夐柣锔界矒濮婄粯绗熼埀顒€顭囪閹囧幢濡炪垺绋戦埢搴ㄥ箣閻樼數鍔跺┑鐘灱濞夋盯鈥﹂鈧妴鎺撶節濮橆厾鍘告繝銏ｆ硾椤戝懘鎮橀敃鍌涚厱闁绘柨鎼禒褏绱掓潏銊ョ瑨闁伙絾绻堝畷姗€顢欓崗鍏煎殘缂傚倸鍊烽懗鍓佸垝椤栨粍宕查柛顐ｇ箘閺嗭箓鏌涢锝嗙閹喖姊洪棃娑辨Ф闁搞劏顫夌粋宥嗐偅閸愨晝鍘介梺纭呮彧缁插€燁暱闂備焦濞婇弨杈╂暜閿熺姴钃熸繛鎴欏焺閺佸啴鏌曢崼婵囧櫤闁诲繋绶氬鍝勭暦閸ヨ泛鍔嗛梺绋块叄娴滃爼鍨鹃敂鐐磯闁靛绠戦弸鍌炴⒑閸涘﹥澶勯柛鎾寸洴钘濋柡澶婄氨閺€鑺ャ亜閺冨倶鈧顔忛妷鈺傜厵缁炬澘宕禍鐐烘煕濞嗗繑鍤囬柡宀嬬秮閹晜娼忛埡濠冃滅紓浣稿⒔閾忓酣宕ｉ崘顔肩疇婵°倕鎳忛幆鐐烘煕閿旇骞橀柨娑欑箖缁绘盯骞樼壕瀣棟濠电偛鐪伴崐婵嗩嚕閹间焦鍋勯柛蹇氬亹閸樹粙姊虹紒妯荤叆鐎殿喛娉涢埢宥夊川椤旇桨绨婚梺鍝勬祩娴滅偟绮欓懡銈囩＜缂備焦顭囩粻鎾淬亜椤愶絿绠炴い銏★耿閹垽宕妷銉ь槮闂傚倸鍊搁崐椋庣矆娓氣偓楠炲鏁嶉崟顐㈢亰闂佸壊鍋侀崕鏌ュ磹閸ф鐓ラ柡鍐ㄧ墛閺嗘粓鏌涚€ｎ偅宕屾俊顐㈠暙閳藉顫濋崣妯肩缂傚倸鍊峰ù鍥ㄣ仈閹间礁绠查柛銉戝懏娈鹃梺鍦劋閸ㄧ喖寮告惔銊︾厵閻庢稒顭囩粻鎾淬亜椤掆偓椤﹂潧顫忓ú顏呭癄濠㈣泛锕ュ▓缁樼箾鐎涙鐭婇柣鏍帶椤曪絾绻濆顓熸珳闂佸憡渚楁禍婵嬪棘閳ь剟姊绘担瑙勫仩闁稿孩妞介幃锟犲醇濠㈩亝鐩畷姗€濡搁姀鈩冩澑婵＄偑鍊栧濠氬Υ鐎ｎ喖缁╃紓浣姑肩换鍡涙煟閹邦垰鐓愭い銉ヮ樀閺岋綁鏁愰崶褍骞嬪銈冨灪濞茬喖寮崘顔肩劦妞ゆ巻鍋撻柡渚囧櫍濮婄粯绗熼埀顒€顭囪钘濇い鎾卞灩绾捐淇婇妶鍛櫣缂佺姵鐓￠弻锟犲炊閳轰焦鐎虹紓浣筋嚙濡繈寮婚敐澶婄疀闁稿繐鎽滈惄搴ㄦ⒑闁偛鑻晶顖炴煟濡や焦绀堥柛娆忔嚇濮婃椽骞愭惔銏㈩槬闂佺锕ラ幃鍌炲箚鐏炶娇鏃堝川椤旀儳骞堥梻渚€鈧稑宓嗘繛浣冲洤鍑犳繛鎴欏灪閻撴盯鏌涢弴妤佹珔闁告棑绠撻弻锛勪沪閻ｅ睗銉︺亜瑜岀欢姘跺蓟濞戙垹绠婚柡澶嬪灥閹藉灚绻濈喊澶岀？闁轰浇顕ч悾鐑芥偄绾拌鲸鏅┑顔斤耿绾悂宕ú顏呪拻濞达綀娅ｉ妴濠囨煕閹惧绠炲┑锛勬暬閹瑧鈧潧鎽滆ぐ楣冩⒑閸濆嫭宸濋柛鐘虫尵瀵囧焵椤掑嫭鈷戞慨鐟版搐閻忓弶绻涙担鍐叉閸欐挳姊婚崒娆掑厡妞ゎ厼鐗撻、鏍幢濞戞顔夐梺鎼炲劀鐏炲墽绋佹繝鐢靛仜濡﹥绂嶉崼鏇炴瀬闁糕剝绋掗悡鍐喐濠婂牆绀堟繛鎴炶壘閸ㄦ繈鏌￠崘銊モ偓鐢稿磻閹剧粯顥堟繛鎴炵懄閸犳劖绻涢幋鐐村碍缂佸缍婂濠氭晲閸涘倻鍠栭幊鏍煛娴ｄ警鍋ч梻鍌欒兌缁垶骞愭繝姘仭闁冲搫鎳庨拑鐔兼煟閺冨倸鍔嬮柛鐘叉閺屾盯寮撮妸銉ょ盎閻炴碍绻堝缁樻媴鐟欏嫬浠╅梺绋匡攻閻楃娀骞冮悿顖ｆЬ濠碘€冲级閸旀瑩鐛幒鎳虫梹鎷呴梹鎰潖闂佽姘﹂～澶娒洪弽顬℃椽濡舵径娑氱◤閻熸粌娴烽幑銏犫槈閵忊剝娅滈梺鍛婁緱閸犳骞冨▎鎾粹拺闁圭瀛╂径鍕瑰鍕畺缂佸矁椴哥换婵嬪炊瑜旈崬鍫曟⒑閸濆嫭宸濋柛瀣〒缁絽鈽夊鍡樺瘜闂侀潧鐗嗗Λ娆撴偂閵夆晜鐓曟慨姗嗗墻閸庢梹銇勯姀鈩冾棃闁诡喒鏅犻幃浠嬫偨绾板闂梻鍌欒兌椤牓寮甸鍕仭闁靛ň鏅╅弫濠傤熆閼搁潧濮堥柣鎾存礋閹鏁愭惔鈥茬凹閻庤娲栭惌鍌炲蓟閿涘嫪娌柛鎾楀嫬鍨辨俊銈囧Х閸嬫稑煤椤撶偟鏆︽俊銈呮噹娴肩娀鏌曟径娑氱暠闁伙箑顭峰濠氬磼濞嗘帒鍘″銈庡幖閻楁捇銆侀弽顓炲耿婵炴垶顭囬澶愭⒑閹肩偛鍔撮柛鎾村哺瀹曟垵螣濮瑰洣绨婚梺鍝勬处椤ㄥ懏绂嶆ィ鍐╁€甸悷娆忓缁€鈧紓鍌氱Т閿曨亪濡存担绯曟瀻闁圭偓娼欐禍妤呮煙閸忓吋鍎楅柛鐘愁殘缁辩偤骞樼紒妯锋嫽闂佺鏈懝楣冨焵椤掑倸鍘撮柟铏殜瀹曟粍鎷呯粙璺ㄤ喊婵＄偑鍊栭悧婊堝磻閹达箑鐒垫い鎺嗗亾闁哥喐娼欓悾鐑藉Ω閳哄﹥鏅┑鐐村灦閿氱紒銊ｅ劦濮婄粯鎷呴崫銉ㄩ梺绋款儏閿曨亜鐣峰鍐ｆ瀻闁瑰濮烽悞鎯ь渻閵堝棗濮ч梻鍕閸╂盯骞掗幊銊ョ秺閺佹劙宕ㄩ钘夋瀾缂傚倷绀侀ˇ閬嶅磿閵堝棛鈹嶅┑鐘叉祩閺佸啴鏌曡箛濞惧亾閸忓懏妯婇梻鍌欐祰椤曟牠宕板璺虹；闁靛牆顦弸渚€鏌涢幇闈涙灈缁炬儳鍚嬬换娑㈠箣閻忔槒鍋愰懞?';
  if (/rejected by the safety system|moderation[_ -]?blocked/i.test(rawMessage)) {
    return 'GPT image 2.0 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳婀遍埀顒傛嚀鐎氼參宕崇壕瀣ㄤ汗闁圭儤鍨归崐鐐烘偡濠婂啰绠荤€殿喗濞婇弫鍐磼濞戞艾骞楅梻渚€娼х换鍫ュ春閸曨垱鍊块柛鎾楀懏锛忛梺璇″瀻瀹€鈧崥瀣⒑閸濆嫮鐒跨紓宥勭窔閻涱噣宕堕澶嬫櫌婵炶揪绲块幊鎾诲礈閻㈢數纾介柛灞剧懆椤斿鏌涚€ｎ偅宕岄柡灞剧洴瀵挳濡搁妷銉ь啈闂備礁鎽滄慨鐢稿礉濞嗘挸钃熼柨婵嗘啒閺冨牆鐒垫い鎺戝閸嬪鏌涢埄鍐噮缂佺姵妫冮弻鐔兼倻濡儵鎷诲┑鈽嗗亽閸ㄥ爼寮婚悢纰辨晬闁糕剝顨堥悘閬嶆煕濮橆剦鍎旀慨濠冩そ瀹曨偊宕熼浣瑰闂備胶鍎甸弲鈺呭垂娴兼惌鏁嬮柨婵嗩槸缁犵粯銇勯弬鎸庮潔闁冲搫鎳忛悡蹇擃熆鐠団€崇仩闁稿﹤顭峰顐ｃ偅閸愨斁鎷婚梺绋挎湰閻熴劑宕楃仦淇变簻妞ゆ挾鍋熸晶锔姐亜閵忥紕澧电€规洘甯￠幃娆撴嚑椤掍胶鍙勯梻鍌欒兌缁垶鈥﹂崼銉晪鐟滄棃骞忛幋锔藉亜闁稿繗鍋愰崢鎼佹⒑閹肩偛鍔楅柡鍛洴瀵悂寮崒婊咃紲闂佺粯顭堝畷鐢告偩濞差亝鐓涚€光偓鐎ｎ剛袦濡ょ姷鍋涘ú顓炍涢崘銊㈡婵妫欏ù鍥⒒閸屾瑨鍏岀紒顕呭灣閹广垽宕橀…鎴炵稁闂佺厧顫曢崐鏍綖閺囥垺鐓欓柟顖嗗懏鎲兼繝娈垮灡閹告娊寮婚悢铏圭＜婵☆垵娅ｉ悷鎰節閵忥綆娼愭繛鑼枎椤繒绱掑Ο璇差€撴繛鎾村嚬閸ㄦ娊宕濋幖浣光拺婵炶尪顕ф晶顕€鏌曢崼銏╃劸闁伙絿鍏橀獮瀣晜閽樺鍋撻悜鑺ョ厽闁瑰浼濋鍛洸婵°倕鎳忛ˉ濠冦亜閹扳晛鐏璺哄閺岀喖宕ㄦ繝鍐ㄥ攭閻庢鍠撻崝宥囩矉閹烘柡鍋撻敐搴′簽闁告ü绮欏楦裤亹閹烘垳鍠婇梺鍛娒妶鎼佸箖濮椻偓婵＄兘鍩￠崒婊冨箞闂備胶绮ú鎴犵矆娓氣偓閹﹢鏁傞柨顖氫壕閻熸瑥瀚粈鈧梺鍝ュ枙濞夋洟宕ｉ崨顓ф富闁靛牆鎳愮粻浼存煙閾忣偄濮嶇€规洏鍨介幃浠嬪川婵炵偓瀚奸梻浣告啞缁嬫垿鏁冮敃鍌氱疇闁告劏鏂傛禍婊堟煥閺傝法浠㈢€规挸妫涢埀顒冾潐濞叉﹢宕濆▎鎾跺祦闁搞儺鍓﹂弫鍥煟閺傚灝妲诲ù鐓庨閳规垿鎮╅崹顐ｆ瘎婵犳鍠栭顓㈠焵椤掍礁鍤柛鎾跺枎閻ｅ嘲鈹戦崼姘壕闁挎繂楠搁弸鐔兼煕婵犲嫭鏆柡宀嬬秮婵偓闁靛牆妫欓柨顓㈡煟閵忊晛鐏犻柣鏍с偢瀵顓奸崶銊ョ彴闂佸搫琚崕鍗烆嚕閺夎鏃堟偐闂堟稐绮跺銈嗗灥椤︾敻鐛崘顔肩厸闁告粈鐒﹂弲鈺呮⒒閸屾艾鈧悂顢氶銏犳瀬濡わ絽鍟埛鎺楁煕鐏炴崘澹橀柍褜鍓氶幃鍌氱暦閹扮増鍊婚柤鎭掑劚濞堟垿姊洪崜鎻掍簼婵炴彃绉归崺鈧い鎺戯功閻ｇ數鈧娲滈崢褔鍩為幋锕€绠涙い鎾跺仜閸樼偤姊婚崒娆戝妽閻庣瑳鍥ц摕闁靛鍔婃禍褰掓煟閹邦喖鍔嬮柛濠傜仢閳规垿鎮╅幓鎺撴缂備胶濞€缁犳牠寮诲☉銏犵労闁稿繆鏅滈崹瑙勭閹间緡鏁囬柕蹇ョ磿閸樹粙姊洪崷顓炲妺闁搞劏顫夌粋鎺戔槈閵忥紕鍘梺鎼炲劀閸愬彞绱旀俊銈囧Х閸嬬偟鏁幒妤婃晣濠靛倻顭堥悙濠囨煠閸涘﹥娅曟繝濠傜墛閳锋帒霉閿濆洤鍔嬮柛銈傚亾闂備礁鎲￠懝楣冾敄婢舵劗宓侀柛鎰靛枛绾惧ジ鏌ｉ幇顖氳敿闁硅姤娲栭埞鎴︽倷閺夋垹浠搁梺鑽ゅ暀閸涱厼袣闂侀€炲苯澧存慨濠冩そ瀹曘劍绻濋崒姣挎洘绻涚€涙鐭岄柛瀣ㄥ€濋獮鍐锤濡も偓缁€瀣亜閺嶃劎鈻撻柟鐤缁辨捇宕掑▎鎴濆闁活亜顦辩槐鎺楀醇閺囨碍鍠氶梺鍝勬湰閻╊垶骞冮埡鍛闁圭粯甯楅幊娆撴⒒娴ｈ櫣銆婇柡鍌欑窔瀹曟垿骞橀幇浣瑰瘜闂侀潧鐗嗗Λ妤冪箔閹烘鐓ラ柡鍥朵簻椤╊剛绱掗鑺ヮ棃闁诡喕绮欏畷銊︾節閸曨偄绠為梻鍌欑劍鐎笛呮崲閸屾侗娈界紒瀣氨閺嬪秶鈧箍鍎卞ú鐘诲磻閹炬枼鏋旈柛顭戝枟閻濐噣姊虹粙娆惧剰闁挎洏鍊濋幃楣冩倻閽樺顔婂┑掳鍊撶粈渚€鍩€椤掑倸鍘撮柡灞诲€楅崰濠囧础閻愭祴鎷婚梻浣告憸閸犲骸煤椤撶儐娼栨繛宸簻娴肩娀鏌涢弴鐐典粵缁楁垿姊绘担铏瑰笡妞ゃ劌鎳庤灋婵炲棙鎸搁悿楣冩煠閸濄儲鏆╂い鈺冨厴閹鏁愭惔婵堟晼闂佷紮绲块崕銈囨崲濠靛顥堟繛鎴炃氶崑鎾诲箹娴ｅ摜鐤呴梺璺ㄥ枔婵敻宕戦崒鐐寸厽闁哄倹瀵ч幉鍝ョ磼閻樿崵鐣洪柡宀€鍠撻埀顒傛暩椤牊绂掕椤儻顧佸ù婊庝邯瀵鈽夐姀鐘电潉闂佽鍎虫晶搴ㄥ汲閵堝鈷戦柛婵嗗閻忛亶鏌涢悩宕囧⒌闁靛棔绀侀埢搴ㄥ箻閺夋垳绨甸梺纭呭亹鐞涖儵骞婇敐澶婄厸濞撴艾娲︾€靛矂姊洪棃娑氬濡ょ姵鎮傞悰顕€骞嬮敂鐣屽幈闂佸搫鍟犻崑鎾绘煕閵娧勬毈闁诡噣绠栭幃婊堟寠婢光斁鏅犻弻宥夊传閸曡埖鏁鹃梺鍝勬嫅缂嶄線骞冨畡閭︾叆闁告劦鍣埀顒侇殘閹喖鈻庤箛锝囧數闂佸吋鎮傚褎鎱ㄩ崼銉︾厓闂佸灝顑呯粭鎺楁婢舵劖鐓ユ繝闈涙閸ｆ椽鏌涢悢鍝勪槐闁诡喖缍婇獮鍥Ω閵夈儮鎷ら梻渚€娼уú銈団偓姘嵆閵嗕礁顫滈埀顒勫箖濞嗘挻顥堟繛鎴炲笒瀵板秴鈹戞幊閸婃鎱ㄩ悜钘夌；婵炴垟鎳為崶顒佸仺缂佸瀵ч悗顒勬⒑閻熸澘鈷旂紒顕呭灦瀹曟垿骞囬悧鍫㈠幘缂佺偓婢樺畷顒佹櫠椤栫偞鐓熼柟鍨缁夘喗鎱ㄦ繝鍕笡闁瑰嘲鎳愮划娆忊枎閻愵剦妫忛梻鍌欒兌椤牓顢栭崨鏉戠疇閹艰揪绲藉鍙夌節濞堝灝鏋熼柕鍥ㄧ洴瀹曟垿骞橀崹娑樹壕閻熸瑥瀚粈鍐煕閵娿儲鍋ラ柣娑卞櫍瀹曞爼顢楁担闀愮綍闂備礁澹婇崑鍛崲閳ь剟鏌涢弽銊у⒌婵﹦绮幏鍛喆閸曨偂鍝楅梻浣侯焾濞寸兘宕曢妶鍥╃焿鐎广儱鎷嬮悡銉╂煕椤愩倕鏋庨柛鎿冨弮濮婅櫣绱掑Ο铏逛桓闁煎灕鍏犵懓顭ㄩ崟顓犵厜闂佸搫鐭夌换婵嗙暦閹烘垟鏀介柛銉㈡杺閳ь剙锕铏圭磼濡櫣鐟ㄩ梺纭咁嚋缁绘繈鐛崼銉ノ╅柨鏂垮⒔閻﹀牓姊洪幖鐐插姉闁哄懏绻勭划锝呂旈崨顔规嫼闂傚倸鐗婄粙鎺撳緞閸曨垱鐓曢柡鍐ｅ亾闁荤啿鏅犻幃浼搭敋閳ь剟鐛幒鎳虫棃鍩€椤掑倻涓嶉柨婵嗘缁♀偓婵犵數濮撮崐鎼佸汲閻愮儤鐓熼幖娣灩閳绘洘鎱ㄦ繝鍌ょ吋鐎规洘甯掗埢搴ㄥ箣椤撶啘婊堟⒒娴ｄ警鏀板┑顔哄€楅崚鎺戭吋婢跺﹦鐤勯梺闈浥堥弲婊堝磻閵娧呯＜閻庯綆鍘界涵鑸点亜閺傛寧鍠樻慨濠冩そ閹剝鎯旈鐣岀◥闂備胶顭堥敃銉┿€冩繝鍥х畾閻忕偞鍎崇欢鐐烘煙闁箑骞橀柛妯兼暬濮婅櫣绱掑Ο铏逛桓闂佹寧宀搁弻锝堢疀閹剧紟锝吳庨崶褝韬鐐存崌楠炴帡寮惔鎾冲緧闂傚倷绀侀幖顐﹀嫉椤掆偓鐓ゆ繝闈涚墢娑撳秵绻涢幋鐐垫噮缂佺娀绠栭弻鐔碱敍閸℃鈧悂藟濮樿埖鈷掑ù锝勮閻掑墽绱掔紒妯哄妤犵偛锕ラ幆鏃堟晲閸屾矮澹曢梺鍓茬厛閸嬪棝宕ｉ埀顒€鈹戦纭峰伐妞ゎ厼鍢查悾鐑藉箳閹存梹鐎婚梺鐟扮摠缁诲倿鈥栨径鎰拻濞达絿鐡旈崵鍐煕閻樺磭澧甸柟顔哄劦閹剝鎯旈敐鍡橆啎闂備礁鎼ú銊╁磿閹扮増鍋傞柕澶嗘櫆閻撴洘銇勯幇鍓佹偧缂佺姵鎸剧槐鎺楀箛椤撶姵鍒涘┑顔硷攻濡炶棄鐣烽妸锔剧瘈闁告洦鍘鹃崢鎰版⒒娴ｅ憡鎲搁柛鐘冲姈缁旂喖宕卞▎蹇撶亰闂佸搫鍟悧婊堝极鐎ｎ喗鐓冪憸婊堝礈閻斿鍤曞┑鐘崇閺咁剟鏌涢弴銊ょ凹闁告洖鍟村娲川婵犲啫鐦烽梺鍛婃处閸嬪嫰鎮橀埄鍐瘈闁汇垽娼у暩濡炪倧绲肩划娆忕暦濠婂啠鏀介悗锝庝簽閻ｆ椽姊虹粙璺ㄧ伇闁稿鐩鍛婄瑹閳ь剟寮婚悢鍏煎亱闁割偆鍠撻崙锟犳倵閻熺増鍟炵紒璇插暣婵＄敻宕熼姘鳖啋濠德板€愰崑鎾绘倵濮樼厧鏋ょ紒顔芥閹粙宕ㄦ繛鐐濠电偠鎻徊鍧楁偤閺冨牆鍚规繛鍡樺姈閸欏繑鎱ㄥΔ鈧悧蹇涙偩閻㈠憡鐓ユ繝闈涚墕娴狅妇鈧灚婢樼€氼厾鎹㈠☉銏犵闁圭偓鐣禒銏ゆ⒑缁洘娅旂紒缁樼箓閻ｅ嘲顫滈埀顒勩€侀弮鍫濆耿闁冲搫鍊愰敂鐣岀瘈闁汇垽娼ф禒鈺呮煙濞茶绨界€垫澘锕ョ粋鎺斺偓锝庝簽椤旀垵鈹戦悩璇у伐闁绘妫楁晥闁哄被鍎查悡銉╂煛閸モ晛浠滈柍褜鍓欑紞濠囧箖閳ユ枼鏋庨柟鎯ь嚟閸樹粙姊洪悷閭﹀殶濞村吋绻堥、鏃堝醇閻斿皝鍋撻崜浣插亾楠炲灝鍔氭い锔垮嵆閹€斥槈閵忥紕鍘撻悷婊勭矒瀹曟粌顫濇潏鈺冪効闂佸湱鍎ら弻锟犲磻閹剧粯鏅查幖绮光偓鑼晼闂備礁鎲￠敃銏＄鐠轰警娼栭柧蹇氼潐閸犲棝鏌涢弴銊ヤ航婵☆偄閰ｅ娲传閸曨剙娅ょ紓浣割儐鐢绮氭潏銊х瘈闁搞儜鍌滅倞闂備礁鎲″ú婊堝极閹间礁鑸归柣銏犳啞閻撶喖鏌ｉ弬鎸庢喐闁瑰啿鍟撮幃妤€顫濋悡搴＄缂備緡鍠栭悧蹇涘焵椤掑﹦绉甸柛瀣嚇瀹曪綀绠涢幘顖涙杸闂佺粯蓱瑜板啴寮抽悙鐑樼厪闁搞儯鍔庣粻姗€鏌嶈閸撴繈锝炴径濞掗缚绠涘☉妯碱槷閻庡箍鍎卞ú锕€鐣烽崣澶岀瘈闂傚牊渚楅崕蹇曠棯閹冩倯闁逛究鍔岃灒闁告繂瀚崐顖滅磽閸屾氨孝婵☆偅绻傞～蹇旂節濮橆剛锛滃┑鐐叉閸╁牆危椤曗偓濮婅櫣娑甸崪浣告疂缂備胶绮换鍌烆敋閿濆棛绡€婵﹩鍎甸埡鍐╁枑闊洦绋掗崕妤呮煙閸撗呭笡闁绘挻娲熼弻鐔煎箲閹邦剛姣㈠銈忚缁犳捇寮诲☉銏犖╅柨鏂垮⒔閻ゅ嫰姊虹拠鈥虫灍妞ゃ劌锕顐﹀箛椤撶喎鍔呴梺鏂ユ櫅閸熺増绂嶉鍫熲拻闁稿本鐟чˇ锔锯偓瑙勬处閸撴瑧鍙呭銈嗘尪閸ㄥ綊鎷戦悢鍏肩厸闁搞儮鏅涢弸搴ｇ磼閸撲礁浠︾紒缁樼洴楠炲鎮滈崶锔捐繑婵犵數鍋涘Ο濠囧矗閸愵煈娼栨繛宸簻瀹告繂鈹戦悙鏉戜刊濞存粍绮撻幃楣冩倻缁涘鏅㈤梺鍛婃处閸嬪棝宕㈤幘顔解拺缁绢厼鎳忚ぐ褔姊婚崟顐㈩伃鐎规洘鍔欓幃婊堟嚍閵壯冨箰濠电姰鍨煎▔娑㈩敄閸涘瓨鍊堕柍杞版€ヨぐ鎺撳亹闁惧浚鍋勯埀顒佸姈閹便劍绻濋崘鈹夸虎闂佸湱顒茬换婵囦繆閸洖宸濇い鏃堟暜閸嬫捇顢橀姀鈾€鎷虹紓浣割儐鐎笛囧箲閿濆鐓涘ù锝呭閻撳ジ鏌ｅ☉鍗炴珝鐎规洘锕㈡俊鍛婃償閿濆懏鐏堥梺鍦劜缁绘繃淇婇崼鏇炵倞闁冲搫鍋嗗鎾绘⒒閸屾艾鈧兘鎮為敃鍌氱畺闁割偅娲栫壕鎸庛亜閺嶎偄浠滅紒鈧径鎰婵烇綆鍓欐俊濂告煕鐏炶濡奸摶鏍煥濠靛棙鍣归柡鍡欏仱閺屽秹鏌ㄧ€ｎ亞浼岄梺鍝勬湰閻╊垶鐛鈧幃鐑藉箥椤旂瓔鍤勯梻鍌欑閹猜ゆ懌闂佺儵鏅╅崹璺侯嚕鐠囨祴妲堟慨姗堢到娴滈箖鏌ㄥ┑鍡欏嚬缂併劎绮妵鍕疀閿濆懎绫嶉梺鍝勭灱閸犳牠銆佸▎鎾虫闁靛牆鐗冮崑鎾诲锤濡や胶鍘告繛杈剧悼椤牓鍩€椤掆偓閻忔繈鎮惧畡閭︾叆闁糕檧鏅滈瀷闂傚倷鐒︾€笛呯矙閹烘柨鍨濋柟鐐墯濞兼牠鏌ц箛鎾磋础闁活厽鐟╅弻鐔虹矙閸噮鍔夐梺鐟板槻瀹曨剟鍩為幋锔绘晩閻熸瑦甯楃划鎾崇暦濠靛棭鍚嬪璺猴功閺屟囨⒑闂堟侗妲撮柡鍛矒閹繝鎮㈤悡搴ｎ啇濠电儑缍嗛崜娆撳焵椤戞儳鈧洟鈥﹂崶顒€绠涙い鎾跺Х椤旀洟姊洪崨濠勬噧妞わ箒椴搁弲鍫曨敂閸喓鍘介梺鎸庣箓濞层倝宕㈢€涙ǜ浜滈柕蹇婃濞堟粎鈧娲橀敃銏ゃ€侀弮鍫濈妞ゅ繐娲ら崢顓㈡⒒閸屾艾鈧悂宕愰幖浣哥９濡炲瀛╅鑺ユ叏濡寧纭鹃柣鎺戠仛閵囧嫰骞掗幋婵冨亾閸涘﹦顩锋繝濠傜墛閻撶姵绻涢懠棰濆殭闁诲骏绻濋弻锟犲川椤撶儐鏆㈤梺閫炲苯澧伴柡浣告憸濞戠敻宕奸弴鐐碉紱闂佸湱鍋撻弸濂稿几閺冨牊鐓曟い顓熷灥閺嬬喖鏌ｅ┑鎰珝婵﹨娅ｇ划娆忊枎閹冨闂備焦瀵уú蹇涘磹濠靛绠栧Δ锝呭暞閻撱儵鎮楅敐搴″⒋婵＄虎鍠氱槐鎾存媴閸撴彃鍓伴梺璇茬箲缁诲倿鎮鹃悽绋垮耿婵炴垶鐟㈤幏铏圭磽閸屾瑧鍔嶉拑閬嶆煟閹惧崬鍔﹂柡宀嬬秮婵℃悂鏁傞崜褏鏉介柣搴ゎ潐濞叉﹢宕归崸妤冨祦婵☆垵鍋愮壕鍏间繆椤栨繃銆冪紓鍌涙崌濮婄粯鎷呴崨濠傛殘缂備礁顑嗛崹鍧楀极閸愵喗鏅濋柛灞捐壘閸嬪秹姊绘笟鍥у缂佸鏁婚崺娑㈠箣閿旂晫鍘电紓浣割儏閻忔繈顢楅姀掳浜滈柕澶堝劜椤ョ偤鏌曢崶褍顏€殿喗鎸冲畷鍗炍旀担鍝ョ崺闁诲氦顫夐幐鐑芥倿閿旂晫鈹嶅┑鐘叉搐鍥撮梺鍛婁緱閸犳牕鈻嶉妶澶嬧拺缂備焦蓱鐏忕増绻涢懠顒€鏋涚€殿喖顭峰鎾閻樿鏁规繝鐢靛█濞佳兾涘畝鍕；闁规崘顕у婵嗏攽閻樻彃顏存繛鍙夋倐濮婅櫣鎷犻垾宕団偓濠氭煃瑜滈崜鐔奉嚕閵婏妇顩烽悗锝庡亞閸欏棗鈹戦悙鏉戠仸闁挎碍銇勮箛濠冩珔闂囧绻濇繝鍌氭殧闁稿鍨介弻锛勪沪閸撗€濮囩紓浣虹帛缁诲牆鐣峰鈧、鏃堝礋閵婏箑顏繝寰锋澘鈧鎱ㄩ悜钘夌；闁绘劕鎼粈澶愭煛瀹ュ骸浜濈€规洖寮剁换婵嬫濞戞瑱绱炲┑鐐茬毞閺呮粓濡甸崟顖氱闁瑰瓨绺鹃崑鎾寸節濮橆剚杈堝銈嗗姧闂勫嫰鍩涢幒鎳ㄥ綊鏁愰崟顕呭妳闂佺粯甯＄粻鏍蓟閿熺姴閱囨い鎰╁灩閳峰鎮楃憴鍕闁荤喆鍔戞俊鐢稿箛閺夎法顔婇梺鐟扮摠缁诲啴宕曢鍫熲拻濞达絽鎲￠幆鍫熺箾鐏炲倸濡介悗鐢靛帶閳规垶绻涙径鍛婄潖闂備礁婀遍崕銈夊箰閸涘﹦顩茬憸鐗堝笚閸婄敻鏌ｉ悢鍛婄凡妞ゃ儱绻橀弻娑㈡偐瀹曞洤鈷岄悗瑙勬礃缁挸鐣烽敓鐘冲€婚柛鈩兠惁婊堟⒒娓氣偓濞佳囨偋閸℃稑鐤い鎰剁畱缁€澶嬫叏濡灝鐓愰柣鎾跺枑娣囧﹪濡堕崟顓炲閻庤娲栭惉濂稿焵椤掍緡鍟忛柛鐘崇洴椤㈡俺顦规い銏★耿瀹曟鎮℃惔锝囩嵁濠电姷鏁告慨鎶芥嚄閸洘鍊峰┑鐘叉处閳锋帒霉閿濆懏鍟為柛鐔哄仦缁绘稓鎷犺閻ｇ數鈧娲橀崹鍨暦閵娾晩鏁囨繛鎴炵懅娴滄牠姊洪懡銈呅俊妞煎妿閹峰啴鏁冮埀顒勫Υ閹烘挾绡€婵﹩鍘鹃崢顏堟⒑閸撴彃浜濈紒璇插缁粯瀵肩€涙鍘介梺鎸庢⒒閺咁偊鎯岄幒妤佺厸閻忕偛澧藉ú鎾煛娴ｇ懓濮岀紒鐘崇洴瀵挳鎮欓懠顒€甯撴繝纰夌磿閸嬫垿宕愰妶澶婄；闁告洦鍘藉畷鏌ユ煙闁箑鏋涚€殿喖寮舵穱濠囨倷椤忓嫧鍋撻弴鐘冲床闁归偊鍠掗崑鎾愁潩闂傚鏁栧┑鈥冲级閸旀瑥鐣锋總绋垮嵆闁绘柨寮剁€氬ジ姊绘担鍛婂暈缂佸鍨块弫鍐Ψ閿曗偓缁剁偤鏌涢弴銊ョ仭闁绘挻娲熼幃妤呮晲鎼存繄鍑归梺闈╃到缂嶅﹪寮诲鍥╃＜婵☆垵顕х壕鎶芥⒑绾懏鐝紒顔芥崌楠炲啯绂掔€ｎ偄浠洪梺姹囧灩閻忔岸锝炵仦瑙ｆ斀闁绘ê鐏氶弳鈺呮煕鐎ｎ偆娲撮柟顔ㄥ洤骞㈡繛鎴炵懃閳ь剝鍩栫换婵嬫濞戝崬鍓伴梺鍛婂灩婵炩偓闁哄本娲熷畷鐓庘攽閹邦厜褔姊虹紒妯诲鞍缂佸鍨垮﹢渚€姊洪幐搴ｇ畵閻庢凹鍨堕、妤呮偄閸忚偐鍘介梺鍦劋椤ㄥ牓鎮惧ú顏呯厸閻忕偟鏅晥闂佸湱顭堥敃銉ヮ嚗閸曨倠鐔兼倻閳哄倻鈧即姊婚崒娆愮グ妞ゆ洘鐗犲畷鏉款潩鐠鸿櫣鏌у銈嗗姂閸婃洟宕瑰┑鍥╃闁糕剝蓱鐏忣參姊虹憗銈呪偓鏍ㄧ┍婵犲洤围闁稿本鐭竟鏇㈡⒒娴ｈ姤銆冪紒鈧担铏圭濠电姴鍋嗗鏍磽娴ｈ偂鎴炲垔閹绢喗鐓曟繛鎴烇公閺€濠氭煕鎼淬垺灏柍瑙勫灴閹瑩鎳犻浣稿瑎闂備礁鎲″褰掑垂閻㈠憡鍋╅柣鎴ｅГ閸嬪鏌涢銈呮瀻闁告柨鎳樺娲濞戞氨鐤勯梺绯曟櫅鐎氼剟婀侀梺鍛婃处閸嬧偓闁衡偓娴犲鐓熼柟閭﹀墮缁狙囨煃缂佹ɑ绀€闂囧绻濇繝鍌氼伀缂佺姷鍋ら弻娑㈠煛閸屾粍鍒涘Δ鐘靛仜椤戝骞冮埡鍛仺缁炬澘顦遍梻顖涚節閻㈤潧浠╅柟娲讳簽缁辩偤鍩€椤掑嫭鐓曢悗锝庝簻閳ь剙娼￠悰顔锯偓锝庡枟閺呮繈鏌嶈閸撶喖骞冮敓鐘插嵆闁靛骏绱曢崢鐢告⒑缂佹ê鐏﹂拑閬嶆倶韫囷絼绨婚棁澶嬬節婵犲倸顏柣顓烆儔閺屾洟宕惰椤忣厽顨ラ悙鎼劷闁圭懓瀚顏堟偋閸繄鍘卞┑鐘垫暩婵參骞忛崘顭戝悑闁搞儮鏅滃▓濂告⒒娴ｅ憡鎯堥柣顒€銈稿畷浼村冀椤撴壕鍋撴担绯曟瀻闁规崘娅曢ˉ婵嬫⒑闂堟稓澧曢柣妤€鍟村畷鎴﹀箻閼搁潧纾梺闈涱焾閸ㄨ绂嶆ィ鍐╁仭婵炲棗绻愰顏嗙磼閳ь剟鍩€椤掑嫭鈷戠紓浣诡焽婢ь亪鏌曢崼鐔稿€愬┑鈥崇摠閹峰懘鎳栧┑鍥ㄢ拹闁瑰嘲鎳橀幃鐑芥焽閿旂懓浜鹃柟鍓х帛閳锋垿鏌涘☉姗堝姛缂佺姵鎹囬幃妤€顫濋悡搴☆潽婵烇絽娲ら敃顏勭暦閸洦鏁嗗ù锝呭级鐎氫粙姊绘担渚劸闁哄牜鍓熼幃鐑藉Ω閳轰胶顦ч悗鍏夊亾闁逞屽墴閹偓妞ゅ繐鐗滈弫鍥煟閹扮増娑ч柣鎾跺枛閹鎲撮崟顒傤槰缂備緡鍠栭惌鍌炲春閻愬搫绠ｉ柣姗嗗亜娴滈箖鏌ㄥ┑鍡楁殭濠碉紕鍏橀弻娑氣偓锝庡亝瀹曞瞼鈧娲橀敃銏ゃ€佸▎鎾村亗閹艰揪绲垮畷娲⒒閸屾瑧顦﹂柟纰卞亰钘濆ù鍏兼綑閸ㄥ倻鎲搁悧鍫濈瑨缂佲偓婢舵劖鐓ラ柡鍥殔娴滄儳顪冮妶搴濈盎闁哥喎鐡ㄦ穱濠囧醇閺囩偛鑰垮┑掳鍊曢崯鈺冩濡崵绡€闁汇垽娼ф禒婊勩亜閿旇姤绶查悡銈夋煟閺冨倸甯剁紒鐘冲哺閹﹢鎮欑紓搴㈠浮瀵憡鎯旈妸锔惧幍闂侀€涚祷濞呮洖鈻嶉崘顏嗙＜闁靛鍎洪悡鍏兼叏婵犲啯銇濇俊顐㈠暙閳藉顫濇潏鈺傛瘞闂傚倷绶氶埀顒傚仜閼活垱鏅堕鈧弻娑㈡偄闁垮浠村Δ鐘靛仦椤ㄥ﹤螞閸愩劉妲堥弶鍫涘妼閻︽粓姊绘笟鈧褔鎮ч崱娑樼柈妞ゆ劧闄勯崐鑸点亜韫囨挻鍣峰ù婊勭矒閺屾洘绻涢崹顔煎Х閻庤鎮堕崕鐢稿蓟閿濆鏅查柛銉戝啫绠ｆ俊銈囧Х閸嬬偟鏁敓鐘靛祦閻庯綆鍠栫猾宥夋煃瑜滈崜鐔兼晲閻愬樊鍚嬮柛娑变簼閺傗偓婵＄偑鍊栧濠氭偤閺傚簱鏋旈柡鍐ｅ亾濞ｅ洤锕、鏇㈡晲閸♀晜顥堟俊銈囧Х閸嬫盯宕幘顔兼瀬闁归偊鍘肩欢鐐烘倵閿涘崬瀚娲⒒閸屾瑨鍏屾い顓炵墦瀵敻顢楅崟顒€浠悷婊勬濡喖姊洪幐搴㈢闁稿﹤缍婇幃鈥斥枎閹炬潙浠梺鎼炲劚濞层倝骞婇幇鐗堝剨闁割偁鍎查崐鐢告偡濞嗗繐顏紒鈧崘顏嗙＜閻犲洤寮堕ˉ鐘电磼椤旀鍤欓柍钘夘槸铻ｉ梺鍨儛濞兼梹绻濈喊妯活潑闁搞劋鍗冲畷銉р偓锝庡枟閸嬪倿鏌ㄥ┑鍡橆棤缂佲檧鍋撻梻浣圭湽閸ㄨ棄顭囪閻☆參姊绘担鐟邦嚋婵炴彃绻樺畷鎰攽閸℃瑦娈惧銈嗙墱閸嬬偤宕戦幇鐗堝仯闁搞儯鍔岀徊濠氭煕閵堝棗鐏存慨濠冩そ瀹曨偊宕熼鐔蜂壕闁告縿鍎存慨鎶芥⒑椤掆偓缁夊绱掗埡浼卞綊鎮╁顔煎壉闂佺粯鎸鹃崰鎰┍婵犲浂鏁嶆繝闈涙祩娴犫晠姊洪幐搴ｂ槈缂佸鏁绘俊鐢稿礋椤栨稒娅滈梺绯曞墲閻熴儱顕ｉ妸鈺傗拺闁告繂瀚悞璺ㄧ磽瀹ュ嫮绐旈柣娑卞枛铻ｉ悘蹇旂墪娴滅偓绻涢幋鐐垫噽闁绘帟濮ら妵鍕晜閸喖绁┑顔硷攻濡炶棄鐣烽锕€绀嬫い鎾跺С缁辨﹢姊绘担鍛婃喐濠殿喚鏁婚幃褔鎮╁顔兼婵犵數濮甸懝楣冩倷婵犲啨浜滈柟鍝勭Ф閸斿秵绻涢崨顓熷枠婵﹥妞介弻鍛存倷閼艰泛顏繝鈷€灞界仸闁哄矉绻濆畷銊╊敇閻樿尙鍘芥俊鐐€戦崹娲儎椤栫偛绠栨繛鍡樺灍閸嬫捇鎮藉▓璺ㄥ姼濡ょ姷鍋涢悧鎾愁潖缂佹ɑ濯撮柣鐔煎亰閸ゅ绱撴担绛嬪殭闁稿﹤娼￠獮鍐槻妞ゎ厹鍔戝畷姗€宕滆婵椽姊绘担绛嬫綈濠㈢懓妫欓弲璺何旈崨顔间簵闂婎偄娲︾粙鎺楁偂閺囥垺鐓忓璺侯儏閻忋儵鏌涢悩宕囶暡閻庨潧銈稿畷姗€顢欓挊澶嗗亾閸偆绠鹃柛顐ｇ箘娴犮垺绻涢崨顕嗚€块柡灞剧洴閺佹劘绠涢弴鐘樻粓鎮楃憴鍕婵＄偘绮欏畷娲焵椤掍降浜滈柟鍝勭Ч濡惧嘲霉濠婂嫮鐭掗柡宀€鍠栭幃婊兾熼搹閫涙樊婵＄偑鍊曠换鍡涘疾濠靛牊顫曢柟鐑橆殔閻掑灚銇勯幒宥囶槮缂佸墎鍋ら幃妤呮晲鎼粹€愁潾濡炪倖姊瑰ú鐔奉潖閾忕懓瀵查柡鍥╁仜閳峰顪冮妶鍐ㄥ闁绘绻掗崚鎺撶節濮橆剛顔呴梺鍏间航閸庢娊宕㈤幖浣光拺缂侇垱娲橀～濠囨煕濮椻偓缁犳牠骞冩ィ鍐╁仺闁告稑锕﹂崢鎼佹煟韫囨洖浠ч柛瀣尵缁牓宕橀浣镐壕闁割煈鍋呯欢鏌ユ倵濮樼厧澧撮柛鈹垮劜瀵板嫰骞囬澶嬬秱闂備礁鐤囧Λ鍕涘畝鍕；闁圭偓鍓氶崥瀣熆鐠轰警鍎岄柟鐤缁辨挻鎷呴崜鎻掑壉闁诲海鐟抽崶褏顔夐梺鎸庣箓椤︿即鎮￠弴銏＄厽婵☆垵娅ｉ敍宥咁熆瑜忛弫鎼佸焵椤掍緡鍟忛柛鐘崇洴椤㈡俺顦规い銏★耿瀹曟鎮℃惔锝囩嵁濠电姷鏁搁崕鎰焽閸ф绀夐柟杈剧畱閽冪喖鏌￠崶鈺佹灁缂佲檧鍋撻梻濠庡亜濞诧箓骞栭埡浼辨椽顢橀姀鈥充画濠电姴锕ょ€氼剚鍎梻浣告啞閸斞呭緤妤ｅ啫妫橀柍褜鍓熷缁樻媴閾忕懓绗￠梺鍛婃⒐濞叉牠顢氶敐澶婇唶闁哄洨鍋ゅΛ鐑芥偡濠婂懎顣奸悽顖涱殜閹繝寮撮姀锛勫幗闂佸搫鍊圭€笛囧疮閻愮儤鍊堕煫鍥ュ劚椤╊剟鏌嶈閸撴岸顢欓弽顓炵獥闁哄稁鍘搁埀顒婄畵閹粓鎸婃径瀣偓顒勬⒑瑜版帒浜伴柛妯垮亹濞嗐垽鎮欓悜妯衡偓鐢告煥濠靛棛鍑圭紒銊╂敱閹便劎鎲撮崟鍨杹濠殿喖锕︾划顖炲箯閸涙潙宸濆┑鐘插€瑰▓姗€姊绘担钘夊惞闁哥姴妫濆畷鏇熸媴閸愨晩妫ㄥ┑锛勫亼閸婃牠鎮у鍫濈９婵炴垯鍨归悙濠冦亜閹哄棗浜鹃梺缁樻尰缁嬫垿婀侀梺鎸庣箓閹冲海鐥閺岋繝宕掑Δ鈧禍楣冩⒒閸屾艾鈧兘鎳楅崜浣稿灊妞ゆ牜鍋涚粈澶愭煛瀹擃喖鐬奸崝宄扳攽閻愬弶顥為柛銊ф暩濞嗐垽濡舵径瀣幘婵犳鍠楅崝鏇㈠焵椤掍緡娈樺瑙勬礋閹虫牠鍩￠崘顏庣闯濠电偠鎻徊鍨枍閵忋倕绀傛い鎺戝閻撶娀鏌熷畡鐗堟拱缁绢厼鐖奸弻宥堫檨闁告挻绻堥敐鐐村緞婵炴帒鎼灒濞撴凹鍨辩€靛本绻涚€电孝妞ゆ垵鎳樺浼村Ψ閳哄倻鍘?';
  }
  if (parsedPayload?.error?.message) return parsedPayload.error.message;
  if (parsedPayload?.detail) return parsedPayload.detail;
  if (parsedPayload?.message) return parsedPayload.message;
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  return error?.message || String(error);
}

async function fetchMivoToken() {
  requireMivoKey();
  const response = await axios.post(
    `${mivoBaseUrl}/api/v1/state/token`,
    { id: '', sub: config.mivoApiKey, name: '' },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const { session, expiresAt } = response.data;
  cachedMivoToken = { session, expiresAt: expiresAt || Date.now() + 30 * 24 * 60 * 60 * 1000 };
  return session;
}

async function getMivoToken() {
  if (cachedMivoToken && Date.now() < cachedMivoToken.expiresAt - 60_000) return cachedMivoToken.session;
  if (mivoTokenPromise) return mivoTokenPromise;
  mivoTokenPromise = fetchMivoToken().finally(() => {
    mivoTokenPromise = null;
  });
  return mivoTokenPromise;
}

async function mivoHttp() {
  const session = await getMivoToken();
  return axios.create({
    baseURL: mivoBaseUrl,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` }
  });
}

const chatSessions = {};

async function getChatSession(chatType) {
  if (chatSessions[chatType]) return chatSessions[chatType];
  const client = await mivoHttp();
  const response = await client.post('/api/v1/message/chat', { type: chatType });
  chatSessions[chatType] = response.data.object_id || response.data.id;
  return chatSessions[chatType];
}

async function createMivoMessage(payload, chatType, messageType, modelType, modelVersion, action = 'mcp') {
  const client = await mivoHttp();
  const chatSessionId = await getChatSession(chatType);
  const normalizedPayload = modelType === 'NANOBANANA' ? { ...payload, provider: 'genai' } : payload;
  const response = await client.post('/api/v1/message', {
    chatSessionId,
    messageType,
    modelType,
    modelFormat: { version: modelVersion },
    action,
    payload: normalizedPayload
  });
  return response.data.object_id || response.data.id;
}

function normalizeImageModel(model) {
  return openAIImageProvider.normalizeImageModel(model);
}

function isGptImageModel(model) {
  return openAIImageProvider.isGptImageModel(model);
}

function clampImageCount(count) {
  return openAIImageProvider.normalizeImageCount(undefined, count);
}

function normalizeImageQuality(quality) {
  return openAIImageProvider.normalizeImageQuality(quality);
}

function roundToMultiple(value, step = 16) {
  return openAIImageProvider.roundToMultiple(value, step);
}

function imageSizeFromSettings(ratio, resolution) {
  return openAIImageProvider.imageSizeFromSettings(ratio, resolution);
}

function nativeNanoImageSizeFromSettings(ratio) {
  return openAIImageProvider.nativeNanoImageSizeFromSettings(ratio);
}

function outputFormatExtension(format) {
  switch (String(format || 'png').toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return { ext: 'jpg', mimeType: 'image/jpeg' };
    case 'webp':
      return { ext: 'webp', mimeType: 'image/webp' };
    default:
      return { ext: 'png', mimeType: 'image/png' };
  }
}

function localAssetLocationFromUrl(url, fallbackProjectUuid) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return null;

  let pathname = rawUrl.split(/[?#]/)[0];
  if (/^https?:\/\//i.test(rawUrl)) {
    try {
      pathname = new URL(rawUrl).pathname;
    } catch {
      return null;
    }
  }

  const match = pathname.match(/^\/assets\/([^/]+)\/([^/]+)$/i);
  if (match) {
    const sourceProjectUuid = decodeURIComponent(match[1]);
    const storedName = decodeURIComponent(match[2]);
    if (
      !sourceProjectUuid ||
      !storedName ||
      path.basename(sourceProjectUuid) !== sourceProjectUuid ||
      path.basename(storedName) !== storedName
    ) {
      return null;
    }
    return { projectUuid: sourceProjectUuid, storedName };
  }

  const legacyMatch = pathname.match(/^\/assets\/([^/]+)$/i);
  if (!legacyMatch) return null;
  const storedName = decodeURIComponent(legacyMatch[1]);
  if (!storedName || path.basename(storedName) !== storedName) return null;
  return { projectUuid: String(fallbackProjectUuid), storedName };
}

async function resolveToOpenAiImageInput(url, projectUuid) {
  if (!url) return null;
  const localAsset = localAssetLocationFromUrl(url, projectUuid);
  if (localAsset) {
    const localPath = await ensureAssetLocalPath(localAsset.projectUuid, localAsset.storedName);
    if (fs.existsSync(localPath)) {
      return {
        filePath: localPath,
        cleanupFiles: [],
        projectUuid: localAsset.projectUuid,
        storedName: localAsset.storedName,
        providerUrl: objectStore.publicUrlForAsset(localAsset.projectUuid, localAsset.storedName)
      };
    }
    return null;
  }
  if (!String(url).startsWith('http')) return null;

  const response = await axios.get(String(url), { responseType: 'arraybuffer', timeout: 60_000 });
  const contentType = String(response.headers['content-type'] || 'image/png').split(';')[0].trim().toLowerCase();
  const inferred = outputFormatExtension(contentType.split('/')[1] || 'png');
  const filePath = path.join(tmpDir(), `${randomId()}.${inferred.ext}`);
  fs.writeFileSync(filePath, Buffer.from(response.data));
  return { filePath, cleanupFiles: [filePath], providerUrl: String(url) };
}

const GEMINI_JSON_REFERENCE_TOTAL_LIMIT = 3 * 1024 * 1024;
const GEMINI_JSON_REFERENCE_ITEM_LIMIT = 1536 * 1024;
const GEMINI_JSON_REFERENCE_MAX_SIDE = 2048;

async function prepareGeminiJsonReference(imageInput, force = false) {
  if (!imageInput?.filePath || !fs.existsSync(imageInput.filePath)) return imageInput;
  const sourceSize = fs.statSync(imageInput.filePath).size;
  if (!force && sourceSize <= GEMINI_JSON_REFERENCE_ITEM_LIMIT) return imageInput;

  const preparedPath = path.join(tmpDir(), `${randomId()}-gemini-ref.jpg`);
  try {
    const sourceBuffer = fs.readFileSync(imageInput.filePath);
    const dimensions = await imageBufferDimensions(sourceBuffer);
    let width = GEMINI_JSON_REFERENCE_MAX_SIDE;
    let height = GEMINI_JSON_REFERENCE_MAX_SIDE;
    if (dimensions?.width > 0 && dimensions?.height > 0) {
      const scale = Math.min(
        1,
        GEMINI_JSON_REFERENCE_MAX_SIDE / dimensions.width,
        GEMINI_JSON_REFERENCE_MAX_SIDE / dimensions.height
      );
      width = Math.max(2, Math.round((dimensions.width * scale) / 2) * 2);
      height = Math.max(2, Math.round((dimensions.height * scale) / 2) * 2);
    }

    await execFileAsync('ffmpeg', [
      '-y',
      '-loglevel', 'error',
      '-i', imageInput.filePath,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,format=yuvj420p`,
      '-frames:v', '1',
      '-q:v', '2',
      preparedPath
    ], { timeout: 120_000 });

    if (!fs.existsSync(preparedPath) || fs.statSync(preparedPath).size <= 0) return imageInput;
    return {
      filePath: preparedPath,
      cleanupFiles: [...(imageInput.cleanupFiles || []), preparedPath]
    };
  } catch (error) {
    fs.rmSync(preparedPath, { force: true });
    console.warn('prepare Gemini reference image failed; using original input:', errorMessageFrom(error));
    return imageInput;
  }
}

async function prepareGeminiJsonReferences(imageInputs) {
  const totalSize = (imageInputs || []).reduce((sum, image) => {
    try {
      return sum + fs.statSync(image.filePath).size;
    } catch {
      return sum;
    }
  }, 0);
  const forceCompression = totalSize > GEMINI_JSON_REFERENCE_TOTAL_LIMIT;
  return Promise.all((imageInputs || []).map((image) => prepareGeminiJsonReference(image, forceCompression)));
}

function imageInputDataUrl(imageInput) {
  if (!imageInput?.filePath || !fs.existsSync(imageInput.filePath)) return '';
  const mimeType = mimeTypeFromName(imageInput.filePath).startsWith('image/')
    ? mimeTypeFromName(imageInput.filePath)
    : 'image/png';
  const encoded = fs.readFileSync(imageInput.filePath).toString('base64');
  return `data:${mimeType};base64,${encoded}`;
}

function imageInputProviderUrl(imageInput) {
  const providerUrl = String(imageInput?.providerUrl || '').trim();
  if (/^https:\/\//i.test(providerUrl)) return providerUrl;
  if (imageInput?.projectUuid && imageInput?.storedName) {
    return objectStore.publicUrlForAsset(imageInput.projectUuid, imageInput.storedName);
  }
  return '';
}

function geminiNativeBaseUrl() {
  return String(openaiBaseUrl || llmBaseUrl || '').replace(/\/v(?:\d+|1beta)$/i, '').replace(/\/+$/, '');
}

function geminiJsonHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (/googleapis\.com/i.test(geminiNativeBaseUrl())) {
    headers['x-goog-api-key'] = currentOpenaiKey();
  } else {
    headers.Authorization = `Bearer ${currentOpenaiKey()}`;
  }
  return headers;
}

function geminiNativePartForImage(imageInput) {
  if (!imageInput?.filePath || !fs.existsSync(imageInput.filePath)) return null;
  const mimeType = mimeTypeFromName(imageInput.filePath).startsWith('image/')
    ? mimeTypeFromName(imageInput.filePath)
    : 'image/png';
  return {
    inlineData: {
      mimeType,
      data: fs.readFileSync(imageInput.filePath).toString('base64')
    }
  };
}

function geminiInteractionPartForImage(imageInput) {
  if (!imageInput?.filePath || !fs.existsSync(imageInput.filePath)) return null;
  const mimeType = mimeTypeFromName(imageInput.filePath).startsWith('image/')
    ? mimeTypeFromName(imageInput.filePath)
    : 'image/png';
  return {
    type: 'image',
    mime_type: mimeType,
    data: fs.readFileSync(imageInput.filePath).toString('base64')
  };
}

function geminiInteractionResponseFormatFromConfig(imageConfig = {}) {
  const format = {
    type: 'image',
    delivery: 'inline',
    mime_type: 'image/jpeg'
  };
  const imageSize = String(imageConfig.imageSize || '').trim().toUpperCase();
  const aspectRatio = String(imageConfig.aspectRatio || '').trim();
  if (imageSize) format.image_size = imageSize;
  if (aspectRatio && aspectRatio !== 'auto') format.aspect_ratio = aspectRatio;
  return format;
}

async function requestGeminiInteractionImage({ model, promptText, inputImages, ratio, resolution, signal }) {
  const imageConfig = openAIImageProvider.geminiImageConfigForModel(model, ratio, resolution);
  // geminiImageConfigForModel already drops the ratio for 'auto'. Do not fall back to the
  // raw ratio here: Vertex imageConfig.aspectRatio only accepts concrete ratios, so sending
  // 'auto' (used by local repaint and same-size edits) fails the whole request with
  // INVALID_ARGUMENT before the model ever sees the images.
  const requestedAspectRatio = String(imageConfig.aspectRatio || '').trim();
  const nativeAspectRatio = requestedAspectRatio === '2:1' ? '16:9' : requestedAspectRatio;
  const parts = [{ text: promptText || 'Generate an image.' }];
  for (const image of inputImages || []) {
    const part = geminiNativePartForImage(image);
    if (part) parts.push(part);
  }

  return axios.post(
    `${geminiNativeBaseUrl()}/v1beta/models/${encodeURIComponent(openAIImageProvider.providerModelForImage(model))}:generateContent`,
    {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          ...(nativeAspectRatio ? { aspectRatio: nativeAspectRatio } : {}),
          imageSize: imageConfig.imageSize || resolution,
        },
      },
    },
    {
      headers: geminiJsonHeaders(),
      signal,
      timeout: 300_000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    },
  );
}

function canUseGeminiInteractionsEndpoint() {
  return /googleapis\.com/i.test(geminiNativeBaseUrl());
}

async function requestGeminiCompatibleImageEdit({
  model,
  promptText,
  inputImages,
  ratio,
  resolution,
  requestCount,
  user,
  outputFormat,
  quality,
  signal
}) {
  const formData = new FormData();
  formData.append('model', openAIImageProvider.providerModelForImage(model));
  formData.append('prompt', promptText || 'Generate an image.');
  formData.append('quality', quality);
  formData.append('output_format', outputFormat);
  formData.append('n', String(requestCount));
  if (user) formData.append('user', user);
  const imageParams = openAIImageProvider.geminiImageParamsForModel(model, ratio, resolution);
  for (const [key, value] of Object.entries(imageParams)) formData.append(key, String(value));
  for (const image of inputImages || []) {
    formData.append('image[]', fs.createReadStream(image.filePath), path.basename(image.filePath));
  }
  return axios.post(`${openaiBaseUrl}/images/edits`, formData, {
    headers: { Authorization: `Bearer ${currentOpenaiKey()}`, ...formData.getHeaders() },
    signal,
    timeout: 300_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
}

async function requestOpenAiMaskedImageEdit({
  model,
  promptText,
  sourceInput,
  maskInput,
  size,
  requestCount,
  user,
  quality,
  signal
}) {
  imageRepaintService.assertReadableImageInput(sourceInput, '局部重绘原图');
  imageRepaintService.assertReadableImageInput(maskInput, '局部重绘遮罩');
  const formData = new FormData();
  formData.append('model', openAIImageProvider.providerModelForImage(model));
  formData.append('prompt', promptText || 'Repaint the transparent mask area.');
  formData.append('quality', quality);
  formData.append('output_format', 'png');
  formData.append('n', String(requestCount));
  if (size && size !== 'auto') formData.append('size', size);
  if (user) formData.append('user', user);
  formData.append('image', fs.createReadStream(sourceInput.filePath), path.basename(sourceInput.filePath));
  formData.append('mask', fs.createReadStream(maskInput.filePath), path.basename(maskInput.filePath));
  return axios.post(`${openaiBaseUrl}/images/edits`, formData, {
    headers: { Authorization: `Bearer ${currentOpenaiKey()}`, ...formData.getHeaders() },
    signal,
    timeout: 300_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
}

function isGeminiInteractionsUnsupported(error) {
  const status = Number(error?.response?.status || 0);
  if (status === 404 || status === 405) return true;
  const message = errorMessageFrom(error);
  return /not found|unsupported|unknown endpoint|route/i.test(String(message || ''));
}

function geminiImageResponseAspectRatio(value) {
  const key = String(value || '').trim();
  const map = {
    '1:1': 'ASPECT_RATIO_ONE_BY_ONE',
    '2:3': 'ASPECT_RATIO_TWO_BY_THREE',
    '3:2': 'ASPECT_RATIO_THREE_BY_TWO',
    '3:4': 'ASPECT_RATIO_THREE_BY_FOUR',
    '4:3': 'ASPECT_RATIO_FOUR_BY_THREE',
    '4:5': 'ASPECT_RATIO_FOUR_BY_FIVE',
    '5:4': 'ASPECT_RATIO_FIVE_BY_FOUR',
    '9:16': 'ASPECT_RATIO_NINE_BY_SIXTEEN',
    '16:9': 'ASPECT_RATIO_SIXTEEN_BY_NINE',
    '21:9': 'ASPECT_RATIO_TWENTY_ONE_BY_NINE',
    '1:8': 'ASPECT_RATIO_ONE_BY_EIGHT',
    '8:1': 'ASPECT_RATIO_EIGHT_BY_ONE',
    '1:4': 'ASPECT_RATIO_ONE_BY_FOUR',
    '4:1': 'ASPECT_RATIO_FOUR_BY_ONE'
  };
  return map[key] || '';
}

function geminiImageResponseSize(value) {
  const key = String(value || '').trim().toUpperCase();
  const map = {
    '512': 'IMAGE_SIZE_FIVE_TWELVE',
    '512PX': 'IMAGE_SIZE_FIVE_TWELVE',
    '1K': 'IMAGE_SIZE_ONE_K',
    '2K': 'IMAGE_SIZE_TWO_K',
    '4K': 'IMAGE_SIZE_FOUR_K'
  };
  return map[key] || '';
}

function geminiImageResponseFormatFromConfig(imageConfig = {}) {
  const image = {};
  const imageSize = geminiImageResponseSize(imageConfig.imageSize);
  const aspectRatio = geminiImageResponseAspectRatio(imageConfig.aspectRatio);
  if (imageSize) image.imageSize = imageSize;
  if (aspectRatio) image.aspectRatio = aspectRatio;
  return image;
}

function targetDimensionsFromSettings(ratio, resolution, model = 'gpt-image-2') {
  const size = openAIImageProvider.imageSizeFromSettings(ratio, resolution, model);
  if (!size || size === 'auto') return null;
  const [width, height] = String(size).split('x').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

async function prepareNanoEditInput(imageInput, ratio, resolution, model) {
  const target = targetDimensionsFromSettings(ratio, resolution, model);
  if (!imageInput?.filePath || !target) return imageInput;

  const sharp = getSharp();
  const preparedPath = path.join(tmpDir(), `${randomId()}-nano-edit.png`);
  const maxSide = Math.max(target.width, target.height);
  if (sharp) {
    await sharp(imageInput.filePath)
      .resize({
        width: maxSide,
        height: maxSide,
        fit: 'inside',
        withoutEnlargement: true
      })
      .png()
      .toFile(preparedPath);
  } else {
    await execFileAsync('ffmpeg', [
      '-y',
      '-loglevel', 'error',
      '-i', imageInput.filePath,
      '-vf', `scale=${maxSide}:${maxSide}:force_original_aspect_ratio=decrease,setsar=1`,
      '-frames:v', '1',
      preparedPath
    ], { timeout: 120_000 });
  }

  return {
    filePath: preparedPath,
    cleanupFiles: [...(imageInput.cleanupFiles || []), preparedPath]
  };
}

async function normalizeImageBufferAspectRatio(buffer, ratio) {
  const expectedAspect = expectedAspectFromRatio(ratio);
  if (!buffer || !expectedAspect) return buffer;
  const sharp = getSharp();
  if (!sharp) return buffer;
  const metadata = await sharp(buffer).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) return buffer;
  const actualAspect = width / height;
  if (Math.abs(actualAspect - expectedAspect) / expectedAspect <= 0.001) return buffer;
  const crop = actualAspect > expectedAspect
    ? { width: Math.max(1, Math.round(height * expectedAspect)), height }
    : { width, height: Math.max(1, Math.round(width / expectedAspect)) };
  const left = Math.max(0, Math.floor((width - crop.width) / 2));
  const top = Math.max(0, Math.floor((height - crop.height) / 2));
  return sharp(buffer)
    .extract({ left, top, width: crop.width, height: crop.height })
    .toBuffer();
}

function imageOutputFormatFromBuffer(buffer, fallbackFormat = 'png') {
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50 && buffer?.[2] === 0x4e && buffer?.[3] === 0x47) return 'png';
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8 && buffer?.[2] === 0xff) return 'jpeg';
  if (buffer?.slice(0, 4).toString('ascii') === 'RIFF' && buffer?.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return fallbackFormat;
}

async function storeGeneratedImages(buffers, projectUuid, canvasRow, outputFormat = 'png') {
  const localUrls = [];
  for (const buffer of buffers) {
    if (!buffer?.length) continue;
    const detectedFormat = imageOutputFormatFromBuffer(buffer, outputFormat);
    const { ext, mimeType } = outputFormatExtension(detectedFormat);
    const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
    const storedName = `${sha1}.${ext}`;
    const fullPath = path.join(assetsDir(projectUuid), storedName);
    if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, buffer);
    await mirrorStoredAsset(projectUuid, storedName, fullPath, mimeType);
    const stat = fs.statSync(fullPath);
    await upsertAssetRecord(canvasRow, {
      originalName: storedName,
      storedName,
      relativePath: assetRelativePath(projectUuid, storedName),
      mimeType,
      byteSize: stat.size,
      sha1,
      sourceType: 'generated'
    });
    localUrls.push(`/assets/${projectUuid}/${storedName}`);
  }
  return localUrls;
}

function isImageBuffer(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return true;
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return true;
  return false;
}

function parsePngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseJpegDimensions(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += length;
  }
  return null;
}

function parseWebpDimensions(buffer) {
  if (!buffer || buffer.length < 30) return null;
  if (buffer.slice(0, 4).toString('ascii') !== 'RIFF' || buffer.slice(8, 12).toString('ascii') !== 'WEBP') return null;
  const chunk = buffer.slice(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buffer.length >= 30) {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  return null;
}

async function imageBufferDimensions(buffer) {
  const sharp = getSharp();
  if (sharp) {
    try {
      const metadata = await sharp(buffer).metadata();
      const width = Number(metadata.width || 0);
      const height = Number(metadata.height || 0);
      if (width > 0 && height > 0) return { width, height };
    } catch {
      // Fall through to the lightweight parsers below.
    }
  }
  return parsePngDimensions(buffer) || parseJpegDimensions(buffer) || parseWebpDimensions(buffer);
}

function expectedAspectFromRatio(ratio) {
  if (!ratio || ratio === 'auto') return null;
  const [rawW, rawH] = String(ratio).split(':').map(Number);
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) return null;
  return rawW / rawH;
}

function requiredLongEdgeForImageResolution(resolution) {
  const value = String(resolution || '').trim().toUpperCase();
  if (value === '4K') return 3000;
  if (value === '2K') return 1800;
  return 0;
}

async function validateGeminiGeneratedImageBuffers(buffers, ratio, resolution) {
  const expectedAspect = expectedAspectFromRatio(ratio);
  const requiredLongEdge = requiredLongEdgeForImageResolution(resolution);
  if (!expectedAspect && !requiredLongEdge) return;

  for (const buffer of buffers || []) {
    const dimensions = await imageBufferDimensions(buffer);
    if (!dimensions) continue;
    const { width, height } = dimensions;
    if (expectedAspect) {
      const actualAspect = width / height;
      const relativeDiff = Math.abs(actualAspect - expectedAspect) / expectedAspect;
      if (relativeDiff > 0.06) {
        throw new Error(`Nano-banana Pro 返回图片比例 ${width}x${height} 与所选 ${ratio} 不一致，已阻止保存。`);
      }
    }
    if (requiredLongEdge && Math.max(width, height) < requiredLongEdge) {
      throw new Error(`Nano-banana Pro ${resolution} 参数没有生效，接口返回 ${width}x${height}，已阻止保存为假 ${resolution}。`);
    }
  }
}

function decodeImageBase64(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const dataUrlMatch = raw.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  const encoded = dataUrlMatch ? dataUrlMatch[1] : raw;
  if (encoded.length < 80) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(encoded.replace(/\s+/g, ''))) return null;
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const buffer = Buffer.from(normalized, 'base64');
    return isImageBuffer(buffer) ? buffer : null;
  } catch {
    return null;
  }
}

function collectOpenAiImageCandidates(payload) {
  const buffers = [];
  const urls = [];
  const seenBuffers = new Set();
  const seenUrls = new Set();
  const seenObjects = new Set();

  const addBuffer = (buffer) => {
    if (!isImageBuffer(buffer)) return;
    const hash = crypto.createHash('sha1').update(buffer).digest('hex');
    if (seenBuffers.has(hash)) return;
    seenBuffers.add(hash);
    buffers.push(buffer);
  };

  const addUrl = (url) => {
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value) || seenUrls.has(value)) return;
    seenUrls.add(value);
    urls.push(value);
  };

  const visit = (value, key = '', depth = 0) => {
    if (value == null || depth > 8) return;
    if (typeof value === 'string') {
      if (/^data:image\//i.test(value)) {
        const buffer = decodeImageBase64(value);
        if (buffer) addBuffer(buffer);
        return;
      }
      const lowerKey = String(key || '').toLowerCase();
      if (
        lowerKey === 'b64_json' ||
        lowerKey === 'image_base64' ||
        lowerKey === 'image_b64' ||
        lowerKey === 'image_data' ||
        lowerKey === 'imagedata' ||
        lowerKey === 'image_bytes' ||
        lowerKey === 'imagebytes' ||
        lowerKey === 'inline_data' ||
        lowerKey === 'inlinedata' ||
        lowerKey === 'bytes_base64_encoded' ||
        lowerKey === 'bytesbase64encoded' ||
        lowerKey === 'base64' ||
        lowerKey === 'image' ||
        lowerKey === 'data'
      ) {
        const buffer = decodeImageBase64(value);
        if (buffer) addBuffer(buffer);
        return;
      }
      if (
        lowerKey === 'url' ||
        lowerKey === 'uri' ||
        lowerKey === 'href' ||
        lowerKey.endsWith('_url') ||
        lowerKey.endsWith('url')
      ) {
        addUrl(value);
      }
      return;
    }

    if (Buffer.isBuffer(value)) {
      addBuffer(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }

    if (typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    for (const [childKey, childValue] of Object.entries(value)) {
      visit(childValue, childKey, depth + 1);
    }
  };

  visit(payload);
  return { buffers, urls };
}

async function fetchImageBufferFromUrl(url) {
  const response = await axios.get(String(url), {
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxRedirects: 5
  });
  const buffer = Buffer.from(response.data);
  if (!isImageBuffer(buffer)) {
    const contentType = String(response.headers?.['content-type'] || '');
    throw new Error(`image url did not return an image${contentType ? ` (${contentType})` : ''}`);
  }
  return buffer;
}

async function resolveOpenAiImageBuffers(responseData) {
  const candidates = collectOpenAiImageCandidates(responseData);
  const urlBuffers = [];
  for (const url of candidates.urls) {
    try {
      urlBuffers.push(await fetchImageBufferFromUrl(url));
    } catch (error) {
      console.error('download OpenAI image url failed', url, error?.response?.status || error?.message || String(error));
    }
  }
  return [...candidates.buffers, ...urlBuffers];
}

function summarizeOpenAiImageResponseWithoutData(responseData) {
  const messages = [];
  const seen = new Set();
  const messageKeys = new Set(['error', 'message', 'content', 'detail', 'reason', 'status', 'code', 'type', 'refusal', 'finish_reason']);
  const seenObjects = new Set();

  const addMessage = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > 500 || seen.has(text)) return;
    seen.add(text);
    messages.push(text);
  };

  const visit = (value, key = '', depth = 0) => {
    if (value == null || depth > 6 || messages.length >= 5) return;
    const lowerKey = String(key || '').toLowerCase();
    if (typeof value === 'string') {
      if (messageKeys.has(lowerKey) || lowerKey.includes('error') || lowerKey.includes('reason')) addMessage(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey, depth + 1);
  };

  visit(responseData);
  return messages.length
    ? `OpenAI image response did not include image data: ${messages.join(' | ')}`
    : 'OpenAI image response did not include image data';
}

function isOpenAiImageNoDataError(error) {
  return /openai image response did not include image data|image response did not include image data/i.test(errorMessageFrom(error));
}

function isImageGatewayHtml400(error) {
  const status = Number(error?.response?.status || 0);
  const payload = error?.response?.data;
  const message = typeof payload === 'string' ? payload : errorMessageFrom(error);
  return status === 400 && /<html|<title>\s*400 bad request|<center>\s*alb\s*<\/center>/i.test(String(message || ''));
}

/**
 * 上游限流 / 配额用尽。
 *
 * 2026-08-26 用户在 Nano Banana Pro 上看到的原文是
 * `litellm.RateLimitError: ... Vertex_aiException - {"error":{"code":429,
 * "message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}`。
 *
 * 只看 HTTP status 不够：网关有时把上游的 429 包在 200/500 的响应体里，
 * 所以正文里的 RateLimitError / RESOURCE_EXHAUSTED / quota 也要认。
 */
/**
 * 上游报错的**原始**文本。
 *
 * 不能走 errorMessageFrom —— 它已经把限流那类错映射成中文了，
 * 再拿映射后的结果去判断「这是不是限流」永远判不出来（改完第一版当场被测试抓到）。
 */
function rawProviderErrorText(error) {
  const payload = error?.response?.data;
  let payloadText = '';
  if (typeof payload === 'string') payloadText = payload;
  else if (payload) {
    try {
      payloadText = JSON.stringify(payload);
    } catch {
      payloadText = '';
    }
  }
  return `${payloadText} ${error?.message || ''} ${error?.code || ''}`;
}

function isRateLimitedProviderError(error) {
  const status = Number(error?.response?.status || 0);
  if (status === 429) return true;
  const text = rawProviderErrorText(error);
  return /RateLimitError|RESOURCE_EXHAUSTED|rate limit|too many requests|resource has been exhausted|check quota/i.test(text);
}

function isRetryableImageProviderError(error) {
  const status = Number(error?.response?.status || 0);
  if (isImageGatewayHtml400(error)) return true;
  if (isRateLimitedProviderError(error)) return true;
  if ([408, 425, 500, 502, 503, 504].includes(status)) return true;
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(error?.code || error?.message || ''));
}

/**
 * 重试等多久。
 *
 * 网关抽风（502 / 连接断）零点几秒后就好了，所以原来一律 900ms × 次数。
 * 但上游配额用尽是**按分钟结算**的，0.9 / 1.8 / 2.7 秒重试三次纯属白等 ——
 * 用户看到的就是「重试完还是那句英文报错」。限流单独给一条更长的退避。
 */
/**
 * 限流失败时给用户看的话。原来直接把 litellm 那串英文栈丢出去，
 * 里面没有一个字告诉用户接下来该干什么。
 */
function rateLimitedProviderMessage(model, attempts) {
  const label = String(model || '图片模型');
  const tried = Number(attempts) > 1 ? `已自动重试 ${attempts} 次，` : '';
  return `${label} 触发了上游限流（配额用尽 429），${tried}稍等一会儿再点生成；着急的话先换一个模型。`;
}

function imageRetryDelayMs(error, attempt) {
  const step = Math.max(1, Number(attempt) || 1);
  if (isRateLimitedProviderError(error)) return Math.min(12_000, 2_000 * 2 ** (step - 1));
  return 900 * step;
}

function isGenerationCancelled(error, signal) {
  return Boolean(
    signal?.aborted ||
    error?.name === 'AbortError' ||
    error?.name === 'CanceledError' ||
    error?.code === 'ERR_CANCELED'
  );
}

async function generateOpenAiImages(params, projectUuid, canvasRow) {
  requireOpenAiKey();
  const repaintConfig = imageRepaintService.normalizeRepaintConfig(params.repaint);
  const signal = params.signal;
  const throwIfCancelled = () => {
    if (!signal?.aborted) return;
    const error = new Error('image generation cancelled');
    error.name = 'AbortError';
    throw error;
  };
  const onProgress = typeof params.onProgress === 'function' ? params.onProgress : null;
  const reportProgress = (value) => {
    if (!onProgress) return;
    const progressPercent = Math.max(1, Math.min(96, Math.round(Number(value || 0) || 0)));
    try {
      onProgress(progressPercent);
    } catch {
      // Progress reporting should never fail the provider request.
    }
  };
  const quality = normalizeImageQuality(params.quality);
  const model = normalizeImageModel(params.model);
  const providerModel = openAIImageProvider.providerModelForImage(model);
  const gptImageModel = isGptImageModel(model);
  const geminiImageParamModel = openAIImageProvider.isGeminiImageParamModel(model);
  const geminiInteractionsImageModel = openAIImageProvider.isGeminiInteractionsImageModel(model);
  const volcengineImageModel = openAIImageProvider.isVolcengineImageModel(model);
  const outputFormat = repaintConfig ? 'png' : geminiInteractionsImageModel ? 'jpeg' : 'png';
  const nativeOnly = Boolean(params.nativeOnly);
  const strictResolution = Boolean(params.strictResolution);
  const ratio = openAIImageProvider.normalizeImageRatio(model, params.ratio);
  const resolution = openAIImageProvider.normalizeImageResolution(model, params.resolution);
  const size = openAIImageProvider.imageSizeForModel(model, ratio, resolution);
  const geminiImageParams = geminiImageParamModel
    ? openAIImageProvider.geminiImageParamsForModel(model, ratio, resolution)
    : null;
  const geminiCompatibleImageParams = geminiImageParamModel
    ? openAIImageProvider.geminiCompatibleImageParamsForModel(model, ratio, resolution)
    : null;
  const aspectRatio = !gptImageModel && ratio && ratio !== 'auto' ? String(ratio) : '';
  if (!gptImageModel && !geminiImageParamModel && !volcengineImageModel && aspectRatio && !size) {
    const nativeRatios = (openAIImageProvider.getImageModelRule(model).nativeRatios || []).join('、');
    throw new Error(`Nano-banana Pro 当前只稳定支持原生比例 ${nativeRatios}；请选择这些比例之一，或切换到 GPT image 2.0。`);
  }
  const count = openAIImageProvider.normalizeImageCount(model, params.count);
  const user = canvasRow?.owner_id ? String(canvasRow.owner_id) : undefined;
  const requestedImageUrls = (params.images || []).filter(Boolean);
  if (repaintConfig && !requestedImageUrls.includes(repaintConfig.sourceUrl)) {
    requestedImageUrls.unshift(repaintConfig.sourceUrl);
  }
  const resolvedImageResults = await Promise.all(
    requestedImageUrls.map(async (url) => ({ url, image: await resolveToOpenAiImageInput(url, projectUuid) }))
  );
  const missingImageUrls = resolvedImageResults.filter((item) => !item.image).map((item) => item.url);
  if (missingImageUrls.length) {
    const error = new Error(`\u6709 ${missingImageUrls.length} \u5f20\u53c2\u8003\u56fe\u65e0\u6cd5\u8bfb\u53d6\uff0c\u8bf7\u91cd\u65b0\u5bfc\u5165\u540e\u518d\u751f\u6210\u3002`);
    error.code = 'REFERENCE_IMAGE_UNAVAILABLE';
    error.referenceUrls = missingImageUrls;
    throw error;
  }
  const resolvedInputImages = resolvedImageResults.map((item) => item.image);
  const repaintSourceInput = repaintConfig
    ? resolvedImageResults.find((item) => item.url === repaintConfig.sourceUrl)?.image || resolvedInputImages[0]
    : null;
  const repaintMaskInput = repaintConfig
    ? await resolveToOpenAiImageInput(repaintConfig.maskUrl, projectUuid)
    : null;
  if (repaintConfig) {
    imageRepaintService.assertReadableImageInput(repaintSourceInput, '局部重绘原图');
    imageRepaintService.assertReadableImageInput(repaintMaskInput, '局部重绘遮罩');
  }
  const inputImages = geminiImageParamModel || gptImageModel || volcengineImageModel
    ? resolvedInputImages
    : await Promise.all(resolvedInputImages.map((image) => prepareNanoEditInput(image, ratio, resolution, model)));
  const providerInputImages = repaintConfig && !gptImageModel && !volcengineImageModel
    ? [...inputImages, repaintMaskInput]
    : inputImages;
  const canRequestMultiple = gptImageModel || (volcengineImageModel && openAIImageProvider.seedreamSupportsSequential(model));

  const requestImageBuffers = async (requestCount) => {
    throwIfCancelled();
    let response;
    const promptText = repaintConfig
      ? gptImageModel || volcengineImageModel
        ? params.prompt || ''
        : imageRepaintService.buildGeminiRepaintPrompt(params.prompt)
      : geminiImageParamModel
      ? openAIImageProvider.geminiImagePrompt(params.prompt, ratio, inputImages.length > 0)
      : !gptImageModel && !volcengineImageModel && aspectRatio && inputImages.length
        ? `${params.prompt || ''}\n\nOutput as a native ${aspectRatio} image composition. Keep the complete referenced subject visible, including head, feet, hands, and clothing edges. Do not crop off important parts. Do not stretch, squeeze, pad, or blur-fill a square image into this ratio.`
        : params.prompt || '';
    if (repaintConfig && gptImageModel) {
      response = await requestOpenAiMaskedImageEdit({
        model,
        promptText,
        sourceInput: repaintSourceInput,
        maskInput: repaintMaskInput,
        size,
        requestCount,
        user,
        quality,
        signal
      });
    } else if (volcengineImageModel) {
      requireLlmKey();
      const seedreamImages = [];
      for (const image of providerInputImages) {
        const url = imageInputProviderUrl(image) || imageInputDataUrl(image);
        if (url) seedreamImages.push(url);
      }
      response = await axios.post(
        `${llmBaseUrl}/volcengine/api/v3/images/generations`,
        openAIImageProvider.seedreamRequestBody({
          model,
          prompt: promptText,
          ratio,
          resolution,
          images: seedreamImages,
          count: requestCount,
          outputFormat,
        }),
        {
          headers: {
            Authorization: `Bearer ${currentLlmKey()}`,
            'Content-Type': 'application/json',
          },
          signal,
          timeout: 300_000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        },
      );
    } else if (geminiInteractionsImageModel) {
      try {
        response = await requestGeminiInteractionImage({
          model,
          promptText,
          inputImages: providerInputImages,
          ratio,
          resolution,
          signal
        });
      } catch (interactionError) {
        if (params.nativeOnly || !isGeminiInteractionsUnsupported(interactionError)) throw interactionError;
        console.warn('Gemini native image endpoint is unavailable; falling back to OpenAI-compatible image request:', errorMessageFrom(interactionError));
      }
    } else if (geminiImageParamModel && !geminiInteractionsImageModel) {
      const imageConfig = openAIImageProvider.geminiImageConfigForModel(model, ratio, resolution);
      const responseImageConfig = geminiImageResponseFormatFromConfig(imageConfig);
      const parts = [{ text: promptText || 'Generate an image.' }];
      for (const image of providerInputImages) {
        const part = geminiNativePartForImage(image);
        if (part) parts.push(part);
      }
      try {
        response = await axios.post(
          `${geminiNativeBaseUrl()}/v1beta/models/${encodeURIComponent(providerModel)}:generateContent`,
          {
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
              responseFormat: {
                image: responseImageConfig
              }
            }
          },
          {
            headers: {
              Authorization: `Bearer ${currentOpenaiKey()}`,
              'Content-Type': 'application/json'
            },
            signal,
            timeout: 300_000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          }
        );
      } catch (nativeError) {
        if (isGenerationCancelled(nativeError, signal)) throw nativeError;
        console.warn('Gemini native image request failed; falling back to OpenAI-compatible image request:', errorMessageFrom(nativeError));
      }
    }

    if (!response && geminiImageParamModel) {
      const content = [{ type: 'text', text: promptText || 'Generate an image.' }];
      for (const image of providerInputImages) {
        const url = imageInputProviderUrl(image) || imageInputDataUrl(image);
        if (url) content.push({ type: 'image_url', image_url: { url } });
      }
      const messageContent = providerInputImages.length ? content : promptText || 'Generate an image.';
      try {
        response = await axios.post(
          `${openaiBaseUrl}/chat/completions`,
          {
            model: providerModel,
            messages: [{ role: 'user', content: messageContent }],
            modalities: providerInputImages.length ? ['text', 'image'] : ['image'],
            output_format: outputFormat,
            n: requestCount,
            user,
            ...geminiCompatibleImageParams
          },
          {
            headers: {
              Authorization: `Bearer ${currentOpenaiKey()}`,
              'Content-Type': 'application/json'
            },
            signal,
            timeout: 300_000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity
          }
        );
      } catch (chatError) {
        if (!isImageGatewayHtml400(chatError)) throw chatError;
        if (!providerInputImages.length) throw chatError;
        console.warn('Gemini URL image request was rejected by the gateway; retrying with multipart image edits.');
        response = await requestGeminiCompatibleImageEdit({
          model,
          promptText,
          inputImages: providerInputImages,
          ratio,
          resolution,
          requestCount,
          user,
          outputFormat,
          quality,
          signal
        });
      }
    } else if (!response && providerInputImages.length) {
      const formData = new FormData();
      formData.append('model', providerModel);
      formData.append('prompt', promptText);
      formData.append('quality', quality);
      formData.append('output_format', outputFormat);
      formData.append('n', String(requestCount));
      if (gptImageModel && size && size !== 'auto') formData.append('size', size);
      if (geminiImageParams) {
        for (const [key, value] of Object.entries(geminiImageParams)) {
          formData.append(key, String(value));
        }
      }
      if (!gptImageModel && size) formData.append('size', size);
      if (user) formData.append('user', user);
      for (const image of providerInputImages) {
        formData.append('image[]', fs.createReadStream(image.filePath), path.basename(image.filePath));
      }
      response = await axios.post(`${openaiBaseUrl}/images/edits`, formData, {
        headers: { Authorization: `Bearer ${currentOpenaiKey()}`, ...formData.getHeaders() },
        signal,
        timeout: 300_000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
    } else if (!response) {
      response = await axios.post(
        `${openaiBaseUrl}/images/generations`,
        {
          model: providerModel,
          prompt: promptText,
          quality,
          ...(gptImageModel
            ? { size }
            : geminiImageParams
              ? geminiCompatibleImageParams
            : size
              ? { size }
              : {}),
          output_format: outputFormat,
          n: requestCount,
          user
        },
        {
          headers: {
            Authorization: `Bearer ${currentOpenaiKey()}`,
            'Content-Type': 'application/json'
          },
          signal,
          timeout: 300_000
        }
      );
    }

    throwIfCancelled();
    let buffers = await resolveOpenAiImageBuffers(response.data);
    if (!buffers.length) throw new Error(summarizeOpenAiImageResponseWithoutData(response.data));
    if (params.panoramaErpTargetRatio) {
      buffers = await Promise.all(buffers.map((buffer) => normalizeImageBufferAspectRatio(buffer, params.panoramaErpTargetRatio)));
    }
    if (geminiImageParamModel) {
      const strictProviderRatio = params.panoramaErpTargetRatio ? 'auto' : ratio;
      await validateGeminiGeneratedImageBuffers(buffers, strictProviderRatio, '1K');
      if (strictResolution) {
        await validateGeminiGeneratedImageBuffers(buffers, strictProviderRatio, resolution);
      } else {
        const upscaleResult = await imageUpscaleService.ensureRequestedResolution({
          buffers,
          requestedResolution: resolution,
          outputFormat,
          temporaryDirectory: tmpDir(),
          getDimensions: imageBufferDimensions,
          createId: randomId,
          fallbackConfig: openAIImageProvider.getImageModelRule(model).resolutionFallback,
        });
        buffers = upscaleResult.buffers;
        await validateGeminiGeneratedImageBuffers(buffers, ratio, resolution);
        for (const detail of upscaleResult.details) {
          if (detail.scaleFactor > 1) {
            console.info('Nano-banana image resolution fallback applied', {
              requestedResolution: resolution,
              method: detail.method,
              scaleFactor: detail.scaleFactor,
              sourceDimensions: detail.sourceDimensions,
              outputDimensions: detail.outputDimensions,
            });
          }
        }
      }
    }
    if (repaintConfig && !gptImageModel && repaintConfig.compositeOutput) {
      buffers = await imageRepaintService.hardCompositeRepaintBuffers({
        sharp: getSharp(),
        generatedBuffers: buffers,
        sourceInput: repaintSourceInput,
        maskInput: repaintMaskInput,
      });
    }
    return buffers;
  };

  try {
    let buffers = [];
    let attempts = 0;
    let didBulkAttempt = false;
    const maxAttempts = canRequestMultiple
      ? count + 1
      : geminiImageParamModel
        ? count + 1
        : Math.max(count * 2, count + 3);
    reportProgress(3);
    while (buffers.length < count && attempts < maxAttempts) {
      throwIfCancelled();
      const remaining = count - buffers.length;
      const requestCount = canRequestMultiple && !didBulkAttempt ? remaining : 1;
      if (requestCount > 1) didBulkAttempt = true;
      let batch;
      try {
        reportProgress(6 + (buffers.length / Math.max(count, 1)) * 82);
        batch = await requestImageBuffers(requestCount);
      } catch (error) {
        throwIfCancelled();
        attempts += 1;
        if (requestCount > 1) {
          console.warn(`bulk image generation request for ${requestCount} image(s) failed; retrying one by one:`, errorMessageFrom(error));
          continue;
        }
        if (isOpenAiImageNoDataError(error) && attempts < maxAttempts) {
          console.warn('single image generation returned no image data; retrying:', errorMessageFrom(error));
          continue;
        }
        if (isRetryableImageProviderError(error) && attempts < maxAttempts) {
          console.warn('image provider gateway request failed; retrying:', errorMessageFrom(error));
          await new Promise((resolve) => setTimeout(resolve, imageRetryDelayMs(error, attempts)));
          continue;
        }
        if (isRateLimitedProviderError(error)) {
          throw new Error(rateLimitedProviderMessage(model, attempts));
        }
        if (isImageGatewayHtml400(error)) {
          throw new Error('\u56fe\u7247\u63a5\u53e3\u7f51\u5173\u62d2\u7edd\u4e86\u672c\u6b21\u8bf7\u6c42\uff0c\u5df2\u81ea\u52a8\u538b\u7f29\u53c2\u8003\u56fe\u5e76\u91cd\u8bd5\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002');
        }
        if (buffers.length) break;
        throw error;
      }
      buffers = [...buffers, ...batch];
      reportProgress(8 + (Math.min(buffers.length, count) / Math.max(count, 1)) * 84);
      attempts += 1;
      if (batch.length >= remaining) break;
    }
    buffers = buffers.slice(0, count);
    if (!buffers.length) throw new Error('image response did not include image data');
    if (buffers.length < count) {
      console.warn(`image generation requested ${count} image(s), but only received ${buffers.length}`);
    }
    reportProgress(96);
    throwIfCancelled();
    return storeGeneratedImages(buffers, projectUuid, canvasRow, outputFormat);
  } finally {
    for (const image of resolvedInputImages) {
      for (const cleanupFile of image?.cleanupFiles || []) {
        fs.rmSync(cleanupFile, { force: true });
      }
    }
    for (const cleanupFile of repaintMaskInput?.cleanupFiles || []) {
      fs.rmSync(cleanupFile, { force: true });
    }
  }
}

async function submitGenImage(params) {
  const model = normalizeImageModel(params.model);
  const ratio = params.ratio || '1:1';
  const resolution = params.resolution || '1K';
  let modelType;
  let payload;

  if (isGptImageModel(model)) {
    modelType = 'GPT';
    payload = {
      prompt: params.prompt,
      imgRatio: ratio,
      quality: normalizeImageQuality(params.quality),
      modelVersion: 'gpt-image-2',
      n: params.count || 1
    };
  } else {
    modelType = 'NANOBANANA';
    payload = {
      prompt: params.prompt,
      imgRatio: ratio,
      resolution,
      modelVersion: model,
      n: params.count || 1
    };
  }

  if (params.images?.length) payload.images = params.images;
  return createMivoMessage(payload, 'freeform', 'image', modelType, model);
}

async function submitGenAudio(params) {
  const model = params.model || 'tts-default';
  return createMivoMessage(
    { prompt: params.prompt || '', type: params.type || 'tts', voice: params.voice || 'default', modelVersion: model },
    'freeform',
    'text',
    'ALICLOUD',
    model
  );
}

async function pollMivoResult(jobId) {
  const client = await mivoHttp();
  const response = await client.get(`/api/v1/message/${jobId}`);
  const data = response.data;
  const content = data.content || {};
  const statusText = content.status || data.status || 'processing';
  const statusMap = { pending: 0, processing: 1, completed: 2, failed: 3 };
  let urls = [];
  if (Array.isArray(content.images) && content.images.length) urls = content.images;
  else if (Array.isArray(content.video_files) && content.video_files.length) urls = content.video_files;
  else if (Array.isArray(content.videos) && content.videos.length) {
    urls = content.videos.map((video) => video.object_id || video._id || video.fileId || video.id || '').filter(Boolean);
  } else if (Array.isArray(content.files) && content.files.length) urls = content.files;

  urls = urls.map((url) => (String(url).startsWith('http') ? url : `${mivoBaseUrl}/api/v1/file/image/${url}`));
  const status = statusMap[statusText] ?? 1;
  return {
    status,
    progressPercent: status === 2 ? 100 : status === 1 ? content.progress || 50 : 0,
    urls,
    error: data.error || content.error
  };
}

async function uploadFileToMivo(filePath) {
  const session = await getMivoToken();
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath), path.basename(filePath));
  const response = await axios.post(`${mivoBaseUrl}/api/v1/file/`, formData, {
    headers: { ...formData.getHeaders(), Authorization: `Bearer ${session}` }
  });
  const items = Array.isArray(response.data) ? response.data : [response.data];
  const fileId = items[0]?.object_id || items[0]?._id;
  if (!fileId) throw new Error('濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣閿濆棭妫勯梺鍝勵儎缁舵岸寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閻愵剙鍔ゆい顓犲厴瀵鏁愭径濠勭杸濡炪倖甯婇悞锕傚磿閹剧粯鈷戦柟鑲╁仜婵″ジ鏌涙繝鍌涘仴鐎殿喛顕ч埥澶愬閳哄倹娅囬梻浣瑰缁诲倸螞濞戔懞鍥Ψ瑜忕壕钘壝归敐鍛儓鐏忓繘姊洪崨濠庢畷濠电偛锕ら锝嗙節濮橆厼浜滈梺绋跨箰閻ㄧ兘骞忔繝姘厽閹艰揪绲鹃弳鈺傘亜椤撶偟澧涘ǎ鍥э攻缁傛帞鈧綆鍋€閹锋椽姊洪崨濠勭畵閻庢凹鍙冨畷鎶芥惞閸︻厾锛滈柣鐘叉穿鐏忔瑦鏅堕敂閿亾濞堝灝鏋涙い顓㈡敱娣囧﹪骞栨担鑲濄劑鏌曡箛濠傚⒉闁哄鎮傚缁樻媴閾忓箍鈧﹪鏌涢幘瀵哥疄闁轰礁顑呴—鍐Χ韫囨艾鎮呴梺鍝勬噺閻╊垶鍨鹃弮鍫濈妞ゆ柨妲堣楠炴牜鍒掗崗澶婁壕闁肩⒈鍓欓崵顒€鈹戦悩鍨毄闁稿濮锋禍绋库枎閹惧磭鐛ラ梺鍝勮癁鐏炶姤顓块梺鑽ゅТ濞诧妇绮婇弶鎳筹綁宕奸妷锔惧帾闂婎偄娲ら敃銉モ枍閸℃稒鐓涢柛娑卞枤缁犵偞鎱ㄦ繝鍐┿仢妤犵偞鍔栭幆鏃堟晲閸モ晜娈煎┑鐘殿暯濡插懘宕戦崨瀛樺剮妞ゆ牗绻冮ˉ銈夋⒒娓氣偓濞佳囨晬韫囨稑宸濇い鏍ュ€楅梻顖涚節閻㈤潧浠╅柟娲讳簽瀵板﹪骞戦幇鈺€姹楅梺鍛婂姀閺呮繈銆?Mivo 濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣閿濆棭妫勯梺鍝勵儎缁舵岸寮诲☉妯锋婵鐗婇弫楣冩⒑閸涘﹦鎳冪紒缁樺姍濠€渚€姊虹粙璺ㄧ闁告艾顑囩槐鐐哄箣閿旂晫鍘遍梺闈涱焾閸庨亶鍩€椤掆偓濠€閬嶅箲閵忕姭妲堟慨妤€妫楅弲鐘差渻閵堝棙顥嗙€规洜鏁婚幆鍕償閿濆洨锛滈梺缁樺姦閸撴瑩宕濋妶鍡欑缁绢參顥撶弧鈧悗娈垮枛椤攱淇婇崼鏇炶Е闁靛牆鎳忕拹锟犳煃瑜滈崜銊х礊閸℃稑纾婚柛娑樼摠閸嬬喖鏌￠崘銊у闁抽攱鍨块弻鐔兼嚃閳轰椒绮舵繝纰夌磿閺咁偆妲愰幒鏃€瀚氶柤纰卞墮閳敻鎮楀▓鍨灕妞ゆ泦鍥х叀濠㈣埖鍔曢～鍛存煟濡椿鍟忛柛鐔奉儐缁绘繂顕ラ柨瀣凡闁逞屽墯閸旀瑥鐣烽幋锕€绠荤紓浣姑埀顒€鐏氶幈銊ノ熼悡搴′粯婵犫拃鍐惧殶闁逞屽墯椤旀牠宕板Δ鍛畺闁稿本姘ㄩ弳锕傛煙閻戞﹩娈曢柛濠囶棑缁辨帡顢欏▎鐐秷闁诲孩鑹鹃妶绋款潖缂佹ɑ濯撮柛娑橈龚绾偓婵＄偑鍊ら崢濂告偋韫囨稑鐒垫い鎺嶈兌閳绘捇鏌￠崨顔剧畼闁告帗甯″畷濂稿Ψ閵壯冨Е婵＄偑鍊栫敮鎺斺偓姘煎弮閸╂盯骞嬮悩鐢碉紲闁诲函缍嗘禍婊堟儍閿涘嫧鍋撶憴鍕仩闁稿骸纾Σ鎰板箻閹颁礁鎮戦梺鍛婄矊閸燁偅瀵奸幇顒夋富闁靛牆妫欑粚璺ㄧ磽瀹ュ嫮顦︽い鏇稻缁绘繂顫濋鈹垮妽閵囧嫰寮崶顬挻绻涢崨顓犵劯婵﹦绮幏鍛村川婵犲倹娈樻繝鐢靛仩椤曟粎绮婚幘宕囨殾婵犲﹤鍟犻弸搴ㄦ煙閹咃紞闁告棑绠戦—鍐Χ閸℃娼戦梺绋款儐閹瑰洭寮婚敐澶婂唨鐟滃宕戦姀鈶╁亾濞堝灝鏋涙い顓犲厴瀵偊骞囬鐐电獮婵犵數濮寸€氼噣寮堕幖浣光拻濞达綀娅ｇ敮娑欍亜閵娿儲鍤囬柟顔ㄥ嫮绡€闁搞儯鍔庨崣鍡楊渻閵堝棙灏甸柛鐘虫尵缁粯銈ｉ崘鈺佲偓鍨箾閹寸偟鎳愰柣鎺嶇矙閺岋綁顢橀悜鍥т紣濡炪値鍙€閸庡藝鏉堚晝纾兼い鏃傛櫕閹冲洨鈧娲樺浠嬪春閳ь剚銇勯幒宥夋濞存粍绮撻弻鐔煎传閸曨厜銈夋偣閹邦亜宓嗛柡灞剧洴閹垺顦版惔锝庡晪闂備礁鎼張顒勬儎椤栫偛绠栭柍鍝勬噹缁犳稑霉閿濆懏璐￠柡澶庮潐娣囧﹪濡堕崶顬儵鏌涚€ｎ剙浠辩€规洖缍婂畷褰掝敊閻愵剚顔曢梻浣筋嚃閸ㄥ爼宕戞繝鍌ょ€堕柕濞炬櫆閳锋垿鏌熼懖鈺佷粶闁逞屽墯閻楁洜鍙呴梺缁樻⒒閸樠囨嫅閻斿摜绠鹃柟瀛樼懃閻掓椽鏌℃担绋挎殻闁哄被鍔岄埞鎴﹀幢濮楀棙锟ユ俊鐐€х拹鐔煎磿闂堟侗娼栭柧蹇撴贡绾惧吋淇婇婵愬殭闂傚绉瑰娲倻閳哄倹鐝﹂梺鎼炲姀濞夋盯顢氶敐鍥ㄥ珰婵炴潙顑嗛～宥呪攽椤旀枻渚涢柛瀣嚇瀹曠喖宕橀瑙ｆ嫼闂佸憡绋戦敃銉р偓鍨懃闇夐柨婵嗘缁茶霉濠婂牏鐣洪柡宀€鍠栭幃婊冾潨閸℃鏆﹂梻浣虹帛閹歌煤濡吋宕叉繛鎴欏灩楠炪垺淇婇妶鍛殶妞ゆ柨顦—鍐Χ閸愩劌濮曠紓渚囧枟閹瑰洤顕?fileId');
  return fileId;
}

async function downloadMivoFile(fileId, savePath) {
  const session = await getMivoToken();
  const response = await axios.get(`${mivoBaseUrl}/api/v1/file/download/${fileId}`, {
    responseType: 'stream',
    headers: { Authorization: `Bearer ${session}` }
  });
  const contentType = response.headers['content-type'] || 'image/png';
  const ext = contentType.split('/')[1]?.split(';')[0] || 'png';
  const filePath = `${savePath}.${ext}`;
  try {
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      response.data.on('error', reject);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    throw error;
  }
  return { filePath, contentType };
}

async function downloadRemoteAsset(url, savePath) {
  const response = await axios.get(String(url), {
    responseType: 'stream',
    timeout: 120_000,
    maxRedirects: 5
  });
  const contentType = response.headers['content-type'] || mimeTypeFromName(url);
  const urlPath = safeUrlObject(url)?.pathname || String(url).split('#')[0].split('?')[0];
  const extFromUrl = path.extname(urlPath);
  const extFromMime = `.${(contentType.split('/')[1] || 'bin').split(';')[0]}`
    .replace(/[^a-zA-Z0-9.]/g, '')
    .toLowerCase();
  const ext = extFromUrl || extFromMime || '.bin';
  const filePath = `${savePath}${ext}`;
  try {
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      response.data.on('error', reject);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    throw error;
  }
  return { filePath, contentType };
}

function safeUrlObject(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function stringifyUnknownError(value, fallback = '请求失败') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === 'object') {
    const message = value.message || value.detail || value.error_description || value.reason;
    if (typeof message === 'string' && message.trim()) return message.trim();
    const nestedError = value.error;
    if (typeof nestedError === 'string' && nestedError.trim()) return nestedError.trim();
    if (nestedError && typeof nestedError === 'object') {
      const nested = stringifyUnknownError(nestedError, '');
      if (nested) return nested;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return String(value);
}

/**
 * ⚠️ 这个文件里有**三个** `errorMessageFrom` 定义（本文件另外两个在前面）。
 * 函数声明后者覆盖前者，所以**只有这一个是活的**，前面两个连同它们的
 * invalid_api_key / moderation / public_figure 映射全是死代码 —— 那些分支从来没跑过。
 * 要改上游报错的呈现，必须改这一个。（重复定义本身该清掉，但那是另一件事。）
 */
function errorMessageFrom(error) {
  const payload = error?.response?.data;
  let parsedPayload = payload;
  if (typeof payload === 'string') {
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      parsedPayload = payload;
    }
  }
  const payloadMessage = stringifyUnknownError(parsedPayload, '');
  /*
   * 上游限流 / 配额用尽。不拦这一条的话，节点上显示的就是整串
   * `litellm.RateLimitError: ... Vertex_aiException - {"code":429,"status":"RESOURCE_EXHAUSTED"}`
   * —— 里面没有一个字告诉用户接下来该干什么（2026-08-26 用户在 Nano Banana Pro 上碰到）。
   *
   * 这里不提模型名（这个函数拿不到），图片那条链路会给带模型名的版本。
   */
  const rawCode = String(
    parsedPayload?.code
    || parsedPayload?.error?.code
    || parsedPayload?.error_code
    || '',
  );
  const rawMessage = `${rawCode} ${payloadMessage} ${error?.message || ''}`;
  if (/RateLimitError|RESOURCE_EXHAUSTED|resource has been exhausted|too many requests|rate limit/i.test(rawMessage)) {
    return '上游模型在限流（配额用尽 429），稍等一会儿再点生成；着急的话先换一个模型。';
  }
  if (/InvalidParameter\.TaskTypeConstraint|identified your task as video editing/i.test(rawMessage)) {
    return 'Seedance 2.5 把这次当成了「视频编辑」，多模态下请用「根据参考生成新视频」的说法；真要改原片请切到视频编辑，比例用自适应、时长跟原片、参考视频至少 4 秒。';
  }
  if (/InvalidParameter\.TaskTypeMismatch/i.test(rawMessage)) {
    return 'Seedance 2.5 认为提示词和模式对不上。多模态请写成根据参考生成新视频；改原片请切到视频编辑。';
  }
  if (/InvalidParameter/i.test(rawMessage) && /Bad Request Request id/i.test(rawMessage)) {
    return 'Seedance 2.5 判定这次不是「多模态参考生成」（常见原因：提示词像在改原片）。请再点一次生成；真要改原片请切到视频编辑，比例用自适应、时长跟原片。';
  }
  if (payloadMessage) return payloadMessage;
  return stringifyUnknownError(error, '请求失败');
}

function redactedUrlForLog(url) {
  const parsed = safeUrlObject(url);
  if (parsed) return `${parsed.origin}${parsed.pathname}`;
  return String(url || '').split('?')[0];
}

function downloadAssetErrorMessage(error) {
  const status = Number(error?.response?.status || 0);
  if (status === 401 || status === 403) {
    return `外部视频链接已失效或无权限访问（HTTP ${status}），请重新导入或重新生成该视频`;
  }
  if (status === 404) {
    return '外部视频链接不存在或已经过期（HTTP 404），请重新导入或重新生成该视频';
  }
  const base = errorMessageFrom(error);
  return status ? `外部资源下载失败（HTTP ${status}）：${base}` : base;
}

function fileIdFromUrl(url) {
  const parsed = safeUrlObject(url);
  if (parsed) {
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || String(url);
  }
  const clean = String(url).split('#')[0].split('?')[0];
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1] || String(url);
}

function isMivoObjectId(value) {
  return /^[0-9a-f]{24}$/.test(String(value));
}

async function resolveToMivoRef(url, projectUuid) {
  if (!url) return '';
  if (String(url).startsWith('http')) {
    const last = fileIdFromUrl(url);
    return isMivoObjectId(last) ? last : url;
  }
  const filename = path.basename(url);
  const stem = filename.replace(/\.[^.]+$/, '');
  if (isMivoObjectId(stem)) return stem;
  const localPath = await ensureAssetLocalPath(projectUuid, filename);
  return uploadFileToMivo(localPath);
}

function generatedVideoRvStoragePlan(meta = {}, options = {}) {
  const ensureRvCompatibleVideos = Boolean(options.ensureRvCompatibleVideos);
  const sourceType = options.sourceType || 'generated';
  const shouldCreateRvCopy = ensureRvCompatibleVideos
    && meta.kind === 'video'
    && !isRvCompatibleGeneratedVideo(meta);
  return {
    shouldCreateRvCopy,
    sourceRecordType: shouldCreateRvCopy ? 'generated-original' : sourceType,
  };
}

function stableAssetExtension(meta = {}, fallbackName = '') {
  const fallbackExtension = path.extname(String(fallbackName || '')).toLowerCase();
  const knownExtensions = new Set([
    '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi',
    '.mp3', '.wav', '.aac', '.m4a', '.ogg',
    '.jpg', '.jpeg', '.png', '.webp', '.gif',
  ]);
  if (knownExtensions.has(fallbackExtension)) {
    return fallbackExtension;
  }
  const formats = String(meta.formatName || '').toLowerCase().split(',');
  if (formats.includes('mp4')) return '.mp4';
  if (formats.includes('webm')) return '.webm';
  if (formats.includes('matroska')) return '.mkv';
  if (formats.includes('avi')) return '.avi';
  return '.bin';
}

function storedMimeTypeForMeta(meta = {}, fallbackMimeType = '', storedName = '') {
  if (meta.kind === 'video') return mimeTypeFromName(storedName) || 'video/mp4';
  if (meta.kind === 'audio') return mimeTypeFromName(storedName) || 'audio/mpeg';
  return fallbackMimeType || meta.mimeType || mimeTypeFromName(storedName);
}

function moveDownloadedAsset(sourcePath, destinationPath) {
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) return destinationPath;
  if (fs.existsSync(destinationPath)) {
    fs.rmSync(sourcePath, { force: true });
  } else {
    fs.renameSync(sourcePath, destinationPath);
  }
  return destinationPath;
}

function taskOutputForStoredAsset(url, meta = {}, mimeType = '', compatibilityMetadata = {}) {
  return {
    url,
    mimeType: meta.kind === 'video' && isRvCompatibleGeneratedVideo(meta)
      ? 'video/mp4'
      : (meta.mimeType || mimeType),
    width: meta.width,
    height: meta.height,
    durationSec: meta.durationSec,
    metadata: {
      codecName: meta.codecName,
      codecProfile: meta.codecProfile,
      pixelFormat: meta.pixelFormat,
      audioCodecName: meta.audioCodecName,
      fps: meta.fps,
      formatName: meta.formatName,
      rvCompatible: meta.kind === 'video' ? isRvCompatibleGeneratedVideo(meta) : undefined,
      ...compatibilityMetadata,
    },
  };
}

async function downloadToAssets(urls, projectUuid, options = {}) {
  const strict = Boolean(options.strict);
  const sourceType = options.sourceType || 'generated';
  const ensureRvCompatibleVideos = Boolean(options.ensureRvCompatibleVideos);
  const requestedUrls = (urls || []).filter(Boolean);
  const prepared = [];
  const localUrls = [];
  const previewUrls = [];
  const outputs = [];
  const failures = [];
  const [canvasRows] = await getPool().query(
    'SELECT id, owner_id, title, data, created_at, updated_at FROM canvases WHERE id = ? LIMIT 1',
    [projectUuid]
  );
  const canvasRow = canvasRows[0] || null;

  // 第一阶段只负责把每个 provider 结果永久归档。多产物任务即使其中一条后续转码失败，
  // 后面的付费原片也已经安全落到本地、对象存储和资产表，不会因 strict 提前抛错而丢失。
  for (const url of requestedUrls) {
    let temporaryDownloadPath = '';
    try {
      const fileId = fileIdFromUrl(url);
      let stem = path.parse(fileId).name || randomId();
      // Some providers (e.g. MiniMax OSS) percent-encode the object key's
      // slashes, so fileId can arrive as a whole path like "a%2Fb%2Foutput_aigc.mp4".
      try { stem = decodeURIComponent(stem); } catch { /* keep raw stem */ }
      stem = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').replace(/_+$/, '').slice(0, 180) || randomId();
      // RV 路径先下载到唯一临时名。不能直接写 provider basename：两个签名 URL 都叫
      // output.mp4 时会互相覆盖，旧节点甚至会在用户不知情时变成另一条视频。
      const savePath = ensureRvCompatibleVideos
        ? path.join(tmpDir(), `generated-source-${randomId()}`)
        : path.join(assetsDir(projectUuid), stem);
      const isRemoteHttp = /^https?:\/\//i.test(String(url || ''));
      const shouldDirectDownload = isRemoteHttp && !isMivoObjectId(path.parse(fileId).name || fileId);
      const downloaded = shouldDirectDownload
        ? await downloadRemoteAsset(url, savePath)
        : await downloadMivoFile(path.parse(fileId).name || fileId, savePath);
      let filePath = downloaded.filePath;
      if (ensureRvCompatibleVideos) temporaryDownloadPath = filePath;
      let storedName = path.basename(filePath);
      const providerName = path.basename(safeUrlObject(url)?.pathname || storedName) || storedName;
      let storedMimeType = downloaded.contentType || mimeTypeFromName(storedName);
      const sourceMeta = await probeMediaMetadata(
        filePath,
        storedMimeType,
        storedName,
        { probeAv: ensureRvCompatibleVideos }
      );
      if (ensureRvCompatibleVideos && sourceMeta.kind !== 'video') {
        throw new Error('视频生成结果不是可识别的视频文件');
      }

      const storagePlan = generatedVideoRvStoragePlan(sourceMeta, {
        ensureRvCompatibleVideos,
        sourceType,
      });
      const sourceSha1 = ensureRvCompatibleVideos
        ? await sha1FileAsync(filePath)
        : path.parse(storedName).name;
      if (ensureRvCompatibleVideos) {
        const extension = stableAssetExtension(sourceMeta, storedName);
        storedName = `${sourceSha1}${storagePlan.shouldCreateRvCopy ? '_original' : ''}${extension}`;
        filePath = moveDownloadedAsset(filePath, path.join(assetsDir(projectUuid), storedName));
        temporaryDownloadPath = '';
        sourceMeta.extension = extension.slice(1);
        sourceMeta.byteSize = fs.statSync(filePath).size;
        storedMimeType = storedMimeTypeForMeta(sourceMeta, storedMimeType, storedName);
        sourceMeta.mimeType = storedMimeType;
      }
      const sourceAssetUrl = `/assets/${projectUuid}/${storedName}`;

      await mirrorStoredAsset(projectUuid, storedName, filePath, storedMimeType);
      if (canvasRow) {
        const stat = fs.statSync(filePath);
        await upsertAssetRecord(canvasRow, {
          originalName: providerName,
          storedName,
          relativePath: assetRelativePath(projectUuid, storedName),
          mimeType: storedMimeType,
          byteSize: stat.size,
          sha1: sourceSha1,
          sourceType: storagePlan.sourceRecordType,
        });
      }
      prepared.push({
        url,
        filePath,
        storedName,
        storedMimeType,
        providerName,
        sourceMeta,
        sourceAssetUrl,
        storagePlan,
      });
    } catch (error) {
      if (temporaryDownloadPath) fs.rmSync(temporaryDownloadPath, { force: true });
      prepared.push({ url, error });
    }
  }

  // 第二阶段才做兼容转码。每一条独立处理并汇总错误，避免一个坏片阻断其余原片归档。
  for (const entry of prepared) {
    if (entry.error) {
      const reason = downloadAssetErrorMessage(entry.error);
      console.error('download asset failed', redactedUrlForLog(entry.url), reason);
      failures.push(reason);
      if (!strict) {
        localUrls.push(entry.url);
        previewUrls.push(null);
        outputs.push({ url: entry.url });
      }
      continue;
    }

    try {
      let finalUrl = entry.sourceAssetUrl;
      let finalMeta = entry.sourceMeta;
      let compatibilityMetadata = {};
      if (entry.storagePlan.shouldCreateRvCopy) {
        if (!canvasRow) throw new Error('生成视频缺少画布记录，无法保存 RV 兼容版');
        console.info(
          `transcoding generated video for RV: canvas=${projectUuid} asset=${entry.storedName}`
          + ` codec=${entry.sourceMeta.codecName || 'unknown'} ${entry.sourceMeta.width || '?'}x${entry.sourceMeta.height || '?'} @${entry.sourceMeta.fps || '?'}fps`
        );
        const converted = await transcodeGeneratedVideoForRv(entry.filePath, entry.sourceMeta);
        const stored = await storeDerivedVideoAsset(
          projectUuid,
          canvasRow,
          converted.filePath,
          entry.providerName,
          'rv',
          { sourceType }
        );
        finalUrl = stored.url;
        finalMeta = stored.meta;
        compatibilityMetadata = {
          compatibilityTranscode: 'h264-yuv420p-crf12',
          providerOriginalUrl: entry.sourceAssetUrl,
          providerOriginalCodecName: entry.sourceMeta.codecName,
          providerOriginalCodecProfile: entry.sourceMeta.codecProfile,
          providerOriginalPixelFormat: entry.sourceMeta.pixelFormat,
          providerOriginalAudioCodecName: entry.sourceMeta.audioCodecName,
          providerOriginalByteSize: Number(entry.sourceMeta.byteSize || 0),
          providerOriginalWidth: entry.sourceMeta.width,
          providerOriginalHeight: entry.sourceMeta.height,
          providerOriginalFps: entry.sourceMeta.fps,
          providerOriginalDurationSec: entry.sourceMeta.durationSec,
        };
      }

      localUrls.push(finalUrl);
      outputs.push(taskOutputForStoredAsset(
        finalUrl,
        finalMeta,
        entry.storedMimeType,
        compatibilityMetadata
      ));
      if (options.includePreviews && String(entry.storedMimeType).startsWith('image/')) {
        previewUrls.push(await createDisplayImageAsset(
          projectUuid,
          entry.storedName,
          entry.filePath
        ));
      } else {
        previewUrls.push(null);
      }
    } catch (error) {
      const reason = downloadAssetErrorMessage(error);
      console.error('prepare downloaded asset failed', redactedUrlForLog(entry.url), reason);
      failures.push(reason);
      if (!strict) {
        localUrls.push(entry.sourceAssetUrl);
        previewUrls.push(null);
        outputs.push(taskOutputForStoredAsset(
          entry.sourceAssetUrl,
          entry.sourceMeta,
          entry.storedMimeType
        ));
      }
    }
  }

  if (strict && failures.length) {
    const detail = failures.length === 1
      ? failures[0]
      : `${failures[0]}（另有 ${failures.length - 1} 个结果处理失败）`;
    throw new Error(detail);
  }
  return options.includePreviews ? { urls: localUrls, previewUrls, outputs } : localUrls;
}

async function resolveVideoTrimSource(url, projectUuid, req = null) {
  const value = String(url || '').trim();
  if (!value) throw new Error('missing video source url');

  if (value.startsWith('/assets/')) {
    const source = await resolveLocalAssetProject(req, value, projectUuid);
    const storedName = source.storedName;
    const localPath = await ensureAssetLocalPath(source.projectUuid, storedName);
    if (!fs.existsSync(localPath)) {
      throw new Error(
        source.projectUuid === String(projectUuid)
          ? '参考视频文件不存在，请重新导入后再生成'
          : `参考视频在画布 ${source.projectUuid}，当前画布找不到这个文件。请把视频重新拖进当前画布，或确认原画布里的文件还在。`,
      );
    }
    return {
      filePath: localPath,
      originalName: storedName,
      mimeType: mimeTypeFromName(storedName),
      cleanupFiles: [],
    };
  }

  if (/^https?:\/\//i.test(value)) {
    const tmpBase = path.join(tmpDir(), `${randomId()}-video-trim-source`);
    const downloaded = await downloadRemoteAsset(value, tmpBase);
    return {
      filePath: downloaded.filePath,
      originalName: path.basename(safeUrlObject(value)?.pathname || downloaded.filePath),
      mimeType: downloaded.contentType || mimeTypeFromName(downloaded.filePath),
      cleanupFiles: [downloaded.filePath],
    };
  }

  if (fs.existsSync(value)) {
    return {
      filePath: value,
      originalName: path.basename(value),
      mimeType: mimeTypeFromName(value),
      cleanupFiles: [],
    };
  }

  throw new Error('video asset does not exist; please re-import it');
}

function derivedVideoOriginalName(originalName, suffix = 'trim') {
  const baseName = path.basename(String(originalName || 'video'));
  const ext = path.extname(baseName) || '.mp4';
  const stem = baseName.slice(0, Math.max(1, baseName.length - ext.length));
  return `${stem}-${suffix}.mp4`;
}

async function storeDerivedVideoAsset(projectUuid, canvasRow, filePath, originalName, suffix = 'trim', options = {}) {
  const outputMimeType = 'video/mp4';
  const sha1 = await sha1FileAsync(filePath);
  const storedName = `${sha1}.mp4`;
  const dest = path.join(assetsDir(projectUuid), storedName);

  if (!fs.existsSync(dest)) {
    fs.renameSync(filePath, dest);
  } else if (filePath !== dest) {
    fs.rmSync(filePath, { force: true });
  }

  await mirrorStoredAsset(projectUuid, storedName, dest, outputMimeType);

  const stat = fs.statSync(dest);
  await upsertAssetRecord(canvasRow, {
    originalName: derivedVideoOriginalName(originalName, suffix),
    storedName,
    relativePath: assetRelativePath(projectUuid, storedName),
    mimeType: outputMimeType,
    byteSize: stat.size,
    sha1,
    sourceType: options.sourceType || 'derived',
  });

  const meta = await probeMediaMetadata(dest, outputMimeType, storedName);
  return {
    url: `/assets/${projectUuid}/${storedName}`,
    sha1,
    meta,
  };
}

function normalizeVideoMergeClips(params = {}) {
  const rawClips = Array.isArray(params.mergeClips) && params.mergeClips.length
    ? params.mergeClips
    : (Array.isArray(params.videoList) ? params.videoList : []);
  const seen = new Set();
  const clips = [];

  for (const item of rawClips) {
    const url = String(item?.url || '').trim();
    if (!url) continue;
    const nodeId = String(item?.nodeId || item?.id || `clip-${clips.length}`);
    const key = `${nodeId}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const startSec = Math.max(0, Number(item?.startSec) || 0);
    const endSec = Number(item?.endSec);
    const durationSec = Number(item?.durationSec);
    const volume = Number(item?.volume);
    clips.push({
      id: String(item?.id || `clip-${nodeId}-${clips.length}`),
      nodeId,
      url,
      name: String(item?.name || item?.label || path.basename(url.split('?')[0]) || `clip-${clips.length + 1}`),
      startSec,
      endSec: Number.isFinite(endSec) ? Math.max(startSec + 0.2, endSec) : undefined,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined,
      volume: Number.isFinite(volume) ? Math.min(3, Math.max(0, volume)) : 1,
      muted: Boolean(item?.muted),
    });
  }

  return clips;
}

function ffconcatPath(filePath) {
  return String(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''");
}

function chooseMergeTargetSize(meta) {
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width >= 2 && height >= 2) {
    return { width: ensureEvenInt(width), height: ensureEvenInt(height) };
  }
  return { width: 1280, height: 720 };
}

function videoMergeClipRange(clip, sourceDurationSec) {
  const start = Math.max(0, Number(clip.startSec) || 0);
  const requestedEnd = Number(clip.endSec);
  const requestedDuration = Number(clip.durationSec);
  let end = Number.isFinite(requestedEnd)
    ? requestedEnd
    : (Number.isFinite(requestedDuration) && requestedDuration > 0 ? start + requestedDuration : start + 5);

  if (Number.isFinite(sourceDurationSec) && sourceDurationSec > 0) {
    end = Math.min(end, sourceDurationSec);
  }

  const safeStart = Math.max(0, Math.min(start, Math.max(0, end - 0.2)));
  const duration = Number((end - safeStart).toFixed(3));
  return { start: safeStart, duration };
}

async function videoHasAudioStream(filePath) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath],
      { timeout: 30_000 }
    );
    return Boolean(String(stdout || '').trim());
  } catch {
    return false;
  }
}

async function exportVideoMergeComposition(projectUuid, canvasRow, params = {}, onProgress = () => {}) {
  const clips = normalizeVideoMergeClips(params);
  if (!clips.length) throw new Error('Please connect at least one video clip before exporting.');

  const sources = [];
  const segmentPaths = [];
  let listPath = '';
  let outputPath = '';

  try {
    onProgress(5);
    for (const clip of clips) {
      const source = await resolveVideoTrimSource(clip.url, projectUuid);
      const meta = await probeMediaMetadata(source.filePath, source.mimeType, source.originalName);
      const hasAudio = await videoHasAudioStream(source.filePath);
      sources.push({ clip, source, meta, hasAudio });
    }

    const firstVideoMeta = sources.find((item) => Number(item.meta?.width) > 0 && Number(item.meta?.height) > 0)?.meta;
    const target = chooseMergeTargetSize(firstVideoMeta);
    const videoFilter = [
      `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
      `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1',
      'fps=30',
      'format=yuv420p',
    ].join(',');

    for (let index = 0; index < sources.length; index += 1) {
      const { clip, source, meta, hasAudio } = sources[index];
      const sourceDurationSec = Number(meta?.durationSec);
      const range = videoMergeClipRange(clip, sourceDurationSec);
      if (!Number.isFinite(range.duration) || range.duration < 0.2) {
        throw new Error(`Clip ${index + 1} is too short to export.`);
      }

      const segmentPath = path.join(tmpDir(), `${randomId()}-merge-segment-${index}.mp4`);
      const volume = clip.muted ? 0 : clip.volume;
      const args = [
        '-y',
        '-loglevel', 'error',
        '-ss', range.start.toFixed(3),
        '-t', range.duration.toFixed(3),
        '-i', source.filePath,
      ];

      if (!hasAudio) {
        args.push(
          '-f', 'lavfi',
          '-t', range.duration.toFixed(3),
          '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'
        );
      }

      args.push(
        '-map', '0:v:0',
        '-map', hasAudio ? '0:a:0' : '1:a:0',
        '-vf', videoFilter,
        '-af', `volume=${volume},aresample=async=1:first_pts=0`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '44100',
        '-ac', '2',
        '-shortest',
        '-movflags', '+faststart',
        segmentPath
      );

      await execFileAsync('ffmpeg', args, { timeout: 20 * 60_000 });
      if (!fs.existsSync(segmentPath)) throw new Error(`Clip ${index + 1} output was not created.`);
      segmentPaths.push(segmentPath);
      onProgress(10 + Math.round(((index + 1) / sources.length) * 70));
    }

    listPath = path.join(tmpDir(), `${randomId()}-merge-list.txt`);
    fs.writeFileSync(listPath, segmentPaths.map((filePath) => `file '${ffconcatPath(filePath)}'`).join('\n'), 'utf8');
    outputPath = path.join(tmpDir(), `${randomId()}-merge.mp4`);
    onProgress(86);
    await execFileAsync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outputPath],
      { timeout: 30 * 60_000 }
    );
    if (!fs.existsSync(outputPath)) throw new Error('Merged video output was not created.');

    onProgress(95);
    const stored = await storeDerivedVideoAsset(projectUuid, canvasRow, outputPath, 'video-merge.mp4', 'merge');
    outputPath = '';
    return stored;
  } finally {
    for (const item of sources) {
      for (const filePath of item.source?.cleanupFiles || []) {
        fs.rmSync(filePath, { force: true });
      }
    }
    for (const filePath of segmentPaths) fs.rmSync(filePath, { force: true });
    if (listPath) fs.rmSync(listPath, { force: true });
    if (outputPath) fs.rmSync(outputPath, { force: true });
  }
}

function normalizeDerivedCropRect(crop, maxWidth, maxHeight) {
  const safeMaxWidth = Math.max(MIN_CROP_SIZE_PX, Math.round(maxWidth || 0));
  const safeMaxHeight = Math.max(MIN_CROP_SIZE_PX, Math.round(maxHeight || 0));
  const rawX = Number(crop?.x);
  const rawY = Number(crop?.y);
  const rawWidth = Number(crop?.width);
  const rawHeight = Number(crop?.height);

  if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite)) return null;

  const baseWidth = clampInt(Math.round(rawWidth), MIN_CROP_SIZE_PX, safeMaxWidth);
  const baseHeight = clampInt(Math.round(rawHeight), MIN_CROP_SIZE_PX, safeMaxHeight);
  const x = ensureEvenCoordinate(clampInt(Math.round(rawX), 0, Math.max(0, safeMaxWidth - baseWidth)));
  const y = ensureEvenCoordinate(clampInt(Math.round(rawY), 0, Math.max(0, safeMaxHeight - baseHeight)));
  const width = clampInt(baseWidth, MIN_CROP_SIZE_PX, safeMaxWidth - x);
  const height = clampInt(baseHeight, MIN_CROP_SIZE_PX, safeMaxHeight - y);

  return {
    x,
    y,
    width: ensureEvenInt(width),
    height: ensureEvenInt(height),
  };
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function ensureEvenInt(value) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function ensureEvenCoordinate(value) {
  const rounded = Math.max(0, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

async function localizeCanvasExternalMedia(canvasRow) {
  if (!canvasRow) return canvasRow;

  const data = readCanvasData(canvasRow);
  const nodeList = nodeListFromData(data, canvasRow.id);
  const cache = new Map();
  let changed = false;

  const localizeUrl = async (url) => {
    if (!isExternalHttpUrl(url)) return String(url || '');
    if (cache.has(url)) return cache.get(url);
    const [localizedUrl] = await downloadToAssets([url], canvasRow.id);
    const nextUrl = localizedUrl || url;
    cache.set(url, nextUrl);
    return nextUrl;
  };

  for (const node of nodeList) {
    let nodeData;
    try {
      nodeData = typeof node.data === 'string' ? JSON.parse(node.data) : { ...(node.data || {}) };
    } catch {
      continue;
    }

    let nodeChanged = false;

    if (Array.isArray(nodeData.url)) {
      const nextUrls = [];
      for (const url of nodeData.url) {
        const nextUrl = await localizeUrl(url);
        if (nextUrl !== url) {
          nodeChanged = true;
          changed = true;
        }
        nextUrls.push(nextUrl);
      }
      if (nodeChanged) nodeData.url = nextUrls;
    }

    if (nodeData.poster) {
      const nextPoster = await localizeUrl(nodeData.poster);
      if (nextPoster !== nodeData.poster) {
        nodeData.poster = nextPoster;
        nodeChanged = true;
        changed = true;
      }
    }

    const params = nodeData.params && typeof nodeData.params === 'object' ? { ...nodeData.params } : null;
    if (params) {
      for (const listKey of ['imageList', 'videoList', 'audioList', 'textList', 'mixedList', 'promptChips']) {
        const list = Array.isArray(params[listKey]) ? params[listKey] : null;
        if (!list) continue;
        let listChanged = false;
        const nextList = [];
        for (const item of list) {
          if (!item || typeof item !== 'object' || !item.url) {
            nextList.push(item);
            continue;
          }
          const nextUrl = await localizeUrl(item.url);
          if (nextUrl !== item.url) {
            listChanged = true;
            changed = true;
          }
          nextList.push({ ...item, url: nextUrl });
        }
        if (listChanged) {
          params[listKey] = nextList;
          nodeChanged = true;
        }
      }

      if (Array.isArray(params.history)) {
        let historyChanged = false;
        const nextHistory = [];
        for (const item of params.history) {
          if (!item || typeof item !== 'object' || !item.url) {
            nextHistory.push(item);
            continue;
          }
          const nextUrl = await localizeUrl(item.url);
          if (nextUrl !== item.url) {
            historyChanged = true;
            changed = true;
          }
          nextHistory.push({ ...item, url: nextUrl });
        }
        if (historyChanged) {
          params.history = nextHistory;
          nodeChanged = true;
        }
      }
    }

    if (nodeChanged) {
      if (params) nodeData.params = params;
      node.data = JSON.stringify(nodeData);
    }
  }

  const nextCustomCoverUrl = isExternalHttpUrl(data.customCoverUrl) ? await localizeUrl(data.customCoverUrl) : data.customCoverUrl;
  if (nextCustomCoverUrl !== data.customCoverUrl) {
    data.customCoverUrl = nextCustomCoverUrl;
    changed = true;
  }

  const nextCoverUrl = isExternalHttpUrl(data.coverUrl) ? await localizeUrl(data.coverUrl) : data.coverUrl;
  if (nextCoverUrl !== data.coverUrl) {
    data.coverUrl = nextCoverUrl;
    changed = true;
  }

  if (!changed) return canvasRow;

  data.nodeList = nodeList;
  await saveCanvasData(canvasRow.id, data, {
    reason: 'localize_media',
    ownerId: canvasRow.owner_id,
    createdBy: canvasRow.owner_id,
  });
  return {
    ...canvasRow,
    data: JSON.stringify(data),
    updated_at: new Date().toISOString(),
  };
}

function seedanceContent(params) {
  const mode = normalizeVideoMode(params.modeType);
  const images = params.images || [];
  const videos = params.videos || [];
  const audios = params.audios || [];
  // modelPrompt 是前端把提示词里的药丸按原位展开成 @图片1 之后的文本（上游文档要求的
  // 指代惯例）。节点上存的仍是不含指代的纯文本，所以这里优先用 modelPrompt。
  // 2.5 多模态带参考视频时再加一句「生成新视频」，避免「参考视频 内容」被判成编辑。
  const prompt = seedanceOmniPrompt(params);
  const items = prompt ? [{ type: 'text', text: prompt }] : [];
  const hasReferenceMedia = images.length > 0 || videos.length > 0 || audios.length > 0;
  if (mode === 't2v' && !hasReferenceMedia) return items;
  if (mode === 'i2v') {
    return [...items, { type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' }];
  }
  if (mode === 'keyframe') {
    const keyframeItems = [...items, { type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' }];
    if (images[1]) keyframeItems.push({ type: 'image_url', image_url: { url: images[1] }, role: 'last_frame' });
    return keyframeItems;
  }
  return [
    ...items,
    ...images.map((url) => ({ type: 'image_url', image_url: { url }, role: 'reference_image' })),
    ...videos.map((url) => ({ type: 'video_url', video_url: { url }, role: 'reference_video' })),
    ...audios.map((url) => ({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })),
  ];
}

async function submitSeedanceVideo(params) {
  requireLlmKey();
  const modelRule = getVideoModelRule(params.model);
  const videoCount = Array.isArray(params.videos) ? params.videos.filter(Boolean).length : 0;
  const omniReferenceTaskType = seedanceOmniReferenceTaskType(params.model, params.modeType, videoCount);
  const body = {
    model: modelRule.providerModel || 'doubao-seedance-2-0-260128',
    content: seedanceContent(params),
    resolution: normalizeVideoResolution(params.model, params.resolution).toLowerCase(),
    ratio: normalizeVideoRatio(params.model, params.ratio, params.modeType),
    duration: normalizeVideoDuration(params.model, params.duration, params.modeType),
    generate_audio: params.enableSound !== 'off',
    watermark: false
  };
  if (omniReferenceTaskType) body.omni_reference_task_type = omniReferenceTaskType;
  const response = await axios.post(`${llmBaseUrl}/volcengine/api/v3/contents/generations/tasks`, body, {
    headers: { Authorization: `Bearer ${currentLlmKey()}`, 'Content-Type': 'application/json' },
    timeout: 60_000
  });
  const taskId = response.data?.id || response.data?.task_id;
  if (!taskId) throw new Error(`Seedance 闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鎯у⒔閹虫捇鈥旈崘顏佸亾閿濆簼绨奸柟鐧哥秮閺岋綁顢橀悙鎼闂侀潧妫欑敮鎺楋綖濠靛鏅查柛娑卞墮椤ユ艾鈹戞幊閸婃鎱ㄩ悜钘夌；闁绘劗鍎ら崑瀣煟濡崵婀介柍褜鍏涚欢姘嚕閹绢喖顫呴柍鈺佸暞閻濇洟姊绘担钘壭撻柨姘亜閿旇鏋ょ紒杈ㄦ瀵挳鎮㈤搹鍦闂備焦鐪归崹钘夘焽瑜嶉悺顓㈡⒒娴ｇ懓顕滄繛鎻掔箻瀹曟劕螖閸涱厾鍔﹀銈嗗笂缁€渚€宕甸鍕厱闁挎繂绻掔粔顔尖攽閳╁啯灏︾€规洏鍔戝鍫曞箣閿濆棙鍟洪梻鍌欑窔濞佳嚶ㄩ埀顒€鈹戦垾铏枠鐎规洩缍佸畷鍗烆渻缂佹ɑ鏉搁梻浣虹帛椤洨鍒掗姘ｆ鐟滃孩绌辨繝鍥舵晝闁挎繂娲﹂崳顓㈡倵閸偅绶查悗姘緲閻ｇ兘鎮㈢喊杈ㄦ櫍濠电偞鍨剁湁濠㈣娲熼弻锝夋偄閸濄儲鍣ч柣搴㈠嚬閸樺墽鍒掗崼銉ョ妞ゆ梻鏅崢浠嬫⒑閻熸壆浠㈤悗姘煎枤瀵囧焵椤掑嫭鍊垫繛鍫濈仢閺嬫稒銇勯鐘插幋妤犵偛鍟存慨鈧柕鍫濇噹缁愭稒绻濋悽闈浶㈤悗姘煎枦閸婃挳姊婚崒姘偓椋庣矆娓氣偓楠炲鏁撻悩鑼唶闂佺硶鍓濈粙鎴濐啅濠靛洢浜滈柡鍐ㄥ€婚幗鍌炴煕閻旈攱鍤囨慨?task_id: ${JSON.stringify(response.data)}`);
  return taskId;
}

function extractVideoUrl(data) {
  const content = data.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const videoUrl = content.video_url;
    if (typeof videoUrl === 'string' && videoUrl) return videoUrl;
    if (videoUrl && typeof videoUrl === 'object') return videoUrl.url || null;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'video_url') {
        if (typeof item.video_url === 'string' && item.video_url) return item.video_url;
        if (item.video_url && typeof item.video_url === 'object') return item.video_url.url || null;
      }
    }
  }
  const output = data.output;
  if (output && typeof output === 'object') {
    const videoUrl = output.video_url;
    if (typeof videoUrl === 'string' && videoUrl) return videoUrl;
    if (videoUrl && typeof videoUrl === 'object') return videoUrl.url || null;
  }
  return null;
}

async function pollSeedanceResult(taskId) {
  requireLlmKey();
  const response = await axios.get(`${llmBaseUrl}/volcengine/api/v3/contents/generations/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${currentLlmKey()}` },
    timeout: 30_000
  });
  const data = response.data || {};
  if (data.status === 'succeeded') {
    const videoUrl = extractVideoUrl(data);
    return { status: 2, progressPercent: 100, urls: videoUrl ? [videoUrl] : [] };
  }
  if (data.status === 'failed') {
    const raw = data.error != null ? data.error : data.message;
    const error = errorMessageFrom({
      message: stringifyUnknownError(raw, 'Seedance task failed'),
      response: { data: raw },
    });
    return { status: 3, progressPercent: 0, error };
  }
  return { status: data.status === 'running' ? 1 : 0, progressPercent: 30 };
}

// MiniMax H3 (Hailuo 3.0) via the gateway passthrough. Same content-array shape as
// Seedance (reuses seedanceContent), but a different provider-native endpoint pair
// and response layout: create → task_id; query → task.status + task.content.url.
// Auth uses the same gateway key (the gateway manages the MiniMax credential).
async function submitMinimaxVideo(params) {
  requireLlmKey();
  const modelRule = getVideoModelRule(params.model);
  const body = {
    model: modelRule.providerModel || 'MiniMax-H3',
    content: seedanceContent(params),
    // MiniMax expects the resolution label as-is (e.g. "768P" / "2K"), not lowercased.
    resolution: normalizeVideoResolution(params.model, params.resolution),
    duration: normalizeVideoDuration(params.model, params.duration, params.modeType),
    ratio: normalizeVideoRatio(params.model, params.ratio, params.modeType),
  };
  const response = await axios.post(`${llmBaseUrl}/minimax/v2/video_generation`, body, {
    headers: { Authorization: `Bearer ${currentLlmKey()}`, 'Content-Type': 'application/json' },
    timeout: 60_000
  });
  const taskId = response.data?.task_id || response.data?.task?.task_id || response.data?.id;
  if (!taskId) throw new Error(`MiniMax video submit returned no task_id: ${JSON.stringify(response.data)}`);
  return taskId;
}

async function pollMinimaxResult(taskId) {
  requireLlmKey();
  const response = await axios.get(`${llmBaseUrl}/minimax/v2/query/video_generation/${taskId}`, {
    headers: { Authorization: `Bearer ${currentLlmKey()}` },
    timeout: 30_000
  });
  const data = response.data || {};
  const task = data.task || data;
  const status = String(task.status || data.status || '').toLowerCase();
  if (status === 'succeeded' || status === 'success') {
    const url =
      (task.content && typeof task.content === 'object' && task.content.url) ||
      (data.content && typeof data.content === 'object' && data.content.url) ||
      extractVideoUrl(task) ||
      null;
    return { status: 2, progressPercent: 100, urls: url ? [url] : [] };
  }
  if (status === 'failed' || status === 'fail' || status === 'cancelled' || status === 'canceled') {
    return { status: 3, progressPercent: 0, error: task.message || data.message || 'MiniMax task failed' };
  }
  return { status: 1, progressPercent: 30 };
}

/**
 * 把画布里的资产地址变成能交给模型的 data URL。
 *
 * 地址形如 /assets/<画布号>/<文件名>。**必须认地址里那个画布号**：
 * 从收藏库、共享空间或别的画布拖进来的图，文件是存在原画布名下的，用当前任务的画布号去找
 * 必然找不到。原来找不到就 `return null`，调用处 `.filter(Boolean)` 一过滤，参考图**静默消失**，
 * 请求变成纯文生视频、钱照花、结果跟参考图毫无关系，而且没有任何报错
 * （2026-08-19 线上实证：画布 264 的节点引用 /assets/23/… ，近 30 天共 67 条这样被丢掉）。
 *
 * 跨画布取图要过一次读权限：生成是服务端进程在读盘，不校验的话，构造一个别的画布的地址
 * 就能借生成把自己无权访问的图读出来。有 req 就校验，没有（内部调用）就只允许本画布。
 */
async function resolveImageUrlForLLM(url, projectUuid, req = null) {
  const value = String(url || '');
  if (!value.startsWith('/assets/')) return null;
  const match = value.match(/^\/assets\/([^/]+)\/(.+)$/);
  let sourceProjectUuid = projectUuid;
  if (match && String(match[1]) !== String(projectUuid)) {
    if (!req) return null;
    const readable = await getReadableCanvasForUser(req, match[1]);
    if (!readable) {
      const error = new Error(`参考图属于画布 ${match[1]}，当前账号没有该画布的读取权限`);
      error.statusCode = 403;
      throw error;
    }
    sourceProjectUuid = match[1];
  }
  const localPath = await ensureAssetLocalPath(sourceProjectUuid, path.basename(value));
  if (!fs.existsSync(localPath)) return null;
  const ext = path.extname(localPath).slice(1).toLowerCase();
  const isVideoAsset = ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext);
  const sharp = getSharp();
  try {
    if (sharp && !isVideoAsset) {
      const buffer = await sharp(localPath).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }
  } catch {
    // Fall back to raw base64 below.
  }
  try {
    const outputPath = path.join(tmpDir(), `${randomId()}-llm-preview.jpg`);
    const args = [
      '-y',
      '-loglevel', 'error',
    ];
    if (isVideoAsset) args.push('-ss', '0');
    args.push(
      '-i', localPath,
      '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease',
      '-frames:v', '1',
      outputPath
    );
    await execFileAsync('ffmpeg', args, { timeout: 120_000 });
    const previewBuffer = fs.readFileSync(outputPath);
    fs.rmSync(outputPath, { force: true });
    return `data:image/jpeg;base64,${previewBuffer.toString('base64')}`;
  } catch {
    // Fall back to raw base64 below.
  }
  const buffer = fs.readFileSync(localPath);
  if (buffer.length > 1.5 * 1024 * 1024) return null;
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function imageFormatFromDataUrl(url) {
  const match = String(url || '').match(/^data:([^;,]+)[;,]/i);
  return match?.[1] || 'image/jpeg';
}

async function resolveVisionInputForLLM(url, projectUuid) {
  const resolvedUrl = await resolveImageUrlForLLM(url, projectUuid);
  if (!resolvedUrl) return null;
  return {
    url: resolvedUrl,
    format: imageFormatFromDataUrl(resolvedUrl)
  };
}

async function* chatStream(messages, model, signal, options = {}) {
  requireLlmKey();
  const payload = applyLlmPerformanceOptions({ model, messages, stream: true }, model, options, 0.7);
  const response = await postLlmChatCompletions(payload, {
    responseType: 'stream',
    signal
  });
  let buffer = '';
  for await (const chunk of response.data) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (raw === '[DONE]') return;
      try {
        const parsed = JSON.parse(raw);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) yield delta;
      } catch {
        // skip malformed chunks
      }
    }
  }
}

function extractChatText(data) {
  const content = data?.choices?.[0]?.message?.content ?? data?.content ?? data?.text ?? '';
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return typeof content === 'string' ? content : '';
}

async function chatComplete(messages, model = config.defaultChatModel, options = {}) {
  requireLlmKey();
  const payload = applyLlmPerformanceOptions({ model, messages, stream: false }, model, options, 0.4);
  const response = await postLlmChatCompletions(payload);
  return extractChatText(response.data).trim();
}

async function chatCompleteWithSignal(messages, model = config.defaultChatModel, options = {}, signal) {
  requireLlmKey();
  const payload = applyLlmPerformanceOptions({ model, messages, stream: false }, model, options, 0.35);
  const response = await postLlmChatCompletions(payload, { signal });
  return extractChatText(response.data).trim();
}

function compactDeepText(value, maxChars = 12000) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.62));
  const tail = text.slice(-Math.floor(maxChars * 0.32));
  return `${head}\n\n[...middle omitted to stay within model context...]\n\n${tail}`;
}

function deepTextMessages(referenceContent, instruction, stageText, extras = '') {
  const content = [
    ...referenceContent,
    {
      type: 'text',
      text: [
        'Deep thinking task:',
        instruction || 'Generate the best possible final text from the provided material.',
        '',
        stageText,
        extras ? `\nWorking notes:\n${extras}` : ''
      ].join('\n')
    }
  ];
  return [
    {
      role: 'system',
      content: [
        'You are Shotflow deep-thinking text mode.',
        'Think carefully, preserve the user requested language, and optimize for accuracy, detail, structure, and usefulness.',
        'Do not mention internal stages in the final answer unless the user asks.'
      ].join(' ')
    },
    { role: 'user', content }
  ];
}

async function streamDeepTextGeneration({ referenceContent, instruction, model, signal, options, onStage, onDelta }) {
  const complete = async (stage, stageInstruction, extras = '') => {
    onStage(stage);
    return chatCompleteWithSignal(
      deepTextMessages(referenceContent, instruction, stageInstruction, extras),
      model,
      options,
      signal
    );
  };

  const analysis = await complete(
    '1/5 分析需求和参考素材',
    'Stage 1: analyze the user task and all provided source material. Identify goals, constraints, missing risks, required output style, and quality criteria. Return compact working notes only.'
  );
  const outline = await complete(
    '2/5 规划输出结构',
    'Stage 2: create a strong output plan and structure. Decide what should be emphasized, what should be removed, and what order is best. Return compact working notes only.',
    compactDeepText(analysis, 6000)
  );
  const draft = await complete(
    '3/5 生成完整初稿',
    'Stage 3: write a complete high-quality draft according to the plan. Be specific and avoid generic filler.',
    compactDeepText([analysis, outline].join('\n\n'), 9000)
  );
  const review = await complete(
    '4/5 自检并强化细节',
    'Stage 4: critique the draft. Find weak logic, vague details, missing constraints, wording issues, and places where quality can be improved. Return concrete revision notes only.',
    compactDeepText([analysis, outline, draft].join('\n\n'), 12000)
  );

  onStage('5/5 输出最终结果');
  const finalMessages = deepTextMessages(
    referenceContent,
    instruction,
    [
      'Final stage: produce only the final polished result.',
      'Use the critique to improve the draft.',
      'Do not include analysis, outline, critique, or stage labels.',
    ].join('\n'),
    compactDeepText([analysis, outline, draft, review].join('\n\n'), 16000)
  );

  let output = '';
  for await (const delta of chatStream(finalMessages, model, signal, options)) {
    output += String(delta || '');
    onDelta(delta);
  }
  return output;
}

function pollAndStore(jobId, internalId, projectUuid, pollFn = pollMivoResult, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 200);
  const intervalMs = Number(options.intervalMs || 3000);
  let attempts = 0;
  let pollInFlight = false;
  const interval = setInterval(async () => {
    if (generationRuntimeDraining) {
      clearGenerationPoller(internalId, interval);
      return;
    }
    if (pollInFlight) return;
    attempts += 1;
    if (attempts > maxAttempts) {
      clearGenerationPoller(internalId, interval);
      jobService.setTask(internalId, { status: 3, progressPercent: 0, error: '轮询超时，请重试' });
      if (options.onFailed) await options.onFailed('轮询超时，请重试');
      return;
    }
    pollInFlight = true;
    let finishPollOperation;
    const pollOperation = new Promise((resolve) => {
      finishPollOperation = resolve;
    });
    activePollOperations.set(internalId, pollOperation);
    try {
      const result = await pollFn(jobId);
      if (result.status === 2 && result.urls?.length) {
        clearGenerationPoller(internalId, interval);
        try {
          if (options.ensureRvCompatibleVideos) {
            jobService.setTask(internalId, {
              status: 1,
              progressPercent: 98,
              providerStatus: { phase: 'preparing_rv_compatible_video' },
            });
          }
          const stored = await downloadToAssets(result.urls, projectUuid, {
            strict: true,
            sourceType: 'generated',
            includePreviews: true,
            ensureRvCompatibleVideos: Boolean(options.ensureRvCompatibleVideos),
          });
          const urls = stored.urls;
          // Optional post-processing hook run after download but before the
          // task is marked succeeded (e.g. panorama's ~2:1 aspect-ratio check
          // + output metadata build). May return { outputs, providerStatus }
          // to merge into the success patch; throwing here is caught by the
          // same download-failure handling below, reusing its error plumbing.
          const postDownloadPatch = options.postDownload ? (await options.postDownload(urls, stored)) || {} : {};
          const outputs = Array.isArray(postDownloadPatch.outputs) && postDownloadPatch.outputs.length
            ? postDownloadPatch.outputs
            : stored.outputs;
          jobService.setTask(internalId, {
            status: 2,
            progressPercent: 100,
            urls,
            outputs,
            providerStatus: {
              phase: 'completed',
              resultCount: urls.length,
              previewUrls: stored.previewUrls,
              ...(postDownloadPatch.providerStatus || {}),
            },
          });
          if (options.onSucceeded) await options.onSucceeded(urls, postDownloadPatch);
        } catch (error) {
          const message = errorMessageFrom(error);
          jobService.setTask(internalId, {
            status: 3,
            progressPercent: 0,
            error: message
          });
          if (options.onFailed) await options.onFailed(message);
          return;
          jobService.setTask(internalId, {
            status: 3,
            progressPercent: 0,
            error: error?.message || '视频结果下载失败，请重新生成'
          });
          if (options.onFailed) await options.onFailed(error?.message || '视频结果下载失败，请重新生成');
        }
      } else if (result.status === 3) {
        clearGenerationPoller(internalId, interval);
        jobService.setTask(internalId, { status: 3, progressPercent: 0, error: result.error });
        if (options.onFailed) await options.onFailed(result.error || '任务失败');
      } else {
        jobService.setTask(internalId, { status: result.status, progressPercent: result.progressPercent });
      }
    } catch (error) {
      console.error('poll error', error);
    } finally {
      pollInFlight = false;
      if (activePollOperations.get(internalId) === pollOperation) {
        activePollOperations.delete(internalId);
      }
      finishPollOperation();
    }
  }, intervalMs);
  registerGenerationPoller(internalId, interval);
}

// 多 provider job 的视频任务轮询。
// options.pollResult 必须传对应 provider 的轮询函数——以前这里写死 pollSeedanceResult，
// 于是 MiniMax 一次生成 2 个及以上视频时，拿着 MiniMax 的 task id 去问 Seedance 的接口，
// 正常生成和重启恢复两条路都错（2026-08-14 修）。默认值只为兼容老调用点。
function pollVideoManyAndStore(jobIds, internalId, projectUuid, options = {}) {
  const pollResult = typeof options.pollResult === 'function' ? options.pollResult : pollSeedanceResult;
  const providerLabel = options.providerLabel || 'Seedance';
  const states = jobIds.map(() => ({ status: 1, progressPercent: 0, urls: [] }));
  let attempts = 0;
  let pollInFlight = false;
  const interval = setInterval(async () => {
    if (generationRuntimeDraining) {
      clearGenerationPoller(internalId, interval);
      return;
    }
    if (pollInFlight) return;
    attempts += 1;
    if (attempts > 400) {
      clearGenerationPoller(internalId, interval);
      jobService.setTask(internalId, { status: 3, progressPercent: 0, error: `${providerLabel} 多视频任务轮询超时，请重新生成` });
      if (options.onFailed) await options.onFailed(`${providerLabel} 多视频任务轮询超时，请重新生成`);
      return;
    }

    pollInFlight = true;
    let finishPollOperation;
    const pollOperation = new Promise((resolve) => {
      finishPollOperation = resolve;
    });
    activePollOperations.set(internalId, pollOperation);
    try {
      await Promise.all(jobIds.map(async (jobId, index) => {
        if (states[index].status === 2 || states[index].status === 3) return;
        const result = await pollResult(jobId);
        if (result.status === 2) {
          states[index] = { status: 2, progressPercent: 100, urls: result.urls || [] };
        } else if (result.status === 3) {
          states[index] = { status: 3, progressPercent: 0, urls: [], error: result.error || `${providerLabel} task failed` };
        } else {
          states[index] = {
            ...states[index],
            status: result.status,
            progressPercent: Number(result.progressPercent || 0)
          };
        }
      }));

      const failed = states.find((state) => state.status === 3);
      if (failed) {
        clearGenerationPoller(internalId, interval);
        jobService.setTask(internalId, {
          status: 3,
          progressPercent: 0,
          error: failed.error || `${providerLabel} 多视频任务失败`
        });
        if (options.onFailed) await options.onFailed(failed.error || `${providerLabel} 多视频任务失败`);
        return;
      }

      if (states.every((state) => state.status === 2)) {
        clearGenerationPoller(internalId, interval);
        const resultUrls = states.flatMap((state) => state.urls || []).filter(Boolean);
        if (resultUrls.length === 0) {
          jobService.setTask(internalId, { status: 3, progressPercent: 0, error: `${providerLabel} 未返回视频链接` });
          if (options.onFailed) await options.onFailed(`${providerLabel} 未返回视频链接`);
          return;
        }
        try {
          jobService.setTask(internalId, {
            status: 1,
            progressPercent: 98,
            providerStatus: { phase: 'preparing_rv_compatible_video' },
          });
          const stored = await downloadToAssets(resultUrls, projectUuid, {
            strict: true,
            sourceType: 'generated',
            includePreviews: true,
            ensureRvCompatibleVideos: true,
          });
          const urls = stored.urls;
          jobService.setTask(internalId, {
            status: 2,
            progressPercent: 100,
            urls,
            outputs: stored.outputs,
            providerStatus: { phase: 'completed', resultCount: urls.length, previewUrls: stored.previewUrls },
          });
          if (options.onSucceeded) await options.onSucceeded(urls);
        } catch (error) {
          const message = errorMessageFrom(error);
          jobService.setTask(internalId, {
            status: 3,
            progressPercent: 0,
            error: message
          });
          if (options.onFailed) await options.onFailed(message);
          return;
          jobService.setTask(internalId, {
            status: 3,
            progressPercent: 0,
            error: error?.message || '视频结果下载失败，请重新生成'
          });
          if (options.onFailed) await options.onFailed(error?.message || '视频结果下载失败，请重新生成');
        }
        return;
      }

      const progressPercent = Math.round(
        states.reduce((sum, state) => sum + (state.status === 2 ? 100 : Number(state.progressPercent || 0)), 0) / states.length
      );
      jobService.setTask(internalId, { status: 1, progressPercent });
    } catch (error) {
      console.error('seedance multi poll error', error);
    } finally {
      pollInFlight = false;
      if (activePollOperations.get(internalId) === pollOperation) {
        activePollOperations.delete(internalId);
      }
      finishPollOperation();
    }
  }, 20_000);
  registerGenerationPoller(internalId, interval);
}

function recoveredVideoTaskCallbacks(task) {
  return {
    onSucceeded: async (urls) => {
      await Promise.all([
        safeUpdateUsageLog(task.usageLogId, {
          status: 'succeeded',
          resultCount: urls.length,
        }),
        safeUpdateVideoTaskDetail(task.videoTaskDetailId, {
          status: 'succeeded',
          resultUrls: urls,
          providerStatus: {
            phase: 'completed_after_restart',
            resultCount: urls.length,
          },
        }),
      ]);
    },
    onFailed: async (message) => {
      await Promise.all([
        safeUpdateUsageLog(task.usageLogId, {
          status: 'failed',
          errorMessage: message,
        }),
        safeUpdateVideoTaskDetail(task.videoTaskDetailId, {
          status: 'failed',
          errorMessage: message,
          providerStatus: {
            phase: 'failed_after_restart',
          },
        }),
      ]);
    },
  };
}

function resumePersistedGenerationTasks(tasks = []) {
  if (generationRuntimeDraining) {
    return {
      resumedCount: 0,
      skippedCount: tasks.length,
    };
  }
  let resumedCount = 0;
  let skippedCount = 0;
  for (const task of tasks) {
    const providerJobIds = Array.isArray(task?.providerJobIds)
      ? task.providerJobIds.filter(Boolean)
      : [];
    const resumeProvider = String(task?.provider || '').toLowerCase();
    // 判据和 JobService.recoverInterruptedTasks 共用同一个函数：两边各写一份就会漂移，
    // 任务会被判成可恢复却没人轮询，永久悬空。
    if (!isResumableGenerationTask(task)) {
      skippedCount += 1;
      continue;
    }

    const providerStatus = {
      phase: 'polling_resumed_after_restart',
      providerJobCount: providerJobIds.length,
      resumedAt: new Date().toISOString(),
    };
    jobService.setTask(task.jobId, {
      status: 1,
      progressPercent: 1,
      providerJobIds,
      providerStatus,
    });
    void safeUpdateVideoTaskDetail(task.videoTaskDetailId, {
      status: 'running',
      providerJobIds,
      providerStatus,
    });

    const callbacks = recoveredVideoTaskCallbacks(task);
    const resumePoll = resumeProvider === 'minimax' ? pollMinimaxResult : pollSeedanceResult;
    if (providerJobIds.length === 1) {
      pollAndStore(
        providerJobIds[0],
        task.jobId,
        task.projectUuid,
        resumePoll,
        {
          intervalMs: 10_000,
          maxAttempts: 200,
          ensureRvCompatibleVideos: true,
          ...callbacks,
        }
      );
    } else {
      pollVideoManyAndStore(
        providerJobIds,
        task.jobId,
        task.projectUuid,
        {
          ...callbacks,
          pollResult: resumePoll,
          providerLabel: resumeProvider === 'minimax' ? 'MiniMax' : 'Seedance',
        }
      );
    }
    resumedCount += 1;
  }
  return {
    resumedCount,
    skippedCount,
  };
}

/**
 * 依赖服务探活。只打 worker 的 /health，不做任何推理，所以很快（默认 3s 超时）。
 *
 * 为什么需要它（2026-08-21）：4090 的抠图 worker 挂了一下午，用户的体验是「建了个节点、
 * 等了一会儿、看到一句看不懂的报错」。有了这个接口，弹窗一打开就知道依赖在不在，
 * 服务没起来就直接把生成按钮灰掉并说明原因，不让人白建节点白等。
 *
 * 结果短缓存 5 秒：多人同时开弹窗时不要把 worker 打爆，但也要让「服务刚被拉起来」
 * 在几秒内就能被发现（所以不能像 LightStageGeometryService 那样缓存 60 秒）。
 *
 * reason 保留原始报错（connect ETIMEDOUT 172.26.166.238:8092 这种），前端的
 * describeServiceError 靠里面的错误码和端口号翻译成人话，所以这里不要提前美化掉。
 */
const TEXTURE_CLARITY_STATUS_TTL_MS = 5_000;
const TEXTURE_CLARITY_STATUS_PROBE_TIMEOUT_MS = 3_000;
let textureClarityStatusCache = { atMs: 0, payload: null };

async function probeWorkerHealth(serviceUrl, serviceToken) {
  const base = String(serviceUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { configured: false, ok: false, reason: '服务未配置' };
  try {
    await axios.get(`${base}/health`, {
      headers: serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {},
      timeout: TEXTURE_CLARITY_STATUS_PROBE_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return { configured: true, ok: true, reason: '' };
  } catch (error) {
    return { configured: true, ok: false, reason: errorMessageFrom(error) };
  }
}

apiRouter.get('/texture-clarity/service-status', async (req, res) => {
  try {
    const now = Date.now();
    if (textureClarityStatusCache.payload && now - textureClarityStatusCache.atMs < TEXTURE_CLARITY_STATUS_TTL_MS) {
      return res.json(textureClarityStatusCache.payload);
    }
    const mattingConfig = config.subjectMatting || {};
    const geometryConfig = config.lightStageGeometry || {};
    // 两个探测并发，别串着等
    const [semantic, geometry] = await Promise.all([
      probeWorkerHealth(mattingConfig.serviceUrl, mattingConfig.serviceToken),
      probeWorkerHealth(geometryConfig.serviceUrl, geometryConfig.serviceToken),
    ]);
    // 语义分区是硬依赖：没有类别图就算不出融合支持区。深度/法线只是少一层约束，缺了也能生成。
    const payload = {
      textureClarityStatus: {
        semantic,
        geometry,
        canRepair: semantic.ok,
        checkedAtMs: now,
      },
    };
    textureClarityStatusCache = { atMs: now, payload };
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: errorMessageFrom(error) });
  }
});

/**
 * 纹理清晰化（精准修复 · 人物真实化）—— 控制素材准备。
 *
 * 编辑器**不再**在打开时调这个（那会把弹窗锁死几十秒）。现在两个入口：
 * 用户主动点「加载控制素材预览」，或者生成任务在节点后台把它作为第一阶段跑。
 * 把原图规范化到 <=2K，拿到语义分区，并**复用**已有的 MoGe-2 深度/法线
 * （tryReuseLightStageGeometry 按源图哈希查，查不到才生成）。
 * 这一步一次生图都不调，所以它是零生图成本的。
 */
apiRouter.post('/texture-clarity/assets', async (req, res) => {
  const cleanupFiles = [];
  try {
    const { projectUuid, nodeKey, sourceUrl } = req.body || {};
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });
    if (!sourceUrl) return res.status(400).json({ error: '精准修复需要源图' });

    const sourceInput = await resolveToOpenAiImageInput(sourceUrl, projectUuid);
    if (!sourceInput?.filePath || !fs.existsSync(sourceInput.filePath)) {
      return res.status(400).json({ error: '源图无法本地化' });
    }
    cleanupFiles.push(...(sourceInput.cleanupFiles || []));

    // 规范化后的图才是这条链的唯一基准：语义图、几何图、融合、诊断全部按它的尺寸对齐。
    const normalized = await textureClarityService.normalizeSourceImage(fs.readFileSync(sourceInput.filePath));
    const sourceHash = crypto.createHash('sha1').update(normalized.buffer).digest('hex');
    const dir = assetsDir(projectUuid);

    const saveAsset = async (key, buffer, mimeType = 'image/png') => {
      const storedName = textureClarityService.assetName(sourceHash, key);
      const fullPath = path.join(dir, storedName);
      const reused = fs.existsSync(fullPath);
      if (!reused) {
        fs.writeFileSync(fullPath, buffer);
        await mirrorStoredAsset(projectUuid, storedName, fullPath, mimeType);
      }
      const stat = fs.statSync(fullPath);
      await upsertAssetRecord(row, {
        originalName: storedName,
        storedName,
        relativePath: assetRelativePath(projectUuid, storedName),
        mimeType,
        byteSize: stat.size,
        sha1: crypto.createHash('sha1').update(fs.readFileSync(fullPath)).digest('hex'),
        sourceType: 'texture-clarity',
      });
      return { url: '/assets/' + projectUuid + '/' + storedName, reused, storedName };
    };

    const sourceAsset = await saveAsset('source', normalized.buffer);

    // ---- 语义分区 ----
    const mattingConfig = config.subjectMatting || {};
    let semantic = { status: 'unavailable', reason: '语义分区服务未配置' };
    if (mattingConfig.serviceUrl) {
      try {
        const parts = await textureClarityService.requestSemanticParts(normalized.buffer, {
          serviceUrl: mattingConfig.serviceUrl,
          serviceToken: mattingConfig.serviceToken,
          timeoutMs: mattingConfig.timeoutMs,
        });
        if (parts.width !== normalized.width || parts.height !== normalized.height) {
          throw new Error('语义图 ' + parts.width + 'x' + parts.height + ' 与规范化源图 ' + normalized.width + 'x' + normalized.height + ' 不一致');
        }
        const classMap = await textureClarityService.decodeClassMap(parts.classMapPng, normalized.width, normalized.height);
        const classMapAsset = await saveAsset('classmap', parts.classMapPng);
        const vizAsset = await saveAsset('semantic', await textureClarityService.buildSemanticVisualization(classMap, normalized.width, normalized.height));
        semantic = {
          status: classMapAsset.reused ? 'cached' : 'generated',
          classMapUrl: classMapAsset.url,
          previewUrl: vizAsset.url,
          modelId: parts.modelId,
          modelRevision: parts.modelRevision,
          labelSet: parts.labelSet,
          elapsedSec: parts.elapsedSec,
          classes: textureClarityService.summarizeClasses(classMap),
        };
      } catch (error) {
        // 语义分区失败不该让编辑器打不开：左栏照实标失败，生成按钮由前端禁用。
        semantic = { status: 'failed', reason: errorMessageFrom(error) };
      }
    }

    // ---- 深度 / 法线：优先复用，查不到才生成 ----
    const geometryConfig = config.lightStageGeometry || {};
    let geometry = { status: 'unavailable', reason: '几何服务未配置' };
    try {
      const cached = await tryReuseLightStageGeometry(projectUuid, sourceHash, {
        serviceUrl: geometryConfig.serviceUrl,
        serviceToken: geometryConfig.serviceToken,
        healthTimeoutMs: geometryConfig.healthTimeoutMs,
      });
      const useMoge = Boolean(geometryConfig.serviceUrl && geometryConfig.serviceToken);
      const result = cached || await lightStageGeometryService.buildGeometryAssets(normalized.buffer, {
        sourceNodeId: nodeKey,
        provider: useMoge ? lightStageGeometryService.MODEL_ID : 'local-2.5d',
        serviceUrl: geometryConfig.serviceUrl,
        serviceToken: geometryConfig.serviceToken,
        timeoutMs: geometryConfig.timeoutMs,
        healthTimeoutMs: geometryConfig.healthTimeoutMs,
        allowLocalFallback: geometryConfig.allowLocalFallback,
      });
      const urls = {};
      for (const item of result.items) {
        const fullPath = path.join(dir, item.storedName);
        if (item.buffer && !fs.existsSync(fullPath)) {
          fs.writeFileSync(fullPath, item.buffer);
          await mirrorStoredAsset(projectUuid, item.storedName, fullPath, item.mimeType);
        }
        if (!fs.existsSync(fullPath)) continue;
        const stat = fs.statSync(fullPath);
        await upsertAssetRecord(row, {
          originalName: item.storedName,
          storedName: item.storedName,
          relativePath: assetRelativePath(projectUuid, item.storedName),
          mimeType: item.mimeType,
          byteSize: stat.size,
          sha1: item.sha1,
          sourceType: 'light-stage',
        });
        urls[item.key] = '/assets/' + projectUuid + '/' + item.storedName;
      }
      geometry = {
        status: cached ? 'cached' : 'generated',
        provider: result.provider,
        modelId: result.modelId,
        depthUrl: urls.depth,
        normalUrl: urls.normal,
        assetVersion: result.assetVersion,
      };
    } catch (error) {
      geometry = { status: 'failed', reason: errorMessageFrom(error) };
    }

    res.json({
      textureClarity: {
        sourceHash,
        assetVersion: textureClarityService.TEXTURE_CLARITY_ASSET_VERSION,
        fusionPolicy: textureClarityService.FUSION_POLICY,
        source: {
          url: sourceAsset.url,
          status: sourceAsset.reused ? 'cached' : 'generated',
          width: normalized.width,
          height: normalized.height,
          originalWidth: normalized.originalWidth,
          originalHeight: normalized.originalHeight,
          scale: normalized.scale,
        },
        semantic,
        geometry,
      },
    });
  } catch (error) {
    res.status(500).json({ error: errorMessageFrom(error) });
  } finally {
    for (const file of cleanupFiles) fs.rmSync(file, { force: true });
  }
});

/**
 * 纹理清晰化 —— 生成修复。
 *
 * 一次点击只调一次生图（count: 1），拿回完整候选图后在本地做保护融合。融合不调生图 API，
 * 所以质量门禁失败时不会自动重试、也不会二次扣费 —— 候选图和诊断都留着给用户看。
 *
 * 比例传 auto：文档要求"跟随原图比例"，强制某个固定比例会让模型拉伸或补边。
 */
apiRouter.post('/texture-clarity/repair', async (req, res) => {
  const cleanupFiles = [];
  try {
    const body = req.body || {};
    const { projectUuid, nodeKey, model, sourceUrl, semanticUrl, classMapUrl, depthUrl, normalUrl, extraInstruction } = body;
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });
    if (!sourceUrl) return res.status(400).json({ error: '精准修复需要源图' });
    if (!classMapUrl) return res.status(400).json({ error: '缺少语义类别图，无法计算融合支持区' });

    const localize = async (url) => {
      if (!url) return null;
      const input = await resolveToOpenAiImageInput(url, projectUuid);
      if (input?.cleanupFiles) cleanupFiles.push(...input.cleanupFiles);
      return input?.filePath && fs.existsSync(input.filePath) ? input.filePath : null;
    };

    const sourcePath = await localize(sourceUrl);
    const classMapPath = await localize(classMapUrl);
    if (!sourcePath) return res.status(400).json({ error: '源图无法本地化' });
    if (!classMapPath) return res.status(400).json({ error: '语义类别图无法本地化' });

    const sourceBuffer = fs.readFileSync(sourcePath);
    // 尺寸走服务层读：这个文件里的 sharp 是懒加载的 getSharp()，没有顶层 sharp 绑定，
    // 裸写 sharp(...) 会是运行时 ReferenceError，node --check 抓不到。
    const sourceMeta = await textureClarityService.imageSize(sourceBuffer);
    const width = sourceMeta.width;
    const height = sourceMeta.height;
    if (!width || !height) return res.status(400).json({ error: '源图尺寸读不出来' });

    // 参考图顺序即优先级：原图第一。语义/深度/法线按可用性追加，缺了也能跑（少一层约束）。
    const references = [sourceUrl, semanticUrl, depthUrl, normalUrl].filter(Boolean);
    const prompt = textureClarityService.buildRepairPrompt({ extraInstruction });

    const generationStartedMs = Date.now();
    const candidateUrls = await generateOpenAiImages(
      {
        model,
        prompt,
        images: references,
        ratio: 'auto',
        resolution: '2K',
        count: 1,
      },
      projectUuid,
      row,
    );
    const candidateUrl = (candidateUrls || [])[0];
    if (!candidateUrl) return res.status(502).json({ error: '生图没有返回候选结果' });
    const generationMs = Date.now() - generationStartedMs;

    const candidatePath = await localize(candidateUrl);
    if (!candidatePath) return res.status(500).json({ error: '候选图无法本地化' });
    const candidateBuffer = fs.readFileSync(candidatePath);

    const fusionStartedMs = Date.now();
    const fused = await textureClarityService.fuseCandidate({
      sourceBuffer,
      candidateBuffer,
      classMapPng: fs.readFileSync(classMapPath),
      width,
      height,
    });
    const fusionMs = Date.now() - fusionStartedMs;

    // 融合结果落资产。名字带候选图哈希，重复点"重新生成"不会互相覆盖。
    const candidateHash = crypto.createHash('sha1').update(candidateBuffer).digest('hex');
    const storedName = textureClarityService.assetName(candidateHash, 'fused');
    const fullPath = path.join(assetsDir(projectUuid), storedName);
    fs.writeFileSync(fullPath, fused.png);
    await mirrorStoredAsset(projectUuid, storedName, fullPath, 'image/png');
    const stat = fs.statSync(fullPath);
    await upsertAssetRecord(row, {
      originalName: storedName,
      storedName,
      relativePath: assetRelativePath(projectUuid, storedName),
      mimeType: 'image/png',
      byteSize: stat.size,
      sha1: crypto.createHash('sha1').update(fused.png).digest('hex'),
      sourceType: 'texture-clarity',
    });

    res.json({
      textureClarity: {
        sourceNodeKey: nodeKey || null,
        requestModel: model || null,
        resolvedModel: openAIImageProvider.providerModelForImage(normalizeImageModel(model)),
        candidateUrl,
        fusedUrl: '/assets/' + projectUuid + '/' + storedName,
        // 验收要求：一个候选只记一次生图调用
        generationCalls: 1,
        generationMs,
        fusionMs,
        passed: fused.passed,
        failures: fused.failures,
        diagnostics: fused.diagnostics,
        promptChars: prompt.length,
        referenceCount: references.length,
      },
    });
  } catch (error) {
    res.status(500).json({ error: errorMessageFrom(error) });
  } finally {
    for (const file of cleanupFiles) fs.rmSync(file, { force: true });
  }
});

apiRouter.post('/light-stage/geometry', async (req, res) => {
  const cleanupFiles = [];
  try {
    const { projectUuid, nodeKey, sourceUrl } = req.body || {};
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });
    if (!sourceUrl) return res.status(400).json({ error: 'Light Stage source image is required' });

    const sourceInput = await resolveToOpenAiImageInput(sourceUrl, projectUuid);
    if (!sourceInput?.filePath || !fs.existsSync(sourceInput.filePath)) {
      return res.status(400).json({ error: 'Light Stage source image could not be localized' });
    }
    cleanupFiles.push(...(sourceInput.cleanupFiles || []));
    const sourceBuffer = fs.readFileSync(sourceInput.filePath);
    const sourceHash = crypto.createHash('sha1').update(sourceBuffer).digest('hex');
    const geometryConfig = config.lightStageGeometry || {};
    const useMoge = Boolean(geometryConfig.serviceUrl && geometryConfig.serviceToken);
    const cachedResult = await tryReuseLightStageGeometry(projectUuid, sourceHash, {
      serviceUrl: geometryConfig.serviceUrl,
      serviceToken: geometryConfig.serviceToken,
      healthTimeoutMs: geometryConfig.healthTimeoutMs,
    });
    const result = cachedResult || await lightStageGeometryService.buildGeometryAssets(sourceBuffer, {
      sourceNodeId: nodeKey,
      provider: useMoge ? lightStageGeometryService.MODEL_ID : 'local-2.5d',
      serviceUrl: geometryConfig.serviceUrl,
      serviceToken: geometryConfig.serviceToken,
      timeoutMs: geometryConfig.timeoutMs,
      healthTimeoutMs: geometryConfig.healthTimeoutMs,
      allowLocalFallback: geometryConfig.allowLocalFallback,
    });
    const urls = {};
    for (const item of result.items) {
      const fullPath = path.join(assetsDir(projectUuid), item.storedName);
      if (item.buffer && (!cachedResult || !fs.existsSync(fullPath))) fs.writeFileSync(fullPath, item.buffer);
      if (!fs.existsSync(fullPath)) {
        return res.status(500).json({ error: 'Light Stage geometry asset cache is incomplete' });
      }
      if (!cachedResult) {
        await mirrorStoredAsset(projectUuid, item.storedName, fullPath, item.mimeType);
      }
      const stat = fs.statSync(fullPath);
      await upsertAssetRecord(row, {
        originalName: item.storedName,
        storedName: item.storedName,
        relativePath: assetRelativePath(projectUuid, item.storedName),
        mimeType: item.mimeType,
        byteSize: stat.size,
        sha1: item.sha1,
        sourceType: 'light-stage',
      });
      urls[item.key] = `/assets/${projectUuid}/${item.storedName}`;
    }
    res.json({
      geometry: {
        provider: result.provider,
        modelId: result.modelId,
        status: result.status,
        diffuseUrl: urls.diffuse,
        normalUrl: urls.normal,
        depthUrl: urls.depth,
        maskUrl: urls.mask,
        pointMapUrl: urls.pointMap,
        previewUrl: urls.preview,
        manifestUrl: urls.manifest,
        width: result.width,
        height: result.height,
        fov: result.fov,
        intrinsics: result.intrinsics,
        assetVersion: result.assetVersion,
        normalConvention: result.normalConvention,
        generatedAtMs: result.generatedAtMs,
        error: result.warning || undefined,
      },
    });
  } catch (error) {
    res.status(error?.response?.status || 500).json({ error: errorMessageFrom(error) });
  } finally {
    for (const filePath of cleanupFiles) fs.rmSync(filePath, { force: true });
  }
});

// --- Appearance transfer: lighting descriptor (Route A "灯光氛围迁移" analysis) ---
// Faithful port of the Dexis descriptor service. A reference image is sent to a
// vision model with a strict-JSON instruction; the reply is strictly parsed into
// a LightingDescriptorV1 that the client feeds into the Route A relight prompt.
// Reuses the LLM vision proxy (resolveVisionInputForLLM + postLlmChatCompletions)
// and an in-memory, TTL-evicted, signature-idempotent job store.
const appearanceDescriptorJobStore = new appearanceDescriptorService.DescriptorJobStore();

function appearanceDescriptorPublicJob(job) {
  if (!job) return null;
  const { _expiresAt, ...view } = job;
  return view;
}

apiRouter.post('/v1/image-features/appearance-transfer/descriptor-jobs', async (req, res) => {
  try {
    if (!config.appearanceTransfer || config.appearanceTransfer.descriptorEnabled === false) {
      return res.status(503).json({ error: 'Lighting descriptor analysis is disabled', errorCode: 'descriptor_disabled' });
    }
    const { projectId, processorNodeId, referenceNodeId, referenceAssetId, referenceUrl, modelId } = req.body || {};
    if (!projectId || !processorNodeId || !referenceUrl) {
      return res.status(400).json({ error: 'projectId, processorNodeId and referenceUrl are required', errorCode: 'invalid_descriptor_input' });
    }
    const row = await getSessionWritableCanvasForUser(req, res, projectId);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });

    const vision = await resolveVisionInputForLLM(referenceUrl, projectId);
    if (!vision) {
      return res.status(400).json({ error: 'Reference image could not be localized for analysis', errorCode: 'invalid_descriptor_input' });
    }

    const requestedModel = String(modelId || config.appearanceTransfer.descriptorModel || 'gemini-3.1-flash-image').trim();
    const fallbackModel = String(config.appearanceTransfer.descriptorFallbackModel || '').trim();
    const referenceHash = crypto.createHash('sha256').update(vision.url).digest('hex');
    const { jobId } = appearanceDescriptorService.computeDescriptorJobId({
      referenceHash,
      requestedModel,
      resolvedModel: requestedModel,
    });

    const cached = appearanceDescriptorJobStore.get(jobId);
    if (cached && (cached.status === 'succeeded' || cached.status === 'running')) {
      return res.json(appearanceDescriptorPublicJob(cached));
    }

    const startedAtIso = new Date().toISOString();
    const baseJob = {
      jobId,
      projectId,
      processorNodeId,
      referenceNodeId: referenceNodeId || null,
      referenceAssetId: referenceAssetId || null,
      referenceAssetHash: referenceHash,
      requestedModel,
      resolvedModel: requestedModel,
      status: 'running',
      progress: 0.1,
      attempts: 0,
      descriptor: null,
      descriptorHash: null,
      errorCode: null,
      errorMessage: null,
      schemaVersion: appearanceDescriptorService.DESCRIPTOR_SCHEMA_VERSION,
      promptVersion: appearanceDescriptorService.DESCRIPTOR_PROMPT_VERSION,
      createdAt: startedAtIso,
      updatedAt: startedAtIso,
      completedAt: null,
    };
    appearanceDescriptorJobStore.set(baseJob);

    // Up to 2 attempts (mirrors the frozen service). Attempt 2 switches to the
    // fallback model when one is configured AND adds the corrective preamble, so
    // one budget covers both "gateway lacks the model" and "bad JSON".
    const attemptModels = fallbackModel && fallbackModel !== requestedModel
      ? [requestedModel, fallbackModel]
      : [requestedModel, requestedModel];
    let descriptor = null;
    let lastError = null;
    let resolvedModel = requestedModel;
    let attempts = 0;
    for (let i = 0; i < 2; i += 1) {
      attempts = i + 1;
      resolvedModel = attemptModels[i];
      try {
        requireLlmKey();
        const messages = [
          { role: 'system', content: appearanceDescriptorService.DESCRIPTOR_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: vision.url, format: vision.format } },
              { type: 'text', text: appearanceDescriptorService.buildDescriptorInstruction({ retry: i > 0 }) },
            ],
          },
        ];
        const response = await postLlmChatCompletions({
          model: resolvedModel,
          messages,
          stream: false,
          temperature: 0,
          // gemini-3.1-pro-preview is a reasoning model: internal reasoning can
          // burn ~2000-3000+ completion tokens, so a low cap truncates the
          // descriptor JSON (finish_reason=length) and parsing always fails.
          max_tokens: 8192,
        });
        const text = extractChatText(response.data).trim();
        descriptor = appearanceDescriptorService.parseDescriptorResponse(text);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!descriptor) {
      const isSchemaError = lastError instanceof appearanceDescriptorService.DescriptorSchemaError;
      const failedJob = {
        ...baseJob,
        status: 'failed',
        progress: 1,
        attempts,
        resolvedModel,
        errorCode: isSchemaError ? 'descriptor_schema_invalid' : 'descriptor_provider_failed',
        errorMessage: isSchemaError
          ? 'The analyzer did not return a valid LightingDescriptorV1.'
          : (llmErrorMessageFrom(lastError, resolvedModel) || 'The reference-light analyzer request failed.'),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      appearanceDescriptorJobStore.set(failedJob);
      return res.json(appearanceDescriptorPublicJob(failedJob));
    }

    const descriptorHash = appearanceDescriptorService.computeDescriptorHash(descriptor);
    const succeededJob = {
      ...baseJob,
      status: 'succeeded',
      progress: 1,
      attempts,
      resolvedModel,
      descriptor,
      descriptorHash,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    appearanceDescriptorJobStore.set(succeededJob);
    return res.json(appearanceDescriptorPublicJob(succeededJob));
  } catch (error) {
    return res.status(error?.response?.status || 500).json({ error: errorMessageFrom(error) });
  }
});

apiRouter.get('/v1/image-features/appearance-transfer/descriptor-jobs/:projectId/:processorNodeId/:jobId', async (req, res) => {
  try {
    const { projectId, jobId } = req.params;
    const row = await getSessionReadableCanvasForUser(req, res, projectId);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });
    const job = appearanceDescriptorJobStore.get(jobId);
    if (!job) return res.status(404).json({ error: 'Descriptor job not found', errorCode: 'descriptor_job_not_found' });
    return res.json(appearanceDescriptorPublicJob(job));
  } catch (error) {
    return res.status(error?.response?.status || 500).json({ error: errorMessageFrom(error) });
  }
});

// Appearance-transfer history (Phase C): persistent, per-processor-node history
// read from generation_tasks (NOT inferred from canvas nodes). Classifies by the
// explicit appearanceLightingMode; preserve-scene / replace-background interleaved.
apiRouter.get('/v1/image-features/appearance-transfer/history', async (req, res) => {
  try {
    const projectId = req.query.projectId;
    const processorNodeId = req.query.processorNodeId;
    if (!projectId || !processorNodeId) {
      return res.status(400).json({ error: 'projectId and processorNodeId are required', errorCode: 'invalid_history_query' });
    }
    const row = await getSessionReadableCanvasForUser(req, res, projectId);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });
    const page = await appearanceHistoryService.listHistory({
      projectUuid: projectId,
      processorNodeId,
      limit: req.query.limit,
    });
    return res.json(page);
  } catch (error) {
    return res.status(error?.response?.status || 500).json({ error: errorMessageFrom(error) });
  }
});

apiRouter.post('/light-stage/mask', async (req, res) => {
  const cleanupFiles = [];
  try {
    const { projectUuid, nodeKey, normalUrl, state = {} } = req.body || {};
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });
    if (!normalUrl) return res.status(400).json({ error: 'Light Stage normal asset is required' });

    const normalInput = await resolveToOpenAiImageInput(normalUrl, projectUuid);
    if (!normalInput?.filePath || !fs.existsSync(normalInput.filePath)) {
      return res.status(400).json({ error: 'Light Stage normal asset could not be localized' });
    }
    cleanupFiles.push(...(normalInput.cleanupFiles || []));
    const item = await lightStageGeometryService.buildLightMaskAsset(
      fs.readFileSync(normalInput.filePath),
      state,
      { sourceNodeId: nodeKey },
    );
    const fullPath = path.join(assetsDir(projectUuid), item.storedName);
    if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, item.buffer);
    await mirrorStoredAsset(projectUuid, item.storedName, fullPath, item.mimeType);
    const stat = fs.statSync(fullPath);
    await upsertAssetRecord(row, {
      originalName: item.storedName,
      storedName: item.storedName,
      relativePath: assetRelativePath(projectUuid, item.storedName),
      mimeType: item.mimeType,
      byteSize: stat.size,
      sha1: item.sha1,
      sourceType: 'light-stage',
    });
    res.json({
      maskUrl: `/assets/${projectUuid}/${item.storedName}`,
      width: item.width,
      height: item.height,
    });
  } catch (error) {
    res.status(error?.response?.status || 500).json({ error: errorMessageFrom(error) });
  } finally {
    for (const filePath of cleanupFiles) fs.rmSync(filePath, { force: true });
  }
});

apiRouter.post('/subject-matting/automatic', async (req, res) => {
  const cleanupFiles = [];
  try {
    const { projectUuid, nodeKey, sourceUrl } = req.body || {};
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });
    if (!sourceUrl) return res.status(400).json({ error: 'Subject matting source image is required' });

    const sourceInput = await resolveToOpenAiImageInput(sourceUrl, projectUuid);
    if (!sourceInput?.filePath || !fs.existsSync(sourceInput.filePath)) {
      return res.status(400).json({ error: 'Subject matting source image could not be localized' });
    }
    cleanupFiles.push(...(sourceInput.cleanupFiles || []));
    const sourceBuffer = fs.readFileSync(sourceInput.filePath);
    const mattingConfig = config.subjectMatting || {};
    const result = await subjectMattingService.buildSubjectMask(sourceBuffer, {
      sourceNodeId: nodeKey,
      serviceUrl: mattingConfig.serviceUrl,
      serviceToken: mattingConfig.serviceToken,
      timeoutMs: mattingConfig.timeoutMs,
      allowLocalFallback: mattingConfig.allowLocalFallback,
    });
    res.json({
      mask: {
        provider: result.provider,
        modelId: result.modelId,
        modelRevision: result.modelRevision,
        status: result.status,
        width: result.width,
        height: result.height,
        maskCoverage: result.maskCoverage,
        maskBorderCoverage: result.maskBorderCoverage,
        maskTouchedEdges: result.maskTouchedEdges,
        maskReliable: result.maskReliable,
        sha1: result.sha1,
        maskDataUrl: `data:image/png;base64,${result.maskBuffer.toString('base64')}`,
        warning: result.warning || undefined,
      },
    });
  } catch (error) {
    res.status(error?.response?.status || 500).json({ error: errorMessageFrom(error) });
  } finally {
    for (const filePath of cleanupFiles) fs.rmSync(filePath, { force: true });
  }
});

apiRouter.post('/subject-matting/correction', async (req, res) => {
  const cleanupFiles = [];
  try {
    const {
      projectUuid,
      nodeKey,
      sourceUrl,
      intent,
      promptType,
      point,
      box,
      taskVersion,
    } = req.body || {};
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });
    if (!sourceUrl) return res.status(400).json({ error: 'Subject matting source image is required' });
    if (!['keep', 'exclude'].includes(String(intent || ''))) {
      return res.status(400).json({ error: 'Subject matting correction intent is required' });
    }
    if (!['point', 'box'].includes(String(promptType || ''))) {
      return res.status(400).json({ error: 'Subject matting correction prompt type is required' });
    }

    const sourceInput = await resolveToOpenAiImageInput(sourceUrl, projectUuid);
    if (!sourceInput?.filePath || !fs.existsSync(sourceInput.filePath)) {
      return res.status(400).json({ error: 'Subject matting source image could not be localized' });
    }
    cleanupFiles.push(...(sourceInput.cleanupFiles || []));
    const sourceBuffer = fs.readFileSync(sourceInput.filePath);
    const mattingConfig = config.subjectMatting || {};
    const result = await subjectMattingService.buildRemoteSubjectCorrection(sourceBuffer, {
      sourceNodeId: nodeKey,
      serviceUrl: mattingConfig.serviceUrl,
      serviceToken: mattingConfig.serviceToken,
      timeoutMs: mattingConfig.timeoutMs,
      intent: String(intent),
      promptType: String(promptType),
      point: point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
        ? { x: Number(point.x), y: Number(point.y) }
        : undefined,
      box: box
        && Number.isFinite(Number(box.x))
        && Number.isFinite(Number(box.y))
        && Number.isFinite(Number(box.width))
        && Number.isFinite(Number(box.height))
        ? {
          x: Number(box.x),
          y: Number(box.y),
          width: Number(box.width),
          height: Number(box.height),
        }
        : undefined,
      taskVersion: Number(taskVersion || 0),
    });
    res.json({
      mask: {
        provider: result.provider,
        modelId: result.modelId,
        modelRevision: result.modelRevision,
        status: result.status,
        width: result.width,
        height: result.height,
        maskCoverage: result.maskCoverage,
        sha1: result.sha1,
        taskVersion: result.taskVersion,
        maskDataUrl: `data:image/png;base64,${result.maskBuffer.toString('base64')}`,
      },
    });
  } catch (error) {
    res.status(error?.response?.status || 500).json({ error: errorMessageFrom(error) });
  } finally {
    for (const filePath of cleanupFiles) fs.rmSync(filePath, { force: true });
  }
});

async function startVideoMergeRender(req, row, projectUuid, nodeKey, params = {}) {
  const internalId = randomId();
  const taskRecord = await jobService.createPersistentTask({
    ...generationTaskBaseFromCanvas(req, row, { projectUuid, nodeKey }),
    jobId: internalId,
    taskType: 'video',
    endpoint: '/render/video-merge',
    provider: 'ffmpeg',
    model: 'ffmpeg',
    mode: 'video_merge',
    quantity: 1,
    referenceMaterials: summarizeVideoReferences(params, {
      imageList: [],
      videoList: params.videoList || [],
      audioList: [],
    }),
    requestParams: compactGenerationRequestParams(params, {
      action: 'video_merge',
      clipCount: Array.isArray(params.mergeClips) ? params.mergeClips.length : 0,
    }),
  });
  const mergePromise = exportVideoMergeComposition(projectUuid, row, params, (progressPercent) => {
    jobService.setTask(internalId, { status: 1, progressPercent });
  })
    .then(async (stored) => {
      await jobService.setTaskAndWait(internalId, {
        status: 2,
        progressPercent: 100,
        urls: [stored.url],
        outputs: [{
          index: 0,
          url: stored.url,
          mimeType: 'video/mp4',
          durationSec: Number(stored.meta?.durationSec || 0) || undefined,
          model: 'ffmpeg',
          isPrimary: true,
          metadata: stored.meta || null,
        }],
        providerStatus: { phase: 'completed', renderer: 'ffmpeg' },
      });
    })
    .catch(async (error) => {
      await jobService.setTaskAndWait(internalId, {
        status: 3,
        progressPercent: 0,
        error: error.message || String(error),
        providerStatus: { phase: 'failed', renderer: 'ffmpeg' },
      });
    });
  trackGenerationPromise(activeNonResumableGenerations, internalId, mergePromise);
  return { jobId: internalId, generationVersion: taskRecord.generationVersion };
}

apiRouter.post('/render/video-merge', async (req, res) => {
  try {
    const { projectUuid, nodeKey, params = {} } = req.body || {};
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: 'Canvas not found or unavailable' });
    res.json(await startVideoMergeRender(req, row, projectUuid, nodeKey, {
      ...params,
      action: 'video_merge',
    }));
  } catch (error) {
    res.status(error?.response?.status || 500).json({ error: errorMessageFrom(error) });
  }
});

apiRouter.post('/generate/image', async (req, res) => {
  try {
    const { projectUuid, nodeKey, params = {} } = req.body;
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
    if (params?.action === 'video_merge') {
      res.json(await startVideoMergeRender(req, row, projectUuid, nodeKey, params));
      return;
    }

    const settings = params.settings || {};
    const imageList = params.imageList || [];
    const promptChips = params.promptChips || [];
    const modeType = String(params.modeType || '').toLowerCase();
    const useImageRefs = modeType !== 'text2image';
    const repaintConfig = imageRepaintService.normalizeRepaintConfig(params?.advancedSettings?.repaint);
    if (params?.advancedSettings?.repaint && !repaintConfig) {
      return res.status(400).json({ error: '局部重绘参数不完整，请重新打开局部重绘后再试。' });
    }
    const lightStageGeometryUrls = params?.advancedSettings?.lightStage?.geometryUrls || {};
    const orderedLightStageRefs = [
      lightStageGeometryUrls.diffuse,
      lightStageGeometryUrls.normal,
      lightStageGeometryUrls.depth,
      lightStageGeometryUrls.mask,
    ].filter(Boolean);
    const refUrls = useImageRefs
      ? [...new Set([...imageList, ...promptChips].map((item) => item.url).filter(Boolean))]
      : [];
    if (repaintConfig && !refUrls.includes(repaintConfig.sourceUrl)) {
      refUrls.unshift(repaintConfig.sourceUrl);
    }
    if (useImageRefs && orderedLightStageRefs.length) {
      for (const url of orderedLightStageRefs) {
        if (!refUrls.includes(url)) refUrls.push(url);
      }
    }
    const normalizedModel = normalizeImageModel(params.model);
    const normalizedMode = refUrls.length ? 'image2image' : 'text2image';
    const normalizedRatio = openAIImageProvider.normalizeImageRatio(normalizedModel, settings.ratio || openAIImageProvider.rules.defaults.ratio);
    const normalizedResolution = openAIImageProvider.normalizeImageResolution(normalizedModel, settings.resolution || openAIImageProvider.rules.defaults.resolution);
    const normalizedCount = openAIImageProvider.normalizeImageCount(normalizedModel, params.count);
    const imageProviderName = openAIImageProvider.getImageModelRule(normalizedModel).provider || 'openai-compatible';
    openAIImageProvider.validateImageCapabilities({
      model: normalizedModel,
      mode: normalizedMode,
      prompt: params.prompt || '',
      imageCount: refUrls.length,
      ratio: normalizedRatio,
      resolution: normalizedResolution,
      count: normalizedCount,
    });
    const internalId = randomId();
    const usageLogId = await safeCreateUsageLog(req, row, {
      projectUuid,
      nodeKey,
      operationType: 'image',
      endpoint: '/generate/image',
      provider: imageProviderName,
      model: normalizedModel,
      mode: normalizedMode,
      quantity: normalizedCount,
      promptChars: String(params.prompt || '').length,
      promptPreview: params.prompt || '',
      inputCounts: { ...usageInputCounts(params), promptChips: promptChips.length, refUrls: refUrls.length },
      settings: {
        ratio: normalizedRatio,
        resolution: normalizedResolution,
        quality: normalizeImageQuality(settings.quality),
        operation: repaintConfig ? 'repaint' : 'generate',
      },
    });
    const taskRecord = await jobService.createPersistentTask({
      ...generationTaskBaseFromCanvas(req, row, { projectUuid, nodeKey }),
      jobId: internalId,
      taskType: 'image',
      endpoint: '/generate/image',
      provider: imageProviderName,
      model: normalizedModel,
      mode: normalizedMode,
      ratio: normalizedRatio,
      resolution: normalizedResolution,
      quantity: normalizedCount,
      referenceMaterials: summarizeVideoReferences(params, { imageList, videoList: [], audioList: [] }),
      requestParams: compactGenerationRequestParams(params, {
        normalizedModel,
        ratio: normalizedRatio,
        resolution: normalizedResolution,
        quality: normalizeImageQuality(settings.quality),
        refUrls,
        appearanceTransfer: params.advancedSettings?.appearanceTransfer || undefined,
        repaint: repaintConfig
          ? {
              version: repaintConfig.version,
              contract: repaintConfig.contract,
              sourceNodeId: repaintConfig.sourceNodeId,
              sourceUrl: repaintConfig.sourceUrl,
              maskUrl: repaintConfig.maskUrl,
              maskWidth: repaintConfig.maskWidth,
              maskHeight: repaintConfig.maskHeight,
              maskCoverage: repaintConfig.maskCoverage,
              commandCount: repaintConfig.commandCount,
              brushSize: repaintConfig.brushSize,
            }
          : null,
      }),
      usageLogId,
    });
    const abortController = new AbortController();
    generationAbortControllers.set(internalId, abortController);

    const imageGenerationPromise = (async () => {
      try {
        jobService.setTask(internalId, { status: 1, progressPercent: 1 });
        const urls = await generateOpenAiImages(
          {
            prompt: params.prompt || '',
            model: normalizedModel,
            ratio: normalizedRatio,
            resolution: normalizedResolution,
            quality: normalizeImageQuality(settings.quality),
            count: normalizedCount,
            images: refUrls,
            repaint: repaintConfig,
            signal: abortController.signal,
            onProgress: (progressPercent) => {
              jobService.setTask(internalId, { status: 1, progressPercent });
            }
          },
          projectUuid,
          row
        );
        if (abortController.signal.aborted) {
          const cancelledError = new Error('image generation cancelled');
          cancelledError.name = 'AbortError';
          throw cancelledError;
        }
        jobService.setTask(internalId, { status: 2, progressPercent: 100, urls });
        await safeUpdateUsageLog(usageLogId, { status: 'succeeded', resultCount: urls.length });
      } catch (error) {
        if (isGenerationCancelled(error, abortController.signal)) {
          await jobService.cancelPersistentTask(internalId);
          await safeUpdateUsageLog(usageLogId, { status: 'cancelled', errorMessage: 'user cancelled image generation' });
          return;
        }
        jobService.setTask(internalId, { status: 3, progressPercent: 0, error: errorMessageFrom(error) });
        await safeUpdateUsageLog(usageLogId, { status: 'failed', errorMessage: errorMessageFrom(error) });
      } finally {
        if (generationAbortControllers.get(internalId) === abortController) {
          generationAbortControllers.delete(internalId);
        }
      }
    })();
    trackGenerationPromise(activeNonResumableGenerations, internalId, imageGenerationPromise);
    res.json({ jobId: internalId, generationVersion: taskRecord.generationVersion });
  } catch (error) {
    res.status(error?.response?.status || 500).json({ error: errorMessageFrom(error) });
  }
});

apiRouter.post('/generate/video', async (req, res) => {
  try {
    const { projectUuid, nodeKey, params } = req.body;
    if (params?.action === 'video_merge') {
      return res.status(400).json({
        error: 'Video merge must use /render/video-merge and cannot be sent to the video provider',
        errorCode: 'VIDEO_MERGE_ROUTE_REQUIRED',
        billable: false,
      });
    }
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
    const settings = params.settings || {};
    const imageList = (params.imageList || []).filter((item) => item?.url);
    const videoList = (params.videoList || []).filter((item) => item?.url);
    const audioList = (params.audioList || []).filter((item) => item?.url);
    const model = params.model || 'Seedance_2_0';
    const modeType = normalizeVideoMode(params.modeType || 'omni');
    const ratio = normalizeVideoRatio(model, settings.ratio || '16:9', modeType);
    const resolution = normalizeVideoResolution(model, settings.resolution || '720P');
    const duration = normalizeVideoDuration(model, settings.duration || 5, modeType);
    const count = normalizeVideoCount(model, params.count, imageList.length > 0);
    const referenceMaterials = summarizeVideoReferences(params, { imageList, videoList, audioList });
    const submissionParams = {
      taskType: 'video-generation',
      endpoint: '/generate/video',
      nodeKey,
      model,
      mode: modeType,
      ratio,
      resolution,
      durationSec: duration,
      quantity: count,
      enableSound: settings.enableSound || 'on',
      requested: {
        model: params.model || null,
        modeType: params.modeType || null,
        settings: params.settings || {},
        count: params.count || null,
      },
    };

    validateVideoCapabilities({
      model,
      mode: modeType,
      prompt: params.prompt || '',
      imageCount: imageList.length,
      videoCount: videoList.length,
      audioCount: audioList.length,
      ratio,
      resolution,
      duration,
      count,
    });

    const internalId = randomId();
    const videoProvider = String(getVideoModelRule(model).provider || 'seedance').toLowerCase();
    const usageLogId = await safeCreateUsageLog(req, row, {
      projectUuid,
      nodeKey,
      operationType: 'video',
      endpoint: '/generate/video',
      provider: videoProvider,
      model,
      mode: modeType,
      quantity: count,
      promptChars: String(params.prompt || '').length,
      promptPreview: params.prompt || '',
      inputCounts: {
        images: imageList.length,
        videos: videoList.length,
        audios: audioList.length,
        texts: Array.isArray(params.textList) ? params.textList.length : 0,
      },
      settings: { ratio, resolution, duration, enableSound: settings.enableSound || 'on' },
    });
    const videoTaskDetailId = await safeCreateVideoTaskDetail(req, row, {
      usageLogId,
      projectUuid,
      nodeKey,
      internalJobId: internalId,
      provider: videoProvider,
      model,
      mode: modeType,
      ratio,
      resolution,
      durationSec: duration,
      quantity: count,
      status: 'submitted',
      promptPreview: params.prompt || '',
      submissionParams,
      referenceMaterials,
    });
    const taskRecord = await jobService.createPersistentTask({
      ...generationTaskBaseFromCanvas(req, row, { projectUuid, nodeKey }),
      jobId: internalId,
      taskType: 'video',
      endpoint: '/generate/video',
      provider: videoProvider,
      model,
      mode: modeType,
      ratio,
      resolution,
      durationSec: duration,
      quantity: count,
      referenceMaterials,
      requestParams: submissionParams,
      usageLogId,
      videoTaskDetailId,
      // 视频节点允许同时挂多个生成：上一条没跑完再点生成，两条各自跑完各自追加，
      // 谁也不取代谁。只有视频走这条路，图片 / 文字仍是「后者取代前者」。
      concurrent: true,
    });
    res.json({ jobId: internalId, generationVersion: taskRecord.generationVersion });

    const providerSubmissionPromise = (async () => {
      try {
        // 参考图取不到就**让这次生成失败**，绝不静默丢掉后照发 —— 悄悄丢掉的后果是
        // 用户花钱拿到一段跟参考图无关的视频，而且完全不知道发生了什么
        // （2026-08-19：近 30 天 67 条参考图就是这么消失的）。
        const wantedImages = imageList.filter((item) => item.url);
        const resolvedImages = await Promise.all(
          wantedImages.map((item) => resolveImageUrlForLLM(item.url, projectUuid, req))
        );
        const missingImageIndex = resolvedImages.findIndex((value) => !value);
        if (missingImageIndex >= 0) {
          throw new Error(
            `参考图读取失败（第 ${missingImageIndex + 1} 张：${wantedImages[missingImageIndex].url}）。`
            + '这张图可能已被删除，或来自另一个画布且文件不在本画布下。请把图重新拖进来再生成。'
          );
        }
        const images = resolvedImages.filter(Boolean);
        const rawVideoUrls = videoList.map((item) => item.url).filter(Boolean);
        const videos = await prepareSeedanceReferenceVideos(req, rawVideoUrls, projectUuid, row, model);
        const audios = (
          await Promise.all(
            audioList
              .map((item) => item.url)
              .filter(Boolean)
              .map((url) => resolveAssetPublicUrlForExternalUse(req, url, projectUuid))
          )
        ).filter(Boolean);
        const seedanceParams = {
          prompt: params.prompt || '',
          modelPrompt: params.modelPrompt || '',
          model,
          modeType,
          ratio,
          duration,
          resolution,
          enableSound: settings.enableSound || 'on',
          images,
          videos,
          audios
        };
        await safeUpdateVideoTaskDetail(videoTaskDetailId, {
          status: 'running',
          providerStatus: {
            phase: 'references_prepared',
            imageCount: images.length,
            videoCount: videos.length,
            audioCount: audios.length,
            omniReferenceTaskType: seedanceOmniReferenceTaskType(model, modeType, videos.length) || null,
          },
        });
        const submitVideo = videoProvider === 'minimax' ? submitMinimaxVideo : submitSeedanceVideo;
        const pollVideo = videoProvider === 'minimax' ? pollMinimaxResult : pollSeedanceResult;
        const jobIds = [];
        for (let index = 0; index < count; index += 1) {
          jobIds.push(await submitVideo(seedanceParams));
          await safeUpdateUsageLog(usageLogId, { providerJobIds: jobIds });
          await safeUpdateVideoTaskDetail(videoTaskDetailId, {
            status: 'running',
            providerJobIds: jobIds,
            providerStatus: {
              phase: 'provider_submitted',
              submitted: index + 1,
              total: count,
            },
          });
        jobService.setTask(internalId, {
          status: 1,
          progressPercent: Math.max(1, Math.round(((index + 1) / count) * 8)),
          providerJobIds: jobIds,
          providerStatus: {
            phase: 'provider_submitted',
            submitted: index + 1,
            total: count,
          },
        });
        }
        if (jobIds.length === 1) {
          pollAndStore(jobIds[0], internalId, projectUuid, pollVideo, {
            intervalMs: 10_000,
            maxAttempts: 200,
            ensureRvCompatibleVideos: true,
            onSucceeded: async (urls) => {
              await Promise.all([
                safeUpdateUsageLog(usageLogId, { status: 'succeeded', resultCount: urls.length }),
                safeUpdateVideoTaskDetail(videoTaskDetailId, {
                  status: 'succeeded',
                  resultUrls: urls,
                  providerStatus: { phase: 'completed', resultCount: urls.length },
                }),
              ]);
            },
            onFailed: async (message) => {
              await Promise.all([
                safeUpdateUsageLog(usageLogId, { status: 'failed', errorMessage: message }),
                safeUpdateVideoTaskDetail(videoTaskDetailId, {
                  status: 'failed',
                  errorMessage: message,
                  providerStatus: { phase: 'failed' },
                }),
              ]);
            },
          });
        }
        else pollVideoManyAndStore(jobIds, internalId, projectUuid, {
          pollResult: pollVideo,
          providerLabel: videoProvider === 'minimax' ? 'MiniMax' : 'Seedance',
          onSucceeded: async (urls) => {
            await Promise.all([
              safeUpdateUsageLog(usageLogId, { status: 'succeeded', resultCount: urls.length }),
              safeUpdateVideoTaskDetail(videoTaskDetailId, {
                status: 'succeeded',
                resultUrls: urls,
                providerStatus: { phase: 'completed', resultCount: urls.length },
              }),
            ]);
          },
          onFailed: async (message) => {
            await Promise.all([
              safeUpdateUsageLog(usageLogId, { status: 'failed', errorMessage: message }),
              safeUpdateVideoTaskDetail(videoTaskDetailId, {
                status: 'failed',
                errorMessage: message,
                providerStatus: { phase: 'failed' },
              }),
            ]);
          },
        });
      } catch (error) {
        const message = errorMessageFrom(error);
        jobService.setTask(internalId, { status: 3, progressPercent: 0, error: message });
        await safeUpdateUsageLog(usageLogId, { status: 'failed', errorMessage: message });
        await safeUpdateVideoTaskDetail(videoTaskDetailId, {
          status: 'failed',
          errorMessage: message,
          providerStatus: { phase: 'submit_failed' },
        });
      }
    })();
    trackGenerationPromise(activeProviderSubmissions, internalId, providerSubmissionPromise);
  } catch (error) {
    res.status(500).json({ error: errorMessageFrom(error) });
  }
});

apiRouter.post('/generate/audio', async (req, res) => {
  try {
    const { projectUuid, params } = req.body;
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
    const jobId = await submitGenAudio(params || {});
    const internalId = randomId();
    jobService.setTask(internalId, { status: 1, progressPercent: 0 });
    pollAndStore(jobId, internalId, projectUuid);
    res.json({ jobId: internalId });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

apiRouter.post('/generate/script', async (req, res) => {
  let usageLogId = null;
  let taskJobId = null;
  try {
    const { projectUuid, nodeKey, params = {} } = req.body || {};
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: '画布不存在或没有权限' });
    const prompt = String(params.description || '').trim();
    if (!prompt) return res.status(400).json({ error: '请输入故事描述' });
    if (!config.llmApiKey) return res.status(500).json({ error: 'LLM_API_KEY 未配置，请在服务器 .env 中设置后重启服务' });

    const textModel = String(params.textModel || params.llmModel || config.defaultChatModel);
    taskJobId = randomId();
    usageLogId = await safeCreateUsageLog(req, row, {
      projectUuid,
      nodeKey,
      operationType: 'text',
      endpoint: '/generate/script',
      provider: 'llm-proxy',
      model: textModel,
      mode: 'script',
      quantity: 1,
      promptChars: prompt.length,
      promptPreview: prompt,
      inputCounts: usageInputCounts(params),
      settings: { performanceMode: 'highest', reasoningEffort: 'high' },
    });
    const taskRecord = await jobService.createPersistentTask({
      ...generationTaskBaseFromCanvas(req, row, { projectUuid, nodeKey }),
      jobId: taskJobId,
      taskType: 'text',
      endpoint: '/generate/script',
      provider: 'llm-proxy',
      model: textModel,
      mode: 'script',
      quantity: 1,
      referenceMaterials: summarizeVideoReferences(params),
      requestParams: compactGenerationRequestParams(params, {
        description: prompt.slice(0, 12000),
        performanceMode: 'highest',
        reasoningEffort: 'high',
      }),
      usageLogId,
    });
    const messages = [
      {
        role: 'system',
        content: [
          '你是专业影视分镜导演。',
          '请把用户输入拆成结构化分镜。',
          '只输出 JSON 数组，不要 Markdown，不要解释。',
          '每项必须包含 id, shot, sceneType, action, dialogue, duration。',
          'duration 使用数字秒数；dialogue 没有就返回空字符串；action 用中文写清画面主体、动作、镜头运动、环境和情绪。'
        ].join('\n')
      },
      { role: 'user', content: prompt }
    ];
    const text = await chatComplete(messages, textModel, { performanceMode: 'highest', reasoningEffort: 'high' });
    if (!text) return res.status(500).json({ error: 'AI 没有返回可用分镜内容，请再试一次' });
    await safeUpdateUsageLog(usageLogId, {
      status: 'succeeded',
      resultCount: 1,
      settings: { performanceMode: 'highest', reasoningEffort: 'high', outputChars: text.length },
    });
    jobService.setTask(taskJobId, {
      status: 2,
      progressPercent: 100,
      providerStatus: { phase: 'completed', outputChars: text.length },
    });
    res.json({ text, taskId: taskJobId, generationVersion: taskRecord.generationVersion });
  } catch (error) {
    const status = error.response?.status;
    const message =
      status === 401
        ? 'LLM_API_KEY 无效，请更新服务器密钥'
        : error.response?.data?.error?.message ||
          error.response?.data?.message ||
          error.message ||
          String(error);
    await safeUpdateUsageLog(usageLogId, { status: 'failed', errorMessage: message });
    if (taskJobId) jobService.setTask(taskJobId, { status: 3, progressPercent: 0, error: message });
    res.status(500).json({ error: message });
  }
});

apiRouter.post('/generate/script-legacy-mivo', async (req, res) => {
  try {
    res.status(410).json({ error: 'Legacy MIVO translation endpoint removed. Use /generate/translate.' });
    return;
    const prompt = req.body.params?.description || '';
    const client = await mivoHttp();
    const response = await client.post('/legacy-mivo-translation-disabled', {
      text: `闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚敐澶婄闁挎繂鎲涢幘缁樼厱濠电姴鍊归崑銉╂煛鐏炶濮傜€殿喗鎸抽幃娆徝圭€ｎ亙澹曢悷婊呭鐢帞澹曢崸妤佺厵閻庣數顭堟牎闂佸摜濮甸崝娆撳蓟閿濆憘鏃堝焵椤掑嫭鍋嬮柛鈩冪懅缁犳棃鏌熼悜姗嗘畷闁绘挻娲熼弻鏇熺箾閸喖濮庨梺閫炲苯澧柟顔煎€垮畷娲倷閸濆嫮顓洪梺鎸庢濡嫭绂嶈ぐ鎺撶厽閹肩补鍓濈拹鈥斥攽椤旇姤灏﹂挊鐔哥節闂堟稓澧㈢痪鎹愭闇夐柨婵嗘处閸も偓婵犳鍠栭悧濠囧Φ閸曨垰惟闁靛鍨甸崥顐︽倵濞堝灝鏋涙い顓犲厴楠炲啴濮€閵堝懐顦ч梺缁樻尭缁ㄨ偐绱旈弴銏♀拻濞达絿顭堥ˉ蹇涙煕鐎ｎ亝顥㈢€规洑鍗抽獮妯兼嫚閼碱剦妲遍梻浣芥硶閸犳挻鎱ㄩ悽绋跨厱闁硅揪闄勯悡娆撴煠濞村娅呭ù鐘崇矊閳规垿鍨鹃悙钘変划闂佸搫鏈粙鎺旀崲濠靛纾兼繝濠傛啗閵娿儙鏃堟偐闂堟稐绮堕梺缁橆殕閹哥粯绌辨繝鍥х濞达綀鍊介妸鈺佺閺夊牆澧介崚浼存煛鐎ｎ偆銆掗柍褜鍓濋～澶娒哄鍫氣偓锕傚醇閿濆洣绨烽梻鍌欑窔閳ь剛鍋涢懟顖涙櫠鐎涙﹩娈介柣鎰儗濞堟粓鏌熼鑽ょ煓鐎规洏鍔嶇换娑㈡倷椤掆偓椤忓綊姊婚崒娆戭槮闁硅绱曠紓鎾诲锤濡も偓绾惧潡鏌涘Δ鍐ㄤ户闁瑰鍎遍埞鎴︽偐濞堟寧姣屽┑鈩冨絻閹虫ê鐣烽幋锕€宸濇い鏍ㄧ☉鎼村﹪姊洪崜鎻掍簼缂佽绉瑰畷鐢稿即閵忊€充化闂佹悶鍎崝搴ㄥΧ鐎涙ü绻嗛柟缁樺笧婢э箓鏌＄仦鐐缂佺姵鐩鎾倷閹扳晛鍔﹂柡灞剧洴瀵噣鍩€椤掑嫬绠伴柛鎰▕濞兼牗绻涘顔荤盎鐎瑰憡绻傞埞鎴︽偐閹绘巻鍋撻幖浣€澶愬醇閵夛腹鎷洪梺鍛婄☉閿曪絿娆㈤柆宥嗙厱闁靛绠戦埢鏇㈡煙椤曗偓缁犳牠鐛惔銊﹀殟闁靛鍨虹€氫粙姊绘担渚劸闁哄牜鍓熼幃鐤樄閽樻繈鏌ㄩ弴鐐测偓褰掓偂濞嗘垹妫柡澶婄仢閼哥懓霉濠婂嫮鐭掗柟钘夌埣閹瑩宕崟顓у晣婵犵數鍎戠紞鍡涘礈濞嗘劒绻嗛柤娴嬫櫇濡垶鏌熼鍡楀娴犳挳姊洪崫鍕効缂傚秳鐒﹂幈銊╁焵椤掑嫭鐓忛煫鍥э攻濞呭洭鏌涢弮鈧幃鍌氼潖濞差亝瀵犲璺猴攻濞堝爼姊洪崫銉バｉ柣妤冨Т椤曪絿鎷犲顔兼倯婵犮垼娉涢敃锕傚储閸涘﹦绠鹃弶鍫濆⒔閸掍即鏌熷ù瀣у亾閺傘儲鐏侀梺鍛婄懃椤﹁京寮ч埀顒€鈹戦悙鑼闁诲繑绻堥幃姗€鏁撻悩宕囧幍闂佸憡绋戦敃銈夊煝閺囩姭鍋撳▓鍨灕妞ゆ泦鍥х叀濠㈣泛谩閻斿吋鐓ラ悗锝呯仛缂嶅苯鈹戦悩鎰佸晱闁哥姵顨婇妴鍐川鐎涙ê浜遍梺绯曞墲閿氭い鏇憾閺岀喖鏌囬敃鈧崢鎾煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屾盯鏁愰崶褍骞嬮梺鍝勬湰閻╊垱淇婇幖浣肝╅柕澶堝劜閸庮亝绻濈喊妯峰亾閸愯尙楠囬梺鍛婃⒐閻熲晠鎮伴鍢夌喓浜搁弽褌澹曞┑鐐村灦椤忣亪顢旈崼顐ｆ櫅闂佺懓澧界划顖炲煕閹烘鐓曢悘鐐靛亾閻ㄦ垵顭胯缁嬫挾妲愰幒鏂哄亾閿濆骸浜滈柣蹇ョ畵閺屾稒鎯旈闂村枈濠殿喖锕ら…宄扮暦閹烘垟鏋庨柟鎼幗琚﹂梻鍌欐祰椤绮婇幘顔肩劦妞ゆ帊绀佹晶顖涚箾閸忚偐澧遍柟鍙夋倐閹囧醇濠靛牏鎳嗛梻浣规偠閸斿矂宕愰崸妤€钃熼柨婵嗩槸椤懘鏌ｅΟ鐑樷枙婵☆偄鐭傚鐑樻姜閹殿噮妲銈嗗灥椤﹂潧顕ｆ繝姘╅柕澶堝灪閺傗偓闂備胶纭跺褔寮插鍛噮缂傚倸鍊搁崐椋庢媼閺屻儱纾婚柟鍓х帛閻撴洘銇勯幇鍓佹偧閻犳劏鏅濋幉鎼佹偋閸繄鐟查梺鍝勬噺閻擄繝寮诲☉銏╂晝闁靛牆鎳忛悵鈩冪箾鐎电袥闁哄懏绮庨幑銏犫攽鐎ｎ亶娼婇梺鎸庣箓濡盯濡撮幇鐗堢厽閹兼番鍨婚。鍙夌節閵忊槄鑰块柨婵堝仩缁犳盯骞樻担瑙勩仢妞ゃ垺妫冨畷鐔碱敃閵堝洤鏄ュ┑鐘垫暩婵兘寮崨濠冨弿閻庣數纭堕崑鎾愁潩閻撳骸鈷嬮梺绯曟櫆閻╊垰鐣烽悡搴樻斀闁告劏鏅滈弶鎼佹⒒娴ｈ櫣甯涢柛鏃€娲栭锝夊醇閺囩偤妫烽梺褰掓？閻掞箓鎮￠悢鍏肩厵濞寸厧鐡ㄥ☉褔鏌ｈ箛銉╂闁逛究鍔嶇换婵嬪磼閵堝洤鎮戦柣搴ゎ潐濞叉鏁幒妤嬬稏婵犻潧顑愰弫鍕煢濡警妲峰瑙勬礋閹鎮烽弶娆句痪闂侀潻绲块ˉ鎰板Φ閹版澘绠抽柟瀵稿Т閳ь剛鍋ら幃宄邦煥閸曨厾鐓€闂傚洤顦甸弻鈥愁吋鎼粹€崇闂佺粯鎸哥换鎰板煘閹达附鍊烽梻鍫熺◥婢规洖鈹戦悙鍙夊櫣婵☆偅绻堝璇测槈濞嗘垹鐦堥梺绋挎湰缁嬫垶绂掗幘顔解拺闁告繂瀚～锕傛煕閺冣偓閸ㄧ敻顢氶敐澶樻晪闁逞屽墮閻ｇ兘骞掗幋鏃€顫嶅┑鐐叉閸ㄩ潧鈽夎濮婂宕掑▎鎺戝帯缂備緡鍣崹鎶藉箲閵忋倕纾奸柣鎰綑娴滎垱绻濋棃娑樷偓濠氣€﹂崼銉﹀珔闁绘柨鎽滅粻楣冩煙鐎涙鎳冮柣蹇婃櫊閺岋綁骞掗幘娣虎闂佸搫鏈惄顖炵嵁閸ヮ剙绀傞柛婵勫劚閸ゎ剟姊绘笟鈧濠氬箑閵夆晛鐐婇柕濞垮灪鐎氬ジ姊绘担渚敯闁稿鍔欏畷鎴濃槈濞嗗海绠氶梺浼欑到閻偐澹曟總鍛婂仯闁搞儯鍔岀徊缁樸亜韫囷絽寮柡灞剧洴閸╃偤骞嗚婢规洖鈹戦敍鍕杭闁稿﹥鐗曢蹇旂節濮橆剛锛涢梺瑙勫劤婢у海澹曟總鍛婄厽婵☆垰鐏濋惃娲极閸儲鍊甸悷娆忓缁€鍐╃箾閼碱剙鏋涚€殿喖顭峰畷鍗炍旈崘鈺傤啌闂備線娼чˇ顓㈠磿閸欏绶為柛鏇ㄥ灡閸婄敻姊婚崼鐔衡棨闁稿鍨婚埀顒侇問閸犳牠鎮ユ總鍝ュ祦閻庯綆鍠楅崑鎰偓瑙勬礀濞层倕顕ｉ悧鍫㈢瘈缁炬澘顦辩壕鍧楁煕鐎ｎ偄鐏寸€规洘鍔欏浠嬵敃閿濆棙顔囬梻浣告贡閸庛倝寮婚敓鐘茬；闁圭偓鍓氬鈺呮煟閹炬娊顎楃紒顐㈢Ч閹鎲撮崟顒傤槰闂佸憡姊归悷銉╂偩闁垮闄勭紒瀣仢瀹撳棝姊虹紒妯荤叆闁圭⒈鍋婇悰顔嘉旈崨顔规嫽婵炶揪绲介幗婊呯矓濞差亝鐓曢悗锝庝悍闊剛鈧娲濋～澶屸偓浣冨亹閳ь剚绋掗敋濞存粍顨婂楦裤亹閹烘垳鍠婇梺鍛婎焾椤绮嬪鍜佺叆闁割偆鍠撻崢顏呯節閵忥絾纭鹃柣妤€妫濆畷婵堚偓娑櫭肩换鍡樸亜閺嶎煈娈斿ù婊堢畺濮婂宕掑▎鎴М闂佸湱鈷堥崑濠囧箚鐏炴儳绶炵€光偓閳ь剛绮堟繝鍌樷偓鎺戭潩閿濆懍澹曢柣搴㈩問閸ｎ噣宕戞繝鍌滄殾婵せ鍋撴い銏＄懇閹虫牠鍩℃担鎰熸洖鈹戦敍鍕杭闁稿﹥鐗滈弫顕€骞掗弬鍝勪壕婵鍘у顔锯偓瑙勬礃閸ㄨ泛顕ラ崟顒傜闁绘劦鍓氶弶鎼佹⒒娴ｄ警鐒鹃柡鍫墰閸掓帡鎮╃紒妯衡偓鍨旈敐鍛殲闁绘挶鍨介弻娑㈠箛閸忓摜鐩庨梺鍝勵儐閸ㄥ湱妲愰幒鏃傜＜婵☆垰鍚嬮崚娑樜旈悩闈涗粶妞ゆ垵顦甸獮鍐煥閸繄鍊為梺鎸庢⒐瀹曟鎹㈤幋婵冩斀闁绘ê鐏氶弳鈺呮煕鐎ｎ偆娲撮柟顖氬暣閹粓鎸婃径灞剧叄闂備胶绮…鍫ヮ敋瑜旈幏鎴︽偄閸忚偐鍙嗗┑鐘绘涧濡厼危閸濄儳纾奸柣妯烘惈閸氬綊鏌嶈閸撴繈锝炴径濞掓椽寮介‖鈩冩そ婵¤埖寰勬繝鍌涘劒婵＄偑鍊栫敮鎺楀磹閼姐倕顥氶柦妯侯棦瑜版帗鏅插璺侯儐闁款厽绻濈喊妯峰亾閸愬弶鍊梺闈涙搐鐎氫即銆佸鈧幃娆撳矗婢诡厸鏅涢—鍐Χ鎼粹€茬盎缂備胶绮崝妤呭矗閸涱収娓婚柕鍫濇噽缁犱即鏌熼崘鏌ュ弰闁糕斁鍋撳銈嗗坊閸嬫挻銇勯鐘插幋鐎殿喛顕ч濂稿幢濡警娼梻浣筋潐椤旀牠宕板☉姘辩幓婵°倐鍋撻柍瑙勫灴閹瑩骞撻幒鎾斥偓顖炴倵閸忓浜剧紓浣割儐椤戞瑥顭囬弽銊х鐎瑰壊鍠曠花鑽も偓鐟版啞缁诲倿鍩為幋锔藉亹闁圭粯宸婚崑鎾愁潰鐏炵儵鍋撻弽顐ょ＝闁稿本鑹鹃埀顒傚厴閹偤鏁冮崒娑樹簵闂佹寧绋戠€氼喗绋夊澶嬬厸鐎广儱楠搁獮鏍磼?shot/sceneType/action/dialogue/duration闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚敐澶婄闁挎繂鎲涢幘缁樼厱濠电姴鍊归崑銉╂煛鐏炶濮傜€殿噮鍣ｅ畷濂告偄閸涘鍞堕梻鍌欒兌椤牓顢栭崱娑樼闁告挆鍐ㄧ亰濡炪倖鎸鹃崑鎰ｉ崼鐔剁箚妞ゆ牗绻嶉崵娆愮箾閸涘洤娲﹂埛鎴炵箾閼奸鍤欐鐐搭殜閺岋綁鎮㈤崣澶嬬彋閻庢鍠栭…鐑藉箖閵忋倕宸濆┑鐘插鑲栭梻鍌欑閹诧繝骞愰崱娑樺窛妞ゆ梻鐡旈崯鍛存⒒閸屾瑦绁版い鏇嗗應鍋撳☉鎺撴珚闁硅櫕绻冮妶锝夊礂椤栨碍澶勯悗闈涖偢瀵爼骞婄粵鍦暤闁哄本鐩鎾Ω閵壯傚摋缂傚倷鑳舵慨鍨箾婵犲洤钃熸繛鎴欏灩閻掓椽鏌涢幇鍓佺窗婵炲矈浜濈换婵嬪閿濆孩缍堝┑鐐插级钃辩紒宀冮哺缁绘繈宕堕妸銉㈠亾闁垮浜滈煫鍥ㄦ尭椤忋倝鏌涚€ｎ偅宕岀€殿喕绮欓垾鏍焺閸愨斂浠㈤梺绯曟櫔缁绘繂鐣峰鈧、鏃堝幢閳哄倐锔界節閻㈤潧浠﹂柟绋款煼瀹曟椽宕橀鑲╋紱闂佺懓澧界划顖炴偂閻斿摜绠鹃柟瀛樼箓閼歌绻涢崨顓犘ｆい銊ｅ劦閹瑩宕ｆ径濠冪亷婵＄偑鍊戦崹娲晝閵忋倕绠栭柕蹇曞Х閺嗗鏌℃径搴殾闁靛牆鎳夐弨浠嬫煥濞戞ê顏╁ù婊冦偢閺屾稒绻涢崹顔瑰亾濠靛棛鏆﹂柟杈剧畱缁犺櫕淇婇妶鍌氫壕闂佺琚崝宀勬箒闂佺粯锚濡﹪宕曡箛娑欑厾闁告縿鍎查崵鈧銈庡幖濞硷繝骞婂鍫燁棃婵炴垶锕╁鏃堟⒒娴ｇ懓鈻曢柡鈧柆宥呭瀭闁割偅娲栫粻鐐烘煏婵炵偓娅嗛柛瀣剁節閺岋絽螖閳ь剟鎮ф繝鍥х畺婵炲棙鎸婚埛鎴犵磽娴ｅ顏嗙箔濮橆厺绻嗛柣鎰閻瑧鈧鍠涢褔鍩ユ径鎰潊闁绘ɑ鐗戦弲鐘诲蓟閺囩喎绶炴繛鎴炶壘閸╁本绻涚€电顎岄柛锝忕秮楠炲啫螖閸愨晛鏋傞梺鍛婃处閸撴盯藝閵娿儮鏀介柣姗嗗枛閻忣亪鏌ㄩ弴妯虹伈闁轰焦鍔欓幃娆徝圭€ｎ偅鏉搁梻浣规偠閸庮垶宕濇惔锝囩煋闁割偅娲橀埛鎴︽煕閹邦剙绾ч柟顖氱墦閺屾盯鎮ゆ担闀愮敖缂?{prompt}`,
      targetLang: 'en'
    });
    res.json({ text: response.data?.data?.translated || response.data?.translated || '' });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

function cleanTranslatedPromptOutput(value, fallbackText = '') {
  let text = String(value || '').trim();
  text = text.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '').trim();
  text = text.replace(/^(translation|translated prompt|english prompt|prompt)\s*[:：]\s*/i, '').trim();
  if (!text) return fallbackText;
  if (!text.includes('\n') && text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '“' && last === '”')) {
      text = text.slice(1, -1).trim();
    }
  }
  return text || fallbackText;
}

async function translatePromptWithLlm(text) {
  const messages = [
    {
      role: 'system',
      content: [
        'You are a professional prompt translator for AI image and video generation.',
        'Translate the user prompt into natural, production-ready English.',
        'Preserve line breaks, markdown bullets, numbers, ratios, model names, filenames, quoted text, and every @mention exactly.',
        'Do not add explanation, labels, greetings, or extra commentary.',
        'If the prompt is already English, lightly polish it without changing its meaning.'
      ].join('\n')
    },
    { role: 'user', content: text }
  ];
  const translated = await chatComplete(messages, config.defaultChatModel, { performanceMode: 'standard' });
  return cleanTranslatedPromptOutput(translated, text);
}

async function translatePromptText(text) {
  const translated = await translatePromptWithLlm(text);
  return { translated, provider: 'llm' };
}

apiRouter.post('/generate/translate', async (req, res) => {
  try {
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.json({ translated: '' });
    }
    const result = await translatePromptText(text);
    res.json(result);
  } catch (error) {
    const message = error.response?.data?.error?.message || error.response?.data?.message || error.message || String(error);
    res.status(500).json({ error: message });
  }
});

apiRouter.post('/generation-errors/report', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const taskId = String(body.taskId || '').trim().slice(0, 80);
  const errorMessage = String(body.errorMessage || body.error || '客户端生成失败').slice(0, 32000);
  if (taskId) {
    const recorded = await recordGenerationTaskFailure(taskId, errorMessage);
    if (recorded) return res.json({ ok: true, sourceKey: `task:${taskId}` });
  }

  const clientRequestId = String(body.clientRequestId || crypto.randomUUID()).slice(0, 120);
  const params = body.params && typeof body.params === 'object' ? body.params : {};
  const recorded = await recordNodeGenerationError({
    sourceKey: `client:${req.user.id}:${clientRequestId}`,
    sourceType: 'http',
    userId: req.user.id,
    username: req.user.username,
    userRole: req.user.role,
    projectUuid: body.projectUuid,
    nodeKey: body.nodeKey,
    taskType: body.operationType || 'unknown',
    operationType: body.operationType || 'unknown',
    endpoint: body.endpoint || '/generate/unknown',
    provider: body.provider || params.provider,
    model: body.model || params.model,
    mode: body.mode || params.mode || params.modeType,
    ratio: body.ratio || params.ratio,
    resolution: body.resolution || params.resolution || params.quality,
    durationSec: body.durationSec || params.duration,
    quantity: body.quantity || params.count,
    httpStatus: body.httpStatus,
    errorMessage,
    requestParams: params,
    referenceMaterials: params.imageList || params.videoList || params.textList || null,
  });
  res.json({ ok: recorded, sourceKey: `client:${req.user.id}:${clientRequestId}` });
}));

apiRouter.post('/generate/llm', async (req, res) => {
  let usageLogId = null;
  let taskJobId = null;
  let outputChars = 0;
  try {
    const { projectUuid, nodeKey, params = {} } = req.body;
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return res.status(404).json({ error: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣濠垫劖缍楅梺閫炲苯澧柛濠傛健閵嗕礁鈻庨幘鏉戔偓閿嬨亜閹烘埈妲圭紓宥嗩殜濮婄粯鎷呴崨濠冨創濠电偛鐪伴崹钘夌暦瑜版帒鎹舵い鎾跺剱濡粍绻濋悽闈浶ｇ痪鏉跨Ч閹€斥枎閹惧磭楠囬梺鍓插亝缁诲倿鍩涢弮鍫熺厽闁挎繂鐗呴崥顐︽煟閵夘喕閭鐐叉椤﹀绱掓径瀣仢闁哄备鈧磭鏆嗛悗锝庡墰閻﹀牓鎮楃憴鍕闁绘牕銈稿畷娲焺閸愨晛顎撶紓浣割儐椤戞瑥螞鎼淬劍鈷掗柛灞剧懅椤︼箓鏌涘顒夊剰妞ゎ厼鐏濊灒濞撴凹鍨抽崝鐑芥⒑鐠恒劌鏋斿┑顔芥尦閹锋垿鎮㈤崫銉ь啎闂佺懓顕崕鎰版倿閹间焦鐓涢柛鎰╁妿婢ф洜绱掗埀顒勫礃椤忓懎鏋戦棅顐㈡处缁嬫帡鍩涢幒鎾变簻闁哄秲鍔岄悞褰掓煛閳ь剚绂掔€ｎ偆鍘介梺褰掑亰閸撴瑧鐥閺屽秶绱掑Ο鑽ゎ槬闂傚洤顦扮换婵囩節閸屾凹浼€缂備胶濮烽崑鐔煎焵椤掑喚娼愭繛鍙夛耿瀹曠銇愰幒鎴犲姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢柣妯诲墯濞堟粓鏌熼鍡欑瘈鐎殿喗鎸抽幃銏㈢礄閻樼數娉块梻鍌欑缂嶅﹪宕戞繝鍥х獥闁哄稁鍘奸崙鐘绘煙鏉堥箖妾柣鎾存礋閺屻劌鈹戦崱妤婁患閻庤鎸稿Λ婵嬪蓟閳ュ磭鏆嗛悗锝庡墰閿涚喖姊洪柅鐐茶嫰婢у墽绱撳鍛棦鐎规洘鍨垮畷鍗炍熺紒妯煎娇闂備焦鐪归崹褰掑箟閿熺姵鍋傛繛鍡樺姂娴滄粓鏌￠崘銊モ偓濠氬箺閸屾稓绠鹃柛顐ゅ枔閻帡鏌″畝瀣埌闁宠棄顦靛畷锟犳倷鐎电缍嗛梺璇叉唉椤煤閺嶎偆绀婂┑鐘叉储閳ь兛绀侀埢搴ㄥ箻閺夋垳绨甸梺鐟板悑閹矂宕板Δ鍐闁瑰墽绮埛鎺楁煕鐏炴崘澹橀柍褜鍓涢崗姗€骞婂Δ鍛唶闁哄洦菤閸嬫挻鎷呴崷顓犵槇闂佺鏈〃鍡涙倵濞差亝鈷戦柛婵嗗閸屻劑鏌涢妸銉﹁础缂侇喖鐗婂鍕偓锝庡墰椤旀洟姊虹化鏇炲⒉閽冮亶鎮樿箛鏇熸毄闁逞屽墲椤骞愰悜鑺ュ€块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
    const imageInputs = await Promise.all((params.imageList || []).filter((item) => item.url).map((item) => resolveVisionInputForLLM(item.url, projectUuid)));
    const videoInputs = await Promise.all((params.videoList || []).filter((item) => item.url).map((item) => resolveVisionInputForLLM(item.url, projectUuid)));
    const textContext = (params.textList || [])
      .filter((item) => item.content)
      .map((item, index) => `[闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧湱鈧懓瀚崳纾嬨亹閹烘垹鍊炲銈嗗笒椤︿即寮查鍫熷仭婵犲﹤鍟扮粻濠氭煕閳规儳浜炬俊鐐€栫敮濠囨嚄閸洖鐓濋柟鍓х帛閻撴盯鏌涘☉鍗炵仩闁宠鐗撻弻鏇㈠幢閺囩媭妲梺瀹狀嚙闁帮綁鐛鈧畷姗€骞撻幒鎾存婵犵绱曢崑鎴﹀磹閺嶎厼绠板Δ锝呭暙绾惧鏌ｉ弬鍨倯闁稿锕㈤弻鏇熷緞閸繂濮夐梺琛″亾濞寸姴顑呯粻鎶芥煙閹増顥夌痪鎯х秺閺岀喖鎮ч崼鐔哄嚒缂佺偓鍎抽…鐑藉蓟閻旂厧绀堢憸蹇曟暜濞戙垺鐓曢悗锝庝簻閳ь剙娼″濠氬即閵忕娀鍞跺┑鐘绘涧濞村倸螞閵堝洨纾藉ù锝呭级椤庡棝鏌涚€ｎ偅灏柍瑙勫灴閹晠宕归锝嗙槑濠电姵顔栭崰妤呭箰閸愯尙鏆﹂柟閭﹀枤绾惧吋淇婇婊呭笡闁绘繄鍏樺娲传閸曨剙鍋嶉梺鎼炲妽濡炰粙骞冮垾鏂ユ闁靛繆鈧枼鍋撻悽鍛婄叆婵犻潧妫楅埀顒傛嚀閳诲秹宕堕埡鍐紲闂佸綊鍋婇崢浠嬎夐崼銉︾厸鐎光偓鐎ｎ剛锛熸繛瀵稿缁犳捇骞冨▎鎿冩晢闁稿被鍊栨晥闂備浇顕у锕傦綖婢跺⊕鍝勵煥閸繂鍋嶉悷婊勬瀹曟椽鎮欓崫鍕吅闂佹寧娲嶉崑鎾剁磼閻樺磭鈯曢柕鍥у楠炴﹢骞囨担璇♀偓鍡欑磽娴ｅ搫校闁搞劌娼″畷娲倷閸濆嫮顓洪梺鎸庢磵閸嬫捇鏌ｉ幙鍕瘈闁哄本鐩崺鍕礃閿旀寧鍕冪紓鍌欓檷閸斿矂濡剁粙娆炬綎婵炲樊浜滅粻浼村箹濞ｎ剙鐏柨娑欙耿濮婃椽骞栭悙鎻掝潊濠碘槅鍋勭€氫即銆佸鑸垫櫜闁搞儯鍔岄悵鏉库攽閻愬瓨缍戞い鎴濇閿濈偛顓兼径瀣ф嫼闂傚倸鐗婄粙鎾剁不閸愭祴鏀芥い鏃囧亹婢э箑鈹戦埄鍐╁€愰柛鈺嬬節瀹曟帒顭ㄩ崘銊﹁緢婵犵數濮烽弫鍛婄箾閳ь剚绻涙担鍐插悩濞戞ǚ鏋庨柟鐐▕濡兘鏌ｉ悢鍝ユ噧閻庢哎鍔嶇粋宥咁煥閸曗晙绨婚梺鐟版惈濡绂嶉幆褜娓婚柕鍫濈箳閻ｅ灚绻涙担鍐叉祫缂?{index + 1}]闂?{item.content}`)
      .join('\n');
    const upstreamTextContext = (params.textList || [])
      .filter((item) => item.content)
      .map((item, index) => `[Upstream text ${index + 1}]\n${item.content}`)
      .join('\n\n');
    const directTextContext = String(params.textContext || '').trim();
    const reliableUpstreamTextContext = directTextContext || upstreamTextContext;
    const downstreamInstruction = String(params.prompt || '').trim();
    const textInstruction = reliableUpstreamTextContext
      ? `Downstream instruction:\n${downstreamInstruction || 'Polish and improve the upstream text while preserving its meaning.'}\n\nUse the upstream text above as source material. Apply the downstream instruction to it. Do not simply copy the upstream text unless the instruction explicitly asks for that. Return only the final result.`
      : downstreamInstruction || 'Please generate content from the reference material above.';
    const promptForUsage = usagePromptPreview(reliableUpstreamTextContext, downstreamInstruction);
    const textModel = String(params.model || config.defaultChatModel);
    const thinkingMode = String(params.thinkingMode || 'fast').toLowerCase() === 'deep' ? 'deep' : 'fast';
    taskJobId = randomId();
    usageLogId = await safeCreateUsageLog(req, row, {
      projectUuid,
      nodeKey,
      operationType: 'text',
      endpoint: '/generate/llm',
      provider: 'llm-proxy',
      model: textModel,
      mode: 'text',
      quantity: 1,
      promptChars: promptForUsage.length,
      promptPreview: promptForUsage,
      inputCounts: usageInputCounts(params),
      settings: {
        performanceMode: params.performanceMode || 'highest',
        reasoningEffort: params.reasoningEffort || 'high',
        thinkingMode,
        imageRefs: imageInputs.filter(Boolean).length,
        videoRefs: videoInputs.filter(Boolean).length,
        textRefs: (params.textList || []).filter((item) => item.content).length,
      },
    });
    const taskRecord = await jobService.createPersistentTask({
      ...generationTaskBaseFromCanvas(req, row, { projectUuid, nodeKey }),
      jobId: taskJobId,
      taskType: 'text',
      endpoint: '/generate/llm',
      provider: 'llm-proxy',
      model: textModel,
      mode: 'text',
      quantity: 1,
      referenceMaterials: summarizeVideoReferences(params),
      requestParams: compactGenerationRequestParams(params, {
        textModel,
        thinkingMode,
        performanceMode: params.performanceMode || 'highest',
        reasoningEffort: params.reasoningEffort || 'high',
        textContextChars: reliableUpstreamTextContext.length,
      }),
      usageLogId,
    });
    const referenceContent = [];
    if (reliableUpstreamTextContext) referenceContent.push({ type: 'text', text: `Upstream text material:\n${reliableUpstreamTextContext}\n` });
    referenceContent.push(...imageInputs.flatMap((item) => (item ? [{ type: 'image_url', image_url: { url: item.url, format: item.format } }] : [])));
    referenceContent.push(...videoInputs.flatMap((item) => (item ? [{ type: 'image_url', image_url: { url: item.url, format: item.format } }] : [])));
    const content = [...referenceContent, { type: 'text', text: textInstruction }];
    const messages = [
      { role: 'system', content: 'You are a text workflow assistant. When upstream text is provided, treat it as source material and transform it according to the downstream instruction.' },
      { role: 'user', content }
    ];

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ task: { taskId: taskJobId, generationVersion: taskRecord.generationVersion } })}\n\n`);
    const abortController = new AbortController();
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': ping\n\n');
    }, 15_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      abortController.abort();
    });
    try {
      const streamOptions = {
        performanceMode: params.performanceMode || 'highest',
        reasoningEffort: params.reasoningEffort || 'high'
      };
      if (thinkingMode === 'deep') {
        await streamDeepTextGeneration({
          referenceContent,
          instruction: textInstruction,
          model: textModel,
          signal: abortController.signal,
          options: streamOptions,
          onStage: (stage) => {
            if (!res.destroyed) res.write(`data: ${JSON.stringify({ stage })}\n\n`);
          },
          onDelta: (delta) => {
            outputChars += String(delta || '').length;
            if (!res.destroyed) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          },
        });
      } else {
        for await (const delta of chatStream(messages, textModel, abortController.signal, streamOptions)) {
          outputChars += String(delta || '').length;
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
      }
      await safeUpdateUsageLog(usageLogId, {
        status: 'succeeded',
        resultCount: 1,
        settings: {
          performanceMode: params.performanceMode || 'highest',
          reasoningEffort: params.reasoningEffort || 'high',
          thinkingMode,
          outputChars,
        },
      });
      jobService.setTask(taskJobId, {
        status: 2,
        progressPercent: 100,
        providerStatus: { phase: 'completed', outputChars, thinkingMode },
      });
    } catch (error) {
      await safeUpdateUsageLog(usageLogId, {
        status: error.name === 'AbortError' ? 'cancelled' : 'failed',
        errorMessage: error.message || String(error),
      });
      if (taskJobId) {
        await jobService.setTaskAndWait(taskJobId, {
          status: error.name === 'AbortError' ? 'cancelled' : 3,
          progressPercent: 0,
          error: error.message || String(error),
          providerStatus: { phase: error.name === 'AbortError' ? 'cancelled' : 'failed' },
        });
      }
      if (error.name !== 'AbortError' && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ error: llmErrorMessageFrom(error, textModel) })}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
    }
    if (!res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (error) {
    await safeUpdateUsageLog(usageLogId, { status: 'failed', errorMessage: error.message || String(error) });
    if (taskJobId) {
      await jobService.setTaskAndWait(taskJobId, {
        status: 3,
        progressPercent: 0,
        error: error.message || String(error),
      });
    }
    if (!res.headersSent) res.status(500).json({ error: error.message || String(error) });
  }
});

apiRouter.get('/projects/:projectUuid/tasks/active', async (req, res, next) => {
  try {
    const row = await getSessionReadableCanvasForUser(req, res, req.params.projectUuid);
    if (!row) return res.status(404).json({ error: 'canvas not found' });
    const tasks = await jobService.listActiveTasksForProject(
      req.params.projectUuid,
      req.user.id,
      req.user.role === 'admin'
    );
    res.json({ tasks });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/projects/:projectUuid/tasks/recoverable', async (req, res, next) => {
  try {
    const row = await getSessionReadableCanvasForUser(req, res, req.params.projectUuid);
    if (!row) return res.status(404).json({ error: 'canvas not found' });
    const tasks = await jobService.listRecoverableTasksForProject(
      req.params.projectUuid,
      req.user.id,
      req.user.role === 'admin'
    );
    res.json({ tasks });
  } catch (error) {
    next(error);
  }
});

/**
 * 补收任务结果时怎么并进节点已有的产物里。
 *
 * 语义跟前端正常成功路径的 mergeResultUrls 对齐：**旧的在前、新的追加、按地址去重**。
 * 唯一有意的差别是**不做 30 条上限的截断**：前端那个上限是给正常生成做的 UI/内存保护，
 * 而这条路径的全部意义就是"别丢结果"，在这里静默淘汰最老的一条正好是反着来的。
 * 真超了 30 条，前端下次正常生成时自然会收上限。
 */
function mergeRecoveredUrls(existing, recovered) {
  const clean = (list) =>
    (Array.isArray(list) ? list : [])
      .map((url) => (typeof url === 'string' ? url.trim() : ''))
      .filter(Boolean);
  const seen = new Set();
  return [...clean(existing), ...clean(recovered)].filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

apiRouter.post('/projects/:projectUuid/tasks/:jobId/recover', async (req, res, next) => {
  try {
    const projectUuid = String(req.params.projectUuid || '');
    const jobId = String(req.params.jobId || '');
    await queueCanvasMutation(projectUuid, async () => {
      const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
      if (!row) return res.status(404).json({ error: 'canvas not found' });
      const task = await jobService.getTask(jobId);
      const ownership = await jobService.getTaskOwnership(jobId);
      if (!task || !ownership || String(ownership.projectUuid || '') !== projectUuid) {
        return res.status(404).json({ error: 'task not found' });
      }
      if (task.status !== 2 || task.meta?.shouldApply === false || !Array.isArray(task.urls) || !task.urls.length) {
        return res.status(409).json({ error: 'task result is not recoverable' });
      }

      const data = readCanvasData(row);
      const nodeList = nodeListFromData(data, projectUuid);
      const node = nodeList.find((item) => String(item.nodeKey) === String(ownership.nodeKey || ''));
      if (!node) return res.status(404).json({ error: 'target node not found' });
      let nodeData;
      try {
        nodeData = typeof node.data === 'string' ? JSON.parse(node.data) : { ...(node.data || {}) };
      } catch {
        nodeData = {};
      }
      const nodeVersion = Number(nodeData._generationVersion || nodeData.taskInfo?.generationVersion || 0);
      const taskVersion = Number(task.meta?.generationVersion || 0);
      if (nodeVersion && taskVersion && taskVersion < nodeVersion) {
        return res.status(409).json({ error: 'a newer generation already exists' });
      }
      const completedAtMs = Date.parse(String(task.meta?.updatedAt || '')) || Date.now();
      const urls = task.urls.map(String).filter(Boolean);
      const assetCreatedAt = { ...(nodeData._assetCreatedAtMs || {}) };
      const assetGenerationMeta = { ...(nodeData._assetGenerationMeta || {}) };
      for (const [index, url] of urls.entries()) {
        assetCreatedAt[url] = completedAtMs;
        assetGenerationMeta[url] = {
          model: task.meta?.model,
          resolution: task.meta?.resolution,
          createdAtMs: completedAtMs,
          taskId: jobId,
          generationVersion: taskVersion,
          outputIndex: index,
        };
      }
      // **追加，绝不替换。** 这里曾经是 `nodeData.url = urls`，
      // 于是补收一个任务的结果就把节点上已有的全部产物冲掉了 ——
      // 2026-08-25 canvas 262 的 P2-2 被打成 17 条 → 1 条，就是这一行。
      // 客户端那条补收路径（tasksStore.restoreProjectTasks）有护栏：节点已经有内容就整个跳过；
      // 而它自己会来调这个接口（applyStatus 已是 applied、或它本地保存失败时），
      // 服务端这边却没有同样的护栏。语义对齐到客户端正常成功路径的 mergeResultUrls。
      nodeData.url = mergeRecoveredUrls(nodeData.url, urls);
      nodeData.taskInfo = {
        ...(nodeData.taskInfo || {}),
        taskId: jobId,
        generationVersion: taskVersion,
        applyStatus: 'applied',
        loading: false,
        status: 2,
        progressPercent: 100,
        completedAtMs,
        model: task.meta?.model,
        taskKind: task.meta?.taskType || 'image',
        error: undefined,
      };
      // 已有主图/主视频就不抢主位 —— 跟客户端同一条规矩（tasksStore 那里的注释：
      // 否则"你正在看的主视频会被另一条刚跑完的顶掉"）。只有主位空着、或它指向的东西
      // 已经不在列表里（脏数据）时才落到补收进来的第一条上。
      const keepPrimary =
        typeof nodeData._primaryAssetUrl === 'string' &&
        nodeData.url.includes(nodeData._primaryAssetUrl);
      nodeData._primaryAssetUrl = keepPrimary ? nodeData._primaryAssetUrl : urls[0];
      nodeData._assetCreatedAtMs = assetCreatedAt;
      nodeData._assetGenerationMeta = assetGenerationMeta;
      nodeData._generationVersion = Math.max(nodeVersion, taskVersion);
      nodeData._updatedAtMs = completedAtMs;
      node.data = JSON.stringify(nodeData);
      data.nodeList = nodeList;
      await saveCanvasData(projectUuid, data, {
        reason: 'recover_generation_result',
        ownerId: row.owner_id,
        createdBy: req.user.id,
        cooldownMs: 0,
      });
      await jobService.markTaskApplied(jobId, task.meta?.outputs || []);
      const contentVersion = crypto.createHash('sha1').update(JSON.stringify(nodeList)).digest('hex');
      const changedAtMs = Date.now();
      publishCanvasChange({
        canvasId: projectUuid,
        source: 'generation_recovery',
        reason: 'recover_generation_result',
        revision: contentVersion,
        contentVersion,
        changedAtMs,
        updatedBy: req.user.id,
        changedNodeKeys: [String(node.nodeKey)],
      });
      res.json({ ok: true, contentVersion, nodeKey: node.nodeKey, urls });
    });
  } catch (error) {
    next(error);
  }
});

// Task-access authorization, scoped to both the task creator AND the task's
// canvas. The creator or an admin always passes; any other user must have
// access to the task's canvas (read access for inspection, write access for
// mutations). On any failure this resolves false so the route returns a
// uniform 404 that never reveals whether the task exists.
async function authorizeTaskAccess(req, jobId, { write = false } = {}) {
  const ownership = await jobService.getTaskOwnership(jobId);
  if (!ownership) return false;
  const canvasId = ownership.projectUuid || (ownership.canvasId != null ? String(ownership.canvasId) : null);
  if (!canvasId) return false;
  const row = write
    ? await getSessionWritableCanvasForUser(req, null, canvasId)
    : await getSessionReadableCanvasForUser(req, null, canvasId);
  if (!row) return false;
  if (req.user.role === 'admin') return true;
  if (ownership.userId != null && Number(ownership.userId) === Number(req.user.id)) return true;
  return true;
}

apiRouter.get('/tasks/:jobId', asyncRoute(async (req, res) => {
  const allowed = await authorizeTaskAccess(req, req.params.jobId);
  if (!allowed) return res.status(404).json({ error: 'task not found' });
  const task = await jobService.getTask(req.params.jobId);
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
}));

apiRouter.post('/tasks/:jobId/apply', asyncRoute(async (req, res) => {
  const allowed = await authorizeTaskAccess(req, req.params.jobId, { write: true });
  if (!allowed) return res.status(404).json({ error: 'task not found' });
  const state = await jobService.markTaskApplied(req.params.jobId, req.body?.outputs);
  if (!state) return res.status(404).json({ error: 'task not found' });
  res.json(state);
}));

apiRouter.post('/tasks/:jobId/orphan', asyncRoute(async (req, res) => {
  const allowed = await authorizeTaskAccess(req, req.params.jobId, { write: true });
  if (!allowed) return res.status(404).json({ error: 'task not found' });
  res.json({ ok: await jobService.markTaskOrphaned(req.params.jobId) });
}));

apiRouter.post('/tasks/:jobId/cancel', asyncRoute(async (req, res) => {
  const allowed = await authorizeTaskAccess(req, req.params.jobId, { write: true });
  if (!allowed) return res.status(404).json({ error: 'task not found' });
  const abortController = generationAbortControllers.get(req.params.jobId);
  if (abortController && !abortController.signal.aborted) abortController.abort();
  clearGenerationPoller(req.params.jobId);
  res.json({
    ok: await jobService.cancelPersistentTask(req.params.jobId),
    aborted: Boolean(abortController),
  });
}));

function favoriteLibraryCategorySql(alias) {
  return `CASE
    WHEN ${alias}.item_type IN ('image', 'video', 'group') THEN ${alias}.item_type
    WHEN JSON_UNQUOTE(JSON_EXTRACT(${alias}.payload, '$.nodes[0].data.type')) = 'text' THEN 'text'
    WHEN JSON_UNQUOTE(JSON_EXTRACT(${alias}.payload, '$.nodes[0].type')) = 'text' THEN 'text'
    WHEN JSON_UNQUOTE(JSON_EXTRACT(${alias}.payload, '$.nodes[0].data.type')) IN ('image', 'director_stage') THEN 'image'
    WHEN JSON_UNQUOTE(JSON_EXTRACT(${alias}.payload, '$.nodes[0].type')) IN ('image', 'director_stage') THEN 'image'
    WHEN JSON_UNQUOTE(JSON_EXTRACT(${alias}.payload, '$.nodes[0].data.type')) IN ('video', 'video_merge') THEN 'video'
    WHEN JSON_UNQUOTE(JSON_EXTRACT(${alias}.payload, '$.nodes[0].type')) IN ('video', 'video_merge') THEN 'video'
    ELSE 'other'
  END`;
}

function favoriteLibraryPage(query) {
  const page = Math.max(1, Number.parseInt(String(query.page || '1'), 10) || 1);
  return { page, pageSize: FAVORITE_LIBRARY_PAGE_SIZE, offset: (page - 1) * FAVORITE_LIBRARY_PAGE_SIZE };
}

function favoriteLibraryTypeFilter(type, alias, where, params) {
  if (!type || type === 'all') return;
  where.push(`${favoriteLibraryCategorySql(alias)} = ?`);
  params.push(type);
}

apiRouter.get('/favorites', async (req, res, next) => {
  try {
    const type = String(req.query.type || 'all');
    const q = String(req.query.q || '').trim();
    const { page, pageSize, offset } = favoriteLibraryPage(req.query);
    const sortDirection = req.query.sortOrder === 'shared_asc' ? 'ASC' : 'DESC';
    const where = [];
    const params = [];

    where.push('f.owner_id = ?');
    params.push(req.user.id);

    favoriteLibraryTypeFilter(type, 'f', where, params);

    if (q) {
      where.push('(f.title LIKE ? OR f.description LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const [countRows] = await getPool().query(
      `SELECT COUNT(*) AS total
       FROM canvas_favorites f
       WHERE ${where.join(' AND ')}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);
    const [rows] = await getPool().query(
      `SELECT
         f.id,
         f.owner_id,
         f.source_project_uuid,
         f.source_root_key,
         f.item_type,
         f.title,
         f.description,
         f.preview_url,
         f.node_count,
         0 AS shared,
         f.tags,
         ${favoriteLibraryCategorySql('f')} AS library_category,
         f.created_at,
         f.updated_at,
         u.username AS owner_name
       FROM canvas_favorites f
       INNER JOIN users u ON u.id = f.owner_id
       WHERE ${where.join(' AND ')}
       ORDER BY f.updated_at ${sortDirection}, f.id ${sortDirection}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({
      items: rows.map((row) => favoriteFromRow(row, req.user, { includePayload: false })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/favorites/status', async (req, res, next) => {
  try {
    const sourceProjectUuid = normalizeFavoriteSourceProject(req.query.projectUuid);
    const sourceRootKey = normalizeFavoriteSourceRoot(req.query.rootIds || req.query.rootKey);
    if (!sourceProjectUuid || !sourceRootKey) {
      res.json({ items: [] });
      return;
    }

    const [rows] = await getPool().query(
      `SELECT f.*, u.username AS owner_name
       FROM canvas_favorites f
       INNER JOIN users u ON u.id = f.owner_id
       WHERE f.owner_id = ?
         AND f.source_project_uuid = ?
         AND f.source_root_key = ?
       ORDER BY f.updated_at DESC, f.id DESC
       LIMIT 5`,
      [req.user.id, sourceProjectUuid, sourceRootKey]
    );
    res.json({ items: rows.map((row) => favoriteFromRow(row, req.user)) });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/favorites/:id', async (req, res, next) => {
  try {
    const [rows] = await getPool().query(
      `SELECT f.*, u.username AS owner_name
       FROM canvas_favorites f
       INNER JOIN users u ON u.id = f.owner_id
       WHERE f.id = ?
       LIMIT 1`,
      [req.params.id]
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: 'favorite not found' });
      return;
    }
    if (Number(row.owner_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      res.status(403).json({ error: 'no permission' });
      return;
    }
    res.json({ item: favoriteFromRow(row, req.user) });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/favorites', async (req, res) => {
  try {
    const itemType = FAVORITE_ITEM_TYPES.has(String(req.body?.itemType)) ? String(req.body.itemType) : 'node';
    const payload = normalizeFavoritePayload(req.body?.payload);
    const sourceProjectUuid = normalizeFavoriteSourceProject(req.body?.sourceProjectUuid || payload.sourceProjectUuid);
    const sourceRootKey = normalizeFavoriteSourceRoot(req.body?.sourceRootKey || payload.rootIds);
    const title = String(req.body?.title || '').trim().slice(0, 180) || 'Favorite node';
    const description = String(req.body?.description || '').trim().slice(0, 500);
    const previewUrl = String(req.body?.previewUrl || '').trim();
    const nodeCount = Math.max(1, Math.min(1000, Number(req.body?.nodeCount) || payload.nodes.length || 1));
    const tags = normalizeFavoriteTags(req.body?.tags);

    if (sourceProjectUuid && sourceRootKey) {
      const [existingRows] = await getPool().query(
        `SELECT id, shared
         FROM canvas_favorites
         WHERE owner_id = ?
           AND source_project_uuid = ?
           AND source_root_key = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [req.user.id, sourceProjectUuid, sourceRootKey]
      );
      const existing = existingRows[0];
      if (existing) {
        await getPool().query(
          `UPDATE canvas_favorites
           SET item_type = ?,
               title = ?,
               description = ?,
               preview_url = ?,
               node_count = ?,
               shared = ?,
               tags = ?,
               payload = ?
           WHERE id = ?`,
          [
            itemType,
            title,
            description || null,
            previewUrl || null,
            nodeCount,
            0,
            JSON.stringify(tags),
            JSON.stringify(payload),
            existing.id,
          ]
        );
        const [rows] = await getPool().query(
          `SELECT f.*, u.username AS owner_name
           FROM canvas_favorites f
           INNER JOIN users u ON u.id = f.owner_id
           WHERE f.id = ?
           LIMIT 1`,
          [existing.id]
        );
        res.json({ item: favoriteFromRow(rows[0], req.user), existing: true });
        return;
      }
    }

    const [result] = await getPool().query(
      `INSERT INTO canvas_favorites
       (owner_id, source_project_uuid, source_root_key, item_type, title, description, preview_url, node_count, shared, tags, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        sourceProjectUuid,
        sourceRootKey,
        itemType,
        title,
        description || null,
        previewUrl || null,
        nodeCount,
        0,
        JSON.stringify(tags),
        JSON.stringify(payload),
      ]
    );

    const [rows] = await getPool().query(
      `SELECT f.*, u.username AS owner_name
       FROM canvas_favorites f
       INNER JOIN users u ON u.id = f.owner_id
       WHERE f.id = ?
       LIMIT 1`,
      [result.insertId]
    );
    res.status(201).json({ item: favoriteFromRow(rows[0], req.user) });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

apiRouter.patch('/favorites/:id', async (req, res) => {
  try {
    const [existingRows] = await getPool().query('SELECT owner_id FROM canvas_favorites WHERE id = ? LIMIT 1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: 'favorite not found' });
      return;
    }
    if (Number(existing.owner_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      res.status(403).json({ error: 'no permission' });
      return;
    }

    const updates = [];
    const params = [];
    if (req.body.title !== undefined) {
      updates.push('title = ?');
      params.push(String(req.body.title || '').trim().slice(0, 180) || 'Favorite node');
    }
    if (req.body.description !== undefined) {
      updates.push('description = ?');
      params.push(String(req.body.description || '').trim().slice(0, 500) || null);
    }
    if (req.body.shared !== undefined) {
      updates.push('shared = ?');
      params.push(req.body.shared ? 1 : 0);
    }
    if (req.body.tags !== undefined) {
      updates.push('tags = ?');
      params.push(JSON.stringify(normalizeFavoriteTags(req.body.tags)));
    }

    if (updates.length > 0) {
      params.push(req.params.id);
      await getPool().query(`UPDATE canvas_favorites SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const [rows] = await getPool().query(
      `SELECT f.*, u.username AS owner_name
       FROM canvas_favorites f
       INNER JOIN users u ON u.id = f.owner_id
       WHERE f.id = ?
       LIMIT 1`,
      [req.params.id]
    );
    res.json({ item: favoriteFromRow(rows[0], req.user) });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

apiRouter.delete('/favorites/:id', async (req, res) => {
  try {
    const [existingRows] = await getPool().query('SELECT owner_id FROM canvas_favorites WHERE id = ? LIMIT 1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: 'favorite not found' });
      return;
    }
    if (Number(existing.owner_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      res.status(403).json({ error: 'no permission' });
      return;
    }
    await getPool().query('DELETE FROM canvas_favorites WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

apiRouter.get('/shared-assets', async (req, res, next) => {
  try {
    const type = String(req.query.type || 'all');
    const q = String(req.query.q || '').trim();
    const { page, pageSize, offset } = favoriteLibraryPage(req.query);
    const sortDirection = req.query.sortOrder === 'shared_asc' ? 'ASC' : 'DESC';
    const where = ['1 = 1'];
    const params = [];

    favoriteLibraryTypeFilter(type, 's', where, params);

    if (q) {
      where.push('(s.title LIKE ? OR s.description LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const [countRows] = await getPool().query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.owner_id = ? THEN 1 ELSE 0 END) AS my_total
       FROM canvas_shared_assets s
       WHERE ${where.join(' AND ')}`,
      [req.user.id, ...params]
    );
    const total = Number(countRows[0]?.total || 0);
    const myTotal = Number(countRows[0]?.my_total || 0);
    const [rows] = await getPool().query(
      `SELECT
         s.id,
         s.owner_id,
         s.source_project_uuid,
         s.source_root_key,
         s.item_type,
         s.title,
         s.description,
         s.preview_url,
         s.node_count,
         1 AS shared,
         s.tags,
         ${favoriteLibraryCategorySql('s')} AS library_category,
         s.created_at,
         s.updated_at,
         u.username AS owner_name
       FROM canvas_shared_assets s
       INNER JOIN users u ON u.id = s.owner_id
       WHERE ${where.join(' AND ')}
       ORDER BY s.updated_at ${sortDirection}, s.id ${sortDirection}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    res.json({
      items: rows.map((row) => favoriteFromRow(row, req.user, { includePayload: false })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      myTotal,
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/shared-assets/status', async (req, res, next) => {
  try {
    const sourceProjectUuid = normalizeFavoriteSourceProject(req.query.projectUuid);
    const sourceRootKey = normalizeFavoriteSourceRoot(req.query.rootIds || req.query.rootKey);
    if (!sourceProjectUuid || !sourceRootKey) {
      res.json({ items: [] });
      return;
    }

    const [rows] = await getPool().query(
      `SELECT s.*, 1 AS shared, u.username AS owner_name
       FROM canvas_shared_assets s
       INNER JOIN users u ON u.id = s.owner_id
       WHERE s.owner_id = ?
         AND s.source_project_uuid = ?
         AND s.source_root_key = ?
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT 5`,
      [req.user.id, sourceProjectUuid, sourceRootKey]
    );
    res.json({ items: rows.map((row) => favoriteFromRow(row, req.user)) });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/shared-assets/:id', async (req, res, next) => {
  try {
    const [rows] = await getPool().query(
      `SELECT s.*, 1 AS shared, u.username AS owner_name
       FROM canvas_shared_assets s
       INNER JOIN users u ON u.id = s.owner_id
       WHERE s.id = ?
       LIMIT 1`,
      [req.params.id]
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: 'shared asset not found' });
      return;
    }
    res.json({ item: favoriteFromRow(row, req.user) });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/shared-assets', async (req, res) => {
  try {
    const itemType = FAVORITE_ITEM_TYPES.has(String(req.body?.itemType)) ? String(req.body.itemType) : 'node';
    const payload = normalizeFavoritePayload(req.body?.payload);
    const sourceProjectUuid = normalizeFavoriteSourceProject(req.body?.sourceProjectUuid || payload.sourceProjectUuid);
    const sourceRootKey = normalizeFavoriteSourceRoot(req.body?.sourceRootKey || payload.rootIds);
    const title = String(req.body?.title || '').trim().slice(0, 180) || 'Shared node';
    const description = String(req.body?.description || '').trim().slice(0, 500);
    const previewUrl = String(req.body?.previewUrl || '').trim();
    const nodeCount = Math.max(1, Math.min(1000, Number(req.body?.nodeCount) || payload.nodes.length || 1));
    const tags = normalizeFavoriteTags(req.body?.tags);

    if (sourceProjectUuid && sourceRootKey) {
      const [existingRows] = await getPool().query(
        `SELECT id
         FROM canvas_shared_assets
         WHERE owner_id = ?
           AND source_project_uuid = ?
           AND source_root_key = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [req.user.id, sourceProjectUuid, sourceRootKey]
      );
      const existing = existingRows[0];
      if (existing) {
        await getPool().query(
          `UPDATE canvas_shared_assets
           SET item_type = ?,
               title = ?,
               description = ?,
               preview_url = ?,
               node_count = ?,
               tags = ?,
               payload = ?
           WHERE id = ?`,
          [
            itemType,
            title,
            description || null,
            previewUrl || null,
            nodeCount,
            JSON.stringify(tags),
            JSON.stringify(payload),
            existing.id,
          ]
        );
        const [rows] = await getPool().query(
          `SELECT s.*, 1 AS shared, u.username AS owner_name
           FROM canvas_shared_assets s
           INNER JOIN users u ON u.id = s.owner_id
           WHERE s.id = ?
           LIMIT 1`,
          [existing.id]
        );
        res.json({ item: favoriteFromRow(rows[0], req.user), existing: true });
        return;
      }
    }

    const [result] = await getPool().query(
      `INSERT INTO canvas_shared_assets
       (owner_id, source_project_uuid, source_root_key, item_type, title, description, preview_url, node_count, tags, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        sourceProjectUuid,
        sourceRootKey,
        itemType,
        title,
        description || null,
        previewUrl || null,
        nodeCount,
        JSON.stringify(tags),
        JSON.stringify(payload),
      ]
    );

    const [rows] = await getPool().query(
      `SELECT s.*, 1 AS shared, u.username AS owner_name
       FROM canvas_shared_assets s
       INNER JOIN users u ON u.id = s.owner_id
       WHERE s.id = ?
       LIMIT 1`,
      [result.insertId]
    );
    res.status(201).json({ item: favoriteFromRow(rows[0], req.user) });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

apiRouter.patch('/shared-assets/:id', async (req, res) => {
  try {
    const [existingRows] = await getPool().query('SELECT owner_id FROM canvas_shared_assets WHERE id = ? LIMIT 1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: 'shared asset not found' });
      return;
    }
    if (Number(existing.owner_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      res.status(403).json({ error: 'no permission' });
      return;
    }

    const updates = [];
    const params = [];
    if (req.body.title !== undefined) {
      updates.push('title = ?');
      params.push(String(req.body.title || '').trim().slice(0, 180) || 'Shared node');
    }
    if (req.body.description !== undefined) {
      updates.push('description = ?');
      params.push(String(req.body.description || '').trim().slice(0, 500) || null);
    }
    if (req.body.tags !== undefined) {
      updates.push('tags = ?');
      params.push(JSON.stringify(normalizeFavoriteTags(req.body.tags)));
    }

    if (updates.length > 0) {
      params.push(req.params.id);
      await getPool().query(`UPDATE canvas_shared_assets SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const [rows] = await getPool().query(
      `SELECT s.*, 1 AS shared, u.username AS owner_name
       FROM canvas_shared_assets s
       INNER JOIN users u ON u.id = s.owner_id
       WHERE s.id = ?
       LIMIT 1`,
      [req.params.id]
    );
    res.json({ item: favoriteFromRow(rows[0], req.user) });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

apiRouter.delete('/shared-assets/:id', async (req, res) => {
  try {
    const [existingRows] = await getPool().query('SELECT owner_id FROM canvas_shared_assets WHERE id = ? LIMIT 1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ error: 'shared asset not found' });
      return;
    }
    if (Number(existing.owner_id) !== Number(req.user.id) && req.user.role !== 'admin') {
      res.status(403).json({ error: 'no permission' });
      return;
    }
    await getPool().query('DELETE FROM canvas_shared_assets WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

apiRouter.get('/logs', (req, res, next) => {
  try {
    const logs = listLogs({ date: req.query.date });
    const latest = logs.reduce((current, log) => {
      const timestamp = Math.max(Number(log.updatedAtMs || 0), Number(log.createdAtMs || 0));
      if (!current || timestamp > current.timestamp || (timestamp === current.timestamp && String(log.id) > current.id)) {
        return { timestamp, id: String(log.id) };
      }
      return current;
    }, null);
    res.json({
      logs,
      version: latest ? `${latest.timestamp}:${latest.id}` : 'empty',
      canAdd: canAddLog(req.user),
      canEdit: canAddLog(req.user),
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/logs', (req, res) => {
  try {
    if (!canAddLog(req.user)) {
      res.status(403).json({ error: '没有添加日志的权限' });
      return;
    }
    const log = addLog({ content: req.body?.content, user: req.user });
    res.status(201).json({ log });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

apiRouter.put('/logs/:id', (req, res) => {
  try {
    if (!canAddLog(req.user)) {
      res.status(403).json({ error: '\u6ca1\u6709\u4fee\u6539\u65e5\u5fd7\u7684\u6743\u9650' });
      return;
    }
    const log = updateLog({ id: req.params.id, content: req.body?.content, user: req.user });
    res.json({ log });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

function startToolJob(fn, id, projectUuid, options = {}) {
  jobService.setTask(id, { status: 1, progressPercent: 0 });
  fn()
    .then((jobId) => {
      if (options.usageLogId) void safeUpdateUsageLog(options.usageLogId, { providerJobIds: [jobId] });
      pollAndStore(jobId, id, projectUuid, undefined, {
        onSucceeded: (urls) => {
          if (options.usageLogId) {
            void safeUpdateUsageLog(options.usageLogId, {
              status: 'succeeded',
              resultCount: Array.isArray(urls) ? urls.length : 1,
            });
          }
        },
        onFailed: (message) => {
          if (options.usageLogId) {
            void safeUpdateUsageLog(options.usageLogId, { status: 'failed', errorMessage: message });
          }
        },
      });
    })
    .catch((error) => {
      if (options.usageLogId) {
        void safeUpdateUsageLog(options.usageLogId, { status: 'failed', errorMessage: error.message || String(error) });
      }
      jobService.setTask(id, { status: 3, progressPercent: 0, error: error.message || String(error) });
    });
}

async function safeCreateToolUsageLog(req, entry) {
  const projectUuid = String(req.body?.projectUuid || '');
  let row = null;
  try {
    row = projectUuid ? await getWritableCanvasForUser(req, projectUuid) : null;
  } catch (error) {
    console.warn('[usage] unable to resolve toolbox canvas context', error.message || error);
  }
  const promptPreview = usagePromptPreview(entry.prompt || req.body?.prompt || '');
  return safeCreateUsageLog(req, row, {
    projectUuid,
    nodeKey: req.body?.nodeKey,
    operationType: 'image',
    provider: entry.provider || 'mivo',
    endpoint: entry.endpoint,
    model: entry.model,
    mode: entry.mode,
    quantity: entry.quantity || 1,
    promptChars: promptPreview.length,
    promptPreview,
    inputCounts: { images: req.body?.imageUrl ? 1 : 0, videos: 0, texts: promptPreview ? 1 : 0 },
    settings: entry.settings || {},
  });
}

apiRouter.post('/toolbox/video-trim', async (req, res) => {
  let source = null;
  let tempOutputPath = '';
  try {
    const projectUuid = String(req.body.projectUuid || '');
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) {
      res.status(404).json({ error: '闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳缍婇弻鐔兼⒒鐎靛壊妲紒鐐劤缂嶅﹪寮婚敐澶婄闁挎繂鎲涢幘缁樼厱濠电姴鍊归崑銉╂煛鐏炶濮傜€殿喗鎸抽幃娆徝圭€ｎ亙澹曢悷婊呭鐢帞澹曢崸妤佺厵閻庣數顭堟牎闂佸摜濮甸崝娆撳蓟閿濆憘鏃堝焵椤掑嫭鍋嬮柛鈩冪懅缁犳棃鏌熼悜姗嗘畷闁绘挻娲熼弻鏇熺箾閸喖濮庨梺閫炲苯澧柟顔煎€垮畷娲倷閸濆嫮顓洪梺鎸庢磵閸嬫挾鐥幆褍鎮戦柟渚垮妼椤粓宕卞Δ鈧埛鎺戔攽閳藉棗浜滈柣顓炲€搁～蹇涙倻濡顫￠梺瑙勵問閸ｎ喖危椤旂⒈娓婚柕鍫濇閻忋儲绻涘顔煎籍闁绘侗鍠楀鍕節鎼淬垺銆冮柣搴″帨閸嬫捇鏌嶈閸撶喖骞冮崸妤€鐒垫い鎺戝閳锋垿鏌涘┑鍡楊仾鐎瑰憡绻堥弻娑氣偓锝庡亞濞叉挳鏌熼缂存垹鎹㈠┑瀣倞闁靛鍨虹€氬ジ姊绘担鍛婂暈闁告梹娲栭锝夊醇閺囩偟鐣鹃梺鍓插亖閸庢煡鎮″▎鎾寸厱闁归偊鍨伴惃铏圭磼閻樺樊鐓奸柡宀€鍠栭、姘跺幢濞嗘垹妲囧┑鐘殿暜缁辨洟宕楀鈧畷娲晸閻樿尙锛滃┑顔斤公缁茶姤绂嶆ィ鍐╃厽闁靛繒濮甸崯鐐烘煟閹惧崬鍔滅紒缁樼箞濡啫鈽夊▎妯伙紗婵＄偑鍊曠€涒晠銆冩繝鍥ц摕婵炴垶顭傞悢铏圭＜婵☆垰鎼弨顓㈡⒒娴ｅ憡鎯堥柣顓烆槺濡叉劙寮撮姀鐘靛姦濡炪倖甯掗敃锔剧矓閻㈠憡鐓曢悗锝庝簼椤ョ偤鏌￠崨顓犲煟闁诡喕绮欏畷銊︾節閸曨偄绠ュ┑锛勫亼閸婃牕顫忔繝姘仱闁哄倸绨遍弸鏃€绻濇繝鍌滃闁绘挾鍠愮换娑㈠箣濠靛棜鍩炲┑鐐叉噹缁夊爼鍩€椤掑喚娼愭繛鍙夌墱缁辩偞绻濋崶銉㈠亾娴ｇ硶鏋庨柟鐐綑娴滄鏌熼崗鍏煎剹闁哥姵顨堢槐鐐哄箻缂佹ǚ鎷婚梺绋挎湰閼归箖鍩€椤掑倸鍘撮柟铏殜瀹曞ジ寮村Ο宄颁壕濞达絽婀辩弧鈧梺绋挎湰椤ㄥ棝鎮楀ú顏呪拺闁告繂瀚崒銊╂煕閵娿儲璐＄紒顔肩墛瀵板嫮鈧綆鍓涢鏇㈡⒑缁洖澧查拑閬嶆倶韫囨洘鏆╅柍褜鍓濋～澶愬箰閻戣姤鍊块柨鏃傛櫕閳瑰秴鈹戦悩鍙夋悙閸ユ挳姊洪崨濠佺繁闁哥姵鐗曢埢宥夊Χ婢跺鎷虹紓浣割儐椤戞瑩宕曢幇鐗堢厱闁哄啠鍋撴い銊ョ墕鍗遍柟鐗堟緲缁犲鎮楀☉娅亪顢撻幘缁樼厽闁绘ê寮剁粊顐ょ磼鏉堛劍绀嬬€规洘绻堥幃婊堟嚍閵夈垺瀚? ' });
      return;
    }

    const startSec = Number(req.body.startSec);
    const endSec = Number(req.body.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      res.status(400).json({ error: 'invalid trim time range' });
      return;
    }

    source = await resolveVideoTrimSource(req.body.sourceUrl, projectUuid);
    const sourceMeta = await probeMediaMetadata(source.filePath, source.mimeType, source.originalName);
    const sourceDurationSec = Number(sourceMeta?.durationSec);
    const safeEnd = Number.isFinite(sourceDurationSec) && sourceDurationSec > 0
      ? Math.min(endSec, sourceDurationSec)
      : endSec;
    const safeStart = Math.max(0, Math.min(startSec, Math.max(0, safeEnd - 0.2)));
    const clipDurationSec = Number((safeEnd - safeStart).toFixed(3));

    if (!Number.isFinite(clipDurationSec) || clipDurationSec < 0.2) {
      res.status(400).json({ error: '闂傚倸鍊搁崐鎼佸磹閹间礁纾归柟闂寸绾惧綊鏌熼梻瀵割槮缁炬儳婀遍埀顒傛嚀鐎氼參宕崇壕瀣ㄤ汗闁圭儤鍨归崐鐐烘偡濠婂啰绠荤€殿喗濞婇弫鍐磼濞戞艾骞楅梻渚€娼х换鍫ュ春閸曨垱鍊块柛鎾楀懐锛滈梺褰掑亰閸欏骸鈻撳鈧弻宥堫檨闁告挻鐟х划璇差吋婢跺﹦锛熼梻渚囧墮缁夊绮婚鐐村€甸柨婵嗙凹缁ㄧ敻鏌嶈閸撴氨鏁Δ鍐╁床婵犻潧妫鈺傘亜閹捐泛孝妤犵偛绉瑰缁樻媴閾忕懓绗￠梺鎼炲妽閸庡ジ骞楅锔解拺闁规儼濮ら弫閬嶆偨椤栥倗绡€鐎殿喖顭烽弫鎰緞濡粯娅嶉梻浣虹帛閸旀牠骞嗙仦杞挎盯鎮欓悜妯锋嫽闂佹悶鍎滅仦閿瀰闂備礁鎼悮顐﹀礉瀹€鍕厴闁硅揪绠戦獮銏′繆椤栨粌鍔嬫い蹇ョ節濮婃椽鎳￠妶鍛咃綁鏌涢弬鐐叉噺瀹曞弶绻濋棃娑卞剰闁藉啰鍠栭弻銊モ攽閸℃ê娅濋梺琛″亾濞寸姴顑嗛悡鏇㈡煃閳轰礁鏆熼柟鍐插暣閺岋綁骞樼捄鐑樼亪濠殿喖锕ュ钘夌暦椤愶箑绀嬫い鏃傗拡娴煎啰绱撻崒娆戭槮妞わ箓浜跺畷妤€螣閼测晜校婵犵數鍋為幐濠氬春閸愵喖纾婚柟鍓х帛閻撴盯鎮橀悙鎻掆挃婵炴彃鐡ㄩ〃銉╂倷閹碱厾鍔烽梺鍦嚀鐎氫即骞冨鍏剧喖姊婚幘顔间粣闂傚倷娴囬褏鈧稈鏅犻、娆撳冀椤撶偟鐛ラ梺鍝勭▉閸樻悂鍩€椤掑﹦鐣甸柟顔界矒閹稿﹥寰勭€ｎ兘鍋撻鍕拺闁荤喐婢橀埛鏃傜磼椤曞懎鐏︾€规洘鍨块獮鍥偋閸垹骞樼紓浣哄亾濠㈡ê鐣烽浣规珷缂備焦眉缁诲棝妫呴顐㈠箹鐎规挸妫欓幈銊︾節閸曨厼绗＄紓浣诡殘閸犳牠宕洪埀顒併亜閹哄棗浜惧銈庡幖濞测晠藝閸洘鐓曢柨婵嗘噽缁夌儤鎱ㄦ繝鍐┿仢鐎规洏鍔嶇换婵嬪磼濮ｆ寧娲樼换娑氣偓娑欘焽閻绱掗鑺ュ磳闁诡喕鍗抽、娆撳床婢跺顥堢€规洏鍔戦、娆戞喆閸曨偒浼滈梻鍌氬€烽懗鍫曗€﹂崼銉ュ珘妞ゆ帒瀚崑锛勬喐閺冨洦顥ら梻浣瑰濞叉牠宕愯ぐ鎺撳亗婵炲棙鍨瑰Λ顖炴煛婢跺﹦浠㈤柤鍝ユ嚀闇夋繝濠傚閻帡鏌熼挊澶屽煟闁诡喗鐟ч埀顒勬涧閹芥粓鎯侀崼銉︹拻闁稿本姘ㄦ晶娑氱磼鐎ｎ偄绗掓い鏂跨箰閳规垿宕堕妷銈囩泿闂備礁鍟块幖顐﹀磹婵犳艾鐭楅柍褜鍓熷娲传閸曨剚鎷遍梺鐑╂櫓閸ㄥ爼濡存笟鈧鎾閳╁啯鐝抽梻浣虹《閸撴繈鎮烽姣硷綁顢楅崒婊咃紳闂佺鏈悷銊╁礂鐏炶В鏀芥い鏇楀亾闁衡偓闁秴绠為柕濞炬櫆閸嬨劑鏌涢…鎴濅簻閹兼潙锕ら埞鎴︽倷閺夋垹浠ч梺鎼炲妼濠€杈╁垝婵犳碍鏅查柛鈩冪懅椤旀洟姊虹化鏇炲⒉妞ゃ劌鐗忕划濠氬礃鐟佷礁缍婇幃鈺呭传閸曨亝鐫忕紓鍌欐祰妞存悂骞愭繝姘闁告稒娼欑粻鐢告煙閸濆嫮孝妞ゃ儲宀稿濠氬磼濞嗘埈妲梺纭咁嚋缁绘繂鐣峰┑瀣櫇闁稿本姘ㄩ悰銉モ攽鎺抽崐鏇㈠箠韫囨稑纾婚柛宀€鍋為悡鐔镐繆椤栨艾鎮戦柡鍡忔櫆娣囧﹪顢曢銏桓闂佸搫澶囬崜婵嗩嚗閸曨剛绡€闁告洦浜ｅ鎼佹⒒娴ｅ搫甯堕柟鑺ョ矒楠炲﹪骞橀悜鈹惧亾閿曞倹鍤勬い鏍电稻椤庡洭姊绘担瑙勫仩闁告柨鐭傞幃銉╂偂鎼搭喖娈ㄦ繝鐢靛У绾板秹寮查幓鎺濈唵閻犺桨璀﹂崕鎰箾閸涱厽顥㈡慨濠勫劋鐎电厧鈻庨幋婵嗙厒闂備焦妞块崜娆撳Χ閹间礁绠栭柍鈺佸暙缁剁偛鈹戦悙闈涗壕闁哄倵鍋撳┑锛勫亼閸婃牕顫忔繝姘ラ悗锝庝憾閸熷懘鏌曟径娑滅濞存粍绮嶉妵鍕箻鐠鸿桨绮跺┑鈩冨絻椤兘寮婚敐澶嬫櫜闁搞儜鍐ㄧ婵°倗濮烽崑鐐垫暜閿熺姷宓侀悗锝庡櫘閺佸洭鏌ｉ弬鍨Щ闁告鍋涢埞鎴︽晬閸曨偂鏉梺绋匡攻閻楃娀鐛幇鐗堝€锋い鎺嗗亾闁搞劍姊归妵鍕箻鐠鸿　鍋撻敐澶嬫櫜闁告哎鍊栧浠嬨€侀弮鍫濆窛妞ゅ繐鎳庨鐑樼節閻㈤潧浠╅柟娲讳簽瀵板﹪鎳栭埡鍌氼€忛梺鎸庢礀閸婂綊宕愰崸妤佺厽闁逛即娼ч崢闈浢瑰鍕煉闁哄瞼鍠撻埀顒佺⊕椤洨绮婚弽銊ｄ簻闁靛绲介悘顏呫亜閵婏絽鍔﹂柟顔界懇瀵爼骞嬮悩杈╃闂佽姘﹂～澶娒洪弽顓熷亯濠靛倹鎮堕埀顑跨铻栭柛娑卞幘閸旓箑顪冮妶鍡楃瑨闁稿﹦绮粙?0.2 缂? ' });
      return;
    }

    tempOutputPath = path.join(tmpDir(), `${randomId()}-trim.mp4`);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-loglevel', 'error',
        '-i', source.filePath,
        '-ss', safeStart.toFixed(3),
        '-t', clipDurationSec.toFixed(3),
        '-map', '0:v:0',
        '-map', '0:a?',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        tempOutputPath,
      ],
      { timeout: 10 * 60_000 }
    );

    if (!fs.existsSync(tempOutputPath)) {
      throw new Error('trim output was not created');
    }

    const stored = await storeDerivedVideoAsset(projectUuid, row, tempOutputPath, source.originalName, 'trim');
    tempOutputPath = '';
    res.json(stored);
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  } finally {
    if (source?.cleanupFiles?.length) {
      for (const filePath of source.cleanupFiles) {
        fs.rmSync(filePath, { force: true });
      }
    }
    if (tempOutputPath) {
      fs.rmSync(tempOutputPath, { force: true });
    }
  }
});

apiRouter.post('/toolbox/video-crop', async (req, res) => {
  let source = null;
  let tempOutputPath = '';
  try {
    const projectUuid = String(req.body.projectUuid || '');
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) {
      res.status(404).json({ error: 'canvas not found' });
      return;
    }

    source = await resolveVideoTrimSource(req.body.sourceUrl, projectUuid);
    const sourceMeta = await probeMediaMetadata(source.filePath, source.mimeType, source.originalName);
    const sourceWidth = Number(sourceMeta?.width);
    const sourceHeight = Number(sourceMeta?.height);

    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < MIN_CROP_SIZE_PX || sourceHeight < MIN_CROP_SIZE_PX) {
      res.status(400).json({ error: 'video size is unavailable' });
      return;
    }

    const crop = normalizeDerivedCropRect(req.body.crop, sourceWidth, sourceHeight);
    if (!crop || crop.width < MIN_CROP_SIZE_PX || crop.height < MIN_CROP_SIZE_PX) {
      res.status(400).json({ error: 'invalid crop rect' });
      return;
    }

    tempOutputPath = path.join(tmpDir(), `${randomId()}-crop.mp4`);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-loglevel', 'error',
        '-i', source.filePath,
        '-map', '0:v:0',
        '-map', '0:a?',
        '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        tempOutputPath,
      ],
      { timeout: 10 * 60_000 }
    );

    if (!fs.existsSync(tempOutputPath)) {
      throw new Error('crop output was not created');
    }

    const stored = await storeDerivedVideoAsset(projectUuid, row, tempOutputPath, source.originalName, 'crop');
    tempOutputPath = '';
    res.json(stored);
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  } finally {
    if (source?.cleanupFiles?.length) {
      for (const filePath of source.cleanupFiles) {
        fs.rmSync(filePath, { force: true });
      }
    }
    if (tempOutputPath) {
      fs.rmSync(tempOutputPath, { force: true });
    }
  }
});

apiRouter.post('/toolbox/super-resolution', async (req, res) => {
  try {
    const projectUuid = String(req.body?.projectUuid || '');
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return;
  } catch (error) {
    return res.status(Number(error?.statusCode) || 500).json({
      error: error?.message || 'Request failed',
      errorCode: error?.code || 'TOOL_REQUEST_FAILED',
    });
  }
  const id = randomId();
  const usageLogId = await safeCreateToolUsageLog(req, {
    endpoint: '/toolbox/super-resolution',
    provider: 'mivo',
    model: 'mivo-super-resolution',
    mode: 'super-resolution',
    settings: { tool: 'super-resolution' },
  });
  startToolJob(async () => {
    const image = await resolveToMivoRef(req.body.imageUrl, req.body.projectUuid);
    const client = await mivoHttp();
    const response = await client.post('/api/v1/super-resolution', { image });
    return response.data?.data?.jobId || response.data?.jobId || response.data?.object_id;
  }, id, req.body.projectUuid, { usageLogId });
  res.json({ jobId: id });
});

apiRouter.post('/toolbox/panorama', async (req, res) => {
  let usageLogId = null;
  let internalId = null;
  try {
    const { projectUuid, nodeKey, imageUrl } = panoramaService.validatePanoramaRequest(req.body || {});
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) {
      res.status(404).json({ error: '画布不存在或没有写入权限', errorCode: 'CANVAS_NOT_ACCESSIBLE' });
      return;
    }

    const params = panoramaGenerationParams.panoramaGenerationParams({
      sourceUrl: imageUrl,
      sourceName: req.body?.sourceName || '',
      model: req.body?.model,
      resolution: req.body?.resolution,
      generationMode: req.body?.generationMode,
      description: req.body?.description,
    });
    const normalizedModel = normalizeImageModel(params.model);
    const normalizedMode = 'image2image';
    const normalizedRatio = openAIImageProvider.normalizeImageRatio(normalizedModel, params.ratio);
    const normalizedResolution = openAIImageProvider.normalizeImageResolution(normalizedModel, params.resolution);
    const normalizedCount = openAIImageProvider.normalizeImageCount(normalizedModel, params.count);
    const imageProviderName = openAIImageProvider.getImageModelRule(normalizedModel).provider || 'openai-compatible';
    openAIImageProvider.validateImageCapabilities({
      model: normalizedModel,
      mode: normalizedMode,
      prompt: params.prompt,
      imageCount: 1,
      ratio: normalizedRatio,
      resolution: normalizedResolution,
      count: normalizedCount,
    });

    internalId = randomId();
    const referenceMaterials = summarizeVideoReferences({}, { imageList: [{ url: imageUrl }] });
    usageLogId = await safeCreateUsageLog(req, row, {
      projectUuid,
      nodeKey,
      operationType: 'image',
      endpoint: '/toolbox/panorama',
      provider: imageProviderName,
      model: normalizedModel,
      mode: params.generationMode,
      quantity: normalizedCount,
      promptChars: params.prompt.length,
      promptPreview: params.prompt,
      inputCounts: { images: 1, videos: 0, audios: 0, texts: 0 },
      settings: {
        tool: 'panorama',
        ratio: normalizedRatio,
        resolution: normalizedResolution,
        quality: params.quality,
        generationMode: params.generationMode,
        projection: 'equirectangular',
      },
    });
    const taskRecord = await jobService.createPersistentTask({
      ...generationTaskBaseFromCanvas(req, row, { projectUuid, nodeKey }),
      jobId: internalId,
      taskType: 'image',
      endpoint: '/toolbox/panorama',
      provider: imageProviderName,
      model: normalizedModel,
      mode: params.generationMode,
      ratio: normalizedRatio,
      resolution: normalizedResolution,
      quantity: normalizedCount,
      referenceMaterials,
      requestParams: {
        tool: 'panorama',
        mode: params.generationMode,
        projection: 'equirectangular',
        imageUrl,
        sourceName: req.body?.sourceName || '',
        description: params.description,
        generationMode: params.generationMode,
        providerCalls: params.providerCalls,
        prompt: params.prompt,
      },
      usageLogId,
    });
    res.json({ jobId: internalId, generationVersion: taskRecord.generationVersion });

    const abortController = new AbortController();
    generationAbortControllers.set(internalId, abortController);
    const generationPromise = (async () => {
      try {
        jobService.setTask(internalId, { status: 1, progressPercent: 1 });
        let generationImages = params.images;
        let repaint = null;
        let erpTemplate = null;
        const erpCleanupFiles = [];
        if (params.generationMode === panoramaGenerationParams.PANORAMA_MODE_ERP_TEMPLATE) {
          const sourceInput = await resolveToOpenAiImageInput(imageUrl, projectUuid);
          if (!sourceInput?.filePath || !fs.existsSync(sourceInput.filePath)) {
            throw new Error('ERP 模板原图无法读取，请重新导入后再试');
          }
          erpCleanupFiles.push(...(sourceInput.cleanupFiles || []));
          const providerSize = openAIImageProvider.imageSizeForModel(normalizedModel, normalizedRatio, normalizedResolution);
          const dimensions = panoramaErpTemplateService.templateDimensionsForResolution(normalizedResolution, providerSize);
          erpTemplate = await panoramaErpTemplateService.buildErpEditTemplate({
            sourcePath: sourceInput.filePath,
            width: dimensions.width,
            height: dimensions.height,
          });
          const [templateUrl, maskUrl] = await storeGeneratedImages(
            [erpTemplate.templateBuffer, erpTemplate.maskBuffer],
            projectUuid,
            row,
            'png',
          );
          if (normalizedModel === 'gpt-image-2') {
            generationImages = [templateUrl];
            repaint = {
              version: 1,
              contract: 'erp-template-mask-v1',
              sourceNodeId: nodeKey,
              sourceUrl: templateUrl,
              sourceName: 'erp-template.png',
              maskUrl,
              maskWidth: dimensions.width,
              maskHeight: dimensions.height,
              maskCoverage: erpTemplate.metadata.knownFraction,
              commandCount: 1,
              brushSize: 1,
              providerBehavior: 'independent-provider-mask',
              compositeOutput: false,
            };
          } else {
            generationImages = [templateUrl, maskUrl];
          }
        }
        let urls;
        try {
          urls = await generateOpenAiImages({
            prompt: params.prompt,
            model: normalizedModel,
            ratio: normalizedRatio,
            resolution: normalizedResolution,
            quality: params.quality,
            count: normalizedCount,
            images: generationImages,
            repaint,
            nativeOnly: normalizedModel === 'gemini-3-pro-image',
            strictResolution: normalizedModel === 'gemini-3-pro-image',
            panoramaErpTargetRatio: normalizedModel === 'gemini-3-pro-image' ? '2:1' : null,
            signal: abortController.signal,
            onProgress: (progressPercent) => {
              jobService.setTask(internalId, { status: 1, progressPercent });
            },
          }, projectUuid, row);
        } finally {
          for (const filePath of erpCleanupFiles) fs.rmSync(filePath, { force: true });
        }
        if (erpTemplate && urls.length) {
          const restoredUrls = [];
          for (const url of urls) {
            const storedName = path.basename(url);
            const localPath = await ensureAssetLocalPath(projectUuid, storedName);
            const restored = await panoramaErpTemplateService.restoreProtectedPixels({
              generatedPath: localPath,
              templateBuffer: erpTemplate.templateBuffer,
              maskBuffer: erpTemplate.maskBuffer,
            });
            const [restoredUrl] = await storeGeneratedImages([restored.buffer], projectUuid, row, 'png');
            restoredUrls.push(restoredUrl);
          }
          urls = restoredUrls;
        }
        if (abortController.signal.aborted) {
          const cancelledError = new Error('image generation cancelled');
          cancelledError.name = 'AbortError';
          throw cancelledError;
        }
        if (!urls.length) throw new Error('全景图生成结果为空');
        const outputs = [];
        let primaryMeasurement = null;
        let primarySeam = null;
        for (const [index, url] of urls.entries()) {
          const storedName = path.basename(url);
          const localPath = await ensureAssetLocalPath(projectUuid, storedName);
          const meta = await probeMediaMetadata(localPath, mimeTypeFromName(storedName), storedName);
          const seam = await panoramaErpTemplateService.inspectErpSeam(localPath);
          const measurement = panoramaService.assertEquirectangularDimensions({ width: meta.width, height: meta.height });
          if (!primaryMeasurement) {
            primaryMeasurement = measurement;
            primarySeam = seam;
          }
          outputs.push(panoramaService.buildPanoramaOutputMetadata({
            url,
            mimeType: meta.mimeType,
            width: measurement.width,
            height: measurement.height,
            model: normalizedModel,
            isPrimary: index === 0,
            extra: {
              kind: 'panorama-360x180',
              generationMode: params.generationMode,
              description: params.description,
              providerCalls: params.providerCalls,
              seamScore: seam.score,
              seamThreshold: seam.threshold,
              seamNeedsRepair: seam.needsRepair,
              repairRequiresConfirmation: seam.needsRepair,
              targetRatio: measurement.targetRatio,
              tolerance: measurement.tolerance,
              assetPath: `/assets/${projectUuid}/${storedName}`,
            },
          }));
        }
        jobService.setTask(internalId, {
          status: 2,
          progressPercent: 100,
          urls,
          outputs,
          providerStatus: {
            phase: 'completed',
            aspectRatio: primaryMeasurement?.ratio,
            projection: 'equirectangular',
            generationMode: params.generationMode,
            providerCalls: params.providerCalls,
            imageEndpoint: normalizedModel === 'gemini-3-pro-image' ? 'gemini-generateContent-native' : 'openai-compatible',
            resolutionMode: normalizedModel === 'gemini-3-pro-image' ? 'provider-native-strict' : 'provider-native-or-fallback',
            seamScore: primarySeam?.score,
            seamNeedsRepair: Boolean(primarySeam?.needsRepair),
            repairRequiresConfirmation: Boolean(primarySeam?.needsRepair),
          },
        });
        await safeUpdateUsageLog(usageLogId, { status: 'succeeded', resultCount: urls.length });
      } catch (error) {
        const rawMessage = errorMessageFrom(error);
        const message = normalizedModel === 'gemini-3-pro-image'
          && /INVALID_ARGUMENT|Request contains an invalid argument|Vertex_aiException/i.test(rawMessage)
          ? 'Nano Banana Pro 4K 全景请求被 Gateway/Vertex 拒绝：模型接口不接受当前全景参数，请稍后重试或改用 GPT Image 2。'
          : rawMessage;
        if (isGenerationCancelled(error, abortController.signal)) {
          await jobService.cancelPersistentTask(internalId);
          await safeUpdateUsageLog(usageLogId, { status: 'cancelled', errorMessage: message });
        } else {
          jobService.setTask(internalId, { status: 3, progressPercent: 0, error: message });
          await safeUpdateUsageLog(usageLogId, { status: 'failed', errorMessage: message });
        }
      } finally {
        if (generationAbortControllers.get(internalId) === abortController) {
          generationAbortControllers.delete(internalId);
        }
      }
    })();
    trackGenerationPromise(activeNonResumableGenerations, internalId, generationPromise);
  } catch (error) {
    if (usageLogId) await safeUpdateUsageLog(usageLogId, { status: 'failed', errorMessage: errorMessageFrom(error) });
    res.status(Number(error?.statusCode) || 500).json({
      error: error?.message || errorMessageFrom(error),
      errorCode: error?.code || 'PANORAMA_REQUEST_FAILED',
      ...(error?.details !== undefined ? { details: error.details } : {}),
    });
  }
});

apiRouter.post('/toolbox/multi-angle', async (req, res) => {
  try {
    const projectUuid = String(req.body?.projectUuid || '');
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return;
  } catch (error) {
    return res.status(Number(error?.statusCode) || 500).json({
      error: error?.message || 'Request failed',
      errorCode: error?.code || 'TOOL_REQUEST_FAILED',
    });
  }
  const id = randomId();
  const usageLogId = await safeCreateToolUsageLog(req, {
    endpoint: '/toolbox/multi-angle',
    provider: 'openai-compatible',
    model: 'gemini-3-pro-image',
    mode: 'multi-angle',
    quantity: 4,
    settings: { tool: 'multi-angle', count: 4 },
  });
  startToolJob(async () => {
    const image = await resolveToMivoRef(req.body.imageUrl, req.body.projectUuid);
    return submitGenImage({
      prompt: '濠电姷鏁告慨鐑藉极閸涘﹥鍙忛柣鎴ｆ閺嬩線鏌涘☉姗堟敾闁告瑥绻橀弻锝夊箣閿濆棭妫勯梺鍝勵儎缁舵岸寮婚悢鍏尖拻閻庨潧澹婂Σ顔剧磼閹冣挃缂侇噮鍨抽幑銏犫槈閵忕姷顓哄┑鐐叉缁绘帡宕濋幘顔解拺閺夌偞澹嗛ˇ锔姐亜閹存繃顥㈠┑锛勬暬瀹曠喖顢涘槌栧晪闂佽崵濮惧▍锝夊磿閵堝鍊靛Δ锝呭暞閳锋垿鏌涘☉姗堝姛闁瑰啿鍟扮槐鎺旂磼濮楀牐鈧寧顨ラ悙鎻掓殭閾绘牠鏌涘☉鍗炲箹闁诲寒鍘奸—鍐Χ閸℃顫囬梺绋匡攻閻楃娀鐛径濞炬瀻闁归偊鍠氶惁鍫濃攽閻愯尙澧曢柣蹇旂箞瀵悂鎮㈢亸浣规杸闂佺粯鍔橀婊堢叕椤掑倵鍋撳▓鍨灈妞ゎ參鏀辨穱濠囧醇閺囩偠袝闂侀潧鐗嗛幊蹇曟嫻閿熺姵鐓冪憸婊堝礈閵娧呯闁糕剝绋戠壕濠氭煕濞戞鎽犻柛瀣枛閺屸€愁吋鎼粹€茬敖缂佺偓宕樺Λ鍕箒闂佹寧绻傞幊蹇涘箚閸儱鍐€闁跨喓濮甸埛鎴︽煕濠靛棗顏い顐畵閺屾盯寮埀顒勫垂閸ф鍨傚Δ锝呭暞閺呮繈鏌涚仦鎯у摵闁轰焦绮岄埞鎴炲箠闁稿﹥鎸剧划鍫熸媴缁洘鐏佸┑鐘绘涧椤戝棝鍩涢幒妤佺厱閻忕偟鍋撻惃鎴濐熆瑜庣粙鎾舵閹烘柡鍋撻敐搴′簻闁诲繑鎸抽弻銊モ攽閸繀绮堕梺浼欑稻缁诲牆鐣烽悢纰辨晢闁稿本鑹剧粻娲⒒閸屾瑨鍏岀紒顕呭灦瀵濡搁埡浣侯啈濠电姴锕ら悧鍡欑不閻樼粯鐓涢柛銉㈡櫅娴滃綊鏌￠埀顒佺鐎ｎ偆鍘撻梺闈涱槶閸斿秹鎮甸鍫熺厱闁绘顒查懓鍧楁煛鐏炲墽娲撮柛鈺冨仱楠炲棜顦卞瑙勬礀閳规垿鏁嶉崟顐℃澀闂佺锕ラ悧鏇㈩敊韫囨梻绡€婵﹩鍓涢敍娑㈡⒑閻熸澘鈷旂紒顕呭灦閹繝寮撮悢鍓佺畾濡炪倖鐗楃换鍌炲触瑜版帗鐓熸い鎾跺枎缁椦囨煃瑜滈崜婵嬶綖婢跺⊕鍝勵潨閳ь剙鐣疯ぐ鎺戦敜婵°倕鍟粊锕€鈹戦埥鍡楃仴闁稿鍔楁竟鏇㈠礂闂傚绠氬銈嗙墬缁瞼鏁懜娈挎闁绘劘灏欐晶锔芥叏婵犲嫮甯涢柟宄版嚇瀹曨偊濡烽‖顔哄姂濮婅櫣绮欏▎鎯у壈闂佹寧娲︽禍婊堟偩闁垮顕遍柡澶嬪灥閸炪劑姊洪棃娴ゆ稓浠︽ィ鍐╂殔濠电姴鐥夐弶搴撳亾瑜忓濠冪鐎ｎ亞鏌堝銈嗙墱閸嬬偤宕戦崒鐐寸厸闁搞儯鍎遍悘顏堟煕婵犲嫭鏆柡灞诲妼閳规垿宕卞Δ浣诡唲濠电姷顣介埀顒傚仺閸嬨垽鏌＄仦鍓ф创鐎殿噮鍣ｉ獮姗€宕滄担瑙勵啌闂傚倷绀侀幖顐ｅ緞閸ヮ剙鐒垫い鎺嗗亾缁剧虎鍙冨鎶藉幢濞戞瑧鍘撻悷婊勭矒瀹曟粓鎮㈡搴㈡婵炴潙鍚嬪娆撳礃閳ь剙顪冮妶鍡樺暗闁稿鍠栭幃鍧楀炊瑜夐弨浠嬫煟濡偐甯涙繛鎳峰嫨浜滈柟瀛樼箖椤ャ垻鈧娲橀崹褰掑焵椤掑﹦绉甸柛鐘愁殜閹繝寮撮悢缈犵盎闂佽婢樻晶搴ㄥ箖閼测晝纾奸柣妯虹－婢у灚鎱ㄦ繝鍌涙儓闁宠閰ｉ獮鍡氼槻缂佺姾宕电槐鎾存媴娴犲鎽甸梺鍦嚀濞层倝鎮鹃悜钘夌闁瑰瓨姊归悗濠氭⒑閸︻厼鍔嬮柛銊ф暩閺侇噣顢涘锝嗘杸闂佺粯蓱閸撴岸宕箛娑欑厱闁绘ê鍟块崫铏光偓娈垮櫘閸嬪懐鎹㈠┑鍡╂僵闁告鍋熼妶锕傛⒒娴ｄ警鏀伴柟娲讳簽缁骞嬮敂钘夆偓宄扳攽閻樻彃顏柛鐘冲姍閻擃偊宕堕妸褉妲堝┑顔款潐閻擄繝寮婚妸鈺佸嵆闁绘劖绁撮崑鎾广亹閹烘挸浜楀┑鐐叉閹稿鎮″▎鎰╀簻闁哄秲鍔庨惌濠冦亜閿濆懎鎮戦柕鍥у婵＄兘濡烽鍙劎绱撴担浠嬪摵閻㈩垽绻濋獮鍐煛閸涱厼鐎銈嗗姂閸ㄦ椽鎮鹃鍕拻闁稿本纰嶉幖鎰亜閿旂偓鏆€殿喖顭锋俊鎼佸Ψ閵忊剝鏉搁梻浣虹《閸撴繈鏁嬪┑鐐叉噷閸婃繂顫忓ú顏勪紶闁靛鍎查悘渚€姊虹粙娆惧剳闁稿鍊栨穱濠囨偨缁嬭法顦板銈嗙墬椤曢亶濡搁埡鍌滃弳闂佸搫鍊搁悘婵嬪煕閺冨牊鐓熼柕鍫濇噹椤忊晠鏌嶇憴鍕伌妞ゃ垺鐟у☉鐢告倻閻ｅ苯寮藉┑鐘垫暩閸嬫盯骞忛幋鐘电濞撴埃鍋撻柣娑卞枟瀵板嫰骞囬鍌ゅ晪婵＄偑鍊栧Λ渚€宕戦幇鍏洦瀵肩€涙ǚ鎷婚梺绋挎湰濮樸劍鏅跺☉姘辩＜閻庯綆鍋勭粭鎺楁煃鐠囪尙孝闁宠棄顦垫慨鈧柍閿亾闁归绮换娑欐綇閸撗冨煂闂佺顕滅换婵嬬嵁婢跺瞼鐭欓幖瀛樻尰閺傗偓婵＄偑鍊栧濠氬磻閹捐姹叉い鎺戝閻撳繘鏌涢埄鍐炬當闁哄棛鍋熺槐鎺旂磼濡偐鐤勯悗瑙勬礃鐢剝淇婇崼鏇炲窛妞ゆ洖鎳庨幃顏堟⒒閸屾艾鈧绮堟笟鈧獮鏍敃閵堝棗浠忓銈嗗姧缁犳垹澹曢崸妤€绾ч柛顐ｇ濞呭洤鈽夐幘宕囆ч柡宀嬬秮閹垻绮欓幐搴ｅ浇闁荤喐绮庢晶妤冩暜濡ゅ懎鐤鹃柡灞诲劜閻撴洘绻涢幋婵嗚埞闁哄濡囬惀顏堫敇濞戞ü澹曢梻鍌氬€搁崐椋庣矆娓氣偓楠炲鏁撻悩顐熷亾閿曞倸鐐婃い鎺嗗亾闁哄绀侀埞鎴︽偐鐎圭姴顥濋梺钘夊暟閸犳牠寮婚妸銉㈡斀闁糕剝锕╁Λ锟犳⒑缁嬫寧鎹ｉ柛鐘崇墵瀵寮撮敍鍕澑婵犵數濮撮崯顐⑩枍濮橆厾绡€婵炲牆鐏濋弸娑欑箾瀹割喖骞栨い顐㈢箰鐓ゆい蹇撳椤斿洭鏌熼崗鑲╂殬闁稿﹥娲熻棢婵犻潧顑嗛埛鎴︽倵閸︻厼顎屾繛鍏煎姍閺屾盯濡搁妷锕€浠撮梺闈涙缁€渚€鍩㈡惔銊ョ婵犮垹瀚ч弲鐘诲蓟閺囩喎绶炴繛鎴炴皑閺嗙姴鈹戦悙鍙夊暁闁告侗鍨抽敍婊堟⒑缂佹ê濮﹂柛鎾寸懇瀹曟繈濡舵径瀣帾闂佸壊鍋侀崺鍕倿閻愵兙浜滈柡鍥朵簽缁夘喚鈧娲栭妶绋款嚕閹绢喗鍊烽柛婵嗗閺嗩亜鈹戦悩鍨毄闁稿鍋ゅ畷褰掑醇閺囩喐娅斿┑锛勫亼閸娿倝宕滃▎鎿冩晞闁搞儮鏅滈～鏇㈡煙閹呮憼濠殿垱鎸抽弻娑樷攽閸℃褰呴梺鎸庣箓椤︿即鎮￠悢闀愮箚闁靛牆瀚崗宀勬煟椤撶偞婀板ǎ鍥э躬瀹曪絾寰勬繝鍌ゆ綒婵°倗濮烽崑鐐垫暜閳ユ剚鍤曟い鎺戝閸婇攱銇勯幒鍡椾壕婵犳鍨崡鍐差潖缂佹ɑ濯撮柦妯猴紞閹剧粯鐓ユ慨姗嗗幑娴滄粓鏌ㄩ弮鍥棄闁崇粯娲滈埀顒冾潐濞叉ê顪冩禒瀣畺婵炲棙鎸婚崐缁樹繆椤栫偞鏁遍悗姘偢濮婅櫣鎷犻弻銉偓妤佺節閳ь剚娼忛妸銉ョ亖濡炪倖鎸鹃崕鎰版倿娴犲鐓欓柟娈垮枛椤ｅジ鏌ｉ幘瀛樼闁哄本娲樼换娑㈠垂椤旂厧袘濠电偛顕慨浼村垂娴犲钃熼柨婵嗩槹閺呮煡鏌涢妷鎴濆暙缁狅絾淇婇妶鍥ラ柛瀣☉铻炴繝闈涱儏閽冪喖鏌涢妷顔煎闁哄懏绮撻弻娑樷枎濡桨鑸梺鍛婃尰濮樸劑骞戦姀鐘斀闁割偅绻冮悗鍐测攽閳藉棗鐏犻柟纰卞亰閸╂稒寰勯幇顓涙嫼缂傚倷鐒﹁摫闁诡垰鐗忕槐鎺旂磼濡偐鐣靛銈嗘穿缂嶄焦淇婇幖浣规櫆闁伙絽鐬艰倴闂傚倷绀侀崯鍧楀箹椤愶箑纾归柛娑橈攻閸庣喎鈹戦悩鎻掆偓鐢稿绩娴犲鐓熼柟閭﹀幗缂嶆垿鏌ｈ箛鏇炴灈闁哄本鐩俊鎼佸Ψ閿曚胶顢呯紓鍌欑贰閸犳牠鈥﹂悜钘夋瀬闁归偊鍘肩欢鐐烘倵閿濆骸澧鐐搭殜濮婄粯鎷呴崫銉ㄩ梺绋款儏閿曨亜鐣烽姀銈嗗仼鐎光偓閳ь剛绮堟繝鍥ㄧ厵閻庣數顭堝暩濠碘槅鍋掗崹璺侯潖閸濆嫧鏋庨柟顖嗗懍鐢绘繝鐢靛仜閹冲酣骞婅箛娑樜﹂柛鏇ㄥ灱閺佸倿鏌涢弴銊ヤ簼婵炲牏绮换婵堝枈濡嘲浜剧€规洖娲ら悡鐔兼倵鐟欏嫭绀€鐎规洦鍓濋悘鎺楁⒑缂佹ɑ灏Δ鐘殿焾鏁堥柡灞诲劜閳锋帡鏌涚仦鍓ф噮闁告柨绉归幃妤冪箔濞戞ê骞樻繛宸簻閻撴盯鏌涚仦鍓ф噮缂佺姵宀稿娲箹閻愭彃濮堕梺璇茬箲閻╊垶寮幇顓炵窞濠电姴瀚弶鎼佹⒒娴ｈ櫣甯涙い銊ユ嚇閹囧幢濞戞鍔﹀銈嗗笒鐎氬嘲螞閹达附鐓熼柕澶樺枙闁垶鏌熼銊ユ搐閺勩儲銇勯幇闈涗簵缂併劏鍋愮槐鎺楀磼濮樻瘷锝夋煏閸剛绉€规洘锕㈤崺锟犲礃閵娿儲杈堟繝鐢靛Х閺佸憡绻涢埀顒佺箾娴ｅ啿鍚樺☉妯锋斀閻庯絽鐏氶弲娑樷攽鎺抽崐鎰板磻閹剧粯顥嗗璺侯儑缁♀偓婵犵數濮撮崐褰掑闯閻熸噴褰掓偐鐠佽櫕鍠氶梺鍝勭焿缁辨洘绂掗敃鍌涘仼閻忕偞绺块崐妤冩閹烘挻缍囬柕濞垮劤閻熴劑鏌ф导娆戠ɑ缂佺粯鐩幊鐘活敆閸屾氨顐兼俊鐐€戦崕閬嶆偋閹炬剚娼栫紓浣股戞刊鎾煕濞戞﹫鏀婚柛搴㈡崌濮婃椽宕楅崗绗轰户闂佹悶鍔岀壕顓㈠礆閹烘绫嶉柛顐ゅ枎閳ь剙顭峰娲箲閹邦剛鍔烽梺鍛婃煥缁夊墎鍒掗銏″亜闁绘挸娴烽崝锕€顪冮妶鍡楃瑨閻庢凹鍓熼幏鎴︽偄閸濄儳顔曢梺鐟扮摠閻熴儵鎮橀埡鍐＜闁绘ê妯婇悡濂告煙椤旇偐绉洪柟鐓庣秺閹兘寮堕崹顕呯€遍梻鍌欐祰椤曆呮崲閹扮増鍋嬮柛鈩冩皑娴?',
      images: [image],
      count: 4,
      model: 'gemini-3-pro-image'
    });
  }, id, req.body.projectUuid, { usageLogId });
  res.json({ jobId: id });
});

apiRouter.post('/toolbox/grid', async (req, res) => {
  try {
    const projectUuid = String(req.body?.projectUuid || '');
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return;
  } catch (error) {
    return res.status(Number(error?.statusCode) || 500).json({
      error: error?.message || 'Request failed',
      errorCode: error?.code || 'TOOL_REQUEST_FAILED',
    });
  }
  const id = randomId();
  const usageLogId = await safeCreateToolUsageLog(req, {
    endpoint: '/toolbox/grid',
    provider: 'openai-compatible',
    model: 'gemini-3-pro-image',
    mode: 'grid',
    settings: { tool: 'grid' },
  });
  startToolJob(async () => {
    const image = await resolveToMivoRef(req.body.imageUrl, req.body.projectUuid);
    return submitGenImage({
      prompt: 'Arrange the image into a grid',
      images: [image],
      model: 'gemini-3-pro-image'
    });
  }, id, req.body.projectUuid, { usageLogId });
  res.json({ jobId: id });
});

apiRouter.post('/toolbox/split-grid', async (req, res) => {
  try {
    const projectUuid = String(req.body?.projectUuid || '');
    const row = await getSessionWritableCanvasForUser(req, res, projectUuid);
    if (!row) return;
  } catch (error) {
    return res.status(Number(error?.statusCode) || 500).json({
      error: error?.message || 'Request failed',
      errorCode: error?.code || 'TOOL_REQUEST_FAILED',
    });
  }
  const cols = Number(req.body.cols || 3);
  const rows = Number(req.body.rows || 3);
  res.json({ nodeKeys: Array.from({ length: cols * rows }, randomId) });
});

module.exports = {
  apiRouter,
  assetRouter,
  // AI 出片的概念图要在服务端无人值守地生图，走的就是这条同步链路（跟细化纹理同一个函数）。
  // StudioService 惰性 require 本模块拿它 —— 这里是九千行的大模块，放到它文件顶部会绕出循环依赖。
  generateOpenAiImages,
  generationRuntimeState,
  pauseGenerationPollers,
  persistUploadedAsset,
  // AI 出片的动态分镜 / 成片要在服务端按镜生成视频。视频跟图片不一样：
  // 一条要几分钟，不能像 generateOpenAiImages 那样同步等在一个 HTTP 请求里，
  // 所以导出「提交」和「查结果」两个原子操作，由 StudioService 自己做提交 → 存 taskId → 轮询。
  submitSeedanceVideo,
  pollSeedanceResult,
  // 导出给测试：「没超上限就一帧都不动」这条规则值得单独锁住 ——
  // 它错一次，用户所有参考视频都会被白压一遍，而且不会有任何报错提示。
  shouldPrepareSeedanceReference,
  parseLocalAssetUrl,
  ffmpegReferenceVideoFilter,
  seedanceReferenceSpec,
  mp4UploadFileName,
  videoCompareMp4TranscodeOptions,
  isH264Mp4Probe,
  generatedVideoRvTranscodeOptions,
  isRvCompatibleGeneratedVideo,
  generatedVideoRvValidationError,
  generatedVideoRvStoragePlan,
  stableAssetExtension,
  taskOutputForStoredAsset,
  probeMediaMetadata,
  transcodeGeneratedVideoForRv,
  // provider 的视频直链**会过期**，拿到之后必须马上落地到画布资产区。
  // 这是画布那边一直在用的那条落地链路（下载 → 镜像到对象存储 → 登记资产记录）。
  downloadToAssets,
  // 导出给测试：补收任务结果必须**追加**而不是替换。这一行写成替换过一次，
  // 代价是节点上已有的全部产物（都是付过费的）被一次补收冲掉。
  mergeRecoveredUrls,
  // 导出给测试：上游限流要认出来、要退避够久、要说人话。
  // 不认出来的用户就会看到一整串 litellm 英文栈（2026-08-26 用户反馈的第二个报错）。
  errorMessageFrom,
  isRateLimitedProviderError,
  isRetryableImageProviderError,
  imageRetryDelayMs,
  rateLimitedProviderMessage,
  // 导出给测试：复制画布时必须把**指向别的画布**的资产也拉进副本。
  // 不拉的话副本会依赖一个使用者可能没权限的画布 —— 2026-08-26「共享画布复制到本地后
  // 别人丢图」就是这个：admin 看着一切正常，普通用户那 43 张全 404。
  collectForeignAssetRefs,
  rewriteForeignAssetRefs,
  resumePersistedGenerationTasks,
  waitForGenerationDrain,
};
