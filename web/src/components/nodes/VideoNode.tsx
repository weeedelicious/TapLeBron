import { useCallback, useRef } from 'react'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { generateApi } from '@/lib/api'
import { VIDEO_MODELS, defaultVideoParams, ASPECT_RATIOS } from '@/lib/nodeData'
import type { CanvasNodeData, VideoParams } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

function getParams(data: CanvasNodeData): VideoParams {
  if (data.params) return data.params as unknown as VideoParams
  return defaultVideoParams()
}

export function VideoNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const videoRef = useRef<HTMLVideoElement>(null)
  const params = getParams(data)

  const setParam = useCallback(<K extends keyof VideoParams>(key: K, val: VideoParams[K]) => {
    updateNodeData(id, { params: { ...params, [key]: val } as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  const setSettings = useCallback((key: string, val: unknown) => {
    setParam('settings', { ...params.settings, [key]: val })
  }, [params, setParam])

  const handleGenerate = useCallback(async () => {
    try {
      const res = await generateApi.video(data.projectUuid, id, params as unknown as Record<string, unknown>)
      addTask(res.jobId, id)
      startPolling(res.jobId, data.projectUuid)
    } catch (e) { console.error(e) }
  }, [data.projectUuid, id, params, addTask, startPolling])

  const urls = data.url ?? []
  const videoUrl = urls[0]

  return (
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={360} minHeight={380}>
      <div className="relative bg-black" style={{ minHeight: 160 }}>
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            className="w-full"
            style={{ maxHeight: 280 }}
            controls
            playsInline
          />
        ) : (
          <div className="h-40 flex items-center justify-center text-muted text-xs">暂无视频</div>
        )}
      </div>

      <div className="p-3 flex flex-col gap-2">
        <textarea
          className="w-full rounded p-2 text-xs resize-none nodrag"
          style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5', minHeight: 70 }}
          placeholder="视频描述…"
          value={params.prompt}
          onChange={e => setParam('prompt', e.target.value)}
          rows={3}
        />

        <div className="flex gap-2 flex-wrap">
          <select
            className="flex-1 text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.model}
            onChange={e => setParam('model', e.target.value)}
          >
            {VIDEO_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>

          <select
            className="text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.settings.ratio}
            onChange={e => setSettings('ratio', e.target.value)}
          >
            {ASPECT_RATIOS.slice(0, 6).map(r => <option key={r} value={r}>{r}</option>)}
          </select>

          <select
            className="text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.settings.duration}
            onChange={e => setSettings('duration', Number(e.target.value))}
          >
            {[5, 10].map(d => <option key={d} value={d}>{d}s</option>)}
          </select>

          <select
            className="text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.settings.resolution}
            onChange={e => setSettings('resolution', e.target.value)}
          >
            {['720p', '1080p'].map(r => <option key={r} value={r}>{r}</option>)}
          </select>

          <select
            className="text-xs rounded px-2 py-1 nodrag"
            style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
            value={params.settings.enableSound}
            onChange={e => setSettings('enableSound', e.target.value)}
          >
            <option value="on">有声</option>
            <option value="off">无声</option>
          </select>
        </div>

        <button
          className="text-xs py-1 rounded font-medium nodrag"
          style={{ background: '#7c5cfc', color: '#fff', border: 'none', cursor: 'pointer' }}
          onClick={handleGenerate}
          disabled={data.taskInfo?.loading}
        >{data.taskInfo?.loading ? '生成中…' : '生成视频'}</button>
      </div>
    </NodeShell>
  )
}
