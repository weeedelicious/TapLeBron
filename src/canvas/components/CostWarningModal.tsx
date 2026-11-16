import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'

/**
 * 高成本操作的红色警示弹窗（2026-11-16：Seedance 2.5 点 4K 时弹）。
 * 挂到 body 上、整屏遮罩、居中 —— 画布铺满窗口，所以就是画布正中央。
 * Esc / 点遮罩 = 取消，Enter = 确定。
 */
export function CostWarningModal({
  title = '成本警示',
  message,
  confirmLabel = '确定使用',
  cancelLabel = '取消',
  onConfirm,
  onCancel,
}: {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onConfirm() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, onConfirm])

  return createPortal(
    <div
      className="nodrag nowheel"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      style={{ position: 'fixed', inset: 0, zIndex: 130000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'rgba(40,0,0,0.62)', backdropFilter: 'blur(2px)' }}
      onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onCancel() }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        style={{
          width: 'min(440px, calc(100vw - 40px))',
          borderRadius: 18,
          border: '2px solid #ff4d4f',
          background: 'linear-gradient(180deg, #3a0b0e, #1f0507)',
          boxShadow: '0 0 0 6px rgba(255,77,79,0.18), 0 28px 90px rgba(0,0,0,0.6)',
          padding: '26px 24px 20px',
          textAlign: 'center',
          animation: 'cost-warning-pop 160ms ease-out',
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <style>{'@keyframes cost-warning-pop{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}'}</style>
        <div style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ff4d4f', color: '#fff', boxShadow: '0 0 24px rgba(255,77,79,0.65)' }}>
          <AlertTriangle size={30} strokeWidth={2.2} />
        </div>
        <div style={{ color: '#ff7875', fontSize: 20, fontWeight: 800, letterSpacing: 1 }}>{title}</div>
        <div style={{ marginTop: 12, color: '#fff1f0', fontSize: 17, fontWeight: 600, lineHeight: 1.6 }}>{message}</div>
        <div style={{ display: 'flex', gap: 12, marginTop: 22 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ flex: 1, height: 42, borderRadius: 10, border: '1px solid rgba(255,163,158,0.45)', background: 'transparent', color: '#ffccc7', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            style={{ flex: 1, height: 42, borderRadius: 10, border: 'none', background: '#ff4d4f', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', boxShadow: '0 6px 18px rgba(255,77,79,0.45)' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
