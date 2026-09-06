const express = require('express');
const fs = require('fs');
const { requirePluginScope } = require('../auth');
const { persistUploadedAsset } = require('../canvasRoutes');
const {
  createPluginToken,
  listPluginTokens,
  revokePluginToken,
} = require('../services/PluginTokenService');
const {
  addNodesForPlugin,
  assertCanvasRevisionForPlugin,
  connectNodesForPlugin,
  createCanvasForPlugin,
  createUploadNodeForPlugin,
  getCanvasSummary,
  listCanvasesForPlugin,
  updateNodeForPlugin,
} = require('../services/PluginCanvasService');
const {
  cancelPluginUploadIntent,
  createPluginUploadIntent,
  finishPluginUploadIntent,
  preparePluginUploadIntent,
  resetPluginUploadIntent,
} = require('../services/PluginUploadService');

const pluginTokenRouter = express.Router();
const shotflowPluginRouter = express.Router();

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requestBody(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

pluginTokenRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json({ tokens: await listPluginTokens(req.user.id) });
  })
);

pluginTokenRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const body = requestBody(req);
    const expiresInDays = Math.max(1, Math.min(365, Number(body.expiresInDays) || 180));
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const created = await createPluginToken(req.user.id, {
      name: body.name,
      scopes: body.scopes,
      expiresAt,
    });
    res.status(201).json(created);
  })
);

pluginTokenRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const revoked = await revokePluginToken(req.user.id, req.params.id);
    if (!revoked) {
      res.status(404).json({ error: 'Plugin token not found', errorCode: 'PLUGIN_TOKEN_NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  })
);

shotflowPluginRouter.get('/status', requirePluginScope('read'), (req, res) => {
  res.json({
    ok: true,
    service: 'shotflow',
    apiVersion: 'v1',
    user: { id: String(req.user.id), username: req.user.username, role: req.user.role },
    token: req.pluginAuth,
    capabilities: {
      read: true,
      canvasWrite: req.pluginAuth.scopes.includes('canvas:write'),
      assetUpload: req.pluginAuth.scopes.includes('canvas:write'),
      generate: false,
      delete: false,
    },
  });
});

shotflowPluginRouter.get(
  '/canvases',
  requirePluginScope('read'),
  asyncRoute(async (req, res) => {
    const canvases = await listCanvasesForPlugin(req.user.id, {
      search: req.query.search,
      limit: req.query.limit,
    });
    res.json({ canvases, count: canvases.length });
  })
);

shotflowPluginRouter.get(
  '/canvases/:id',
  requirePluginScope('read'),
  asyncRoute(async (req, res) => {
    res.json(await getCanvasSummary(req.user.id, req.params.id));
  })
);

shotflowPluginRouter.post(
  '/canvases',
  requirePluginScope('canvas:write'),
  asyncRoute(async (req, res) => {
    const body = requestBody(req);
    const canvas = await createCanvasForPlugin(req.user.id, {
      name: body.name,
      assignedProjectId: body.assignedProjectId,
    });
    res.status(201).json(canvas);
  })
);

shotflowPluginRouter.post(
  '/canvases/:id/nodes',
  requirePluginScope('canvas:write'),
  asyncRoute(async (req, res) => {
    const body = requestBody(req);
    res.status(201).json(await addNodesForPlugin(req.user.id, req.params.id, {
      nodes: body.nodes,
      expectedRevision: body.expectedRevision,
    }));
  })
);

shotflowPluginRouter.post(
  '/canvases/:id/assets/upload-intents',
  requirePluginScope('canvas:write'),
  asyncRoute(async (req, res) => {
    const body = requestBody(req);
    await assertCanvasRevisionForPlugin(req.user.id, req.params.id, body.expectedRevision);
    const intent = await createPluginUploadIntent(req.user.id, req.params.id, {
      expectedRevision: body.expectedRevision,
      name: body.name,
      x: body.x,
      y: body.y,
      width: body.width,
      height: body.height,
    });
    res.status(201).json(intent);
  })
);

shotflowPluginRouter.post(
  '/canvases/:id/assets/upload-intents/:intentId/complete',
  requirePluginScope('canvas:write'),
  asyncRoute(async (req, res) => {
    const prepared = await preparePluginUploadIntent(req.user.id, req.params.id, req.params.intentId);
    try {
      const { intent, file } = prepared;
      const result = await createUploadNodeForPlugin(req.user.id, req.params.id, {
        expectedRevision: intent.expectedRevision,
        name: intent.name,
        x: intent.x,
        y: intent.y,
        width: intent.width,
        height: intent.height,
        persistAsset: (canvasRow) => persistUploadedAsset(canvasRow, file, {
          projectUuid: intent.canvasId,
          originalName: intent.name,
          sourceType: 'plugin_upload',
        }),
      });
      await finishPluginUploadIntent(intent);
      res.status(201).json(result);
    } catch (error) {
      resetPluginUploadIntent(prepared.intent);
      throw error;
    } finally {
      fs.rmSync(prepared.file.path, { force: true });
    }
  })
);

shotflowPluginRouter.post(
  '/canvases/:id/assets/upload-intents/:intentId/cancel',
  requirePluginScope('canvas:write'),
  asyncRoute(async (req, res) => {
    res.json(await cancelPluginUploadIntent(req.user.id, req.params.id, req.params.intentId));
  })
);

shotflowPluginRouter.post(
  '/canvases/:id/connections',
  requirePluginScope('canvas:write'),
  asyncRoute(async (req, res) => {
    const body = requestBody(req);
    res.json(await connectNodesForPlugin(req.user.id, req.params.id, {
      connections: body.connections,
      expectedRevision: body.expectedRevision,
    }));
  })
);

shotflowPluginRouter.patch(
  '/canvases/:id/nodes/:nodeKey',
  requirePluginScope('canvas:write'),
  asyncRoute(async (req, res) => {
    const body = requestBody(req);
    res.json(await updateNodeForPlugin(req.user.id, req.params.id, req.params.nodeKey, {
      patch: body.patch,
      expectedRevision: body.expectedRevision,
    }));
  })
);

module.exports = { pluginTokenRouter, shotflowPluginRouter };
