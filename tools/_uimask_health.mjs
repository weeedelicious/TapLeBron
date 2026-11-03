import { maskDetectorConfig, maskPanelConfig } from '/data/wyx_root/tapflow-workbench/vendor/ui-mask-node-source/server/uiMaskDetector.js';
import { uiMaskApi } from '/data/wyx_root/tapflow-workbench/vendor/ui-mask-node-source/server/uiMaskApi.js';
const root = '/data/wyx_root/tapflow-workbench/vendor/ui-mask-node-source';
const model = maskDetectorConfig(root);
const panel = maskPanelConfig(root);
console.log(JSON.stringify({
  trained: model.available,
  trainedVersion: model.version,
  panel: panel.available,
  panelVersion: panel.version,
  api: typeof uiMaskApi,
}, null, 2));
