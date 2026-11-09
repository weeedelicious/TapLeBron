/**
 * 基础元素类
 * 所有画布元素（矩形、视频等）的基类，封装通用属性与交互逻辑
 */
export class BaseElement {
  constructor(x, y, width, height) {
    // 世界坐标位置
    this.x = x;
    this.y = y;
    // 元素尺寸（世界坐标）
    this.width = width;
    this.height = height;
    // 选中状态
    this.selected = false;
  }

  /**
   * 判断世界坐标点是否在元素内
   * @param {number} wx 世界X
   * @param {number} wy 世界Y
   * @returns {boolean} 是否命中
   */
  hitTest(wx, wy) {
    return (
      wx >= this.x &&
      wx <= this.x + this.width &&
      wy >= this.y &&
      wy <= this.y + this.height
    );
  }

  /**
   * 移动元素
   * @param {number} dx 世界X偏移
   * @param {number} dy 世界Y偏移
   */
  move(dx, dy) {
    this.x += dx;
    this.y += dy;
  }

  /**
   * 渲染方法，由子类实现
   * @param {CanvasRenderingContext2D} ctx 画布上下文
   * @param {Viewport} viewport 视口实例
   */
  render(ctx, viewport) {
    // 子类重写此方法
  }
}
