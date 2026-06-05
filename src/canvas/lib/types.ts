export type NodeType =
  | 'text'
  | 'image'
  | 'video'
  | 'video_merge'
  | 'director_stage'
  | 'audio'
  | 'script'
  | 'upload'
  | 'group'

export interface ResourceMeta {
  kind: 'image' | 'video' | 'audio'
  mimeType?: string
  byteSize?: number
  width?: number
  height?: number
  durationSec?: number
  hashSha1?: string
  extension?: string
}

export interface NodeRef {
  nodeId: string
  url: string
  mediaType?: 'image' | 'video' | 'audio'
}

export interface ImageParams {
  prompt: string
  model: string
  count: number
  settings: {
    quality?: string
    ratio: string
    resolution?: string
  }
  advancedSettings?: Record<string, unknown>
  cameraControl?: {
    enabled: boolean
    camera?: string
    lens?: string
    focal?: string
    aperture?: string
  }
  modeType: 'text2image' | 'image2image'
  promptChips?: { nodeId: string; url: string; name: string }[]
  promptHtml?: string
  imageList: NodeRef[]
  imageListOrder: string[]
  videoList: NodeRef[]
  audioList: NodeRef[]
  textList: NodeRef[]
}

export interface VideoHistoryItem {
  id: string
  timestamp: number
  url: string
  prompt: string
  promptHtml?: string
  promptChips?: { nodeId: string; url: string; name: string }[]
  model: string
  modeType: string
  settings: { ratio: string; resolution: string; duration: number; enableSound: 'on' | 'off' }
  imageList: NodeRef[]
}

export interface VideoParams {
  prompt: string
  model: string
  modeType: 'text2video' | 'image2video' | 'mixed2video'
  count: number
  imageList: NodeRef[]
  mixedList: NodeRef[]
  mixedListOrder: string[]
  imageListOrder: string[]
  videoList: NodeRef[]
  audioList: NodeRef[]
  textList: NodeRef[]
  settings: {
    ratio: string
    resolution: string
    duration: number
    enableSound: 'on' | 'off'
  }
  promptChips?: { nodeId: string; url: string; name: string }[]
  promptHtml?: string
  history?: VideoHistoryItem[]
  advancedSettings?: Record<string, unknown>
}

export interface AudioParams {
  prompt?: string
  model?: string
  type: 'tts' | 'music' | 'upload'
  voice?: string
  speed?: number
}

export interface TextParams {
  content: string   // generated / edited output text
  model: string
  prompt: string    // user instruction
  imageList: NodeRef[]
  videoList: NodeRef[]
  textList: NodeRef[]
}

export interface ScriptRow {
  id: string
  shot: string
  sceneType: string
  action: string
  dialogue: string
  duration: number
}

export interface ScriptParams {
  description: string
  rows: ScriptRow[]
}

export interface TaskInfo {
  taskId: string
  loading: boolean
  status: 0 | 1 | 2 | 3  // 0=pending, 1=running, 2=done, 3=failed
  progressPercent: number
  error?: string
}

export interface CanvasNodeData extends Record<string, unknown> {
  type: NodeType
  name: string
  url: string[]
  poster?: string
  action: 'image_resource' | 'image_generate' | 'video_generate' | 'audio_generate' | 'text_node' | 'script_node' | 'video_merge' | 'director_stage'
  generatorType?: string
  params?: Record<string, unknown>
  taskInfo?: TaskInfo
  isStale?: boolean
  contentWidth?: number
  contentHeight?: number
  _resourceMeta?: { items: ResourceMeta[] }
  _updatedAtMs?: number
}

export interface CanvasNode {
  nodeKey: string
  projectUuid: string
  toolId?: number
  toolKey?: string
  type: number  // 1=text 2=image 3=video 4=video_merge 5=director_stage 6=audio 7=script 8=upload
  name: string
  position: { positionX: number; positionY: number }
  measured: { width: number; height: number }
  data: string  // JSON stringified CanvasNodeData
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
