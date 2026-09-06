import type { CanvasNodeData, ResourceMeta } from './types'

export type AssetCreatedAtMap = Record<string, number>

export function normalizeAssetTimestamp(value: unknown) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined
}

export function assetUrlCandidates(url: string, meta?: ResourceMeta) {
  return Array.from(new Set([
    url,
    meta?.originalUrl,
    meta?.displayUrl,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0)))
}

export function mergeAssetCreatedAtMap(
  current: AssetCreatedAtMap | undefined,
  urls: Array<string | undefined | null>,
  timestamp: unknown = Date.now()
) {
  const normalized = normalizeAssetTimestamp(timestamp) ?? Date.now()
  const next: AssetCreatedAtMap = { ...(current ?? {}) }
  urls
    .filter((url): url is string => typeof url === 'string' && url.length > 0)
    .forEach((url) => {
      next[url] = normalized
    })
  return next
}

export function assetCreatedAtFromNodeData(
  data: CanvasNodeData,
  url: string,
  meta?: ResourceMeta,
  externalAssetTimes?: AssetCreatedAtMap
) {
  const candidates = assetUrlCandidates(url, meta)
  const localMap = data._assetCreatedAtMs ?? {}
  for (const candidate of candidates) {
    const localTime = normalizeAssetTimestamp(localMap[candidate])
    if (localTime) return localTime
  }

  const metaTime = normalizeAssetTimestamp(meta?.createdAtMs)
  if (metaTime) return metaTime

  for (const candidate of candidates) {
    const externalTime = normalizeAssetTimestamp(externalAssetTimes?.[candidate])
    if (externalTime) return externalTime
  }

  return undefined
}

export function assetHistoryTimestamp(
  data: CanvasNodeData,
  url: string,
  meta: ResourceMeta | undefined,
  externalAssetTimes: AssetCreatedAtMap | undefined,
  fallback?: unknown
) {
  return assetCreatedAtFromNodeData(data, url, meta, externalAssetTimes) ??
    normalizeAssetTimestamp(fallback) ??
    Date.now()
}
