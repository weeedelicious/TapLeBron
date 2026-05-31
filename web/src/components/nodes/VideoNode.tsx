import { useCallback, useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { NodeShell } from './NodeShell'
import { ImagePreview } from '@/components/ImagePreview'
import { PromptEditor } from '@/components/PromptEditor'
import type { ChipRef } from '@/components/PromptEditor'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { generateApi } from '@/lib/api'
import { defaultVideoParams, VIDEO_MODELS } from '@/lib/nodeData'
import type { CanvasNodeData, VideoParams, NodeRef } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

function getParams(data: CanvasNodeData): VideoParams {
  if (data.params) return data.params as unknown as VideoParams
  return defaultVideoParams()
}

const RATIOS: { value: string; label: string; w: number; h: number }[] = [
  { value: 'auto', label: 'Auto', w: 20, h: 14 },
  { value: '16:9', label: '16:9', w: 22, h: 13 },
  { value: '4:3',  label: '4:3',  w: 20, h: 15 },
  { value: '1:1',  label: '1:1',  w: 16, h: 16 },
  { value: '3:4',  label: '3:4',  w: 15, h: 20 },
  { value: '9:16', label: '9:16', w: 13, h: 22 },
  { value: '21:9', label: '21:9', w: 26, h: 11 },
]
const RESOLUTIONS = ['480P', '720P', '1080P']
const DURATION_MIN = 4
const DURATION_MAX = 15

type VideoMode = 't2v' | 'omni' | 'i2v' | 'keyframe' | 'img_ref'

const MODES: { key: VideoMode; label: string }[] = [
  { key: 't2v', label: '文生视频' },
  { key: 'omni', label: '全能参考' },
  { key: 'i2v', label: '图生视频' },
  { key: 'keyframe', label: '首尾帧' },
  { key: 'img_ref', label: '图片参考' },
]

const SUB_TOOLS = [
  { icon: '⚑', label: '标记' },
  { icon: '🎥', label: '运镜' },
  { icon: '◉', label: '角色库' },
]

export function VideoNode({ id, data, selected }: Props) {
  const { updateNodeData, nodes, edges, setEdges } = useCanvasStore()
  const { addTask, startPolling, cancelTask } = useTasksStore()
  const videoRef = useRef<HTMLVideoElement>(null)
  const editorRef = useRef<{ insertChip: (ref: ChipRef) => void }>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  // Auto-clear stale taskInfo on mount — don't restart polling for expired jobs
  useEffect(() => {
    if (data.taskInfo?.loading) {
      updateNodeData(id, { taskInfo: undefined })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [count, setCount] = useState(1)
  const [hoverThumb, setHoverThumb] = useState<{ url: string; name: string; rect: DOMRect } | null>(null)
  const [atMenu, setAtMenu] = useState(false)
  const [previewChipUrl, setPreviewChipUrl] = useState<string | null>(null)
  const [chips, setChips] = useState<ChipRef[]>([])
  const [collapsed, setCollapsed] = useState(true)
  const nodeContainerRef = useRef<HTMLDivElement>(null)

  // Auto-collapse when clicking outside the node
  useEffect(() => {
    if (collapsed) return
    const handler = (e: MouseEvent) => {
      if (!nodeContainerRef.current?.contains(e.target as Node)) {
        setCollapsed(true)
        setShowSettings(false)
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [collapsed])

  const params = getParams(data)
  const mode: VideoMode = (params.modeType as VideoMode) ?? 't2v'
  const urls = data.url ?? []
  const videoUrl = urls[0]

  const ratio = params.settings.ratio ?? '16:9'
  const resolution = params.settings.resolution ?? '720P'
  const duration = params.settings.duration ?? 5
  const sound = params.settings.enableSound ?? 'on'

  // Auto-sync: resolve live URLs + assign order-based names ("图片1", "图片2")
  const connectedRefs = (params.imageList as NodeRef[] | undefined)?.filter(r => r.nodeId) ?? []
  const connectedImages = connectedRefs.map((ref, i) => {
    const srcNode = nodes.find(n => n.id === ref.nodeId)
    const liveUrl = (srcNode?.data as CanvasNodeData)?.url?.[0] ?? ref.url
    return { ...ref, url: liveUrl, orderName: `图片${i + 1}` }
  }).filter(r => r.url)

  const setParam = useCallback(<K extends keyof VideoParams>(key: K, val: VideoParams[K]) => {
    updateNodeData(id, { params: { ...params, [key]: val } as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  // Remove connected image + disconnect edge
  const removeConnectedImage = useCallback((nodeId: string) => {
    const newList = (params.imageList as NodeRef[] ?? []).filter(r => r.nodeId !== nodeId)
    updateNodeData(id, { params: { ...params, imageList: newList } as unknown as Record<string, unknown> })
    setEdges(edges.filter(e => !(e.source === nodeId && e.target === id) && !(e.source === id && e.target === nodeId)))
  }, [id, params, updateNodeData, edges, setEdges])

  // Reorder connected images by drag — use nodeId to find real index in imageList
  const moveConnectedImage = useCallback((fromConnIdx: number, toConnIdx: number) => {
    if (fromConnIdx === toConnIdx) return
    const connList = (params.imageList as NodeRef[] ?? []).filter(r => r.nodeId)
    const fromId = connList[fromConnIdx]?.nodeId
    const toId = connList[toConnIdx]?.nodeId
    if (!fromId || !toId) return
    const fullList = [...(params.imageList as NodeRef[] ?? [])]
    const fromReal = fullList.findIndex(r => r.nodeId === fromId)
    const toReal = fullList.findIndex(r => r.nodeId === toId)
    if (fromReal === -1 || toReal === -1) return
    const [item] = fullList.splice(fromReal, 1)
    fullList.splice(toReal, 0, item)
    updateNodeData(id, { params: { ...params, imageList: fullList } as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  // @mention: insert chip inline via PromptEditor
  const handleAtInsert = useCallback((ref: ChipRef) => {
    setAtMenu(false)
    editorRef.current?.insertChip(ref)
  }, [])

  const setSettings = useCallback((key: string, val: unknown) => {
    setParam('settings', { ...params.settings, [key]: val })
  }, [params, setParam])

  const handleGenerate = useCallback(async () => {
    setGenError(null)
    try {
      // Refresh imageList URLs from live node data before sending to API
      const freshImageList = ((params.imageList as NodeRef[] | undefined) ?? []).map(ref => {
        const srcNode = nodes.find(n => n.id === ref.nodeId)
        const liveUrl = (srcNode?.data as CanvasNodeData)?.url?.[0]
        return liveUrl ? { ...ref, url: liveUrl } : ref
      })
      const freshParams = { ...params, imageList: freshImageList }
      const res = await generateApi.video(data.projectUuid, id, freshParams as unknown as Record<string, unknown>)
      addTask(res.jobId, id)
      startPolling(res.jobId, data.projectUuid)
    } catch (e: unknown) {
      const axErr = e as { response?: { data?: { error?: string } }; message?: string }
      setGenError(axErr.response?.data?.error ?? axErr.message ?? '生成失败')
    }
  }, [data.projectUuid, id, params, nodes, addTask, startPolling])

  const isLoading = !!data.taskInfo?.loading

  return (
    <div ref={nodeContainerRef} style={{ display: 'contents' }}>
    <NodeShell nodeKey={id} data={data} selected={selected}
      minWidth={collapsed ? 260 : 420}
      minHeight={collapsed ? 160 : 380}
    >
      {/* Video preview — click to expand when collapsed */}
      <div
        className="relative"
        style={{
          background: '#0d0b18',
          minHeight: collapsed ? 160 : 196,
          cursor: collapsed ? 'pointer' : 'default',
        }}
        onClick={collapsed ? () => setCollapsed(false) : undefined}
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            className="w-full"
            style={{ maxHeight: collapsed ? 220 : 280, display: 'block' }}
            controls={!collapsed}
            playsInline
            onClick={e => { if (collapsed) { e.stopPropagation(); setCollapsed(false) } }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2"
            style={{ height: collapsed ? 160 : 196 }}
          >
            <svg width="36" height="36" viewBox="0 0 40 40" fill="none" opacity={0.15}>
              <polygon points="14,10 32,20 14,30" fill="#fff" />
            </svg>
            {collapsed && (
              <span style={{ fontSize: 12, color: '#4a4060' }}>点击展开</span>
            )}
          </div>
        )}

        {/* Small expand indicator when collapsed */}
        {collapsed && (
          <div style={{
            position: 'absolute', bottom: 8, right: 8,
            background: 'rgba(13,11,24,0.7)', border: '1px solid #312550',
            borderRadius: 4, color: '#6a5a8a', fontSize: 11,
            padding: '2px 6px', pointerEvents: 'none',
          }}>
            点击展开
          </div>
        )}
      </div>

      {/* Panel — only visible when expanded */}
      {!collapsed && <>

      {/* Mode tabs + expand */}
      <div className="flex items-center nodrag" style={{ borderBottom: '1px solid #2a2040' }}>
        <div className="flex flex-1 px-2 pt-1 gap-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {MODES.map(m => (
            <button
              key={m.key}
              className="text-sm px-3 py-2 whitespace-nowrap nodrag"
              style={{
                background: 'none',
                color: mode === m.key ? '#c4b5fd' : '#5a5070',
                border: 'none',
                cursor: 'pointer',
                borderBottom: mode === m.key ? '2px solid #7c5cfc' : '2px solid transparent',
                fontWeight: mode === m.key ? 500 : 400,
                transition: 'color 0.15s',
              }}
              onClick={() => setParam('modeType', m.key as never)}
            >{m.label}</button>
          ))}
        </div>
        <button
          className="nodrag"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#5a5070', fontSize: 13, padding: '0 10px 0 4px' }}
          title="展开面板"
        >⤢</button>
      </div>

      {/* Sub-toolbar: 标记 运镜 角色库 + connected images */}
      <div className="flex items-center gap-1.5 px-3 py-2 nodrag" style={{ borderBottom: '1px solid #2a2040' }}>
        {SUB_TOOLS.map(btn => (
          <button
            key={btn.label}
            className="flex flex-col items-center justify-center gap-0.5 rounded nodrag"
            style={{
              background: '#1e1830',
              border: '1px solid #312550',
              cursor: 'pointer',
              width: 44,
              height: 44,
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1, color: '#8a7aaa' }}>{btn.icon}</span>
            <span style={{ fontSize: 11, color: '#8a7aaa' }}>{btn.label}</span>
          </button>
        ))}

        {/* Connected image thumbnails — drag reorder, × delete, hover zoom */}
        {connectedImages.map((ref, i) => (
          <div key={ref.nodeId}
            className="relative nodrag"
            style={{ flexShrink: 0, width: 44, height: 44 }}
            draggable
            onDragStart={e => e.dataTransfer.setData('thumb-idx', String(i))}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); moveConnectedImage(Number(e.dataTransfer.getData('thumb-idx')), i) }}
            onMouseEnter={e => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setHoverThumb({ url: ref.url, name: ref.orderName, rect })
            }}
            onMouseLeave={() => setHoverThumb(null)}
          >
            <div className="rounded overflow-hidden" style={{ width: 44, height: 44, border: '1px solid #312550', cursor: 'grab' }}>
              <img src={ref.url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            {/* × delete button */}
            <button
              className="nodrag"
              style={{
                position: 'absolute', top: -5, right: -5, width: 14, height: 14,
                borderRadius: '50%', background: '#312550', border: '1px solid #5a4080',
                color: '#c4b5fd', fontSize: 9, cursor: 'pointer', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onClick={() => removeConnectedImage(ref.nodeId)}
            >×</button>
            {/* Order label */}
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center',
              fontSize: 8, color: 'rgba(255,255,255,0.6)', background: 'rgba(0,0,0,0.5)',
              lineHeight: '14px', pointerEvents: 'none',
            }}>{ref.orderName}</div>
          </div>
        ))}
      </div>

      {/* Prompt — PromptEditor with scrollable area */}
      <div className="px-3 pt-2 pb-1 nodrag" style={{ position: 'relative' }}>
        {/* Scrollable wrapper with styled scrollbar */}
        <div
          className="nodrag"
          style={{
            maxHeight: 200,
            overflowY: 'auto',
            overflowX: 'hidden',
            paddingRight: 4,
            scrollbarWidth: 'thin',
            scrollbarColor: '#312550 transparent',
          }}
        >
          <PromptEditor
            ref={editorRef}
            value={params.prompt}
            chips={chips}
            onValueChange={val => setParam('prompt', val as never)}
            onChipsChange={setChips}
            onAtKey={() => connectedImages.length > 0 && setAtMenu(true)}
            onEscape={() => setAtMenu(false)}
            placeholder="描述你想要生成的画面内容，@引用素材"
            orderMap={Object.fromEntries(connectedImages.map(r => [r.nodeId, r.orderName]))}
            style={{ fontSize: 14, lineHeight: 1.7, minHeight: 80 }}
          />
        </div>

        {/* @ dropdown */}
        {atMenu && connectedImages.length > 0 && (
          <div className="nodrag" style={{
            position: 'absolute', left: 12, bottom: '100%', marginBottom: 4,
            background: '#16112a', border: '1px solid #312550',
            borderRadius: 8, overflow: 'hidden', minWidth: 160,
            boxShadow: '0 8px 24px rgba(0,0,0,0.7)', zIndex: 50,
          }}>
            <div style={{ padding: '5px 10px 4px', fontSize: 10, color: '#5a5070' }}>引用图片节点</div>
            {connectedImages.map(ref => (
              <button key={ref.nodeId} className="nodrag flex items-center gap-2 w-full"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px 10px', color: '#c4b5fd', fontSize: 12 }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,92,252,0.15)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                onMouseDown={e => {
                  e.preventDefault()
                  handleAtInsert({ nodeId: ref.nodeId, url: ref.url, name: ref.orderName })
                }}
              >
                <img src={ref.url} draggable={false} style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />
                <span>{ref.orderName}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Error */}
      {(genError || data.taskInfo?.status === 3) && (
        <div className="mx-3 mb-1 px-2 py-1 rounded text-xs nodrag flex items-center justify-between"
          style={{ background: '#2a1020', color: '#f87171' }}>
          <span>{genError ?? data.taskInfo?.error ?? '生成失败'}</span>
          <button className="nodrag" style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 10 }}
            onClick={() => { setGenError(null); updateNodeData(id, { taskInfo: undefined }) }}>清除</button>
        </div>
      )}

      {/* Cancel stuck generation */}
      {isLoading && (
        <div className="flex justify-end px-3 pb-1 nodrag">
          <button className="nodrag text-xs"
            style={{ background: 'none', border: 'none', color: '#5a5070', cursor: 'pointer' }}
            onClick={() => {
              const taskId = data.taskInfo?.taskId
              if (taskId) cancelTask(taskId)
              else updateNodeData(id, { taskInfo: undefined })
            }}
          >取消生成</button>
        </div>
      )}

      {/* Bottom bar wrapper — settings popup floats above */}
      <div className="relative nodrag" style={{ borderTop: '1px solid #2a2040' }}>
        {showSettings && (
          <div className="absolute nodrag"
            style={{
              bottom: '100%', left: 0, right: 0, marginBottom: 4,
              background: '#13102a', border: '1px solid #312550',
              borderRadius: 10, padding: '14px 16px',
              boxShadow: '0 -8px 24px rgba(0,0,0,0.6)', zIndex: 40,
            }}
          >
            <div className="mb-3">
              <div className="text-xs mb-2" style={{ color: '#5a5070' }}>比例</div>
              <div className="flex flex-wrap gap-2">
                {RATIOS.map(r => {
                  const active = ratio === r.value
                  return (
                    <button key={r.value}
                      className="flex flex-col items-center justify-end gap-1 rounded nodrag"
                      style={{ background: active ? '#2a1f50' : '#1e1830', border: active ? '1px solid #7c5cfc' : '1px solid #312550', cursor: 'pointer', padding: '7px 10px 6px', minWidth: 46 }}
                      onClick={() => setSettings('ratio', r.value)}
                    >
                      <div style={{ width: 28, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ width: r.w, height: r.h, border: `1.5px solid ${active ? '#a78bfa' : '#5a5070'}`, borderRadius: 2, background: active ? 'rgba(124,92,252,0.18)' : 'transparent' }} />
                      </div>
                      <span style={{ fontSize: 10, color: active ? '#c4b5fd' : '#6a5a8a' }}>{r.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="mb-3">
              <div className="text-xs mb-2" style={{ color: '#5a5070' }}>清晰度</div>
              <div className="flex gap-2">
                {RESOLUTIONS.map(r => (
                  <button key={r} className="flex-1 text-sm py-1.5 rounded nodrag"
                    style={{ background: resolution === r ? '#7c5cfc' : '#1e1830', color: resolution === r ? '#fff' : '#8a7aaa', border: resolution === r ? 'none' : '1px solid #312550', cursor: 'pointer' }}
                    onClick={() => setSettings('resolution', r)}>{r}</button>
                ))}
              </div>
            </div>
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs" style={{ color: '#5a5070' }}>视频时长</span>
                <span className="text-sm font-medium" style={{ color: '#c4b5fd' }}>{duration}s</span>
              </div>
              <input type="range" min={DURATION_MIN} max={DURATION_MAX} step={1} value={duration}
                className="w-full nodrag" style={{ accentColor: '#7c5cfc', cursor: 'pointer' }}
                onChange={e => setSettings('duration', Number(e.target.value))} />
              <div className="flex justify-between mt-1">
                <span style={{ fontSize: 10, color: '#5a5070' }}>{DURATION_MIN}s</span>
                <span style={{ fontSize: 10, color: '#5a5070' }}>{DURATION_MAX}s</span>
              </div>
            </div>
            <div>
              <div className="text-xs mb-2" style={{ color: '#5a5070' }}>生成音频</div>
              <div className="flex gap-2">
                {(['on', 'off'] as const).map(v => (
                  <button key={v} className="flex-1 text-sm py-2 rounded nodrag"
                    style={{ background: sound === v ? '#7c5cfc' : '#1e1830', color: sound === v ? '#fff' : '#8a7aaa', border: sound === v ? 'none' : '1px solid #312550', cursor: 'pointer', fontWeight: sound === v ? 600 : 400, transition: 'background 0.15s' }}
                    onClick={() => setSettings('enableSound', v)}>
                    {v === 'on' ? '开启' : '关闭'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      <div className="flex items-center gap-1.5 px-3 py-2 nodrag">
        {/* Model selector */}
        <select
          className="text-sm rounded px-2 py-1 nodrag"
          style={{
            background: '#1e1830', border: '1px solid #312550',
            color: '#c4b5fd', maxWidth: 136, flex: '0 0 auto',
          }}
          value={params.model}
          onChange={e => setParam('model', e.target.value)}
        >
          {VIDEO_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>

        {/* Settings pill */}
        <button
          className="flex items-center gap-1 text-xs px-2 py-1 rounded nodrag"
          style={{
            background: '#1e1830', border: '1px solid #312550',
            color: '#8a7aaa', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
          onClick={() => setShowSettings(v => !v)}
        >
          <span>{ratio === 'auto' ? 'Auto' : ratio}</span>
          <span style={{ opacity: 0.3 }}>·</span>
          <span>{resolution}</span>
          <span style={{ opacity: 0.3 }}>·</span>
          <span>{duration}s</span>
          {sound === 'on' && <span style={{ fontSize: 11 }}>·🔊</span>}
        </button>

        {/* Translate */}
        <button
          className="text-xs px-1.5 py-1 rounded nodrag"
          style={{
            background: '#1e1830', border: '1px solid #312550',
            color: '#8a7aaa', cursor: 'pointer', fontWeight: 500,
          }}
          title="翻译提示词"
        >文A</button>

        <div style={{ flex: 1 }} />

        {/* Count */}
        <button
          className="flex items-center gap-0.5 text-xs px-1.5 py-1 rounded nodrag"
          style={{
            background: '#1e1830', border: '1px solid #312550',
            color: '#8a7aaa', cursor: 'pointer',
          }}
          onClick={() => setCount(c => c >= 4 ? 1 : c + 1)}
        >
          {count}个
          <span style={{ fontSize: 8, marginLeft: 1 }}>▲</span>
        </button>

        {/* Generate button */}
        <button
          className="flex items-center justify-center rounded-full nodrag"
          style={{
            width: 32, height: 32,
            background: isLoading ? '#312550' : '#7c5cfc',
            border: 'none',
            cursor: isLoading ? 'default' : 'pointer',
            color: '#fff',
            flexShrink: 0,
            transition: 'background 0.2s',
          }}
          onClick={handleGenerate}
          disabled={isLoading}
          title={isLoading ? `生成中 ${data.taskInfo?.progressPercent ?? 0}%` : '生成'}
        >
          {isLoading
            ? <span style={{ fontSize: 9 }}>{data.taskInfo?.progressPercent ?? 0}%</span>
            : <span style={{ fontSize: 16, lineHeight: 1 }}>↑</span>
          }
        </button>
      </div>
      </div>{/* end bottom bar wrapper */}

      </>}{/* end collapsed panel */}
    </NodeShell>

    {/* Hover zoom Portal — outside overflow-hidden */}
    {hoverThumb && createPortal(
      <div style={{
        position: 'fixed',
        left: hoverThumb.rect.left + hoverThumb.rect.width / 2,
        top: hoverThumb.rect.top - 8,
        transform: 'translate(-50%, -100%)',
        zIndex: 99998, pointerEvents: 'none',
        background: '#0d0b18', border: '1px solid #312550',
        borderRadius: 8, padding: 4,
        boxShadow: '0 8px 32px rgba(0,0,0,0.9)',
      }}>
        <img src={hoverThumb.url} draggable={false}
          style={{ width: 180, height: 180, objectFit: 'contain', display: 'block', borderRadius: 5 }} />
        <div style={{ fontSize: 10, color: '#8a7aaa', textAlign: 'center', marginTop: 4 }}>
          {hoverThumb.name}
        </div>
      </div>,
      document.body
    )}

    {previewChipUrl && <ImagePreview url={previewChipUrl} onClose={() => setPreviewChipUrl(null)} />}
    </div>
  )
}
