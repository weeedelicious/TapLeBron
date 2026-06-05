import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Node, Edge, Viewport } from '@xyflow/react'
import type { CanvasNode, CanvasNodeData, Project } from '@/lib/types'
import { NODE_TYPE_INT, makeNodeData, NODE_LABELS } from '@/lib/nodeData'
import { nodesApi, projectsApi } from '@/lib/api'
import { debounce } from '@/lib/debounce'

export type FlowNode = Node & { data: CanvasNodeData & { nodeKey: string; projectUuid: string } }

interface HistorySnapshot { nodes: FlowNode[]; edges: Edge[] }

interface CanvasState {
  projectUuid: string | null
  projectName: string
  nodes: FlowNode[]
  edges: Edge[]
  viewport: Viewport
  selectedNodeKeys: string[]
  isDirty: boolean
  isSaving: boolean
  clipboard: { nodes: FlowNode[]; edges: Edge[] } | null
  history: HistorySnapshot[]
  historyIndex: number

  loadProject: (project: Project) => void
  setProjectUuid: (uuid: string) => void
  setNodes: (nodes: FlowNode[]) => void
  setEdges: (edges: Edge[]) => void
  setViewport: (vp: Viewport) => void
  setSelected: (keys: string[]) => void
  addNode: (type: string) => FlowNode
  addNodeAt: (type: string, x: number, y: number, extraData?: Partial<CanvasNodeData>) => FlowNode
  deleteNodes: (nodeKeys: string[]) => void
  updateNodeData: (nodeKey: string, patch: Partial<CanvasNodeData>) => void
  updateNodePosition: (nodeKey: string, x: number, y: number) => void
  updateNodeSize: (nodeKey: string, w: number, h: number) => void
  persistNodes: () => Promise<void>
  persistViewport: () => Promise<void>
  groupNodes: (nodeIds: string[]) => void
  copySelected: () => void
  pasteClipboard: () => void
  pushHistory: () => void
  undo: () => void
  ungroupNodes: (groupId: string) => void
  duplicateNodes: (nodeIds: string[]) => void
}

const debouncedPersistNodes = debounce(async (
  projectUuid: string,
  nodes: FlowNode[],
  setState: (s: Partial<CanvasState>) => void
) => {
  setState({ isSaving: true })
  const canvasNodes: CanvasNode[] = nodes.map(n => ({
    nodeKey: n.data.nodeKey,
    projectUuid,
    type: NODE_TYPE_INT[n.data.type] ?? 2,
    name: n.data.name,
    position: { positionX: n.position.x, positionY: n.position.y },
    measured: { width: n.measured?.width ?? n.data.contentWidth ?? 620, height: n.measured?.height ?? n.data.contentHeight ?? 350 },
    data: JSON.stringify(n.data),
    status: 1,
  }))
  try {
    await nodesApi.batchSave(projectUuid, canvasNodes)
    setState({ isDirty: false })
  } finally {
    setState({ isSaving: false })
  }
}, 500)

const debouncedPersistViewport = debounce(async (
  projectUuid: string,
  viewport: Viewport
) => {
  await projectsApi.saveDraft(projectUuid, {
    projectUuid,
    viewportX: viewport.x,
    viewportY: viewport.y,
    viewportZoom: viewport.zoom,
  })
}, 600)

export const useCanvasStore = create<CanvasState>((set, get) => ({
  projectUuid: null,
  projectName: '未命名项目',
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  selectedNodeKeys: [],
  isDirty: false,
  isSaving: false,
  clipboard: null,
  history: [],
  historyIndex: -1,

  loadProject: (project: Project) => {
    const nodes: FlowNode[] = project.nodeList.map(cn => {
      let data: CanvasNodeData
      try { data = JSON.parse(cn.data) } catch { data = { type: 'upload', name: cn.name, url: [], action: 'image_resource' } }
      // Cap image/video node widths so they don't stretch across canvas
      const MAX_W: Partial<Record<string, number>> = { image: 520, video: 520 }
      const storedW = Number(cn.measured?.width ?? 520)
      const cappedW = MAX_W[data.type] ? Math.min(storedW, MAX_W[data.type]!) : storedW
      return {
        id: cn.nodeKey,
        type: data.type,
        position: { x: Number(cn.position.positionX), y: Number(cn.position.positionY) },
        data: { ...data, nodeKey: cn.nodeKey, projectUuid: cn.projectUuid },
        width: cappedW || undefined,
        draggable: true,
        selectable: true,
      }
    })

    // Reconstruct edges from node ref lists (imageList/videoList/audioList/textList)
    const nodeIds = new Set(nodes.map(n => n.id))
    const edgeSet = new Set<string>()
    const edges: Edge[] = []
    for (const node of nodes) {
      const params = (node.data.params ?? {}) as Record<string, unknown>
      for (const listKey of ['imageList', 'videoList', 'audioList', 'textList']) {
        const list = (params[listKey] ?? []) as Array<{ nodeId: string }>
        for (const ref of list) {
          if (ref.nodeId && nodeIds.has(ref.nodeId)) {
            const eid = `e-${ref.nodeId}-${node.id}`
            if (!edgeSet.has(eid)) {
              edgeSet.add(eid)
              edges.push({ id: eid, source: ref.nodeId, target: node.id, type: 'glow' })
            }
          }
        }
      }
    }

    const { viewportX, viewportY, viewportZoom } = project.projectDraft
    set({
      projectUuid: project.projectMeta.uuid,
      projectName: project.projectMeta.name,
      nodes,
      edges,
      viewport: { x: Number(viewportX), y: Number(viewportY), zoom: Number(viewportZoom) },
      isDirty: false,
    })
  },

  setProjectUuid: (uuid) => set({ projectUuid: uuid }),
  setNodes: (nodes) => {
    set({ nodes, isDirty: true })
    const { projectUuid } = get()
    if (projectUuid) debouncedPersistNodes(projectUuid, nodes, set as (s: Partial<CanvasState>) => void)
  },
  setEdges: (edges) => set({ edges }),
  setViewport: (viewport) => {
    set({ viewport })
    const { projectUuid } = get()
    if (projectUuid) debouncedPersistViewport(projectUuid, viewport)
  },
  setSelected: (keys) => set({ selectedNodeKeys: keys }),

  addNode: (type: string) => {
    const { projectUuid, nodes, viewport } = get()
    const nodeKey = uuidv4()
    const name = `${NODE_LABELS[type] ?? type} ${nodes.filter(n => n.data.type === type).length + 1}`
    const data = makeNodeData(type, name)
    // Place near center of viewport
    const x = (-viewport.x + window.innerWidth / 2) / viewport.zoom
    const y = (-viewport.y + window.innerHeight / 2) / viewport.zoom
    const newNode: FlowNode = {
      id: nodeKey,
      type,
      position: { x, y },
      data: { ...data, nodeKey, projectUuid: projectUuid ?? '' },
      draggable: true,
      selectable: true,
    }
    const updated = [...nodes, newNode]
    set({ nodes: updated, isDirty: true })
    if (projectUuid) debouncedPersistNodes(projectUuid, updated, set as (s: Partial<CanvasState>) => void)
    return newNode
  },

  addNodeAt: (type: string, x: number, y: number, extraData?: Partial<CanvasNodeData>) => {
    const { projectUuid, nodes } = get()
    const nodeKey = uuidv4()
    const name = `${NODE_LABELS[type] ?? type} ${nodes.filter(n => n.data.type === type).length + 1}`
    const data = makeNodeData(type, name)
    const newNode: FlowNode = {
      id: nodeKey,
      type,
      position: { x, y },
      data: { ...data, ...extraData, nodeKey, projectUuid: projectUuid ?? '' },
      draggable: true,
      selectable: true,
    }
    const updated = [...nodes, newNode]
    set({ nodes: updated, isDirty: true })
    if (projectUuid) debouncedPersistNodes(projectUuid, updated, set as (s: Partial<CanvasState>) => void)
    return newNode
  },

  deleteNodes: (nodeKeys: string[]) => {
    get().pushHistory()
    const { projectUuid, nodes } = get()
    const updated = nodes.filter(n => !nodeKeys.includes(n.data.nodeKey))
    set({ nodes: updated, isDirty: true })
    if (projectUuid) {
      nodesApi.delete(projectUuid, nodeKeys).catch(console.error)
    }
  },

  updateNodeData: (nodeKey: string, patch: Partial<CanvasNodeData>) => {
    const { nodes, projectUuid } = get()
    const updated = nodes.map(n =>
      (n.data.nodeKey === nodeKey || n.id === nodeKey)
        ? { ...n, data: { ...n.data, ...patch } }
        : n
    )
    set({ nodes: updated, isDirty: true })
    if (projectUuid) debouncedPersistNodes(projectUuid, updated, set as (s: Partial<CanvasState>) => void)
  },

  updateNodePosition: (nodeKey: string, x: number, y: number) => {
    const { nodes } = get()
    const updated = nodes.map(n =>
      n.data.nodeKey === nodeKey ? { ...n, position: { x, y } } : n
    )
    set({ nodes: updated, isDirty: true })
  },

  updateNodeSize: (nodeKey: string, w: number, h: number) => {
    const { nodes } = get()
    const updated = nodes.map(n =>
      n.data.nodeKey === nodeKey
        ? { ...n, data: { ...n.data, contentWidth: w, contentHeight: h } }
        : n
    )
    set({ nodes: updated })
  },

  persistNodes: async () => {
    const { projectUuid, nodes } = get()
    if (!projectUuid) return
    await debouncedPersistNodes(projectUuid, nodes, set as (s: Partial<CanvasState>) => void)
  },

  persistViewport: async () => {
    const { projectUuid, viewport } = get()
    if (!projectUuid) return
    await debouncedPersistViewport(projectUuid, viewport)
  },

  pushHistory: () => {
    const { nodes, edges, history, historyIndex } = get()
    const snapshot: HistorySnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
    }
    // Trim any future history (after undo) and cap at 30 snapshots
    const newHistory = [...history.slice(0, historyIndex + 1), snapshot].slice(-30)
    set({ history: newHistory, historyIndex: newHistory.length - 1 })
  },

  undo: () => {
    const { history, historyIndex } = get()
    if (historyIndex <= 0) return
    const prev = history[historyIndex - 1]
    // Only restore in-memory state — don't auto-persist on undo to avoid data loss
    set({ nodes: prev.nodes, edges: prev.edges, historyIndex: historyIndex - 1, isDirty: true })
  },

  copySelected: () => {
    const { selectedNodeKeys, nodes, edges } = get()
    if (selectedNodeKeys.length === 0) return
    const selectedNodes = nodes.filter(n => selectedNodeKeys.includes(n.id))
    const selectedEdges = edges.filter(
      e => selectedNodeKeys.includes(e.source) && selectedNodeKeys.includes(e.target)
    )
    set({ clipboard: { nodes: JSON.parse(JSON.stringify(selectedNodes)), edges: JSON.parse(JSON.stringify(selectedEdges)) } })
  },

  pasteClipboard: () => {
    const { clipboard, nodes, edges, projectUuid } = get()
    if (!clipboard || clipboard.nodes.length === 0) return

    const idMap: Record<string, string> = {}
    const newNodes: FlowNode[] = clipboard.nodes.map(n => {
      const newId = uuidv4()
      idMap[n.id] = newId
      return {
        ...n,
        id: newId,
        position: { x: n.position.x + 40, y: n.position.y + 40 },
        data: { ...n.data, nodeKey: newId, taskInfo: undefined },
        selected: false,
      }
    })
    const newEdges: Edge[] = clipboard.edges.map(e => ({
      ...e,
      id: `e-${idMap[e.source]}-${idMap[e.target]}`,
      source: idMap[e.source],
      target: idMap[e.target],
    }))

    const updatedNodes = [...nodes, ...newNodes]
    const updatedEdges = [...edges, ...newEdges]
    set({ nodes: updatedNodes, edges: updatedEdges, isDirty: true })
    if (projectUuid) debouncedPersistNodes(projectUuid, updatedNodes, set as (s: Partial<CanvasState>) => void)
  },

  groupNodes: (nodeIds: string[]) => {
    get().pushHistory()
    const { projectUuid, nodes } = get()
    if (nodeIds.length === 0) return
    const targets = nodes.filter(n => nodeIds.includes(n.id))
    if (targets.length === 0) return

    const PAD = 40
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of targets) {
      const w = n.measured?.width ?? n.data.contentWidth ?? 300
      const h = n.measured?.height ?? n.data.contentHeight ?? 200
      minX = Math.min(minX, n.position.x)
      minY = Math.min(minY, n.position.y)
      maxX = Math.max(maxX, n.position.x + w)
      maxY = Math.max(maxY, n.position.y + h)
    }

    const gx = minX - PAD, gy = minY - PAD
    const gw = maxX - minX + PAD * 2, gh = maxY - minY + PAD * 2
    const nodeKey = uuidv4()
    const name = `分组 ${nodes.filter(n => n.data.type === 'group').length + 1}`
    const groupNode: FlowNode = {
      id: nodeKey,
      type: 'group',
      position: { x: gx, y: gy },
      data: {
        type: 'group', name, url: [], action: 'image_resource',
        params: { childIds: nodeIds, color: '#1a3a2a' } as unknown as Record<string, unknown>,
        nodeKey, projectUuid: projectUuid ?? '',
        contentWidth: gw, contentHeight: gh,
      },
      draggable: true, selectable: true,
      style: { width: gw, height: gh },
    }
    // Group node goes first so it renders below children
    const updated = [groupNode, ...nodes]
    set({ nodes: updated, isDirty: true })
    if (projectUuid) debouncedPersistNodes(projectUuid, updated, set as (s: Partial<CanvasState>) => void)
  },

  ungroupNodes: (groupId: string) => {
    const { projectUuid, nodes } = get()
    const updated = nodes.filter(n => n.id !== groupId)
    set({ nodes: updated, isDirty: true })
    if (projectUuid) {
      nodesApi.delete(projectUuid, [groupId]).catch(console.error)
    }
  },

  duplicateNodes: (nodeIds: string[]) => {
    get().pushHistory()
    const { projectUuid, nodes, edges } = get()
    const targets = nodes.filter(n => nodeIds.includes(n.id))
    if (targets.length === 0) return

    const idMap: Record<string, string> = {}
    const newNodes: FlowNode[] = targets.map(n => {
      const newId = uuidv4()
      idMap[n.id] = newId
      return {
        ...n,
        id: newId,
        position: { x: n.position.x + 40, y: n.position.y + 40 },
        data: { ...n.data, nodeKey: newId, taskInfo: undefined },
        selected: false,
      }
    })

    // Clone edges between duplicated nodes
    const newEdges: Edge[] = edges
      .filter(e => nodeIds.includes(e.source) && nodeIds.includes(e.target))
      .map(e => ({
        ...e,
        id: `e-${idMap[e.source]}-${idMap[e.target]}`,
        source: idMap[e.source],
        target: idMap[e.target],
      }))

    const updatedNodes = [...nodes, ...newNodes]
    const updatedEdges = [...edges, ...newEdges]
    set({ nodes: updatedNodes, edges: updatedEdges, isDirty: true })
    if (projectUuid) debouncedPersistNodes(projectUuid, updatedNodes, set as (s: Partial<CanvasState>) => void)
  },
}))
