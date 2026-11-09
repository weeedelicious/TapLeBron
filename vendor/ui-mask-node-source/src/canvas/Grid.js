/**
 * 无限网格类
 * 根据当前视口动态计算可见网格线，只绘制屏幕范围内的线条
 */
export class Grid {
  constructor() {
    // 世界坐标下的网格大小
    this.gridSize = 100;
    this.strokeStyle = '#333333';
    this.lineWidth = 1;
  }

  /**
   * 绘制网格
   * @param {CanvasRenderingContext2D} ctx 画布上下文
   * @param {Viewport} viewport 视口实例
   * @param {number} canvasWidth 画布宽度
   * @param {number} canvasHeight 画布高度
   */
  render(ctx, viewport, canvasWidth, canvasHeight) {
    // 计算视口四个角对应的世界坐标
    const topLeft = viewport.screenToWorld(0, 0);
    const bottomRight = viewport.screenToWorld(canvasWidth, canvasHeight);

    // 计算起始网格线位置，对齐网格
    const startX = Math.floor(topLeft.x / this.gridSize) * this.gridSize;
    const startY = Math.floor(topLeft.y / this.gridSize) * this.gridSize;

    ctx.save();
    ctx.strokeStyle = this.strokeStyle;
    ctx.lineWidth = this.lineWidth;
    ctx.beginPath();

    // 绘制竖线
    for (let x = startX; x < bottomRight.x; x += this.gridSize) {
      const screenPos = viewport.worldToScreen(x, 0);
      ctx.moveTo(screenPos.x, 0);
      ctx.lineTo(screenPos.x, canvasHeight);
    }

    // 绘制横线
    for (let y = startY; y < bottomRight.y; y += this.gridSize) {
      const screenPos = viewport.worldToScreen(0, y);
      ctx.moveTo(0, screenPos.y);
      ctx.lineTo(canvasWidth, screenPos.y);
    }

    ctx.stroke();
    ctx.restore();
  }
}
