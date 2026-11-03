/**
 * 把预演帧录成 WebM。上传时由服务端转成 H.264/yuv420p MP4（和视频对比导出同一条路）。
 */
export const REHEARSAL_UPLOAD_OPTIONS = {
  sourceType: 'director-stage-rehearsal',
  normalizeVideoToMp4: true,
} as const

export function pickRehearsalRecorderMime() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return 'video/webm'
}

function waitMs(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), Math.max(0, ms))
  })
}

export async function encodeCanvasFrames(args: {
  canvas: HTMLCanvasElement
  frameCount: number
  fps: number
  fileName: string
  draw: (index: number) => void | Promise<void>
  onProgress?: (done: number, total: number) => void
}): Promise<File> {
  if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不能录视频')
  const frameCount = Math.max(2, Math.round(args.frameCount))
  const fps = Math.max(1, Math.round(args.fps || 24))
  const mimeType = pickRehearsalRecorderMime()
  const stream = args.canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
  const bitsPerPixel = 8
  const videoBitsPerSecond = Math.min(
    40_000_000,
    Math.max(8_000_000, Math.round(args.canvas.width * args.canvas.height * fps * bitsPerPixel)),
  )
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  const requestFrame = () => {
    if (typeof track.requestFrame === 'function') track.requestFrame()
  }

  recorder.start(100)
  const paceMs = Math.max(16, Math.round(1000 / fps))

  for (let index = 0; index < frameCount; index += 1) {
    await args.draw(index)
    requestFrame()
    args.onProgress?.(index + 1, frameCount)
    await waitMs(paceMs)
  }

  await waitMs(paceMs)
  await new Promise<void>((resolve, reject) => {
    recorder.onerror = () => reject(new Error('白模参考视频录制失败'))
    recorder.onstop = () => resolve()
    recorder.stop()
  })
  stream.getTracks().forEach((item) => item.stop())

  const blob = new Blob(chunks, { type: mimeType.split(';')[0] })
  if (blob.size <= 0) throw new Error('白模参考视频是空的')
  return new File([blob], args.fileName, { type: blob.type, lastModified: Date.now() })
}
