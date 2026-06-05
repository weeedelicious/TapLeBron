import { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { NodeResizer, useNodeId, useStore as useRFStore } from '@xyflow/react'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { generateApi } from '@/lib/api'
import type { CanvasNodeData } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

const PRESET_COLORS = [
  { label: '无色', value: 'transparent', border: '#555' },
  { label: '红', value: '#3a1a1a', border: '#8a3a3a' },
  { label: '橙', value: '#3a2a1a', border: '#8a6a3a' },
  { label: '黄', value: '#2e2e10', border: '#7a7a30' },
  { label: '绿', value: '#1a3a2a', border: '#3a8a5a' },
  { label: '青', value: '#1a3a3a', border: '#3a8a8a' },
  { label: '蓝', value: '#1a2a3a', border: '#3a6a8a' },
  { label: '紫', value: '#2a1a3a', border: '#6a3a8a' },
  { label: '灰', value: '#252525', border: '#666' },
]

const BTN: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: '#e0d8ff', fontSize: 15,
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '0 8px', whiteSpace: 'nowrap',
}

export function GroupNode({ id, data, selected }: Props) {
  const { updateNodeData, ungroupNodes, nodes } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const [showColorPicker, setShowColorPicker] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const params = (data.params ?? {}) as { childIds?: string[]; color?: string }
  const childIds: string[] = params.childIds ?? []
  const color = params.color ?? '#1a3a2a'
  const borderColor = PRESET_COLORS.find(c => c.value === color)?.border ?? '#3a8a5a'
  const isTransparent = color === 'transparent'

  const nonGroupCount = childIds.filter(cid => {
    const n = nodes.find(nd => nd.id === cid)
    return n && n.type !== 'group'
  }).length

  // Compute toolbar position from node DOM rect on demand (no setInterval)
  const getToolbarPos = () => {
    const el = containerRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top }
  }
  const toolbarPos = selected ? getToolbarPos() : null

  const handleColorChange = useCallback((newColor: string) => {
    updateNodeData(id, {
      params: { ...params, color: newColor } as unknown as Record<string, unknown>
    })
    setShowColorPicker(false)
  }, [id, params, updateNodeData])

  const handleGroupExecute = useCallback(async () => {
    const { nodes: allNodes } = useCanvasStore.getState()
    for (const childId of childIds) {
      const node = allNodes.find(n => n.id === childId)
      if (!node) continue
      const nd = node.data as CanvasNodeData & { nodeKey: string; projectUuid: string }
      const p = (nd.params ?? {}) as Record<string, unknown>
      try {
        if (node.type === 'image' && p.prompt) {
          const res = await generateApi.image(nd.projectUuid, childId, p)
          addTask(res.jobId, childId); startPolling(res.jobId, nd.projectUuid)
        } else if (node.type === 'video') {
          const res = await generateApi.video(nd.projectUuid, childId, p)
          addTask(res.jobId, childId); startPolling(res.jobId, nd.projectUuid)
        }
      } catch (e) { console.error('group execute', e) }
    }
  }, [childIds, addTask, startPolling])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <NodeResizer
        isVisible={selected}
        minWidth={200} minHeight={150}
        handleStyle={{ background: '#fff', border: '1px solid #7c5cfc', borderRadius: 2, width: 10, height: 10 }}
        lineStyle={{ borderColor: '#7c5cfc' }}
      />

      {/* Background */}
      <div style={{
        position: 'absolute', inset: 0,
        background: isTransparent ? 'rgba(255,255,255,0.02)' : color + 'cc',
        border: `1.5px solid ${isTransparent ? '#555' : borderColor}`,
        borderRadius: 10, pointerEvents: 'none',
      }} />

      {/* Label */}
      <div style={{
        position: 'absolute', top: 10, left: 14,
        fontSize: 12, color: 'rgba(255,255,255,0.45)',
        pointerEvents: 'none', userSelect: 'none',
      }}>
        分组 {nonGroupCount} 个节点
      </div>

      {/* Toolbar via Portal — fixed screen size, unaffected by canvas zoom */}
      {selected && toolbarPos && createPortal(
        <div
          className="nodrag"
          style={{
            position: 'fixed',
            left: toolbarPos.x,
            top: toolbarPos.y - 56,
            transform: 'translateX(-50%)',
            display: 'flex', alignItems: 'center', gap: 2,
            background: '#16112e', border: '1px solid #3a2860',
            borderRadius: 28, padding: '8px 20px',
            boxShadow: '0 6px 24px rgba(0,0,0,0.7)',
            zIndex: 99999, pointerEvents: 'all',
            whiteSpace: 'nowrap',
          }}
        >
          {/* Color dot */}
          <div style={{ position: 'relative', marginRight: 4 }}>
            <button
              className="nodrag"
              style={{
                width: 30, height: 30, borderRadius: '50%',
                background: isTransparent ? 'transparent' : color,
                border: `3px solid ${isTransparent ? '#888' : borderColor}`,
                cursor: 'pointer', flexShrink: 0,
              }}
              onClick={() => setShowColorPicker(v => !v)}
            />
            {showColorPicker && (
              <div className="nodrag" style={{
                position: 'fixed',
                left: toolbarPos.x - 60,
                top: toolbarPos.y - 56 + 46,
                background: '#16112e', border: '1px solid #3a2860',
                borderRadius: 12, padding: 12,
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.9)', zIndex: 100000,
              }}>
                {PRESET_COLORS.map(c => (
                  <button key={c.value} className="nodrag" style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: c.value === 'transparent' ? 'transparent' : c.value,
                    border: `3px solid ${color === c.value ? '#fff' : c.border}`,
                    cursor: 'pointer',
                  }} title={c.label} onClick={() => handleColorChange(c.value)} />
                ))}
              </div>
            )}
          </div>

          {/* 品 */}
          <button className="nodrag" style={BTN} title="节点面板">
            <span style={{ fontSize: 17 }}>品</span>
          </button>

          <div style={{ width: 1, height: 24, background: '#3a2860', margin: '0 6px' }} />

          {/* 整组执行 */}
          <button className="nodrag" style={BTN} onClick={handleGroupExecute}>
            <span style={{ fontSize: 14 }}>▶</span>
            <span>整组执行</span>
          </button>

          <div style={{ width: 1, height: 24, background: '#3a2860', margin: '0 6px' }} />

          {/* 解组 */}
          <button className="nodrag" style={{ ...BTN, color: '#c0b0f0' }} onClick={() => ungroupNodes(id)}>
            <span style={{ fontSize: 15 }}>🔓</span>
            <span>解组</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
