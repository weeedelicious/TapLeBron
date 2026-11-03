import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, Eraser, Loader2, X } from 'lucide-react'

export type VideoUiRemovalMethod = 'propainter' | 'diffueraser'

export const VIDEO_UI_REMOVAL_METHODS: Array<{
  id: VideoUiRemovalMethod
  name: string
  model: string
  description: string
  recommended?: boolean
}> = [
  {
    id: 'propainter',
    name: '稳定修复',
    model: 'SAM 2 + ProPainter',
    description: '时间更稳，适合 20 秒视频，补出的细节稍软。',
    recommended: true,
  },
  {
    id: 'diffueraser',
    name: '画质优先',
    model: 'SAM 2 + DiffuEraser',
    description: '补出的角色和背景更完整，但更吃显存，可能轻微闪烁。',
  },
]

interface Props {
  name: string
  durationHintSec?: number
  onCancel: () => void
  onConfirm: (method: VideoUiRemovalMethod) => Promise<void> | void
  /** 先用 SAM 2 标出会被擦掉的区域，返回红色蒙版预览视频和覆盖比例。 */
  onPreview: () => Promise<{ blob: Blob; coverage: number | null }>
}

const cardStyle: CSSProperties = {
  width: 'min(760px, calc(100vw - 40px))',
  borderRadius: 20,
  border: '1px solid #382966',
  background: 'linear-gradient(180deg, #171129, #0f0c18)',
  boxShadow: '0 28px 90px rgba(0,0,0,0.58)',
}

export function VideoUiRemovalModal({ name, durationHintSec, onCancel, onConfirm, onPreview }: Props) {
  const [method, setMethod] = useState<VideoUiRemovalMethod>('propainter')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [coverage, setCoverage] = useState<number | null>(null)
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [previewError, setPreviewError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''
    setPreviewState('loading')
    setPreviewError('')
    setPreviewUrl('')
    onPreview()
      .then((result) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(result.blob)
        setPreviewUrl(objectUrl)
        setCoverage(result.coverage)
        setPreviewState('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setPreviewState('error')
        setPreviewError(err instanceof Error ? err.message : '蒙版预览失败')
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [retry, onPreview])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const confirm = async () => {
    setSubmitting(true)
    setError('')
    try {
      await onConfirm(method)
    } catch (err) {
      setError(err instanceof Error ? err.message : '去除 UI 失败')
      setSubmitting(false)
    }
  }

  const coverageLabel = coverage == null ? '' : ' · 约占 ' + (coverage * 100).toFixed(1) + '%'

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 2147483646, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(0,0,0,0.62)' }}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onCancel() }}
    >
      <section style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '18px 20px', borderBottom: '1px solid #312550' }}>
          <div>
            <strong style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f4f1ff', fontSize: 18 }}>
              <Eraser size={18} />去除 UI
            </strong>
            <div style={{ marginTop: 5, color: '#9488ad', fontSize: 12 }}>
              {name}{durationHintSec ? ' · ' + Math.round(durationHintSec) + ' 秒' : ''}· 红色区域会被擦掉，确认后再开始
            </div>
          </div>
          <button type="button" aria-label="关闭" disabled={submitting} onClick={onCancel} style={{ width: 34, height: 34, border: 0, borderRadius: 9, background: 'transparent', color: '#ddd', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>
        <div style={{ display: 'grid', gap: 12, padding: 18 }}>
          <div style={{ minHeight: 180, borderRadius: 12, overflow: 'hidden', background: '#09070f', border: '1px solid #312550' }}>
            {previewState === 'loading' && (
              <div style={{ display: 'grid', placeItems: 'center', minHeight: 180, color: '#c4b5fd' }}>
                <Loader2 size={18} className="animate-spin" />正在标出会擦掉的区域
              </div>
            )}
            {previewState === 'error' && (
              <div style={{ display: 'grid', placeItems: 'center', minHeight: 180, padding: 16, textAlign: 'center', color: '#ffc9c9' }}>
                <span>{previewError}</span>
                <button type="button" onClick={() => setRetry((value) => value + 1)} style={{ marginTop: 10, height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid #312550', background: 'transparent', color: '#ddd', cursor: 'pointer' }}>重试</button>
              </div>
            )}
            {previewState === 'ready' && previewUrl && (
              <video src={previewUrl} controls autoPlay muted loop playsInline style={{ display: 'block', width: '100%', maxHeight: 320, background: '#000' }} />
            )}
          </div>
          {previewState === 'ready' && (
            <div style={{ color: '#c4b5fd', fontSize: 12 }}>红色区域会被擦掉{coverageLabel}。播放确认名片有没有跟上。</div>
          )}
          {VIDEO_UI_REMOVAL_METHODS.map((item) => {
            const active = method === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setMethod(item.id)}
                style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 10, padding: 14, textAlign: 'left', borderRadius: 12, border: '1px solid ' + (active ? '#8b7cf6' : '#312550'), background: active ? 'rgba(124,92,252,0.18)' : '#141022', color: '#f4f1ff', cursor: 'pointer' }}
              >
                <span>{active ? <Check size={16} /> : null}</span>
                <span>
                  <strong>{item.name}{item.recommended ? ' · 推荐' : ''}</strong>
                  <small style={{ display: 'block', margin: '3px 0', color: '#c4b5fd' }}>{item.model}</small>
                  <span style={{ color: '#9488ad', fontSize: 12 }}>{item.description}</span>
                </span>
              </button>
            )
          })}
        </div>
        {error && <div style={{ margin: '0 18px 12px', padding: '8px 10px', borderRadius: 8, color: '#ffc9c9', background: '#592f2f' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0 18px 18px' }}>
          <button type="button" onClick={onCancel} disabled={submitting} style={{ height: 38, padding: '0 14px', borderRadius: 9, border: '1px solid #312550', background: 'transparent', color: '#ddd', cursor: 'pointer' }}>取消</button>
          <button
            type="button"
            onClick={() => { void confirm() }}
            disabled={submitting || previewState !== 'ready'}
            style={{ height: 38, minWidth: 112, padding: '0 14px', border: 0, borderRadius: 9, background: '#7c5cfc', color: '#fff', cursor: submitting ? 'wait' : 'pointer', opacity: previewState === 'ready' ? 1 : 0.55 }}
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : '开始去除'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}
