import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { NodeResizer, useViewport } from '@xyflow/react'
import {
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Copy,
  Download,
  LayoutGrid,
  Unlock,
} from 'lucide-react'
import { useCanvasStore } from '@/store/canvasStore'
import { FavoriteQuickActions } from '@/components/FavoriteQuickActions'
import type { CanvasNodeData, ResourceMeta } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

type ArrangeMode = 'grid' | 'horizontal' | 'vertical'

const ARRANGE_GAP = 48
const NODE_TITLE_SCREEN_HEIGHT = 26
const GROUP_BOUNDS_PADDING_SCREEN = 10
const GROUP_TOOLBAR_TOP_OFFSET_SCREEN = 74

const L = {
  noColor: '\u65e0\u8272',
  red: '\u7ea2',
  orange: '\u6a59',
  yellow: '\u9ec4',
  green: '\u7eff',
  cyan: '\u9752',
  blue: '\u84dd',
  purple: '\u7d2b',
  gray: '\u7070',
  group: (count: number) => `\u5206\u7ec4 ${count} \u4e2a\u8282\u70b9`,
  defaultGroupName: (count: number) => `\u5206\u7ec4${count}\u4e2a\u8282\u70b9`,
  arrange: '\u6392\u5217',
  grid: '\u5bab\u683c\u6392\u5217',
  horizontal: '\u6c34\u5e73\u6392\u5217',
  vertical: '\u5782\u76f4\u6392\u5217',
  copyGroup: '\u590d\u5236\u7ec4',
  batchDownload: '\u6279\u91cf\u4e0b\u8f7d',
  ungroup: '\u89e3\u7ec4',
}

const PRESET_COLORS = [
  { label: L.noColor, value: 'transparent', border: '#555' },
  { label: L.red, value: '#3a1a1a', border: '#8a3a3a' },
  { label: L.orange, value: '#3a2a1a', border: '#8a6a3a' },
  { label: L.yellow, value: '#2e2e10', border: '#7a7a30' },
  { label: L.green, value: '#1a3a2a', border: '#3a8a5a' },
  { label: L.cyan, value: '#1a3a3a', border: '#3a8a8a' },
  { label: L.blue, value: '#1a2a3a', border: '#3a6a8a' },
  { label: L.purple, value: '#2a1a3a', border: '#6a3a8a' },
  { label: L.gray, value: '#252525', border: '#666' },
]

const TOOLBAR_BUTTON: CSSProperties = {
  // 刻意不写 color / background：内联样式会压过 styles.css 里的主题覆盖，
  // 白色和暖色画布下就会变成浅紫字配米色底、完全看不清。颜色一律交给
  // .shotflow-group-toolbar button 那几条规则。
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 12,
  height: 30,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 7px',
  whiteSpace: 'nowrap',
}

function childWidth(node: {
  measured?: { width?: number | null }
  width?: number | null
  data?: { contentWidth?: unknown }
}) {
  return Math.max(1, Number(node.data?.contentWidth ?? node.width ?? node.measured?.width ?? 240))
}

function childHeight(node: {
  measured?: { height?: number | null }
  height?: number | null
  data?: { contentHeight?: unknown }
}) {
  return Math.max(1, Number(node.data?.contentHeight ?? node.height ?? node.measured?.height ?? 160))
}

function orderedChildren<T extends { position: { x: number; y: number } }>(nodes: T[]) {
  return [...nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
}

function displayGroupName(name: unknown, count: number) {
  const text = typeof name === 'string' ? name.trim() : ''
  if (!text || /^\u5206\u7ec4\s*\d+$/.test(text)) return L.defaultGroupName(count)
  return text
}

function arrangeMenuButtonStyle(): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    border: 'none',
    borderRadius: 9,
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    textAlign: 'left',
  }
}

function sanitizeDownloadName(value: unknown, fallback: string) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return text
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 90)
    .trim() || fallback
}

function extensionFromResource(url: string, meta?: ResourceMeta) {
  if (meta?.extension) return meta.extension.replace(/^\./, '').toLowerCase()
  if (meta?.mimeType) {
    const mime = meta.mimeType.toLowerCase()
    if (mime.includes('jpeg')) return 'jpg'
    if (mime.includes('png')) return 'png'
    if (mime.includes('webp')) return 'webp'
    if (mime.includes('gif')) return 'gif'
    if (mime.includes('mp4')) return 'mp4'
    if (mime.includes('quicktime')) return 'mov'
    if (mime.includes('webm')) return 'webm'
    if (mime.includes('mpeg')) return 'mp3'
    if (mime.includes('wav')) return 'wav'
  }
  const cleanUrl = url.split(/[?#]/)[0] ?? ''
  const match = cleanUrl.match(/\.([a-z0-9]{2,6})$/i)
  return match?.[1]?.toLowerCase() || 'file'
}

function triggerDownload(url: string, fileName: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
}

export function GroupNode({ id, data, selected }: Props) {
  const { updateNodeData, ungroupNodes, duplicateNodes, nodes, selectedNodeKeys, activePanelNodeId, setActivePanelNode, setNodes, pushHistory } = useCanvasStore()
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [showArrangeMenu, setShowArrangeMenu] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const arrangeRef = useRef<HTMLDivElement>(null)
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const isSoleSelected = selectedNodeKeys.length === 1 && selectedNodeKeys[0] === id
  const isPanelActive = activePanelNodeId === id && isSoleSelected
  const isGroupSelected = Boolean(selected || isSoleSelected)
  const { zoom } = useViewport()
  const safeZoom = zoom || 1
  const inverseZoom = 1 / safeZoom
  const selectedGlowRing = 0.7 / safeZoom
  const selectedGlowInner = 5 / safeZoom
  const selectedGlowOuter = 12 / safeZoom
  const selectedHandleScaleBase = safeZoom > 1 ? safeZoom : 1
  const selectedHandleSize = Math.max(4, 7 / selectedHandleScaleBase)
  const selectedHandleGlow = 8 / selectedHandleScaleBase

  const params = (data.params ?? {}) as { childIds?: string[]; color?: string }
  const childIds = params.childIds ?? []
  const color = params.color ?? '#252525'
  const borderColor = PRESET_COLORS.find(c => c.value === color)?.border ?? '#3a8a5a'
  const isTransparent = color === 'transparent'

  const nonGroupCount = childIds.filter(childId => {
    const node = nodes.find(item => item.id === childId)
    return node && node.type !== 'group'
  }).length
  const displayName = displayGroupName(data.name, nonGroupCount)

  useEffect(() => {
    setTitleDraft(displayName)
    setIsRenaming(false)
  }, [displayName])

  const toolbarPos = (() => {
    if (!isPanelActive) return null
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: rect.left + rect.width / 2, y: rect.top }
  })()

  useEffect(() => {
    if (!showArrangeMenu) return
    const close = (event: MouseEvent) => {
      if (!arrangeRef.current?.contains(event.target as Node)) setShowArrangeMenu(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowArrangeMenu(false)
    }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', close, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [showArrangeMenu])

  const handleColorChange = useCallback((newColor: string) => {
    updateNodeData(id, {
      params: { ...params, color: newColor } as unknown as Record<string, unknown>,
    })
    setShowColorPicker(false)
  }, [id, params, updateNodeData])

  const handleCopyGroup = useCallback(() => {
    duplicateNodes([id])
  }, [duplicateNodes, id])

  const selectGroup = useCallback(() => {
    const state = useCanvasStore.getState()
    state.setSelected([id])
    state.setNodes(
      state.nodes.map(node => ({
        ...node,
        selected: false,
      })),
      { persist: false, markDirty: false }
    )
  }, [id])

  const handleGroupPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pointerStartRef.current = { x: event.clientX, y: event.clientY }
    setActivePanelNode(null)
    selectGroup()
  }, [selectGroup, setActivePanelNode])

  const handleGroupClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current
    pointerStartRef.current = null
    if (!start) return
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    if (moved <= 4) setActivePanelNode(id)
  }, [id, setActivePanelNode])

  const startRename = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    pointerStartRef.current = null
    setTitleDraft(displayName)
    setIsRenaming(true)
    setActivePanelNode(id)
    selectGroup()
  }, [displayName, id, selectGroup, setActivePanelNode])

  const commitRename = useCallback(() => {
    const nextName = titleDraft.trim() || displayName
    setTitleDraft(nextName)
    setIsRenaming(false)
    if (nextName !== data.name) updateNodeData(id, { name: nextName })
  }, [data.name, displayName, id, titleDraft, updateNodeData])

  const cancelRename = useCallback(() => {
    setTitleDraft(displayName)
    setIsRenaming(false)
  }, [displayName])

  const handleArrangeChildren = useCallback((mode: ArrangeMode) => {
    const allNodes = useCanvasStore.getState().nodes
    const groupNode = allNodes.find(node => node.id === id)
    const targets = orderedChildren(allNodes.filter(node => childIds.includes(node.id) && node.type !== 'group'))
    if (!groupNode || targets.length < 2) {
      setShowArrangeMenu(false)
      return
    }

    const minX = Math.min(...targets.map(node => node.position.x))
    const minY = Math.min(...targets.map(node => node.position.y))
    const positions = new Map<string, { x: number; y: number }>()

    if (mode === 'horizontal') {
      let cursorX = minX
      for (const node of targets) {
        positions.set(node.id, { x: cursorX, y: minY })
        cursorX += childWidth(node) + ARRANGE_GAP
      }
    } else if (mode === 'vertical') {
      let cursorY = minY
      for (const node of targets) {
        positions.set(node.id, { x: minX, y: cursorY })
        cursorY += childHeight(node) + ARRANGE_GAP
      }
    } else {
      const cols = Math.ceil(Math.sqrt(targets.length))
      const cellWidth = Math.max(...targets.map(childWidth)) + ARRANGE_GAP
      const cellHeight = Math.max(...targets.map(childHeight)) + ARRANGE_GAP
      targets.forEach((node, index) => {
        const row = Math.floor(index / cols)
        const col = index % cols
        positions.set(node.id, {
          x: minX + col * cellWidth,
          y: minY + row * cellHeight,
        })
      })
    }

    let nextMaxX = -Infinity
    let nextMaxY = -Infinity
    for (const node of targets) {
      const next = positions.get(node.id) ?? node.position
      nextMaxX = Math.max(nextMaxX, next.x + childWidth(node))
      nextMaxY = Math.max(nextMaxY, next.y + childHeight(node))
    }

    const padding = GROUP_BOUNDS_PADDING_SCREEN / safeZoom
    const groupTopPadding = NODE_TITLE_SCREEN_HEIGHT / safeZoom
    const nextGroupX = minX - padding
    const nextGroupY = minY - groupTopPadding - padding
    const nextGroupWidth = Math.max(1, nextMaxX - nextGroupX + padding)
    const nextGroupHeight = Math.max(1, nextMaxY - nextGroupY + padding)

    pushHistory()
    setNodes(
      allNodes.map(node => {
        if (node.id === id) {
          return {
            ...node,
            position: { x: nextGroupX, y: nextGroupY },
            data: {
              ...node.data,
              contentWidth: nextGroupWidth,
              contentHeight: nextGroupHeight,
            },
            selected: false,
            style: {
              ...(node.style ?? {}),
              width: nextGroupWidth,
              height: nextGroupHeight,
              pointerEvents: 'auto',
            },
            selectable: false,
          }
        }
        const nextPosition = positions.get(node.id)
        return nextPosition ? { ...node, position: nextPosition } : node
      }),
      { persist: true, markDirty: true }
    )
    setShowArrangeMenu(false)
  }, [childIds, id, pushHistory, safeZoom, setNodes])

  const handleBatchDownload = useCallback(async () => {
    if (isDownloading) return
    const allNodes = useCanvasStore.getState().nodes
    const nodeMap = new Map(allNodes.map(node => [node.id, node]))
    const seenUrls = new Set<string>()
    const downloadItems: Array<{ url: string; fileName: string }> = []

    const collectNode = (nodeId: string) => {
      const node = nodeMap.get(nodeId)
      if (!node) return
      if (node.type === 'group') {
        const groupParams = (node.data.params ?? {}) as { childIds?: string[] }
        ;(groupParams.childIds ?? []).forEach(collectNode)
        return
      }

      const urls = (node.data.url ?? []).filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
      const metas = (node.data._resourceMeta?.items ?? []) as ResourceMeta[]
      urls.forEach((url, index) => {
        const meta = metas[index]
        const downloadUrl = meta?.originalUrl || url
        if (!downloadUrl || seenUrls.has(downloadUrl)) return
        seenUrls.add(downloadUrl)
        const baseName = sanitizeDownloadName(node.data.name, `node-${index + 1}`)
        const suffix = urls.length > 1 ? `-${index + 1}` : ''
        const extension = extensionFromResource(downloadUrl, meta)
        downloadItems.push({
          url: downloadUrl,
          fileName: `${baseName}${suffix}.${extension}`,
        })
      })
    }

    childIds.forEach(collectNode)
    if (downloadItems.length === 0) {
      window.alert('\u8fd9\u4e2a\u7ec4\u91cc\u6ca1\u6709\u53ef\u4e0b\u8f7d\u7684\u56fe\u7247\u6216\u89c6\u9891')
      return
    }

    setIsDownloading(true)
    try {
      for (const item of downloadItems) {
        triggerDownload(item.url, item.fileName)
        await new Promise(resolve => window.setTimeout(resolve, 120))
      }
    } finally {
      window.setTimeout(() => setIsDownloading(false), 300)
    }
  }, [childIds, isDownloading])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', pointerEvents: 'none' }}>
      <div
        className={`group-node-drag-surface group-node-frame${isGroupSelected ? ' is-selected' : ''}${data._cindyProposalMessageId ? ' is-cindy-origin' : ''}`}
        style={{
          position: 'absolute',
          inset: 0,
          background: isTransparent ? 'rgba(255,255,255,0.02)' : `${color}cc`,
          border: `1.5px solid ${isTransparent ? '#555' : borderColor}`,
          borderRadius: 10,
          pointerEvents: 'auto',
          cursor: 'move',
          zIndex: 0,
          boxShadow: isGroupSelected ? undefined : 'none',
          '--selected-node-ring': `${selectedGlowRing}px`,
          '--selected-node-inner': `${selectedGlowInner}px`,
          '--selected-node-outer': `${selectedGlowOuter}px`,
        }}
        onPointerDown={handleGroupPointerDown}
        onClick={handleGroupClick}
      />

      <div
        className={isRenaming ? 'nodrag nopan group-node-title' : 'group-node-drag-surface group-node-title'}
        style={{
          position: 'absolute',
          top: -24 / safeZoom,
          left: 0,
          height: 22,
          maxWidth: '100%',
          transform: `scale(${inverseZoom})`,
          transformOrigin: 'top left',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 'calc(12px * var(--canvas-text-scale, 1))',
          color: 'rgba(255,255,255,0.82)',
          pointerEvents: 'auto',
          userSelect: isRenaming ? 'text' : 'none',
          cursor: isRenaming ? 'text' : 'move',
          zIndex: 2,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        onPointerDown={isRenaming ? event => event.stopPropagation() : handleGroupPointerDown}
        onClick={isRenaming ? event => event.stopPropagation() : handleGroupClick}
        onDoubleClick={startRename}
      >
        {isRenaming ? (
          <input
            className="nodrag nopan"
            autoFocus
            value={titleDraft}
            onChange={event => setTitleDraft(event.currentTarget.value)}
            onBlur={commitRename}
            onMouseDown={event => event.stopPropagation()}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelRename()
              }
            }}
            style={{
              width: Math.max(110, Math.min(280, displayName.length * 13 + 34)),
              maxWidth: '100%',
              height: 20,
              padding: '0 6px',
              borderRadius: 5,
              border: '1px solid rgba(255,255,255,0.24)',
              background: 'rgba(18,16,24,0.92)',
              color: '#fff',
              fontSize: 'calc(12px * var(--canvas-text-scale, 1))',
              outline: 'none',
              boxShadow: '0 0 10px rgba(255,250,218,0.28)',
            }}
          />
        ) : (
          displayName
        )}
      </div>

      <NodeResizer
        isVisible={isGroupSelected}
        minWidth={200}
        minHeight={150}
        handleStyle={{
          background: 'rgba(224, 242, 255, 0.98)',
          border: '1px solid rgba(240, 248, 255, 0.96)',
          borderRadius: 999,
          width: selectedHandleSize,
          height: selectedHandleSize,
          boxShadow: `0 0 ${selectedHandleGlow}px rgba(103, 190, 255, 0.72)`,
          pointerEvents: 'auto',
        }}
        lineStyle={{ borderColor: 'transparent' }}
      />

      {isPanelActive && toolbarPos && createPortal(
        <div
          className="nodrag shotflow-group-toolbar"
          style={{
            position: 'fixed',
            left: toolbarPos.x,
            top: toolbarPos.y - GROUP_TOOLBAR_TOP_OFFSET_SCREEN,
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            background: '#1a1530',
            border: '1px solid #312550',
            borderRadius: 999,
            padding: '4px 8px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            zIndex: 99999,
            pointerEvents: 'all',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ position: 'relative', marginRight: 2 }}>
            <button
              /* shotflow-group-color-swatch：styles.css 里那条工具栏按钮的
                 background !important 会盖掉下面的内联分组色，靠这个类把它排除掉。 */
              className="nodrag shotflow-group-color-swatch"
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: isTransparent ? 'transparent' : color,
                border: `2px solid ${isTransparent ? '#888' : borderColor}`,
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onClick={() => {
                setShowArrangeMenu(false)
                setShowColorPicker(open => !open)
              }}
            />
            {showColorPicker && (
              <div
                className="nodrag shotflow-group-color-menu"
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: 'calc(100% + 12px)',
                  transform: 'translateX(-50%)',
                  padding: 12,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 10,
                  zIndex: 100000,
                }}
              >
                {PRESET_COLORS.map(preset => (
                  <button
                    key={preset.value}
                    /* shotflow-group-menu-item：色块的底色和边框都是内联的，
                       styles.css 里那条工具栏按钮规则带 !important，会把它们盖成
                       一片看不出颜色的灰方块，靠这个类排除掉。 */
                    className="nodrag shotflow-group-menu-item"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: preset.value === 'transparent' ? 'transparent' : preset.value,
                      border: `3px solid ${color === preset.value ? '#fff' : preset.border}`,
                      cursor: 'pointer',
                    }}
                    title={preset.label}
                    onClick={() => handleColorChange(preset.value)}
                  />
                ))}
              </div>
            )}
          </div>

          <FavoriteQuickActions
            rootIds={[id]}
            variant="bare"
            buttonStyle={{
              ...TOOLBAR_BUTTON,
              width: 30,
              height: 30,
              justifyContent: 'center',
              borderRadius: 999,
              padding: 0,
            }}
          />

          <div ref={arrangeRef} style={{ position: 'relative' }}>
            <button
              className="nodrag"
              style={{
                ...TOOLBAR_BUTTON,
                width: 30,
                height: 30,
                justifyContent: 'center',
                borderRadius: 999,
                background: showArrangeMenu ? 'rgba(255,255,255,0.11)' : 'transparent',
                padding: 0,
              }}
              title={L.arrange}
              onClick={() => {
                setShowColorPicker(false)
                setShowArrangeMenu(open => !open)
              }}
            >
              <LayoutGrid size={15} strokeWidth={2.1} />
            </button>

            {showArrangeMenu && (
              <div
                className="nodrag shotflow-group-arrange-menu"
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: 'calc(100% + 12px)',
                  transform: 'translateX(-50%)',
                  minWidth: 142,
                  padding: 6,
                  zIndex: 100001,
                }}
              >
                <button
                  className="nodrag shotflow-group-menu-item"
                  style={arrangeMenuButtonStyle()}
                  onMouseEnter={event => { event.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
                  onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
                  onClick={() => handleArrangeChildren('grid')}
                >
                  <LayoutGrid size={17} strokeWidth={2.1} />
                  {L.grid}
                </button>
                <button
                  className="nodrag shotflow-group-menu-item"
                  style={arrangeMenuButtonStyle()}
                  onMouseEnter={event => { event.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
                  onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
                  onClick={() => handleArrangeChildren('horizontal')}
                >
                  <AlignHorizontalDistributeCenter size={17} strokeWidth={2.1} />
                  {L.horizontal}
                </button>
                <button
                  className="nodrag shotflow-group-menu-item"
                  style={arrangeMenuButtonStyle()}
                  onMouseEnter={event => { event.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
                  onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
                  onClick={() => handleArrangeChildren('vertical')}
                >
                  <AlignVerticalDistributeCenter size={17} strokeWidth={2.1} />
                  {L.vertical}
                </button>
              </div>
            )}
          </div>

          <div className="shotflow-group-toolbar-divider" />

          <button className="nodrag" style={TOOLBAR_BUTTON} onClick={handleCopyGroup}>
            <Copy size={14} strokeWidth={2} />
            <span>{L.copyGroup}</span>
          </button>

          <div className="shotflow-group-toolbar-divider" />

          <button
            className="nodrag"
            style={{ ...TOOLBAR_BUTTON, opacity: isDownloading ? 0.68 : 1, cursor: isDownloading ? 'wait' : 'pointer' }}
            onClick={() => void handleBatchDownload()}
            disabled={isDownloading}
          >
            <Download size={14} strokeWidth={2} />
            <span>{isDownloading ? '\u4e0b\u8f7d\u4e2d' : L.batchDownload}</span>
          </button>

          <div className="shotflow-group-toolbar-divider" />

          <button className="nodrag" style={TOOLBAR_BUTTON} data-accent="ungroup" onClick={() => ungroupNodes(id)}>
            <Unlock size={14} strokeWidth={2} />
            <span>{L.ungroup}</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
