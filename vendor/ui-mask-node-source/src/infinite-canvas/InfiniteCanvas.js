import { graphInputBlocked, isTextInput, hasEditorGesture, startEditorGesture } from '../ui/EditorInteraction.js';
import { Viewport } from '../canvas/Viewport.js';
import { Renderer } from '../canvas/Renderer.js';
import { Grid } from '../canvas/Grid.js';

/**
 * 无限画布
 * 最底层：网格、平移缩放、视频前景，以及把视频拖进来的入口。
 */
export class InfiniteCanvas {
  constructor(container) {
    this.container = container;
    this.onVideoDropped = null;
    this.onViewportChange = null;
    this.currentVideo = null;
    this._objectUrl = null;
    this._centered = false;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: block;
      cursor: grab;
      z-index: 1;
    `;
    this.container.appendChild(this.canvas);

    this.viewport = new Viewport();
    this.renderer = new Renderer(this.canvas, this.viewport);
    this.renderer.videoLayer.safeInset = { top: 16, right: 16, bottom: 16, left: 16 };
    this.grid = new Grid();
    this.renderer.setGrid(this.grid);
    this.renderer.start();

    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._bindInteraction();
    this._bindDrop();
  }

  _resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    if (!this._centered) {
      this.viewport.panX = width / 2;
      this.viewport.panY = height / 2;
      this._centered = true;
    }
  }

  _bindInteraction() {
    const canvas = this.canvas;
    const viewport = this.viewport;
    canvas.style.touchAction = 'none';
    this.onBoxSelectStart = null;
    this.onBoxSelectMove = null;
    this.onBoxSelectEnd = null;
    this.onBoxSelectCancel = null;
    const localPoint = e => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    // Middle-button panning also works over a node, without dragging that node.
    this.container.addEventListener('pointerdown', e => {
      if (e.button !== 1 || graphInputBlocked(e)) return;
      const initial = { x: viewport.panX, y: viewport.panY };
      let lastX = e.clientX, lastY = e.clientY;
      const resetCursor = () => { canvas.style.cursor = 'grab'; };
      if (!startEditorGesture(e, {
        element: canvas,
        move: next => {
          viewport.pan(next.clientX - lastX, next.clientY - lastY);
          lastX = next.clientX; lastY = next.clientY;
          this.onViewportChange?.();
        },
        end: resetCursor,
        cancel: reason => {
          if (reason === 'escape') {
            viewport.panX = initial.x; viewport.panY = initial.y;
            this.onViewportChange?.();
          }
          resetCursor();
        }
      })) return;
      canvas.style.cursor = 'grabbing';
      e.stopPropagation();
    }, true);

    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0 || graphInputBlocked(e)) return;
      const hit = this._hitPlayback(e);
      if (hit) {
        if (hit.type === 'play' || hit.type === 'bar') this.togglePlay();
        else if (hit.type === 'volume') this.toggleMute();
        else if (hit.type === 'track') {
          this._scrubTo(e, hit.geometry);
          startEditorGesture(e, {
            element: canvas, move: next => this._scrubTo(next, hit.geometry),
            end: () => { canvas.style.cursor = 'grab'; },
            cancel: () => { canvas.style.cursor = 'grab'; }
          });
          canvas.style.cursor = 'ew-resize';
        }
        return;
      }
      const start = localPoint(e);
      if (!startEditorGesture(e, {
        element: canvas,
        move: next => { const p = localPoint(next); this.onBoxSelectMove?.(p.x, p.y); },
        end: next => { const p = localPoint(next); this.onBoxSelectEnd?.(p.x, p.y); },
        cancel: () => this.onBoxSelectCancel?.()
      })) return;
      this.onBoxSelectStart?.(start.x, start.y);
    });

    this.container.addEventListener('wheel', e => {
      if (graphInputBlocked(e) || isTextInput(e.target) || e.target.closest?.('[data-no-wheel]')) return;
      e.preventDefault();
      if (hasEditorGesture()) return;
      const p = localPoint(e);
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.height : 1);
      viewport.zoomAt(p.x, p.y, Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.0015));
      this.onViewportChange?.();
    }, { passive: false });

    let activeVideo = null;
    document.addEventListener('pointerdown', e => {
      if (graphInputBlocked(e)) return;
      const nodeCard = e.target.closest?.('.node-card');
      if (nodeCard) activeVideo = nodeCard.querySelector('video');
    }, true);
    document.addEventListener('keydown', e => {
      if (e.code !== 'Space' || e.repeat || graphInputBlocked(e) || isTextInput(e.target)) return;
      if (e.target.closest?.('button, a') || document.fullscreenElement || !activeVideo?.videoWidth) return;
      e.preventDefault();
      if (activeVideo.paused) activeVideo.play().catch(() => {});
      else activeVideo.pause();
    });
  }

  /** 命中检测：屏幕坐标是否在播放控制区域 */
  _hitPlayback(e) {
    if (!this.renderer?.videoElement || !this.renderer.hitPlaybackControls) return null;
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return this.renderer.hitPlaybackControls(sx, sy);
  }

  /** 进度条拖动 → seek */
  _scrubTo(e, geometry) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const g = geometry;
    const ratio = (sx - g.track.x) / g.track.width;
    const ve = this.renderer.videoElement;
    if (!ve || !ve.video) return;
    const duration = ve.video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const t = Math.max(0, Math.min(1, ratio)) * duration;
    ve.seek(t);
    ve.pause();
  }

  /** 静音 / 取消静音切换 */
  toggleMute() {
    const ve = this.renderer?.videoElement;
    if (!ve || !ve.video) return;
    ve.video.muted = !ve.video.muted;
  }

  /** 播放 / 暂停切换（在用户手势内调用，带声音合法播放） */
  togglePlay() {
    const ve = this.renderer?.videoElement;
    if (!ve || !ve.video?.videoWidth) return;
    if (ve.playing) {
      ve.pause();
    } else {
      // 视频要带声音，确保未静音
      if (ve.video.muted) ve.video.muted = false;
      ve.play();
      if (ve.video.paused) {
        const p = ve.video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    }
  }

  _bindDrop() {
    this.container.addEventListener('dragover', (e) => {
      if (graphInputBlocked(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    this.container.addEventListener('drop', async (e) => {
      if (graphInputBlocked(e)) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!isVideoFile(file)) return;
      try {
        await this.loadVideo(file);
        await this.onVideoDropped?.(file);
      } catch (err) {
        alert(err.message || '视频加载失败');
      }
    });
  }

  /**
   * 创建视频元素（不推上画布底层）。
   * 视频画面由「视频输入卡片」内嵌播放（ComfyUI Load Video 风格）；
   * 画布底层只负责渲染帧率转换后的预览结果。
   * @param {File} file
   * @returns {Promise<HTMLVideoElement>}
   */
  loadVideo(file) {
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    const video = document.createElement('video');
    this._objectUrl = URL.createObjectURL(file);
    video.src = this._objectUrl;
    video.muted = false; // 带声音播放（创作者习惯：拖入即可听到）
    video.playsInline = true;
    video.preload = 'auto';
    video.sourceFile = file;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled || !video.videoWidth) return;
        settled = true;
        this.currentVideo = video;
        resolve(video);
      };
      video.onloadedmetadata = finish;
      video.onloadeddata = finish;
      video.onerror = () => {
        if (settled) return;
        settled = true;
        reject(new Error('视频加载失败'));
      };
    });
  }

  /**
   * @param {HTMLVideoElement | { source?: HTMLVideoElement, mode?: string } | null} stream
   */
  setVideoStream(stream) {
    this.renderer.setVideoStream(stream);
  }
}

function isVideoFile(file) {
  if (!file) return false;
  if (file.type.startsWith('video/')) return true;
  return /\.(mp4|webm|mov|mkv|ogv|m4v)$/i.test(file.name || '');
}
