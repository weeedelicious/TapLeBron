export function computeContainedPreviewSize(
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return null
  }
  const scale = Math.min(viewportWidth / sourceWidth, viewportHeight / sourceHeight)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

export const PREVIEW_ZOOM_MIN = 0.5
export const PREVIEW_ZOOM_MAX = 4
export const PREVIEW_ZOOM_STEP = 0.05
export const PREVIEW_ZOOM_WHEEL_SENSITIVITY = 0.0012
export const PREVIEW_STAGE_GUTTER = 24

export function clampPreviewZoom(value: number) {
  const finite = Number.isFinite(value) ? value : 1
  return Math.round(
    Math.max(PREVIEW_ZOOM_MIN, Math.min(PREVIEW_ZOOM_MAX, finite)) * 1000,
  ) / 1000
}

export function nextPreviewZoom(current: number, wheelDeltaY: number) {
  if (wheelDeltaY === 0) return clampPreviewZoom(current)
  return clampPreviewZoom(
    current * Math.exp(-wheelDeltaY * PREVIEW_ZOOM_WHEEL_SENSITIVITY),
  )
}

function zoomGeometry(
  baseWidth: number,
  baseHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  zoom: number,
) {
  const stageWidth = baseWidth * zoom
  const stageHeight = baseHeight * zoom
  const spaceWidth = Math.max(viewportWidth, stageWidth + PREVIEW_STAGE_GUTTER)
  const spaceHeight = Math.max(viewportHeight, stageHeight + PREVIEW_STAGE_GUTTER)
  return {
    stageWidth,
    stageHeight,
    spaceWidth,
    spaceHeight,
    stageLeft: (spaceWidth - stageWidth) / 2,
    stageTop: (spaceHeight - stageHeight) / 2,
  }
}

export function computePreviewZoomScroll({
  baseWidth,
  baseHeight,
  viewportWidth,
  viewportHeight,
  oldZoom,
  newZoom,
  pointerX,
  pointerY,
  scrollLeft,
  scrollTop,
}: {
  baseWidth: number
  baseHeight: number
  viewportWidth: number
  viewportHeight: number
  oldZoom: number
  newZoom: number
  pointerX: number
  pointerY: number
  scrollLeft: number
  scrollTop: number
}) {
  const oldGeometry = zoomGeometry(
    baseWidth,
    baseHeight,
    viewportWidth,
    viewportHeight,
    oldZoom,
  )
  const newGeometry = zoomGeometry(
    baseWidth,
    baseHeight,
    viewportWidth,
    viewportHeight,
    newZoom,
  )
  const imageX = Math.max(0, Math.min(
    1,
    (
      scrollLeft +
      pointerX -
      oldGeometry.stageLeft
    ) / Math.max(1, oldGeometry.stageWidth),
  ))
  const imageY = Math.max(0, Math.min(
    1,
    (
      scrollTop +
      pointerY -
      oldGeometry.stageTop
    ) / Math.max(1, oldGeometry.stageHeight),
  ))
  return {
    left: Math.max(
      0,
      Math.round(
        newGeometry.stageLeft +
        imageX * newGeometry.stageWidth -
        pointerX,
      ),
    ),
    top: Math.max(
      0,
      Math.round(
        newGeometry.stageTop +
        imageY * newGeometry.stageHeight -
        pointerY,
      ),
    ),
  }
}

export function computePreviewZoomSpace(
  baseWidth: number,
  baseHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  zoom: number,
) {
  const geometry = zoomGeometry(
    baseWidth,
    baseHeight,
    viewportWidth,
    viewportHeight,
    zoom,
  )
  return {
    stageWidth: Math.round(geometry.stageWidth),
    stageHeight: Math.round(geometry.stageHeight),
    spaceWidth: Math.round(geometry.spaceWidth),
    spaceHeight: Math.round(geometry.spaceHeight),
  }
}

export function computePreviewPanScroll({
  startScrollLeft,
  startScrollTop,
  startPointerX,
  startPointerY,
  pointerX,
  pointerY,
  maxScrollLeft,
  maxScrollTop,
}: {
  startScrollLeft: number
  startScrollTop: number
  startPointerX: number
  startPointerY: number
  pointerX: number
  pointerY: number
  maxScrollLeft: number
  maxScrollTop: number
}) {
  const clampScroll = (value: number, maximum: number) => Math.max(
    0,
    Math.min(Math.max(0, maximum), Math.round(value)),
  )
  return {
    left: clampScroll(
      startScrollLeft - (pointerX - startPointerX),
      maxScrollLeft,
    ),
    top: clampScroll(
      startScrollTop - (pointerY - startPointerY),
      maxScrollTop,
    ),
  }
}
