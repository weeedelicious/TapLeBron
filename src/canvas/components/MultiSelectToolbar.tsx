import { useEffect, useRef, useState } from 'react'
import {
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  ChevronDown,
  LayoutGrid,
} from 'lucide-react'
import { useCanvasStore } from '@/store/canvasStore'

interface Props {
  selectedIds: string[]
  position?: { left: number; top: number } | null
}

type ArrangeMode = 'grid' | 'horizontal' | 'vertical'

const ARRANGE_GAP = 48

function nodeWidth(node: { measured?: { width?: number }; width?: number; data?: { contentWidth?: number } }) {
  return Math.max(1, Number(node.data?.contentWidth ?? node.width ?? node.measured?.width ?? 240))
}

function nodeHeight(node: { measured?: { height?: number }; height?: number; data?: { contentHeight?: number } }) {
  return Math.max(1, Number(node.data?.contentHeight ?? node.height ?? node.measured?.height ?? 160))
}

function orderedNodes<T extends { position: { x: number; y: number } }>(nodes: T[]) {
  return [...nodes].sort((a, b) => (a.position.y - b.position.y) || (a.position.x - b.position.x))
}

function buttonStyle(active = false): React.CSSProperties {
  return {
    background: active ? 'rgba(124,92,252,0.18)' : 'none',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    color: '#c4b5fd',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '4px 7px',
    whiteSpace: 'nowrap',
  }
}

function menuButtonStyle(): React.CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    border: 'none',
    borderRadius: 9,
    background: 'transparent',
    color: '#f2edff',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    textAlign: 'left',
  }
}

export function MultiSelectToolbar({ selectedIds, position }: Props) {
  const { nodes, groupNodes, duplicateNodes, setNodes, pushHistory } = useCanvasStore()
  const [arrangeOpen, setArrangeOpen] = useState(false)
  const arrangeRef = useRef<HTMLDivElement>(null)

  const selectedNodes = nodes.filter(n => selectedIds.includes(n.id))

  useEffect(() => {
    if (!arrangeOpen) return
    const close = (event: MouseEvent) => {
      if (!arrangeRef.current?.contains(event.target as Node)) setArrangeOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setArrangeOpen(false)
    }
    document.addEventListener('mousedown', close, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', close, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [arrangeOpen])

  useEffect(() => {
    setArrangeOpen(false)
  }, [selectedIds.join('|')])

  if (selectedIds.length < 2 || !position) return null

  const arrangeNodes = (mode: ArrangeMode) => {
    const targets = orderedNodes(selectedNodes)
    if (targets.length < 2) return

    const minX = Math.min(...targets.map(node => node.position.x))
    const minY = Math.min(...targets.map(node => node.position.y))
    const positions = new Map<string, { x: number; y: number }>()

    if (mode === 'horizontal') {
      let cursorX = minX
      for (const node of targets) {
        positions.set(node.id, { x: cursorX, y: minY })
        cursorX += nodeWidth(node) + ARRANGE_GAP
      }
    } else if (mode === 'vertical') {
      let cursorY = minY
      for (const node of targets) {
        positions.set(node.id, { x: minX, y: cursorY })
        cursorY += nodeHeight(node) + ARRANGE_GAP
      }
    } else {
      const cols = Math.ceil(Math.sqrt(targets.length))
      const cellWidth = Math.max(...targets.map(nodeWidth)) + ARRANGE_GAP
      const cellHeight = Math.max(...targets.map(nodeHeight)) + ARRANGE_GAP
      targets.forEach((node, index) => {
        const row = Math.floor(index / cols)
        const col = index % cols
        positions.set(node.id, {
          x: minX + col * cellWidth,
          y: minY + row * cellHeight,
        })
      })
    }

    pushHistory()
    setNodes(
      nodes.map(node => {
        const nextPosition = positions.get(node.id)
        return nextPosition ? { ...node, position: nextPosition } : node
      }),
      { persist: true, markDirty: true }
    )
    setArrangeOpen(false)
  }

  return (
    <div
      className="nodrag nopan"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        transform: 'translate(-50%, -100%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: '#1a1530',
        border: '1px solid #312550',
        borderRadius: 20,
        padding: '6px 14px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
        pointerEvents: 'all',
      }}
    >
      <span style={{ fontSize: 11, color: '#6a5a8a', marginRight: 4 }}>
        已选 {selectedIds.length} 个
      </span>

      <div style={{ width: 1, height: 16, background: '#312550' }} />

      <button
        style={buttonStyle()}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,92,252,0.15)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'none')}
        onClick={() => duplicateNodes(selectedIds)}
        title="创建副本"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="4" y="4" width="9" height="9" rx="1.5" stroke="#c4b5fd" strokeWidth="1.2" />
          <rect x="1" y="1" width="9" height="9" rx="1.5" stroke="#c4b5fd" strokeWidth="1.2" fill="#1a1530" />
        </svg>
        <span>创建副本</span>
      </button>

      <div style={{ width: 1, height: 16, background: '#312550' }} />

      <div ref={arrangeRef} style={{ position: 'relative' }}>
        <button
          style={buttonStyle(arrangeOpen)}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,92,252,0.15)')}
          onMouseLeave={e => {
            if (!arrangeOpen) e.currentTarget.style.background = 'none'
          }}
          onClick={() => setArrangeOpen(open => !open)}
          title="排列"
        >
          <LayoutGrid size={14} strokeWidth={2} />
          <span>排列</span>
          <ChevronDown size={12} strokeWidth={2.2} style={{ opacity: 0.7 }} />
        </button>

        {arrangeOpen && (
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 'calc(100% + 9px)',
              transform: 'translateX(-50%)',
              minWidth: 142,
              padding: 6,
              borderRadius: 12,
              background: '#242424',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 18px 40px rgba(0,0,0,0.52)',
            }}
          >
            <button
              style={menuButtonStyle()}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              onClick={() => arrangeNodes('grid')}
            >
              <LayoutGrid size={17} strokeWidth={2.1} />
              宫格排列
            </button>
            <button
              style={menuButtonStyle()}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              onClick={() => arrangeNodes('horizontal')}
            >
              <AlignHorizontalDistributeCenter size={17} strokeWidth={2.1} />
              水平排列
            </button>
            <button
              style={menuButtonStyle()}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              onClick={() => arrangeNodes('vertical')}
            >
              <AlignVerticalDistributeCenter size={17} strokeWidth={2.1} />
              垂直排列
            </button>
          </div>
        )}
      </div>

      <div style={{ width: 1, height: 16, background: '#312550' }} />

      <button
        style={buttonStyle()}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,92,252,0.15)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'none')}
        onClick={() => groupNodes(selectedIds)}
        title="打组"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="1" y="1" width="12" height="12" rx="2" stroke="#c4b5fd" strokeWidth="1.2" strokeDasharray="3 2" />
          <rect x="3.5" y="3.5" width="3" height="3" rx="1" fill="#c4b5fd" opacity="0.6" />
          <rect x="7.5" y="3.5" width="3" height="3" rx="1" fill="#c4b5fd" opacity="0.6" />
          <rect x="3.5" y="7.5" width="3" height="3" rx="1" fill="#c4b5fd" opacity="0.6" />
          <rect x="7.5" y="7.5" width="3" height="3" rx="1" fill="#c4b5fd" opacity="0.6" />
        </svg>
        <span>打组</span>
      </button>
    </div>
  )
}
