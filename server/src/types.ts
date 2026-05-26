export interface CanvasNode {
  nodeKey: string
  projectUuid: string
  toolId?: number
  toolKey?: string
  type: number
  name: string
  position: { positionX: number; positionY: number }
  measured: { width: number; height: number }
  data: string
  parentKey?: string
  status: number
  workflowUuid?: string
  workflowRoot?: number
  createdAtMs?: number
  updatedAtMs?: number
}

export interface ProjectMeta {
  id?: number
  uuid: string
  name: string
  coverUrl?: string
  visibility?: number
  ownerId?: number
  createdAtMs: number
  updatedAtMs: number
}

export interface ProjectDraft {
  id?: number
  uuid?: string
  projectUuid: string
  viewportX: number
  viewportY: number
  viewportZoom: number
  lastEditedAtMs?: number
}

export interface Project {
  projectMeta: ProjectMeta
  projectDraft: ProjectDraft
  nodeList: CanvasNode[]
}

export interface ProjectIndex {
  uuid: string
  name: string
  coverUrl?: string
  updatedAtMs: number
  nodeCount: number
}
