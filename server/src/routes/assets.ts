import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { PROJECTS_DIR } from '../config'
import { getAssetsDir } from '../services/storage'
import { sha1File } from '../services/hash'

const router = Router()

const upload = multer({ dest: path.join(PROJECTS_DIR, '_tmp') })

router.post('/upload', upload.single('file'), (req, res) => {
  const { projectUuid } = req.body
  if (!req.file || !projectUuid) return res.status(400).json({ error: 'missing file or projectUuid' })

  const sha1 = sha1File(req.file.path)
  const ext = path.extname(req.file.originalname) || `.${req.file.mimetype.split('/')[1]}`
  const assetsDir = getAssetsDir(projectUuid)
  const dest = path.join(assetsDir, `${sha1}${ext}`)

  if (!fs.existsSync(dest)) {
    fs.renameSync(req.file.path, dest)
  } else {
    fs.unlinkSync(req.file.path)
  }

  const url = `/assets/${projectUuid}/${sha1}${ext}`
  res.json({ url, sha1, meta: { mimeType: req.file.mimetype, byteSize: req.file.size } })
})

router.get('/:projectUuid', (req, res) => {
  const dir = path.join(PROJECTS_DIR, req.params.projectUuid, 'assets')
  if (!fs.existsSync(dir)) return res.json([])
  const files = fs.readdirSync(dir).map(f => ({
    url: `/assets/${req.params.projectUuid}/${f}`,
    name: f,
    mimeType: '',
    sha1: f.split('.')[0],
  }))
  res.json(files)
})

router.get('/', (_req, res) => {
  const results: { url: string; name: string; mimeType: string; sha1: string; projectUuid: string }[] = []
  if (!fs.existsSync(PROJECTS_DIR)) return res.json([])
  for (const uuid of fs.readdirSync(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, uuid, 'assets')
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      results.push({ url: `/assets/${uuid}/${f}`, name: f, mimeType: '', sha1: f.split('.')[0], projectUuid: uuid })
    }
  }
  res.json(results)
})

export default router
