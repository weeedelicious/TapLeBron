import type { ResourceMeta } from './types'

export interface WhiteboardStoredState {
  snapshot?: unknown
  resultNodeId?: string
  updatedAtMs?: number
}

function stripFileExtension(fileName: string) {
  const trimmed = String(fileName || '').trim() || 'image'
  const lastDot = trimmed.lastIndexOf('.')
  if (lastDot <= 0) return trimmed
  return trimmed.slice(0, lastDot)
}

function normalizeImageFileName(baseName: string) {
  return `${stripFileExtension(baseName)}-annotation.png`
}

function mimeToExtension(mimeType: string) {
  const normalized = String(mimeType || '').toLowerCase()
  if (normalized === 'image/jpeg') return 'jpg'
  if (normalized === 'image/png') return 'png'
  if (normalized === 'image/webp') return 'webp'
  if (normalized === 'image/gif') return 'gif'
  return 'bin'
}

export function readWhiteboardState(advancedSettings?: Record<string, unknown>) {
  const raw = advancedSettings?.whiteboard
  if (!raw || typeof raw !== 'object') return null

  const entry = raw as Record<string, unknown>
  const updatedAtMs = Number(entry.updatedAtMs)

  return {
    snapshot: entry.snapshot,
    resultNodeId: typeof entry.resultNodeId === 'string' ? entry.resultNodeId : undefined,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : undefined,
  } as WhiteboardStoredState
}

export function writeWhiteboardState(
  advancedSettings: Record<string, unknown> | undefined,
  patch: WhiteboardStoredState
) {
  const current = readWhiteboardState(advancedSettings) ?? {}
  return {
    ...(advancedSettings ?? {}),
    whiteboard: {
      ...current,
      ...patch,
    },
  }
}

export function resourceMetaFromUploadPayload(
  meta: Record<string, unknown> | undefined,
  fallbackKind: ResourceMeta['kind']
) {
  if (!meta || typeof meta !== 'object') return null

  const width = Number(meta.width)
  const height = Number(meta.height)
  const durationSec = Number(meta.durationSec)
  const byteSize = Number(meta.byteSize)
  const displayByteSize = Number(meta.displayByteSize)
  const displayWidth = Number(meta.displayWidth)
  const displayHeight = Number(meta.displayHeight)
  const displayDurationSec = Number(meta.displayDurationSec)
  const createdAtMs = Number(meta.createdAtMs)
  const fps = Number(meta.fps ?? meta.frameRate)

  return {
    kind: fallbackKind,
    mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : undefined,
    extension: typeof meta.extension === 'string' ? meta.extension : undefined,
    hashSha1: typeof meta.sha1 === 'string' ? meta.sha1 : undefined,
    displayUrl: typeof meta.displayUrl === 'string' ? meta.displayUrl : undefined,
    originalUrl: typeof meta.originalUrl === 'string' ? meta.originalUrl : undefined,
    displayByteSize: Number.isFinite(displayByteSize) && displayByteSize > 0 ? displayByteSize : undefined,
    displayWidth: Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : undefined,
    displayHeight: Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : undefined,
    displayDurationSec: Number.isFinite(displayDurationSec) && displayDurationSec > 0 ? displayDurationSec : undefined,
    byteSize: Number.isFinite(byteSize) && byteSize > 0 ? byteSize : undefined,
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined,
    fps: Number.isFinite(fps) && fps > 0 ? fps : undefined,
    codecName: typeof meta.codecName === 'string' ? meta.codecName : undefined,
    codecProfile: typeof meta.codecProfile === 'string' ? meta.codecProfile : undefined,
    pixelFormat: typeof meta.pixelFormat === 'string' ? meta.pixelFormat : undefined,
    audioCodecName: typeof meta.audioCodecName === 'string' ? meta.audioCodecName : undefined,
    formatName: typeof meta.formatName === 'string' ? meta.formatName : undefined,
    createdAtMs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : Date.now(),
  } as ResourceMeta
}

export async function loadAssetFileFromUrl(url: string, fallbackName: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('资源加载失败，请稍后重试')

  const blob = await response.blob()
  const extension = mimeToExtension(blob.type)
  const normalizedName = `${stripFileExtension(fallbackName)}.${extension}`

  return new File([blob], normalizedName, {
    type: blob.type || 'application/octet-stream',
    lastModified: Date.now(),
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('标注导出失败'))
        return
      }
      resolve(blob)
    }, mimeType)
  })
}

export async function captureVideoFrameFile(video: HTMLVideoElement, fallbackName: string) {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
    throw new Error('视频还没准备好，请稍后再试')
  }

  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法处理视频标注')

  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const blob = await canvasToBlob(canvas, 'image/png')

  return new File([blob], normalizeImageFileName(fallbackName), {
    type: 'image/png',
    lastModified: Date.now(),
  })
}

function waitForMediaEvent(target: HTMLMediaElement, eventName: string, timeoutMs = 15000) {
  return new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timeoutId) window.clearTimeout(timeoutId)
      target.removeEventListener(eventName, onEvent)
      target.removeEventListener('error', onError)
    }
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('\u89c6\u9891\u5e27\u8bfb\u53d6\u5931\u8d25'))
    }
    timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error('\u89c6\u9891\u5e27\u8bfb\u53d6\u8d85\u65f6'))
    }, timeoutMs)
    target.addEventListener(eventName, onEvent, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

export async function captureVideoFrameFileFromUrl(url: string, timeSec: number, fallbackName: string) {
  const cleanUrl = String(url || '').trim()
  if (!cleanUrl) throw new Error('\u6ca1\u6709\u53ef\u622a\u53d6\u7684\u89c6\u9891')

  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = cleanUrl

  try {
    if (video.readyState < 1) await waitForMediaEvent(video, 'loadedmetadata')
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null
    const targetTime = Math.max(0, duration ? Math.min(timeSec, Math.max(0, duration - 0.001)) : timeSec)
    const safeTargetTime = Number.isFinite(targetTime) ? targetTime : 0
    if (Math.abs(video.currentTime - safeTargetTime) > 0.001) {
      video.currentTime = safeTargetTime
      await waitForMediaEvent(video, 'seeked')
    }
    if (video.readyState < 2) await waitForMediaEvent(video, 'loadeddata')
    return await captureVideoFrameFile(video, fallbackName)
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

export async function dataUrlToFile(dataUrl: string, fallbackName: string) {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return new File([blob], normalizeImageFileName(fallbackName), {
    type: blob.type || 'image/png',
    lastModified: Date.now(),
  })
}
