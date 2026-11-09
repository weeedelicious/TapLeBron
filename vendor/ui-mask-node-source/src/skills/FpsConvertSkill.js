import { BaseNode } from '../node-editor/BaseNode.js';
import { mapBlend, mapDuplicateSource } from '../elements/VideoElement.js';

/**
 * Skill: 帧率转换节点
 * 24fps 转 30fps。映射与渲染同一套：帧复制取最近原帧，帧混合先铺满前帧再盖后帧。
 *
 * 端口规范（与「视频素材」卡片同构）：
 *   - 输入：只有一个「视频源」，继承上游复合对象里的全部信息（原始帧率/分辨率/时长）
 *   - 输出：只有一个「转换后视频」，把转换后的全部信息（视频/目标帧率/模式/源文件）封装成复合对象
 *
 * 预览：不再平铺到画布，改为节点内嵌小画面（canvas 逐帧渲染转换效果）。
 */
export class FpsConvertSkill extends BaseNode {
  static nodeId = 'fps_convert';
  static nodeName = '帧率转换';

  constructor(id, x, y) {
    super(id, 'fps_convert', x, y);

    // 唯一输入：视频源（复合对象，继承上游全部信息）
    this.addInput('视频源', 'video');
    // 唯一输出：转换后视频（复合对象，封装目标帧率/模式/源文件）
    this.addOutput('转换后视频', 'video');

    this.addParam('mode', '转换模式', 'duplicate', 'select', [
      { label: '帧复制（画质无损）', value: 'duplicate' },
      { label: '帧混合（运动更流畅，轻微模糊）', value: 'blend' },
      { label: '光流法（最丝滑，实验性）', value: 'optical' }
    ]);
    this.addParam('targetFps', '目标帧率', 30, 'number');

    // 节点内嵌小预览高度（替代画布平铺大预览）
    this.previewHeight = 150;
  }

  execute() {
    const sourceInput = this.getInput('视频源');
    if (sourceInput?.hudState && sourceInput.hudState !== 'ready') {
      this.outputData = { '转换后视频': sourceInput };
      return;
    }
    // 原始帧率从上游复合对象继承（无需单独端口）
    const originalFps = sourceInput?.originalFps || 24;
    const mode = this.getParam('mode');
    const targetFps = this.getParam('targetFps');

    // 兼容复合视频源对象：{ video, source, originalFps, ... } 或 HTMLVideoElement / VideoElement
    const sourceVideo = sourceInput?.video || sourceInput?.source || sourceInput || null;

    if (!sourceVideo) {
      this.outputData = { '转换后视频': null };
      return;
    }

    const convertedVideo = {
      kind: 'video-source',
      hudState: sourceInput?.hudState,
      processedAsset: sourceInput?.processedAsset,
      video: sourceVideo,
      source: sourceVideo,
      sourceFile: sourceInput?.sourceFile || sourceVideo.sourceFile || null,
      originalFps,
      targetFps,
      mode,
      resolution: {
        w: sourceInput?.resolution?.w || sourceVideo.videoWidth,
        h: sourceInput?.resolution?.h || sourceVideo.videoHeight
      },
      duration: sourceInput?.duration || (Number.isFinite(sourceVideo.duration) ? sourceVideo.duration : 0),
      // 音轨信息透传：源有音轨 → 转换后仍然有（帧率转换不动音频数据）
      audio: sourceInput?.audio || null,
      get videoWidth() { return sourceVideo.videoWidth; },
      get videoHeight() { return sourceVideo.videoHeight; },
      renderFrameAtTime: (ctx, time) => {
        const targetFrameIndex = Math.max(0, Math.floor(time * targetFps + 1e-4));
        const width = sourceVideo.videoWidth;
        const height = sourceVideo.videoHeight;
        const duration = sourceVideo.duration;
        const maxFrame = Number.isFinite(duration) && duration > 0
          ? Math.max(0, Math.round(duration * originalFps) - 1)
          : 0;
        const clamp = (index) => Math.max(0, Math.min(index, maxFrame));
        ctx.globalAlpha = 1;

        if (mode === 'blend') {
          const { frameIndex, alpha } = mapBlend(targetFrameIndex, originalFps, targetFps);
          const prevIdx = clamp(frameIndex);
          const nextIdx = clamp(frameIndex + 1);
          sourceVideo.currentTime = prevIdx / originalFps;
          ctx.drawImage(sourceVideo, 0, 0, width, height);
          if (alpha > 0 && nextIdx !== prevIdx) {
            sourceVideo.currentTime = nextIdx / originalFps;
            ctx.globalAlpha = alpha;
            ctx.drawImage(sourceVideo, 0, 0, width, height);
            ctx.globalAlpha = 1;
          }
        } else {
          const dupIndex = clamp(mapDuplicateSource(targetFrameIndex, originalFps, targetFps));
          sourceVideo.currentTime = dupIndex / originalFps;
          ctx.drawImage(sourceVideo, 0, 0, width, height);
        }
      }
    };

    this.outputData = { '转换后视频': convertedVideo };
  }

  /**
   * 节点内嵌小预览：跟随源视频播放画面（零 seek）。
   * 关键：绝不调用 renderFrameAtTime（那会每帧 seek 源 video，把卡片播放钉死）。
   * 播放中直接画源 video 当前帧（运动节奏与转换后一致）；暂停时画当前暂停帧。
   */
  onRendered() {
    if (!this.element || this.element.querySelector('.fps-preview-canvas')) return;

    // 等 preview-wrap 挂载（renderNode 已生成，直接取）
    const tryMount = () => {
      const wrap = this.element.querySelector('.preview-wrap');
      if (!wrap) {
        requestAnimationFrame(tryMount);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.className = 'fps-preview-canvas';
      canvas.style.cssText = 'width:100%; height:100%; display:block; background:#000;';
      wrap.appendChild(canvas);
      const ctx = canvas.getContext('2d');

      let raf = null;
      const tick = () => {
        const out = this.getOutput('转换后视频');
        const sv = out?.source || out?.video || null;
        const w = canvas.width;
        const h = canvas.height;

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);

        if (sv?.videoWidth) {
          if (sv.readyState >= 2) {
            const scale = Math.min(w / sv.videoWidth, h / sv.videoHeight);
            const dw = sv.videoWidth * scale;
            const dh = sv.videoHeight * scale;
            const dx = (w - dw) / 2;
            const dy = (h - dh) / 2;
            try { ctx.drawImage(sv, dx, dy, dw, dh); } catch (e) { /* ignore */ }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      // 节点销毁时停止循环
      this._previewStop = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
      };
    };
    requestAnimationFrame(tryMount);
  }

  /** 节点被删除时释放：停止预览循环 */
  dispose() {
    if (typeof this._previewStop === 'function') this._previewStop();
    this._previewStop = null;
  }
}
