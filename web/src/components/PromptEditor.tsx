/**
 * Rich-text prompt editor: plain text + inline image chips.
 * Chips are <span contentEditable="false"> elements inserted at cursor.
 */
import { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react'

export interface ChipRef {
  nodeId: string
  url: string
  name: string
}

interface Props {
  value: string
  chips: ChipRef[]
  onValueChange: (text: string) => void
  onChipsChange: (chips: ChipRef[]) => void
  onAtKey: () => void
  onEscape: () => void
  placeholder?: string
  style?: React.CSSProperties
  /** Stored innerHTML snapshot — restores chip positions exactly on remount */
  htmlSnapshot?: string
  /** Called after every edit with the current innerHTML */
  onHtmlChange?: (html: string) => void
  /** nodeId → display name，当黄框顺序变化时传入新映射，自动更新 chip 显示名 */
  orderMap?: Record<string, string>
}

function buildChipHtml(ref: ChipRef) {
  const short = ref.name.length > 6 ? ref.name.slice(0, 6) + '…' : ref.name
  return (
    `<span contenteditable="false" data-chip="1" ` +
    `data-nodeid="${ref.nodeId}" data-url="${ref.url}" data-name="${ref.name}" ` +
    `style="display:inline-flex;align-items:center;gap:3px;background:#251e38;` +
    `border:1px solid #312550;border-radius:4px;padding:1px 5px 1px 3px;` +
    `margin:0 2px;vertical-align:middle;user-select:none;cursor:default;">` +
    `<img src="${ref.url}" draggable="false" ` +
    `style="width:16px;height:16px;object-fit:cover;border-radius:2px;" />` +
    `<span style="font-size:11px;color:#c4b5fd;">${short}</span>` +
    `<span data-del="1" style="font-size:11px;color:#5a5070;cursor:pointer;padding:0 2px;">×</span>` +
    `</span>`
  )
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'BR', 'LI', 'H1', 'H2', 'H3'])

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

export const PromptEditor = forwardRef<{ insertChip: (ref: ChipRef) => void }, Props>(
  ({ value, chips, onValueChange, onChipsChange, onAtKey, onEscape, placeholder, style, htmlSnapshot, onHtmlChange, orderMap }, ref) => {
    const divRef = useRef<HTMLDivElement>(null)
    const composingRef = useRef(false)
    const initializedRef = useRef(false)

    // Always-fresh callback refs — eliminates stale closure issues
    const cbRef = useRef({ onValueChange, onChipsChange, onAtKey, onEscape, onHtmlChange })
    useEffect(() => {
      cbRef.current = { onValueChange, onChipsChange, onAtKey, onEscape, onHtmlChange }
    })

    // Sync DOM → state (also snapshot innerHTML to preserve chip positions)
    const syncOut = useCallback(() => {
      const el = divRef.current
      if (!el) return
      const { text, chips: newChips } = extractContent(el)
      cbRef.current.onValueChange(text)
      cbRef.current.onChipsChange(newChips)
      cbRef.current.onHtmlChange?.(el.innerHTML)
    }, [])

    // Insert chip at current cursor position
    const insertChip = useCallback((chipRef: ChipRef) => {
      const el = divRef.current
      if (!el) return

      el.focus()
      const sel = window.getSelection()

      // Ensure we have a selection inside our editor
      if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) {
        // Fallback: place cursor at end
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        sel?.removeAllRanges()
        sel?.addRange(range)
      }

      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0)

        // Remove trailing @ from text node before cursor
        if (range.startContainer.nodeType === Node.TEXT_NODE) {
          const txt = range.startContainer.textContent ?? ''
          const atIdx = txt.lastIndexOf('@', range.startOffset - 1)
          if (atIdx !== -1) {
            const cleanRange = document.createRange()
            cleanRange.setStart(range.startContainer, atIdx)
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
      }

      syncOut()
    }, [syncOut])

    // Expose insertChip to parent via ref
    useImperativeHandle(ref, () => ({ insertChip }), [insertChip])

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
        // Restore exact HTML snapshot — preserves chip positions perfectly
        el.innerHTML = htmlSnapshot
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
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    const handleInput = useCallback(() => {
      if (composingRef.current) return
      syncOut()

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
    }, [syncOut])

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
      }
    }, [syncOut])

    const isEmpty = !value && chips.length === 0

    return (
      <div style={{ position: 'relative', minHeight: 72 }}>
        <div
          ref={divRef}
          contentEditable
          suppressContentEditableWarning
          style={{
            outline: 'none',
            minHeight: 80,
            lineHeight: 1.7,
            fontSize: 14,
            color: '#d0c8f0',
            wordBreak: 'break-word',
            ...style,
          }}
          onInput={handleInput}
          onClick={handleClick}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false; syncOut() }}
          onKeyDown={e => {
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
      </div>
    )
  }
)

PromptEditor.displayName = 'PromptEditor'
