import { useCallback } from 'react'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { generateApi } from '@/lib/api'
import { defaultAudioParams } from '@/lib/nodeData'
import type { CanvasNodeData, AudioParams } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

export function AudioNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const params = data.params ? (data.params as unknown as AudioParams) : defaultAudioParams()

  const setParam = useCallback(<K extends keyof AudioParams>(key: K, val: AudioParams[K]) => {
    updateNodeData(id, { params: { ...params, [key]: val } as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  const handleGenerate = useCallback(async () => {
    try {
      const res = await generateApi.audio(data.projectUuid, id, params as unknown as Record<string, unknown>)
      addTask(res.jobId, id)
      startPolling(res.jobId, data.projectUuid)
    } catch (e) { console.error(e) }
  }, [data.projectUuid, id, params, addTask, startPolling])

  const audioUrl = data.url?.[0]

  return (
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={320} minHeight={240}>
      <div className="p-3 flex flex-col gap-2">
        {audioUrl ? (
          <audio src={audioUrl} controls className="w-full nodrag" />
        ) : (
          <div className="h-12 flex items-center justify-center text-muted text-xs rounded"
            style={{ border: '1px dashed #2a2a2a' }}>暂无音频</div>
        )}

        <select
          className="text-xs rounded px-2 py-1 nodrag"
          style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
          value={params.type}
          onChange={e => setParam('type', e.target.value as AudioParams['type'])}
        >
          <option value="tts">语音合成 TTS</option>
          <option value="music">音乐生成</option>
          <option value="upload">上传音频</option>
        </select>

        <textarea
          className="w-full rounded p-2 text-xs resize-none nodrag"
          style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5', minHeight: 70 }}
          placeholder={params.type === 'tts' ? '要朗读的文字…' : '音乐风格描述…'}
          value={params.prompt ?? ''}
          onChange={e => setParam('prompt', e.target.value)}
          rows={3}
        />

        <div className="flex gap-2">
          {params.type === 'tts' && (
            <select
              className="flex-1 text-xs rounded px-2 py-1 nodrag"
              style={{ background: '#141414', border: '1px solid #2a2a2a', color: '#e5e5e5' }}
              value={params.voice ?? 'default'}
              onChange={e => setParam('voice', e.target.value)}
            >
              <option value="default">默认音色</option>
              <option value="female">女声</option>
              <option value="male">男声</option>
            </select>
          )}
          <button
            className="flex-1 text-xs py-1 rounded font-medium nodrag"
            style={{ background: '#7c5cfc', color: '#fff', border: 'none', cursor: 'pointer' }}
            onClick={handleGenerate}
            disabled={data.taskInfo?.loading}
          >{data.taskInfo?.loading ? '生成中…' : '生成音频'}</button>
        </div>
      </div>
    </NodeShell>
  )
}
