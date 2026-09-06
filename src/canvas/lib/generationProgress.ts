import type { CanvasNodeData, ImageParams, TaskInfo, VideoParams } from './types'

export type GenerationTaskKind = 'image' | 'video' | 'video_merge' | 'text' | 'other'

export interface GenerationEstimate {
  taskKind: GenerationTaskKind
  model?: string
  quantity?: number
  estimatedMs: number
}

const SECOND = 1000

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function resolutionMultiplier(resolution: unknown) {
  const text = normalizeText(resolution)
  if (text.includes('4k')) return 2.6
  if (text.includes('2k') || text.includes('1080')) return 1.55
  if (text.includes('720')) return 1
  if (text.includes('480')) return 0.82
  return 1
}

function refCount(params: { imageList?: unknown[]; videoList?: unknown[]; mixedList?: unknown[]; textList?: unknown[] }) {
  return (
    (Array.isArray(params.imageList) ? params.imageList.length : 0) +
    (Array.isArray(params.videoList) ? params.videoList.length : 0) +
    (Array.isArray(params.mixedList) ? params.mixedList.length : 0) +
    (Array.isArray(params.textList) ? params.textList.length : 0)
  )
}

function estimateImageTask(data: CanvasNodeData): GenerationEstimate {
  const params = (data.params ?? {}) as unknown as Partial<ImageParams>
  const model = String(params.model || data.generatorType || 'image')
  const modelKey = normalizeText(model)
  const count = clamp(Number(params.count || 1), 1, 8)
  const settings = params.settings ?? { ratio: '16:9', resolution: '1K' }

  let baseMs = 72 * SECOND
  if (modelKey.includes('gpt') || modelKey.includes('image 2')) baseMs = 105 * SECOND
  if (modelKey.includes('nano') || modelKey.includes('banana') || modelKey.includes('gemini')) baseMs = 68 * SECOND

  const refs = refCount(params)
  const countFactor = 1 + (count - 1) * 0.58
  const refFactor = 1 + Math.min(0.38, refs * 0.08)
  const estimatedMs = Math.round(baseMs * resolutionMultiplier(settings.resolution) * countFactor * refFactor)

  return {
    taskKind: 'image',
    model,
    quantity: count,
    estimatedMs: clamp(estimatedMs, 28 * SECOND, 12 * 60 * SECOND),
  }
}

function estimateVideoTask(data: CanvasNodeData): GenerationEstimate {
  const params = (data.params ?? {}) as unknown as Partial<VideoParams>
  const model = String(params.model || data.generatorType || 'Seedance 2.0')
  const settings = params.settings ?? { ratio: '16:9', resolution: '720P', duration: 5, enableSound: 'off' }
  const duration = clamp(Number(settings.duration || 5), 1, 60)
  const count = clamp(Number(params.count || 1), 1, 8)
  const refs = refCount(params)

  let baseMs = 122 * SECOND
  const resKey = normalizeText(settings.resolution)
  if (resKey.includes('480')) baseMs = 92 * SECOND
  if (resKey.includes('1080')) baseMs = 185 * SECOND
  if (resKey.includes('4k')) baseMs = 360 * SECOND

  const durationFactor = clamp(Math.pow(duration / 5, 0.82), 0.78, 4.2)
  const countFactor = 1 + (count - 1) * 0.76
  const refFactor = 1 + Math.min(0.46, refs * 0.1)
  const soundFactor = settings.enableSound === 'on' ? 1.08 : 1

  return {
    taskKind: 'video',
    model,
    quantity: count,
    estimatedMs: clamp(Math.round(baseMs * durationFactor * countFactor * refFactor * soundFactor), 60 * SECOND, 40 * 60 * SECOND),
  }
}

function estimateVideoMergeTask(data: CanvasNodeData): GenerationEstimate {
  const params = (data.params ?? {}) as unknown as Partial<VideoParams>
  const clips = Array.isArray(params.mergeClips) ? params.mergeClips : []
  const totalSec = clips.reduce((sum, clip) => {
    const duration = Number(clip?.durationSec)
    const end = Number(clip?.endSec)
    const start = Number(clip?.startSec)
    if (Number.isFinite(duration) && duration > 0) return sum + duration
    if (Number.isFinite(end) && Number.isFinite(start) && end > start) return sum + (end - start)
    return sum + 5
  }, 0)
  return {
    taskKind: 'video_merge',
    model: 'video-merge',
    estimatedMs: clamp(Math.round((35 + totalSec * 1.8) * SECOND), 35 * SECOND, 12 * 60 * SECOND),
  }
}

export function estimateTaskFromNodeData(data?: CanvasNodeData | null): GenerationEstimate {
  if (!data) return { taskKind: 'other', estimatedMs: 70 * SECOND }
  if (data.type === 'image') return estimateImageTask(data)
  if (data.type === 'video') return estimateVideoTask(data)
  if (data.type === 'video_merge') return estimateVideoMergeTask(data)
  if (data.type === 'text') return { taskKind: 'text', model: String((data.params as { model?: string } | undefined)?.model || 'text'), estimatedMs: 90 * SECOND }
  return { taskKind: 'other', model: String(data.generatorType || data.type), estimatedMs: 70 * SECOND }
}

export function displayGenerationProgress(taskInfo?: Partial<TaskInfo> | null, nowMs = Date.now()) {
  const startedAtMs = Number(taskInfo?.startedAtMs) || nowMs
  const estimatedMs = clamp(Number(taskInfo?.estimatedMs) || 70 * SECOND, 10 * SECOND, 90 * 60 * SECOND)
  const elapsedMs = Math.max(0, nowMs - startedAtMs)
  const rawServerProgress = Number(taskInfo?.progressPercent)
  const serverProgress = Number.isFinite(rawServerProgress) ? clamp(rawServerProgress, 0, 100) : 0

  if (!taskInfo?.loading && taskInfo?.status === 2) {
    return { percent: 100, elapsedMs, remainingMs: 0, estimatedMs }
  }

  const elapsedRatio = elapsedMs / estimatedMs
  const timeProgress = elapsedRatio <= 1
    ? 6 + elapsedRatio * 86
    : 92 + Math.min(4, (elapsedRatio - 1) * 2.5)
  const percent = clamp(Math.max(serverProgress, timeProgress), 3, taskInfo?.loading ? 96 : 100)
  const remainingFromPercent = percent > 4 ? elapsedMs * (100 / percent - 1) : estimatedMs - elapsedMs
  const remainingMs = Math.max(0, Math.min(Math.max(estimatedMs - elapsedMs, 0), remainingFromPercent))

  return { percent: Math.round(percent), elapsedMs, remainingMs, estimatedMs }
}

export function formatGenerationDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / SECOND))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}秒`
  if (seconds === 0) return `${minutes}分`
  return `${minutes}分${seconds}秒`
}
