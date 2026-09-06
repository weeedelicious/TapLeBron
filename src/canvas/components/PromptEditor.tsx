/**
 * Rich-text prompt editor: plain text + inline image chips.
 * Chips are <span contentEditable="false"> elements inserted at cursor.
 */
import { useRef, useEffect, useCallback, useImperativeHandle, forwardRef, useState } from 'react'
import { ImagePreview } from './ImagePreview'
import { HoverImagePreview } from './HoverImagePreview'
import { missingChipPreviewHtml } from '@/lib/promptChips'
import { plainTextFromClipboard, sanitizePromptHtml } from '@/lib/promptHtml'
import { clipboardLabelFromChipName } from '@/lib/promptTokenMention'
import { useCanvasStore } from '@/store/canvasStore'

export interface ChipRef {
  nodeId: string
  url: string
  name: string
  mediaType?: 'image' | 'video' | 'audio'
}

export interface PromptEditorSnapshot {
  text: string
  chips: ChipRef[]
  html: string
}

export interface PromptEditorHandle {
  insertChip: (ref: ChipRef) => void
  setPlainText: (text: string) => void
  markChipsMissing: (refs: { nodeId?: string | null; url?: string | null }[]) => void
  /** 整段扫一遍，把能对上引用的 image1 都换成 chip（失焦时自动跑，也可手动调） */
  convertTextMentions: () => void
}

interface Props {
  value: string
  chips: ChipRef[]
  onValueChange?: (text: string) => void
  onChipsChange?: (chips: ChipRef[]) => void
  onChange?: (snapshot: PromptEditorSnapshot) => void
  onAtKey: () => void
  onEscape: () => void
  mentionMenuOpen?: boolean
  onMentionNavigate?: (direction: 'up' | 'down') => void
  onMentionSelect?: () => void
  placeholder?: string
  style?: React.CSSProperties
  /** Stored innerHTML snapshot — restores chip positions exactly on remount */
  htmlSnapshot?: string
  /** Called after every edit with the current innerHTML */
  onHtmlChange?: (html: string) => void
  /** nodeId → display name，当黄框顺序变化时传入新映射，自动更新 chip 显示名 */
  orderMap?: Record<string, string>
  /**
   * 手写 `image1` 自动转成 @引用。传入光标前的那段文字，返回要替换成哪个 chip；
   * 返回 null 就什么都不做（文字原样留着）。判断逻辑在 lib/promptTokenMention 里，
   * 由节点侧带上自己的引用清单调用 —— 编辑器本身不知道「图片1」是谁。
   */
  resolveTextMention?: (textBeforeCaret: string) => { chip: ChipRef; removeCount: number; tail: string } | null
  /**
   * 整段扫描版：给一段文字，返回其中所有能对上引用的 token（**倒序**，方便逐个替换）。
   * 失焦时跑一次，用来兜住「在中间插入、没敲尾随字符」和粘贴进来的提示词。
   */
  resolveTextMentionsIn?: (text: string) => Array<{ start: number; length: number; chip: ChipRef }>
}

function inferChipMediaType(ref: Pick<ChipRef, 'url' | 'name' | 'mediaType'>): 'image' | 'video' | 'audio' {
  if (ref.mediaType === 'video' || ref.mediaType === 'audio' || ref.mediaType === 'image') return ref.mediaType
  const url = String(ref.url || '')
  const name = String(ref.name || '')
  if (/^视频\d*$/i.test(name) || /\.(mp4|mov|webm|m4v)(?:[?#].*)?$/i.test(url)) return 'video'
  if (/^音频\d*$/i.test(name) || /\.(mp3|wav|m4a|aac|ogg)(?:[?#].*)?$/i.test(url)) return 'audio'
  return 'image'
}

function buildChipPreviewHtml(ref: ChipRef) {
  const mediaType = inferChipMediaType(ref)
  if (mediaType === 'video') {
    return (
      `<span data-chip-preview="1" style="width:16px;height:16px;position:relative;` +
      `display:inline-block;overflow:hidden;border-radius:2px;background:#1b1430;flex-shrink:0;">` +
      `<video src="${ref.url}" muted playsinline preload="metadata" draggable="false" ` +
      `style="width:100%;height:100%;object-fit:cover;display:block;"></video>` +
      `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;` +
      `font-size:9px;color:#efeaff;background:linear-gradient(180deg,rgba(10,6,18,0.02),rgba(10,6,18,0.28));">▻</span>` +
      `</span>`
    )
  }
  if (mediaType === 'audio') {
    return (
      `<span data-chip-preview="1" style="width:16px;height:16px;display:inline-flex;align-items:center;` +
      `justify-content:center;border-radius:2px;background:#1b1430;color:#efeaff;font-size:10px;flex-shrink:0;">♪</span>`
    )
  }
  return (
    `<img src="${ref.url}" draggable="false" data-chip-preview="1" ` +
    `style="width:16px;height:16px;object-fit:cover;border-radius:2px;flex-shrink:0;" />`
  )
}

function upgradeChipPreviewElements(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-chip="1"]').forEach(chip => {
    const ref: ChipRef = {
      nodeId: chip.dataset.nodeid ?? '',
      url: chip.dataset.url ?? '',
      name: chip.dataset.name ?? '',
      mediaType: chip.dataset.mediaType as ChipRef['mediaType'],
    }
    const mediaType = inferChipMediaType(ref)
    chip.dataset.mediaType = mediaType
    const preview = chip.querySelector<HTMLElement>('[data-chip-preview="1"]')
    if (mediaType !== 'video' || preview?.tagName === 'SPAN') return
    const tmp = document.createElement('span')
    tmp.innerHTML = buildChipPreviewHtml({ ...ref, mediaType })
    const nextPreview = tmp.firstElementChild
    if (nextPreview && preview) preview.replaceWith(nextPreview)
  })
}

function buildChipHtml(ref: ChipRef) {
  const short = ref.name.length > 6 ? ref.name.slice(0, 6) + '…' : ref.name
  return (
    `<span contenteditable="false" data-chip="1" ` +
    `data-nodeid="${ref.nodeId}" data-url="${ref.url}" data-name="${ref.name}" data-media-type="${inferChipMediaType(ref)}" ` +
    `style="display:inline-flex;align-items:center;gap:3px;max-width:calc(100% - 8px);background:#251e38;` +
    `border:1px solid #312550;border-radius:4px;padding:1px 5px 1px 3px;` +
    `margin:0 2px;vertical-align:middle;user-select:none;cursor:pointer;box-sizing:border-box;">` +
    buildChipPreviewHtml(ref) +
    `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#c4b5fd;">${short}</span>` +
    `<span data-del="1" style="font-size:11px;color:#5a5070;cursor:pointer;padding:0 2px;">×</span>` +
    `</span>`
  )
}

function buildEditorHtml(value: string, chips: ChipRef[]) {
  if (typeof document === 'undefined') return ''
  const wrapper = document.createElement('div')
  if (value) wrapper.appendChild(document.createTextNode(value))
  for (const chip of chips) {
    const tmp = document.createElement('span')
    tmp.innerHTML = buildChipHtml(chip)
    const chipNode = tmp.firstChild
    if (chipNode) {
      wrapper.appendChild(chipNode)
      wrapper.appendChild(document.createTextNode('​'))
    }
  }
  return wrapper.innerHTML
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'BR', 'LI', 'H1', 'H2', 'H3'])

function canPreviewImage(url: string) {
  const value = String(url || '').trim()
  return (
    /^data:image\//i.test(value) ||
    /^blob:/i.test(value) ||
    /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i.test(value)
  )
}

function canPreviewVideo(url: string, mediaType?: string) {
  if (mediaType === 'video') return true
  const value = String(url || '').trim()
  return /\.(mp4|mov|webm|m4v)(?:[?#].*)?$/i.test(value)
}

function extractContent(el: HTMLElement): { text: string; chips: ChipRef[] } {
  const chips: ChipRef[] = []
  let text = ''
  let needsNewline = false

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/​/g, '') // strip ZWS
      if (t) {
        if (needsNewline && text) { text += '\n'; needsNewline = false }
        text += t
      }
      return
    }
    const el = node as HTMLElement
    if (el.tagName === 'BR') { needsNewline = true; return }
    if (el.dataset?.chip) {
      chips.push({
        nodeId: el.dataset.nodeid ?? '',
        url: el.dataset.url ?? '',
        name: el.dataset.name ?? '',
        mediaType: el.dataset.mediaType as ChipRef['mediaType'],
      })
      return
    }
    const isBlock = BLOCK_TAGS.has(el.tagName)
    if (isBlock && text) needsNewline = true
    el.childNodes.forEach(walk)
    if (isBlock) needsNewline = true
  }

  el.childNodes.forEach(walk)
  return { text: text.trim(), chips }
}

/**
 * 复制 / 剪切时给剪贴板的纯文本。chip 写成 `image1` / `video1` / `audio1`，
 * 不带删除按钮、不加换行。
 *
 * 不能让浏览器自己序列化：chip 是个 span，里面有缩略图和「×」，
 * 贴到画布外（记事本、聊天框）时图过不去就会整段消失
 * （2026-08-28 用户报的：视频节点提示词复制到非画布区域，@的图片直接没了）。
 * 写成 `image1` 外面能读，粘回提示词框时 token 转换也会把它认回成 chip。
 */
export function clipboardTextFromFragment(root: HTMLElement): string {
  let text = ''
  let needsNewline = false

  const push = (value: string) => {
    if (!value) return
    if (needsNewline && text) {
      text += '\n'
      needsNewline = false
    }
    text += value
  }

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      push((node.textContent ?? '').replace(/​/g, ''))
      return
    }
    const el = node as HTMLElement
    if (el.tagName === 'BR') {
      needsNewline = true
      return
    }
    if (el.dataset?.chip) {
      // 只要英文编号。× 是界面上的删除按钮，缩略图贴到外面也会丢。
      push(clipboardLabelFromChipName(el.dataset.name) || el.dataset.name || '')
      return
    }
    const isBlock = BLOCK_TAGS.has(el.tagName)
    if (isBlock && text) needsNewline = true
    el.childNodes.forEach(walk)
    if (isBlock) needsNewline = true
  }

  root.childNodes.forEach(walk)
  // 不 trim：这是选区片段，首尾的空格可能正是用户选中的内容
  return text
}

export const PromptEditor = forwardRef<PromptEditorHandle, Props>(
  ({ value, chips, onValueChange, onChipsChange, onChange, onAtKey, onEscape, mentionMenuOpen = false, onMentionNavigate, onMentionSelect, placeholder, style, htmlSnapshot, onHtmlChange, orderMap, resolveTextMention, resolveTextMentionsIn }, ref) => {
    const divRef = useRef<HTMLDivElement>(null)
    const composingRef = useRef(false)
    const initializedRef = useRef(false)
    const savedRangeRef = useRef<Range | null>(null)
    const [previewUrl, setPreviewUrl] = useState<string | null>(null)
    const [isEmpty, setIsEmpty] = useState(!value && chips.length === 0)
    const [hoverPreview, setHoverPreview] = useState<{ url: string; name?: string; rect: DOMRect; kind?: 'image' | 'video' } | null>(null)
    const hoverTimerRef = useRef<number | null>(null)
    const activeChipRef = useRef<HTMLElement | null>(null)
    const lastSnapshotRef = useRef('')
    const routeNextUndoRef = useRef(false)

    // Always-fresh callback refs — eliminates stale closure issues
    const cbRef = useRef({ onValueChange, onChipsChange, onChange, onAtKey, onEscape, onHtmlChange, onMentionNavigate, onMentionSelect, resolveTextMention, resolveTextMentionsIn })
    useEffect(() => {
      cbRef.current = { onValueChange, onChipsChange, onChange, onAtKey, onEscape, onHtmlChange, onMentionNavigate, onMentionSelect, resolveTextMention, resolveTextMentionsIn }
    }, [onValueChange, onChipsChange, onChange, onAtKey, onEscape, onHtmlChange, onMentionNavigate, onMentionSelect, resolveTextMention, resolveTextMentionsIn])

    // Sync DOM → state (also snapshot innerHTML to preserve chip positions)
    const syncOut = useCallback(() => {
      const el = divRef.current
      if (!el) return
      const { text, chips: newChips } = extractContent(el)
      const html = el.innerHTML
      setIsEmpty(!text && newChips.length === 0)
      const snapshotKey = JSON.stringify({
        text,
        html,
        chips: newChips.map((chip) => `${chip.nodeId}|${chip.url}|${chip.name}`),
      })
      if (lastSnapshotRef.current === snapshotKey) return
      lastSnapshotRef.current = snapshotKey
      if (cbRef.current.onChange) {
        cbRef.current.onChange({ text, chips: newChips, html })
        return
      }
      cbRef.current.onValueChange?.(text)
      cbRef.current.onChipsChange?.(newChips)
      cbRef.current.onHtmlChange?.(html)
    }, [])

    const saveSelection = useCallback(() => {
      const el = divRef.current
      const sel = window.getSelection()
      if (!el || !sel || !sel.rangeCount) return
      const range = sel.getRangeAt(0)
      if (el.contains(range.startContainer) && el.contains(range.endContainer)) {
        savedRangeRef.current = range.cloneRange()
      }
    }, [])

    const clearHoverTimer = useCallback(() => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
      }
    }, [])

    const hideHoverPreview = useCallback(() => {
      clearHoverTimer()
      activeChipRef.current = null
      setHoverPreview(null)
    }, [clearHoverTimer])

    const scheduleHoverPreview = useCallback((chip: HTMLElement) => {
      const url = chip.dataset.url ?? ''
      const mediaType = chip.dataset.mediaType
      const kind = canPreviewVideo(url, mediaType)
        ? 'video'
        : canPreviewImage(url)
          ? 'image'
          : null
      if (!kind) return
      clearHoverTimer()
      activeChipRef.current = chip
      const name = chip.dataset.name ?? ''
      const rect = chip.getBoundingClientRect()
      hoverTimerRef.current = window.setTimeout(() => {
        if (activeChipRef.current !== chip) return
        setHoverPreview({ url, name, rect, kind })
        hoverTimerRef.current = null
      }, 450)
    }, [clearHoverTimer])

    /**
     * Insert chip at current cursor position.
     *
     * opts.removeBeforeCaret：删掉光标前这么多个字符再插入。不给时保持老行为
     * （往前找最近的 `@` 删掉）—— 手写 `image1` 自动转引用走的是前者，
     * 因为要删的是 `image1` 加它后面那个分隔符，不是一个 `@`。
     * opts.appendText：插完 chip 再把这段文字补在后面（用户敲的那个分隔符原样还给他）。
     */
    const insertChip = useCallback((
      chipRef: ChipRef,
      opts?: { removeBeforeCaret?: number; appendText?: string },
    ) => {
      const el = divRef.current
      if (!el) return

      el.focus()
      const sel = window.getSelection()

      // Ensure we have a selection inside our editor
      if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) {
        const savedRange = savedRangeRef.current
        if (sel && savedRange && el.contains(savedRange.startContainer) && el.contains(savedRange.endContainer)) {
          sel.removeAllRanges()
          sel.addRange(savedRange.cloneRange())
        } else {
          // Fallback: place cursor at end
          const range = document.createRange()
          range.selectNodeContents(el)
          range.collapse(false)
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      }

      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0)

        // 清掉光标前那段要被 chip 顶替的文字
        if (range.startContainer.nodeType === Node.TEXT_NODE) {
          const txt = range.startContainer.textContent ?? ''
          const removeCount = opts?.removeBeforeCaret
          // 明确给了个数就按个数删（手写 image1 那条路）；没给就沿用老行为：往前找最近的 @
          const from = typeof removeCount === 'number'
            ? Math.max(0, range.startOffset - removeCount)
            : txt.lastIndexOf('@', range.startOffset - 1)
          if (from !== -1 && from < range.startOffset) {
            const cleanRange = document.createRange()
            cleanRange.setStart(range.startContainer, from)
            cleanRange.setEnd(range.startContainer, range.startOffset)
            cleanRange.deleteContents()
          }
        }

        // Insert chip HTML
        const tmp = document.createElement('span')
        tmp.innerHTML = buildChipHtml(chipRef)
        const chipNode = tmp.firstChild as Node

        const insertRange = sel.getRangeAt(0)
        insertRange.insertNode(chipNode)

        // Zero-width space after chip so cursor can continue
        const zws = document.createTextNode('​')
        if (chipNode.nextSibling) {
          chipNode.parentNode?.insertBefore(zws, chipNode.nextSibling)
        } else {
          chipNode.parentNode?.appendChild(zws)
        }

        // Move cursor after the ZWS
        const newRange = document.createRange()
        newRange.setStartAfter(zws)
        newRange.collapse(true)
        sel.removeAllRanges()
        sel.addRange(newRange)

        // 把用户敲的那个分隔符补回来。不补的话 `image1/` 会变成 chip 后面少一个斜杠 ——
        // 那是他提示词里的内容，不能吃掉。
        if (opts?.appendText) {
          const tailNode = document.createTextNode(opts.appendText)
          newRange.insertNode(tailNode)
          const afterTail = document.createRange()
          afterTail.setStartAfter(tailNode)
          afterTail.collapse(true)
          sel.removeAllRanges()
          sel.addRange(afterTail)
          savedRangeRef.current = afterTail.cloneRange()
        } else {
          savedRangeRef.current = newRange.cloneRange()
        }
      }

      syncOut()
      routeNextUndoRef.current = true
    }, [syncOut])

    /**
     * 把整段提示词里所有能对上引用的 `image1` 都换成 chip。
     *
     * 边打边转只覆盖「打完 token 又敲了一个字」这一种。用户在已有文字中间插一个 image1
     * （后面本来就跟着汉字、他也没再敲任何键），或者粘贴一段、或者是 Cindy 写好的提示词，
     * 都只能靠整段扫 —— 用户原话是「提示词里**有** image1 就自动变成 @」，是个状态而不是按键事件。
     *
     * 失焦时跑一次：那会儿用户已经不在打字了，不存在把 image15 抢成 image1 的风险。
     *
     * 两个实现要点：
     *   · 跳过 chip 内部的文字（chip 自己的标签写着「图片1」，再扫一遍会无限套娃）；
     *   · 同一个文本节点里从**后往前**替换，否则插入 chip 会让前面几处的下标全部失效。
     */
    const convertTextMentions = useCallback(() => {
      const el = divRef.current
      const resolve = cbRef.current.resolveTextMentionsIn
      if (!el || !resolve) return
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const textNodes: Text[] = []
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        if ((node.parentElement as HTMLElement | null)?.closest('[data-chip]')) continue
        textNodes.push(node)
      }
      let changed = false
      for (const node of textNodes) {
        const hits = resolve(node.textContent ?? '')
        for (const hit of hits) {
          const range = document.createRange()
          range.setStart(node, hit.start)
          range.setEnd(node, hit.start + hit.length)
          range.deleteContents()
          const tmp = document.createElement('span')
          tmp.innerHTML = buildChipHtml(hit.chip)
          const chipNode = tmp.firstChild
          if (!chipNode) continue
          range.insertNode(chipNode)
          changed = true
        }
      }
      if (changed) syncOut()
    }, [syncOut])

    const setPlainText = useCallback((text: string) => {
      const el = divRef.current
      if (!el) return
      el.textContent = text
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      savedRangeRef.current = range.cloneRange()
      syncOut()
    }, [syncOut])

    const markChipsMissing = useCallback((refs: { nodeId?: string | null; url?: string | null }[]) => {
      const el = divRef.current
      if (!el || refs.length === 0) return
      let changed = false
      el.querySelectorAll<HTMLElement>('[data-chip="1"]').forEach(chip => {
        const matched = refs.some(item => {
          const nodeMatches = item.nodeId && chip.dataset.nodeid === item.nodeId
          const urlMatches = item.url && chip.dataset.url === item.url
          return Boolean(nodeMatches || urlMatches)
        })
        if (!matched) return
        chip.dataset.url = ''
        chip.dataset.missing = '1'
        const tmp = document.createElement('span')
        tmp.innerHTML = missingChipPreviewHtml()
        const preview = chip.querySelector('[data-chip-preview="1"]')
        const replacement = tmp.firstElementChild
        if (preview && replacement) preview.replaceWith(replacement)
        changed = true
      })
      if (changed) syncOut()
      if (changed) routeNextUndoRef.current = true
    }, [syncOut])

    // Expose editor commands to parent via ref
    useImperativeHandle(ref, () => ({ insertChip, setPlainText, markChipsMissing, convertTextMentions }), [insertChip, setPlainText, markChipsMissing, convertTextMentions])

    // When orderMap changes, update chip display names in DOM
    // Use stable serialized key to avoid running on every render
    const orderMapKey = orderMap ? JSON.stringify(orderMap) : ''
    useEffect(() => {
      const el = divRef.current
      if (!el || !orderMap) return
      el.querySelectorAll<HTMLElement>('[data-chip="1"]').forEach(chip => {
        const nodeId = chip.dataset.nodeid
        if (!nodeId || !(nodeId in orderMap)) return
        const newName = orderMap[nodeId]
        const short = newName.length > 6 ? newName.slice(0, 6) + '…' : newName
        chip.dataset.name = newName
        const nameSpan = chip.children[1] as HTMLElement | undefined
        if (nameSpan && nameSpan.textContent !== short) nameSpan.textContent = short
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orderMapKey])

    // Initialize DOM content on mount only
    useEffect(() => {
      const el = divRef.current
      if (!el || initializedRef.current) return
      initializedRef.current = true
      if (htmlSnapshot) {
        // Restore exact HTML snapshot — preserves chip positions perfectly.
        // 洗一遍再注入：历史上粘贴进来的富文本把 white-space:nowrap / 固定 width 之类的内联
        // 样式一起存进了 promptHtml，内联样式压过容器的 pre-wrap，那些段落就不换行、被外层
        // 的 overflowX:hidden 裁掉。chip 子树不受影响（sanitizePromptHtml 会整棵跳过）。
        el.innerHTML = sanitizePromptHtml(htmlSnapshot)
        upgradeChipPreviewElements(el)
      } else if (value || chips.length > 0) {
        el.innerHTML = ''
        if (value) el.appendChild(document.createTextNode(value))
        for (const chip of chips) {
          const tmp = document.createElement('span')
          tmp.innerHTML = buildChipHtml(chip)
          const chipNode = tmp.firstChild
          if (chipNode) {
            el.appendChild(chipNode)
            el.appendChild(document.createTextNode('​'))
          }
        }
      }
      const { text, chips: currentChips } = extractContent(el)
      setIsEmpty(!text && currentChips.length === 0)
      lastSnapshotRef.current = JSON.stringify({
        text,
        html: el.innerHTML,
        chips: currentChips.map((chip) => `${chip.nodeId}|${chip.url}|${chip.name}`),
      })
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    const chipsKey = chips.map((chip) => `${chip.nodeId}|${chip.url}|${chip.name}|${chip.mediaType ?? ''}`).join('\n')
    useEffect(() => {
      const el = divRef.current
      if (!el || !initializedRef.current) return
      const nextHtml = htmlSnapshot ? sanitizePromptHtml(htmlSnapshot) : buildEditorHtml(value, chips)
      if (el.innerHTML === nextHtml) return
      el.innerHTML = nextHtml
      upgradeChipPreviewElements(el)
      const { text, chips: currentChips } = extractContent(el)
      setIsEmpty(!text && currentChips.length === 0)
      lastSnapshotRef.current = JSON.stringify({
        text,
        html: el.innerHTML,
        chips: currentChips.map((chip) => `${chip.nodeId}|${chip.url}|${chip.name}`),
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [htmlSnapshot, value, chipsKey])

    useEffect(() => {
      const handler = () => saveSelection()
      document.addEventListener('selectionchange', handler)
      return () => document.removeEventListener('selectionchange', handler)
    }, [saveSelection])

    useEffect(() => {
      return () => {
        clearHoverTimer()
      }
    }, [clearHoverTimer])

    /**
     * 粘贴只取纯文本。
     *
     * 不拦的话浏览器会把剪贴板里的 text/html 连同内联样式整块插进来（Word / 网页 / AI 对话
     * 都是富文本），那些 white-space:nowrap、固定 width 会一路存进 params.promptHtml，表现
     * 就是「有些段落不换行」，而且 promptHtml 会涨到正文的几十倍。
     *
     * 用 execCommand('insertText')：它是唯一能在 contenteditable 里既插文本、又保留浏览器
     * 原生撤销栈的办法（虽然标记 deprecated，但目标浏览器都还支持）。失败时退回手动 Range
     * 插入 —— 那样会丢一次撤销机会，但内容不会丢。
     */
    const handlePaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
      const text = plainTextFromClipboard(event.clipboardData)
      event.preventDefault()
      if (!text) return
      let inserted = false
      try {
        inserted = document.execCommand('insertText', false, text)
      } catch {
        inserted = false
      }
      if (!inserted) {
        const selection = window.getSelection()
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0)
          range.deleteContents()
          const node = document.createTextNode(text)
          range.insertNode(node)
          range.setStartAfter(node)
          range.setEndAfter(node)
          selection.removeAllRanges()
          selection.addRange(range)
        }
      }
      // execCommand 不一定触发 React 的 onInput，手动同步一次，否则字数与保存都不会更新
      syncOut()
      saveSelection()
      // 粘进来的这段里可能有好几个 `图片1`，位置也不一定在光标附近，所以整段扫一遍
      // （只做光标前那一处的话，粘贴完还是一堆裸文字，得等失焦 —— 2026-08-25 用户报的
      // 「复制粘贴会这样，再点一下才会正常」）。
      convertTextMentions()
    }, [convertTextMentions, saveSelection, syncOut])

    /**
     * 光标前刚好打完一个 `image1` 就地换成 chip。返回是否换掉了。
     *
     * 单独提出来是因为要在**两处**调用：普通输入，以及**输入法组字结束**。
     * 组字期间 handleInput 会被 composingRef 挡掉，而中文提示词里 `image1` 后面
     * 紧跟的就是拼音打出来的汉字 —— 只在 handleInput 里做的话，用中文输入法时
     * 永远等不到那一次检查，得等失焦扫描才转（2026-08-25 用户报的「要再点下节点」）。
     */
    const tryConvertTokenAtCaret = useCallback(() => {
      const resolve = cbRef.current.resolveTextMention
      if (!resolve) return false
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount) return false
      const node = sel.getRangeAt(0).startContainer
      if (node.nodeType !== Node.TEXT_NODE) return false
      const hit = resolve((node.textContent ?? '').slice(0, sel.getRangeAt(0).startOffset))
      if (!hit) return false
      insertChip(hit.chip, { removeBeforeCaret: hit.removeCount, appendText: hit.tail })
      return true
    }, [insertChip])

    const handleInput = useCallback(() => {
      if (composingRef.current) return
      syncOut()
      saveSelection()

      // Check for @ to trigger dropdown
      const sel = window.getSelection()
      if (sel && sel.rangeCount) {
        const node = sel.getRangeAt(0).startContainer
        if (node.nodeType === Node.TEXT_NODE) {
          const txt = node.textContent ?? ''
          const cur = sel.getRangeAt(0).startOffset
          const lastAt = txt.lastIndexOf('@', cur - 1)
          if (lastAt !== -1 && !txt.slice(lastAt + 1, cur).includes(' ')) {
            cbRef.current.onAtKey()
            return
          }
        }
      }
      // 手写 `image1` + 断词字符 → 自动换成对应的 @引用。
      // 放在 @ 检测之后：正在打 @xxx 时不插手，那条路有自己的候选菜单。
      tryConvertTokenAtCaret()
    }, [saveSelection, syncOut, tryConvertTokenAtCaret])

    /**
     * 复制 / 剪切时自己写剪贴板，不让浏览器序列化 chip。
     * 浏览器那份会把 chip 的删除按钮「×」也算成文字、还在 chip 前后加换行，
     * 粘回来就多出一个 × 和两个换行。
     */
    const writeSelectionToClipboard = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return false
      const holder = document.createElement('div')
      holder.appendChild(sel.getRangeAt(0).cloneContents())
      const text = clipboardTextFromFragment(holder)
      // 空文本就不插手，让浏览器按默认走。**光标折叠的情况也走这条**：
      // 折叠选区 cloneContents 出来必然是空片段，所以不用再单独判 isCollapsed
      // （单独判等于一句永远走不到的死代码）。
      if (!text) return false
      event.clipboardData.setData('text/plain', text)
      event.preventDefault()
      return true
    }, [])

    const handleCopy = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
      writeSelectionToClipboard(event)
    }, [writeSelectionToClipboard])

    const handleCut = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
      // preventDefault 之后浏览器不会再帮我们删，所以自己删一次
      if (!writeSelectionToClipboard(event)) return
      const sel = window.getSelection()
      if (sel && sel.rangeCount) sel.getRangeAt(0).deleteContents()
      syncOut()
      saveSelection()
    }, [saveSelection, syncOut, writeSelectionToClipboard])

    const handleClick = useCallback((e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.dataset?.del) {
        const chip = target.closest('[data-chip]') as HTMLElement | null
        if (chip) {
          chip.remove()
          syncOut()
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
      const chip = target.closest('[data-chip]') as HTMLElement | null
      if (chip) {
        const url = chip.dataset.url ?? ''
        if (canPreviewImage(url)) {
          setPreviewUrl(url)
          e.preventDefault()
          e.stopPropagation()
        }
      }
    }, [syncOut])

    const handleMouseOver = useCallback((e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      const chip = target.closest('[data-chip]') as HTMLElement | null
      if (!chip || chip === activeChipRef.current) return
      scheduleHoverPreview(chip)
    }, [scheduleHoverPreview])

    const handleMouseOut = useCallback((e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      const chip = target.closest('[data-chip]') as HTMLElement | null
      if (!chip) return
      const relatedTarget = e.relatedTarget as Node | null
      if (relatedTarget && chip.contains(relatedTarget)) return
      hideHoverPreview()
    }, [hideHoverPreview])

    return (
      <div style={{ position: 'relative', minHeight: 72, width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' }}>
        <div
          ref={divRef}
          className="shotflow-prompt-editor"
          contentEditable
          suppressContentEditableWarning
          style={{
            outline: 'none',
            display: 'block',
            width: '100%',
            maxWidth: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            minHeight: 80,
            lineHeight: 1.7,
            fontSize: 14,
            color: '#d0c8f0',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            whiteSpace: 'pre-wrap',
            ...style,
          }}
          onInput={handleInput}
          onPaste={handlePaste}
          onCopy={handleCopy}
          onCut={handleCut}
          onClick={handleClick}
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
          onFocus={saveSelection}
          onBlur={convertTextMentions}
          onMouseUp={saveSelection}
          onKeyUp={saveSelection}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => {
            composingRef.current = false
            syncOut()
            saveSelection()
            // 组字期间 handleInput 被挡掉了，这里补一次：中文输入法打出的汉字
            // 正是 image1 后面那个断词字符
            tryConvertTokenAtCaret()
          }}
          onKeyDown={e => {
            const key = e.key.toLowerCase()
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z' && routeNextUndoRef.current) {
              e.preventDefault()
              e.stopPropagation()
              routeNextUndoRef.current = false
              useCanvasStore.getState().undo()
              return
            }
            if (mentionMenuOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                cbRef.current.onMentionNavigate?.('down')
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                cbRef.current.onMentionNavigate?.('up')
                return
              }
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                e.preventDefault()
                cbRef.current.onMentionSelect?.()
                return
              }
            }
            if (e.key === 'Escape') { cbRef.current.onEscape(); return }
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.preventDefault()
              const sel = window.getSelection()
              if (sel && sel.rangeCount) {
                const range = sel.getRangeAt(0)
                range.deleteContents()
                const br = document.createElement('br')
                range.insertNode(br)
                // Insert extra br if at end so cursor stays on new line
                if (!br.nextSibling || (br.nextSibling as HTMLElement).tagName === 'BR') {
                  const extra = document.createElement('br')
                  br.parentNode?.insertBefore(extra, br.nextSibling ?? null)
                  range.setStartBefore(extra)
                } else {
                  range.setStartAfter(br)
                }
                range.collapse(true)
                sel.removeAllRanges()
                sel.addRange(range)
                syncOut()
              }
            }
          }}
        />
        {isEmpty && (
          <div style={{
            position: 'absolute', top: 0, left: 0,
            pointerEvents: 'none', userSelect: 'none',
            color: '#4a4060', fontSize: 14, lineHeight: 1.7,
          }}>
            {placeholder ?? '描述你想要生成的画面内容，@引用素材'}
          </div>
        )}
        <HoverImagePreview entry={hoverPreview} />
        {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
      </div>
    )
  }
)

PromptEditor.displayName = 'PromptEditor'
