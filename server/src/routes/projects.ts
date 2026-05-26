import { Router } from 'express'
import * as storage from '../services/storage'

const router = Router()

router.get('/', (_req, res) => {
  res.json(storage.readIndex())
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
