import { useCanvasStore } from '@/store/canvasStore'

interface Props {
  selectedIds: string[]
}

export function MultiSelectToolbar({ selectedIds }: Props) {
  const { nodes, groupNodes, duplicateNodes } = useCanvasStore()

  // Only show when 2+ non-group nodes are selected
  const selectedNodes = nodes.filter(n => selectedIds.includes(n.id))
  const hasGroup = selectedNodes.some(n => n.type === 'group')
  if (selectedIds.length < 2 || hasGroup) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 64,
        left: '50%',
        transform: 'translateX(-50%)',
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

      {/* 创建副本 */}
      <button
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#c4b5fd', fontSize: 12,
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '2px 6px',
        }}
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

      {/* 打组 */}
      <button
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#c4b5fd', fontSize: 12,
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '2px 6px',
        }}
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
