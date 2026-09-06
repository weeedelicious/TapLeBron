/**
 * 一个节点「对外的那一张 / 那一条」是哪个 —— 也就是节点上大图显示的那个主图 / 主视频。
 *
 * 2026-08-25 用户报的问题：多图 / 多视频节点被下游当参考用时，在源节点上点「设为主图 /
 * 设为主视频」，下游的参考图 / 参考视频不跟着换。
 *
 * 根因是历史遗留的一句话在七八个地方各写了一遍：`srcNode.data.url?.[0]`。
 * `url[]` 是**生成顺序**，`_primaryAssetUrl` 才是用户选中的那个 —— 取 [0] 等于永远拿
 * 第一次生成的结果，跟节点上显示的、跟用户刚点的那次选择都不一致。
 *
 * 所以把这条规则收到一个函数里：谁要「上游现在对外的那个地址」都调它，
 * 以后再有第八个地方也不会跑偏。
 */

/** 只取实际用到的两个字段，这样 upload / video / image / panorama 各种节点都能传进来。 */
export interface PrimaryOutputSource {
  url?: unknown
  _primaryAssetUrl?: unknown
}

function usableUrls(data: PrimaryOutputSource | null | undefined): string[] {
  if (!Array.isArray(data?.url)) return []
  return (data.url as unknown[]).filter(
    (url): url is string => typeof url === 'string' && url.trim().length > 0,
  )
}

/**
 * 节点当前的主图 / 主视频地址；没有产物时返回空串。
 *
 * `_primaryAssetUrl` 必须**还在 url[] 里**才认 —— 删掉主图时 ImageNode / VideoNode 会
 * 顺手把它改掉，但插件写入、任务补收、老画布都可能留下一个指向已删产物的悬空值。
 * 悬空就退回第一个 —— 跟节点自己渲染大图时的判断（primaryGalleryItem）保持一致，
 * 不然下游会参考一张节点上根本看不到的图。
 *
 * 不做 trim：`_primaryAssetUrl` 存的就是 url[] 里的原值，比较必须逐字一致。
 * 也不用再单独挡空串 / 全空白的主图 —— usableUrls 已经把这种值从 urls 里筛掉了，
 * `urls.includes(primary)` 自然就不成立。
 */
export function primaryOutputUrl(data: PrimaryOutputSource | null | undefined): string {
  const urls = usableUrls(data)
  const primary = typeof data?._primaryAssetUrl === 'string' ? data._primaryAssetUrl : ''
  if (urls.includes(primary)) return primary
  return urls[0] ?? ''
}

/**
 * 解析一条引用的实际地址：优先跟着上游当前的主图 / 主视频，上游没了才退回引用里存的快照。
 *
 * 退回快照是有意的：上游节点被删掉之后参考图还能看见、生成也还能用，
 * 而不是整条引用凭空消失。
 *
 * 用 `||` 而不是 `??`：上游存在但还没有任何产物时 primaryOutputUrl 返回空串，
 * 那种情况也该退回快照，`??` 不会。
 */
export function liveRefUrl(
  data: PrimaryOutputSource | null | undefined,
  fallbackUrl?: unknown,
): string {
  return primaryOutputUrl(data) || (typeof fallbackUrl === 'string' ? fallbackUrl : '')
}
