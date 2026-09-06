import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Crop, Loader2, X } from 'lucide-react'

interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

interface VideoCropModalProps {
  url: string
  name: string
  sourceWidthHint?: number
  sourceHeightHint?: number
  onCancel: () => void
  onConfirm: (crop: CropRect) => Promise<void> | void
}

type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

const MIN_CROP_SIZE = 32

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function roundRect(rect: CropRect): CropRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function createDefaultCrop(width: number, height: number): CropRect {
  const safeWidth = Math.max(MIN_CROP_SIZE, Math.round(width || 1280))
  const safeHeight = Math.max(MIN_CROP_SIZE, Math.round(height || 720))
  const cropWidth = clamp(Math.round(safeWidth * 0.8), MIN_CROP_SIZE, safeWidth)
  const cropHeight = clamp(Math.round(safeHeight * 0.8), MIN_CROP_SIZE, safeHeight)
  return {
    x: Math.round((safeWidth - cropWidth) / 2),
    y: Math.round((safeHeight - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  }
}

function fitFrame(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number) {
  const safeWidth = Math.max(1, sourceWidth)
  const safeHeight = Math.max(1, sourceHeight)
  let width = Math.min(maxWidth, safeWidth)
  let height = width * (safeHeight / safeWidth)

  if (height > maxHeight) {
    height = maxHeight
    width = height * (safeWidth / safeHeight)
  }

  return {
    width: Math.max(280, Math.round(width)),
    height: Math.max(180, Math.round(height)),
  }
}

function cropBoxCursor(handle: ResizeHandle) {
  switch (handle) {
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'nw':
    case 'se':
      return 'nwse-resize'
    default:
      return 'default'
  }
}

export function VideoCropModal({
  url,
  name,
  sourceWidthHint,
  sourceHeightHint,
  onCancel,
  onConfirm,
}: VideoCropModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{
    mode: 'move' | 'resize'
    handle?: ResizeHandle
    startClientX: number
    startClientY: number
    originRect: CropRect
  } | null>(null)

  const [sourceSize, setSourceSize] = useState(() => ({
    width: Math.max(MIN_CROP_SIZE, Math.round(sourceWidthHint || 1280)),
    height: Math.max(MIN_CROP_SIZE, Math.round(sourceHeightHint || 720)),
  }))
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 })
  const [cropRect, setCropRect] = useState(() => createDefaultCrop(sourceWidthHint || 1280, sourceHeightHint || 720))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight

  const previewFrame = useMemo(
    () => fitFrame(sourceSize.width, sourceSize.height, Math.min(viewportWidth - 96, 980), Math.min(viewportHeight - 260, 620)),
    [sourceSize.height, sourceSize.width, viewportHeight, viewportWidth]
  )

  useEffect(() => {
    setCropRect(createDefaultCrop(sourceSize.width, sourceSize.height))
  }, [sourceSize.height, sourceSize.width, url])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSubmitting, onCancel])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    const updateSize = () => {
      const rect = frame.getBoundingClientRect()
      setDisplaySize({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(frame)
    window.addEventListener('resize', updateSize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateSize)
    }
  }, [])

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const dragState = dragStateRef.current
      if (!dragState || displaySize.width <= 0 || displaySize.height <= 0) return

      const scaleX = displaySize.width / Math.max(1, sourceSize.width)
      const scaleY = displaySize.height / Math.max(1, sourceSize.height)
      const deltaX = (event.clientX - dragState.startClientX) / Math.max(scaleX, 0.0001)
      const deltaY = (event.clientY - dragState.startClientY) / Math.max(scaleY, 0.0001)

      if (dragState.mode === 'move') {
        const nextRect = roundRect({
          x: clamp(dragState.originRect.x + deltaX, 0, Math.max(0, sourceSize.width - dragState.originRect.width)),
          y: clamp(dragState.originRect.y + deltaY, 0, Math.max(0, sourceSize.height - dragState.originRect.height)),
          width: dragState.originRect.width,
          height: dragState.originRect.height,
        })
        setCropRect(nextRect)
        return
      }

      const handle = dragState.handle
      if (!handle) return

      let left = dragState.originRect.x
      let top = dragState.originRect.y
      let right = dragState.originRect.x + dragState.originRect.width
      let bottom = dragState.originRect.y + dragState.originRect.height

      if (handle.includes('w')) {
        left = clamp(dragState.originRect.x + deltaX, 0, right - MIN_CROP_SIZE)
      }
      if (handle.includes('e')) {
        right = clamp(
          dragState.originRect.x + dragState.originRect.width + deltaX,
          left + MIN_CROP_SIZE,
          sourceSize.width
        )
      }
      if (handle.includes('n')) {
        top = clamp(dragState.originRect.y + deltaY, 0, bottom - MIN_CROP_SIZE)
      }
      if (handle.includes('s')) {
        bottom = clamp(
          dragState.originRect.y + dragState.originRect.height + deltaY,
          top + MIN_CROP_SIZE,
          sourceSize.height
        )
      }

      setCropRect(roundRect({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      }))
    }

    const handleMouseUp = () => {
      dragStateRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [displaySize.height, displaySize.width, sourceSize.height, sourceSize.width])

  const handleMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const nextWidth = Math.max(MIN_CROP_SIZE, Math.round(video.videoWidth || sourceWidthHint || 1280))
    const nextHeight = Math.max(MIN_CROP_SIZE, Math.round(video.videoHeight || sourceHeightHint || 720))
    setSourceSize({ width: nextWidth, height: nextHeight })
    setIsReady(true)
    setError(null)
    try {
      video.currentTime = Math.min(0.05, Math.max(0, (video.duration || 0) - 0.05))
      video.pause()
    } catch {
      // ignore preview seek failures
    }
  }, [sourceHeightHint, sourceWidthHint])

  const startMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragStateRef.current = {
      mode: 'move',
      startClientX: event.clientX,
      startClientY: event.clientY,
      originRect: cropRect,
    }
  }, [cropRect])

  const startResize = useCallback((handle: ResizeHandle, event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragStateRef.current = {
      mode: 'resize',
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originRect: cropRect,
    }
  }, [cropRect])

  const handleConfirm = useCallback(async () => {
    if (isSubmitting) return
    setIsSubmitting(true)
    setError(null)
    try {
      await onConfirm(roundRect(cropRect))
    } catch (cropError) {
      setError(cropError instanceof Error ? cropError.message : '视频裁剪失败')
    } finally {
      setIsSubmitting(false)
    }
  }, [cropRect, isSubmitting, onConfirm])

  const scaleX = displaySize.width > 0 ? displaySize.width / Math.max(1, sourceSize.width) : 1
  const scaleY = displaySize.height > 0 ? displaySize.height / Math.max(1, sourceSize.height) : 1
  const displayCrop = {
    left: cropRect.x * scaleX,
    top: cropRect.y * scaleY,
    width: cropRect.width * scaleX,
    height: cropRect.height * scaleY,
  }

  const handles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 12000,
        background: 'rgba(0,0,0,0.74)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onMouseDown={() => {
        if (!isSubmitting) onCancel()
      }}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: `min(${previewFrame.width + 96}px, calc(100vw - 40px))`,
          maxWidth: 'calc(100vw - 40px)',
          borderRadius: 22,
          border: '1px solid #312550',
          background: '#12101b',
          boxShadow: '0 28px 80px rgba(0,0,0,0.52)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '16px 18px 14px',
            borderBottom: '1px solid #241b3d',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 12,
                background: 'rgba(124,92,252,0.12)',
                border: '1px solid #3a2b61',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#cbbdfd',
                flexShrink: 0,
              }}
            >
              <Crop size={16} strokeWidth={1.9} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#f5f1ff', fontSize: 15, fontWeight: 600 }}>裁剪视频</div>
              <div
                style={{
                  color: '#8c82aa',
                  fontSize: 12,
                  marginTop: 2,
                  maxWidth: 420,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={name}
              >
                {name}
              </div>
            </div>
          </div>
          <button
            onClick={onCancel}
            disabled={isSubmitting}
            style={{
              width: 34,
              height: 34,
              borderRadius: 12,
              border: '1px solid #312550',
              background: '#181327',
              color: '#b9aedf',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: isSubmitting ? 'default' : 'pointer',
              opacity: isSubmitting ? 0.5 : 1,
            }}
            aria-label="关闭"
          >
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>

        <div style={{ padding: '20px 22px 10px' }}>
          <div
            ref={frameRef}
            style={{
              width: previewFrame.width,
              maxWidth: '100%',
              margin: '0 auto',
              position: 'relative',
              borderRadius: 18,
              overflow: 'hidden',
              background: '#050507',
              border: '1px solid #2d234b',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.02)',
            }}
          >
            <video
              ref={videoRef}
              src={url}
              preload="metadata"
              playsInline
              muted
              onLoadedMetadata={handleMetadata}
              onLoadedData={handleMetadata}
              onError={() => {
                setError('视频预览加载失败')
                setIsReady(false)
              }}
              style={{
                width: '100%',
                height: 'auto',
                display: 'block',
                background: '#000',
                userSelect: 'none',
              }}
            />

            <div
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
              }}
            >
              <div
                onMouseDown={startMove}
                style={{
                  position: 'absolute',
                  left: displayCrop.left,
                  top: displayCrop.top,
                  width: displayCrop.width,
                  height: displayCrop.height,
                  border: '2px solid rgba(255,255,255,0.92)',
                  borderRadius: 10,
                  boxShadow: '0 0 0 99999px rgba(0,0,0,0.54)',
                  pointerEvents: 'auto',
                  cursor: 'move',
                  background: 'linear-gradient(rgba(255,255,255,0.02), rgba(255,255,255,0.02))',
                }}
              >
                {[1 / 3, 2 / 3].map((ratio) => (
                  <div
                    key={`v-${ratio}`}
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: `${ratio * 100}%`,
                      width: 1,
                      background: 'rgba(255,255,255,0.34)',
                    }}
                  />
                ))}
                {[1 / 3, 2 / 3].map((ratio) => (
                  <div
                    key={`h-${ratio}`}
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: `${ratio * 100}%`,
                      height: 1,
                      background: 'rgba(255,255,255,0.34)',
                    }}
                  />
                ))}

                {handles.map((handle) => {
                  const vertical = handle.includes('n') ? 0 : handle.includes('s') ? '100%' : '50%'
                  const horizontal = handle.includes('w') ? 0 : handle.includes('e') ? '100%' : '50%'
                  return (
                    <div
                      key={handle}
                      onMouseDown={(event) => startResize(handle, event)}
                      style={{
                        position: 'absolute',
                        top: vertical,
                        left: horizontal,
                        width: 14,
                        height: 14,
                        borderRadius: 999,
                        border: '2px solid rgba(255,255,255,0.92)',
                        background: '#12101b',
                        transform: 'translate(-50%, -50%)',
                        cursor: cropBoxCursor(handle),
                        boxShadow: '0 0 0 3px rgba(0,0,0,0.14)',
                      }}
                    />
                  )
                })}
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              marginTop: 18,
              borderRadius: 18,
              border: '1px solid #312550',
              background: '#171222',
              padding: '10px 14px',
            }}
          >
            <button
              onClick={onCancel}
              disabled={isSubmitting}
              style={{
                width: 42,
                height: 42,
                borderRadius: 14,
                border: '1px solid #312550',
                background: '#181327',
                color: '#b9aedf',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: isSubmitting ? 'default' : 'pointer',
                opacity: isSubmitting ? 0.5 : 1,
                flexShrink: 0,
              }}
              aria-label="取消"
            >
              <X size={18} strokeWidth={1.9} />
            </button>

            <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
              <div style={{ color: '#f5f1ff', fontSize: 17, fontWeight: 600 }}>
                {cropRect.width} x {cropRect.height}
              </div>
              <div style={{ color: '#8c82aa', fontSize: 12, marginTop: 2 }}>
                拖动边框调整裁剪区域
              </div>
            </div>

            <button
              onClick={handleConfirm}
              disabled={!isReady || isSubmitting}
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                border: 'none',
                background: !isReady || isSubmitting ? '#2b2540' : '#ffffff',
                color: !isReady || isSubmitting ? '#8f83bc' : '#111',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: !isReady || isSubmitting ? 'default' : 'pointer',
                flexShrink: 0,
                boxShadow: !isReady || isSubmitting ? 'none' : '0 10px 20px rgba(0,0,0,0.26)',
              }}
              aria-label="确认裁剪"
            >
              {isSubmitting
                ? <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
                : <Check size={20} strokeWidth={2.1} />}
            </button>
          </div>

          {error && (
            <div
              style={{
                marginTop: 12,
                borderRadius: 14,
                border: '1px solid rgba(255,80,120,0.18)',
                background: 'rgba(118,21,46,0.55)',
                color: '#ff9fbb',
                padding: '11px 14px',
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
