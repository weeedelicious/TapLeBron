import { useCallback, useState, useRef } from 'react'
import { useImeInput } from '@/lib/useImeInput'
import { NodeShell } from './NodeShell'
import { ImagePreview } from '@/components/ImagePreview'
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

export function ImageNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const [genError, setGenError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

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

  const setParam = useCallback(<K extends keyof ImageParams>(key: K, val: ImageParams[K]) => {
    updateNodeData(id, { params: { ...params, [key]: val } as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  const promptIme = useImeInput(params.prompt, val => setParam('prompt', val))

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
    <NodeShell nodeKey={id} data={data} selected={selected} toolbar={toolbar} minWidth={360} minHeight={200}>

      {/* ── Image preview ── */}
      {hasImage ? (
        !expanded ? (
          /* ── Collapsed: single main image ── */
          <div className="relative group" style={{ background: '#0d0b18' }}>
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
        <div className="flex items-center justify-center" style={{ minHeight: 180, background: '#0d0b18' }}>
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none" opacity={0.12}>
            <rect x="3" y="7" width="34" height="26" rx="3" stroke="#c4b5fd" strokeWidth="2" />
            <circle cx="14" cy="18" r="3.5" stroke="#c4b5fd" strokeWidth="2" />
            <path d="M3 28l10-8 8 8 6-5 10 9" stroke="#c4b5fd" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      {/* ── Sub-toolbar: 风格 标记 聚焦 + connected images ── */}
      <div className="flex items-center gap-1.5 px-3 py-2 nodrag" style={{ borderBottom: '1px solid #2a2040' }}>
        {SUB_TOOLS.map(btn => (
          <button key={btn.key}
            className="flex flex-col items-center justify-center gap-0.5 rounded nodrag"
            style={{ background: '#1e1830', border: '1px solid #312550', cursor: 'pointer', width: 46, height: 44 }}
            onMouseEnter={e => (e.currentTarget.style.background = '#251e38')}
            onMouseLeave={e => (e.currentTarget.style.background = '#1e1830')}
          >
            <span style={{ fontSize: 14, lineHeight: 1, color: '#8a7aaa' }}>{btn.icon}</span>
            <span style={{ fontSize: 9, color: '#6a5a8a' }}>{btn.label}</span>
          </button>
        ))}

        {/* Connected image thumbnails */}
        {connectedImages.length > 0 && (
          <div className="relative rounded overflow-hidden nodrag"
            style={{ width: 44, height: 44, border: '1px solid #312550', flexShrink: 0 }}>
            <img src={connectedImages[0].url} alt=""
              draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            <div style={{
              position: 'absolute', top: 2, right: 2, width: 15, height: 15,
              background: '#7c5cfc', borderRadius: '50%', fontSize: 9,
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600,
            }}>{connectedImages.length}</div>
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Expand button */}
        <button className="nodrag"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5a5070', fontSize: 13 }}
          title="展开"
        >⤢</button>
      </div>

      {/* ── Prompt ── */}
      <div className="px-3 pt-2 pb-1 nodrag">
        <textarea
          className="w-full text-xs resize-none nodrag"
          style={{
            background: 'transparent', border: 'none', color: '#d0c8f0',
            minHeight: 80, outline: 'none', lineHeight: 1.6,
          }}
          placeholder="描述你想要生成的画面内容，按/呼出指令，@引用素材"
          value={params.prompt}
          {...promptIme}
          rows={3}
        />
      </div>

      {/* ── Settings panel ── */}
      {showSettings && (
        <div className="mx-3 mb-2 p-3 rounded nodrag" style={{ background: '#16112a', border: '1px solid #2a2040' }}>
          <div className="text-xs mb-1.5" style={{ color: '#5a5070' }}>分辨率</div>
          <div className="flex gap-1.5 mb-3">
            {RESOLUTIONS.map(r => (
              <button key={r} className="flex-1 text-xs py-0.5 rounded nodrag"
                style={{
                  background: resolution === r ? '#7c5cfc' : '#1e1830',
                  color: resolution === r ? '#fff' : '#8a7aaa',
                  border: resolution === r ? 'none' : '1px solid #312550', cursor: 'pointer',
                }}
                onClick={() => { setSettings('resolution', r); setShowSettings(false) }}
              >{r}</button>
            ))}
          </div>
          <div className="text-xs mb-1.5" style={{ color: '#5a5070' }}>比例</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
            {RATIOS.map(r => {
              const active = ratio === r.value
              return (
                <button key={r.value}
                  className="nodrag flex flex-col items-center justify-end gap-1 py-2 rounded"
                  style={{
                    background: active ? 'rgba(124,92,252,0.15)' : '#1e1830',
                    border: active ? '1px solid #7c5cfc' : '1px solid #312550',
                    cursor: 'pointer', color: active ? '#c4b5fd' : '#6a5a8a',
                    fontSize: 10, minHeight: 52,
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

      {/* ── Error ── */}
      {(genError || data.taskInfo?.status === 3) && (
        <div className="mx-3 mb-1 px-2 py-1 rounded text-xs nodrag"
          style={{ background: '#2a1020', color: '#f87171' }}>
          {genError ?? data.taskInfo?.error ?? '生成失败'}
        </div>
      )}

      {/* ── Bottom bar ── */}
      <div className="flex items-center gap-1.5 px-3 py-2 nodrag" style={{ borderTop: '1px solid #2a2040' }}>
        {/* Model */}
        <select
          className="text-xs rounded px-1.5 py-1 nodrag"
          style={{ background: '#1e1830', border: '1px solid #312550', color: '#c4b5fd', flex: '1 1 0', minWidth: 0 }}
          value={params.model}
          onChange={e => setParam('model', e.target.value)}
        >
          {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>

        {/* Ratio · Res pill */}
        <button
          className="flex items-center gap-1 text-xs px-2 py-1 rounded nodrag"
          style={{ background: '#1e1830', border: '1px solid #312550', color: '#8a7aaa', cursor: 'pointer', whiteSpace: 'nowrap' }}
          onClick={() => setShowSettings(v => !v)}
        >
          <span>{ratio === 'auto' ? '自适应' : ratio}</span>
          <span style={{ opacity: 0.3 }}>·</span>
          <span>{resolution}</span>
          <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 1 }}>▾</span>
        </button>

        {/* Camera mode */}
        <button
          className="flex items-center gap-1 text-xs px-2 py-1 rounded nodrag"
          style={{ background: '#1e1830', border: '1px solid #312550', color: '#8a7aaa', cursor: 'pointer', whiteSpace: 'nowrap' }}
          title="摄像机模式"
        >
          <span style={{ fontSize: 11 }}>🎞</span>
          <span>摄像机</span>
        </button>

        {/* Translate */}
        <button
          className="text-xs px-1.5 py-1 rounded nodrag"
          style={{ background: '#1e1830', border: '1px solid #312550', color: '#8a7aaa', cursor: 'pointer', fontWeight: 500 }}
          onClick={handleTranslate}
          title="翻译提示词"
        >文A</button>

        {/* Count */}
        <select
          className="text-xs rounded px-1.5 py-1 nodrag"
          style={{ background: '#1e1830', border: '1px solid #312550', color: '#8a7aaa' }}
          value={params.count}
          onChange={e => setParam('count', Number(e.target.value))}
        >
          {[1, 2, 4].map(n => <option key={n} value={n}>{n}张</option>)}
        </select>

        {/* Generate */}
        <button
          className="flex items-center justify-center rounded-full nodrag"
          style={{
            width: 32, height: 32, flexShrink: 0,
            background: isLoading ? '#312550' : '#7c5cfc',
            border: 'none', cursor: isLoading ? 'default' : 'pointer', color: '#fff',
            transition: 'background 0.2s',
          }}
          onClick={handleGenerate}
          disabled={isLoading}
          title={isLoading ? `生成中 ${data.taskInfo?.progressPercent ?? 0}%` : '生成'}
        >
          {isLoading
            ? <span style={{ fontSize: 9 }}>{data.taskInfo?.progressPercent ?? 0}%</span>
            : <span style={{ fontSize: 16 }}>↑</span>
          }
        </button>
      </div>

      {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </NodeShell>
  )
}
