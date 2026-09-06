import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Loader2, Scissors } from 'lucide-react'
import { MediaNodeToolbar } from '@/components/MediaNodeToolbar'
import { GenerationProgress } from '@/components/GenerationProgress'
import { VideoMergeEditorModal } from '@/components/VideoMergeEditorModal'
import { NodeShell } from './NodeShell'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { generateApi } from '@/lib/api'
import { errorToText } from '@/lib/display'
import { defaultVideoParams } from '@/lib/nodeData'
import type { CanvasNodeData, VideoMergeClip, VideoParams, NodeRef } from '@/lib/types'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

function getParams(data: CanvasNodeData): VideoParams {
  if (data.params) return data.params as unknown as VideoParams
  return defaultVideoParams()
}

function stripFileName(url: string) {
  const clean = String(url || '').split('#')[0].split('?')[0]
  const part = clean.split('/').filter(Boolean).pop() || '视频片段'
  try {
    return decodeURIComponent(part).replace(/\.[a-z0-9]+$/i, '')
  } catch {
    return part.replace(/\.[a-z0-9]+$/i, '')
  }
}

function clipFromRef(ref: NodeRef, index: number): VideoMergeClip {
  return {
    id: `clip-${ref.nodeId || index}-${index}`,
    nodeId: ref.nodeId || `ref-${index}`,
    url: ref.url,
    name: stripFileName(ref.url) || `视频片段 ${index + 1}`,
    startSec: 0,
    volume: 1,
    muted: false,
  }
}

function normalizedMergeClips(params: VideoParams): VideoMergeClip[] {
  const sourceRefs = (params.videoList ?? []).filter((ref) => ref.url)
  const existing = Array.isArray(params.mergeClips)
    ? params.mergeClips.filter((clip) => clip?.url)
    : []
  const seen = new Set<string>()
  const merged: VideoMergeClip[] = []

  for (const clip of existing) {
    const key = clip.id || clip.nodeId || clip.url
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      id: clip.id || `clip-${clip.nodeId || merged.length}-${merged.length}`,
      nodeId: clip.nodeId || clip.id || `clip-${merged.length}`,
      url: clip.url,
      name: clip.name || stripFileName(clip.url) || `视频片段 ${merged.length + 1}`,
      startSec: Math.max(0, Number(clip.startSec) || 0),
      endSec: Number.isFinite(Number(clip.endSec)) ? Number(clip.endSec) : undefined,
      durationSec: Number.isFinite(Number(clip.durationSec)) ? Number(clip.durationSec) : undefined,
      volume: Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 1,
      muted: Boolean(clip.muted),
    })
  }

  for (const ref of sourceRefs) {
    if (merged.some((clip) => clip.nodeId === ref.nodeId || clip.url === ref.url)) continue
    merged.push(clipFromRef(ref, merged.length))
  }

  return merged
}

function nodeRefFromClip(clip: VideoMergeClip): NodeRef {
  return {
    nodeId: clip.nodeId,
    url: clip.url,
    mediaType: 'video',
  }
}

export function VideoMergeNode({ id, data, selected }: Props) {
  const { updateNodeData, selectedNodeKeys, activePanelNodeId } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const params = getParams(data)
  const clips = useMemo(() => normalizedMergeClips(params), [params])
  const [editorOpen, setEditorOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  useEffect(() => {
    if (data.taskInfo?.loading) setIsSubmitting(false)
  }, [data.taskInfo?.loading])

  const commitClips = useCallback((nextClips: VideoMergeClip[]) => {
    updateNodeData(id, {
      params: {
        ...params,
        videoList: nextClips.map(nodeRefFromClip),
        mixedList: nextClips.map(nodeRefFromClip),
        mixedListOrder: nextClips.map((clip) => clip.nodeId),
        mergeClips: nextClips,
      } as unknown as Record<string, unknown>,
    })
  }, [id, params, updateNodeData])

  const handleExport = useCallback(async () => {
    if (isSubmitting || data.taskInfo?.loading || clips.length === 0) return
    setGenError(null)
    setIsSubmitting(true)
    try {
      const res = await generateApi.video(data.projectUuid, id, {
        ...(params as unknown as Record<string, unknown>),
        action: 'video_merge',
        mergeClips: clips,
      })
      addTask(res.jobId, id)
      startPolling(res.jobId, data.projectUuid)
    } catch (error) {
      setGenError(errorToText((error as { response?: { data?: { error?: unknown } }; message?: string })?.response?.data?.error ?? error, '视频合成失败'))
      setIsSubmitting(false)
    }
  }, [addTask, clips, data.projectUuid, data.taskInfo?.loading, id, isSubmitting, params, startPolling])

  const outputUrl = data.url?.[0]
  const isLoading = isSubmitting || Boolean(data.taskInfo?.loading)
  const errorText = genError ?? (data.taskInfo?.status === 3 ? errorToText(data.taskInfo.error, '视频合成失败') : null)
  const isSoleSelected = selectedNodeKeys.length === 1 && selectedNodeKeys[0] === id
  const isPanelActive = activePanelNodeId === id && isSoleSelected

  const toolbar = isPanelActive ? (
    <MediaNodeToolbar
      actions={[
        { key: 'edit', label: '剪辑合成', icon: <Scissors size={16} />, onClick: () => setEditorOpen(true) },
        { key: 'export', label: isLoading ? '合成中' : '导出合成', icon: isLoading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />, onClick: handleExport, disabled: isLoading || clips.length === 0 },
      ]}
    />
  ) : undefined

  return (
    <>
      <NodeShell nodeKey={id} data={data} selected={selected} toolbar={toolbar} showFavoriteToolbarFallback={false} minWidth={360} minHeight={300}>
        <div
          style={{
            height: 300,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            background: '#202020',
            color: '#a6a6aa',
            position: 'relative',
          }}
          onDoubleClick={() => setEditorOpen(true)}
        >
          {outputUrl ? (
            <video
              src={outputUrl}
              controls
              draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#070707' }}
            />
          ) : (
            <>
              <Scissors size={66} strokeWidth={1.6} style={{ opacity: 0.42, pointerEvents: 'none' }} />
              <button
                className="nodrag nopan"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setEditorOpen(true)}
                style={{
                  padding: '8px 14px',
                  borderRadius: 8,
                  border: '1px solid #383838',
                  background: '#252525',
                  color: '#d5d5d8',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                打开视频合成
              </button>
              <div style={{ position: 'absolute', bottom: 12, color: '#777', fontSize: 12 }}>
                {clips.length ? `${clips.length} 个片段待合成` : '连接视频节点后开始剪辑'}
              </div>
            </>
          )}
          {isLoading && false ? (
            <div
              className="nodrag nopan"
              style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.45)', color: '#fff', gap: 8 }}
            >
              <Loader2 size={18} className="animate-spin" />
              合成中
            </div>
          ) : null}
          {isLoading ? (
            <div
              className="nodrag nopan"
              style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.45)' }}
            >
              <GenerationProgress taskInfo={data.taskInfo} label="合成视频" compact />
            </div>
          ) : null}
          {errorText ? (
            <div style={{ position: 'absolute', left: 10, right: 10, bottom: 10, padding: '7px 9px', borderRadius: 7, background: '#35101a', color: '#ff8aa0', fontSize: 12 }}>
              {errorText}
            </div>
          ) : null}
        </div>
      </NodeShell>

      {editorOpen ? (
        <VideoMergeEditorModal
          nodeName={data.name}
          clips={clips}
          outputUrl={outputUrl}
          isExporting={isLoading}
          error={errorText}
          onChangeClips={commitClips}
          onExport={handleExport}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
    </>
  )
}
