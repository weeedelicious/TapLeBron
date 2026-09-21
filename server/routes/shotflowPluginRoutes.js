const express = require('express');
const fs = require('fs');
const config = require('../config');
const { requirePluginScope } = require('../auth');
const { apiRouter, persistUploadedAsset } = require('../canvasRoutes');
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
  getGenerationNodeForPlugin,
  listCanvasesForPlugin,
  updateNodeForPlugin,
} = require('../services/PluginCanvasService');
const {
  completeStart,
  createPlan,
  failStart,
  getJobForPlugin,
  hasScope,
  prepareStart,
} = require('../services/PluginGenerationService');
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

function forwardGenerationToCanvasApi(req, res, next, prepared) {
  return new Promise((resolve, reject) => {
    const originalUrl = req.url;
    const originalBody = req.body;
    const originalJson = res.json.bind(res);
    let settled = false;

    const finish = () => {
      req.url = originalUrl;
      req.body = originalBody;
      res.json = originalJson;
    };

    res.json = (payload) => {
      if (settled) return res;
      settled = true;
      const success = res.statusCode >= 200 && res.statusCode < 300 && payload && payload.jobId;
      const persistence = success
        ? completeStart({
            userId: req.user.id,
            canvasId: prepared.loaded.canvas.id,
            planId: prepared.plan.plan_id,
            idempotencyKey: prepared.idempotencyKey,
            jobId: payload.jobId,
            response: payload,
          })
        : failStart({
            userId: req.user.id,
            canvasId: prepared.loaded.canvas.id,
            idempotencyKey: prepared.idempotencyKey,
            errorCode: payload?.errorCode || 'GENERATION_START_FAILED',
          });
      void Promise.resolve(persistence).then(() => {
        finish();
        originalJson(payload);
        resolve();
      }, (error) => {
        finish();
        reject(error);
      });
      return res;
    };

    req.url = `/generate/${prepared.kind}`;
    req.body = {
      projectUuid: prepared.loaded.canvas.id,
      nodeKey: prepared.loaded.node.key,
      params: prepared.params,
    };
    apiRouter.handle(req, res, (error) => {
      if (settled) return;
      settled = true;
      void failStart({
        userId: req.user.id,
        canvasId: prepared.loaded.canvas.id,
        idempotencyKey: prepared.idempotencyKey,
        errorCode: error?.code || 'GENERATION_START_FAILED',
      }).finally(() => {
        finish();
        if (error) reject(error);
        else {
          const notFound = new Error('Generation dispatcher route not found');
          notFound.statusCode = 500;
          reject(notFound);
        }
      });
    });
  }).catch(next);
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
      generate: config.generation.pluginEnabled && (
        hasScope(req.pluginAuth.scopes, 'generate:image') || hasScope(req.pluginAuth.scopes, 'generate:video')
      ),
      generateImage: config.generation.pluginEnabled && config.generation.imageEnabled
        && hasScope(req.pluginAuth.scopes, 'generate:image'),
      generateVideo: config.generation.pluginEnabled && config.generation.videoEnabled
        && hasScope(req.pluginAuth.scopes, 'generate:video'),
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

shotflowPluginRouter.get(
  '/canvases/:id/nodes/:nodeKey',
  requirePluginScope('read'),
  asyncRoute(async (req, res) => {
    res.json(await getGenerationNodeForPlugin(req.user.id, req.params.id, req.params.nodeKey));
  })
);

shotflowPluginRouter.post(
  '/canvases/:id/nodes/:nodeKey/generation-plans',
  requirePluginScope('read'),
  asyncRoute(async (req, res) => {
    res.status(201).json(await createPlan({
      userId: req.user.id,
      tokenId: req.pluginAuth.id,
      scopes: req.pluginAuth.scopes,
      canvasId: req.params.id,
      nodeKey: req.params.nodeKey,
    }));
  })
);

shotflowPluginRouter.post(
  '/canvases/:id/nodes/:nodeKey/generations',
  requirePluginScope('read'),
  asyncRoute(async (req, res, next) => {
    const body = requestBody(req);
    const prepared = await prepareStart({
      userId: req.user.id,
      tokenId: req.pluginAuth.id,
      scopes: req.pluginAuth.scopes,
      canvasId: req.params.id,
      nodeKey: req.params.nodeKey,
      planId: body.planId,
      confirmBillable: body.confirmBillable,
      idempotencyKey: body.idempotencyKey,
      maxCost: body.maxCost,
    });
    if (prepared.replay) {
      res.json({ ...(prepared.response || {}), replayed: true });
      return;
    }
    await forwardGenerationToCanvasApi(req, res, next, prepared);
  })
);

shotflowPluginRouter.get(
  '/canvases/:id/jobs/:jobId',
  requirePluginScope('read'),
  asyncRoute(async (req, res) => {
    res.json(await getJobForPlugin({
      userId: req.user.id,
      canvasId: req.params.id,
      jobId: req.params.jobId,
    }));
  })
);

module.exports = { pluginTokenRouter, shotflowPluginRouter };
