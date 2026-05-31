import axios from 'axios'
import fs from 'fs'
import path from 'path'
import FormData from 'form-data'
import { config } from '../config'

const BASE_URL = config.mivoBaseUrl || 'https://aigc.xindong.com'
const USER_SUB = config.mivoApiKey  // MIVO_USER_SUB

// ── Token cache ────────────────────────────────────────────────────────────────
let cachedToken: { session: string; expiresAt: number } | null = null
let tokenPromise: Promise<string> | null = null

async function fetchToken(): Promise<string> {
  const res = await axios.post(`${BASE_URL}/api/v1/state/token`, {
    id: '', sub: USER_SUB, name: '',
  }, { headers: { 'Content-Type': 'application/json' } })
  const { session, expiresAt } = res.data
  cachedToken = { session, expiresAt: expiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000 }
  return session
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.session
  if (tokenPromise) return tokenPromise
  tokenPromise = fetchToken().finally(() => { tokenPromise = null })
  return tokenPromise
}

function http(session: string) {
  return axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
  })
}

async function authedHttp() {
  return http(await getToken())
}

// ── Chat session cache ─────────────────────────────────────────────────────────
const chatSessions: Record<string, string> = {}

async function getChatSession(chatType: string): Promise<string> {
  if (chatSessions[chatType]) return chatSessions[chatType]
  const client = await authedHttp()
  const res = await client.post('/api/v1/message/chat', { type: chatType })
  chatSessions[chatType] = res.data.object_id ?? res.data.id
  return chatSessions[chatType]
}

async function createMessage(
  payload: Record<string, unknown>,
  chatType: string,
  messageType: string,
  modelType: string,
  modelVersion: string,
  action = 'mcp',
): Promise<string> {
  const client = await authedHttp()
  const chatSessionId = await getChatSession(chatType)
  const normalizedPayload = modelType === 'NANOBANANA' ? { ...payload, provider: 'genai' } : payload
  const res = await client.post('/api/v1/message', {
    chatSessionId,
    messageType,
    modelType,
    modelFormat: { version: modelVersion },
    action,
    payload: normalizedPayload,
  })
  return res.data.object_id ?? res.data.id
}

// ── Image generation ───────────────────────────────────────────────────────────
export interface GenImageParams {
  prompt: string
  model?: string
  ratio?: string
  images?: string[]
  resolution?: string
  quality?: string
  count?: number
}

function isGptModel(model: string) {
  return model === 'gpt-image-2' || model.toLowerCase().startsWith('gpt')
}

export async function submitGenImage(params: GenImageParams): Promise<string> {
  const model = params.model ?? 'gemini-3-pro-image-preview'
  const ratio = params.ratio ?? '1:1'
  const resolution = params.resolution ?? '1K'

  let modelType: string
  let payload: Record<string, unknown>

  if (isGptModel(model)) {
    modelType = 'GPT'
    payload = {
      prompt: params.prompt,
      imgRatio: ratio,
      quality: params.quality ?? 'auto',
      modelVersion: 'gpt-image-2',
      n: params.count ?? 1,
    }
  } else {
    modelType = 'NANOBANANA'
    payload = {
      prompt: params.prompt,
      imgRatio: ratio,
      resolution,
      modelVersion: model,
      n: params.count ?? 1,
    }
  }

  if (params.images?.length) payload.images = params.images

  try {
    return await createMessage(payload, 'freeform', 'image', modelType, model)
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const detail = e.response?.data?.message ?? e.response?.data?.msg ?? e.response?.data?.error
      throw new Error(`Mivo API ${e.response?.status ?? '?'}: ${detail ?? e.message}`)
    }
    throw e
  }
}

// ── Video generation ───────────────────────────────────────────────────────────
export interface GenVideoParams {
  prompt: string
  model?: string
  ratio?: string
  duration?: number
  resolution?: string
  enableSound?: string  // 'on' | 'off'
  // images[0] → firstFrame, images[1] → lastFrame
  images?: string[]
}

export async function submitGenVideo(params: GenVideoParams): Promise<string> {
  const model = params.model ?? 'Seedance_1_5_Pro'
  const rawRatio = params.ratio ?? '16:9'
  const ratio = rawRatio === 'auto' ? '16:9' : rawRatio
  const rawResolution = params.resolution ?? '720P'
  const resolution = rawResolution.toUpperCase()
  const duration = Number(params.duration ?? 5)

  const payload: Record<string, unknown> = {
    prompt: params.prompt,
    videoRatio: ratio,
    duration,
    resolution,
    genAudio: params.enableSound !== 'off',
  }
  if (params.images?.[0]) payload.firstFrame = params.images[0]
  if (params.images?.[1]) payload.lastFrame = params.images[1]

  try {
    return await createMessage(payload, 'video', 'video', 'ARK', model, 'generate_video')
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const data = e.response?.data
      const detail = data?.message ?? data?.msg ?? data?.error
        ?? (data?.detail ? String(data.detail) : undefined)
      throw new Error(`Mivo API ${e.response?.status ?? '?'}: ${detail ?? e.message}`)
    }
    throw e
  }
}

// ── Audio generation ───────────────────────────────────────────────────────────
export interface GenAudioParams {
  prompt?: string
  type?: string
  voice?: string
  model?: string
}

export async function submitGenAudio(params: GenAudioParams): Promise<string> {
  const model = params.model ?? 'tts-default'
  const payload: Record<string, unknown> = {
    prompt: params.prompt ?? '',
    type: params.type ?? 'tts',
    voice: params.voice ?? 'default',
    modelVersion: model,
  }
  try {
    return await createMessage(payload, 'freeform', 'text', 'ALICLOUD', model)
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const detail = e.response?.data?.message ?? e.response?.data?.msg ?? e.response?.data?.error
      throw new Error(`Mivo API ${e.response?.status ?? '?'}: ${detail ?? e.message}`)
    }
    throw e
  }
}

// ── Poll result ────────────────────────────────────────────────────────────────
export interface PollResult {
  status: number  // 0=pending 1=running 2=done 3=failed
  progressPercent: number
  urls?: string[]
  error?: string
}

const STATUS_MAP: Record<string, number> = {
  pending: 0, processing: 1, completed: 2, failed: 3,
}

export async function pollResult(jobId: string): Promise<PollResult> {
  const client = await authedHttp()
  const res = await client.get(`/api/v1/message/${jobId}`)
  const d = res.data
  const contentStatus: string = d.content?.status ?? d.status ?? 'processing'
  const statusNum = STATUS_MAP[contentStatus] ?? 1

  // Extract result URLs — images first, then video_files, then videos objects, then files
  let urls: string[] = []
  const c = d.content ?? {}
  if (Array.isArray(c.images) && c.images.length) {
    urls = c.images
  } else if (Array.isArray(c.video_files) && c.video_files.length) {
    urls = c.video_files
  } else if (Array.isArray(c.videos) && c.videos.length) {
    urls = (c.videos as Array<Record<string, string>>)
      .map(v => v.object_id ?? v._id ?? v.fileId ?? v.id ?? '')
      .filter(Boolean)
  } else if (Array.isArray(c.files) && c.files.length) {
    urls = c.files
  }

  // For video results, convert file IDs to download URLs
  const BASE = config.mivoBaseUrl || 'https://aigc.xindong.com'
  urls = urls.map(u =>
    u.startsWith('http') ? u : `${BASE}/api/v1/file/image/${u}`
  )

  return {
    status: statusNum,
    progressPercent: statusNum === 2 ? 100 : statusNum === 1 ? (c.progress ?? 50) : 0,
    urls,
    error: d.error ?? c.error,
  }
}

export function fileUrl(fileId: string): string {
  return `${BASE_URL}/api/v1/file/image/${fileId}`
}

// ── File upload to Mivo (for image references in generation) ──────────────────
export async function uploadFileToMivo(filePath: string): Promise<string> {
  const session = await getToken()
  const formData = new FormData()
  formData.append('file', fs.createReadStream(filePath), path.basename(filePath))
  const res = await axios.post(`${BASE_URL}/api/v1/file/`, formData, {
    headers: { ...formData.getHeaders(), Authorization: `Bearer ${session}` },
  })
  const arr = Array.isArray(res.data) ? res.data : [res.data]
  const fileId = arr[0]?.object_id ?? arr[0]?._id
  if (!fileId) throw new Error('上传到 Mivo 失败：无法获取 fileId')
  return fileId
}

// ── Download file from Mivo ───────────────────────────────────────────────────
export async function downloadFile(fileId: string, savePath: string): Promise<string> {
  const session = await getToken()
  const res = await axios.get(`${BASE_URL}/api/v1/file/download/${fileId}`, {
    responseType: 'stream',
    headers: { Authorization: `Bearer ${session}` },
  })
  const ct: string = res.headers['content-type'] ?? 'image/png'
  const ext = ct.split('/')[1]?.split(';')[0] ?? 'png'
  const filePath = `${savePath}.${ext}`
  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(filePath)
    res.data.pipe(writer)
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
  return filePath
}

// ── Toolbox helpers ────────────────────────────────────────────────────────────
export async function superResolution(imageUrl: string): Promise<string> {
  const client = await authedHttp()
  const res = await client.post('/api/v1/super-resolution', { image: imageUrl })
  return res.data?.data?.jobId ?? res.data?.jobId ?? res.data?.object_id
}

export async function expandPanorama(imageUrl: string): Promise<string> {
  const client = await authedHttp()
  const res = await client.post('/api/v1/panorama', { image: imageUrl })
  return res.data?.data?.jobId ?? res.data?.jobId ?? res.data?.object_id
}

export async function genLighting(imageUrl: string, style?: string): Promise<string> {
  const client = await authedHttp()
  const res = await client.post('/api/v1/relighting', { image: imageUrl, style })
  return res.data?.data?.jobId ?? res.data?.jobId ?? res.data?.object_id
}

export async function translate(text: string): Promise<string> {
  const client = await authedHttp()
  const res = await client.post('/api/v1/translate', { text, targetLang: 'en' })
  return res.data?.data?.translated ?? res.data?.translated ?? text
}
