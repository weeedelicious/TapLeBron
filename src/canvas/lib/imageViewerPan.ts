/** 大图查看器：滚轮缩放后，按住中键（或左键）拖动查看细节。

 * Chrome / Edge 点中键默认会进入「自动滚屏」（那个带四向箭头的圆），
 * 必须在捕获阶段 preventDefault，React 冒泡阶段的 onMouseDown 往往来不及。
 */

export const VIEWER_CHROME_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '.shotflow-image-viewer-toolbar',
  '.shotflow-image-viewer-info',
  '.shotflow-image-viewer-strip',
  '.shotflow-image-viewer-actions',
  '.shotflow-image-viewer-node-actions',
  '.shotflow-image-viewer-nav',
].join(', ')

export function isViewerPanButton(button: number): boolean {
  return button === 0 || button === 1
}

export function shouldPreventAutoscroll(button: number): boolean {
  return button === 1
}

export function isViewerChromeTarget(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest(VIEWER_CHROME_SELECTOR))
}

export function nextPanOffset(
  current: { x: number; y: number },
  clientX: number,
  clientY: number,
  lastX: number,
  lastY: number,
): { x: number; y: number } {
  return {
    x: current.x + (clientX - lastX),
    y: current.y + (clientY - lastY),
  }
}

/** 视频未放大时左键留给原生控件；中键始终用来拖。工具条/信息栏不拖。 */
export function shouldStartViewerPan(options: {
  button: number
  isVideo: boolean
  scale: number
  target: EventTarget | null | undefined
}): boolean {
  if (!isViewerPanButton(options.button)) return false
  if (isViewerChromeTarget(options.target)) return false
  if (options.isVideo && options.button === 0 && options.scale <= 1.05) return false
  return true
}
