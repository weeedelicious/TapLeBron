import { useEffect, useRef } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/lib/types'
import { NodeShell } from '@/components/nodes/NodeShell'
import { useCanvasStore } from '@/store/canvasStore'

declare global {
  interface Window {
    ShotflowUiMask?: {
      openWorkspace?: (detail: Record<string, unknown>) => void
    }
  }
}

/** 节点尺寸跟图片 / 视频节点一致：520 宽，预览按 16:9 */
export const UI_MASK_NODE_WIDTH = 520
export const UI_MASK_NODE_HEIGHT = 380

/**
 * UI 遮罩节点：一张和其它节点同规格、可拖动的卡片。
 * 双击卡片或点按钮打开全屏的遮罩创作工作台（public/ui-mask-bridge.js 注入的 window.ShotflowUiMask）。
 * 选中节点不再自动打开——节点要能拖，拖动必然会选中；只有刚从视频节点创建出来时自动打开一次。
 */
export function UiMaskNode({ id, data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  const params = (nodeData.params ?? {}) as { videoList?: Array<{ url?: string; nodeId?: string }>; openOnCreate?: boolean }
  const source = (params.videoList || [])[0] || null
  const sourceUrl = source?.url || ''
  const openedOnCreate = useRef(false)

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

  // 刚从视频节点创建：自动打开一次，然后清掉标记，刷新或拖动都不会再弹
  useEffect(() => {
    if (!params.openOnCreate || openedOnCreate.current || !sourceUrl) return
    openedOnCreate.current = true
    const { updateNodeData } = useCanvasStore.getState()
    const { openOnCreate: _done, ...rest } = params
    updateNodeData(id, { params: rest as Record<string, unknown> })
    openWorkspace()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.openOnCreate, sourceUrl, id])

  return (
    <NodeShell nodeKey={id} data={data as CanvasNodeData & { nodeKey: string }} selected={selected} minWidth={UI_MASK_NODE_WIDTH} minHeight={300}>
      <div
        onDoubleClick={(event) => {
          event.stopPropagation()
          openWorkspace()
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, height: '100%', boxSizing: 'border-box' }}
      >
        <div
          style={{
            position: 'relative',
            width: '100%',
            aspectRatio: '16 / 9',
            borderRadius: 10,
            overflow: 'hidden',
            background: '#0b1118',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {sourceUrl ? (
            <video
              src={`${sourceUrl}#t=0.1`}
              muted
              playsInline
              preload="metadata"
              draggable={false}
              // 预览只看首帧；不吃指针事件，拖动落到节点本身
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none' }}
            />
          ) : (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e8b478', fontSize: 13 }}>
              先把视频连到这个节点
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ flex: 1, minWidth: 0, color: sourceUrl ? '#9eb1c4' : '#e8b478', fontSize: 12 }}>
            {sourceUrl ? '已连接视频，双击卡片或点右边按钮打开工作台' : '连接视频后可以手画遮罩或 AI 辅助识别'}
          </span>
          <button
            type="button"
            className="nodrag nopan"
            disabled={!sourceUrl}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              openWorkspace()
            }}
            style={{
              flexShrink: 0,
              height: 32,
              padding: '0 14px',
              borderRadius: 8,
              border: '1px solid #3b6d66',
              background: sourceUrl ? '#1d3b37' : '#1a2430',
              color: sourceUrl ? '#dff5ef' : '#6f8193',
              fontSize: 13,
              cursor: sourceUrl ? 'pointer' : 'not-allowed',
            }}
          >
            打开遮罩工作台
          </button>
        </div>
      </div>
    </NodeShell>
  )
}
