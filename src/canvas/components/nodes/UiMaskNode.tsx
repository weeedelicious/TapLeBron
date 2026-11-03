import { useEffect } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useCanvasStore } from '@/store/canvasStore'
import type { CanvasNodeData } from '@/lib/types'

declare global {
  interface Window {
    ShotflowUiMask?: {
      openWorkspace?: (detail: Record<string, unknown>) => void
    }
  }
}

export function UiMaskNode({ id, data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  const setSelected = useCanvasStore((state) => state.setSelected)
  const source = ((nodeData.params as { videoList?: Array<{ url?: string; nodeId?: string }> } | undefined)?.videoList || [])[0]
  const sourceUrl = source?.url || ''
  const popupOpen = Boolean(selected && sourceUrl)

  useEffect(() => {
    if (!popupOpen || !window.ShotflowUiMask?.openWorkspace) return
    window.ShotflowUiMask.openWorkspace({
      url: sourceUrl,
      nodeId: id,
      projectUuid: nodeData.projectUuid,
      name: nodeData.name,
      sourceNodeId: source?.nodeId,
    })
  }, [id, nodeData.name, nodeData.projectUuid, popupOpen, source?.nodeId, sourceUrl])

  const reopen = () => {
    window.ShotflowUiMask?.openWorkspace?.({
      url: sourceUrl,
      nodeId: id,
      projectUuid: nodeData.projectUuid,
      name: nodeData.name,
      sourceNodeId: source?.nodeId,
    })
  }

  return (
    <div style={{ width: 280, position: 'relative' }}>
      <Handle type="target" position={Position.Left} id="video" />
      <Handle type="source" position={Position.Right} id="out" />
      <div style={{ background: '#172331', color: '#dce5ee', border: selected ? '1px solid #49b6a5' : '1px solid #344b62', borderRadius: 14, boxShadow: '0 16px 40px rgba(0,0,0,.35)', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', fontWeight: 650, cursor: 'grab' }}>{nodeData.name || 'UI遮罩'}</div>
        <div style={{ padding: '0 14px 12px', color: sourceUrl ? '#9eb1c4' : '#e8b478', fontSize: 12 }}>
          {sourceUrl ? '点节点打开遮罩创作工作台' : '先把视频连到这个节点'}
        </div>
      </div>
      {popupOpen && (
        <div className="nodrag nopan nowheel" style={{ position: 'absolute', top: 'calc(100% + 12px)', left: 0, width: 320, zIndex: 40, background: '#172331', color: '#dce5ee', border: '1px solid #49b6a5', borderRadius: 14, boxShadow: '0 18px 50px rgba(0,0,0,.45)', padding: 12 }}>
          <strong style={{ fontSize: 14 }}>遮罩创作工作台</strong>
          <p style={{ margin: '8px 0', color: '#9eb1c4', fontSize: 12 }}>主界面是全屏工作台：画面、钢笔、矩形、时间轴和辅助识别都在那里。</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={reopen} style={{ background: '#24766e', border: '1px solid #49b6a5', borderRadius: 6, color: '#e7f1fb', padding: '6px 10px', cursor: 'pointer' }}>打开主界面</button>
            <button type="button" onClick={() => setSelected([])} style={{ background: '#243446', border: '1px solid #486176', borderRadius: 6, color: '#e7f1fb', padding: '6px 10px', cursor: 'pointer' }}>关闭</button>
          </div>
        </div>
      )}
    </div>
  )
}
