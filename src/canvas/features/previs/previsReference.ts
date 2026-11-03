import { primaryOutputUrl } from '@/lib/primaryOutput'
import type { CanvasNodeData } from '@/lib/types'

export interface PrevisReferenceRef {
  nodeId?: string
  url?: string
  name?: string
}

export interface PrevisReference {
  url: string
  name: string
  nodeId: string
  missing: boolean
}

const EMPTY: PrevisReference = { url: '', name: '', nodeId: '', missing: false }

export function readPrevisRef(params: unknown): PrevisReferenceRef | null {
  const source = (params ?? {}) as Record<string, unknown>
  const ref = source.previsRef
  if (!ref || typeof ref !== 'object') return null
  const { nodeId, url, name } = ref as Record<string, unknown>
  const out: PrevisReferenceRef = {}
  if (typeof nodeId === 'string' && nodeId.trim()) out.nodeId = nodeId.trim()
  if (typeof url === 'string' && url.trim()) out.url = url.trim()
  if (typeof name === 'string' && name.trim()) out.name = name.trim()
  return out.nodeId || out.url ? out : null
}

export function resolvePrevisReference(
  params: unknown,
  nodes: Array<{ id: string; data: CanvasNodeData & { nodeKey?: string } }>,
): PrevisReference {
  const ref = readPrevisRef(params)
  if (!ref) return EMPTY
  const upstream = ref.nodeId
    ? nodes.find((node) => node.id === ref.nodeId || node.data.nodeKey === ref.nodeId)
    : undefined
  const liveUrl = upstream ? primaryOutputUrl(upstream.data) : ''
  const url = liveUrl || ref.url || ''
  return {
    url,
    name: String(upstream?.data.name || ref.name || '参考图'),
    nodeId: ref.nodeId ?? '',
    missing: Boolean(ref.nodeId) && !upstream,
  }
}

export function clearedPrevisRef(params: unknown, removedNodeIds: Set<string>) {
  const ref = readPrevisRef(params)
  if (!ref?.nodeId || !removedNodeIds.has(ref.nodeId)) return null
  return { previsRef: null }
}
