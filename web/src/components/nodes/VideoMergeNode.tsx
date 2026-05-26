import { useCallback } from 'react'
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

export function VideoMergeNode({ id, data, selected }: Props) {
  const { updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const params = data.params ? (data.params as unknown as VideoParams) : defaultVideoParams()

  const removeVideo = useCallback((nodeId: string) => {
    const videoList = params.videoList.filter((v: NodeRef) => v.nodeId !== nodeId)
    const mixedListOrder = params.mixedListOrder.filter((vid: string) => vid !== nodeId)
    updateNodeData(id, { params: { ...params, videoList, mixedListOrder } as unknown as Record<string, unknown> })
  }, [id, params, updateNodeData])

  const handleMerge = useCallback(async () => {
    try {
      const res = await generateApi.video(data.projectUuid, id, { ...(params as unknown as Record<string, unknown>), action: 'video_merge' })
      addTask(res.jobId, id)
      startPolling(res.jobId, data.projectUuid)
    } catch (e) { console.error(e) }
  }, [data.projectUuid, id, params, addTask, startPolling])

  const outputUrl = data.url?.[0]

  return (
    <NodeShell nodeKey={id} data={data} selected={selected} minWidth={360} minHeight={300}>
      <div className="p-3 flex flex-col gap-2">
        {outputUrl ? (
          <video src={outputUrl} controls className="w-full nodrag" style={{ maxHeight: 180 }} />
        ) : (
          <div className="flex items-center justify-center text-xs text-muted rounded" style={{ height: 80, border: '1px dashed #2a2a2a' }}>
            合并后的视频将显示在此
          </div>
        )}

        <div className="text-xs text-muted">引用的视频片段：</div>
        {params.videoList.length === 0 ? (
          <div className="text-xs text-muted text-center py-2">
            从视频节点的右侧 handle 连线到此节点
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {params.videoList.map((v: NodeRef, i: number) => (
              <div key={v.nodeId} className="flex items-center gap-2 text-xs text-fg">
                <span className="text-muted">{i + 1}.</span>
                <span className="flex-1 truncate">{v.url.split('/').pop()}</span>
                <button className="text-red-400 nodrag" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => removeVideo(v.nodeId)}>✕</button>
              </div>
            ))}
          </div>
        )}

        <button
          className="text-xs py-1 rounded font-medium nodrag"
          style={{ background: '#7c5cfc', color: '#fff', border: 'none', cursor: 'pointer' }}
          onClick={handleMerge}
          disabled={params.videoList.length === 0 || data.taskInfo?.loading}
        >{data.taskInfo?.loading ? '合成中…' : '合成视频'}</button>
      </div>
    </NodeShell>
  )
}
