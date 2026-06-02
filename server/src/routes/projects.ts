import { Router } from 'express'
import * as storage from '../services/storage'

const router = Router()

router.get('/', (_req, res) => {
  const index = storage.readIndex()
  // Auto-populate cover for projects that don't have one yet
  const enriched = index.map(entry => {
    if (entry.coverUrl) return entry
    const project = storage.readProject(entry.uuid)
    if (!project) return entry
    for (const node of project.nodeList) {
      try {
        const data = JSON.parse(node.data)
        if (Array.isArray(data.url) && data.url.length > 0 &&
            (data.type === 'image' || data.type === 'upload')) {
          return { ...entry, coverUrl: data.url[0] }
        }
      } catch { /* ignore */ }
    }
    return entry
  })
  res.json(enriched)
})

router.post('/', (req, res) => {
  const { name = '未命名项目' } = req.body
  const project = storage.createProject(name)
  res.json(project)
})

router.get('/:uuid', (req, res) => {
  const project = storage.readProject(req.params.uuid)
  if (!project) return res.status(404).json({ error: 'not found' })
  res.json(project)
})

router.patch('/:uuid', (req, res) => {
  const { name } = req.body
  if (name) storage.renameProject(req.params.uuid, name)
  res.json({ ok: true })
})

router.delete('/:uuid', (req, res) => {
  storage.deleteProject(req.params.uuid)
  res.json({ ok: true })
})

router.patch('/:uuid/cover', (req, res) => {
  const { coverUrl } = req.body
  if (!coverUrl) return res.status(400).json({ error: 'coverUrl required' })
  storage.setCoverUrl(req.params.uuid, coverUrl)
  res.json({ ok: true })
})

router.patch('/:uuid/draft', (req, res) => {
  storage.saveDraft(req.params.uuid, req.body)
  res.json({ ok: true })
})

router.post('/:uuid/nodes/batch', (req, res) => {
  const { nodes } = req.body
  if (!Array.isArray(nodes)) return res.status(400).json({ error: 'nodes must be array' })
  storage.saveNodes(req.params.uuid, nodes)
  res.json({ ok: true })
})

router.post('/:uuid/nodes/delete', (req, res) => {
  const { nodeKeys } = req.body
  if (!Array.isArray(nodeKeys)) return res.status(400).json({ error: 'nodeKeys must be array' })
  storage.deleteNodes(req.params.uuid, nodeKeys)
  res.json({ ok: true })
})

export default router
