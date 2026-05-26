import axios from 'axios'
import type { Project, ProjectIndex, CanvasNode, ProjectDraft } from './types'

const http = axios.create({ baseURL: '/api' })

export const projectsApi = {
  list: () => http.get<ProjectIndex[]>('/projects').then(r => r.data),
  get: (uuid: string) => http.get<Project>(`/projects/${uuid}`).then(r => r.data),
  create: (name: string) => http.post<Project>('/projects', { name }).then(r => r.data),
  rename: (uuid: string, name: string) =>
    http.patch(`/projects/${uuid}`, { name }).then(r => r.data),
  delete: (uuid: string) => http.delete(`/projects/${uuid}`),
  saveDraft: (uuid: string, draft: Partial<ProjectDraft>) =>
    http.patch(`/projects/${uuid}/draft`, draft),
}

export const nodesApi = {
  batchSave: (projectUuid: string, nodes: CanvasNode[]) =>
    http.post(`/projects/${projectUuid}/nodes/batch`, { nodes }),
  delete: (projectUuid: string, nodeKeys: string[]) =>
    http.post(`/projects/${projectUuid}/nodes/delete`, { nodeKeys }),
}

export const generateApi = {
  image: (projectUuid: string, nodeKey: string, params: Record<string, unknown>) =>
    http.post<{ jobId: string }>('/generate/image', { projectUuid, nodeKey, params }).then(r => r.data),
  video: (projectUuid: string, nodeKey: string, params: Record<string, unknown>) =>
    http.post<{ jobId: string }>('/generate/video', { projectUuid, nodeKey, params }).then(r => r.data),
  audio: (projectUuid: string, nodeKey: string, params: Record<string, unknown>) =>
    http.post<{ jobId: string }>('/generate/audio', { projectUuid, nodeKey, params }).then(r => r.data),
  script: (projectUuid: string, nodeKey: string, params: Record<string, unknown>) =>
    http.post<{ text: string }>('/generate/script', { projectUuid, nodeKey, params }).then(r => r.data),
  translate: (text: string) =>
    http.post<{ translated: string }>('/generate/translate', { text }).then(r => r.data),
  poll: (jobId: string) =>
    http.get<{ status: number; progressPercent: number; urls?: string[]; error?: string }>(`/tasks/${jobId}`).then(r => r.data),
}

export const toolboxApi = {
  superResolution: (projectUuid: string, nodeKey: string, imageUrl: string) =>
    http.post<{ jobId: string }>('/toolbox/super-resolution', { projectUuid, nodeKey, imageUrl }).then(r => r.data),
  panorama: (projectUuid: string, nodeKey: string, imageUrl: string) =>
    http.post<{ jobId: string }>('/toolbox/panorama', { projectUuid, nodeKey, imageUrl }).then(r => r.data),
  multiAngle: (projectUuid: string, nodeKey: string, imageUrl: string) =>
    http.post<{ jobId: string }>('/toolbox/multi-angle', { projectUuid, nodeKey, imageUrl }).then(r => r.data),
  lighting: (projectUuid: string, nodeKey: string, imageUrl: string, style?: string) =>
    http.post<{ jobId: string }>('/toolbox/lighting', { projectUuid, nodeKey, imageUrl, style }).then(r => r.data),
  grid: (projectUuid: string, nodeKey: string, imageUrl: string, cols: number) =>
    http.post<{ jobId: string }>('/toolbox/grid', { projectUuid, nodeKey, imageUrl, cols }).then(r => r.data),
  splitGrid: (projectUuid: string, nodeKey: string, imageUrl: string, cols: number, rows: number) =>
    http.post<{ nodeKeys: string[] }>('/toolbox/split-grid', { projectUuid, nodeKey, imageUrl, cols, rows }).then(r => r.data),
}

export const assetsApi = {
  upload: (projectUuid: string, file: File, onProgress?: (pct: number) => void) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('projectUuid', projectUuid)
    return http.post<{ url: string; sha1: string; meta: Record<string, unknown> }>('/assets/upload', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: e => { if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100)) }
    }).then(r => r.data)
  },
  listProject: (projectUuid: string) =>
    http.get<{ url: string; name: string; mimeType: string; sha1: string }[]>(`/assets/${projectUuid}`).then(r => r.data),
  listAll: () =>
    http.get<{ url: string; name: string; mimeType: string; sha1: string; projectUuid: string }[]>('/assets').then(r => r.data),
}
