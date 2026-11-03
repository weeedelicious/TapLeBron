import { useEffect } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/lib/types'

declare global {
  interface Window {
    ShotflowUiMask?: {
      openWorkspace?: (detail: Record<string, unknown>) => void
    }
  }
}

/**
 * UI 遮罩节点：本身只是一张入口卡片。选中或点击时打开全屏的遮罩创作工作台
 * （public/ui-mask-bridge.js 注入的 window.ShotflowUiMask），工作台在画布之外独立运行。
 */
export function UiMaskNode({ id, data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  const source = ((nodeData.params as { videoList?: Array<{ url?: string; nodeId?: string }> } | undefined)?.videoList || [])[0] || null
  const sourceUrl = source?.url || ''

  const openWorkspace = () => {
    if (!sourceUrl) return
    const api = window.ShotflowUiMask
    if (!api || typeof api.openWorkspace !== 'function') {
      window.alert('遮罩工作台没有加载，请强制刷新后再点一次')
      return
    }
    api.openWorkspace({
      url: sourceUrl,
      nodeId: id,
      projectUuid: nodeData.projectUuid,
      name: nodeData.name,
      sourceNodeId: source?.nodeId,
    })
  }

  useEffect(() => {
    if (selected) openWorkspace()
    // 只在选中或连接的视频变化时打开一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, sourceUrl, id, nodeData.projectUuid, nodeData.name, source?.nodeId])

  return (
    <div style={{ width: 280, position: 'relative' }}>
      <Handle type="target" position={Position.Left} id="video" />
      <div
        className="nodrag"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          openWorkspace()
        }}
        style={{
          background: '#172331',
          color: '#dce5ee',
          border: selected ? '1px solid #49b6a5' : '1px solid #344b62',
          borderRadius: 14,
          boxShadow: '0 16px 40px rgba(0,0,0,.35)',
          overflow: 'hidden',
          cursor: sourceUrl ? 'pointer' : 'default',
        }}
      >
        <div style={{ padding: '12px 14px', fontWeight: 650 }}>{nodeData.name || 'UI遮罩'}</div>
        <div style={{ padding: '0 14px 12px', color: sourceUrl ? '#9eb1c4' : '#e8b478', fontSize: 12 }}>
          {sourceUrl ? '已连接视频，点这里打开工作台' : '先把视频连到这个节点'}
        </div>
      </div>
    </div>
  )
}
