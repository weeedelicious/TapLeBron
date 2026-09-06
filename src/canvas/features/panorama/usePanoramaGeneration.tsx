import { useCallback, useMemo, useRef, useState } from 'react'
import { addEdge } from '@xyflow/react'
import { PanoramaGenerationModal } from './PanoramaGenerationModal'
import { PanoramaViewerModal } from './PanoramaViewerModal'
import { isPanoramaNodeData } from './panorama'
import { panoramaModeLabel, type PanoramaGenerationSettings } from './panorama-generation'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { toolboxApi } from '@/lib/api'
import { defaultImageParams } from '@/lib/nodeData'
import { errorToText } from '@/lib/display'
import type { CanvasNodeData, ImageParams } from '@/lib/types'

interface UsePanoramaGenerationOptions {
  id: string
  data: CanvasNodeData & { projectUuid: string }
  sourceUrl: string
  sourceName?: string
  shellWidth: number
}

function stripExtension(name: string) {
  return String(name || 'image').replace(/\.[a-z0-9]+$/i, '') || 'image'
}

export function usePanoramaGeneration({
  id,
  data,
  sourceUrl,
  sourceName,
  shellWidth,
}: UsePanoramaGenerationOptions) {
  const { addNodeAt, edges, nodes, setEdges, updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const [submitting, setSubmitting] = useState(false)
  const submissionLockRef = useRef(false)
  const [activeResultNodeId, setActiveResultNodeId] = useState<string | null>(null)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const panorama = isPanoramaNodeData(data)
  const activeResultNode = activeResultNodeId
    ? nodes.find((node) => node.id === activeResultNodeId || node.data.nodeKey === activeResultNodeId)
    : undefined
  const busy = submitting || Boolean(activeResultNode?.data.taskInfo?.loading)

  const openGenerator = useCallback(() => {
    if (!sourceUrl || panorama || busy) return
    setGeneratorOpen(true)
  }, [busy, panorama, sourceUrl])

  const generate = useCallback(async (generation: PanoramaGenerationSettings) => {
    if (!sourceUrl || panorama || busy || submissionLockRef.current) return
    submissionLockRef.current = true
    setSubmitting(true)
    const sourceNode = nodes.find((node) => node.id === id || node.data.nodeKey === id)
    const outgoingCount = edges.filter((edge) => edge.source === id).length
    const createdAtMs = Date.now()
    const sourceRef = { nodeId: id, url: sourceUrl, mediaType: 'image' as const }
    const baseParams = defaultImageParams()
    const modeLabel = panoramaModeLabel(generation.model, generation.generationMode)
    const resultName = `HDR全景_${stripExtension(sourceName || data.name)}`
    const resultParams: ImageParams = {
      ...baseParams,
      prompt: generation.description,
      model: generation.model,
      count: 1,
      modeType: 'image2image',
      settings: {
        ...baseParams.settings,
        quality: 'high',
        ratio: '2:1',
        resolution: generation.resolution,
      },
      imageList: [sourceRef],
      imageListOrder: [id],
      videoList: [],
      audioList: [],
      textList: [],
      advancedSettings: {
        ...(baseParams.advancedSettings ?? {}),
        panorama: {
          version: 2,
          kind: 'panorama-360x180',
          projection: 'equirectangular',
          sourceNodeId: id,
          sourceUrl,
          sourceName: sourceName || data.name || 'image',
          engine: generation.model,
          model: generation.model,
          resolution: generation.resolution,
          generationMode: generation.generationMode,
          generationModeLabel: modeLabel,
          description: generation.description,
          providerCalls: 1,
          createdAtMs,
        },
      },
    }
    const resultNode = addNodeAt(
      'image',
      (sourceNode?.position.x ?? 0) + shellWidth + 140,
      (sourceNode?.position.y ?? 0) + outgoingCount * 44,
      {
        name: resultName,
        url: [],
        action: 'image_generate',
        sourceKind: 'derived',
        generatorType: 'panorama-360x180',
        params: resultParams as unknown as Record<string, unknown>,
        taskInfo: {
          taskId: '',
          loading: true,
          status: 1,
          progressPercent: 0,
          model: generation.model,
          taskKind: 'image',
        },
      },
    )

    setActiveResultNodeId(resultNode.id)

    const viewerNode = addNodeAt(
      'panorama_viewer',
      (sourceNode?.position.x ?? 0) + shellWidth + 140 + 760,
      (sourceNode?.position.y ?? 0) + outgoingCount * 44,
      {
        name: `360°查看_${stripExtension(sourceName || data.name)}`,
        url: [],
        action: 'panorama_viewer',
        params: {
          panoramaRef: {
            nodeId: resultNode.id,
            name: resultName,
          },
        },
      },
      { recordHistory: false },
    )

    const edgeId = `e-${id}-${resultNode.id}`
    const sourceEdge = edges.some((edge) => edge.id === edgeId)
      ? edges
      : addEdge({
          id: edgeId,
          source: id,
          target: resultNode.id,
          type: 'glow',
          selectable: true,
          interactionWidth: 34,
        }, edges)
    const viewerEdgeId = `e-${resultNode.id}-${viewerNode.id}-panorama`
    const nextEdges = addEdge({
      id: viewerEdgeId,
      source: resultNode.id,
      target: viewerNode.id,
      targetHandle: 'panorama',
      type: 'glow',
      selectable: true,
      interactionWidth: 34,
    }, sourceEdge)
    setEdges(nextEdges)

    try {
      const response = await toolboxApi.panorama(data.projectUuid, resultNode.id, sourceUrl, {
        model: generation.model,
        resolution: generation.resolution,
        generationMode: generation.generationMode,
        description: generation.description,
        sourceName: sourceName || data.name || '',
      })
      addTask(response.jobId, resultNode.id, response.generationVersion)
      startPolling(response.jobId, data.projectUuid)
      setGeneratorOpen(false)
    } catch (error) {
      const responseError = error as { response?: { data?: { error?: unknown } }; message?: string }
      updateNodeData(resultNode.id, {
        taskInfo: {
          taskId: '',
          loading: false,
          status: 3,
          progressPercent: 0,
          model: generation.model,
          taskKind: 'image',
          error: errorToText(responseError.response?.data?.error ?? responseError.message, '360°×180°全景生成提交失败'),
        },
      })
      setGeneratorOpen(false)
    } finally {
      submissionLockRef.current = false
      setSubmitting(false)
    }
  }, [addNodeAt, addTask, busy, data.name, data.projectUuid, edges, id, nodes, panorama, setEdges, shellWidth, sourceName, sourceUrl, startPolling, updateNodeData])

  const openViewer = useCallback(() => {
    if (!panorama || !sourceUrl) return
    setViewerOpen(true)
  }, [panorama, sourceUrl])

  const modal = useMemo(() => (
    <>
      {generatorOpen && !panorama && sourceUrl && (
        <PanoramaGenerationModal
          sourceName={sourceName || data.name}
          busy={submitting}
          onCancel={() => setGeneratorOpen(false)}
          onConfirm={generate}
        />
      )}
      {viewerOpen && panorama && sourceUrl && (
        <PanoramaViewerModal
          url={sourceUrl}
          name={sourceName || data.name || 'HDR全景'}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  ), [data.name, generate, generatorOpen, panorama, sourceName, sourceUrl, submitting, viewerOpen])

  return {
    generate,
    openGenerator,
    openViewer,
    isPanorama: panorama,
    submitting: busy,
    modal,
    viewer: modal,
  }
}
