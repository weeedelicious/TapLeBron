import type { Edge, Node } from '@xyflow/react'
import type {
  CanvasNodeData,
  FavoriteLibraryCreatePayload,
  FavoriteLibraryItemType,
  FavoriteLibraryPayload,
  ResourceMeta,
} from './types'

type FlowNodeLike = Node & { data: CanvasNodeData & { nodeKey: string; projectUuid: string } }

function cleanText(value: unknown, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

function mediaKindFromNode(data: CanvasNodeData): 'image' | 'video' | null {
  if (data.type === 'image' || data.type === 'director_stage') return 'image'
  if (data.type === 'video' || data.type === 'video_merge' || data.type === 'video_compare') return 'video'
  const metaKind = data._resourceMeta?.items?.find((item) => item?.kind === 'image' || item?.kind === 'video')?.kind
  if (metaKind === 'image' || metaKind === 'video') return metaKind
  const url = data.url?.[0] ?? ''
  if (/\.(mp4|mov|m4v|webm|avi|mkv)(?:[?#].*)?$/i.test(url)) return 'video'
  if (/\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/i.test(url)) return 'image'
  return null
}

function itemTypeFromRoot(root?: FlowNodeLike): FavoriteLibraryItemType {
  if (!root) return 'node'
  if (root.type === 'group' || root.data.type === 'group') return 'group'
  return mediaKindFromNode(root.data) ?? 'node'
}

function previewUrlFromNode(data: CanvasNodeData) {
  const primaryUrl = typeof data._primaryAssetUrl === 'string' ? data._primaryAssetUrl : ''
  const firstUrl = data.url?.find((url): url is string => typeof url === 'string' && url.trim().length > 0) ?? ''
  const items = (data._resourceMeta?.items ?? []) as ResourceMeta[]
  const metaPreview =
    items.find((item) => item.displayUrl)?.displayUrl ??
    items.find((item) => item.originalUrl)?.originalUrl ??
    ''
  return primaryUrl || data.poster || firstUrl || metaPreview
}

function previewUrlFromNodes(nodes: FlowNodeLike[]) {
  const mediaNode =
    nodes.find((node) => mediaKindFromNode(node.data) === 'image' && previewUrlFromNode(node.data)) ??
    nodes.find((node) => mediaKindFromNode(node.data) === 'video' && previewUrlFromNode(node.data))
  return mediaNode ? previewUrlFromNode(mediaNode.data) : ''
}

function escapeXml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(value: unknown) {
  return escapeXml(value).replace(/"/g, '&quot;')
}

function numeric(value: unknown, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function nodePreviewWidth(node: FlowNodeLike) {
  return Math.max(
    36,
    numeric(node.data.contentWidth, numeric(node.width, numeric(node.measured?.width, numeric(node.style?.width, 220))))
  )
}

function nodePreviewHeight(node: FlowNodeLike) {
  return Math.max(
    28,
    numeric(node.data.contentHeight, numeric(node.height, numeric(node.measured?.height, numeric(node.style?.height, 140))))
  )
}

function nodePreviewLabel(node: FlowNodeLike) {
  return cleanText(node.data.name, node.data.type || node.type || 'node')
}

function nodePreviewResolution(node: FlowNodeLike) {
  const data = node.data
  const width =
    numeric((data.params as Record<string, unknown> | undefined)?.width) ||
    numeric(data.imageWidth) ||
    numeric(data.videoWidth)
  const height =
    numeric((data.params as Record<string, unknown> | undefined)?.height) ||
    numeric(data.imageHeight) ||
    numeric(data.videoHeight)
  if (width > 0 && height > 0) return `${Math.round(width)} x ${Math.round(height)}`
  const resolution = cleanText((data.params as Record<string, unknown> | undefined)?.resolution)
  return resolution
}

function truncatePreviewText(value: unknown, maxLength: number) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}

function previewContentFromNode(node: FlowNodeLike) {
  const data = node.data
  const url = previewUrlFromNode(data)
  if (url && !/\.(mp4|mov|m4v|webm|avi|mkv)(?:[?#].*)?$/i.test(url)) return { kind: 'image' as const, url }
  const params = (data.params ?? {}) as Record<string, unknown>
  const text = truncatePreviewText(
    params.content ?? params.prompt ?? data.description ?? data.name ?? data.type,
    150
  )
  return { kind: 'text' as const, text }
}

function buildGroupPreviewUrl(nodes: FlowNodeLike[], edges: Edge[]) {
  const visibleNodes = nodes
    .filter(node => node.type !== 'group' && node.data.type !== 'group')
    .slice(0, 36)
  if (visibleNodes.length === 0) return previewUrlFromNodes(nodes)

  const canvasWidth = 760
  const canvasHeight = 520
  const margin = 32
  const bounds = visibleNodes.reduce((box, node) => {
    const width = nodePreviewWidth(node)
    const height = nodePreviewHeight(node)
    return {
      minX: Math.min(box.minX, node.position.x),
      minY: Math.min(box.minY, node.position.y),
      maxX: Math.max(box.maxX, node.position.x + width),
      maxY: Math.max(box.maxY, node.position.y + height),
    }
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })

  const rawWidth = Math.max(1, bounds.maxX - bounds.minX)
  const rawHeight = Math.max(1, bounds.maxY - bounds.minY)
  const scale = Math.min(
    (canvasWidth - margin * 2) / rawWidth,
    (canvasHeight - margin * 2) / rawHeight,
    0.48
  )
  const offsetX = margin + (canvasWidth - margin * 2 - rawWidth * scale) / 2
  const offsetY = margin + (canvasHeight - margin * 2 - rawHeight * scale) / 2

  const nodeBoxes = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const node of visibleNodes) {
    const w = nodePreviewWidth(node) * scale
    const h = nodePreviewHeight(node) * scale
    nodeBoxes.set(node.id, {
      x: offsetX + (node.position.x - bounds.minX) * scale,
      y: offsetY + (node.position.y - bounds.minY) * scale,
      w,
      h,
    })
  }

  const edgeSvg = edges
    .filter(edge => nodeBoxes.has(edge.source) && nodeBoxes.has(edge.target))
    .slice(0, 80)
    .map(edge => {
      const source = nodeBoxes.get(edge.source)!
      const target = nodeBoxes.get(edge.target)!
      const sx = source.x + source.w
      const sy = source.y + source.h / 2
      const tx = target.x
      const ty = target.y + target.h / 2
      const bend = Math.max(32, Math.abs(tx - sx) * 0.45)
      return `<path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${(sx + bend).toFixed(1)} ${sy.toFixed(1)}, ${(tx - bend).toFixed(1)} ${ty.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}" fill="none" stroke="rgba(107,166,234,0.28)" stroke-width="1.4"/>`
    })
    .join('')

  const nodeSvg = visibleNodes.map(node => {
    const box = nodeBoxes.get(node.id)!
    const content = previewContentFromNode(node)
    const label = truncatePreviewText(nodePreviewLabel(node), 24)
    const resolution = truncatePreviewText(nodePreviewResolution(node), 12)
    const labelY = Math.max(12, box.y - 6)
    const header = [
      `<text x="${box.x.toFixed(1)}" y="${labelY.toFixed(1)}" fill="rgba(241,238,255,0.9)" font-family="Inter, Arial, sans-serif" font-size="10" font-weight="700">${escapeXml(label)}</text>`,
      resolution
        ? `<text x="${(box.x + box.w).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="end" fill="rgba(205,193,255,0.68)" font-family="Inter, Arial, sans-serif" font-size="9">${escapeXml(resolution)}</text>`
        : '',
    ].join('')

    const body = content.kind === 'image'
      ? `<rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}" rx="3" fill="#11101a"/><image href="${escapeAttr(content.url)}" x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}" rx="4" fill="#11101a" stroke="rgba(205,190,255,0.16)"/><text x="${(box.x + 8).toFixed(1)}" y="${(box.y + 18).toFixed(1)}" fill="rgba(255,255,255,0.82)" font-family="Inter, Arial, sans-serif" font-size="9">${escapeXml(content.text)}</text>`

    return `<g>${header}${body}</g>`
  }).join('')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
    <rect width="100%" height="100%" fill="#111111"/>
    <pattern id="grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M 18 0 L 0 0 0 18" fill="none" stroke="rgba(255,255,255,0.045)" stroke-width="1"/></pattern>
    <rect width="100%" height="100%" fill="url(#grid)"/>
    ${edgeSvg}
    ${nodeSvg}
  </svg>`

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function collectNodeIds(rootIds: string[], nodes: FlowNodeLike[]) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const collected = new Set<string>()

  const collect = (nodeId: string) => {
    if (collected.has(nodeId)) return
    const node = nodeMap.get(nodeId)
    if (!node) return
    collected.add(node.id)
    if (node.type !== 'group' && node.data.type !== 'group') return
    const params = (node.data.params ?? {}) as { childIds?: string[] }
    ;(params.childIds ?? []).forEach(collect)
  }

  rootIds.forEach(collect)
  return collected
}

function typeTag(type: FavoriteLibraryItemType) {
  if (type === 'image') return 'image'
  if (type === 'video') return 'video'
  if (type === 'group') return 'group'
  return 'node'
}

function defaultTitle(root: FlowNodeLike | undefined, type: FavoriteLibraryItemType, count: number) {
  const name = cleanText(root?.data.name)
  if (name) return name
  if (type === 'group') return `Group ${count} nodes`
  if (type === 'image') return 'Image favorite'
  if (type === 'video') return 'Video favorite'
  return 'Node favorite'
}

export function buildFavoriteCreatePayload(
  rootIds: string[],
  nodes: FlowNodeLike[],
  edges: Edge[],
  options: {
    projectUuid?: string | null
    projectName?: string
    shared?: boolean
  } = {}
): FavoriteLibraryCreatePayload | null {
  const normalizedRootIds = rootIds.filter(Boolean)
  if (normalizedRootIds.length === 0) return null
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const collectedIds = collectNodeIds(normalizedRootIds, nodes)
  if (collectedIds.size === 0) return null

  const root = nodeMap.get(normalizedRootIds[0])
  const itemType = itemTypeFromRoot(root)
  const selectedNodes = nodes.filter((node) => collectedIds.has(node.id))
  const selectedEdges = edges.filter((edge) => collectedIds.has(edge.source) && collectedIds.has(edge.target))
  const payload: FavoriteLibraryPayload = {
    version: 1,
    rootIds: normalizedRootIds.filter((id) => collectedIds.has(id)),
    nodes: cloneJson(selectedNodes.map((node) => ({ ...node, selected: false }))) as Array<Record<string, unknown>>,
    edges: cloneJson(selectedEdges.map((edge) => ({ ...edge, selected: false }))) as Array<Record<string, unknown>>,
    sourceProjectUuid: options.projectUuid ?? undefined,
    sourceProjectName: options.projectName,
  }

  const tags = [typeTag(itemType)]
  if (selectedNodes.length > 1) tags.push('multi-node')
  if (options.shared) tags.push('shared')

  return {
    itemType,
    sourceProjectUuid: payload.sourceProjectUuid,
    sourceRootKey: payload.rootIds.join('|'),
    title: defaultTitle(root, itemType, selectedNodes.length),
    description: selectedNodes.length > 1 ? `${selectedNodes.length} nodes` : typeTag(itemType),
    previewUrl: itemType === 'group' || selectedNodes.length > 1
      ? buildGroupPreviewUrl(selectedNodes, selectedEdges)
      : previewUrlFromNodes(selectedNodes),
    nodeCount: selectedNodes.length,
    shared: Boolean(options.shared),
    tags,
    payload,
  }
}
