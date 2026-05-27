import { useState, useCallback } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { useCanvasStore } from '@/store/canvasStore'
import type { CanvasNodeData } from '@/lib/types'

const NODE_ICONS: Record<string, string> = {
  image: '🖼', video: '🎬', text: '📝', audio: '🎵',
  script: '📋', upload: '📁', video_merge: '🔗', director_stage: '🎭',
}

function PlusHandleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="9.35" fill="rgba(18,12,40,0.92)" stroke="#5b46c8" strokeWidth="1.3" />
      <path d="M10 6.5v7M6.5 10h7" stroke="#9880f0" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

interface NodeShellProps {
  nodeKey: string
  data: CanvasNodeData & { nodeKey: string }
  children: React.ReactNode
  minWidth?: number
  minHeight?: number
  selected?: boolean
}

export function NodeShell({ nodeKey, data, children, minWidth = 320, minHeight = 200, selected }: NodeShellProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { deleteNodes, updateNodeData } = useCanvasStore()

  const handleDelete = useCallback(() => {
    deleteNodes([nodeKey])
    setMenuOpen(false)
  }, [nodeKey, deleteNodes])

  const handleRename = useCallback(() => {
    const name = prompt('重命名节点', data.name)
    if (name) updateNodeData(nodeKey, { name })
    setMenuOpen(false)
  }, [nodeKey, data.name, updateNodeData])

  const isLoading = data.taskInfo?.loading
  const progress = data.taskInfo?.progressPercent ?? 0
  const hasError = data.taskInfo?.status === 3

  return (
    <div
      className="relative flex flex-col"
      style={{ minWidth, minHeight }}
      onClick={() => menuOpen && setMenuOpen(false)}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={minWidth}
        minHeight={minHeight}
        handleStyle={{ background: '#7c5cfc', border: 'none', borderRadius: 2 }}
        lineStyle={{ borderColor: '#7c5cfc' }}
      />

      {/* Floating title above the node */}
      <div
        className="absolute flex items-center gap-1.5 nodrag"
        style={{ top: -28, left: 0, height: 24, zIndex: 20 }}
      >
        <span style={{ fontSize: 13 }}>{NODE_ICONS[data.type] ?? '📄'}</span>
        <span className="text-xs truncate" style={{ color: '#b0a8d8', maxWidth: 200 }}>{data.name}</span>
        <div className="relative">
          <button
            style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', color: '#6a6080', fontSize: 16, lineHeight: 1 }}
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
          >⋯</button>
          {menuOpen && (
            <div
              className="absolute left-0 z-50 rounded shadow-lg py-1"
              style={{ top: 24, minWidth: 96, background: '#1a1428', border: '1px solid #3a2860' }}
            >
              <button
                className="block w-full text-left px-3 py-1 text-xs hover:bg-white/5"
                style={{ color: '#c0b8e0' }}
                onClick={handleRename}
              >重命名</button>
              <button
                className="block w-full text-left px-3 py-1 text-xs text-red-400 hover:bg-white/5"
                onClick={handleDelete}
              >删除</button>
            </div>
          )}
        </div>
      </div>

      {/* Target handle (left edge) */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ width: 0, height: 0, minWidth: 0, minHeight: 0, background: 'transparent', border: 'none', zIndex: 20 }}
      >
        <div
          className="nodrag"
          style={{
            position: 'absolute', width: 56, height: 56,
            left: -28, top: -28,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'all',
          }}
        >
          <PlusHandleIcon />
        </div>
      </Handle>

      {/* Source handle (right edge) */}
      <Handle
        type="source"
        position={Position.Right}
        style={{ width: 0, height: 0, minWidth: 0, minHeight: 0, background: 'transparent', border: 'none', zIndex: 20 }}
      >
        <div
          className="nodrag"
          style={{
            position: 'absolute', width: 56, height: 56,
            left: -28, top: -28,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'all',
          }}
        >
          <PlusHandleIcon />
        </div>
      </Handle>

      {/* Node body */}
      <div
        className="relative flex flex-col flex-1 rounded-lg overflow-hidden"
        style={{
          background: '#1a1625',
          border: selected ? '1px solid #7c5cfc' : '1px solid #2d2040',
        }}
      >
        <div className="flex-1 min-h-0">{children}</div>

        {/* Progress overlay */}
        {isLoading && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center"
            style={{ background: 'rgba(15,10,30,0.82)', zIndex: 30 }}
          >
            <div className="w-3/4 h-1 rounded mb-2" style={{ background: '#2d2040' }}>
              <div
                className="h-full rounded"
                style={{ width: `${progress}%`, background: '#7c5cfc', transition: 'width 0.4s' }}
              />
            </div>
            <span className="text-xs" style={{ color: '#9d8ff0' }}>生成中 {progress}%</span>
          </div>
        )}

        {/* Error overlay */}
        {hasError && (
          <div
            className="absolute bottom-0 inset-x-0 px-3 py-2 text-xs text-red-400"
            style={{ background: 'rgba(30,0,0,0.8)', zIndex: 30 }}
          >
            {data.taskInfo?.error ?? '生成失败，请重试'}
          </div>
        )}
      </div>
    </div>
  )
}
