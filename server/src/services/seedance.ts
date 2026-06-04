/**
 * Seedance 2.0 video generation — direct Volcengine API via llm-proxy.tapsvc.com
 * Mirrors autoanim1.2/pipelines/video.py
 */
import axios from 'axios'
import { config } from '../config'

const BASE_URL = config.llmBaseUrl || 'https://llm-proxy.tapsvc.com'
const API_KEY  = config.llmApiKey  || ''

const SUBMIT_URL = `${BASE_URL}/volcengine/api/v3/contents/generations/tasks`
const QUERY_URL  = `${BASE_URL}/volcengine/api/v3/contents/generations/tasks`

// UI model key → Volcengine model ID
const MODEL_MAP: Record<string, string> = {
  'Seedance_2_0':      'doubao-seedance-2-0-260128',
  'Seedance_2_0_Fast': 'doubao-seedance-2-0-fast-260128',
  // passthrough — if caller already sends the full ID
  'doubao-seedance-2-0-260128':      'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-fast-260128': 'doubao-seedance-2-0-fast-260128',
}
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128'

export interface SeedanceVideoParams {
  prompt: string
  model?: string
  modeType?: string   // 't2v'|'i2v'|'keyframe'|'omni'|'img_ref'
  ratio?: string
  resolution?: string // '480P'|'720P'|'1080P' (normalised to lowercase internally)
  duration?: number
  enableSound?: string  // 'on'|'off'
  images?: string[]     // base64 data URIs — no auth required
}

export interface PollResult {
  status: number  // 0=pending 1=running 2=done 3=failed
  progressPercent: number
  urls?: string[]
  error?: string
}

type ContentItem = Record<string, unknown>

function buildContent(params: SeedanceVideoParams): ContentItem[] {
  const mode = params.modeType ?? 't2v'
  const images = params.images ?? []

  const textItem: ContentItem = { type: 'text', text: params.prompt || '' }

  if (mode === 't2v' || images.length === 0) {
    return [textItem]
  }

  if (mode === 'i2v') {
    return [
      textItem,
      { type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' },
    ]
  }

  if (mode === 'keyframe') {
    const items: ContentItem[] = [
      textItem,
      { type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' },
    ]
    if (images[1]) {
      items.push({ type: 'image_url', image_url: { url: images[1] }, role: 'last_frame' })
    }
    return items
  }

  // omni / img_ref — all images as reference_image
  return [
    textItem,
    ...images.map(url => ({
      type: 'image_url',
      image_url: { url },
      role: 'reference_image',
    })),
  ]
}

export async function submitSeedanceVideo(params: SeedanceVideoParams): Promise<string> {
  const modelId = MODEL_MAP[params.model ?? ''] ?? DEFAULT_MODEL
  const rawResolution = params.resolution ?? '720P'
  const resolution = rawResolution.toLowerCase()  // Seedance wants lowercase: '720p'
  const rawRatio = params.ratio ?? '16:9'
  const ratio = rawRatio === 'auto' ? '16:9' : rawRatio
  const duration = Number(params.duration ?? 5)
  const generateAudio = params.enableSound !== 'off'

  const content = buildContent(params)

  const body: Record<string, unknown> = {
    model: modelId,
    content,
    resolution,
    ratio,
    duration,
    generate_audio: generateAudio,
    watermark: false,
  }

  try {
    const res = await axios.post(SUBMIT_URL, body, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    })
    const data = res.data
    const taskId = data?.id ?? data?.task_id
    if (!taskId) throw new Error(`Seedance 未返回 task_id: ${JSON.stringify(data)}`)
    return taskId as string
  } catch (e: unknown) {
    if (axios.isAxiosError(e) && e.response) {
      const d = e.response.data
      const detail = d?.error?.message ?? d?.message ?? d?.error ?? JSON.stringify(d)
      throw new Error(`Seedance ${e.response.status}: ${detail}`)
    }
    throw e
  }
}

function extractVideoUrl(data: Record<string, unknown>): string | null {
  // Shape 1: content is dict { video_url: string | { url: string } }
  const c = data.content
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const vu = (c as Record<string, unknown>).video_url
    if (typeof vu === 'string' && vu) return vu
    if (vu && typeof vu === 'object') return (vu as Record<string, string>).url ?? null
  }
  // Shape 2: content is array [{ type:'video_url', video_url: string | { url } }]
  if (Array.isArray(c)) {
    for (const item of c as Record<string, unknown>[]) {
      if (item.type === 'video_url') {
        const vu = item.video_url
        if (typeof vu === 'string' && vu) return vu
        if (vu && typeof vu === 'object') return (vu as Record<string, string>).url ?? null
      }
    }
  }
  // Shape 3: output.video_url
  const out = data.output
  if (out && typeof out === 'object') {
    const vu = (out as Record<string, unknown>).video_url
    if (typeof vu === 'string' && vu) return vu
    if (vu && typeof vu === 'object') return (vu as Record<string, string>).url ?? null
  }
  return null
}

export async function pollSeedanceResult(taskId: string): Promise<PollResult> {
  try {
    const res = await axios.get(`${QUERY_URL}/${taskId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      timeout: 30_000,
    })
    const data = res.data as Record<string, unknown>
    const status = data.status as string

    if (status === 'succeeded') {
      const videoUrl = extractVideoUrl(data)
      return {
        status: 2,
        progressPercent: 100,
        urls: videoUrl ? [videoUrl] : [],
      }
    }
    if (status === 'failed') {
      const msg = (data.message ?? data.error ?? 'Seedance 任务失败') as string
      return { status: 3, progressPercent: 0, error: msg }
    }
    // pending / running
    return { status: status === 'running' ? 1 : 0, progressPercent: 30 }
  } catch (e: unknown) {
    if (axios.isAxiosError(e) && e.response) {
      const d = e.response.data
      const detail = d?.error?.message ?? d?.message ?? JSON.stringify(d)
      return { status: 3, progressPercent: 0, error: `poll error ${e.response.status}: ${detail}` }
    }
    throw e
  }
}
