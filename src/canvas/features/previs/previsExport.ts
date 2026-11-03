import type { CanvasNodeData, ResourceMeta } from '@/lib/types'
import { stageRenderPreviewFrame } from '@/features/director-stage/renderMerge'

export const PREVIS_EXPORT_GENERATOR = 'previs-export'

export function appendPrevisStill(
  data: CanvasNodeData,
  record: { url: string; width: number; height: number; createdAtMs: number; resourceMeta?: ResourceMeta },
): Partial<CanvasNodeData> {
  const url = record.url.trim()
  if (!url) return {}
  const existing = (Array.isArray(data.url) ? data.url : []).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  const nextUrls = existing.includes(url) ? existing : [...existing, url]
  const existingItems = (data._resourceMeta?.items ?? []).filter(Boolean)
  const items = record.resourceMeta
    ? [...existingItems.filter((item) => item.displayUrl !== url && item.originalUrl !== url), record.resourceMeta]
    : existingItems
  return {
    url: nextUrls,
    _primaryAssetUrl: url,
    _assetCreatedAtMs: { ...(data._assetCreatedAtMs ?? {}), [url]: record.createdAtMs },
    _assetGenerationMeta: {
      ...(data._assetGenerationMeta ?? {}),
      [url]: {
        model: '白模预演',
        resolution: `${Math.round(record.width)}×${Math.round(record.height)}`,
        createdAtMs: record.createdAtMs,
        outputIndex: nextUrls.indexOf(url),
      },
    },
    ...(items.length > 0 ? { _resourceMeta: { items } } : {}),
    _updatedAtMs: record.createdAtMs,
  }
}

export function previsImageNodeData(input: {
  sourceNodeId: string
  sourceName?: string
  url: string
  width: number
  height: number
  createdAtMs: number
  resourceMeta?: ResourceMeta
  baseImageParams: Record<string, unknown>
}) {
  const url = input.url.trim()
  const sourceRef = { nodeId: input.sourceNodeId, url, mediaType: 'image' as const }
  const frame = stageRenderPreviewFrame(input.width, input.height)
  return {
    name: `${input.sourceName || '白模预演'} 截图`,
    url: [url],
    action: 'image_resource',
    sourceKind: 'derived',
    generatorType: PREVIS_EXPORT_GENERATOR,
    contentWidth: frame.width,
    contentHeight: frame.height,
    ...(input.resourceMeta ? { _resourceMeta: { items: [input.resourceMeta] } } : {}),
    _primaryAssetUrl: url,
    _assetCreatedAtMs: { [url]: input.createdAtMs },
    _assetGenerationMeta: {
      [url]: {
        model: '白模预演',
        resolution: `${Math.round(input.width)}×${Math.round(input.height)}`,
        createdAtMs: input.createdAtMs,
        outputIndex: 0,
      },
    },
    _updatedAtMs: input.createdAtMs,
    params: {
      ...input.baseImageParams,
      prompt: '',
      modeType: 'image2image',
      imageList: [sourceRef],
      imageListOrder: [input.sourceNodeId],
      mixedList: [sourceRef],
      mixedListOrder: [input.sourceNodeId],
    },
  }
}

export function previsVideoNodeData(input: {
  sourceNodeId: string
  sourceName?: string
  url: string
  width: number
  height: number
  durationSec: number
  fps: number
  createdAtMs: number
  resourceMeta?: ResourceMeta
  baseVideoParams: Record<string, unknown>
}) {
  const url = input.url.trim()
  const sourceRef = { nodeId: input.sourceNodeId, url, mediaType: 'video' as const }
  const durationSec = Math.max(1, Math.round(Number(input.durationSec) || 1))
  return {
    name: `${input.sourceName || '白模预演'} 预演`,
    url: [url],
    action: 'video_generate',
    sourceKind: 'derived',
    generatorType: PREVIS_EXPORT_GENERATOR,
    ...(input.resourceMeta ? { _resourceMeta: { items: [input.resourceMeta] } } : {}),
    _primaryAssetUrl: url,
    _assetCreatedAtMs: { [url]: input.createdAtMs },
    _assetGenerationMeta: {
      [url]: {
        model: '白模预演',
        resolution: `${Math.round(input.width)}×${Math.round(input.height)}`,
        createdAtMs: input.createdAtMs,
        outputIndex: 0,
      },
    },
    _updatedAtMs: input.createdAtMs,
    params: {
      ...input.baseVideoParams,
      prompt: '',
      videoList: [sourceRef],
      mixedList: [sourceRef],
      mixedListOrder: [input.sourceNodeId],
      settings: {
        ...((input.baseVideoParams.settings ?? {}) as Record<string, unknown>),
        duration: durationSec,
      },
    },
  }
}
