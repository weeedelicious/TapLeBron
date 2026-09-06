import type { CanvasNode } from '../../shared/types/canvas'
import type { AppearanceFinalizerBackendId } from './appearance-transfer-backends'
import type { AppearanceResolution } from './appearance-transfer-types'

export type AppearanceResolutionPlanV1 = {
  schemaVersion: 1
  requested: AppearanceResolution
  sourceWidth: number
  sourceHeight: number
  sourceAspectRatio: number
  targetWidth: number
  targetHeight: number
  targetLongEdge: number
  alignment: 1 | 16
  providerRatio: 'auto'
}

function positiveDimension(value: number | null | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.round(Number(value)) : fallback
}

export function createAppearanceResolutionPlan(
  source: Pick<CanvasNode, 'imageWidth' | 'imageHeight'>,
  requested: AppearanceResolution,
): AppearanceResolutionPlanV1 {
  const sourceWidth = positiveDimension(source.imageWidth, 1024)
  const sourceHeight = positiveDimension(source.imageHeight, 1024)
  const sourceAspectRatio = sourceWidth / sourceHeight

  return {
    schemaVersion: 1,
    requested,
    sourceWidth,
    sourceHeight,
    sourceAspectRatio,
    targetWidth: sourceWidth,
    targetHeight: sourceHeight,
    targetLongEdge: Math.max(sourceWidth, sourceHeight),
    alignment: 1,
    providerRatio: 'auto',
  }
}

export function isAppearanceOutputSizeValid(
  plan: AppearanceResolutionPlanV1,
  width: number | null | undefined,
  height: number | null | undefined,
) {
  if (!width || !height || width <= 0 || height <= 0) return false
  return Math.round(width) === plan.targetWidth && Math.round(height) === plan.targetHeight
}

export function isAppearanceOutputAspectValid(
  plan: AppearanceResolutionPlanV1,
  width: number | null | undefined,
  height: number | null | undefined,
) {
  if (!width || !height || width <= 0 || height <= 0) return false
  const targetAspectRatio = plan.sourceWidth / plan.sourceHeight
  const aspectDelta = Math.abs(width / height - targetAspectRatio) / targetAspectRatio
  return aspectDelta <= 0.035
}

function originalQualityByLongEdge(
  longEdge: number,
  thresholds: Array<[maximum: number, quality: string]>,
  fallback: string,
) {
  return thresholds.find(([maximum]) => longEdge <= maximum)?.[1] ?? fallback
}

export function resolveAppearanceProviderQuality(
  backendId: AppearanceFinalizerBackendId,
  plan: AppearanceResolutionPlanV1,
) {
  if (backendId === 'gpt-image-2') {
    if (plan.requested === 'original') {
      return originalQualityByLongEdge(
        plan.targetLongEdge,
        [
          [1024, 'gpt-1k'],
          [1536, 'gpt-1-5k'],
          [2048, 'gpt-2k'],
        ],
        'gpt-3k',
      )
    }
    return plan.requested === '4K'
      ? 'gpt-3k'
      : plan.requested === '2K'
        ? 'gpt-2k'
        : 'gpt-1k'
  }

  if (backendId === 'flux-2-klein-4b-fp8') {
    if (plan.requested === 'original') {
      return plan.targetLongEdge <= 1024 ? '1k' : '2k'
    }
    return plan.requested === '1K' ? '1k' : '2k'
  }

  if (plan.requested === 'original') {
    return originalQualityByLongEdge(
      plan.targetLongEdge,
      [
        [1024, '1k'],
        [2048, '2k'],
      ],
      '4k',
    )
  }
  return plan.requested.toLowerCase()
}
