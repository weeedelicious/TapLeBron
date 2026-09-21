import { useCallback, useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Gauge, Loader2, X } from 'lucide-react'

export const VIDEO_FRAME_INTERPOLATION_TARGETS = [30, 60, 120] as const
export type VideoFrameInterpolationMethod = 'quality' | 'openflowframes' | 'video2x'

export const VIDEO_FRAME_INTERPOLATION_METHODS: Array<{
  id: VideoFrameInterpolationMethod
  name: string
  model: string
  description: string
  recommended?: boolean
}> = [
  {
    id: 'openflowframes',
    name: 'OpenFlowFrames',
    model: 'RIFE 4.26 · 精确目标帧数',
    description: '直接生成目标总帧数，24→30 不经过丢帧，运动边缘更自然。',
    recommended: true,
  },
  {
    id: 'video2x',
    name: 'Video2X 6.4',
    model: 'RIFE 4.26 · 2× 后精确重定时',
    description: '先用 Video2X RIFE 生成高帧率无损中间帧，再按时间轴精确输出 30fps。',
  },
  {
    id: 'quality',
    name: 'FFmpeg 光流',
    model: 'MCI 运动补偿',
    description: '兼容保底方法，不依赖 GPU 深度学习模型。',
  },
]

interface VideoFrameInterpolationModalProps {
  url: string
  name: string
  sourceFpsHint?: number
  sourceWidthHint?: number
  sourceHeightHint?: number
  durationHintSec?: number
  onCancel: () => void
  onConfirm: (targetFps: number, method: VideoFrameInterpolationMethod) => Promise<void> | void
}

function finitePositive(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function formatFps(value: number) {
  if (!value) return '读取中'
  return `${Number(value.toFixed(3))} fps`
}

function formatDuration(value: number) {
  if (!value) return '—'
  const totalSeconds = Math.max(0, Math.round(value))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const cardStyle: CSSProperties = {
  width: 'min(700px, calc(100vw - 40px))',
  maxHeight: 'calc(100vh - 40px)',
  overflowY: 'auto',
  borderRadius: 20,
  border: '1px solid #382966',
  background: 'linear-gradient(180deg, #171129, #0f0c18)',
  boxShadow: '0 28px 90px rgba(0,0,0,0.58), inset 0 1px 0 rgba(255,255,255,0.06)',
}

export function VideoFrameInterpolationModal({
  url,
  name,
  sourceFpsHint,
  sourceWidthHint,
  sourceHeightHint,
  durationHintSec,
  onCancel,
  onConfirm,
}: VideoFrameInterpolationModalProps) {
  const [sourceFps, setSourceFps] = useState(() => finitePositive(sourceFpsHint))
  const [sourceWidth, setSourceWidth] = useState(() => Math.round(finitePositive(sourceWidthHint)))
  const [sourceHeight, setSourceHeight] = useState(() => Math.round(finitePositive(sourceHeightHint)))
  const [durationSec, setDurationSec] = useState(() => finitePositive(durationHintSec))
  const [targetFps, setTargetFps] = useState(() => {
    const hint = finitePositive(sourceFpsHint)
    return VIDEO_FRAME_INTERPOLATION_TARGETS.find((value) => !hint || value > hint + 0.01) ?? 30
  })
  const [method, setMethod] = useState<VideoFrameInterpolationMethod>('openflowframes')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const availableTargets = useMemo(
    () => VIDEO_FRAME_INTERPOLATION_TARGETS.filter((value) => !sourceFps || value > sourceFps + 0.01),
    [sourceFps],
  )

  useEffect(() => {
    if (availableTargets.length > 0 && !availableTargets.includes(targetFps as 30 | 60 | 120)) {
      setTargetFps(availableTargets[0])
    }
  }, [availableTargets, targetFps])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSubmitting, onCancel])

  const handleMetadata = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    if (video.videoWidth > 0) setSourceWidth(video.videoWidth)
    if (video.videoHeight > 0) setSourceHeight(video.videoHeight)
    if (Number.isFinite(video.duration) && video.duration > 0) setDurationSec(video.duration)
  }, [])

  const handleConfirm = useCallback(async () => {
    if (isSubmitting || !targetFps) return
    if (sourceFps > 0 && targetFps <= sourceFps + 0.01) {
      setError('目标帧率必须高于源视频帧率')
      return
    }
    setError(null)
    setIsSubmitting(true)
    try {
      await onConfirm(targetFps, method)
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '视频补帧失败')
      setIsSubmitting(false)
    }
  }, [isSubmitting, method, onConfirm, sourceFps, targetFps])

  return createPortal(
    <div
      className="nodrag"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        background: 'rgba(2,1,7,0.82)',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) onCancel()
      }}
    >
      <div className="nodrag" style={cardStyle} onMouseDown={(event) => event.stopPropagation()}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '16px 18px 14px',
            borderBottom: '1px solid #2b2048',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#d9ceff',
                background: 'rgba(124,92,252,0.16)',
                border: '1px solid rgba(167,139,250,0.28)',
                flexShrink: 0,
              }}
            >
              <Gauge size={18} strokeWidth={1.9} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#f6f1ff', fontSize: 16, fontWeight: 700 }}>视频补帧</div>
              <div
                title={name}
                style={{
                  marginTop: 3,
                  color: '#9185b4',
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 430,
                }}
              >
                {name || '视频'}
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            disabled={isSubmitting}
            onClick={onCancel}
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              border: '1px solid #382b5d',
              background: '#1b1530',
              color: '#b9addb',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: isSubmitting ? 'default' : 'pointer',
              opacity: isSubmitting ? 0.5 : 1,
            }}
          >
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>

        <div style={{ padding: 18 }}>
          <div
            style={{
              borderRadius: 14,
              overflow: 'hidden',
              border: '1px solid #2b2148',
              background: '#050408',
            }}
          >
            <video
              src={url}
              controls
              muted
              playsInline
              preload="metadata"
              onLoadedMetadata={handleMetadata}
              style={{ display: 'block', width: '100%', maxHeight: '42vh', background: '#000' }}
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 8,
              marginTop: 12,
            }}
          >
            <InfoCell label="源帧率" value={formatFps(sourceFps)} />
            <InfoCell label="分辨率" value={sourceWidth && sourceHeight ? `${sourceWidth} × ${sourceHeight}` : '读取中'} />
            <InfoCell label="时长" value={formatDuration(durationSec)} />
          </div>

          <div
            style={{
              marginTop: 14,
              padding: 14,
              borderRadius: 14,
              border: '1px solid #302451',
              background: 'rgba(31,23,56,0.58)',
            }}
          >
            <div style={{ color: '#eee8ff', fontSize: 13, fontWeight: 700, marginBottom: 10 }}>补帧方法</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {VIDEO_FRAME_INTERPOLATION_METHODS.map((option) => {
                const active = method === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => setMethod(option.id)}
                    style={{
                      width: '100%',
                      padding: '11px 12px',
                      borderRadius: 11,
                      border: active ? '1px solid #a78bfa' : '1px solid #392b5c',
                      background: active ? 'rgba(124,92,252,0.18)' : '#171128',
                      color: '#eee8ff',
                      textAlign: 'left',
                      cursor: isSubmitting ? 'default' : 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 750 }}>{option.name}</span>
                      {option.recommended && (
                        <span style={{ color: '#d8ceff', fontSize: 10, padding: '2px 7px', borderRadius: 999, background: 'rgba(124,92,252,0.32)' }}>
                          推荐
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 3, color: active ? '#cfc2f8' : '#9e91c2', fontSize: 11, fontWeight: 650 }}>{option.model}</div>
                    <div style={{ marginTop: 3, color: '#8175a3', fontSize: 11, lineHeight: 1.45 }}>{option.description}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div
            style={{
              marginTop: 14,
              padding: 14,
              borderRadius: 14,
              border: '1px solid #302451',
              background: 'rgba(31,23,56,0.58)',
            }}
          >
            <div style={{ color: '#eee8ff', fontSize: 13, fontWeight: 700, marginBottom: 10 }}>目标帧率</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {VIDEO_FRAME_INTERPOLATION_TARGETS.map((value) => {
                const disabled = Boolean(sourceFps && value <= sourceFps + 0.01)
                const active = targetFps === value
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={disabled || isSubmitting}
                    onClick={() => setTargetFps(value)}
                    style={{
                      minWidth: 92,
                      height: 42,
                      padding: '0 14px',
                      borderRadius: 10,
                      border: active ? '1px solid #a78bfa' : '1px solid #3b2c61',
                      background: active ? 'rgba(124,92,252,0.82)' : '#1a1430',
                      color: disabled ? '#655b7f' : active ? '#fff' : '#c9bdf0',
                      cursor: disabled || isSubmitting ? 'default' : 'pointer',
                      opacity: disabled ? 0.5 : 1,
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    {value} fps
                  </button>
                )
              })}
            </div>
            {availableTargets.length === 0 && (
              <div style={{ marginTop: 9, color: '#fca5a5', fontSize: 12 }}>当前源视频帧率已不低于可选目标，无需补帧。</div>
            )}
          </div>

          <div
            style={{
              marginTop: 12,
              padding: '11px 13px',
              borderRadius: 12,
              border: '1px solid rgba(167,139,250,0.2)',
              background: 'rgba(124,92,252,0.07)',
              color: '#a99bcf',
              fontSize: 11,
              lineHeight: 1.65,
            }}
          >
            <div style={{ color: '#d8ceff', fontWeight: 700, marginBottom: 2 }}>画质优先输出</div>
            <div>{VIDEO_FRAME_INTERPOLATION_METHODS.find((option) => option.id === method)?.model}</div>
            <div>保留原分辨率与音轨 · 首末帧保护 · H.264 High · yuv420p · MP4 · CRF 12 · RV 兼容</div>
          </div>

          {error && (
            <div
              style={{
                marginTop: 12,
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(248,113,113,0.28)',
                background: 'rgba(127,29,29,0.28)',
                color: '#fca5a5',
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={onCancel}
              style={{
                height: 40,
                padding: '0 16px',
                borderRadius: 10,
                border: '1px solid #3b2c61',
                background: '#1a1430',
                color: '#b9addb',
                cursor: isSubmitting ? 'default' : 'pointer',
              }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={isSubmitting || availableTargets.length === 0}
              onClick={handleConfirm}
              style={{
                minWidth: 118,
                height: 40,
                padding: '0 16px',
                borderRadius: 10,
                border: 'none',
                background: isSubmitting || availableTargets.length === 0 ? '#322951' : '#fff',
                color: isSubmitting || availableTargets.length === 0 ? '#978abd' : '#17111f',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                cursor: isSubmitting || availableTargets.length === 0 ? 'default' : 'pointer',
                fontWeight: 700,
              }}
            >
              {isSubmitting ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={16} strokeWidth={2.2} />}
              {isSubmitting ? '正在执行' : '执行补帧'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0, padding: '8px 10px', borderRadius: 10, background: '#141022', border: '1px solid #261c40' }}>
      <div style={{ color: '#71658f', fontSize: 10, marginBottom: 3 }}>{label}</div>
      <div style={{ color: '#ddd5f5', fontSize: 12, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  )
}
