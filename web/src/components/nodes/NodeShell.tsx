import { useState, useCallback } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { useCanvasStore } from '@/store/canvasStore'
import type { CanvasNodeData } from '@/lib/types'

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
      className="relative rounded-lg overflow-hidden flex flex-col"
      style={{ background: '#1e1e1e', border: selected ? '1px solid #7c5cfc' : '1px solid #2a2a2a', minWidth, minHeight }}
      onClick={() => menuOpen && setMenuOpen(false)}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={minWidth}
        minHeight={minHeight}
        handleStyle={{ background: '#7c5cfc', border: 'none', borderRadius: 2 }}
        lineStyle={{ borderColor: '#7c5cfc' }}
      />
      <Handle type="target" position={Position.Left} style={{ background: '#7c5cfc', width: 10, height: 10, border: 'none' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#7c5cfc', width: 10, height: 10, border: 'none' }} />

      {/* title bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0" style={{ borderColor: '#2a2a2a' }}>
        <span className="text-xs text-muted truncate">{data.name}</span>
        <div className="relative">
          <button
            className="text-muted hover:text-fg w-5 h-5 flex items-center justify-center rounded"
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
          >⋯</button>
          {menuOpen && (
            <div className="absolute right-0 top-6 z-50 rounded shadow-lg py-1 min-w-24" style={{ background: '#1e1e1e', border: '1px solid #2a2a2a' }}>
              <button className="block w-full text-left px-3 py-1 text-xs text-fg hover:bg-surface" onClick={handleRename}>重命名</button>
              <button className="block w-full text-left px-3 py-1 text-xs text-red-400 hover:bg-surface" onClick={handleDelete}>删除</button>
            </div>
          )}
        </div>
      </div>

      {/* content */}
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>

      {/* progress overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: 'rgba(20,20,20,0.8)' }}>
          <div className="w-3/4 h-1 rounded bg-border mb-2" style={{ background: '#2a2a2a' }}>
            <div className="h-full rounded" style={{ width: `${progress}%`, background: '#7c5cfc', transition: 'width 0.4s' }} />
          </div>
          <span className="text-xs text-muted">生成中 {progress}%</span>
        </div>
      )}

      {/* error overlay */}
      {hasError && (
        <div className="absolute bottom-0 inset-x-0 px-3 py-2 text-xs text-red-400" style={{ background: 'rgba(30,0,0,0.8)' }}>
          {data.taskInfo?.error ?? '生成失败，请重试'}
        </div>
      )}
    </div>
  )
}
