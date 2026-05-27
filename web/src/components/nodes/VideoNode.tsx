import { useCallback, useRef, useState } from 'react'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { generateApi } from '@/lib/api'
import { defaultVideoParams } from '@/lib/nodeData'
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

const VIDEO_MODELS = [
  { value: 'Seedance_2_0', label: 'Seedance 2.0 Pro', modes: ['t2v', 'i2v'] },
  { value: 'Seedance_2_0_Fast', label: 'Seedance 2.0 Fast', modes: ['t2v', 'i2v'] },
  { value: 'Seedance_1_5_Pro', label: 'Seedance 1.5 Pro', modes: ['t2v', 'i2v'] },
  { value: 'Seedance_1_0_Pro', label: 'Seedance 1.0 Pro', modes: ['t2v', 'i2v'] },
]

const RATIOS = ['auto', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9']
const RESOLUTIONS = ['480P', '720P']
const DURATIONS = [5, 8, 12]

type VideoMode = 't2v' | 'i2v' | 'keyframe'

const MODES: { key: VideoMode; label: string }[] = [
  { key: 't2v', label: '文生视频' },
  { key: 'i2v', label: '图生视频' },
  { key: 'keyframe', label: '首尾帧' },
]

export function VideoNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const params = getParams(data)
  const mode: VideoMode = (params.modeType as VideoMode) ?? 't2v'
  const urls = data.url ?? []
  const videoUrl = urls[0]

  const setParam = useCallback(<K extends keyof VideoParams>(key: K, val: VideoParams[K]) => {
    updateNodeData(id, { params: { ...params, [key]: val } as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  const setSettings = useCallback((key: string, val: unknown) => {
    setParam('settings', { ...params.settings, [key]: val })
  }, [params, setParam])

  const handleGenerate = useCallback(async () => {
    setGenError(null)
    try {
      const res = await generateApi.video(data.projectUuid, id, params as unknown as Record<string, unknown>)
      addTask(res.jobId, id)
      startPolling(res.jobId, data.projectUuid)
    } catch (e: unknown) {
      const axErr = e as { response?: { data?: { error?: string } }; message?: string }
      setGenError(axErr.response?.data?.error ?? axErr.message ?? '生成失败')
    }
  }, [data.projectUuid, id, params, addTask, startPolling])

  const ratio = params.settings.ratio ?? '16:9'
  const resolution = params.settings.resolution ?? '720P'
  const duration = params.settings.duration ?? 5
  const sound = params.settings.enableSound ?? 'on'

  return (
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={400} minHeight={420}>
      {/* Video preview */}
      <div className="relative bg-black" style={{ minHeight: 180 }}>
        {videoUrl ? (
          <video ref={videoRef} src={videoUrl} className="w-full" style={{ maxHeight: 280 }} controls playsInline />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 text-muted"
            style={{ height: 180 }}>
            <span style={{ fontSize: 36, opacity: 0.2 }}>▶</span>
            {mode !== 't2v' && (
              <div className="flex gap-2 text-xs">
                <button className="px-3 py-1 rounded nodrag"
                  style={{ border: '1px solid #3a3a3a', background: '#1e1e1e', color: '#aaa', cursor: 'pointer' }}
                  onClick={() => setParam('modeType', 'keyframe' as never)}>
                  首尾帧生成视频
                </button>
                <button className="px-3 py-1 rounded nodrag"
                  style={{ border: '1px solid #3a3a3a', background: '#1e1e1e', color: '#aaa', cursor: 'pointer' }}
                  onClick={() => setParam('modeType', 'i2v' as never)}>
                  首帧生成视频
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mode tabs */}
      <div className="flex border-b px-3 pt-2 gap-1 nodrag" style={{ borderColor: '#2a2a2a' }}>
        {MODES.map(m => (
          <button
            key={m.key}
            className="text-xs px-3 py-1 rounded-t nodrag"
            style={{
              background: mode === m.key ? '#7c5cfc22' : 'none',
              color: mode === m.key ? '#7c5cfc' : '#8a8a8a',
              border: 'none', cursor: 'pointer',
              borderBottom: mode === m.key ? '2px solid #7c5cfc' : '2px solid transparent',
            }}
            onClick={() => setParam('modeType', m.key as never)}
          >{m.label}</button>
        ))}
      </div>

      {/* Reference images from connected nodes */}
      {(params.imageList as NodeRef[] | undefined)?.filter(r => r.url).length ? (
        <div className="px-3 pt-2">
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
      <div className="px-3 pt-2 pb-1">
        <textarea
          className="w-full rounded p-2 text-xs resize-none nodrag"
          style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5', minHeight: 80 }}
          placeholder="描述你想要生成的画面内容…"
          value={params.prompt}
          onChange={e => setParam('prompt', e.target.value)}
          rows={3}
        />
      </div>

      {/* Settings popup */}
      {showSettings && (
        <div className="mx-3 mb-2 p-3 rounded nodrag" style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}>
          {/* Ratio */}
          <div className="mb-3">
            <div className="text-xs text-muted mb-1">比例</div>
            <div className="flex flex-wrap gap-1">
              {RATIOS.map(r => (
                <button key={r} className="text-xs px-2 py-1 rounded nodrag"
                  style={{
                    background: ratio === r ? '#7c5cfc' : '#2a2a2a',
                    color: ratio === r ? '#fff' : '#aaa',
                    border: 'none', cursor: 'pointer',
                  }}
                  onClick={() => setSettings('ratio', r)}>{r === 'auto' ? 'Auto' : r}</button>
              ))}
            </div>
          </div>
          {/* Resolution */}
          <div className="mb-3">
            <div className="text-xs text-muted mb-1">清晰度</div>
            <div className="flex gap-1">
              {RESOLUTIONS.map(r => (
                <button key={r} className="text-xs px-3 py-1 rounded nodrag"
                  style={{
                    background: resolution === r ? '#7c5cfc' : '#2a2a2a',
                    color: resolution === r ? '#fff' : '#aaa',
                    border: 'none', cursor: 'pointer',
                  }}
                  onClick={() => setSettings('resolution', r)}>{r.toUpperCase()}</button>
              ))}
            </div>
          </div>
          {/* Duration */}
          <div className="mb-3">
            <div className="text-xs text-muted mb-1">视频时长</div>
            <div className="flex gap-1">
              {DURATIONS.map(d => (
                <button key={d} className="flex-1 text-xs py-1 rounded nodrag"
                  style={{
                    background: duration === d ? '#7c5cfc' : '#2a2a2a',
                    color: duration === d ? '#fff' : '#aaa',
                    border: 'none', cursor: 'pointer',
                  }}
                  onClick={() => setSettings('duration', d)}>{d}s</button>
              ))}
            </div>
          </div>
          {/* Sound */}
          <div>
            <div className="text-xs text-muted mb-1">生成音频</div>
            <div className="flex gap-1">
              {(['on', 'off'] as const).map(v => (
                <button key={v} className="flex-1 text-xs py-1 rounded nodrag"
                  style={{
                    background: sound === v ? '#7c5cfc' : '#2a2a2a',
                    color: sound === v ? '#fff' : '#aaa',
                    border: 'none', cursor: 'pointer',
                  }}
                  onClick={() => setSettings('enableSound', v)}>{v === 'on' ? '开启' : '关闭'}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {(genError || data.taskInfo?.status === 3) && (
        <div className="mx-3 mb-1 px-2 py-1 rounded text-xs" style={{ background: '#3a1a1a', color: '#f87171' }}>
          {genError ?? data.taskInfo?.error ?? '生成失败'}
        </div>
      )}

      {/* Bottom control bar */}
      <div className="flex items-center gap-2 px-3 pb-3 nodrag" style={{ borderTop: '1px solid #2a2a2a', paddingTop: 8 }}>
        {/* Model selector */}
        <select
          className="flex-1 text-xs rounded px-2 py-1 nodrag"
          style={{ background: '#1e1e1e', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
          value={params.model}
          onChange={e => setParam('model', e.target.value)}
        >
          {VIDEO_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>

        {/* Ratio · Res · Duration summary */}
        <button
          className="text-xs px-2 py-1 rounded nodrag"
          style={{ background: '#1e1e1e', border: '1px solid #2a2a2a', color: '#aaa', cursor: 'pointer', whiteSpace: 'nowrap' }}
          onClick={() => setShowSettings(v => !v)}
        >
          {ratio === 'auto' ? 'Auto' : ratio} · {resolution} · {duration}s
          {sound === 'on' ? ' · 🔊' : ''}
        </button>

        {/* Generate */}
        <button
          className="text-xs px-4 py-1 rounded font-medium nodrag"
          style={{ background: '#7c5cfc', color: '#fff', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
          onClick={handleGenerate}
          disabled={data.taskInfo?.loading}
        >
          {data.taskInfo?.loading ? `${data.taskInfo.progressPercent ?? 0}%…` : '生成'}
        </button>
      </div>
    </NodeShell>
  )
}
