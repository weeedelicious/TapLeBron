import { BaseElement } from './BaseElement.js';
import { generateIntermediateFrame } from '../utils/OpticalFlow.js';
import { generateIntermediateFrameAI, checkAISupport } from '../utils/AIOpticalFlow.js';

// AI光流是否可用（缓存结果）
let aiSupported = null;

/**
 * 30fps 输出帧对应的 24fps 原帧。四舍五入到最近原帧。
 * 每 4 张原帧铺进 5 张输出帧，总时长不变；被重复的原帧形成顿挫。
 * @param {number} targetFrameIndex
 * @param {number} originalFps
 * @param {number} targetFps
 * @returns {number}
 */
export function mapDuplicateSource(targetFrameIndex, originalFps = 24, targetFps = 30) {
  return Math.round(targetFrameIndex * (originalFps / targetFps));
}

/**
 * 30fps 输出帧在原片时间轴上的位置，以及与后一帧的混合比。
 * @param {number} targetFrameIndex
 * @param {number} originalFps
 * @param {number} targetFps
 * @returns {{frameIndex: number, alpha: number}}
 */
export function mapBlend(targetFrameIndex, originalFps = 24, targetFps = 30) {
  const sourceFramePos = targetFrameIndex * (originalFps / targetFps);
  const frameIndex = Math.floor(sourceFramePos);
  return {
    frameIndex,
    alpha: sourceFramePos - frameIndex
  };
}

/**
 * 视频元素类 - 支持24fps→30fps帧率转换
 * 继承基础元素，封装视频播放、时间控制、帧率转换、帧渲染逻辑
 */
export class VideoElement extends BaseElement {
  constructor(x, y, video) {
    // 以视频原始分辨率作为元素世界尺寸
    super(x, y, video.videoWidth, video.videoHeight);
    this.video = video;
    this.playing = false;
    this.playTime = 0; // 当前播放时间（秒），三种模式共用
    this.playbackRate = 1; // 基础播放速率

    // ========== 帧率转换配置 ==========
    this.originalFps = 24; // 原始视频帧率
    this.targetFps = 30; // 目标输出帧率
    this.fpsConvertMode = 'none'; // none | duplicate | blend
    this.lastFrameIndex = -1; // 上一次写入缓存的原帧索引
    this.currentBlendAlpha = 0; // 后一帧的混合权重
    this.frameBank = new Map();
    this.bankLimit = 16;

    this.video.addEventListener('seeked', () => {
      if (this.playing || this.exporting || this.video.readyState < 2) return;
      this.forceStoreFrame(this.visibleSourceIndex());
    });
  }

  /**
   * 30fps 输出帧号。加上很小的偏移，避免 1/30 这类二进制小数被 floor 成上一帧。
   * @param {number} [playTime]
   * @returns {number}
   */
  outputFrameIndex(playTime = this.playTime) {
    return Math.max(0, Math.floor(playTime * this.targetFps + 1e-4));
  }

  /**
   * 当前模式实际显示的原帧号
   * @returns {number}
   */
  visibleSourceIndex() {
    if (this.fpsConvertMode === 'duplicate') return this.duplicateSourceIndex();
    if (this.fpsConvertMode === 'blend') return this.blendState().frameIndex;
    return this.clampFrame(Math.floor(this.playTime * this.originalFps + 1e-4));
  }

  /**
   * 按指定原帧号写入缓存，供暂停后的逐帧查看使用
   * @param {number} index
   */
  forceStoreFrame(index) {
    if (this.video.readyState < 2 || !this.width || !this.height) return;
    if (index < 0) return;

    let slot = this.frameBank.get(index);
    if (!slot) {
      slot = document.createElement('canvas');
      slot.width = this.width;
      slot.height = this.height;
      this.frameBank.set(index, slot);
      while (this.frameBank.size > this.bankLimit) {
        const oldest = this.frameBank.keys().next().value;
        this.frameBank.delete(oldest);
      }
    }

    const cacheCtx = slot.getContext('2d');
    cacheCtx.clearRect(0, 0, slot.width, slot.height);
    cacheCtx.drawImage(this.video, 0, 0, slot.width, slot.height);
    this.lastFrameIndex = index;
  }

  /**
   * 把当前已解码的原帧抄进缓存。只在原帧号变化时画一次。
   */
  capturePresentedFrame() {
    if (this.video.readyState < 2 || this.video.seeking) return;
    if (!this.width || !this.height) return;

    const index = Math.floor(this.video.currentTime * this.originalFps + 1e-3);
    if (index < 0 || index === this.lastFrameIndex) return;
    if (Math.abs(this.video.currentTime - this.playTime) > 1.5 / this.originalFps) return;

    let slot = this.frameBank.get(index);
    if (!slot) {
      slot = document.createElement('canvas');
      slot.width = this.width;
      slot.height = this.height;
      this.frameBank.set(index, slot);
      while (this.frameBank.size > this.bankLimit) {
        const oldest = this.frameBank.keys().next().value;
        this.frameBank.delete(oldest);
      }
    }

    const cacheCtx = slot.getContext('2d');
    cacheCtx.clearRect(0, 0, slot.width, slot.height);
    cacheCtx.drawImage(this.video, 0, 0, slot.width, slot.height);
    this.lastFrameIndex = index;
  }

  /**
   * 设置帧率转换模式
   * @param {string} mode none | duplicate | blend
   */
  setFpsConvertMode(mode) {
    this.fpsConvertMode = mode;
    this.lastFrameIndex = -1;
    this.seek(this.playTime);
  }

  /**
   * 跳转到指定时间
   * @param {number} time 目标时间（秒）
   */
  seek(time) {
    if (!Number.isFinite(time)) return;
    const duration = this.video.duration;
    let next = Math.max(0, time);
    if (Number.isFinite(duration) && duration > 0) {
      next = Math.min(next, duration);
    }
    this.playTime = next;
    this.lastFrameIndex = -1;

    if (this.fpsConvertMode === 'blend') {
      this.currentBlendAlpha = this.blendState().alpha;
    }

    const sampleTime = this.playing ? this.playTime : this.visibleSourceIndex() / this.originalFps;
    if (Math.abs((this.video.currentTime || 0) - sampleTime) > 1e-4) {
      try {
        this.video.currentTime = sampleTime;
      } catch (err) {
        // 元数据还没到时，先记下 playTime，等解码完成后再显示
      }
    } else if (!this.playing) {
      this.forceStoreFrame(this.visibleSourceIndex());
    }
  }

  /**
   * 逐帧步进。停在该帧，按目标帧率走一格。
   * @param {number} frameCount 步进帧数，按目标帧率计算
   */
  stepFrame(frameCount) {
    this.pause();
    const nextIndex = Math.max(0, this.outputFrameIndex() + frameCount);
    this.seek(nextIndex / this.targetFps);
  }

  /**
   * 获取调试信息
   * @returns {object} 当前帧所有调试参数
   */
  getDebugInfo() {
    const targetFrameIndex = this.outputFrameIndex();
    const sourceFramePos = targetFrameIndex * (this.originalFps / this.targetFps);
    let sourceFrameIndex = this.visibleSourceIndex();
    let blendAlpha = this.currentBlendAlpha;
    if (this.fpsConvertMode === 'blend') {
      const state = this.blendState();
      sourceFrameIndex = state.frameIndex;
      blendAlpha = state.alpha;
      this.currentBlendAlpha = state.alpha;
    }
    return {
      mode: this.fpsConvertMode,
      playTime: this.playTime.toFixed(4),
      targetFps: this.targetFps,
      targetFrameIndex,
      originalFps: this.originalFps,
      sourceFrameIndex,
      sourceFramePos: sourceFramePos.toFixed(4),
      blendAlpha: blendAlpha.toFixed(4)
    };
  }

  /**
   * 原帧号夹到成片范围内
   * @param {number} index
   * @returns {number}
   */
  clampFrame(index) {
    if (index < 0) return 0;
    const duration = this.video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return index;
    const maxFrame = Math.max(0, Math.round(duration * this.originalFps) - 1);
    return Math.min(index, maxFrame);
  }

  /**
   * 当前时刻 3:2 帧复制应显示的原帧
   * @param {number} [playTime]
   * @returns {number}
   */
  duplicateSourceIndex(playTime = this.playTime) {
    return this.clampFrame(mapDuplicateSource(this.outputFrameIndex(playTime), this.originalFps, this.targetFps));
  }

  /**
   * 当前时刻帧混合的前帧与后帧权重
   * @param {number} [playTime]
   * @returns {{frameIndex: number, alpha: number}}
   */
  blendState(playTime = this.playTime) {
    const mapped = mapBlend(this.outputFrameIndex(playTime), this.originalFps, this.targetFps);
    return {
      frameIndex: this.clampFrame(mapped.frameIndex),
      alpha: mapped.alpha
    };
  }

  /**
   * 等到指定时间的画面真正解码出来
   * @param {number} time
   */
  seekVideoFrame(time) {
    const duration = this.video.duration;
    let target = Math.max(0, time);
    if (Number.isFinite(duration) && duration > 0) {
      target = Math.min(target, Math.max(0, duration - 0.04));
    }
    if (Math.abs(this.video.currentTime - target) < 0.0004 && this.video.readyState >= 2 && !this.video.seeking) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.video.removeEventListener('seeked', finish);
        resolve();
      };
      const timer = setTimeout(finish, 500);
      this.video.addEventListener('seeked', finish);
      try {
        this.video.currentTime = target;
      } catch (err) {
        finish();
      }
    }).then(() => new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    }));
  }

  /**
   * 把当前解码帧拍成位图。drawImage 在 seeked 当帧可能仍是旧画面。
   */
  async snapshotVideo() {
    if (this.video.readyState < 2) return null;
    return createImageBitmap(this.video);
  }

  /**
   * 在指定时间点渲染一帧到目标上下文。
   * 不改 playTime。seek 完成后再画，否则画到的仍是上一帧。
   * @param {CanvasRenderingContext2D} ctx 目标画布上下文
   * @param {number} time 时间点（秒）
   * @param {string} mode 帧率转换模式
   */
  async renderFrameAtTime(ctx, time, mode) {
    const width = this.width;
    const height = this.height;
    this.exporting = true;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);

    try {
      if (mode === 'blend') {
        const { frameIndex, alpha } = this.blendState(time);
        await this.seekVideoFrame(frameIndex / this.originalFps);
        const prev = await this.snapshotVideo();
        const nextIndex = this.clampFrame(frameIndex + 1);
        let next = null;
        if (alpha > 0 && nextIndex !== frameIndex) {
          await this.seekVideoFrame(nextIndex / this.originalFps);
          next = await this.snapshotVideo();
        }
        if (prev) ctx.drawImage(prev, 0, 0, width, height);
        if (next) {
          ctx.globalAlpha = alpha;
          ctx.drawImage(next, 0, 0, width, height);
        }
        prev?.close();
        next?.close();
      } else if (mode === 'optical') {
        // AI光流法（优先），不支持时降级到块匹配
        const { frameIndex, alpha } = this.blendState(time);
        await this.seekVideoFrame(frameIndex / this.originalFps);
        const prev = await this.snapshotVideo();
        const nextIndex = this.clampFrame(frameIndex + 1);
        let next = null;
        if (alpha > 0 && nextIndex !== frameIndex) {
          await this.seekVideoFrame(nextIndex / this.originalFps);
          next = await this.snapshotVideo();
        }
        if (prev && next) {
          // 优先用 AI 光流
          if (aiSupported === null) {
            aiSupported = await checkAISupport();
          }
          
          if (aiSupported) {
            try {
              const intermediate = await generateIntermediateFrameAI(prev, next, alpha);
              ctx.drawImage(intermediate, 0, 0, width, height);
            } catch (e) {
              console.warn('[AI光流] 失败，降级到块匹配：', e);
              aiSupported = false;
              const intermediate = generateIntermediateFrame(prev, next, alpha);
              ctx.drawImage(intermediate, 0, 0, width, height);
            }
          } else {
            // 降级到块匹配
            const intermediate = generateIntermediateFrame(prev, next, alpha);
            ctx.drawImage(intermediate, 0, 0, width, height);
          }
        } else if (prev) {
          ctx.drawImage(prev, 0, 0, width, height);
        }
        prev?.close();
        next?.close();
      } else {
        const sourceTime = mode === 'duplicate'
          ? this.duplicateSourceIndex(time) / this.originalFps
          : time;
        await this.seekVideoFrame(sourceTime);
        const shot = await this.snapshotVideo();
        if (shot) {
          ctx.drawImage(shot, 0, 0, width, height);
          shot.close();
        }
      }
    } finally {
      ctx.restore();
      this.exporting = false;
    }
  }

  /**
   * 帧更新：由渲染器统一驱动
   * 时间轴与模式无关，所以三种模式总时长一致。
   * 解码走原生播放；转换只改变绘制时取哪一张原帧。
   * @param {number} deltaTime 距上一帧的时间增量（秒）
   */
  update(deltaTime) {
    if (!this.playing) return;

    if (this.video.ended) {
      this.playTime = 0;
      this.lastFrameIndex = -1;
      this.video.currentTime = 0;
    }

    if (this.video.paused) {
      this.video.playbackRate = this.playbackRate;
      const pending = this.video.play();
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {});
      }
    } else if (this.video.playbackRate !== this.playbackRate) {
      this.video.playbackRate = this.playbackRate;
    }

    if (!Number.isFinite(deltaTime) || deltaTime <= 0) return;

    this.playTime += deltaTime * this.playbackRate;

    const duration = this.video.duration;
    if (Number.isFinite(duration) && duration > 0 && this.playTime >= duration) {
      this.playTime = 0;
      this.lastFrameIndex = -1;
      this.video.currentTime = 0;
      return;
    }

    // 只在时间轴明显偏离时才 seek，避免逐帧 seek 把解码器卡住
    if (!this.video.seeking && Math.abs(this.video.currentTime - this.playTime) > 0.25) {
      this.video.currentTime = this.playTime;
    }

    this.capturePresentedFrame();

    if (this.fpsConvertMode === 'blend') {
      this.currentBlendAlpha = this.blendState().alpha;
    }
  }

  /**
   * 移出视口时暂停解码。playing 保持为真，回到屏幕内由 update 继续。
   */
  suspend() {
    if (this.playing && !this.video.paused) {
      this.video.pause();
    }
  }

  /**
   * 开始播放
   */
  play() {
    this.playing = true;
  }

  /**
   * 暂停播放
   */
  pause() {
    this.playing = false;
    if (this.video && typeof this.video.pause === 'function') {
      this.video.pause();
    }
  }

  /**
   * 直接画当前解码帧
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   */
  drawVideo(ctx, x, y, w, h) {
    if (this.video.readyState < 2) return;
    ctx.globalAlpha = 1;
    ctx.drawImage(this.video, x, y, w, h);
  }

  /**
   * 渲染视频帧到画布
   * @param {CanvasRenderingContext2D} ctx 画布上下文
   * @param {Viewport} viewport 视口实例
   */
  render(ctx, viewport) {
    const screenPos = this.drawRect
      ? { x: this.drawRect.x, y: this.drawRect.y }
      : viewport.worldToScreen(this.x, this.y);
    const screenW = this.drawRect ? this.drawRect.width : this.width * viewport.zoom;
    const screenH = this.drawRect ? this.drawRect.height : this.height * viewport.zoom;
    if (screenW <= 0 || screenH <= 0) return;

    ctx.save();

    if (this.fpsConvertMode === 'blend') {
      const { frameIndex, alpha } = this.blendState();
      this.currentBlendAlpha = alpha;
      const prev = this.frameBank.get(frameIndex);
      const next = this.frameBank.get(this.clampFrame(frameIndex + 1));
      if (prev && next) {
        // 先铺满前帧，再按权重盖上后帧，得到线性混合
        ctx.globalAlpha = 1;
        ctx.drawImage(prev, screenPos.x, screenPos.y, screenW, screenH);
        ctx.globalAlpha = alpha;
        ctx.drawImage(next, screenPos.x, screenPos.y, screenW, screenH);
      } else if (prev || next) {
        ctx.globalAlpha = 1;
        ctx.drawImage(prev || next, screenPos.x, screenPos.y, screenW, screenH);
      } else {
        this.drawVideo(ctx, screenPos.x, screenPos.y, screenW, screenH);
      }
    } else if (this.fpsConvertMode === 'duplicate') {
      const slot = this.frameBank.get(this.duplicateSourceIndex());
      if (slot) {
        ctx.globalAlpha = 1;
        ctx.drawImage(slot, screenPos.x, screenPos.y, screenW, screenH);
      } else {
        this.drawVideo(ctx, screenPos.x, screenPos.y, screenW, screenH);
      }
    } else if (this.video.readyState >= 2) {
      this.drawVideo(ctx, screenPos.x, screenPos.y, screenW, screenH);
    }

    if (this.selected) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(screenPos.x, screenPos.y, screenW, screenH);
    }
    ctx.restore();
  }
}
