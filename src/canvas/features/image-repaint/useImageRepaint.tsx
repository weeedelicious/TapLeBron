import { useCallback, useMemo, useState } from 'react'
import { addEdge } from '@xyflow/react'
import { ImageRepaintModal, type ImageRepaintAcceptPayload } from './ImageRepaintModal'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { assetsApi, generateApi } from '@/lib/api'
import { defaultImageParams } from '@/lib/nodeData'
import { errorToText } from '@/lib/display'
import type { CanvasNodeData, ImageParams } from '@/lib/types'
import { loadAssetFileFromUrl } from '@/lib/whiteboard'

interface UseImageRepaintOptions {
  id: string
  data: CanvasNodeData & { projectUuid: string }
  sourceUrl: string
  sourceName?: string
  shellWidth: number
  initialModel?: string
}

export function useImageRepaint({
  id,
  data,
  sourceUrl,
  sourceName,
  shellWidth,
  initialModel,
}: UseImageRepaintOptions) {
  const { addNodeAt, edges, nodes, setEdges, updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const [open, setOpen] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)

  const openEditor = useCallback(async () => {
    if (!sourceUrl || preparing || submitting) return
    setError(null)
    setSourceFile(null)
    setOpen(true)
    setPreparing(true)
    try {
      const file = await loadAssetFileFromUrl(sourceUrl, sourceName || data.name || 'image')
      setSourceFile(file)
    } catch (loadError) {
      setError(errorToText(loadError, '局部重绘原图加载失败'))
    } finally {
      setPreparing(false)
    }
  }, [data.name, preparing, sourceName, sourceUrl, submitting])

  const closeEditor = useCallback(() => {
    if (submitting) return
    setOpen(false)
    setSourceFile(null)
    setError(null)
  }, [submitting])

  const handleAccept = useCallback(async (payload: ImageRepaintAcceptPayload) => {
    if (!sourceUrl || submitting) return
    setError(null)
    setSubmitting(true)
    let createdNodeId: string | null = null
    try {
      const uploadedMask = await assetsApi.upload(data.projectUuid, payload.file)
      const sourceNode = nodes.find((node) => node.id === id)
      const sourceRef = { nodeId: id, url: sourceUrl, mediaType: 'image' as const }
      const createdAtMs = Date.now()
      const outgoingCount = edges.filter((edge) => edge.source === id).length
      const baseParams = defaultImageParams()
      const repaintParams: ImageParams = {
        ...baseParams,
        prompt: payload.prompt,
        model: payload.model,
        count: 1,
        modeType: 'image2image',
        settings: {
          ...baseParams.settings,
          quality: 'high',
          ratio: payload.ratio,
          resolution: payload.resolution,
        },
        imageList: [sourceRef],
        imageListOrder: [id],
        videoList: [],
        audioList: [],
        textList: [],
        advancedSettings: {
          ...(baseParams.advancedSettings ?? {}),
          repaint: {
            version: 1,
            contract: 'hard-mask-v0.0.1',
            sourceNodeId: id,
            sourceUrl,
            sourceName: sourceName || data.name || 'image',
            maskUrl: uploadedMask.url,
            maskWidth: payload.width,
            maskHeight: payload.height,
            maskCoverage: payload.maskCoverage,
            commandCount: payload.commandCount,
            brushSize: payload.brushSize,
            ratio: payload.ratio,
            resolution: payload.resolution,
            providerBehavior: payload.model === 'gpt-image-2'
              ? 'native-mask-edit'
              : 'gemini-hard-composite',
            createdAtMs,
          },
        },
      }

      const createdNode = addNodeAt(
        'image',
        (sourceNode?.position.x ?? 0) + shellWidth + 140,
        (sourceNode?.position.y ?? 0) + outgoingCount * 44,
        {
          name: `局部重绘_${String(createdAtMs).slice(-4)}`,
          url: [],
          action: 'image_generate',
          sourceKind: 'derived',
          params: repaintParams as unknown as Record<string, unknown>,
          taskInfo: {
            taskId: '',
            loading: true,
            status: 1,
            progressPercent: 0,
            taskKind: 'image',
            model: payload.model,
            quantity: 1,
            startedAtMs: createdAtMs,
          },
        },
      )
      createdNodeId = createdNode.id

      const edgeId = `e-${id}-${createdNode.id}`
      if (!edges.some((edge) => edge.id === edgeId)) {
        setEdges(addEdge({
          id: edgeId,
          source: id,
          target: createdNode.id,
          type: 'glow',
          selectable: true,
          interactionWidth: 34,
        }, edges))
      }

      const response = await generateApi.image(
        data.projectUuid,
        createdNode.id,
        repaintParams as unknown as Record<string, unknown>,
      )
      addTask(response.jobId, createdNode.id, response.generationVersion)
      startPolling(response.jobId, data.projectUuid)
      setOpen(false)
      setSourceFile(null)
    } catch (submitError) {
      const message = errorToText(submitError, '局部重绘提交失败')
      setError(message)
      if (createdNodeId) {
        updateNodeData(createdNodeId, {
          taskInfo: {
            taskId: '',
            loading: false,
            status: 3,
            progressPercent: 0,
            taskKind: 'image',
            error: message,
          },
        })
      }
      throw submitError
    } finally {
      setSubmitting(false)
    }
  }, [
    addNodeAt,
    addTask,
    data.name,
    data.projectUuid,
    edges,
    id,
    nodes,
    setEdges,
    shellWidth,
    sourceName,
    sourceUrl,
    startPolling,
    submitting,
    updateNodeData,
  ])

  const modal = useMemo(() => {
    if (!open) return null
    return (
      <ImageRepaintModal
        sourceFile={sourceFile}
        sourceName={sourceName || data.name}
        initialModel={initialModel}
        busy={submitting}
        loadingSource={preparing}
        error={error}
        onCancel={closeEditor}
        onAccept={handleAccept}
      />
    )
  }, [closeEditor, data.name, error, handleAccept, initialModel, open, preparing, sourceFile, sourceName, submitting])

  return {
    openEditor,
    preparing,
    submitting,
    error,
    modal,
  }
}
