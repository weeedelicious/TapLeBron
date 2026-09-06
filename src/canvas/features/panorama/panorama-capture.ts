export type PanoramaCaptureRatio =
  | 'source'
  | '1:1'
  | '9:16'
  | '16:9'
  | '3:4'
  | '4:3'
  | '3:2'
  | '2:3'
  | '5:4'
  | '4:5'
  | '21:9'

export type PanoramaCaptureResolution = '1K' | '2K' | '4K'

export interface PanoramaCaptureDimensions {
  width: number
  height: number
  aspectRatio: number
  ratio: PanoramaCaptureRatio
  resolution: PanoramaCaptureResolution
}

export const PANORAMA_CAPTURE_RATIO_OPTIONS: Array<{ value: PanoramaCaptureRatio; label: string }> = [
  { value: 'source', label: '原图比例' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '5:4', label: '5:4' },
  { value: '4:5', label: '4:5' },
  { value: '21:9', label: '21:9' },
]

export const PANORAMA_CAPTURE_RESOLUTION_OPTIONS: Array<{
  value: PanoramaCaptureResolution
  label: string
  edge: number
}> = [
  { value: '1K', label: '1K', edge: 1024 },
  { value: '2K', label: '2K', edge: 2048 },
  { value: '4K', label: '4K', edge: 3840 },
]

export const DEFAULT_PANORAMA_CAPTURE_RATIO: PanoramaCaptureRatio = '16:9'
export const DEFAULT_PANORAMA_CAPTURE_RESOLUTION: PanoramaCaptureResolution = '2K'

export function panoramaCaptureAspectRatio(
  ratio: PanoramaCaptureRatio,
  sourceWidth?: number,
  sourceHeight?: number,
) {
  if (ratio === 'source') {
    const width = Number(sourceWidth)
    const height = Number(sourceHeight)
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return width / height
    return 16 / 9
  }
  const [width, height] = ratio.split(':').map(Number)
  return width > 0 && height > 0 ? width / height : 16 / 9
}

export function panoramaCaptureDimensions(
  ratio: PanoramaCaptureRatio,
  resolution: PanoramaCaptureResolution,
  sourceWidth?: number,
  sourceHeight?: number,
): PanoramaCaptureDimensions {
  const aspectRatio = panoramaCaptureAspectRatio(ratio, sourceWidth, sourceHeight)
  const edge = PANORAMA_CAPTURE_RESOLUTION_OPTIONS.find((option) => option.value === resolution)?.edge ?? 2048
  const width = aspectRatio >= 1 ? edge : Math.max(16, Math.round(edge * aspectRatio))
  const height = aspectRatio >= 1 ? Math.max(16, Math.round(edge / aspectRatio)) : edge
  return { width, height, aspectRatio, ratio, resolution }
}

export function panoramaCaptureFileName(
  sourceName: string,
  yaw: number,
  pitch: number,
  ratio: PanoramaCaptureRatio,
  resolution: PanoramaCaptureResolution,
) {
  const base = String(sourceName || 'HDR全景').replace(/\.[a-z0-9]+$/i, '') || 'HDR全景'
  const safeBase = base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100)
  const yawLabel = Math.round(Number(yaw) || 0)
  const pitchLabel = Math.round(Number(pitch) || 0)
  const ratioLabel = ratio.replace(':', 'x')
  return `${safeBase}_机位_Y${yawLabel}_P${pitchLabel}_${ratioLabel}_${resolution}.png`
}
