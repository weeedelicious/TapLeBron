import type { CanvasNodeData, NodeRef } from './types'

type NodeLike = {
  id: string
  data: CanvasNodeData
}

function cleanText(value: unknown) {
  if (typeof value === 'string') return value.trim()
  if (value == null) return ''
  return String(value).trim()
}

export function textPromptFromNodeData(data?: CanvasNodeData | null) {
  const params = (data?.params ?? {}) as { content?: unknown; prompt?: unknown }
  return cleanText(params.content) || cleanText(params.prompt)
}

export function textPromptFromRefs(textList: NodeRef[] | undefined, nodes: NodeLike[]) {
  const chunks: string[] = []
  const seen = new Set<string>()

  for (const ref of textList ?? []) {
    if (!ref?.nodeId || seen.has(ref.nodeId)) continue
    seen.add(ref.nodeId)

    const refText = cleanText((ref as NodeRef & { content?: unknown }).content)
    const srcNode = nodes.find(node => node.id === ref.nodeId || node.data.nodeKey === ref.nodeId)
    const liveText = textPromptFromNodeData(srcNode?.data)
    const text = liveText || refText

    if (text) chunks.push(text)
  }

  return chunks.join('\n\n').trim()
}
