/**
 * AI 出片（Studio）接口。挂在 /api/studio，走 requireAuth（跟 Shotflow 共用登录，
 * 不做第二套账号）。所有接口先过 requireStudio —— 白名单之外的人一律 403，
 * 前端入口也只对白名单显示，两头都挡。
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const studioService = require('../services/StudioService');

const studioRouter = express.Router();

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireStudio(req, res, next) {
  if (!studioService.isStudioAllowed(req.user?.id)) {
    return res.status(403).json({ error: '没有 AI 出片权限', code: 'STUDIO_FORBIDDEN' });
  }
  return next();
}

function requestBody(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

// 前端拿它决定入口显不显示。这个不挡白名单 —— 不然没权限的人连"有没有这功能"都问不到，
// 只能靠 403 猜，日志里全是噪音。
studioRouter.get('/status', (req, res) => {
  res.json({ enabled: studioService.isStudioAllowed(req.user?.id) });
});

studioRouter.get('/projects', requireStudio, asyncRoute(async (req, res) => {
  res.json({ projects: await studioService.listProjects(req.user.id) });
}));

studioRouter.post('/projects', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.createProject(req.user.id, requestBody(req));
  res.status(201).json({ project });
}));

studioRouter.get('/projects/:id', requireStudio, asyncRoute(async (req, res) => {
  res.json({ project: await studioService.getProject(req.user.id, req.params.id) });
}));

studioRouter.patch('/projects/:id', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.updateProject(req.user.id, req.params.id, requestBody(req));
  res.json({ project });
}));

studioRouter.delete('/projects/:id', requireStudio, asyncRoute(async (req, res) => {
  await studioService.deleteProject(req.user.id, req.params.id);
  res.json({ ok: true });
}));

// 设定图上传的临时落点。跟画布那边的上传共用同一个 _tmp 目录和 200MB 上限（参考资料
// 也可能是视频）。multer 不会自己建目录，先确保它在。
const referenceUploadTmpDir = path.join(config.projectsDir, '_tmp');
fs.mkdirSync(referenceUploadTmpDir, { recursive: true });
const referenceUpload = multer({
  dest: referenceUploadTmpDir,
  limits: { fileSize: 200 * 1024 * 1024 },
});

// requireStudio 故意排在 multer 前面：没权限的人不该先把文件写进磁盘再被拒。
studioRouter.post(
  '/projects/:id/references/upload',
  requireStudio,
  referenceUpload.single('file'),
  async (req, res, next) => {
    if (!req.file) {
      res.status(400).json({ error: '没有收到文件', code: 'STUDIO_UPLOAD_NO_FILE' });
      return;
    }
    try {
      res.json(await studioService.uploadReference(req.user.id, req.params.id, req.file));
    } catch (error) {
      // 成功路径由 persistUploadedAsset 自己清临时文件；在它之前失败（比如项目不是你的）
      // 就得在这里清，否则 _tmp 会一直涨。
      if (req.file?.path) fs.rmSync(req.file.path, { force: true });
      next(error);
    }
  }
);

/**
 * 补建画布。给两种情况用：
 *   - 建项目时画布没建成（历史上那个 NaN bug 留下的坏数据）；
 *   - 画布被人删了。
 * 幂等：已经有画布就原样返回，不会多建一张。
 */
studioRouter.post('/projects/:id/canvas', requireStudio, asyncRoute(async (req, res) => {
  await studioService.ensureProjectCanvas(req.user.id, req.params.id);
  const project = await studioService.getProject(req.user.id, req.params.id);
  res.json({ project });
}));

studioRouter.post('/projects/:id/storyboard', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.generateStoryboard(req.user.id, req.params.id);
  res.json({ project });
}));

studioRouter.post('/projects/:id/storyboard/push', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.pushStoryboardToCanvas(req.user.id, req.params.id);
  res.json({ project });
}));

// ── 分镜绘制（第三阶段）──────────────────────────────────────────────────
// 跟概念图一样拆成 plan / save / generate / push 四个口：
// plan 和 save 零成本，generate 才花钱（每条一次生图），push 只搬已有结果。
studioRouter.post('/projects/:id/boards/plan', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.planBoards(req.user.id, req.params.id, requestBody(req));
  res.json({ project });
}));

studioRouter.patch('/projects/:id/boards', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.saveBoards(req.user.id, req.params.id, requestBody(req));
  res.json({ project });
}));

studioRouter.post('/projects/:id/boards/generate', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.generateBoards(req.user.id, req.params.id, requestBody(req));
  res.json({ project });
}));

studioRouter.post('/projects/:id/boards/push', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.pushBoardsToCanvas(req.user.id, req.params.id);
  res.json({ project });
}));

// ── 动态分镜（第四阶段）与成片（第五阶段）────────────────────────────────
// 同一套路由形状，:stage 取 motion / film。generate 只提交就返回，结果靠 poll 收 ——
// 一条视频几分钟，同步等在请求里必被网关掐断。
for (const verb of ['plan', 'generate', 'poll', 'push']) {
  studioRouter.post(`/projects/:id/:stage(motion|film)/${verb}`, requireStudio, asyncRoute(async (req, res) => {
    const { id, stage } = req.params;
    const body = requestBody(req);
    const project =
      verb === 'plan' ? await studioService.planVideoStage(req.user.id, id, stage, body)
      : verb === 'generate' ? await studioService.generateVideoStage(req.user.id, id, stage, body)
      : verb === 'poll' ? await studioService.pollVideoStage(req.user.id, id, stage)
      : await studioService.pushVideoStageToCanvas(req.user.id, id, stage);
    res.json({ project });
  }));
}

studioRouter.patch('/projects/:id/:stage(motion|film)', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.saveVideoStageEdits(
    req.user.id, req.params.id, req.params.stage, requestBody(req)
  );
  res.json({ project });
}));

// ── 概念图（第二阶段）────────────────────────────────────────────────────
// plan 只调模型列清单，零生图成本；generate 才花钱（每条一次生图），所以分成两个口，
// 前端也分成两个按钮 —— 不要为了少一次往返把它们合成一个。
studioRouter.post('/projects/:id/concepts/plan', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.planConcepts(req.user.id, req.params.id);
  res.json({ project });
}));

studioRouter.post('/projects/:id/concepts/generate', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.generateConcepts(req.user.id, req.params.id, requestBody(req));
  res.json({ project });
}));

studioRouter.post('/projects/:id/concepts/push', requireStudio, asyncRoute(async (req, res) => {
  const project = await studioService.pushConceptsToCanvas(req.user.id, req.params.id);
  res.json({ project });
}));

module.exports = { studioRouter };
