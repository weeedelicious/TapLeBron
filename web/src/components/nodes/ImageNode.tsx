import { useCallback, useState } from 'react'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { generateApi } from '@/lib/api'
import { ASPECT_RATIOS, IMAGE_MODELS, defaultImageParams } from '@/lib/nodeData'
import type { CanvasNodeData, ImageParams } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

function getParams(data: CanvasNodeData): ImageParams {
  if (data.params) return data.params as unknown as ImageParams
  return defaultImageParams()
}

export function ImageNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const [showAdvanced, setShowAdvanced] = useState(false)

  const params = getParams(data)
  const urls = data.url ?? []

  const setParam = useCallback(<K extends keyof ImageParams>(key: K, val: ImageParams[K]) => {
    const updated = { ...params, [key]: val }
    updateNodeData(id, { params: updated as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  const setSettings = useCallback((key: string, val: string) => {
    setParam('settings', { ...params.settings, [key]: val })
  }, [params, setParam])

  const handleGenerate = useCallback(async () => {
    if (!params.prompt.trim()) return
    try {
      const res = await generateApi.image(data.projectUuid, id, params as unknown as Record<string, unknown>)
      addTask(res.jobId, id)
      startPolling(res.jobId, data.projectUuid)
    } catch (e) {
      console.error(e)
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
      <div className="relative bg-black" style={{ minHeight: urls.length ? undefined : 160 }}>
        {urls.length > 0 ? (
          <div className="flex flex-wrap">
            {urls.map((url, i) => (
              <img key={i} src={url} alt="" className="w-full object-contain" style={{ maxHeight: 300 }} />
            ))}
          </div>
        ) : (
          <div className="h-40 flex items-center justify-center text-muted text-xs">暂无图片</div>
        )}
      </div>

      <div className="p-3 flex flex-col gap-2">
        <textarea
          className="w-full rounded p-2 text-xs resize-none nodrag"
          style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5', minHeight: 80 }}
          placeholder="描述想要生成的图像…"
          value={params.prompt}
          onChange={e => setParam('prompt', e.target.value)}
          rows={4}
        />

        <div className="flex gap-2 flex-wrap">
          <select
            className="flex-1 text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.model}
            onChange={e => setParam('model', e.target.value)}
          >
            {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>

          <select
            className="text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.settings.ratio}
            onChange={e => setSettings('ratio', e.target.value)}
          >
            {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>

          <select
            className="text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.count}
            onChange={e => setParam('count', Number(e.target.value))}
          >
            {[1, 2, 4].map(n => <option key={n} value={n}>{n}张</option>)}
          </select>
        </div>

        <button
          className="text-xs text-left text-muted nodrag"
          onClick={() => setShowAdvanced(v => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer' }}
        >{showAdvanced ? '▲' : '▼'} 高级参数</button>

        {showAdvanced && (
          <div className="flex flex-col gap-2">
            <SliderRow label="风格化" min={0} max={1000} value={params.stylization ?? 100} onChange={v => setParam('stylization', v)} />
            <SliderRow label="怪异度" min={0} max={3000} value={params.weirdness ?? 100} onChange={v => setParam('weirdness', v)} />
            <SliderRow label="多样性" min={0} max={100} value={params.diversity ?? 5} onChange={v => setParam('diversity', v)} />
            <input
              className="w-full text-xs rounded px-2 py-1 nodrag"
              style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
              placeholder="个性化风格 P 值"
              value={params.pValue ?? ''}
              onChange={e => setParam('pValue', e.target.value)}
            />
          </div>
        )}

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
          >{data.taskInfo?.loading ? '生成中…' : '生成'}</button>
        </div>
      </div>
    </NodeShell>
  )
}

function SliderRow({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted w-16 flex-shrink-0">{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} className="flex-1 nodrag" style={{ accentColor: '#7c5cfc' }} />
      <span className="text-xs text-muted w-10 text-right">{value}</span>
    </div>
  )
}
