import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Loader2, Scissors, X } from 'lucide-react'

interface VideoTrimModalProps {
  url: string
  name: string
  durationHintSec?: number
  onCancel: () => void
  onConfirm: (range: { startSec: number; endSec: number }) => Promise<void> | void
}

type DragMode = 'start' | 'end' | 'range'

const MIN_TRIM_DURATION_SEC = 0.2
const THUMB_WIDTH = 144
const THUMB_HEIGHT = 80

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatTime(seconds: number) {
  const totalTenths = Math.max(0, Math.round((Number(seconds) || 0) * 10))
  const minutes = Math.floor(totalTenths / 600)
  const secs = Math.floor((totalTenths % 600) / 10)
  const tenths = totalTenths % 10
  return `${minutes}:${String(secs).padStart(2, '0')}.${tenths}`
}

function drawVideoCoverFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  targetWidth: number,
  targetHeight: number
) {
  const sourceWidth = Math.max(1, video.videoWidth || targetWidth)
  const sourceHeight = Math.max(1, video.videoHeight || targetHeight)
  const targetRatio = targetWidth / targetHeight
  const sourceRatio = sourceWidth / sourceHeight

  let drawWidth = targetWidth
  let drawHeight = targetHeight
  let offsetX = 0
  let offsetY = 0

  if (sourceRatio > targetRatio) {
    drawHeight = targetHeight
    drawWidth = drawHeight * sourceRatio
    offsetX = (targetWidth - drawWidth) / 2
  } else {
    drawWidth = targetWidth
    drawHeight = drawWidth / sourceRatio
    offsetY = (targetHeight - drawHeight) / 2
  }

  context.clearRect(0, 0, targetWidth, targetHeight)
  context.drawImage(video, offsetX, offsetY, drawWidth, drawHeight)
}

function waitForVideoMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', handleLoaded)
      video.removeEventListener('error', handleError)
    }

    const handleLoaded = () => {
      cleanup()
      resolve()
    }

    const handleError = () => {
      cleanup()
      reject(new Error('视频预览加载失败'))
    }

    if (video.readyState >= 1) {
      resolve()
      return
    }

    video.addEventListener('loadedmetadata', handleLoaded, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('error', handleError)
    }

    const handleSeeked = () => {
      cleanup()
      resolve()
    }

    const handleError = () => {
      cleanup()
      reject(new Error('视频帧定位失败'))
    }

    video.addEventListener('seeked', handleSeeked, { once: true })
    video.addEventListener('error', handleError, { once: true })
    video.currentTime = Math.max(0, time)
  })
}

export function VideoTrimModal({
  url,
  name,
  durationHintSec,
  onCancel,
  onConfirm,
}: VideoTrimModalProps) {
  const previewRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{
    mode: DragMode
    anchorSec: number
    originStartSec: number
    originEndSec: number
  } | null>(null)

  const [durationSec, setDurationSec] = useState(Math.max(0, Number(durationHintSec) || 0))
  const [startSec, setStartSec] = useState(0)
  const [endSec, setEndSec] = useState(Math.max(0, Number(durationHintSec) || 0))
  const [currentSec, setCurrentSec] = useState(0)
  const [isReady, setIsReady] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [dragging, setDragging] = useState<DragMode | null>(null)
  const [thumbnails, setThumbnails] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const durationValue = Math.max(0.01, durationSec || Number(durationHintSec) || 0.01)
  const startRatio = clamp(startSec / durationValue, 0, 1)
  const endRatio = clamp(endSec / durationValue, 0, 1)
  const playheadRatio = clamp(currentSec / durationValue, 0, 1)
  const clipDurationSec = Math.max(0, endSec - startSec)

  const thumbnailCount = useMemo(
    () => clamp(Math.ceil(durationValue / 2), 6, 10),
    [durationValue]
  )

  const pointToTime = useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
    return ratio * durationValue
  }, [durationValue])

  const scrubPreview = useCallback((time: number) => {
    const video = previewRef.current
    if (!video) return
    const nextTime = clamp(time, 0, durationValue)
    try {
      video.currentTime = nextTime
    } catch {
      // ignore failed seeks while metadata is still loading
    }
    setCurrentSec(nextTime)
  }, [durationValue])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSubmitting, onCancel])

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const dragState = dragStateRef.current
      if (!dragState) return

      const nextTime = pointToTime(event.clientX)
      if (dragState.mode === 'start') {
        const nextStart = clamp(nextTime, 0, Math.max(0, endSec - MIN_TRIM_DURATION_SEC))
        setStartSec(nextStart)
      } else if (dragState.mode === 'end') {
        const nextEnd = clamp(nextTime, startSec + MIN_TRIM_DURATION_SEC, durationValue)
        setEndSec(nextEnd)
      } else {
        const windowSec = dragState.originEndSec - dragState.originStartSec
        const delta = nextTime - dragState.anchorSec
        const maxStart = Math.max(0, durationValue - windowSec)
        const nextStart = clamp(dragState.originStartSec + delta, 0, maxStart)
        const nextEnd = nextStart + windowSec
        setStartSec(nextStart)
        setEndSec(nextEnd)
      }
    }

    const handleMouseUp = () => {
      dragStateRef.current = null
      setDragging(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [durationValue, endSec, pointToTime, startSec])

  useEffect(() => {
    const video = previewRef.current
    if (!video || !isReady) return
    if (video.currentTime < startSec || video.currentTime > endSec) {
      scrubPreview(startSec)
    }
  }, [endSec, isReady, scrubPreview, startSec])

  useEffect(() => {
    let cancelled = false

    const generateThumbnails = async () => {
      if (!url || !durationSec || !Number.isFinite(durationSec) || durationSec <= 0) {
        setThumbnails([])
        return
      }

      try {
        const video = document.createElement('video')
        video.src = url
        video.preload = 'auto'
        video.muted = true
        video.playsInline = true
        video.crossOrigin = 'anonymous'

        await waitForVideoMetadata(video)
        if (cancelled) return

        const canvas = document.createElement('canvas')
        canvas.width = THUMB_WIDTH
        canvas.height = THUMB_HEIGHT
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法生成视频缩略帧')

        const frames: string[] = []
        for (let index = 0; index < thumbnailCount; index += 1) {
          const frameTime = thumbnailCount === 1
            ? 0
            : (durationSec * index) / Math.max(1, thumbnailCount - 1)
          await seekVideo(video, clamp(frameTime, 0, Math.max(0, durationSec - 0.05)))
          if (cancelled) return
          drawVideoCoverFrame(context, video, THUMB_WIDTH, THUMB_HEIGHT)
          frames.push(canvas.toDataURL('image/jpeg', 0.72))
        }

        if (!cancelled) setThumbnails(frames)
      } catch {
        if (!cancelled) setThumbnails([])
      }
    }

    void generateThumbnails()

    return () => {
      cancelled = true
    }
  }, [durationSec, thumbnailCount, url])

  const startDrag = useCallback((event: ReactMouseEvent, mode: DragMode) => {
    event.preventDefault()
    event.stopPropagation()

    const anchorSec = pointToTime(event.clientX)
    dragStateRef.current = {
      mode,
      anchorSec,
      originStartSec: startSec,
      originEndSec: endSec,
    }
    setDragging(mode)
  }, [endSec, pointToTime, startSec])

  const handleTrackMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const nextTime = pointToTime(event.clientX)
    scrubPreview(nextTime)
  }, [pointToTime, scrubPreview])

  const handlePreviewMetadata = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    const nextDuration = Math.max(0.01, Number(video.duration) || Number(durationHintSec) || 0.01)
    setDurationSec(nextDuration)
    setEndSec((current) => {
      if (current > 0) return clamp(current, MIN_TRIM_DURATION_SEC, nextDuration)
      return nextDuration
    })
    setIsReady(true)
  }, [durationHintSec])

  const handlePreviewTimeUpdate = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    const nextCurrent = video.currentTime || 0
    if (nextCurrent >= endSec - 0.02 && endSec > startSec) {
      video.pause()
      try {
        video.currentTime = startSec
      } catch {
        // ignore failed seek at playback boundary
      }
      setCurrentSec(startSec)
      return
    }
    setCurrentSec(nextCurrent)
  }, [endSec, startSec])

  const handlePreviewPlay = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    if (video.currentTime < startSec || video.currentTime >= endSec) {
      try {
        video.currentTime = startSec
      } catch {
        // ignore failed seek while switching ranges
      }
    }
  }, [endSec, startSec])

  const handleSubmit = useCallback(async () => {
    if (!isReady || isSubmitting) return
    if (clipDurationSec < MIN_TRIM_DURATION_SEC) {
      setError('裁剪时长至少需要 0.2 秒')
      return
    }

    setError(null)
    setIsSubmitting(true)
    try {
      await onConfirm({
        startSec: Number(startSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
      })
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : '裁剪失败'
      setError(message)
      setIsSubmitting(false)
    }
  }, [clipDurationSec, endSec, isReady, isSubmitting, onConfirm, startSec])

  return createPortal(
    <div
      className="nodrag"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(0,0,0,0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) onCancel()
      }}
    >
      <div
        className="nodrag"
        style={{
          width: 'min(960px, calc(100vw - 48px))',
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div
          style={{
            background: '#151022',
            border: '1px solid #312550',
            borderRadius: 18,
            overflow: 'hidden',
            boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '14px 18px',
              borderBottom: '1px solid #2a2040',
              color: '#f3efff',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(124,92,252,0.14)',
                  color: '#d7ccff',
                  flexShrink: 0,
                }}
              >
                <Scissors size={16} strokeWidth={1.9} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {name || '视频裁剪'}
                </div>
                <div style={{ marginTop: 3, fontSize: 12, color: '#9a8fbc' }}>
                  {formatTime(startSec)} - {formatTime(endSec)} · 片段 {formatTime(clipDurationSec)}
                </div>
              </div>
            </div>

            <button
              className="nodrag"
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: '1px solid #312550',
                background: '#1d1730',
                color: '#b9addd',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: isSubmitting ? 'default' : 'pointer',
                opacity: isSubmitting ? 0.5 : 1,
              }}
              title="关闭"
            >
              <X size={16} strokeWidth={1.9} />
            </button>
          </div>

          <div style={{ padding: 18 }}>
            <div
              style={{
                background: '#09070f',
                borderRadius: 14,
                overflow: 'hidden',
                border: '1px solid #241a38',
              }}
            >
              <video
                ref={previewRef}
                src={url}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={handlePreviewMetadata}
                onTimeUpdate={handlePreviewTimeUpdate}
                onPlay={handlePreviewPlay}
                style={{
                  display: 'block',
                  width: '100%',
                  maxHeight: '56vh',
                  background: '#000',
                }}
              />
            </div>
          </div>

          <div style={{ padding: '0 18px 18px' }}>
            <div
              style={{
                background: '#130f20',
                border: '1px solid #2a2040',
                borderRadius: 16,
                padding: 14,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f3efff' }}>
                  <span style={pillStyle}>{formatTime(startSec)}</span>
                  <span style={{ color: '#6f6491', fontSize: 12 }}>到</span>
                  <span style={pillStyle}>{formatTime(endSec)}</span>
                </div>
                <div style={{ fontSize: 12, color: '#9388b8' }}>
                  拖动两侧把手，或拖动中间选区整体移动
                </div>
              </div>

              <div
                ref={trackRef}
                className="nodrag"
                style={{
                  position: 'relative',
                  height: 92,
                  borderRadius: 14,
                  overflow: 'hidden',
                  background: '#0d0a17',
                  border: '1px solid #2d2344',
                  cursor: dragging === 'range' ? 'grabbing' : 'pointer',
                }}
                onMouseDown={handleTrackMouseDown}
              >
                {thumbnails.length > 0 ? (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(${thumbnails.length}, minmax(0, 1fr))`,
                      width: '100%',
                      height: '100%',
                    }}
                  >
                    {thumbnails.map((thumb, index) => (
                      <div key={`${thumb}-${index}`} style={{ position: 'relative', overflow: 'hidden' }}>
                        <img
                          src={thumb}
                          alt=""
                          draggable={false}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            display: 'block',
                            opacity: 0.92,
                          }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'linear-gradient(90deg, rgba(124,92,252,0.14), rgba(124,92,252,0.04))',
                    }}
                  />
                )}

                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: `${startRatio * 100}%`,
                    background: 'rgba(7,6,13,0.7)',
                    pointerEvents: 'none',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    right: 0,
                    width: `${(1 - endRatio) * 100}%`,
                    background: 'rgba(7,6,13,0.7)',
                    pointerEvents: 'none',
                  }}
                />

                <div
                  className="nodrag"
                  style={{
                    position: 'absolute',
                    top: 6,
                    bottom: 6,
                    left: `${startRatio * 100}%`,
                    width: `${Math.max(0, (endRatio - startRatio) * 100)}%`,
                    border: '2px solid #ffffff',
                    borderRadius: 12,
                    boxShadow: 'inset 0 0 0 1px rgba(124,92,252,0.3)',
                    background: 'rgba(255,255,255,0.02)',
                    cursor: dragging === 'range' ? 'grabbing' : 'grab',
                  }}
                  onMouseDown={(event) => startDrag(event, 'range')}
                />

                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: `${playheadRatio * 100}%`,
                    width: 2,
                    background: 'rgba(255,255,255,0.95)',
                    boxShadow: '0 0 12px rgba(255,255,255,0.55)',
                    pointerEvents: 'none',
                  }}
                />

                <button
                  className="nodrag"
                  type="button"
                  onMouseDown={(event) => startDrag(event, 'start')}
                  style={{
                    position: 'absolute',
                    top: 4,
                    bottom: 4,
                    left: `calc(${startRatio * 100}% - 11px)`,
                    width: 22,
                    borderRadius: 11,
                    border: 'none',
                    background: '#ffffff',
                    boxShadow: '0 8px 18px rgba(0,0,0,0.35)',
                    cursor: 'ew-resize',
                  }}
                  title="拖动开始时间"
                >
                  <span style={handleMarkStyle} />
                </button>

                <button
                  className="nodrag"
                  type="button"
                  onMouseDown={(event) => startDrag(event, 'end')}
                  style={{
                    position: 'absolute',
                    top: 4,
                    bottom: 4,
                    left: `calc(${endRatio * 100}% - 11px)`,
                    width: 22,
                    borderRadius: 11,
                    border: 'none',
                    background: '#ffffff',
                    boxShadow: '0 8px 18px rgba(0,0,0,0.35)',
                    cursor: 'ew-resize',
                  }}
                  title="拖动结束时间"
                >
                  <span style={handleMarkStyle} />
                </button>
              </div>

              {error && (
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 12,
                    background: '#2a1020',
                    color: '#ff7f94',
                    fontSize: 12,
                  }}
                >
                  {error}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14 }}>
                <div style={{ fontSize: 12, color: '#8f84b2' }}>
                  总时长 {formatTime(durationValue)}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    className="nodrag"
                    type="button"
                    onClick={onCancel}
                    disabled={isSubmitting}
                    style={{
                      ...actionButtonStyle,
                      background: '#1b162b',
                      color: '#d3caf0',
                      border: '1px solid #312550',
                      cursor: isSubmitting ? 'default' : 'pointer',
                      opacity: isSubmitting ? 0.55 : 1,
                    }}
                  >
                    取消
                  </button>
                  <button
                    className="nodrag"
                    type="button"
                    onClick={handleSubmit}
                    disabled={!isReady || isSubmitting}
                    style={{
                      ...actionButtonStyle,
                      background: '#ffffff',
                      color: '#111111',
                      border: 'none',
                      cursor: !isReady || isSubmitting ? 'default' : 'pointer',
                      opacity: !isReady || isSubmitting ? 0.65 : 1,
                    }}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                        处理中
                      </>
                    ) : (
                      <>
                        <Check size={15} strokeWidth={2.1} />
                        保存裁剪
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

const pillStyle: CSSProperties = {
  padding: '4px 9px',
  borderRadius: 999,
  border: '1px solid #312550',
  background: '#1d1730',
  color: '#efe9ff',
  fontSize: 12,
  fontWeight: 600,
}

const handleMarkStyle: CSSProperties = {
  width: 6,
  height: 24,
  display: 'inline-block',
  borderRadius: 999,
  background: 'linear-gradient(180deg, #b8b8c2, #767684)',
}

const actionButtonStyle: CSSProperties = {
  minWidth: 104,
  height: 40,
  padding: '0 16px',
  borderRadius: 12,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  fontSize: 14,
  fontWeight: 600,
}
