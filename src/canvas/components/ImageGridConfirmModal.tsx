import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Grid3X3, Loader2, X } from 'lucide-react'
import {
  MULTI_CAMERA_GRID_RATIOS,
  MULTI_CAMERA_GRID_RESOLUTIONS,
  normalizeMultiCameraGridRatio,
} from '@/lib/multiCameraGrid'

interface ImageGridConfirmModalProps {
  initialRatio?: string
  busy?: boolean
  onCancel: () => void
  onConfirm: (settings: { ratio: string; resolution: string }) => void
}

export function ImageGridConfirmModal({
  initialRatio,
  busy = false,
  onCancel,
  onConfirm,
}: ImageGridConfirmModalProps) {
  const [ratio, setRatio] = useState(normalizeMultiCameraGridRatio(initialRatio))
  const [resolution, setResolution] = useState('1K')

  return createPortal(
    <div
      className="nodrag"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2400,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0,0,0,0.56)',
        backdropFilter: 'blur(7px)',
        WebkitBackdropFilter: 'blur(7px)',
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div
        className="nodrag"
        style={{
          width: 420,
          maxWidth: 'calc(100vw - 32px)',
          borderRadius: 18,
          border: '1px solid rgba(180,160,255,0.22)',
          background: 'linear-gradient(180deg, #1c1827 0%, #13101d 100%)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.62), 0 0 0 1px rgba(124,92,252,0.08) inset',
          color: '#f4efff',
          overflow: 'hidden',
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '18px 18px 14px',
            borderBottom: '1px solid rgba(124,92,252,0.16)',
          }}
        >
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(124,92,252,0.18)',
              color: '#d8ccff',
            }}
          >
            <Grid3X3 size={18} strokeWidth={2} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.25 }}>生成九宫格</div>
            <div style={{ marginTop: 3, fontSize: 12, color: '#9f94bd' }}>
              使用 GPT image 2.0 参考当前图片生成 3x3 多机位分镜
            </div>
          </div>
          <button
            type="button"
            className="nodrag"
            onClick={onCancel}
            disabled={busy}
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              border: '1px solid rgba(124,92,252,0.18)',
              background: 'rgba(255,255,255,0.04)',
              color: '#b8add8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.5 : 1,
            }}
            aria-label="关闭"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 18 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 800, color: '#cfc5ee' }}>比例</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {MULTI_CAMERA_GRID_RATIOS.map((option) => {
                const active = option === ratio
                return (
                  <button
                    key={option}
                    type="button"
                    className="nodrag"
                    disabled={busy}
                    onClick={() => setRatio(option)}
                    style={{
                      minHeight: 36,
                      borderRadius: 10,
                      border: active ? '1px solid #bca8ff' : '1px solid rgba(124,92,252,0.22)',
                      background: active ? 'rgba(124,92,252,0.24)' : 'rgba(255,255,255,0.035)',
                      color: active ? '#ffffff' : '#a99ec6',
                      fontSize: 13,
                      fontWeight: active ? 800 : 600,
                      cursor: busy ? 'default' : 'pointer',
                    }}
                  >
                    {option === 'auto' ? '自适应' : option}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 800, color: '#cfc5ee' }}>分辨率</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {MULTI_CAMERA_GRID_RESOLUTIONS.map((option) => {
                const active = option === resolution
                return (
                  <button
                    key={option}
                    type="button"
                    className="nodrag"
                    disabled={busy}
                    onClick={() => setResolution(option)}
                    style={{
                      minHeight: 38,
                      borderRadius: 10,
                      border: active ? '1px solid #bca8ff' : '1px solid rgba(124,92,252,0.22)',
                      background: active ? 'rgba(124,92,252,0.24)' : 'rgba(255,255,255,0.035)',
                      color: active ? '#ffffff' : '#a99ec6',
                      fontSize: 13,
                      fontWeight: active ? 800 : 600,
                      cursor: busy ? 'default' : 'pointer',
                    }}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '0 18px 18px',
          }}
        >
          <button
            type="button"
            className="nodrag"
            onClick={onCancel}
            disabled={busy}
            style={{
              minWidth: 78,
              height: 38,
              borderRadius: 10,
              border: '1px solid rgba(124,92,252,0.22)',
              background: 'rgba(255,255,255,0.035)',
              color: '#b8add8',
              fontSize: 13,
              fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.5 : 1,
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="nodrag"
            onClick={() => onConfirm({ ratio, resolution })}
            disabled={busy}
            style={{
              minWidth: 118,
              height: 38,
              borderRadius: 10,
              border: 'none',
              background: busy ? '#3b3159' : '#ffffff',
              color: busy ? '#9f94bd' : '#111019',
              fontSize: 13,
              fontWeight: 900,
              cursor: busy ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              boxShadow: busy ? 'none' : '0 10px 24px rgba(0,0,0,0.28)',
            }}
          >
            {busy && <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />}
            确认生成
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
