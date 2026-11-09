import { clamp } from '../utils/math.js';

/**
 * 视口类 - 无限画布核心
 * 管理世界坐标与屏幕坐标的转换，处理平移、缩放变换
 */
export class Viewport {
  constructor() {
    // 平移偏移量（世界坐标）
    this.panX = 0;
    this.panY = 0;
    // 缩放倍数
    this.zoom = 1;
    // 缩放范围限制
    this.minZoom = 0.1;
    this.maxZoom = 5;
  }

  /**
   * 世界坐标转屏幕坐标
   * @param {number} wx 世界X
   * @param {number} wy 世界Y
   * @returns {{x: number, y: number}} 屏幕坐标
   */
  worldToScreen(wx, wy) {
    return {
      x: (wx + this.panX) * this.zoom,
      y: (wy + this.panY) * this.zoom
    };
  }

  /**
   * 屏幕坐标转世界坐标
   * @param {number} sx 屏幕X
   * @param {number} sy 屏幕Y
   * @returns {{x: number, y: number}} 世界坐标
   */
  screenToWorld(sx, sy) {
    return {
      x: sx / this.zoom - this.panX,
      y: sy / this.zoom - this.panY
    };
  }

  /**
   * 平移画布
   * 屏幕位移换算到世界坐标后累加，拖拽方向与内容移动方向一致
   * @param {number} dx 屏幕像素X偏移
   * @param {number} dy 屏幕像素Y偏移
   */
  pan(dx, dy) {
    this.panX += dx / this.zoom;
    this.panY += dy / this.zoom;
  }

  /**
   * 以指定屏幕点为中心缩放
   * @param {number} sx 屏幕中心点X
   * @param {number} sy 屏幕中心点Y
   * @param {number} factor 缩放系数
   */
  zoomAt(sx, sy, factor) {
    // 缩放前记录鼠标对应的世界坐标
    const worldBefore = this.screenToWorld(sx, sy);

    // 应用缩放并限制范围
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);

    // 缩放后调整平移量，保持鼠标指向的世界坐标不变
    const worldAfter = this.screenToWorld(sx, sy);
    this.panX += worldAfter.x - worldBefore.x;
    this.panY += worldAfter.y - worldBefore.y;
  }
}
