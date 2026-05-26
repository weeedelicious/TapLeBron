import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import * as mivo from '../services/mivo'

const router = Router()

// In-memory task registry
const tasks: Record<string, { status: number; progressPercent: number; urls?: string[]; error?: string }> = {}

async function pollAndStore(jobId: string, internalId: string) {
  let attempts = 0
  const interval = setInterval(async () => {
    attempts++
    if (attempts > 200) { clearInterval(interval); return }
    try {
      const res = await mivo.pollResult(jobId)
      tasks[internalId] = { status: res.status, progressPercent: res.progressPercent, urls: res.urls, error: res.error }
      if (res.status === 2 || res.status === 3) clearInterval(interval)
    } catch (e) { console.error('poll error', e) }
  }, 3000)
}

router.post('/image', async (req, res) => {
  try {
    const { params } = req.body as { projectUuid: string; nodeKey: string; params: mivo.GenImageParams }
    const jobId = await mivo.submitGenImage(params)
    const internalId = uuidv4()
    tasks[internalId] = { status: 1, progressPercent: 0 }
    pollAndStore(jobId, internalId)
    res.json({ jobId: internalId })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

router.post('/video', async (req, res) => {
  try {
    const { params } = req.body as { projectUuid: string; nodeKey: string; params: mivo.GenVideoParams }
    const jobId = await mivo.submitGenVideo(params)
    const internalId = uuidv4()
    tasks[internalId] = { status: 1, progressPercent: 0 }
    pollAndStore(jobId, internalId)
    res.json({ jobId: internalId })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

router.post('/audio', async (req, res) => {
  try {
    const { params } = req.body as { projectUuid: string; nodeKey: string; params: mivo.GenAudioParams }
    const jobId = await mivo.submitGenAudio(params)
    const internalId = uuidv4()
    tasks[internalId] = { status: 1, progressPercent: 0 }
    pollAndStore(jobId, internalId)
    res.json({ jobId: internalId })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

router.post('/script', async (req, res) => {
  try {
    const { params } = req.body as { params: { description: string } }
    // Simple GPT-based script generation via mivo translate/LLM endpoint
    const text = await mivo.translate(`生成视频故事板JSON数组，包含字段 shot/sceneType/action/dialogue/duration，描述：${params.description}`)
    res.json({ text })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

router.post('/translate', async (req, res) => {
  try {
    const { text } = req.body
    const translated = await mivo.translate(text)
    res.json({ translated })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

// Poll endpoint
router.get('/:jobId', (req, res) => {
  const task = tasks[req.params.jobId]
  if (!task) return res.status(404).json({ error: 'task not found' })
  res.json(task)
})

export { tasks }
export default router
