import { useCallback, type Dispatch, type PointerEvent, type RefObject, type SetStateAction } from 'react'

export type PanelSize = {
  width: number
  height: number
}

type ResizeOptions = {
  minWidth: number
  minHeight: number
  maxWidth?: number
  maxHeight?: number
  onResizeEnd?: (size: PanelSize) => void
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function readPanelSize(value: unknown): PanelSize | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { width?: unknown; height?: unknown }
  const width = Number(raw.width)
  const height = Number(raw.height)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0) return null
  return { width: Math.round(width), height: Math.round(height) }
}

export function useResizablePanel(
  panelRef: RefObject<HTMLElement | null>,
  setPanelSize: Dispatch<SetStateAction<PanelSize | null>>,
  options: ResizeOptions
) {
  return useCallback((event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()

    const panel = panelRef.current
    const rect = panel?.getBoundingClientRect()
    if (!rect) return

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is best-effort; window listeners below still keep resizing responsive.
    }

    const session = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      maxWidth: Math.max(options.minWidth, Math.min(options.maxWidth ?? Infinity, window.innerWidth - rect.left - 12)),
      maxHeight: Math.max(options.minHeight, Math.min(options.maxHeight ?? Infinity, window.innerHeight - rect.top - 12)),
    }
    let latestSize: PanelSize = {
      width: Math.round(session.startWidth),
      height: Math.round(session.startHeight),
    }

    setPanelSize(latestSize)

    function cleanup() {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('blur', finish)
    }

    function resizeFromPointer(pointerEvent: globalThis.PointerEvent | PointerEvent<HTMLButtonElement>) {
      const nextWidth = clamp(
        Math.round(session.startWidth + pointerEvent.clientX - session.startX),
        options.minWidth,
        session.maxWidth
      )
      const nextHeight = clamp(
        Math.round(session.startHeight + pointerEvent.clientY - session.startY),
        options.minHeight,
        session.maxHeight
      )
      latestSize = { width: nextWidth, height: nextHeight }
      setPanelSize(latestSize)
    }

    function move(moveEvent: globalThis.PointerEvent) {
      if (moveEvent.pointerId !== session.pointerId) return
      moveEvent.preventDefault()
      resizeFromPointer(moveEvent)
    }

    function finish(finishEvent?: globalThis.PointerEvent | Event) {
      if ('pointerId' in (finishEvent ?? {}) && (finishEvent as globalThis.PointerEvent).pointerId !== session.pointerId) return
      if (finishEvent && 'clientX' in finishEvent) resizeFromPointer(finishEvent as globalThis.PointerEvent)
      cleanup()
      options.onResizeEnd?.(latestSize)
    }

    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
    window.addEventListener('blur', finish)
  }, [options.maxHeight, options.maxWidth, options.minHeight, options.minWidth, options.onResizeEnd, panelRef, setPanelSize])
}

export function ResizablePanelHandle({ onPointerDown }: { onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      type="button"
      className="resizable-panel-corner nodrag nopan"
      title="拖动调整弹窗大小"
      aria-label="拖动调整弹窗大小"
      onPointerDown={onPointerDown}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <span />
    </button>
  )
}
