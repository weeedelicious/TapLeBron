import { useCallback, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useUpdateNodeInternals, useViewport, useStore } from '@xyflow/react'
import { NodeShell } from './NodeShell'
import { ImagePreview } from '@/components/ImagePreview'
import { PromptEditor } from '@/components/PromptEditor'
import type { ChipRef } from '@/components/PromptEditor'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { generateApi } from '@/lib/api'
import { IMAGE_MODELS, defaultImageParams } from '@/lib/nodeData'
import type { CanvasNodeData, ImageParams, NodeRef } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

function getParams(data: CanvasNodeData): ImageParams {
  if (data.params) return data.params as unknown as ImageParams
  return defaultImageParams()
}

const RATIOS = [
  { value: 'auto', label: '自适应', w: 4, h: 3 },
  { value: '1:1',  label: '1:1',   w: 1, h: 1 },
  { value: '9:16', label: '9:16',  w: 9, h: 16 },
  { value: '16:9', label: '16:9',  w: 16, h: 9 },
  { value: '3:4',  label: '3:4',   w: 3, h: 4 },
  { value: '4:3',  label: '4:3',   w: 4, h: 3 },
  { value: '3:2',  label: '3:2',   w: 3, h: 2 },
  { value: '2:3',  label: '2:3',   w: 2, h: 3 },
  { value: '4:5',  label: '4:5',   w: 4, h: 5 },
  { value: '5:4',  label: '5:4',   w: 5, h: 4 },
  { value: '21:9', label: '21:9',  w: 21, h: 9 },
]
const RESOLUTIONS = ['1K', '2K', '4K']

const TOOLBAR_LEFT = [
  { key: 'panorama', label: '全景',   icon: '⤡', badge: 'NEW' },
  { key: 'multi',    label: '多角度', icon: '◈' },
  { key: 'light',    label: '打光',   icon: '✦' },
  { key: 'grid9',    label: '九宫格', icon: '⊞', dropdown: true },
  { key: 'hd',       label: '高清',   icon: '▣', dropdown: true },
  { key: 'split',    label: '宫格切分', icon: '⊟', dropdown: true },
]
const TOOLBAR_RIGHT = [
  { key: 'edit',       icon: '✏', title: '编辑' },
  { key: 'link',       icon: '⬡', title: '引用' },
  { key: 'download',   icon: '↓', title: '下载' },
  { key: 'fullscreen', icon: '⤢', title: '全屏' },
]

const SUB_TOOLS = [
  { key: 'style',  icon: '⊡', label: '风格' },
  { key: 'mark',   icon: '⚑', label: '标记' },
  { key: 'focus',  icon: '⊙', label: '聚焦' },
]

const imgActionBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 3,
  background: 'rgba(13,11,24,0.88)', border: '1px solid #312550',
  borderRadius: 5, color: '#c4b5fd', fontSize: 11,
  cursor: 'pointer', padding: '3px 7px', fontWeight: 500, whiteSpace: 'nowrap',
}

function RatioIcon({ w, h, active }: { w: number; h: number; active: boolean }) {
  const MAX = 20
  const scale = MAX / Math.max(w, h)
  const rw = Math.max(3, Math.round(w * scale))
  const rh = Math.max(3, Math.round(h * scale))
  return (
    <svg width={rw} height={rh} viewBox={`0 0 ${rw} ${rh}`} fill="none" style={{ display: 'block' }}>
      <rect x="0.75" y="0.75" width={rw - 1.5} height={rh - 1.5} rx="1.5"
        stroke={active ? '#a78bfa' : '#5a5070'} strokeWidth="1.5"
        fill={active ? 'rgba(124,92,252,0.15)' : 'none'} />
    </svg>
  )
}

// ── @ Mention dropdown ────────────────────────────────────────────────────────
function AtMentionDropdown({ pos, connectedNodeIds, onSelect, onClose }: {
  pos: { x: number; y: number }
  connectedNodeIds: Set<string>
  onSelect: (chip: ChipRef) => void
  onClose: () => void
}) {
  const { nodes } = useCanvasStore()
  const ref = useRef<HTMLDivElement>(null)

  // Only show nodes that are edge-connected into this node (imageList refs)
  const candidates = nodes.filter(n =>
    connectedNodeIds.has(n.id) &&
    Array.isArray(n.data.url) && (n.data.url as string[]).length > 0
  )

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [onClose])

  if (candidates.length === 0) return null

  return createPortal(
    <div ref={ref} className="nodrag" style={{
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 99999,
      background: '#16121f', border: '1px solid #2d2248', borderRadius: 10,
      boxShadow: '0 8px 32px rgba(0,0,0,0.7)', padding: '6px 0',
      minWidth: 220, maxHeight: 300, overflowY: 'auto',
    }}>
      <div style={{ padding: '4px 12px 6px', fontSize: 11, color: '#5a5070' }}>@引用图片节点</div>
      {candidates.map(n => {
        const url = (n.data.url as string[])[0]
        return (
          <button key={n.id} className="nodrag" onClick={() => onSelect({ nodeId: n.id, url, name: n.data.name as string })}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 12px', background: 'none', border: 'none',
              cursor: 'pointer', textAlign: 'left', color: '#d0c8f0',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,92,252,0.12)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <img src={url} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
            <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.data.name as string}</span>
          </button>
        )
      })}
    </div>,
    document.body
  )
}

export function ImageNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const [genError, setGenError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState(true)
  const [showAtMenu, setShowAtMenu] = useState(false)
  const [atMenuPos, setAtMenuPos] = useState({ x: 0, y: 0 })
  const imgRef = useRef<HTMLImageElement>(null)
  const promptEditorRef = useRef<{ insertChip: (ref: ChipRef) => void }>(null)
  const promptWrapRef = useRef<HTMLDivElement>(null)
  const nodeContainerRef = useRef<HTMLDivElement>(null)
  const dividerRef = useRef<HTMLDivElement>(null)      // bottom edge of image area
  const controlsPortalRef = useRef<HTMLDivElement>(null)
  const updateNodeInternals = useUpdateNodeInternals()

  // viewport + node absolute position — drive portal re-positioning
  const { zoom, x: vpX, y: vpY } = useViewport()
  const nodeAbsPos = useStore(s => (s.nodeLookup as Map<string, { internals?: { positionAbsolute?: { x: number; y: number } } }>)?.get(id)?.internals?.positionAbsolute)
  const [portalRect, setPortalRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    setPortalRect(dividerRef.current?.getBoundingClientRect() ?? null)
  }, [collapsed, zoom, vpX, vpY, nodeAbsPos?.x, nodeAbsPos?.y])

  // Force React Flow to re-measure handles after collapse/expand
  useEffect(() => { updateNodeInternals(id) }, [collapsed, id, updateNodeInternals])

  // Auto-collapse on outside click (checks both node and portal)
  useEffect(() => {
    if (collapsed) return
    const handler = (e: MouseEvent) => {
      if (
        !nodeContainerRef.current?.contains(e.target as Node) &&
        !controlsPortalRef.current?.contains(e.target as Node)
      ) {
        setCollapsed(true)
        setShowAtMenu(false)
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [collapsed])

  const setMainImage = useCallback((index: number) => {
    if (index === 0) { setExpanded(false); return }
    const newUrls = [...(data.url ?? [])]
    const [picked] = newUrls.splice(index, 1)
    newUrls.unshift(picked)
    updateNodeData(id, { url: newUrls })
    setExpanded(false)
  }, [data.url, id, updateNodeData])

  const params = getParams(data)
  const urls = data.url ?? []
  const hasImage = urls.length > 0
  const ratio = params.settings.ratio ?? '16:9'
  const resolution = params.settings.resolution ?? '1K'
  const connectedImages = (params.imageList as NodeRef[] | undefined)?.filter(r => r.url) ?? []
  const chips = (params.promptChips ?? []) as ChipRef[]

  const setParam = useCallback(<K extends keyof ImageParams>(key: K, val: ImageParams[K]) => {
    updateNodeData(id, { params: { ...params, [key]: val } as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  const handleChipsChange = useCallback((newChips: ChipRef[]) => {
    setParam('promptChips', newChips as never)
  }, [setParam])

  const handleAtKey = useCallback(() => {
    if (promptWrapRef.current) {
      const rect = promptWrapRef.current.getBoundingClientRect()
      setAtMenuPos({ x: rect.left, y: rect.bottom + 4 })
    }
    setShowAtMenu(true)
  }, [])

  const handleSelectMention = useCallback((chip: ChipRef) => {
    promptEditorRef.current?.insertChip(chip)
    setShowAtMenu(false)
  }, [])

  const setSettings = useCallback((key: string, val: string) => {
    setParam('settings', { ...params.settings, [key]: val })
  }, [params, setParam])

  const handleGenerate = useCallback(async () => {
    if (!params.prompt.trim()) return
    setGenError(null)
    try {
      const res = await generateApi.image(data.projectUuid, id, params as unknown as Record<string, unknown>)
      addTask(res.jobId, id)
      startPolling(res.jobId, data.projectUuid)
    } catch (e: unknown) {
      const axErr = e as { response?: { data?: { error?: string } }; message?: string }
      setGenError(axErr.response?.data?.error ?? axErr.message ?? '请求失败')
    }
  }, [data.projectUuid, id, params, addTask, startPolling])

  const handleTranslate = useCallback(async () => {
    if (!params.prompt) return
    try {
      const res = await generateApi.translate(params.prompt)
      setParam('prompt', res.translated)
    } catch (e) { console.error(e) }
  }, [params.prompt, setParam])

  const handleDownload = useCallback((url: string) => {
    const a = document.createElement('a')
    a.href = url
    a.download = data.name || 'image'
    a.click()
  }, [data.name])

  const isLoading = !!data.taskInfo?.loading

  // Toolbar shown above node when image is selected
  const toolbar = selected && hasImage ? (
    <div className="nodrag flex items-center gap-0.5 rounded-full px-2 py-1"
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
            <span style={{ fontSize: 9, background: '#7c5cfc', color: '#fff', borderRadius: 3, padding: '1px 3px', fontWeight: 700 }}>{tool.badge}</span>
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
          onClick={tool.key === 'download' ? () => handleDownload(urls[0]) : tool.key === 'fullscreen' ? () => setPreviewUrl(urls[0]) : undefined}
        >{tool.icon}</button>
      ))}
    </div>
  ) : undefined

  return (
    <>
    <div ref={nodeContainerRef} style={{ display: 'contents' }}>
    <NodeShell nodeKey={id} data={data} selected={selected} toolbar={toolbar}
      minWidth={collapsed ? 220 : 360} maxWidth={520} minHeight={collapsed ? 140 : 200}>

      {/* ── Image preview ── */}
      {hasImage ? (
        !expanded ? (
          /* ── Collapsed: single main image ── */
          <div className="relative group"
            style={{ background: '#0d0b18', cursor: collapsed ? 'pointer' : 'default' }}
            onClick={collapsed ? () => setCollapsed(false) : undefined}
          >
            {/* Collapsed overlay: "点击展开" */}
            {collapsed && !isLoading && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 8,
                display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
                padding: 8, pointerEvents: 'none',
              }}>
                <span style={{
                  fontSize: 11, color: '#c4b5fd', background: 'rgba(13,10,26,0.75)',
                  borderRadius: 4, padding: '2px 7px',
                }}>点击展开</span>
              </div>
            )}
            {/* Loading overlay — only covers the image area */}
            {isLoading && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 10,
                backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                background: 'rgba(13,10,26,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div className="nodrag flex items-center gap-2 px-4 py-2 rounded-full"
                  style={{ background: 'rgba(20,15,40,0.92)', border: '1px solid #312550' }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: 'spin 1s linear infinite' }}>
                    <circle cx="7" cy="7" r="5.5" stroke="#312550" strokeWidth="2" fill="none" />
                    <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" stroke="#7c5cfc" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </svg>
                  <span style={{ fontSize: 12, color: '#c4b5fd', whiteSpace: 'nowrap' }}>
                    生成中 {data.taskInfo?.progressPercent ?? 0}%
                  </span>
                  <button className="nodrag" onClick={() => {}} style={{
                    fontSize: 11, color: '#8a7aaa', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  }}>取消</button>
                </div>
              </div>
            )}
            <img
              ref={imgRef}
              src={urls[0]} alt=""
              className="w-full block"
              draggable={false}
              style={{ objectFit: 'contain', maxHeight: 400, cursor: 'zoom-in' }}
              onLoad={e => {
                const img = e.currentTarget
                setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
              }}
              onDoubleClick={() => setPreviewUrl(urls[0])}
            />
            {imgSize && (
              <div style={{
                position: 'absolute', top: 8, left: 10, fontSize: 10, color: '#8a7aaa',
                background: 'rgba(13,11,24,0.75)', borderRadius: 4, padding: '1px 6px',
                pointerEvents: 'none',
              }}>{imgSize.w} × {imgSize.h}</div>
            )}
            {/* Multi-image badge */}
            {urls.length > 1 && (
              <button
                className="nodrag"
                style={{
                  position: 'absolute', top: 8, right: 8,
                  display: 'flex', alignItems: 'center', gap: 4,
                  background: 'rgba(13,11,24,0.88)', border: '1px solid #312550',
                  borderRadius: 6, color: '#c4b5fd', fontSize: 11,
                  cursor: 'pointer', padding: '3px 8px', fontWeight: 500,
                }}
                onClick={() => setExpanded(true)}
              >
                <span style={{ fontSize: 12 }}>⤢</span>
                {urls.length}张
              </button>
            )}
            {/* Download (single image, no badge) */}
            {urls.length === 1 && (
              <button
                className="nodrag opacity-0 group-hover:opacity-100"
                style={{
                  position: 'absolute', top: 8, right: 8, width: 28, height: 28,
                  borderRadius: '50%', background: 'rgba(13,11,24,0.85)',
                  border: '1px solid #312550', color: '#c4b5fd', fontSize: 14,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'opacity 0.15s',
                }}
                onClick={() => handleDownload(urls[0])}
              >↑</button>
            )}
          </div>
        ) : (
          /* ── Expanded: 2×2 grid (max 4) ── */
          <div style={{
            background: '#0d0b18',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 2,
          }}>
            {urls.slice(0, 4).map((url, i) => (
              <div key={i} className="relative group"
                style={{ position: 'relative', overflow: 'hidden' }}>
                <img
                  src={url} alt=""
                  className="w-full block"
                  draggable={false}
                  style={{ objectFit: 'cover', height: 180, cursor: 'zoom-in', width: '100%' }}
                  onDoubleClick={() => setPreviewUrl(url)}
                />
                <div className="nodrag" style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
                  <button style={imgActionBtn} onClick={() => handleDownload(url)}>↓ 下载</button>
                  {i === 0 ? (
                    <button style={imgActionBtn} onClick={() => setExpanded(false)}>⤡ 收起</button>
                  ) : (
                    <button
                      style={{ ...imgActionBtn, background: 'rgba(124,92,252,0.85)', borderColor: '#7c5cfc', color: '#fff' }}
                      onClick={() => setMainImage(i)}
                    >设为主图</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="relative flex items-center justify-center" style={{ minHeight: 180, background: '#0d0b18' }}>
          {isLoading ? (
            <div className="nodrag flex items-center gap-2 px-4 py-2 rounded-full"
              style={{ background: 'rgba(20,15,40,0.92)', border: '1px solid #312550' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: 'spin 1s linear infinite' }}>
                <circle cx="7" cy="7" r="5.5" stroke="#312550" strokeWidth="2" fill="none" />
                <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" stroke="#7c5cfc" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
              <span style={{ fontSize: 12, color: '#c4b5fd', whiteSpace: 'nowrap' }}>
                生成中 {data.taskInfo?.progressPercent ?? 0}%
              </span>
            </div>
          ) : (
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" opacity={0.12}>
              <rect x="3" y="7" width="34" height="26" rx="3" stroke="#c4b5fd" strokeWidth="2" />
              <circle cx="14" cy="18" r="3.5" stroke="#c4b5fd" strokeWidth="2" />
              <path d="M3 28l10-8 8 8 6-5 10 9" stroke="#c4b5fd" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}

      {/* Divider ref — marks the bottom edge of the image area for portal positioning */}
      <div ref={dividerRef} style={{ height: 0 }} />
    </NodeShell>
    </div>

      {/* ── Controls card — rendered as a portal so it stays fixed-size at any canvas zoom ── */}
      {!collapsed && portalRect && createPortal(
        <div ref={controlsPortalRef} className="nodrag" style={{
          position: 'fixed',
          top: portalRect.bottom,
          left: portalRect.left,
          width: portalRect.width / zoom,  // always fixed at natural node width, never scales with canvas zoom
          zIndex: 1000,
          background: '#1a1625',
          borderRadius: '0 0 10px 10px',
          border: '1px solid #2d2040',
          borderTop: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}>
        <div style={{ padding: '0 10px 10px' }}>
        <div style={{
          background: '#16121f', borderRadius: 12,
          border: '1px solid #221a35', overflow: 'hidden',
        }}>
          {/* Sub-toolbar row */}
          <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-2">
            {SUB_TOOLS.map(btn => (
              <button key={btn.key}
                className="flex flex-col items-center justify-center gap-0.5 rounded-lg nodrag"
                style={{ background: '#1e1830', border: '1px solid #2a2040', cursor: 'pointer', width: 48, height: 46 }}
                onMouseEnter={e => (e.currentTarget.style.background = '#251e38')}
                onMouseLeave={e => (e.currentTarget.style.background = '#1e1830')}
              >
                <span style={{ fontSize: 15, lineHeight: 1, color: '#8a7aaa' }}>{btn.icon}</span>
                <span style={{ fontSize: 10, color: '#6a5a8a' }}>{btn.label}</span>
              </button>
            ))}
            {connectedImages.map((ref, i) => (
              <div key={i} className="relative rounded-lg overflow-hidden nodrag"
                style={{ width: 48, height: 46, border: '1px solid #2a2040', flexShrink: 0 }}>
                <img src={ref.url} alt="" draggable={false}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                {/* "图片N" label at bottom */}
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0,
                  background: 'rgba(13,10,26,0.72)', fontSize: 9,
                  color: '#c4b5fd', textAlign: 'center', padding: '1px 0',
                }}>图片{i + 1}</div>
              </div>
            ))}
            <div style={{ flex: 1 }} />
            <button className="nodrag" onClick={() => setPreviewUrl(urls[0] ?? null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5a5070', fontSize: 14, padding: 4 }}
              title="全屏">⤢</button>
          </div>

          {/* Prompt */}
          <div ref={promptWrapRef} style={{ padding: '0 14px 10px' }}>
            <PromptEditor
              ref={promptEditorRef}
              value={params.prompt}
              chips={chips}
              onValueChange={val => setParam('prompt', val)}
              onChipsChange={handleChipsChange}
              onAtKey={handleAtKey}
              onEscape={() => setShowAtMenu(false)}
              placeholder="描述你想要生成的画面内容，@引用素材"
              style={{ fontSize: 15, lineHeight: 1.65, color: '#e0d8f8', minHeight: 72 }}
            />
            {showAtMenu && (
              <AtMentionDropdown
                pos={atMenuPos}
                connectedNodeIds={new Set(connectedImages.map(r => r.nodeId))}
                onSelect={handleSelectMention}
                onClose={() => setShowAtMenu(false)}
              />
            )}
          </div>

          {/* Ratio / Resolution panel */}
          {showSettings && (
            <div style={{ padding: '0 14px 12px' }}>
              <div style={{ fontSize: 11, color: '#4a4060', marginBottom: 6 }}>分辨率</div>
              <div className="flex gap-1.5 mb-3">
                {RESOLUTIONS.map(r => (
                  <button key={r} className="flex-1 rounded-lg nodrag"
                    style={{
                      fontSize: 13, padding: '4px 0',
                      background: resolution === r ? '#7c5cfc' : '#1e1830',
                      color: resolution === r ? '#fff' : '#8a7aaa',
                      border: resolution === r ? 'none' : '1px solid #2a2040', cursor: 'pointer',
                    }}
                    onClick={() => { setSettings('resolution', r); setShowSettings(false) }}
                  >{r}</button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#4a4060', marginBottom: 6 }}>比例</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5 }}>
                {RATIOS.map(r => {
                  const active = ratio === r.value
                  return (
                    <button key={r.value}
                      className="nodrag flex flex-col items-center justify-end gap-1 py-2 rounded-lg"
                      style={{
                        background: active ? 'rgba(124,92,252,0.15)' : '#1e1830',
                        border: active ? '1px solid #7c5cfc' : '1px solid #2a2040',
                        cursor: 'pointer', color: active ? '#c4b5fd' : '#6a5a8a',
                        fontSize: 11, minHeight: 52,
                      }}
                      onClick={() => { setSettings('ratio', r.value); setShowSettings(false) }}
                    >
                      <RatioIcon w={r.w} h={r.h} active={active} />
                      <span>{r.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Error */}
          {(genError || data.taskInfo?.status === 3) && (
            <div style={{ margin: '0 14px 8px', padding: '6px 10px', borderRadius: 8, background: '#2a1020', color: '#f87171', fontSize: 13 }}>
              {genError ?? data.taskInfo?.error ?? '生成失败'}
            </div>
          )}

          {/* Bottom bar — LibLib TV style */}
          <div className="flex items-center nodrag" style={{
            borderTop: '1px solid #1e1a2e', padding: '8px 12px', gap: 4,
          }}>
            {/* Model selector */}
            <select className="nodrag" value={params.model} onChange={e => setParam('model', e.target.value)}
              style={{
                flex: '1 1 0', minWidth: 0, background: 'none', border: 'none',
                color: '#c4b5fd', fontSize: 13, cursor: 'pointer', outline: 'none',
                fontWeight: 500,
              }}
            >
              {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>

            <div style={{ width: 1, height: 16, background: '#2a2040', flexShrink: 0 }} />

            {/* Ratio · Res */}
            <button className="nodrag flex items-center gap-1" onClick={() => setShowSettings(v => !v)}
              style={{ background: 'none', border: 'none', color: '#8a7aaa', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', padding: '0 4px' }}>
              <span style={{ fontSize: 10, opacity: 0.6 }}>□</span>
              <span>{ratio === 'auto' ? '自适应' : ratio} · {resolution}</span>
              <span style={{ fontSize: 9, opacity: 0.5 }}>▾</span>
            </button>

            <div style={{ width: 1, height: 16, background: '#2a2040', flexShrink: 0 }} />

            {/* Translate */}
            <button className="nodrag" onClick={handleTranslate}
              style={{ background: 'none', border: 'none', color: '#8a7aaa', fontSize: 13, cursor: 'pointer', padding: '0 4px' }}
              title="翻译提示词">文A</button>

            {/* Count */}
            <select className="nodrag" value={params.count} onChange={e => setParam('count', Number(e.target.value))}
              style={{ background: 'none', border: 'none', color: '#8a7aaa', fontSize: 13, cursor: 'pointer', outline: 'none' }}>
              {[1, 2, 4].map(n => <option key={n} value={n}>{n}张</option>)}
            </select>

            {/* Generate button */}
            <button className="nodrag flex items-center justify-center"
              style={{
                width: 36, height: 36, flexShrink: 0, marginLeft: 4, borderRadius: 10,
                background: isLoading ? '#1e1830' : '#ffffff',
                border: 'none',
                cursor: isLoading ? 'default' : 'pointer',
                color: isLoading ? '#7c5cfc' : '#111',
                boxShadow: isLoading ? 'none' : '0 2px 8px rgba(0,0,0,0.25)',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { if (!isLoading) (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0' }}
              onMouseLeave={e => { if (!isLoading) (e.currentTarget as HTMLButtonElement).style.background = '#ffffff' }}
              onClick={handleGenerate} disabled={isLoading}
              title={isLoading ? `生成中 ${data.taskInfo?.progressPercent ?? 0}%` : '生成'}
            >
              {isLoading
                ? <svg width="15" height="15" viewBox="0 0 14 14" style={{ animation: 'spin 1s linear infinite' }}>
                    <circle cx="7" cy="7" r="5.5" stroke="#312550" strokeWidth="2" fill="none" />
                    <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" stroke="#7c5cfc" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </svg>
                : <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M8 13V3M8 3L4 7M8 3l4 4" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
              }
            </button>
          </div>
        </div>
        </div>
        </div>,
        document.body
      )}

      {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </>
  )
}
