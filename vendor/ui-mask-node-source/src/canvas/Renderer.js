import { VideoElement } from '../elements/VideoElement.js';
import { VideoLayer } from './VideoLayer.js';

/** 秒 → mm:ss（剪辑软件习惯的时间码显示） */
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 渲染器
 * 画网格、视频流和其他元素。视频按视口平移缩放，播放中不逐帧 seek。
 */
export class Renderer {
  constructor(canvas, viewport) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.viewport = viewport;
    this.elements = [];
    this.grid = null;
    this.videoStream = null;
    this.videoElement = null;
    this.videoLayer = new VideoLayer();
    this.running = false;
    this.isRunning = false;
    this.lastTime = 0;
    this.loop = this._loop.bind(this);
  }

  setGrid(grid) {
    this.grid = grid;
  }

  /**
   * 接入视频流。带 mode 的转换结果会按该模式绘制。
   * 视频默认暂停显示首帧（浏览器自动播放策略会拦截带声音的自动播放，
   * 且符合创作习惯：先看素材，再手动播放）。
   * @param {HTMLVideoElement | { source?: HTMLVideoElement, mode?: string, sourceFile?: File } | null} videoStream
   */
  setVideoStream(videoStream) {
    this.videoStream = videoStream || null;
    this._syncVideoElement();
  }

  /** 供外部（播放控制条/节点）触发放置：用户手势内调用，浏览器允许带声音播放 */
  playVideo() {
    if (this.videoElement) this.videoElement.play();
  }

  /** 暂停当前视频 */
  pauseVideo() {
    if (this.videoElement) this.videoElement.pause();
  }

  addElement(element) {
    this.elements.push(element);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.isRunning = true;
    this.lastTime = 0;
    requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    this.isRunning = false;
  }

  _loop(timestamp) {
    if (!this.running) return;
    if (!this.lastTime) this.lastTime = timestamp;
    const deltaTime = (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;
    this._draw(deltaTime);
    requestAnimationFrame(this.loop);
  }

  _draw(deltaTime) {
    // 静态跳帧：视口未变、无视频播放、无动画元素时，画面静止，直接跳过整帧绘制。
    // 避免 4K 视频/大画布每帧 clearRect + 重绘吃满 GPU，导致系统卡顿。
    // 任何平移/缩放（视口键变化）、播放、或超过 150ms 都会强制重绘，视觉无损。
    const vp = this.viewport;
    const vpKey = `${vp.panX}|${vp.panY}|${vp.zoom}`;
    const playing = !!(this.videoElement?.playing);
    const hasAnimated = this.elements.some((el) => !el.hidden && el.animated);
    const now = performance.now();
    if (!playing && !hasAnimated && vpKey === this._lastVpKey && (this._lastDrawAt == null || now - this._lastDrawAt < 150)) {
      return; // 静止画面零重绘
    }
    this._lastVpKey = vpKey;
    this._lastDrawAt = now;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.grid) {
      this.grid.render(ctx, this.viewport, this.canvas.width, this.canvas.height);
    }

    this._drawVideoStream(deltaTime);

    for (const element of this.elements) {
      if (element.hidden) continue;
      const visible = this.isElementVisible(element);
      if (visible && typeof element.update === 'function') {
        element.update(deltaTime);
      } else if (!visible && typeof element.suspend === 'function') {
        element.suspend();
      }
      if (visible && typeof element.render === 'function') {
        element.render(ctx, this.viewport);
      }
    }
  }

  _syncVideoElement() {
    const stream = this.videoStream;
    const rawVideo = stream ? (stream.source || stream) : null;
    const mode = stream?.mode || 'none';

    if (!rawVideo || !rawVideo.videoWidth || !rawVideo.videoHeight) {
      if (this.videoElement) this.videoElement.pause();
      this.videoElement = null;
      return;
    }

    if (this.videoElement && this.videoElement.video === rawVideo) {
      this.videoElement.sourceFile = stream.sourceFile || rawVideo.sourceFile || null;
      if (this.videoElement.fpsConvertMode !== mode) {
        this.videoElement.setFpsConvertMode(mode);
      }
      return;
    }

    if (this.videoElement) this.videoElement.pause();
    const videoEl = new VideoElement(-rawVideo.videoWidth / 2, -rawVideo.videoHeight / 2, rawVideo);
    videoEl.sourceFile = stream.sourceFile || rawVideo.sourceFile || null;
    videoEl.setFpsConvertMode(mode);
    // 不自动播放：等用户手势（点击播放/空格）再带声音播放
    videoEl.pause();
    this.videoElement = videoEl;
  }

  /**
   * 画当前视频流。用已解码画面和帧率模式，不在每一帧里 seek。
   * 视频画面 + 底部播放控制条（播放/暂停、进度、时间码、音量）。
   * @param {number} deltaTime
   */
  _drawVideoStream(deltaTime) {
    this._syncVideoElement();
    if (!this.videoElement) return;

    const rect = this.videoLayer.layout(
      this.videoElement.video.videoWidth,
      this.videoElement.video.videoHeight,
      this.viewport,
      this.canvas.width,
      this.canvas.height
    );
    if (!rect || !this.videoLayer.isOnScreen(rect, this.canvas.width, this.canvas.height)) {
      this.videoElement.suspend();
      // 离屏时清空控制几何与命中，避免残留
      this._controlsGeometry = null;
      this.videoRect = null;
      return;
    }

    // 记录当前视频屏幕矩形，供播放控制交互命中检测
    this.videoRect = rect;
    this.videoLayer.draw(this.ctx, this.videoElement, this.viewport);
    this.videoElement.update(deltaTime);

    // 播放控制条：叠加在视频画面底部，参考剪辑软件播放器习惯
    this._drawPlaybackControls(rect);
  }

  /**
   * 绘制播放控制条（播放/暂停、可拖进度条、时间码、音量静音）。
   * 全部画在视频画面内部的底部半透明条带上，随视频缩放平移。
   * @param {{x:number,y:number,width:number,height:number}} rect 视频屏幕矩形
   */
  _drawPlaybackControls(rect) {
    const ctx = this.ctx;
    const ve = this.videoElement;
    if (!ve || !ve.video) return;
    const video = ve.video;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration) return;

    // 控制条参数（相对视频宽高的比例，随缩放自适应）
    const barH = Math.max(24, Math.min(48, rect.height * 0.08));
    const barY = rect.y + rect.height - barH;
    const padding = Math.max(6, barH * 0.18);
    const btnW = barH * 0.8;
    const timeW = Math.min(110, Math.max(64, rect.width * 0.24));
    const volumeW = Math.min(54, Math.max(32, rect.width * 0.12));

    ctx.save();
    // 半透明底
    ctx.fillStyle = 'rgba(12, 12, 20, 0.72)';
    ctx.fillRect(rect.x, barY, rect.width, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x, barY, rect.width, barH);

    // 时间码（当前/总时长）
    ctx.fillStyle = '#e6e6e6';
    ctx.font = `${Math.max(10, barH * 0.34)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const timeText = `${fmtTime(ve.playTime)} / ${fmtTime(duration)}`;
    ctx.fillText(timeText, rect.x + padding + btnW + timeW / 2, barY + barH / 2);

    // 进度条（可拖拽 seek）
    const trackX = rect.x + padding + btnW + timeW + padding;
    const trackW = rect.width - padding * 2 - btnW - timeW - padding * 2 - volumeW;
    const trackY = barY + barH / 2;
    const progress = Math.max(0, Math.min(1, ve.playTime / duration));
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = Math.max(2, barH * 0.08);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(trackX, trackY);
    ctx.lineTo(trackX + trackW, trackY);
    ctx.stroke();
    // 已播部分
    ctx.strokeStyle = '#50c878';
    ctx.beginPath();
    ctx.moveTo(trackX, trackY);
    ctx.lineTo(trackX + trackW * progress, trackY);
    ctx.stroke();
    // 播放头
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(trackX + trackW * progress, trackY, Math.max(3, barH * 0.1), 0, Math.PI * 2);
    ctx.fill();

    // 播放/暂停按钮（视频画面中央大按钮）
    if (!ve.playing) {
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2 - barH / 2;
      const r = Math.max(22, Math.min(48, Math.min(rect.width, rect.height) * 0.14));
      ctx.fillStyle = 'rgba(12, 12, 20, 0.6)';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 播放三角
      ctx.fillStyle = '#ffffff';
      const tri = r * 0.36;
      ctx.beginPath();
      ctx.moveTo(cx - tri * 0.7, cy - tri);
      ctx.lineTo(cx - tri * 0.7, cy + tri);
      ctx.lineTo(cx + tri, cy);
      ctx.closePath();
      ctx.fill();
    }

    // 音量静音按钮（控制条右端；点击切换静音）
    const volX = rect.x + rect.width - padding - volumeW;
    const volY = barY + barH / 2;
    const muted = !!video.muted;
    ctx.fillStyle = muted ? 'rgba(255,120,120,0.9)' : '#e6e6e6';
    // 喇叭图标
    const spW = volumeW * 0.32;
    const spH = barH * 0.28;
    ctx.beginPath();
    ctx.moveTo(volX, volY - spH * 0.3);
    ctx.lineTo(volX + spW * 0.55, volY - spH * 0.3);
    ctx.lineTo(volX + spW * 0.55 + spW * 0.35, volY - spH);
    ctx.lineTo(volX + spW * 0.55 + spW * 0.35, volY + spH);
    ctx.lineTo(volX + spW * 0.55, volY + spH * 0.3);
    ctx.lineTo(volX, volY + spH * 0.3);
    ctx.closePath();
    ctx.fill();
    // 声波弧线（非静音时）
    if (!muted) {
      ctx.strokeStyle = '#e6e6e6';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(volX + spW * 0.55 + spW * 0.5, volY, spW * 0.38, -0.5, 0.5);
      ctx.stroke();
    } else {
      // 静音斜线
      ctx.strokeStyle = 'rgba(255,120,120,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(volX + spW * 0.55 + spW * 0.2, volY - spH * 0.6);
      ctx.lineTo(volX + spW * 0.55 + spW * 0.8, volY + spH * 0.6);
      ctx.stroke();
    }

    ctx.restore();

    // 保存控制条几何，供交互命中
    this._controlsGeometry = {
      rect,
      bar: { x: rect.x, y: barY, width: rect.width, height: barH },
      playBtn: {
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2 - barH / 2,
        r: Math.max(22, Math.min(48, Math.min(rect.width, rect.height) * 0.14))
      },
      track: { x: trackX, y: trackY, width: trackW },
      volume: { x: volX, y: volY, width: volumeW, height: barH * 0.9 }
    };
  }

  /** 命中检测：屏幕坐标是否落在播放控制区域 */
  hitPlaybackControls(sx, sy) {
    const g = this._controlsGeometry;
    if (!g || !g.bar) return null;
    // 音量按钮（优先于控制条带）
    if (sx >= g.volume.x - 4 && sx <= g.volume.x + g.volume.width + 4 && sy >= g.volume.y - g.volume.height / 2 && sy <= g.volume.y + g.volume.height / 2) {
      return { type: 'volume', geometry: g };
    }
    // 控制条带
    if (sx >= g.bar.x && sx <= g.bar.x + g.bar.width && sy >= g.bar.y && sy <= g.bar.y + g.bar.height) {
      // 进度条区域
      if (sx >= g.track.x - 6 && sx <= g.track.x + g.track.width + 6 && Math.abs(sy - g.track.y) <= 12) {
        return { type: 'track', geometry: g };
      }
      return { type: 'bar', geometry: g };
    }
    // 中央大播放按钮（仅暂停时显示）
    if (!this.videoElement?.playing) {
      const dx = sx - g.playBtn.cx;
      const dy = sy - g.playBtn.cy;
      if (dx * dx + dy * dy <= g.playBtn.r * g.playBtn.r) {
        return { type: 'play', geometry: g };
      }
    }
    return null;
  }

  isElementVisible(element) {
    const screenPos = this.viewport.worldToScreen(element.x, element.y);
    const screenW = element.width * this.viewport.zoom;
    const screenH = element.height * this.viewport.zoom;
    return (
      screenPos.x + screenW > 0 &&
      screenPos.x < this.canvas.width &&
      screenPos.y + screenH > 0 &&
      screenPos.y < this.canvas.height
    );
  }
}
