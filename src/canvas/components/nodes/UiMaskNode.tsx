import { useEffect, useRef, useState } from 'react'
import { addEdge } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '@/lib/types'
import { NodeShell } from '@/components/nodes/NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { videoVariantsForUrl } from '@/lib/mediaPreview'

declare global {
  interface Window {
    ShotflowUiMask?: {
      openWorkspace?: (detail: Record<string, unknown>) => void
    }
  }
}

type UiMaskOutput = { sourceUrl?: string; url?: string; category?: string; mode?: string }
type UiMaskParams = { videoList?: Array<{ url?: string; nodeId?: string }>; openOnCreate?: boolean; placedOutputs?: string[] }

const OUTPUT_LABELS: Record<string, string> = { static: '静态遮罩', dynamic: '动态遮罩', model: '模型遮罩' }

/** 这个结果（工作台里的任务地址）是否已经放到画布过 */
function outputPlaced(nodeId: string, sourceUrl: string) {
  const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
  const placed = ((node?.data.params ?? {}) as UiMaskParams).placedOutputs || []
  return placed.includes(sourceUrl)
}

/** 盖黑视频生成好后：在遮罩节点右边新建一个视频节点，并从遮罩节点连线过去 */
function placeOutput(nodeId: string, output: UiMaskOutput) {
  const url = output.url || ''
  const key = output.sourceUrl || url
  if (!url || !key || outputPlaced(nodeId, key)) return
  const state = useCanvasStore.getState()
  const self = state.nodes.find((item) => item.id === nodeId)
  if (!self) return
  const params = (self.data.params ?? {}) as UiMaskParams
  const outgoing = state.edges.filter((edge) => edge.source === nodeId).length
  const width = Number(self.measured?.width ?? self.width ?? UI_MASK_NODE_WIDTH) || UI_MASK_NODE_WIDTH
  const created = state.addNodeAt('video', self.position.x + width + 140, self.position.y + outgoing * 420, {
    name: `${self.data.name || 'UI遮罩'} ${OUTPUT_LABELS[output.category || ''] || '盖黑视频'}`,
    url: [url],
    action: 'image_resource',
  })
  // 连线从不单独存库，刷新时按节点数据重算（canvasStore edgesFromNodeReferences）。
  // 在新视频节点上记下来源遮罩节点，刷新后这根线才画得回来；不进 videoList，免得被当成生成参考。
  state.updateNodeData(created.id, {
    params: { ...((created.data.params ?? {}) as Record<string, unknown>), uiMaskSourceRef: { nodeId } },
  })
  const latest = useCanvasStore.getState()
  const edgeId = `e-${nodeId}-${created.id}`
  if (!latest.edges.some((edge) => edge.id === edgeId)) {
    latest.setEdges(addEdge({ id: edgeId, source: nodeId, target: created.id, type: 'glow', selectable: true, interactionWidth: 34 }, latest.edges))
  }
  latest.updateNodeData(nodeId, {
    params: { ...params, placedOutputs: [...(params.placedOutputs || []), key].slice(-50) } as Record<string, unknown>,
  })
}

/** 节点尺寸跟视频 / 图片节点同一套规则：按视频比例放进 520 × 400 的框里，最窄 220 */
export const UI_MASK_NODE_WIDTH = 520
export const UI_MASK_NODE_HEIGHT = 400
const UI_MASK_NODE_MIN_WIDTH = 220

function fitFrameToAspect(w: number, h: number, maxWidth: number, maxHeight: number, minWidth: number) {
  const safeW = Math.max(1, w)
  const safeH = Math.max(1, h)
  let width = maxWidth
  let height = width * (safeH / safeW)
  if (height > maxHeight) {
    height = maxHeight
    width = height * (safeW / safeH)
  }
  width = Math.max(minWidth, width)
  return { width: Math.round(width), height: Math.round(height) }
}

/**
 * UI 遮罩节点：外观和尺寸跟视频节点一样——画面铺满节点，比例跟着源视频走。
 * 双击节点或点画面上的按钮打开全屏的遮罩创作工作台（public/ui-mask-bridge.js 注入的 window.ShotflowUiMask）。
 * 选中节点不再自动打开——节点要能拖，拖动必然会选中；只有刚从视频节点创建出来时自动打开一次。
 */
export function UiMaskNode({ id, data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData
  const params = (nodeData.params ?? {}) as UiMaskParams
  const source = (params.videoList || [])[0] || null
  const sourceUrl = source?.url || ''
  const openedOnCreate = useRef(false)
  const [hovered, setHovered] = useState(false)
  // 源视频节点上记着这条视频的宽高和封面图（新视频才有）；没有就等 <video> 读到元数据
  const sourceVariants = useCanvasStore((state) => {
    if (!sourceUrl) return null
    const sourceNode = state.nodes.find((node) => node.id === source?.nodeId || node.data.nodeKey === source?.nodeId)
    return sourceNode ? videoVariantsForUrl(sourceNode.data, sourceUrl) : null
  })
  const [metaSize, setMetaSize] = useState<{ w: number; h: number } | null>(null)
  const aspectW = Number(sourceVariants?.width) || metaSize?.w || 16
  const aspectH = Number(sourceVariants?.height) || metaSize?.h || 9
  const frame = fitFrameToAspect(aspectW, aspectH, UI_MASK_NODE_WIDTH, UI_MASK_NODE_HEIGHT, UI_MASK_NODE_MIN_WIDTH)
  const posterUrl = String(sourceVariants?.posterUrl || '')

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
      isPlaced: (sourceUrl: string) => outputPlaced(id, sourceUrl),
      onOutput: (output: UiMaskOutput) => placeOutput(id, output),
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
    <NodeShell
      nodeKey={id}
      data={data as CanvasNodeData & { nodeKey: string }}
      selected={selected}
      minWidth={frame.width}
      maxWidth={frame.width}
      minHeight={frame.height}
      bodyStyle={sourceUrl ? { background: 'transparent', overflow: 'visible' } : undefined}
    >
      <div
        onDoubleClick={(event) => {
          event.stopPropagation()
          openWorkspace()
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: 'relative',
          width: frame.width,
          height: frame.height,
          borderRadius: 'inherit',
          overflow: 'hidden',
          background: '#0b1118',
        }}
      >
        {sourceUrl ? (
          posterUrl ? (
            <img
              src={posterUrl}
              alt=""
              draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
            />
          ) : (
            <video
              src={`${sourceUrl}#t=0.1`}
              muted
              playsInline
              preload="metadata"
              draggable={false}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget
                if (video.videoWidth && video.videoHeight) setMetaSize({ w: video.videoWidth, h: video.videoHeight })
              }}
              // 预览只看首帧；不吃指针事件，拖动落到节点本身
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
            />
          )
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', color: '#e8b478', fontSize: 13 }}>
            先把视频连到这个节点
          </div>
        )}
        {sourceUrl ? (
          <button
            type="button"
            className="nodrag nopan"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              openWorkspace()
            }}
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 14,
              transform: 'translateX(-50%)',
              padding: '9px 20px',
              border: 0,
              borderRadius: 999,
              background: 'rgba(255,255,255,0.94)',
              color: '#1c1c1c',
              fontSize: 14,
              fontWeight: 650,
              letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
              boxShadow: '0 10px 28px rgba(0,0,0,0.28)',
              cursor: 'pointer',
              // 平时只露画面，鼠标移上来或选中时才出按钮，跟视频节点一样干净
              opacity: hovered || selected ? 1 : 0,
              pointerEvents: hovered || selected ? 'auto' : 'none',
              transition: 'opacity 0.15s ease',
            }}
          >
            打开遮罩工作台
          </button>
        ) : null}
      </div>
    </NodeShell>
  )
}
