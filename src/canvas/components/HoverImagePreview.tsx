import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'

interface HoverImagePreviewEntry {
  url: string
  name?: string
  rect: DOMRect
  kind?: 'image' | 'video'
}

interface Props {
  entry: HoverImagePreviewEntry | null
}

function previewSrc(url: string, kind: 'image' | 'video') {
  if (kind !== 'video') return url
  return url.includes('#') ? url : `${url}#t=0.001`
}

export function HoverImagePreview({ entry }: Props) {
  if (!entry) return null

  const kind = entry.kind === 'video' ? 'video' : 'image'
  const mediaStyle: CSSProperties = {
    width: 200,
    maxWidth: 'min(200px, 40vw)',
    maxHeight: 'min(200px, 40vh)',
    objectFit: 'contain',
    display: 'block',
    borderRadius: 5,
    background: '#120f1d',
  }

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: entry.rect.left + entry.rect.width / 2,
        top: entry.rect.top - 10,
        transform: 'translate(-50%, -100%)',
        zIndex: 99998,
        pointerEvents: 'none',
        background: '#0d0b18',
        border: '1px solid #312550',
        borderRadius: 8,
        padding: 4,
        boxShadow: '0 8px 32px rgba(0,0,0,0.9)',
      }}
    >
      {kind === 'video' ? (
        <video
          src={previewSrc(entry.url, kind)}
          muted
          playsInline
          autoPlay
          loop
          preload="metadata"
          draggable={false}
          style={mediaStyle}
        />
      ) : (
        <img
          src={entry.url}
          draggable={false}
          style={mediaStyle}
        />
      )}
      {entry.name ? (
        <div
          style={{
            fontSize: 10,
            color: '#8a7aaa',
            textAlign: 'center',
            marginTop: 4,
            maxWidth: 200,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.name}
        </div>
      ) : null}
    </div>,
    document.body
  )
}
