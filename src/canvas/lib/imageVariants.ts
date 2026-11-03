import type { CanvasNodeData, ImageVariants } from './types'

/**
 * 新图片的派生图（短边 360 的节点图、短边 1080 的查看图）由服务端在上传 / 生成时生成，
 * 地址按原图地址存进节点的 `_assetImageVariants`，随画布一起保存。
 *
 * 上传、导入、粘贴、各种工具产物都是"先传文件、再建或改节点"，调用点有二十多处。
 * 与其每处都手写一遍，这里在接口层把服务端返回的派生图按原图地址登记下来，
 * 画布 store 新建 / 更新节点时（addNodeAt、updateNodeData）发现节点用到了登记过的
 * 原图，就自动把记录写进节点。生成结果走 tasksStore，从任务 outputs 里显式合并。
 */

const MAX_REGISTERED = 500
const registered = new Map<string, ImageVariants>()

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function positiveNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** 从服务端返回的上传结果 / 任务 output / 资源信息里取出派生图记录；没有 previewUrl 时返回 null。 */
export function imageVariantsFrom(source: unknown): ImageVariants | null {
  if (!source || typeof source !== 'object') return null
  const record = source as Record<string, unknown>
  const meta = (record.meta && typeof record.meta === 'object' ? record.meta : {}) as Record<string, unknown>
  const previewUrl = stringValue(record.previewUrl) || stringValue(meta.previewUrl)
  if (!previewUrl) return null
  const variants: ImageVariants = { previewUrl }
  const viewerUrl = stringValue(record.viewerUrl) || stringValue(meta.viewerUrl)
  if (viewerUrl) variants.viewerUrl = viewerUrl
  const width = positiveNumber(record.width) ?? positiveNumber(meta.width)
  const height = positiveNumber(record.height) ?? positiveNumber(meta.height)
  if (width && height) {
    variants.width = width
    variants.height = height
  }
  return variants
}

/** 登记一张原图的派生图。上传结果直接传进来即可（url + previewUrl / viewerUrl / meta）。 */
export function registerImageVariants(originalUrl: unknown, source: unknown) {
  const url = stringValue(originalUrl)
  const variants = imageVariantsFrom(source)
  if (!url || !variants) return
  registered.delete(url)
  registered.set(url, variants)
  while (registered.size > MAX_REGISTERED) {
    const oldest = registered.keys().next().value
    if (oldest === undefined) break
    registered.delete(oldest)
  }
}

export function registeredImageVariants(url: string) {
  return registered.get(url)
}

/**
 * 节点数据补丁里有 url 列表时，把其中登记过的原图的派生图并进 `_assetImageVariants`。
 * 节点上已有的记录不覆盖；没有可补的就原样返回 patch。
 */
export function withRegisteredImageVariants<T extends Partial<CanvasNodeData>>(
  current: Partial<CanvasNodeData> | undefined,
  patch: T,
): T {
  if (!registered.size || !Array.isArray(patch.url) || !patch.url.length) return patch
  const existing = patch._assetImageVariants ?? current?._assetImageVariants
  let next: Record<string, ImageVariants> | null = null
  for (const raw of patch.url) {
    const url = stringValue(raw)
    if (!url || existing?.[url] || next?.[url]) continue
    const variants = registered.get(url)
    if (!variants) continue
    next = next ?? { ...(existing ?? {}) }
    next[url] = variants
  }
  return next ? { ...patch, _assetImageVariants: next } : patch
}

/**
 * 把一批生成结果的派生图并进节点已有的记录。outputs 里没有派生图时原样返回 current，
 * 不给旧节点平白加字段。
 */
export function mergeImageVariantsFromOutputs(
  current: Record<string, ImageVariants> | undefined,
  urls: string[],
  outputs: unknown,
) {
  const list = Array.isArray(outputs) ? outputs as Array<Record<string, unknown>> : []
  let next: Record<string, ImageVariants> | null = null
  for (const [index, url] of urls.entries()) {
    if (!url) continue
    const output = list.find((item) => item && (item.url === url || Number(item.index) === index))
    const variants = imageVariantsFrom(output)
    if (!variants) continue
    next = next ?? { ...(current ?? {}) }
    next[url] = variants
  }
  return next ?? current
}
