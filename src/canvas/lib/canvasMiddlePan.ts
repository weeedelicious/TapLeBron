/**
 * 展开多图 / 多视频时，非主图那几张是 portal 到 document.body 的。
 * React Flow 的 panOnDrag 收不到它们上面的中键，看起来就像拖不动画布。
 *
 * 在捕获阶段拦中键：挡住 Chrome 自动滚屏，并把位移交给画布 viewport。
 * 大图查看器、裁剪弹窗等全屏层自己处理指针，这里不要抢。
 */

export const EXPANDED_GALLERY_PAN_ATTR = 'data-shotflow-expanded-gallery'
export const BLOCK_CANVAS_PAN_ATTR = 'data-block-canvas-pan'

export function isCanvasMiddleButton(button: number) {
  return button === 1
}

export function isExpandedGalleryPanTarget(target: EventTarget | null | undefined) {
  if (!(target instanceof Element)) return false
  if (target.closest(`[${BLOCK_CANVAS_PAN_ATTR}]`)) return false
  if (target.closest('.shotflow-image-viewer')) return false
  if (target.closest('button, a, input, textarea, select')) return false
  return Boolean(target.closest(`[${EXPANDED_GALLERY_PAN_ATTR}]`))
}

export function nextCanvasPanViewport(
  viewport: { x: number; y: number; zoom: number },
  clientX: number,
  clientY: number,
  lastX: number,
  lastY: number,
) {
  return {
    x: viewport.x + (clientX - lastX),
    y: viewport.y + (clientY - lastY),
    zoom: viewport.zoom,
  }
}
