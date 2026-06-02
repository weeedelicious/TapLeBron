import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { PROJECTS_DIR } from '../config'
import type { Project, ProjectMeta, ProjectDraft, CanvasNode, ProjectIndex } from '../types'

const INDEX_FILE = path.join(PROJECTS_DIR, '_index.json')

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function projectDir(uuid: string) { return path.join(PROJECTS_DIR, uuid) }
function projectFile(uuid: string) { return path.join(projectDir(uuid), 'project.json') }
function assetsDir(uuid: string) { return path.join(projectDir(uuid), 'assets') }

export function readIndex(): ProjectIndex[] {
  if (!fs.existsSync(INDEX_FILE)) return []
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'))
}

function writeIndex(index: ProjectIndex[]) {
  ensureDir(PROJECTS_DIR)
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2))
}

function upsertIndex(uuid: string, meta: Pick<ProjectMeta, 'name' | 'coverUrl'>, nodeCount: number) {
  const index = readIndex()
  const existing = index.findIndex(p => p.uuid === uuid)
  const entry: ProjectIndex = { uuid, name: meta.name, coverUrl: meta.coverUrl, updatedAtMs: Date.now(), nodeCount }
  if (existing >= 0) index[existing] = entry
  else index.unshift(entry)
  writeIndex(index)
}

export function readProject(uuid: string): Project | null {
  const f = projectFile(uuid)
  if (!fs.existsSync(f)) return null
  return JSON.parse(fs.readFileSync(f, 'utf-8'))
}

function atomicWrite(file: string, data: string) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export function createProject(name: string): Project {
  const uuid = uuidv4()
  const now = Date.now()
  const project: Project = {
    projectMeta: { uuid, name, createdAtMs: now, updatedAtMs: now },
    projectDraft: { projectUuid: uuid, viewportX: 0, viewportY: 0, viewportZoom: 1 },
    nodeList: [],
  }
  ensureDir(projectDir(uuid))
  ensureDir(assetsDir(uuid))
  atomicWrite(projectFile(uuid), JSON.stringify(project, null, 2))
  upsertIndex(uuid, { name }, 0)
  return project
}

export function saveNodes(uuid: string, nodes: CanvasNode[]) {
  const project = readProject(uuid)
  if (!project) return
  project.nodeList = nodes
  project.projectMeta.updatedAtMs = Date.now()
  // Auto-pick cover from first image/upload node unless user set one manually
  if (!project.projectMeta.coverManual) {
    for (const node of nodes) {
      try {
        const data = JSON.parse(node.data)
        if (Array.isArray(data.url) && data.url.length > 0 &&
            (data.type === 'image' || data.type === 'upload')) {
          project.projectMeta.coverUrl = data.url[0]
          break
        }
      } catch { /* ignore malformed node data */ }
    }
  }
  atomicWrite(projectFile(uuid), JSON.stringify(project, null, 2))
  upsertIndex(uuid, project.projectMeta, nodes.length)
}

export function setCoverUrl(uuid: string, coverUrl: string) {
  const project = readProject(uuid)
  if (!project) return
  project.projectMeta.coverUrl = coverUrl
  project.projectMeta.coverManual = true
  project.projectMeta.updatedAtMs = Date.now()
  atomicWrite(projectFile(uuid), JSON.stringify(project, null, 2))
  upsertIndex(uuid, project.projectMeta, project.nodeList.length)
}

export function deleteNodes(uuid: string, nodeKeys: string[]) {
  const project = readProject(uuid)
  if (!project) return
  project.nodeList = project.nodeList.filter(n => !nodeKeys.includes(n.nodeKey))
  atomicWrite(projectFile(uuid), JSON.stringify(project, null, 2))
  upsertIndex(uuid, project.projectMeta, project.nodeList.length)
}

export function saveDraft(uuid: string, draft: Partial<ProjectDraft>) {
  const project = readProject(uuid)
  if (!project) return
  project.projectDraft = { ...project.projectDraft, ...draft }
  project.projectMeta.updatedAtMs = Date.now()
  atomicWrite(projectFile(uuid), JSON.stringify(project, null, 2))
}

export function renameProject(uuid: string, name: string) {
  const project = readProject(uuid)
  if (!project) return
  project.projectMeta.name = name
  atomicWrite(projectFile(uuid), JSON.stringify(project, null, 2))
  upsertIndex(uuid, { name, coverUrl: project.projectMeta.coverUrl }, project.nodeList.length)
}

export function deleteProject(uuid: string) {
  const dir = projectDir(uuid)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
  const index = readIndex().filter(p => p.uuid !== uuid)
  writeIndex(index)
}

export function getAssetsDir(uuid: string) {
  const dir = assetsDir(uuid)
  ensureDir(dir)
  return dir
}
