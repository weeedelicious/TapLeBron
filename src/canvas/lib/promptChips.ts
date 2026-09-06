type PromptChipLike = {
  nodeId?: string | null
  url?: string | null
  name?: string | null
  mediaType?: string | null
}

export type PromptChipRefKey = {
  nodeId?: string | null
  url?: string | null
}

export function promptChipMatchesRef(chip: PromptChipLike, refs: PromptChipRefKey[]) {
  return refs.some(ref => {
    const nodeMatches = ref.nodeId && chip.nodeId === ref.nodeId
    const urlMatches = ref.url && chip.url === ref.url
    return Boolean(nodeMatches || urlMatches)
  })
}

export function missingChipPreviewHtml() {
  return (
    `<span data-chip-preview="1" data-chip-missing="1" style="width:16px;height:16px;` +
    `display:inline-flex;align-items:center;justify-content:center;overflow:hidden;border-radius:2px;` +
    `background:#211b2f;border:1px solid #4a405c;color:#8a7aa8;font-size:11px;line-height:1;flex-shrink:0;">` +
    `?</span>`
  )
}

export function markPromptChipRefsMissingInHtml(html: unknown, refs: PromptChipRefKey[]) {
  if (typeof html !== 'string' || refs.length === 0 || !html.includes('data-chip')) return html
  if (typeof document === 'undefined') return html
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll<HTMLElement>('[data-chip="1"]').forEach(chip => {
    if (!promptChipMatchesRef({
      nodeId: chip.dataset.nodeid,
      url: chip.dataset.url,
      name: chip.dataset.name,
      mediaType: chip.dataset.mediaType,
    }, refs)) return
    chip.dataset.url = ''
    chip.dataset.missing = '1'
    const tmp = document.createElement('span')
    tmp.innerHTML = missingChipPreviewHtml()
    const preview = chip.querySelector('[data-chip-preview="1"]')
    const replacement = tmp.firstElementChild
    if (preview && replacement) preview.replaceWith(replacement)
  })
  return template.innerHTML
}

/**
 * nodeId → 该上游节点现在的主图 / 主视频地址。
 * 由节点侧从已经解析好的引用列表构造，所以这里全是纯字符串 / DOM 操作，可单测。
 */
export type PromptChipLiveUrls = Record<string, string>

/**
 * 把提示词 HTML 里 chip 存的地址换成上游当前的主图 / 主视频。
 *
 * 为什么 chip 也得跟着换：服务端算参考素材时是
 * `[...imageList, ...promptChips].map(item => item.url)` 取并集的。
 * 只换 imageList 不换 chip，等于把**新旧两张图**一起当参考发出去 —— 比不换更糟。
 *
 * 地址不光在 data-url 上，chip 里那个 16px 小预览的 src 也是写死的，两处都要改，
 * 不然药丸指向新图、显示的还是旧图。
 *
 * 没有任何改动时**原样返回入参那个字符串**（不重新序列化）：
 * 编辑器是靠 `el.innerHTML === nextHtml` 判断要不要重新注入的，
 * 每次都吐一份重新序列化的 HTML 会让它反复重建 DOM、把光标顶掉。
 */
export function refreshPromptChipUrlsInHtml(html: unknown, live: PromptChipLiveUrls) {
  if (typeof html !== 'string' || !html.includes('data-chip')) return html
  if (Object.keys(live).length === 0) return html
  if (typeof document === 'undefined') return html
  const template = document.createElement('template')
  template.innerHTML = html
  let changed = false
  template.content.querySelectorAll<HTMLElement>('[data-chip="1"]').forEach(chip => {
    const nodeId = chip.dataset.nodeid
    if (!nodeId) return
    const nextUrl = live[nodeId]
    if (!nextUrl || chip.dataset.url === nextUrl) return
    // 已经标成「引用没了」的药丸不复活：live 只包含当前还连着的引用，
    // 所以能走到这里说明这个 nodeId 确实还连着，missing 标记是过期的，一并清掉。
    chip.dataset.url = nextUrl
    delete chip.dataset.missing
    const preview = chip.querySelector<HTMLElement>('[data-chip-preview="1"]')
    // 图片是 <img src>、视频是 <span> 里包一个 <video src>、音频只有一个 ♪ 没有地址。
    const media = preview instanceof HTMLImageElement
      ? preview
      : preview?.querySelector<HTMLElement>('img, video') ?? null
    if (media instanceof HTMLImageElement || media instanceof HTMLVideoElement) {
      media.setAttribute('src', nextUrl)
    }
    changed = true
  })
  return changed ? template.innerHTML : html
}

/**
 * params 层的同一件事：promptChips 和 promptHtml 两份都换。
 * 没有改动时原样返回入参对象，调用方可以直接用 `!==` 判断要不要落库。
 */
export function refreshPromptChipUrlsInParams<T extends { promptChips?: unknown; promptHtml?: unknown }>(
  params: T,
  live: PromptChipLiveUrls,
): T {
  if (Object.keys(live).length === 0) return params
  let changed = false
  const promptChips = Array.isArray(params.promptChips)
    ? params.promptChips.map(chip => {
      const entry = chip as PromptChipLike
      const nodeId = typeof entry?.nodeId === 'string' ? entry.nodeId : ''
      const nextUrl = nodeId ? live[nodeId] : ''
      if (!nextUrl || entry.url === nextUrl) return chip
      changed = true
      const next: Record<string, unknown> = { ...(chip as Record<string, unknown>), url: nextUrl }
      delete next.missing
      return next
    })
    : params.promptChips
  const promptHtml = refreshPromptChipUrlsInHtml(params.promptHtml, live)
  if (!changed && promptHtml === params.promptHtml) return params
  return { ...params, promptChips, promptHtml }
}

export function markPromptChipRefsMissingInParams<T extends { promptChips?: unknown; promptHtml?: unknown }>(
  params: T,
  refs: PromptChipRefKey[],
): T {
  if (refs.length === 0) return params
  const promptChips = Array.isArray(params.promptChips)
    ? params.promptChips.map(chip => {
      if (!promptChipMatchesRef(chip as PromptChipLike, refs)) return chip
      return { ...(chip as Record<string, unknown>), url: '', missing: true }
    })
    : params.promptChips
  return {
    ...params,
    promptChips,
    promptHtml: markPromptChipRefsMissingInHtml(params.promptHtml, refs),
  }
}
