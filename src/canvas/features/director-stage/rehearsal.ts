/**
 * 白模预演台：把起止机位插成一段运镜。
 *
 * 纯函数，jsdom 里也能测。真正录视频在 rehearsalEncode / Three 里，
 * 这里只负责「这一帧相机在哪」—— 错了画面就看起来没动。
 */
import { captureSize, clampOrbitDistance, clampPitchDeg, normalizeYawDeg } from './cameraMath'
import {
  DEFAULT_DIRECTOR_REHEARSAL_DURATION_SEC,
  DIRECTOR_REHEARSAL_DURATION_OPTIONS,
  normalizeCamera,
  normalizeRehearsalDurationSec as normalizeDurationFromState,
  type StageCamera,
} from './types'

export const REHEARSAL_DURATION_OPTIONS = DIRECTOR_REHEARSAL_DURATION_OPTIONS
export const DEFAULT_REHEARSAL_DURATION_SEC = DEFAULT_DIRECTOR_REHEARSAL_DURATION_SEC
export const REHEARSAL_FPS = 24
/** 参考视频短边。720P 对 Seedance 2.0/2.5 都在像素上下限里。 */
export const REHEARSAL_SHORT_EDGE = 720

export function normalizeRehearsalDurationSec(value: unknown) {
  return normalizeDurationFromState(value)
}

export function easeInOutCubic(t: number) {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

/** yaw 走最短弧，350° → 10° 是右转 20°，不是倒转一圈。 */
export function lerpYawDeg(from: number, to: number, t: number) {
  const start = normalizeYawDeg(from)
  let delta = normalizeYawDeg(to) - start
  if (delta > 180) delta -= 360
  if (delta < -180) delta += 360
  return normalizeYawDeg(start + delta * t)
}

export function interpolateCamera(start: StageCamera, end: StageCamera, t: number): StageCamera {
  const e = easeInOutCubic(t)
  const from = normalizeCamera(start)
  const to = normalizeCamera(end)
  return normalizeCamera({
    yaw: lerpYawDeg(from.yaw, to.yaw, e),
    pitch: lerp(from.pitch, to.pitch, e),
    distance: lerp(from.distance, to.distance, e),
    target: [
      lerp(from.target[0], to.target[0], e),
      lerp(from.target[1], to.target[1], e),
      lerp(from.target[2], to.target[2], e),
    ],
    focalMm: lerp(from.focalMm, to.focalMm, e),
  })
}

export function rehearsalFrameCount(durationSec: unknown, fps = REHEARSAL_FPS) {
  const duration = normalizeRehearsalDurationSec(durationSec)
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : REHEARSAL_FPS
  return Math.max(2, Math.round(duration * safeFps) + 1)
}

export function rehearsalCameras(start: StageCamera, end: StageCamera, durationSec: unknown, fps = REHEARSAL_FPS) {
  const count = rehearsalFrameCount(durationSec, fps)
  const cameras: StageCamera[] = []
  for (let i = 0; i < count; i += 1) {
    cameras.push(interpolateCamera(start, end, count === 1 ? 1 : i / (count - 1)))
  }
  return cameras
}

export function rehearsalVideoSize(ratio: string) {
  const size = captureSize(ratio, REHEARSAL_SHORT_EDGE)
  return {
    width: Math.max(16, Math.round(size.width / 2) * 2),
    height: Math.max(16, Math.round(size.height / 2) * 2),
    aspect: size.aspect,
  }
}

export function camerasLookSame(a: StageCamera | null | undefined, b: StageCamera | null | undefined) {
  if (!a || !b) return false
  const left = normalizeCamera(a)
  const right = normalizeCamera(b)
  return (
    Math.abs(left.yaw - right.yaw) < 0.2 &&
    Math.abs(left.pitch - right.pitch) < 0.2 &&
    Math.abs(left.distance - right.distance) < 0.01 &&
    Math.abs(left.focalMm - right.focalMm) < 0.2 &&
    Math.abs(left.target[0] - right.target[0]) < 0.01 &&
    Math.abs(left.target[1] - right.target[1]) < 0.01 &&
    Math.abs(left.target[2] - right.target[2]) < 0.01
  )
}

export function orbitYawCamera(camera: StageCamera, deltaDeg: number): StageCamera {
  const current = normalizeCamera(camera)
  return normalizeCamera({ ...current, yaw: current.yaw + deltaDeg })
}

export function dollyCamera(camera: StageCamera, factor: number): StageCamera {
  const current = normalizeCamera(camera)
  return normalizeCamera({
    ...current,
    distance: clampOrbitDistance(current.distance * factor),
  })
}

export function riseCamera(camera: StageCamera, pitchDelta: number, targetDelta = 0): StageCamera {
  const current = normalizeCamera(camera)
  return normalizeCamera({
    ...current,
    pitch: clampPitchDeg(current.pitch + pitchDelta),
    target: [current.target[0], current.target[1] + targetDelta, current.target[2]],
  })
}

export function rehearsalHasMotion(start: StageCamera | null | undefined, end: StageCamera | null | undefined) {
  if (!start || !end) return false
  return !camerasLookSame(start, end)
}
