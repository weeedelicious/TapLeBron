import type { CanvasNodeData } from './types'

// Param keys whose value is a NodeRef[] of upstream generation inputs. These are
// exactly the connections that feed a node's generation (image2image sources,
// reference videos/audio, prompt text nodes), so they define its dependencies
// for ordered auto-generation.
const INPUT_REF_LIST_KEYS = ['imageList', 'videoList', 'audioList', 'textList', 'mixedList'] as const

type NodeRefLike = { nodeId?: string }

/** Collect the node ids this node consumes as generation inputs (deduped). */
export function collectInputNodeIds(params: Record<string, unknown> | undefined | null): string[] {
  if (!params || typeof params !== 'object') return []
  const ids = new Set<string>()
  for (const key of INPUT_REF_LIST_KEYS) {
    const list = (params as Record<string, unknown>)[key]
    if (!Array.isArray(list)) continue
    for (const ref of list as NodeRefLike[]) {
      const nodeId = ref && typeof ref.nodeId === 'string' ? ref.nodeId : ''
      if (nodeId) ids.add(nodeId)
    }
  }
  return [...ids]
}

/**
 * For dependency-ordered "apply & generate": returns true if any upstream input
 * node is still pending — i.e. queued to auto-generate (`_autoGenerate`) or
 * currently generating (`taskInfo.loading`). A node should defer firing its own
 * generation while this is true, so e.g. a video waits for its source image to
 * finish and actually receives the produced image.
 *
 * Nodes that have already settled (produced output, failed, or were never part
 * of the batch) are not pending, so a failed/absent upstream never deadlocks the
 * chain — the downstream fires with whatever inputs exist.
 */
export function hasPendingUpstream(
  params: Record<string, unknown> | undefined | null,
  getNodeData: (nodeId: string) => CanvasNodeData | undefined,
): boolean {
  for (const nodeId of collectInputNodeIds(params)) {
    const upstream = getNodeData(nodeId)
    if (!upstream) continue
    if (upstream._autoGenerate || upstream.taskInfo?.loading) return true
  }
  return false
}
