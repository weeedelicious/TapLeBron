import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { NodeShell } from './NodeShell'
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

function RatioIcon({ w, h, active }: { w: number; h: number; active: boolean }) {
  const MAX = 20
  const scale = MAX / Math.max(w, h)
  const rw = Math.max(3, Math.round(w * scale))
  const rh = Math.max(3, Math.round(h * scale))
  return (
    <svg width={rw} height={rh} viewBox={`0 0 ${rw} ${rh}`} fill="none" style={{ display: 'block' }}>
      <rect x="0.75" y="0.75" width={rw - 1.5} height={rh - 1.5} rx="1.5"
        stroke={active ? '#7c5cfc' : 'currentColor'} strokeWidth="1.5" fill={active ? 'rgba(124,92,252,0.15)' : 'none'} />
    </svg>
  )
}

export function ImageNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const [genError, setGenError] = useState<string | null>(null)
  const [showRatioPanel, setShowRatioPanel] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const params = getParams(data)
  const urls = data.url ?? []
  const ratio = params.settings.ratio ?? '16:9'
  const resolution = params.settings.resolution ?? '1K'

  const setParam = useCallback(<K extends keyof ImageParams>(key: K, val: ImageParams[K]) => {
    const updated = { ...params, [key]: val }
    updateNodeData(id, { params: updated as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

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

  return (
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={360} minHeight={420}>
      {/* Image preview area */}
      <div className="relative bg-black" style={{ minHeight: urls.length ? undefined : 160 }}>
        {urls.length > 0 ? (
          <div className="flex flex-wrap">
            {urls.map((url, i) => (
              <img
                key={i} src={url} alt=""
                className="w-full object-contain nodrag"
                style={{ maxHeight: 300, cursor: 'zoom-in' }}
                onDoubleClick={() => setPreviewUrl(url)}
              />
            ))}
          </div>
        ) : (
          <div className="h-40 flex items-center justify-center text-muted text-xs">暂无图片</div>
        )}
      </div>

      <div className="p-3 flex flex-col gap-2">
        {/* Reference images */}
        {(params.imageList as NodeRef[] | undefined)?.filter(r => r.url).length ? (
          <div>
            <div className="text-xs mb-1" style={{ color: '#6a6080' }}>参考图</div>
            <div className="flex flex-wrap gap-1">
              {(params.imageList as NodeRef[]).filter(r => r.url).map((ref, i) => (
                <div key={i} className="relative rounded overflow-hidden" style={{ width: 52, height: 52 }}>
                  <img src={ref.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <button
                    className="absolute top-0 right-0 nodrag"
                    style={{ width: 16, height: 16, background: 'rgba(0,0,0,0.7)', border: 'none', color: '#aaa', fontSize: 10, cursor: 'pointer', lineHeight: 1 }}
                    onClick={() => setParam('imageList', (params.imageList as NodeRef[]).filter((_, j) => j !== i) as never)}
                  >×</button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Prompt */}
        <textarea
          className="w-full rounded p-2 text-xs resize-none nodrag"
          style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5', minHeight: 80 }}
          placeholder="描述想要生成的图像…"
          value={params.prompt}
          onChange={e => setParam('prompt', e.target.value)}
          rows={4}
        />

        {/* Controls row */}
        <div className="flex gap-2 flex-wrap items-center">
          <select
            className="flex-1 text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.model}
            onChange={e => setParam('model', e.target.value)}
          >
            {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>

          {/* Ratio · Resolution pill */}
          <button
            className="text-xs px-2 py-1 rounded nodrag"
            style={{ background: showRatioPanel ? '#2a2040' : '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5', cursor: 'pointer', whiteSpace: 'nowrap' }}
            onClick={() => setShowRatioPanel(v => !v)}
          >
            {ratio === 'auto' ? '自适应' : ratio} · {resolution}
          </button>

          {/* Count */}
          <select
            className="text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.count}
            onChange={e => setParam('count', Number(e.target.value))}
          >
            {[1, 2, 4].map(n => <option key={n} value={n}>{n}张</option>)}
          </select>
        </div>

        {/* Ratio / Resolution panel (inline) */}
        {showRatioPanel && (
          <div className="rounded nodrag" style={{ background: '#1a1a2e', border: '1px solid #2d2248', padding: '12px 14px' }}>
            <div className="text-xs mb-2" style={{ color: '#8a80a8' }}>分辨率</div>
            <div className="flex gap-2 mb-3">
              {RESOLUTIONS.map(r => (
                <button key={r}
                  className="flex-1 text-xs py-1 rounded nodrag"
                  style={{
                    background: resolution === r ? '#7c5cfc' : '#2a2040',
                    color: resolution === r ? '#fff' : '#a090c8',
                    border: resolution === r ? 'none' : '1px solid #3a2860',
                    cursor: 'pointer',
                  }}
                  onClick={() => { setSettings('resolution', r); setShowRatioPanel(false) }}
                >{r}</button>
              ))}
            </div>
            <div className="text-xs mb-2" style={{ color: '#8a80a8' }}>比例</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
              {RATIOS.map(r => {
                const active = ratio === r.value
                return (
                  <button key={r.value}
                    className="nodrag flex flex-col items-center justify-end gap-1 py-2 rounded"
                    style={{
                      background: active ? 'rgba(124,92,252,0.15)' : '#2a2040',
                      border: active ? '1px solid #7c5cfc' : '1px solid #3a2860',
                      cursor: 'pointer', color: active ? '#b09cf0' : '#7a70a8',
                      fontSize: 10, minHeight: 52,
                    }}
                    onClick={() => { setSettings('ratio', r.value); setShowRatioPanel(false) }}
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
          <div className="px-2 py-1 rounded text-xs nodrag" style={{ background: '#3a1a1a', color: '#f87171' }}>
            {genError ?? data.taskInfo?.error ?? '生成失败'}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            className="text-xs px-3 py-1 rounded text-muted nodrag"
            style={{ border: '1px solid #2a2a2a', background: 'none', cursor: 'pointer' }}
            onClick={handleTranslate}
          >翻译提示词</button>
          <button
            className="flex-1 text-xs py-1 rounded font-medium nodrag"
            style={{ background: '#7c5cfc', color: '#fff', border: 'none', cursor: 'pointer' }}
            onClick={handleGenerate}
            disabled={data.taskInfo?.loading}
          >{data.taskInfo?.loading ? `生成中… ${data.taskInfo.progressPercent ?? 0}%` : '生成'}</button>
        </div>
      </div>

      {/* Full-screen image preview portal */}
      {previewUrl && createPortal(
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 99999,
            background: 'rgba(0,0,0,0.88)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
          onClick={() => setPreviewUrl(null)}
        >
          <img
            src={previewUrl}
            style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8, boxShadow: '0 20px 60px rgba(0,0,0,0.8)' }}
          />
          <button
            style={{
              position: 'absolute', top: 20, right: 24,
              background: 'rgba(255,255,255,0.12)', border: 'none',
              color: '#fff', fontSize: 24, cursor: 'pointer',
              width: 40, height: 40, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={() => setPreviewUrl(null)}
          >×</button>
        </div>,
        document.body
      )}
    </NodeShell>
  )
}
