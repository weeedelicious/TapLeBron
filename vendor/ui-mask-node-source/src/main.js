import './video-controls-dark.css';
import './editor-ui.css';
import { InfiniteCanvas } from './infinite-canvas/InfiniteCanvas.js';
import { NodeEditor } from './node-editor/NodeEditor.js';
import { VideoInputSkill } from './skills/VideoInputSkill.js';
import { FpsConvertSkill } from './skills/FpsConvertSkill.js';
import { VideoExportSkill } from './skills/VideoExportSkill.js';

window.VideoInputSkill = VideoInputSkill;
window.FpsConvertSkill = FpsConvertSkill;
window.VideoExportSkill = VideoExportSkill;

const app = document.getElementById('app');
const infiniteCanvas = new InfiniteCanvas(app);
const nodeEditor = new NodeEditor(app, infiniteCanvas.viewport);
window.infiniteCanvas = infiniteCanvas;
window.editor = nodeEditor;

// 挂接左键拖空白 = 框选节点
nodeEditor.attachBoxSelect(infiniteCanvas);

infiniteCanvas.onViewportChange = () => {
  nodeEditor.syncViewport();
};

infiniteCanvas.onVideoDropped = async (file) => {
  // Nuke/ComfyUI 风格：每次拖入视频都新建独立素材节点，画布上可多个素材共存
  const spot = nodeEditor.spotForNewNode(null);
  const node = nodeEditor.createNode(VideoInputSkill, spot.x, spot.y);
  await node.setVideoFile(file, infiniteCanvas.currentVideo);
  nodeEditor.resetDownstream(node);
  nodeEditor.onNodeChange?.(node);
};

nodeEditor.onNodeChange = () => {
  // 画布底层保持干净（只留网格 + 节点卡片）。
  // 源视频在「视频素材」卡片内播放，转换效果在「帧率转换」节点内嵌小预览展示，
  // 不再平铺生成大预览视频遮挡创作视野。
  infiniteCanvas.renderer.setVideoStream(null);
};

// Restore after the graph, canvas and callbacks are ready. Rebuilt nodes use current code.
nodeEditor._restoreState();
if (import.meta.hot) {
  const saveBeforeUpdate = () => nodeEditor.persistence.saveAutomatically();
  import.meta.hot.on('vite:beforeUpdate', saveBeforeUpdate);
  import.meta.hot.on('vite:beforeFullReload', saveBeforeUpdate);
}

// ── 本地后端自诊断提示条 ─────────────────────────────────────
// 页面打开时探测 /api/health：可用 → 完整路径/直写磁盘正常；
// 不可用（旧进程/非 dev 模式）→ 明确提示，一眼可见。
const BACKEND_TIP_ID = 'backend-status-tip';
function renderBackendTip(ok, detail) {
  const old = document.getElementById(BACKEND_TIP_ID);
  if (old) old.remove();
  const tip = document.createElement('div');
  tip.id = BACKEND_TIP_ID;
  tip.style.cssText = `
    position: fixed;
    right: 14px;
    bottom: 18px;
    z-index: 30;
    padding: 6px 12px;
    border-radius: 6px;
    font: 12px/1.5 system-ui, sans-serif;
    color: #fff;
    pointer-events: none;
    box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    max-width: 340px;
  `;
  tip.style.background = ok ? 'rgba(30,120,70,0.92)' : 'rgba(60,90,140,0.92)';
  tip.textContent = ok
    ? `本机服务已连接`
    : `离线模式 · 视频将保存到下载文件夹`;
  document.body.appendChild(tip);
}

(async function initBackendStatus() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch('/api/health', { signal: controller.signal });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('json')) {
      const data = await res.json();
      if (data && data.ok) {
        renderBackendTip(true);
        return;
      }
    }
    renderBackendTip(false, '（请用 npm run dev 启动 dev server，并确认 5173 未被旧进程占用后刷新）');
  } catch {
    renderBackendTip(false, '（请用 npm run dev 启动 dev server，并确认 5173 未被旧进程占用后刷新）');
  }
})();
