import { useRef, useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  url: string
  onClose: () => void
}

export function ImagePreview({ url, onClose }: Props) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const backdropRef = useRef<HTMLDivElement>(null)

  const reset = useCallback(() => { setScale(1); setOffset({ x: 0, y: 0 }) }, [])

  // ─── Middle-mouse drag via React synthetic event + window-level tracking ───
  // Using React's onMouseDown which fires in React's synthetic event system
  // BEFORE Chrome's native auto-scroll behavior kicks in
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    lastPos.current = { x: e.clientX, y: e.clientY }
    setIsDragging(true)
  }, [])

  // Track movement + release at window level so drag works anywhere on screen
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      e.preventDefault()
      setOffset(o => ({
        x: o.x + e.clientX - lastPos.current.x,
        y: o.y + e.clientY - lastPos.current.y,
      }))
      lastPos.current = { x: e.clientX, y: e.clientY }
    }

    const onUp = (e: MouseEvent) => {
      if (e.button === 1) {
        dragging.current = false
        setIsDragging(false)
      }
    }

    // Prevent Chrome's auto-scroll popup when middle-clicking
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // Block at capture phase so it fires before browser default
    window.addEventListener('mousedown', onMouseDown, { capture: true })

    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('mousedown', onMouseDown, { capture: true } as EventListenerOptions)
    }
  }, [])

  // ─── Wheel to zoom ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = backdropRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale(s => Math.min(10, Math.max(0.2, s - e.deltaY * 0.001 * s)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ─── ESC to close ────────────────────────────────────────────────────────
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  return createPortal(
    <div
      ref={backdropRef}
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: 'rgba(0,0,0,0.92)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: isDragging ? 'grabbing' : 'default',
        userSelect: 'none',
      }}
      onMouseDown={handleMouseDown}
      onClick={e => {
        if (e.target === e.currentTarget && scale === 1 && !isDragging) onClose()
      }}
    >
      <img
        src={url}
        draggable={false}
        style={{
          maxWidth: '90vw', maxHeight: '90vh',
          objectFit: 'contain', borderRadius: 6,
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: 'center',
          transition: isDragging ? 'none' : 'transform 0.05s',
          boxShadow: '0 20px 60px rgba(0,0,0,0.8)',
          pointerEvents: 'none',
        }}
      />

      {/* Controls */}
      <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', background: 'rgba(0,0,0,0.4)', borderRadius: 4, padding: '2px 8px' }}>
          {Math.round(scale * 100)}%
        </span>
        <button style={btnStyle} onClick={reset} title="重置 (1:1)">⊡</button>
        <button style={btnStyle} onClick={onClose} title="关闭 (Esc)">×</button>
      </div>

      <div style={{ position: 'absolute', bottom: 20, fontSize: 11, color: 'rgba(255,255,255,0.25)', pointerEvents: 'none' }}>
        滚轮缩放 · 中键拖动 · ESC 关闭
      </div>
    </div>,
    document.body
  )
}

const btnStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: '50%',
  background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)',
  color: '#fff', fontSize: 18, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
