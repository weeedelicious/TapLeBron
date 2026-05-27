import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Node, Edge, Viewport } from '@xyflow/react'
import type { CanvasNode, CanvasNodeData, Project } from '@/lib/types'
import { NODE_TYPE_INT, makeNodeData, NODE_LABELS } from '@/lib/nodeData'
import { nodesApi, projectsApi } from '@/lib/api'
import { debounce } from '@/lib/debounce'

export type FlowNode = Node & { data: CanvasNodeData & { nodeKey: string; projectUuid: string } }

interface CanvasState {
  projectUuid: string | null
  projectName: string
  nodes: FlowNode[]
  edges: Edge[]
  viewport: Viewport
  selectedNodeKeys: string[]
  isDirty: boolean
  isSaving: boolean

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

  loadProject: (project: Project) => {
    const nodes: FlowNode[] = project.nodeList.map(cn => {
      let data: CanvasNodeData
      try { data = JSON.parse(cn.data) } catch { data = { type: 'upload', name: cn.name, url: [], action: 'image_resource' } }
      return {
        id: cn.nodeKey,
        type: data.type,
        position: { x: Number(cn.position.positionX), y: Number(cn.position.positionY) },
        data: { ...data, nodeKey: cn.nodeKey, projectUuid: cn.projectUuid },
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
}))
