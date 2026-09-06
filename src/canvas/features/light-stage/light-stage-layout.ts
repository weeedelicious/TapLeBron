import type { LightStageViewMode } from './types'

export const LIGHT_STAGE_SPHERE_RADIUS = 2.75
export const LIGHT_STAGE_MAX_SPHERE_OCCUPANCY = 0.84
export const LIGHT_STAGE_PERSPECTIVE_CONTAINMENT_SCALE = 0.72
export const LIGHT_STAGE_FRONT_CONTAINMENT_SCALE = 1
export const LIGHT_STAGE_PERSPECTIVE_FOV = 34

const FALLBACK_ASPECT = 4 / 5

export interface LightStagePlaneLayout {
  aspect: number
  width: number
  height: number
  reliefDepth: number
  cssAspectRatio: string
}

export function lightStageSourceAspect(width?: number, height?: number) {
  const safeWidth = Number(width)
  const safeHeight = Number(height)
  if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight) || safeWidth <= 0 || safeHeight <= 0) {
    return FALLBACK_ASPECT
  }
  return safeWidth / safeHeight
}

export function lightStagePlaneLayout(width?: number, height?: number): LightStagePlaneLayout {
  const aspect = lightStageSourceAspect(width, height)
  const maxSpan = LIGHT_STAGE_SPHERE_RADIUS * 2 * LIGHT_STAGE_MAX_SPHERE_OCCUPANCY
  const planeWidth = aspect >= 1 ? maxSpan : maxSpan * aspect
  const planeHeight = aspect >= 1 ? maxSpan / aspect : maxSpan
  const shortSide = Math.min(planeWidth, planeHeight)

  return {
    aspect,
    width: planeWidth,
    height: planeHeight,
    reliefDepth: Math.max(0.16, Math.min(0.36, shortSide * 0.085)),
    cssAspectRatio: `${Number(width) || 4} / ${Number(height) || 5}`,
  }
}

export function lightStageViewScale(viewMode: LightStageViewMode) {
  return viewMode === 'perspective'
    ? LIGHT_STAGE_PERSPECTIVE_CONTAINMENT_SCALE
    : LIGHT_STAGE_FRONT_CONTAINMENT_SCALE
}

export function lightStagePerspectiveDistance(viewportAspect: number) {
  const verticalFov = LIGHT_STAGE_PERSPECTIVE_FOV * Math.PI / 180
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(0.1, viewportAspect))
  const limitingFov = Math.min(verticalFov, horizontalFov)
  return LIGHT_STAGE_SPHERE_RADIUS / Math.sin(limitingFov / 2) * 1.06
}

export function lightStageOrthoHalfHeight(viewportAspect: number) {
  const safeAspect = Math.max(0.1, viewportAspect)
  const sphereHalfHeight = LIGHT_STAGE_SPHERE_RADIUS / 0.94
  const sphereHalfWidthAsHeight = LIGHT_STAGE_SPHERE_RADIUS / (0.94 * safeAspect)
  return Math.max(sphereHalfHeight, sphereHalfWidthAsHeight)
}
