import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import * as mivo from '../services/mivo'
import { tasks } from './generate'

const router = Router()

function startMivoJob(fn: () => Promise<string>, internalId: string) {
  tasks[internalId] = { status: 1, progressPercent: 0 }
  fn().then(async (jobId) => {
    let attempts = 0
    const interval = setInterval(async () => {
      attempts++
      if (attempts > 200) { clearInterval(interval); return }
      try {
        const res = await mivo.pollResult(jobId)
        tasks[internalId] = { status: res.status, progressPercent: res.progressPercent, urls: res.urls, error: res.error }
        if (res.status === 2 || res.status === 3) clearInterval(interval)
      } catch (e) { console.error(e) }
    }, 3000)
  }).catch(e => {
    tasks[internalId] = { status: 3, progressPercent: 0, error: String(e) }
  })
}

router.post('/super-resolution', (req, res) => {
  const { imageUrl } = req.body
  const id = uuidv4()
  startMivoJob(() => mivo.superResolution(imageUrl), id)
  res.json({ jobId: id })
})

router.post('/panorama', (req, res) => {
  const { imageUrl } = req.body
  const id = uuidv4()
  startMivoJob(() => mivo.expandPanorama(imageUrl), id)
  res.json({ jobId: id })
})

router.post('/multi-angle', (req, res) => {
  const { imageUrl, projectUuid, nodeKey } = req.body
  const id = uuidv4()
  // Generate 4 variations with slightly varied prompts using same image
  startMivoJob(() => mivo.submitGenImage({
    prompt: '从不同角度重新生成，保持主体一致',
    images: [imageUrl],
    count: 4,
    model: 'gemini-3-pro-image-preview',
  }), id)
  res.json({ jobId: id })
})

router.post('/lighting', (req, res) => {
  const { imageUrl } = req.body
  const id = uuidv4()
  startMivoJob(() => mivo.genLighting(imageUrl), id)
  res.json({ jobId: id })
})

router.post('/grid', (req, res) => {
  const { imageUrl, cols = 3 } = req.body
  const id = uuidv4()
  // Generate a grid composition
  startMivoJob(() => mivo.submitGenImage({
    prompt: `将图片排列为 ${cols}x${cols} 宫格`,
    images: [imageUrl],
    model: 'gemini-3-pro-image-preview',
  }), id)
  res.json({ jobId: id })
})

router.post('/split-grid', async (req, res) => {
  // Stub: return placeholder node keys
  const { cols = 3, rows = 3 } = req.body
  const nodeKeys = Array.from({ length: cols * rows }, () => uuidv4())
  res.json({ nodeKeys })
})

export default router
