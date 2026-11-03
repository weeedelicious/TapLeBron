import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Loader2, X } from 'lucide-react'

export type VideoUiRemovalMethod = 'propainter' | 'diffueraser'

const METHODS: Array<{
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

interface VideoUiRemovalModalProps {
  name: string
  durationHintSec?: number
  onCancel: () => void
  onConfirm: (method: VideoUiRemovalMethod) => Promise<void> | void
  onPreview: () => Promise<{ blob: Blob; coverage: number | null }>
}

export function VideoUiRemovalModal({ name, durationHintSec, onCancel, onConfirm, onPreview }: VideoUiRemovalModalProps) {
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
  const durationLabel = durationHintSec ? ' · ' + durationHintSec.toFixed(1) + ' 秒' : ''

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 2147483646, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.62)' }}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onCancel() }}
    >
      <div style={{ width: 'min(760px, calc(100vw - 40px))', borderRadius: 20, border: '1px solid #382966', background: 'linear-gradient(180deg, #171129, #0f0c18)', boxShadow: '0 28px 90px rgba(0,0,0,0.58)', color: '#f6f1ff', padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 650 }}>去除 UI</div>
            <div style={{ marginTop: 4, color: '#b7adc9', fontSize: 13 }}>{name}{durationLabel}{coverageLabel}</div>
          </div>
          <button type="button" onClick={onCancel} disabled={submitting} style={{ border: 0, background: 'transparent', color: '#f6f1ff', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(220px, 0.8fr)', gap: 16 }}>
          <div style={{ minHeight: 220, borderRadius: 14, overflow: 'hidden', background: '#09070f', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {previewState === 'loading' && <span style={{ color: '#b7adc9' }}><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> 正在生成蒙版预览</span>}
            {previewState === 'error' && (
              <button type="button" onClick={() => setRetry((value) => value + 1)} style={{ color: '#f6f1ff', background: 'transparent', border: 0, cursor: 'pointer' }}>{previewError}，点击重试</button>
            )}
            {previewState === 'ready' && previewUrl && <img src={previewUrl} alt="蒙版预览" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {METHODS.map((item) => (
              <button key={item.id} type="button" onClick={() => setMethod(item.id)} style={{ textAlign: 'left', borderRadius: 12, border: method === item.id ? '1px solid rgba(167,139,250,0.7)' : '1px solid #382b5d', background: method === item.id ? 'rgba(124,92,252,0.22)' : '#1b1530', color: '#f6f1ff', padding: '8px 12px', cursor: 'pointer' }}>
                <strong>{item.name}{item.recommended ? ' · 推荐' : ''}</strong>
                <div style={{ marginTop: 2, fontSize: 12, color: '#c8bddb' }}>{item.model}</div>
                <div style={{ marginTop: 4, fontSize: 12, color: '#b7adc9' }}>{item.description}</div>
              </button>
            ))}
          </div>
        </div>
        {error && <div style={{ marginTop: 12, color: '#ffb4b4', fontSize: 13 }}>{error}</div>}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onCancel} disabled={submitting} style={{ borderRadius: 12, border: '1px solid #382b5d', background: 'transparent', color: '#f6f1ff', padding: '8px 14px', cursor: 'pointer' }}>取消</button>
          <button type="button" onClick={confirm} disabled={submitting} style={{ borderRadius: 12, border: 0, background: '#7c5cfc', color: '#fff', padding: '8px 14px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {submitting ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Eye size={14} />}
            {submitting ? '正在创建' : '开始去除'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
