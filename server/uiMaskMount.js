const path = require('path');
const { pathToFileURL } = require('url');

function mountUiMask(app, requireAuth) {
  let handler = null;
  app.use('/api/ui-mask', requireAuth, (req, res, next) => {
    if (!handler) return res.status(503).json({ error: '遮罩服务尚未就绪' });
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) res.status(500).json({ error: error && error.message ? error.message : String(error) });
    });
  });
  const root = path.join(__dirname, '..', 'vendor', 'ui-mask-node-source');
  const moduleUrl = pathToFileURL(path.join(root, 'server', 'uiMaskApi.js')).href;
  return import(moduleUrl).then(({ uiMaskApi }) => {
    const plugin = uiMaskApi({
      root,
      jobsDirectory: path.join(root, 'outputs', 'ui-mask-jobs'),
    });
    plugin.configureServer({
      middlewares: { use(_prefix, fn) { handler = fn; } },
      httpServer: null,
    });
  }).catch((error) => {
    console.error('ui mask api failed to start', error);
  });
}

module.exports = { mountUiMask };
