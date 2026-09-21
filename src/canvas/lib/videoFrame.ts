/**
 * Video frame stepping helpers.
 *
 * HTMLVideoElement exposes the current time, but not the source frame rate.
 * Shotflow therefore supplies the rate from persisted ffprobe/generation
 * metadata and falls back to 30fps only when an older asset has no metadata.
 */

export const DEFAULT_VIDEO_FPS = 30
const MAX_REASONABLE_VIDEO_FPS = 1000

/** Parse a number or an ffprobe-style rational such as "24000/1001". */
export function parseVideoFps(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    const rational = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)$/)
    if (rational) {
      const numerator = Number(rational[1])
      const denominator = Number(rational[2])
      const parsed = denominator > 0 ? numerator / denominator : Number.NaN
      return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_REASONABLE_VIDEO_FPS
        ? parsed
        : undefined
    }
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_REASONABLE_VIDEO_FPS
    ? parsed
    : undefined
}

/** Return the first valid fps value, or the compatibility fallback. */
export function resolveVideoFps(...values: unknown[]): number {
  for (const value of values) {
    const parsed = parseVideoFps(value)
    if (parsed !== undefined) return parsed
  }
  return DEFAULT_VIDEO_FPS
}

export function frameStepSecondsForFps(fps?: unknown): number {
  return 1 / resolveVideoFps(fps)
}

/** Convert a presentation timestamp to a one-based frame number. */
export function frameNumberFromTime(timeSec: unknown, fps?: unknown): number {
  const safeTime = Number(timeSec)
  const time = Number.isFinite(safeTime) && safeTime > 0 ? safeTime : 0
  const frameRate = resolveVideoFps(fps)
  // The epsilon avoids showing the preceding frame when a browser rounds a
  // timestamp such as 1/24 down to 0.041666666666666664.
  return Math.max(1, Math.floor(time * frameRate + 1e-6) + 1)
}

/**
 * Seek to an adjacent frame without accumulating floating-point drift.
 * `durationSec` is optional because metadata may not be ready on first use.
 */
export function nextVideoFrameTime(
  timeSec: unknown,
  direction: -1 | 1,
  fps?: unknown,
  durationSec?: unknown,
): number {
  const frameRate = resolveVideoFps(fps)
  const safeTime = Number(timeSec)
  const time = Number.isFinite(safeTime) && safeTime > 0 ? safeTime : 0
  const currentFrameIndex = Math.max(0, Math.round(time * frameRate))
  let nextFrameIndex = Math.max(0, currentFrameIndex + (direction < 0 ? -1 : 1))

  const duration = Number(durationSec)
  if (Number.isFinite(duration) && duration > 0) {
    // A duration of exactly N seconds contains frame indices 0..N*fps-1.
    const maxFrameIndex = Math.max(0, Math.ceil(duration * frameRate - 1e-6) - 1)
    nextFrameIndex = Math.min(nextFrameIndex, maxFrameIndex)
  }

  return nextFrameIndex / frameRate
}

export function formatVideoFps(...values: unknown[]): string {
  const fps = values.map(parseVideoFps).find((value): value is number => value !== undefined)
  if (fps === undefined) return '—'
  const rounded = Math.round(fps * 1000) / 1000
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `${text} fps`
}
