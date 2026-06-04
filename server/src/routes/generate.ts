import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import * as mivo from '../services/mivo'
import * as llm from '../services/llm'
import * as seedance from '../services/seedance'
import { config, PROJECTS_DIR } from '../config'

const router = Router()

// In-memory task registry
const tasks: Record<string, { status: number; progressPercent: number; urls?: string[]; error?: string }> = {}

function fileIdFromUrl(url: string): string {
  return url.split('/').pop() ?? url
}

// Mivo fileId is a 24-char lowercase hex MongoDB ObjectId
function isMivoObjectId(s: string): boolean {
  return /^[0-9a-f]{24}$/.test(s)
}

// Convert local /assets/... URL to a Mivo-accessible file ID or URL.
// If the filename stem is already a Mivo ObjectId (generated files), use it directly.
// Otherwise upload the local file to Mivo.
async function resolveToMivoRef(url: string, projectUuid: string): Promise<string> {
  if (!url) return ''
  if (url.startsWith('http')) {
    // Already a Mivo URL — extract fileId if possible, else return as-is
    const last = url.split('/').pop() ?? ''
    return isMivoObjectId(last) ? last : url
  }
  const filename = path.basename(url)
  const stem = filename.replace(/\.[^.]+$/, '')
  if (isMivoObjectId(stem)) return stem  // Mivo-generated file — ID is in the filename
  // User-uploaded file — need to upload to Mivo
  const localPath = path.join(PROJECTS_DIR, projectUuid, 'assets', filename)
  try {
    return await mivo.uploadFileToMivo(localPath)
  } catch (e) {
    console.error('Failed to upload local image to Mivo:', localPath, e)
    return ''
  }
}

async function downloadToAssets(mivoUrls: string[], projectUuid: string): Promise<string[]> {
  const assetsDir = path.join(PROJECTS_DIR, projectUuid, 'assets')
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })

  const localUrls: string[] = []
  for (const url of mivoUrls) {
    try {
      const fileId = fileIdFromUrl(url)
      const savePath = path.join(assetsDir, fileId)
      const localPath = await mivo.downloadFile(fileId, savePath)
      const filename = path.basename(localPath)
      localUrls.push(`/assets/${projectUuid}/${filename}`)
    } catch (e) {
      console.error('download asset failed', url, e)
      localUrls.push(url) // fallback to original URL
    }
  }
  return localUrls
}

async function pollAndStore(
  jobId: string,
  internalId: string,
  projectUuid: string,
  pollFn: (id: string) => Promise<{ status: number; progressPercent: number; urls?: string[]; error?: string }> = mivo.pollResult,
) {
  let attempts = 0
  const interval = setInterval(async () => {
    attempts++
    if (attempts > 200) { clearInterval(interval); return }
    try {
      const res = await pollFn(jobId)
      if (res.status === 2 && res.urls?.length) {
        clearInterval(interval)
        const localUrls = await downloadToAssets(res.urls, projectUuid)
        tasks[internalId] = { status: 2, progressPercent: 100, urls: localUrls }
      } else if (res.status === 3) {
        clearInterval(interval)
        tasks[internalId] = { status: 3, progressPercent: 0, error: res.error }
      } else {
        tasks[internalId] = { status: res.status, progressPercent: res.progressPercent }
      }
    } catch (e) { console.error('poll error', e) }
  }, 3000)
}

router.post('/image', async (req, res) => {
  try {
    const { projectUuid, params } = req.body as { projectUuid: string; nodeKey: string; params: Record<string, unknown> }
    const settings = (params.settings as Record<string, unknown>) ?? {}
    const imageList = (params.imageList as Array<{ url: string }> | undefined) ?? []
    const promptChips = (params.promptChips as Array<{ url: string }> | undefined) ?? []
    // Combine edge-connected images + @-mention chips, deduplicated by URL
    const allRefUrls = [...new Set([...imageList, ...promptChips].map(i => i.url).filter(Boolean))]

    const resolvedImages = await Promise.all(
      allRefUrls.map(url => resolveToMivoRef(url, projectUuid))
    )
    const genParams: mivo.GenImageParams = {
      prompt: (params.prompt as string) ?? '',
      model: params.model as string | undefined,
      ratio: (settings.ratio as string) ?? '1:1',
      resolution: (settings.resolution as string) ?? '1K',
      quality: (settings.quality as string) ?? 'auto',
      count: Number(params.count ?? 1),
      images: resolvedImages.filter(Boolean),
    }
    const jobId = await mivo.submitGenImage(genParams)
    const internalId = uuidv4()
    tasks[internalId] = { status: 1, progressPercent: 0 }
    pollAndStore(jobId, internalId, projectUuid)
    res.json({ jobId: internalId })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

router.post('/video', async (req, res) => {
  try {
    const { projectUuid, params } = req.body as { projectUuid: string; nodeKey: string; params: Record<string, unknown> }
    const settings = (params.settings as Record<string, unknown>) ?? {}
    const imageList = (params.imageList as Array<{ url: string }> | undefined) ?? []
    const mode = (params.modeType as string) ?? 't2v'

    // All modes: use base64 data URIs — direct Seedance API can't access Mivo CDN (auth required)
    const base64Images = await Promise.all(
      imageList.filter(i => i.url).map(i => resolveImageUrlForLLM(i.url, projectUuid))
    )

    const genParams: seedance.SeedanceVideoParams = {
      prompt: (params.prompt as string) ?? '',
      model: params.model as string | undefined,
      modeType: mode,
      ratio: (settings.ratio as string) ?? '16:9',
      duration: Number(settings.duration ?? 5),
      resolution: (settings.resolution as string) ?? '720P',
      enableSound: (settings.enableSound as string) ?? 'on',
      images: base64Images.filter(Boolean) as string[],
    }
    const taskId = await seedance.submitSeedanceVideo(genParams)
    const internalId = uuidv4()
    tasks[internalId] = { status: 1, progressPercent: 0 }
    pollAndStore(taskId, internalId, projectUuid, seedance.pollSeedanceResult)
    res.json({ jobId: internalId })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

router.post('/audio', async (req, res) => {
  try {
    const { projectUuid, params } = req.body as { projectUuid: string; nodeKey: string; params: mivo.GenAudioParams }
    const jobId = await mivo.submitGenAudio(params)
    const internalId = uuidv4()
    tasks[internalId] = { status: 1, progressPercent: 0 }
    pollAndStore(jobId, internalId, projectUuid)
    res.json({ jobId: internalId })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

router.post('/script', async (req, res) => {
  try {
    const { params } = req.body as { params: { description: string } }
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

// ── LLM text generation — streaming SSE ──────────────────────────────────────
interface NodeRefInput { nodeId: string; url: string; content?: string; mediaType?: string }

// Mivo CDN requires auth so we can't pass CDN URLs to external LLM proxy.
// Always compress & inline as base64 — avoids auth issues entirely.
async function resolveImageUrlForLLM(url: string, projectUuid: string): Promise<string | null> {
  if (!url) return null
  if (!url.startsWith('/assets/')) return null  // only handle local assets

  const filename = path.basename(url)
  const localPath = path.join(PROJECTS_DIR, projectUuid, 'assets', filename)
  if (!fs.existsSync(localPath)) return null

  try {
    // Compress to max 1024px JPEG — keeps payload small enough for LLM API
    const sharp = (await import('sharp')).default
    const buf = await sharp(localPath)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer()
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  } catch {
    // sharp not available — raw base64 but skip if > 1.5 MB to avoid 400 on size
    const buf = fs.readFileSync(localPath)
    if (buf.length > 1.5 * 1024 * 1024) return null
    const ext = path.extname(filename).slice(1).toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  }
}

router.post('/llm', async (req, res) => {
  try {
    const { projectUuid, params } = req.body as {
      projectUuid: string
      nodeKey: string
      params: {
        prompt: string
        model: string
        imageList?: NodeRefInput[]
        videoList?: NodeRefInput[]
        textList?: NodeRefInput[]
      }
    }

    const { prompt, model, imageList = [], videoList = [], textList = [] } = params

    // Build image content items from connected image nodes
    const imageUrls = await Promise.all(imageList.filter(r => r.url).map(r => resolveImageUrlForLLM(r.url, projectUuid)))
    const imageItems: llm.ContentItem[] = imageUrls
      .flatMap(u => u ? [{ type: 'image_url' as const, image_url: { url: u } }] : [])

    // Video nodes: use first URL as image reference
    const videoUrls = await Promise.all(videoList.filter(r => r.url).map(r => resolveImageUrlForLLM(r.url, projectUuid)))
    const videoImageItems: llm.ContentItem[] = videoUrls
      .flatMap(u => u ? [{ type: 'image_url' as const, image_url: { url: u } }] : [])

    // Text node references — prepend as context
    const textContext = textList
      .filter(r => r.content)
      .map((r, i) => `[引用文本${i + 1}]：${r.content}`)
      .join('\n')

    const messages: llm.ChatMessage[] = [
      { role: 'system', content: '你是创意助手，请根据用户的指令和提供的参考素材生成文字内容。' },
    ]

    const userContent: llm.ContentItem[] = []
    if (textContext) userContent.push({ type: 'text', text: textContext + '\n' })
    userContent.push(...imageItems, ...videoImageItems)
    userContent.push({ type: 'text', text: prompt || '请根据上面的素材生成内容' })

    messages.push({ role: 'user', content: userContent })

    // Set up SSE streaming response
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const abortController = new AbortController()
    // res 'close' fires when client disconnects (req 'close' fires when body is consumed — too early)
    res.on('close', () => abortController.abort())

    try {
      for await (const delta of llm.chatStream(messages, model, abortController.signal)) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`)
      }
    } catch (e: unknown) {
      if ((e as { name?: string }).name !== 'AbortError') {
        const msg = e instanceof Error ? e.message : String(e)
        res.write(`data: ${JSON.stringify({ error: msg })}\n\n`)
      }
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!res.headersSent) res.status(500).json({ error: msg })
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
