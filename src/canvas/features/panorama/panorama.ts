import type { CanvasNodeData } from '@/lib/types'

export const PANORAMA_KIND = 'panorama-360x180' as const
export const PANORAMA_PROJECTION = 'equirectangular' as const

export interface PanoramaDerivation {
  version: 1
  kind: typeof PANORAMA_KIND
  projection: typeof PANORAMA_PROJECTION
  sourceNodeId: string
  sourceUrl: string
  sourceName?: string
  engine: string
  width?: number
  height?: number
  createdAtMs: number
}

function finitePositive(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

export function readPanoramaDerivation(data?: CanvasNodeData | null): PanoramaDerivation | null {
  const params = data?.params
  if (!params || typeof params !== 'object') return null
  const advanced = params.advancedSettings
  if (!advanced || typeof advanced !== 'object') return null
  const raw = (advanced as Record<string, unknown>).panorama
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.kind !== PANORAMA_KIND || value.projection !== PANORAMA_PROJECTION) return null
  const sourceNodeId = String(value.sourceNodeId || '').trim()
  const sourceUrl = String(value.sourceUrl || '').trim()
  const createdAtMs = finitePositive(value.createdAtMs)
  if (!sourceNodeId || !sourceUrl || !createdAtMs) return null
  return {
    version: 1,
    kind: PANORAMA_KIND,
    projection: PANORAMA_PROJECTION,
    sourceNodeId,
    sourceUrl,
    sourceName: typeof value.sourceName === 'string' ? value.sourceName : undefined,
    engine: String(value.engine || 'gemini-3-pro-image'),
    width: finitePositive(value.width),
    height: finitePositive(value.height),
    createdAtMs,
  }
}

export function isPanoramaNodeData(data?: CanvasNodeData | null) {
  return readPanoramaDerivation(data) !== null
}

export function normalizePanoramaYaw(value: number) {
  const safe = Number.isFinite(value) ? value : 0
  return ((safe + 180) % 360 + 360) % 360 - 180
}

export function clampPanoramaPitch(value: number) {
  const safe = Number.isFinite(value) ? value : 0
  return Math.max(-85, Math.min(85, safe))
}

export function clampPanoramaFov(value: number) {
  const safe = Number.isFinite(value) ? value : 72
  return Math.max(32, Math.min(105, safe))
}

export function isTwoToOnePanorama(width: number, height: number, tolerance = 0.015) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  return Math.abs(width / height - 2) <= Math.max(0, tolerance)
}
