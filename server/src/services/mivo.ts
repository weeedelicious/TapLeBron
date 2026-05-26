import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { config } from '../config'

const http = axios.create({
  baseURL: config.mivoBaseUrl || 'https://aigc.xindong.com',
  headers: { 'Authorization': `Bearer ${config.mivoApiKey}` }
})

export interface GenImageParams {
  prompt: string
  model?: string
  ratio?: string
  images?: string[]
  resolution?: string
  quality?: string
  count?: number
  stylization?: number
  weirdness?: number
  diversity?: number
}

export interface GenVideoParams {
  prompt: string
  model?: string
  ratio?: string
  duration?: number
  resolution?: string
  enableSound?: boolean
  images?: string[]
  videos?: string[]
  action?: string
}

export interface GenAudioParams {
  prompt?: string
  type?: string
  voice?: string
  model?: string
}

export interface PollResult {
  status: number  // 0=pending 1=running 2=done 3=failed
  progressPercent: number
  fileIds?: string[]
  urls?: string[]
  error?: string
}

export async function submitGenImage(params: GenImageParams): Promise<string> {
  const payload: Record<string, unknown> = {
    prompt: params.prompt,
    modelVersion: params.model ?? 'gemini-3-pro-image-preview',
    ratio: params.ratio ?? '1:1',
    resolution: params.resolution ?? '1K',
  }
  if (params.images?.length) payload.images = params.images
  if (params.quality) payload.quality = params.quality

  const res = await http.post('/api/v1/gen-image/submit', payload)
  return res.data?.data?.jobId ?? res.data?.jobId
}

export async function submitGenVideo(params: GenVideoParams): Promise<string> {
  const payload: Record<string, unknown> = {
    prompt: params.prompt,
    modelVersion: params.model ?? 'Seed3D_2_0',
    ratio: params.ratio ?? '16:9',
    duration: params.duration ?? 5,
    resolution: params.resolution ?? '720p',
    enableSound: params.enableSound ?? true,
  }
  if (params.images?.length) payload.images = params.images
  if (params.videos?.length) payload.videos = params.videos

  const res = await http.post('/api/v1/gen-video/submit', payload)
  return res.data?.data?.jobId ?? res.data?.jobId
}

export async function submitGenAudio(params: GenAudioParams): Promise<string> {
  const payload: Record<string, unknown> = {
    prompt: params.prompt ?? '',
    type: params.type ?? 'tts',
    voice: params.voice ?? 'default',
    modelVersion: params.model ?? 'tts-default',
  }
  const res = await http.post('/api/v1/gen-audio/submit', payload)
  return res.data?.data?.jobId ?? res.data?.jobId
}

export async function pollResult(jobId: string): Promise<PollResult> {
  const res = await http.get(`/api/v1/tasks/${jobId}`)
  const d = res.data?.data ?? res.data
  return {
    status: d.status ?? 1,
    progressPercent: d.progress ?? d.progressPercent ?? 0,
    fileIds: d.fileIds ?? [],
    urls: d.urls ?? d.resultUrls ?? [],
    error: d.error ?? d.message,
  }
}

export async function downloadFile(fileId: string, savePath: string): Promise<string> {
  const res = await http.get(`/api/v1/file/image/${fileId}`, { responseType: 'stream' })
  const ext = (res.headers['content-type'] ?? 'image/png').split('/')[1]?.split(';')[0] ?? 'png'
  const filePath = `${savePath}.${ext}`
  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(filePath)
    res.data.pipe(writer)
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
  return filePath
}

export async function superResolution(imageUrl: string): Promise<string> {
  const res = await http.post('/api/v1/super-resolution', { image: imageUrl })
  return res.data?.data?.jobId ?? res.data?.jobId
}

export async function expandPanorama(imageUrl: string): Promise<string> {
  const res = await http.post('/api/v1/panorama', { image: imageUrl })
  return res.data?.data?.jobId ?? res.data?.jobId
}

export async function genLighting(imageUrl: string, style?: string): Promise<string> {
  const res = await http.post('/api/v1/relighting', { image: imageUrl, style })
  return res.data?.data?.jobId ?? res.data?.jobId
}

export async function translate(text: string): Promise<string> {
  const res = await http.post('/api/v1/translate', { text, targetLang: 'en' })
  return res.data?.data?.translated ?? text
}
