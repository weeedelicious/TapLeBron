/**
 * 视频层
 * 把视频放进视口：按安全区适配大小，再跟平移和缩放走。
 */
export class VideoLayer {
  constructor() {
    this.safeInset = { top: 24, right: 24, bottom: 72, left: 24 };
  }

  /**
   * 计算视频在屏幕上的矩形。
   * 缩放为 1 时完整落在安全区内并居中，平移和缩放沿用视口。
   * @param {number} videoWidth
   * @param {number} videoHeight
   * @param {import('./Viewport.js').Viewport} viewport
   * @param {number} viewWidth
   * @param {number} viewHeight
   * @returns {{x: number, y: number, width: number, height: number} | null}
   */
  layout(videoWidth, videoHeight, viewport, viewWidth, viewHeight) {
    if (!videoWidth || !videoHeight || !viewWidth || !viewHeight || !viewport) return null;

    const { top, right, bottom, left } = this.safeInset;
    const safeW = Math.max(1, viewWidth - left - right);
    const safeH = Math.max(1, viewHeight - top - bottom);
    const contain = Math.min(safeW / videoWidth, safeH / videoHeight);
    const worldW = videoWidth * contain;
    const worldH = videoHeight * contain;
    const centerX = (left - right) / 2;
    const centerY = (top - bottom) / 2;
    const origin = viewport.worldToScreen(centerX - worldW / 2, centerY - worldH / 2);

    return {
      x: origin.x,
      y: origin.y,
      width: worldW * viewport.zoom,
      height: worldH * viewport.zoom
    };
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLVideoElement | { source?: HTMLVideoElement, video?: HTMLVideoElement, render?: Function }} videoStream
   * @param {import('./Viewport.js').Viewport} viewport
   */
  draw(ctx, videoStream, viewport) {
    const video = videoStream?.video || videoStream?.source || videoStream;
    const videoWidth = video?.videoWidth;
    const videoHeight = video?.videoHeight;
    if (!ctx?.canvas || !videoWidth || !videoHeight) return null;

    const rect = this.layout(videoWidth, videoHeight, viewport, ctx.canvas.width, ctx.canvas.height);
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    if (!this.isOnScreen(rect, ctx.canvas.width, ctx.canvas.height)) return null;

    if (typeof videoStream.render === 'function' && videoStream.video) {
      videoStream.drawRect = rect;
      videoStream.render(ctx, viewport);
      videoStream.drawRect = null;
      return rect;
    }

    if (video.readyState >= 2) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }
    return rect;
  }

  isOnScreen(rect, viewWidth, viewHeight) {
    return rect.x < viewWidth && rect.y < viewHeight && rect.x + rect.width > 0 && rect.y + rect.height > 0;
  }
}
