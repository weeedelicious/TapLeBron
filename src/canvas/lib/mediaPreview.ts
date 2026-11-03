import type { CanvasNodeData, ImageVariants, ResourceMeta } from './types'

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : ''
}

function positiveNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/**
 * 这个地址对应的资源信息。只认地址对得上的那条；只有节点只有一条资源信息、它又没记
 * 原图地址（旧数据）时才把它当成这张图的。以前对不上就拿第一条兜底，多图节点里别的图
 * 会被换成第一张图的预览图。
 */
function resourceMetaForUrl(data: CanvasNodeData, url: string) {
  const items = (data._resourceMeta?.items ?? []) as ResourceMeta[]
  const matched = items.find((item) => item?.originalUrl === url || item?.displayUrl === url)
  if (matched) return matched
  const urls = data.url ?? []
  if (items.length === 1 && !items[0]?.originalUrl && urls.length <= 1) return items[0]
  return undefined
}

/** 新图片的派生图记录：先看节点的 `_assetImageVariants`，再看对应资源信息里的 previewUrl。 */
export function imageVariantsForUrl(data: CanvasNodeData, url: string | undefined): ImageVariants | null {
  const originalUrl = stringValue(url)
  if (!originalUrl) return null
  const mapped = data._assetImageVariants?.[originalUrl]
  if (mapped && stringValue(mapped.previewUrl)) return mapped
  const meta = resourceMetaForUrl(data, originalUrl)
  const previewUrl = stringValue(meta?.previewUrl)
  if (!previewUrl) return null
  return {
    previewUrl,
    viewerUrl: stringValue(meta?.viewerUrl) || undefined,
    width: positiveNumber(meta?.width),
    height: positiveNumber(meta?.height),
  }
}

/** Returns a lightweight canvas preview while keeping the passed URL as the operation source. */
export function mediaPreviewUrl(data: CanvasNodeData, url: string | undefined, index?: number) {
  const originalUrl = stringValue(url)
  if (!originalUrl) return ''

  const variants = imageVariantsForUrl(data, originalUrl)
  if (variants) return variants.previewUrl

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

/**
 * 全屏查看用的图：新图片且原图短边大于 1080 时是 1080 的查看图，其余（含旧图片）都是原图。
 * 下载、复制、放大镜仍然用原图地址，不走这里。
 */
export function mediaViewerUrl(data: CanvasNodeData, url: string | undefined) {
  const originalUrl = stringValue(url)
  if (!originalUrl) return ''
  return imageVariantsForUrl(data, originalUrl)?.viewerUrl || originalUrl
}

/**
 * 节点里那张 <img> 加载完时报的是派生图的像素，节点标题的尺寸、高清增强的输出尺寸
 * 都要原图尺寸。有派生图记录且记了原图宽高时用记录的，否则用实际加载到的。
 */
export function mediaPixelSize(data: CanvasNodeData, url: string | undefined, naturalWidth: number, naturalHeight: number) {
  const variants = imageVariantsForUrl(data, url)
  if (variants?.width && variants.height) return { w: variants.width, h: variants.height }
  return { w: naturalWidth, h: naturalHeight }
}
