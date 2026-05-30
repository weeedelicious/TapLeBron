import { useCallback, useRef, useState, useEffect } from 'react'
import { NodeShell } from './NodeShell'
import { ImagePreview } from '@/components/ImagePreview'
import { useCanvasStore } from '@/store/canvasStore'
import { assetsApi } from '@/lib/api'
import type { CanvasNodeData } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

const TOOLBAR_LEFT = [
  { key: 'panorama', label: '全景',     icon: '⤡', badge: 'NEW' },
  { key: 'multi',    label: '多角度',   icon: '◈' },
  { key: 'light',    label: '打光',     icon: '✦' },
  { key: 'grid9',    label: '九宫格',   icon: '⊞', dropdown: true },
  { key: 'hd',       label: '高清',     icon: '▣', dropdown: true },
  { key: 'split',    label: '宫格切分', icon: '⊟', dropdown: true },
]
const TOOLBAR_RIGHT = [
  { key: 'edit',       icon: '✏', title: '编辑' },
  { key: 'link',       icon: '⬡', title: '引用' },
  { key: 'download',   icon: '↓', title: '下载' },
  { key: 'fullscreen', icon: '⤢', title: '全屏' },
]

const isImage = (url: string) => /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(url)
const isVideo = (url: string) => /\.(mp4|webm|mov)$/i.test(url)

export function UploadNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const nodeRef = useRef<HTMLDivElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [showToolbar, setShowToolbar] = useState(false)

  const urls = data.url ?? []
  const thumbUrls = ((data.params as Record<string, unknown>)?.thumbUrls ?? []) as string[]
  const mainUrl = urls[0] ?? ''
  // Use thumbnail for display (smaller file), fallback to original
  const mainDisplayUrl = thumbUrls[0] ?? mainUrl
  const hasContent = urls.length > 0
  const hasImage = hasContent && isImage(mainUrl)

  // Hide toolbar when clicking outside the node
  useEffect(() => {
    if (!showToolbar) return
    const handler = (e: MouseEvent) => {
      if (!nodeRef.current?.contains(e.target as Node)) {
        setShowToolbar(false)
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [showToolbar])

  // Also hide when node gets deselected
  useEffect(() => {
    if (!selected) setShowToolbar(false)
  }, [selected])

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    const uploaded: string[] = []
    const thumbs: string[] = []
    for (const file of Array.from(files)) {
      try {
        const res = await assetsApi.upload(data.projectUuid, file)
        uploaded.push(res.url)
        thumbs.push(res.thumbUrl ?? res.url)
      } catch (e) { console.error(e) }
    }
    const existingThumbs = ((data.params as Record<string, unknown>)?.thumbUrls ?? []) as string[]
    updateNodeData(id, {
      url: [...urls, ...uploaded],
      params: { ...(data.params as Record<string, unknown>), thumbUrls: [...existingThumbs, ...thumbs] }
    })
  }, [id, data.projectUuid, urls, data.params, updateNodeData])

  const handleDownload = useCallback((url: string) => {
    const a = document.createElement('a')
    a.href = url
    a.download = data.name || url.split('/').pop() || 'file'
    a.click()
  }, [data.name])

  const toolbar = showToolbar && hasImage ? (
    <div
      className="nodrag flex items-center gap-0.5 rounded-full px-2 py-1"
      style={{
        background: '#1a1530', border: '1px solid #312550',
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        whiteSpace: 'nowrap', width: 'fit-content', margin: '0 auto',
      }}
    >
      {TOOLBAR_LEFT.map(tool => (
        <button key={tool.key}
          className="nodrag flex items-center gap-1 px-2 py-1 rounded-full text-xs"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c4b5fd' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,92,252,0.15)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          title={tool.label}
        >
          <span style={{ fontSize: 12 }}>{tool.icon}</span>
          <span>{tool.label}</span>
          {tool.badge && (
            <span style={{ fontSize: 9, background: '#7c5cfc', color: '#fff', borderRadius: 3, padding: '1px 3px', fontWeight: 700 }}>
              {tool.badge}
            </span>
          )}
          {tool.dropdown && <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>}
        </button>
      ))}
      <div style={{ width: 1, height: 18, background: '#312550', margin: '0 4px', flexShrink: 0 }} />
      {TOOLBAR_RIGHT.map(tool => (
        <button key={tool.key}
          className="nodrag flex items-center justify-center rounded-full"
          style={{ width: 28, height: 28, background: 'none', border: 'none', cursor: 'pointer', color: '#8a7aaa', fontSize: 14 }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,92,252,0.15)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          title={tool.title}
          onClick={
            tool.key === 'download' ? () => handleDownload(mainUrl) :
            tool.key === 'fullscreen' ? () => setPreviewUrl(mainUrl) :
            undefined
          }
        >{tool.icon}</button>
      ))}
    </div>
  ) : undefined

  return (
    <div ref={nodeRef} style={{ display: 'contents' }}>
      <NodeShell nodeKey={id} data={data} selected={selected} toolbar={toolbar} minWidth={240} minHeight={160}>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />

        {hasContent ? (
          <div style={{ background: '#0d0b18' }}>
            <div className="relative group">
              {isImage(mainUrl) && (
                <img
                  src={mainDisplayUrl} alt=""
                  className="w-full block"
                  draggable={false}
                  style={{ objectFit: 'contain', maxHeight: 280, display: 'block', cursor: 'pointer' }}
                  onLoad={e => {
                    const img = e.currentTarget
                    setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
                  }}
                  onClick={() => setShowToolbar(v => !v)}
                  onDoubleClick={() => setPreviewUrl(mainUrl)}
                />
              )}
              {isVideo(mainUrl) && (
                <video src={mainUrl} controls className="w-full block nodrag" style={{ maxHeight: 300 }} />
              )}
              {!isImage(mainUrl) && !isVideo(mainUrl) && (
                <div className="flex items-center gap-2 p-3 text-xs" style={{ color: '#8a7aaa' }}>
                  <span style={{ fontSize: 20 }}>📄</span>
                  <span className="truncate">{mainUrl.split('/').pop()}</span>
                </div>
              )}

              {/* Dimensions badge */}
              {imgSize && (
                <div style={{
                  position: 'absolute', top: 8, left: 10, fontSize: 10, color: '#8a7aaa',
                  background: 'rgba(13,11,24,0.75)', borderRadius: 4, padding: '1px 6px',
                  pointerEvents: 'none',
                }}>{imgSize.w} × {imgSize.h}</div>
              )}

              {/* Hover download button */}
              {isImage(mainUrl) && (
                <button
                  className="nodrag opacity-0 group-hover:opacity-100"
                  style={{
                    position: 'absolute', top: 8, right: 8,
                    width: 28, height: 28, borderRadius: '50%',
                    background: 'rgba(13,11,24,0.85)', border: '1px solid #312550',
                    color: '#c4b5fd', fontSize: 14, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'opacity 0.15s',
                  }}
                  onClick={() => handleDownload(mainUrl)}
                  title="下载"
                >↑</button>
              )}
            </div>

            {/* Extra files strip (no add button) */}
            {urls.length > 1 && (
              <div className="flex gap-1 p-2">
                {urls.slice(1).map((url, i) => (
                  isImage(url) ? (
                    <img key={i} src={url} alt=""
                      className="rounded"
                      draggable={false}
                      style={{ width: 48, height: 48, objectFit: 'cover', cursor: 'zoom-in', border: '1px solid #312550' }}
                      onClick={() => setPreviewUrl(url)}
                    />
                  ) : (
                    <div key={i} className="text-xs truncate" style={{ color: '#6a5a8a', maxWidth: 80 }}>
                      {url.split('/').pop()}
                    </div>
                  )
                ))}
              </div>
            )}
          </div>
        ) : (
          /* Empty drop zone */
          <div
            className="flex flex-col items-center justify-center gap-2 cursor-pointer nodrag"
            style={{
              minHeight: 160, background: '#0d0b18',
              border: '2px dashed #2a2040', borderRadius: 8, margin: 8,
              color: '#4a4060', transition: 'border-color 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#312550')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a2040')}
            onClick={() => inputRef.current?.click()}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" opacity={0.4}>
              <path d="M16 22V10M10 16l6-6 6 6" stroke="#c4b5fd" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="4" y="4" width="24" height="24" rx="4" stroke="#c4b5fd" strokeWidth="1.5" />
            </svg>
            <span style={{ fontSize: 11 }}>点击上传图片 / 视频 / 音频</span>
          </div>
        )}

        {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
      </NodeShell>
    </div>
  )
}
