const express = require('express');
const config = require('../config');
const {
  allowedCindyModes,
  createMessage,
  generateAssistantReply,
  getMessageRow,
  getSkillDocs,
  imagePartsFromCanvasImages,
  getWritableCanvasForUser,
  isUserAllowed,
  listMessages,
  normalizeCanvasContext,
  resolveCindyMode,
  setProposalStatus,
} = require('../services/CindyAssistantService');
const { getUserApiKeyByExternalId } = require('../userCatalog');

const cindyAssistantRouter = express.Router();
const activeRequests = new Set();

function requireAllowedUser(req, res, next) {
  if (!isUserAllowed(req.user)) {
    res.status(403).json({ error: 'Cindy 画布助手未对当前账号开放' });
    return;
  }
  next();
}

async function requireWritableCanvas(req, res, next) {
  try {
    const canvasId = req.params.canvasId;
    const canvas = await getWritableCanvasForUser(req.user, canvasId);
    if (!canvas) {
      res.status(404).json({ error: '画布不存在或没有写入权限' });
      return;
    }
    req.cindyCanvas = canvas;
    next();
  } catch (error) {
    next(error);
  }
}

cindyAssistantRouter.get('/status', (req, res) => {
  const enabled = isUserAllowed(req.user);
  res.json({
    enabled,
    model: enabled ? config.cindyAssistant?.model || config.defaultChatModel : null,
    capabilities: enabled ? ['chat', 'propose_nodes', 'propose_connections'] : [],
    // 这个账号能用哪些 Skill 模式。人人有 'default'，film / master 按名单。
    // 前端照这个渲染模式选择器；只有一个模式时干脆不显示选择器。
    modes: allowedCindyModes(req.user),
    safety: enabled ? { requiresApply: true, generation: false, deletion: false } : null,
  });
});

// Read-only: any authenticated user may view the prompt-skill docs (guidelines,
// not secrets). Placed before requireAllowedUser so it is not gated to Cindy users.
cindyAssistantRouter.get('/skills', (req, res) => {
  res.json({ skills: getSkillDocs() });
});

cindyAssistantRouter.use(requireAllowedUser);

cindyAssistantRouter.get('/canvases/:canvasId/messages', requireWritableCanvas, async (req, res, next) => {
  try {
    const messages = await listMessages(req.cindyCanvas.id, req.user.id);
    res.json({ messages });
  } catch (error) {
    next(error);
  }
});

cindyAssistantRouter.post('/canvases/:canvasId/messages', requireWritableCanvas, async (req, res, next) => {
  const requestKey = `${req.user.id}:${req.cindyCanvas.id}`;
  if (activeRequests.has(requestKey)) {
    res.status(409).json({ error: 'Cindy 正在处理上一条消息，请稍候' });
    return;
  }

  const content = String(req.body?.content || '').trim().slice(0, 4000);
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  // 只带图不打字也允许发 —— 「看看这张图」是很自然的用法，文字为空时服务端会补一句默认提问
  if (!content && images.length === 0) {
    res.status(400).json({ error: '请输入消息或附一张图' });
    return;
  }

  activeRequests.add(requestKey);
  try {
    const canvasContext = normalizeCanvasContext({
      ...(req.body?.canvasContext || {}),
      canvasName: req.cindyCanvas.title,
    });
    const userMessage = await createMessage({
      canvasId: req.cindyCanvas.id,
      userId: req.user.id,
      role: 'user',
      content,
      images,
    });
    const history = await listMessages(req.cindyCanvas.id, req.user.id, 16);
    // 只给当前这一轮真的内联图片（读盘 → 缩到 1024 → base64）。
    // createMessage 已经把地址按「必须属于本画布」过滤过一遍，这里拿存下来的那份，
    // 不用请求体里的原始值。
    const lastTurn = history[history.length - 1];
    if (lastTurn && lastTurn.id === userMessage.id && userMessage.images?.length) {
      lastTurn.imageParts = await imagePartsFromCanvasImages(req.cindyCanvas.id, userMessage.images);
    }
    const userApiKey = await getUserApiKeyByExternalId(req.user && req.user.external_user_id).catch(() => null);
    // 生效的模式在服务端定 —— 请求体是用户可控的，没权限的人手搓 mode:'master' 也只会拿到默认模式
    const mode = resolveCindyMode(req.user, req.body?.mode);
    const result = await generateAssistantReply(history, canvasContext, mode, userApiKey);
    const assistantMessage = await createMessage({
      canvasId: req.cindyCanvas.id,
      userId: req.user.id,
      role: 'assistant',
      content: result.reply,
      proposal: result.proposal,
    });
    res.status(201).json({ userMessage, assistantMessage });
  } catch (error) {
    next(error);
  } finally {
    activeRequests.delete(requestKey);
  }
});

cindyAssistantRouter.post('/messages/:messageId/proposal-status', async (req, res, next) => {
  try {
    const messageRow = await getMessageRow(req.params.messageId, req.user.id);
    if (!messageRow) {
      res.status(404).json({ error: '提案不存在' });
      return;
    }
    const canvas = await getWritableCanvasForUser(req.user, messageRow.canvas_id);
    if (!canvas) {
      res.status(404).json({ error: '画布不存在或没有写入权限' });
      return;
    }
    const message = await setProposalStatus(
      req.params.messageId,
      req.user.id,
      String(req.body?.status || '')
    );
    if (!message) {
      res.status(404).json({ error: '提案不存在' });
      return;
    }
    res.json({ message });
  } catch (error) {
    next(error);
  }
});

cindyAssistantRouter.use((error, req, res, next) => {
  const statusCode = Number(error?.statusCode);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
    res.status(statusCode).json({
      error: error.message || 'Cindy 请求失败',
      errorCode: error.code || 'CINDY_ASSISTANT_REQUEST_FAILED',
    });
    return;
  }
  next(error);
});

module.exports = {
  cindyAssistantRouter,
  requireAllowedUser,
};
