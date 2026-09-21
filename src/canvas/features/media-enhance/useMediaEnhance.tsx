import { useCallback, useMemo, useRef, useState } from 'react'
import { addEdge } from '@xyflow/react'
import {
  MediaEnhanceModal,
  type MediaEnhanceMode,
  type MediaEnhanceScale,
} from './MediaEnhanceModal'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { toolboxApi } from '@/lib/api'
import { defaultImageParams, defaultVideoParams } from '@/lib/nodeData'
import { errorToText } from '@/lib/display'
import type { CanvasNodeData } from '@/lib/types'

interface UseMediaEnhanceOptions {
  id: string
  data: CanvasNodeData & { projectUuid: string }
  sourceUrl: string
  sourceName?: string
  mediaType: 'image' | 'video'
  shellWidth: number
  sourceWidth?: number
  sourceHeight?: number
  sourceFps?: number
  sourceDurationSec?: number
}

function stripExtension(name: string) {
  return String(name || '素材').replace(/\.[a-z0-9]+$/i, '') || '素材'
}

export function useMediaEnhance({
  id,
  data,
  sourceUrl,
  sourceName,
  mediaType,
  shellWidth,
  sourceWidth,
  sourceHeight,
  sourceFps,
  sourceDurationSec,
}: UseMediaEnhanceOptions) {
  const { addTask, startPolling } = useTasksStore()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lockRef = useRef(false)

  const openModal = useCallback(() => {
    if (!sourceUrl || submitting) return
    setError(null)
    setOpen(true)
  }, [sourceUrl, submitting])

  const closeModal = useCallback(() => {
    if (submitting) return
    setOpen(false)
    setError(null)
  }, [submitting])

  const submit = useCallback(async (mode: MediaEnhanceMode, scale: MediaEnhanceScale) => {
    if (!sourceUrl || submitting || lockRef.current) return
    lockRef.current = true
    setSubmitting(true)
    setError(null)
    let createdNodeId = ''
    let taskStarted = false
    try {
      const state = useCanvasStore.getState()
      const sourceNode = state.nodes.find((node) => node.id === id || node.data.nodeKey === id)
      const sourcePosition = sourceNode?.position ?? { x: 0, y: 0 }
      const outgoingCount = state.edges.filter((edge) => edge.source === id || edge.source === sourceNode?.id).length
      const sourceRef = { nodeId: id, url: sourceUrl, mediaType }
      const targetWidth = sourceWidth ? Math.round(sourceWidth * scale) : undefined
      const targetHeight = sourceHeight ? Math.round(sourceHeight * scale) : undefined
      const generative = mode === 'generative'
      const nvidiaVsr = mode === 'nvidia-vsr'
      const flashVsr = mode === 'flashvsr'
      const generativeDetails = generative || flashVsr
      const provider = generative ? 'seedvr2' : flashVsr ? 'flashvsr' : nvidiaVsr ? 'nvidia-vfx' : 'realsr-ncnn-vulkan'
      const model = generative
        ? 'SeedVR2 7B Sharp FP8'
        : flashVsr
          ? 'FlashVSR v1.1 Tiny Long'
        : nvidiaVsr
          ? 'NVIDIA RTX Video Super Resolution'
          : 'RealSR DF2K'
      const phaseLabel = generative
        ? 'AI 生成式细节'
        : flashVsr
          ? 'FlashVSR 电影级细节'
        : nvidiaVsr
          ? 'NVIDIA RTX 视频超分'
          : 'AI 高清增强'
      const marker = {
        version: 3,
        sourceNodeId: id,
        sourceUrl,
        mediaType,
        enhanceMode: mode,
        scale,
        sourceWidth,
        sourceHeight,
        targetWidth,
        targetHeight,
        sourceFps,
        durationSec: sourceDurationSec,
        provider,
        model,
        qualityMode: 'quality',
        generativeDetails,
        ...(nvidiaVsr ? {
          nvidiaVfxVersion: '0.1.0.1',
          nvidiaVsrQuality: 'ULTRA',
        } : {}),
        ...(generative ? {
          colorCorrection: 'lab',
          batchSize: 5,
          uniformBatchSize: true,
          temporalOverlap: mediaType === 'video' ? 4 : 0,
          prependFrames: mediaType === 'video' ? 4 : 0,
        } : {}),
        ...(flashVsr ? {
          flashVsrVersion: 'v1.1',
          flashVsrPipeline: 'tiny-long',
          flashVsrLocalRange: 11,
          flashVsrSparseRatio: 2,
        } : {}),
        ...(mediaType === 'video'
          ? { crf: 12, preset: 'slow', outputFormat: 'mp4', pixelFormat: 'yuv420p' }
          : { imageTta: true, outputFormat: 'png' }),
      }

      let params: Record<string, unknown>
      if (mediaType === 'video') {
        const base = defaultVideoParams()
        params = {
          ...base,
          model,
          modeType: 'video-edit',
          videoList: [sourceRef],
          mixedList: [sourceRef],
          mixedListOrder: [id],
          settings: {
            ...base.settings,
            ratio: 'auto',
            resolution: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : `${scale}x`,
            duration: sourceDurationSec || base.settings.duration,
          },
          mediaEnhance: marker,
        } as unknown as Record<string, unknown>
      } else {
        const base = defaultImageParams()
        params = {
          ...base,
          prompt: '',
          model,
          count: 1,
          modeType: 'image2image',
          settings: {
            ...base.settings,
            ratio: 'original',
            resolution: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : `${scale}x`,
          },
          imageList: [sourceRef],
          imageListOrder: [id],
          mediaEnhance: marker,
        } as unknown as Record<string, unknown>
      }

      const resultNode = state.addNodeAt(
        mediaType,
        sourcePosition.x + shellWidth + 140,
        sourcePosition.y + outgoingCount * 44,
        {
          name: `${stripExtension(sourceName || data.name)} ${generative ? '生成式细节' : flashVsr ? 'FlashVSR' : nvidiaVsr ? 'NVIDIA VSR' : 'AI 高清'} ${scale}x`,
          url: [],
          action: mediaType === 'video' ? 'video_generate' : 'image_generate',
          sourceKind: 'media_enhance',
          generatorType: 'media-enhance',
          params,
          taskInfo: {
            taskId: '',
            loading: true,
            status: 1,
            progressPercent: 0,
            model,
            taskKind: mediaType,
            phaseLabel,
          },
        },
      )
      createdNodeId = resultNode.id

      const latest = useCanvasStore.getState()
      const edgeId = `e-${id}-${resultNode.id}`
      if (!latest.edges.some((edge) => edge.id === edgeId)) {
        latest.setEdges(addEdge({
          id: edgeId,
          source: sourceNode?.id || id,
          target: resultNode.id,
          type: 'glow',
          selectable: true,
          interactionWidth: 34,
        }, latest.edges))
      }
      const saved = await useCanvasStore.getState().persistNodesAndWait()
      if (!saved) throw new Error('高清增强输出节点保存失败，请刷新画布后重试')

      const response = await toolboxApi.mediaEnhance(
        data.projectUuid,
        resultNode.id,
        sourceUrl,
        mediaType,
        scale,
        mode,
        id,
      )
      if (!response?.jobId) throw new Error('高清增强任务未创建')
      taskStarted = true
      addTask(response.jobId, resultNode.id, response.generationVersion, {
        phaseLabel,
        model,
        taskKind: mediaType,
      })
      startPolling(response.jobId, data.projectUuid)
      setOpen(false)
    } catch (submitError) {
      setError(errorToText(submitError, 'AI 高清增强失败'))
      if (createdNodeId && !taskStarted) {
        const state = useCanvasStore.getState()
        if (state.nodes.some((node) => node.id === createdNodeId)) state.deleteNodes([createdNodeId])
      }
    } finally {
      lockRef.current = false
      setSubmitting(false)
    }
  }, [addTask, data.name, data.projectUuid, id, mediaType, shellWidth, sourceDurationSec, sourceFps, sourceHeight, sourceName, sourceUrl, sourceWidth, startPolling, submitting])

  const modal = useMemo(() => {
    if (!open) return null
    return (
      <MediaEnhanceModal
        mediaType={mediaType}
        url={sourceUrl}
        name={sourceName || data.name}
        widthHint={sourceWidth}
        heightHint={sourceHeight}
        fpsHint={sourceFps}
        durationHintSec={sourceDurationSec}
        busy={submitting}
        error={error}
        onCancel={closeModal}
        onConfirm={submit}
      />
    )
  }, [closeModal, data.name, error, mediaType, open, sourceDurationSec, sourceFps, sourceHeight, sourceName, sourceUrl, sourceWidth, submit, submitting])

  return {
    openModal,
    submitting,
    modal,
  }
}
