import type { CanvasNodeData, ResourceMeta } from './types'

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : ''
}

function resourceMetaForUrl(data: CanvasNodeData, url: string) {
  const items = (data._resourceMeta?.items ?? []) as ResourceMeta[]
  return items.find((item) => item?.originalUrl === url || item?.displayUrl === url) ?? items[0]
}

/** Returns a lightweight canvas preview while keeping the passed URL as the operation source. */
export function mediaPreviewUrl(data: CanvasNodeData, url: string | undefined, index?: number) {
  const originalUrl = stringValue(url)
  if (!originalUrl) return ''

  const mappedUrl = stringValue(data._assetPreviewUrls?.[originalUrl])
  if (mappedUrl) return mappedUrl

  const params = (data.params ?? {}) as Record<string, unknown>
  const thumbUrls = Array.isArray(params.thumbUrls) ? params.thumbUrls : []
  const resolvedIndex = index ?? Math.max(0, (data.url ?? []).indexOf(originalUrl))
  const thumbUrl = stringValue(thumbUrls[resolvedIndex])
  if (thumbUrl) return thumbUrl

  const meta = resourceMetaForUrl(data, originalUrl)
  const displayUrl = stringValue(meta?.displayUrl)
  if (displayUrl) return displayUrl

  return originalUrl
}
