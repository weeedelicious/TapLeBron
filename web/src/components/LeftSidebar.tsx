import { useState } from 'react'
import { useCanvasStore } from '@/store/canvasStore'
import { AddNodeMenu } from './AddNodeMenu'
import { Toolbox } from './Toolbox'
import type { CanvasNodeData } from '@/lib/types'

type Panel = 'none' | 'add' | 'toolbox' | 'assets' | 'history'

type SelectedNodeArg = {
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
} | null | undefined

export function LeftSidebar() {
  const [panel, setPanel] = useState<Panel>('none')
  const { selectedNodeKeys, nodes } = useCanvasStore()

  const selectedNodeRaw = selectedNodeKeys.length === 1
    ? nodes.find(n => n.data.nodeKey === selectedNodeKeys[0])
    : null
  const selectedNode: SelectedNodeArg = selectedNodeRaw ?? null

  const toggle = (p: Panel) => setPanel(prev => prev === p ? 'none' : p)

  const btnStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
    color: active ? '#e5e5e5' : '#8a8a8a',
    background: active ? '#2a2a2a' : 'transparent',
    border: 'none', width: '100%', textAlign: 'left',
    transition: 'background 0.1s',
  })

  return (
    <div style={{ display: 'flex', height: '100%', position: 'absolute', left: 0, top: 0, zIndex: 10, pointerEvents: 'none' }}>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, background: '#1e1e1e', borderRight: '1px solid #2a2a2a', pointerEvents: 'all', width: 120 }}
      >
        <button style={btnStyle(panel === 'add')} onClick={() => toggle('add')}>
          <span>＋</span> 添加节点
        </button>
        <button style={btnStyle(panel === 'toolbox')} onClick={() => toggle('toolbox')}>
          <span>⚒</span> 工具箱
        </button>
        <button style={btnStyle(panel === 'assets')} onClick={() => toggle('assets')}>
          <span>🗂</span> 我的素材
        </button>
        <button style={btnStyle(panel === 'history')} onClick={() => toggle('history')}>
          <span>🕐</span> 历史记录
        </button>
      </div>

      {panel !== 'none' && (
        <div
          style={{ background: '#1e1e1e', borderRight: '1px solid #2a2a2a', pointerEvents: 'all', width: 260, overflowY: 'auto' }}
        >
          {panel === 'add' && <AddNodeMenu onClose={() => setPanel('none')} />}
          {panel === 'toolbox' && <Toolbox selectedNode={selectedNode} />}
          {panel === 'assets' && <AssetsPanel />}
          {panel === 'history' && <HistoryPanel />}
        </div>
      )}
    </div>
  )
}

function AssetsPanel() {
  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#e5e5e5', marginBottom: 12 }}>我的素材</div>
      <div style={{ fontSize: 12, color: '#8a8a8a' }}>暂无素材。上传节点中的文件会自动收录。</div>
    </div>
  )
}

function HistoryPanel() {
  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#e5e5e5', marginBottom: 12 }}>历史记录</div>
      <div style={{ fontSize: 12, color: '#8a8a8a' }}>暂无生成历史。</div>
    </div>
  )
}
