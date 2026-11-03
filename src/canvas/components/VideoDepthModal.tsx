import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, Loader2, ScanLine, X } from 'lucide-react'
import {
  VIDEO_DEPTH_ENCODERS,
  VIDEO_DEPTH_PRESETS,
  videoDepthMaxDurationSec,
  videoDepthModelLabel,
  type VideoDepthEncoder,
  type VideoDepthNear,
  type VideoDepthPreset,
  type VideoDepthProvider,
  type VideoDepthRequest,
} from '@/lib/videoDepth'

interface VideoDepthModalProps {
  provider: VideoDepthProvider
  name: string
  durationHintSec?: number
  onCancel: () => void
  onConfirm: (request: VideoDepthRequest) => Promise<void> | void
}

const cardStyle: CSSProperties = {
  width: 'min(640px, calc(100vw - 40px))',
  maxHeight: 'calc(100vh - 40px)',
  overflowY: 'auto',
  borderRadius: 20,
  border: '1px solid #382966',
  background: 'linear-gradient(180deg, #171129, #0f0c18)',
  boxShadow: '0 28px 90px rgba(0,0,0,0.58), inset 0 1px 0 rgba(255,255,255,0.06)',
}

function formatDuration(value: number) {
  if (!value) return '—'
  const totalSeconds = Math.max(0, Math.round(value))
  return Math.floor(totalSeconds / 60) + ':' + String(totalSeconds % 60).padStart(2, '0')
}

export function VideoDepthModal({ provider, name, durationHintSec, onCancel, onConfirm }: VideoDepthModalProps) {
  const isDepthCrafter = provider === 'depthcrafter'
  const [encoder, setEncoder] = useState<Exclude<VideoDepthEncoder, 'svd'>>('vitl')
  const [preset, setPreset] = useState<VideoDepthPreset>(480)
  const [near, setNear] = useState<VideoDepthNear>('bright')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const limit = videoDepthMaxDurationSec(provider)
  const duration = Number(durationHintSec) > 0 ? Number(durationHintSec) : 0
  const tooLong = duration > limit + 0.05

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSubmitting, onCancel])

  const handleConfirm = useCallback(async () => {
    if (isSubmitting) return
    if (tooLong) {
      setError((isDepthCrafter ? 'DepthCrafter' : 'Video Depth Anything') + ' 目前最长 ' + limit + ' 秒，请先剪短视频')
      return
    }
    setError(null)
    setIsSubmitting(true)
    try {
      await onConfirm({
        provider,
        encoder: isDepthCrafter ? 'svd' : encoder,
        maxRes: preset,
        near,
      })
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '视频转深度失败')
      setIsSubmitting(false)
    }
  }, [encoder, isDepthCrafter, isSubmitting, limit, near, onConfirm, preset, provider, tooLong])

  const title = isDepthCrafter ? 'DepthCrafter 深度' : 'Video Depth Anything'
  const summary = isDepthCrafter
    ? '用腾讯 DepthCrafter 把整段视频做成时间上更稳的灰度深度。适合 30 秒以内、需要保住动作和前后景的参考片。'
    : '用字节 Video Depth Anything 直接估计整段视频的深度。适合更长的片子，Large 细节最好。'

  return createPortal(
    <div
      className="nodrag"
      style={{ position: 'fixed', inset: 0, zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'rgba(2,1,7,0.82)' }}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !isSubmitting) onCancel() }}
    >
      <div className="nodrag" style={cardStyle} onMouseDown={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 18px 14px', borderBottom: '1px solid #2b2048' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            <div style={{ width: 36, height: 36, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d9ceff', background: 'rgba(124,92,252,0.16)', border: '1px solid rgba(167,139,250,0.28)' }}>
              <ScanLine size={18} strokeWidth={1.9} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#f6f1ff', fontSize: 16, fontWeight: 700 }}>{title}</div>
              <div title={name} style={{ marginTop: 3, color: '#9185b4', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>{name || '视频'}</div>
            </div>
          </div>
          <button type="button" aria-label="关闭" disabled={isSubmitting} onClick={onCancel} style={{ width: 32, height: 32, borderRadius: 10, border: '1px solid #382b5d', background: '#1b1530', color: '#b9addb', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: isSubmitting ? 'default' : 'pointer' }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: 18, display: 'grid', gap: 16 }}>
          <p style={{ margin: 0, color: '#c9bddf', fontSize: 13, lineHeight: 1.6 }}>{summary}</p>
          <div style={{ color: '#9185b4', fontSize: 12 }}>源视频时长 {formatDuration(duration)}，本方案最长 {limit} 秒。输出是近处{near === 'bright' ? '偏亮' : '偏暗'}的灰度 MP4，会新建到右侧视频节点。</div>
          <div>
            <div style={{ color: '#f6f1ff', fontSize: 13, fontWeight: 650, marginBottom: 8 }}>清晰度</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {VIDEO_DEPTH_PRESETS.map((item) => (
                <button key={item.id} type="button" disabled={isSubmitting} onClick={() => setPreset(item.id)} style={choiceStyle(preset === item.id)}>{item.label}</button>
              ))}
            </div>
          </div>
          {!isDepthCrafter && (
            <div>
              <div style={{ color: '#f6f1ff', fontSize: 13, fontWeight: 650, marginBottom: 8 }}>模型规模</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {VIDEO_DEPTH_ENCODERS.map((item) => (
                  <button key={item.id} type="button" disabled={isSubmitting} onClick={() => setEncoder(item.id)} style={{ ...choiceStyle(encoder === item.id), textAlign: 'left' }}>
                    <strong>{item.label}</strong>
                    <span style={{ display: 'block', marginTop: 4, color: '#9185b4', fontWeight: 400 }}>{item.detail}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <div style={{ color: '#f6f1ff', fontSize: 13, fontWeight: 650, marginBottom: 8 }}>灰度方向</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" disabled={isSubmitting} onClick={() => setNear('bright')} style={choiceStyle(near === 'bright')}>近处偏亮</button>
              <button type="button" disabled={isSubmitting} onClick={() => setNear('dark')} style={choiceStyle(near === 'dark')}>近处偏暗</button>
            </div>
          </div>
          <div style={{ color: '#9185b4', fontSize: 12 }}>将使用 {videoDepthModelLabel(provider, isDepthCrafter ? 'svd' : encoder)}。原片的脸、衣服和颜色不会留在深度视频里。</div>
          {error && <div style={{ color: '#ffb4c4', fontSize: 13 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" disabled={isSubmitting} onClick={onCancel} style={choiceStyle(false)}>取消</button>
            <button type="button" disabled={isSubmitting || tooLong} onClick={handleConfirm} style={{ ...choiceStyle(true), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {isSubmitting ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={14} />}
              {isSubmitting ? '正在创建' : '生成深度视频'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function choiceStyle(active: boolean): CSSProperties {
  return {
    borderRadius: 12,
    border: active ? '1px solid rgba(167,139,250,0.7)' : '1px solid #382b5d',
    background: active ? 'rgba(124,92,252,0.22)' : '#1b1530',
    color: '#f6f1ff',
    padding: '8px 12px',
    cursor: 'pointer',
  }
}
