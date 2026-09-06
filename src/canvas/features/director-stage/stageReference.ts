/**
 * 三维空间节点的参考图输入。
 *
 * 用途只有一个：**从这张图里分析出人物姿势，套到白模上**（2026-08-26 你定的用法）。
 * 它不进 3D 场景、不进出图画面 —— 分析完就不显示，所以它是「输入」而不是「场景状态」。
 *
 * 因此它存在 `params.stageRef`，**不进 `params.stage`**：
 *   · `params.stage`（`DirectorStageState`）是要落库的场景状态，有序列化体积守卫；
 *   · 参考图是一条指向别的节点的引用，跟 `panoramaRef` 同类，生命周期也一样
 *     （上游节点被删就得清空，见 Canvas.tsx 的删除清理块）。
 *
 * 形状照 `features/panorama/PanoramaViewerNode.tsx:35 resolvePanoramaViewerSource`：
 * 实时按 `nodeId` 去节点表里取上游**当前**的主图，`ref.url` 只是上游被删掉时的兜底快照。
 * 不这么做的话，上游「设为主图」换了一张，这边还在分析旧的那张。
 */
import { primaryOutputUrl } from '@/lib/primaryOutput'
import type { CanvasNodeData } from '@/lib/types'

export interface StageReferenceRef {
  nodeId?: string
  url?: string
  name?: string
}

export interface StageReference {
  /** 当前该分析哪张图；空串表示没有可用的参考图 */
  url: string
  name: string
  nodeId: string
  /** 连过但上游已经不见了（ref 还在、节点没了）—— 界面要说人话而不是静静地什么都不做 */
  missing: boolean
}

const EMPTY: StageReference = { url: '', name: '', nodeId: '', missing: false }

export function readStageRef(params: unknown): StageReferenceRef | null {
  const source = (params ?? {}) as Record<string, unknown>
  const ref = source.stageRef
  if (!ref || typeof ref !== 'object') return null
  const { nodeId, url, name } = ref as Record<string, unknown>
  const out: StageReferenceRef = {}
  if (typeof nodeId === 'string' && nodeId.trim()) out.nodeId = nodeId.trim()
  if (typeof url === 'string' && url.trim()) out.url = url.trim()
  if (typeof name === 'string' && name.trim()) out.name = name.trim()
  return out.nodeId || out.url ? out : null
}

export function resolveStageReference(
  params: unknown,
  nodes: Array<{ id: string; data: CanvasNodeData & { nodeKey?: string } }>,
): StageReference {
  const ref = readStageRef(params)
  if (!ref) return EMPTY

  const upstream = ref.nodeId
    ? nodes.find((node) => node.id === ref.nodeId || node.data.nodeKey === ref.nodeId)
    : undefined

  // 上游还在就按它当前的主图走（跟着「设为主图」变），没了才退回快照
  const liveUrl = upstream ? primaryOutputUrl(upstream.data) : ''
  const url = liveUrl || ref.url || ''

  return {
    url,
    name: String(upstream?.data.name || ref.name || '参考图'),
    nodeId: ref.nodeId ?? '',
    missing: Boolean(ref.nodeId) && !upstream,
  }
}

/** 上游被删时把 ref 清掉。返回 null 表示不用改。 */
export function clearedStageRef(params: unknown, removedNodeIds: Set<string>) {
  const ref = readStageRef(params)
  if (!ref?.nodeId || !removedNodeIds.has(ref.nodeId)) return null
  return { stageRef: null }
}
