import { useCallback, useMemo, useState } from 'react'
import { addEdge } from '@xyflow/react'
import { SubjectMattingModal, type SubjectMattingAcceptPayload } from './SubjectMattingModal'
import { useCanvasStore } from '@/store/canvasStore'
import { assetsApi, subjectMattingApi, type SubjectMattingAutomaticMask } from '@/lib/api'
import { defaultImageParams } from '@/lib/nodeData'
import { errorToText } from '@/lib/display'
import type { CanvasNodeData, ImageParams } from '@/lib/types'
import { loadAssetFileFromUrl, resourceMetaFromUploadPayload } from '@/lib/whiteboard'

interface UseSubjectMattingOptions {
  id: string
  data: CanvasNodeData & { projectUuid: string }
  sourceUrl: string
  sourceName?: string
  shellWidth: number
}

function stripExtension(name: string) {
  return String(name || 'image').replace(/\.[a-z0-9]+$/i, '') || 'image'
}

export function useSubjectMatting({
  id,
  data,
  sourceUrl,
  sourceName,
  shellWidth,
}: UseSubjectMattingOptions) {
  const { addNodeAt, edges, nodes, setEdges } = useCanvasStore()
  const [open, setOpen] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [automaticMask, setAutomaticMask] = useState<SubjectMattingAutomaticMask | null>(null)
  const [automaticMaskLoading, setAutomaticMaskLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openEditor = useCallback(async () => {
    if (!sourceUrl || preparing || submitting) return
    setError(null)
    setSourceFile(null)
    setAutomaticMask(null)
    setOpen(true)
    setPreparing(true)
    try {
      const file = await loadAssetFileFromUrl(sourceUrl, sourceName || data.name || 'image')
      setSourceFile(file)
      setAutomaticMaskLoading(true)
      subjectMattingApi.prepareAutomaticMask(data.projectUuid, id, sourceUrl)
        .then((mask) => {
          setAutomaticMask(mask)
          if (mask.warning) setError(mask.warning)
        })
        .catch((maskError) => {
          setAutomaticMask({
            provider: 'browser-local',
            modelId: 'local-browser-fallback',
            modelRevision: null,
            status: 'fallback',
            width: 0,
            height: 0,
            maskCoverage: null,
            maskDataUrl: '',
            warning: errorToText(maskError, 'BiRefNet 自动识别失败，已使用本地预选'),
          })
        })
        .finally(() => setAutomaticMaskLoading(false))
    } catch (loadError) {
      setError(errorToText(loadError, '抠像原图加载失败'))
    } finally {
      setPreparing(false)
    }
  }, [data.name, data.projectUuid, id, preparing, sourceName, sourceUrl, submitting])

  const closeEditor = useCallback(() => {
    if (submitting) return
    setOpen(false)
    setSourceFile(null)
    setAutomaticMask(null)
    setAutomaticMaskLoading(false)
    setError(null)
  }, [submitting])

  const handleAccept = useCallback(async (payload: SubjectMattingAcceptPayload) => {
    if (!sourceUrl || submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const uploaded = await assetsApi.upload(data.projectUuid, payload.file)
      const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
      const sourceNode = nodes.find((node) => node.id === id)
      const sourceRef = { nodeId: id, url: sourceUrl, mediaType: 'image' as const }
      const createdAtMs = Date.now()
      const outgoingCount = edges.filter((edge) => edge.source === id).length
      const reverseOutput = payload.settings.reverseOutput === true
      const baseParams = defaultImageParams()
      const resultParams: ImageParams = {
        ...baseParams,
        prompt: '',
        model: 'subject-matting',
        count: 1,
        modeType: 'image2image',
        settings: {
          ...baseParams.settings,
          ratio: 'original',
          resolution: `${payload.width}x${payload.height}`,
        },
        imageList: [sourceRef],
        imageListOrder: [id],
        videoList: [],
        audioList: [],
        textList: [],
        advancedSettings: {
          ...(baseParams.advancedSettings ?? {}),
          derivation: {
            kind: 'subject-matting',
            sourceNodeId: id,
            sourceUrl,
            sourceName: sourceName || data.name || 'image',
            width: payload.width,
            height: payload.height,
            maskCoverage: payload.maskCoverage,
            settings: payload.settings,
            createdAtMs,
          },
        },
      }
      const createdNode = addNodeAt(
        'image',
        (sourceNode?.position.x ?? 0) + shellWidth + 140,
        (sourceNode?.position.y ?? 0) + outgoingCount * 44,
        {
          name: `${stripExtension(sourceName || data.name)} ${reverseOutput ? '反选抠像' : '主体抠像'}`,
          url: [uploaded.url],
          action: 'image_resource',
          sourceKind: 'derived',
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          _assetCreatedAtMs: { [uploaded.url]: createdAtMs },
          _assetGenerationMeta: {
            [uploaded.url]: {
              model: '快速抠图',
              resolution: `${payload.width}×${payload.height}`,
              createdAtMs,
              outputIndex: 0,
            },
          },
          params: resultParams as unknown as Record<string, unknown>,
        },
      )

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

      setOpen(false)
      setSourceFile(null)
    } catch (submitError) {
      const message = errorToText(submitError, '抠像节点生成失败')
      setError(message)
      throw submitError
    } finally {
      setSubmitting(false)
    }
  }, [addNodeAt, data.name, data.projectUuid, edges, id, nodes, setEdges, shellWidth, sourceName, sourceUrl, submitting])

  const modal = useMemo(() => {
    if (!open) return null
    return (
      <SubjectMattingModal
        projectUuid={data.projectUuid}
        nodeKey={id}
        sourceUrl={sourceUrl}
        sourceFile={sourceFile}
        sourceName={sourceName || data.name}
        busy={submitting}
        loadingSource={preparing}
        automaticMask={automaticMask}
        automaticMaskLoading={automaticMaskLoading}
        error={error}
        onCancel={closeEditor}
        onAccept={handleAccept}
      />
    )
  }, [automaticMask, automaticMaskLoading, closeEditor, data.name, error, handleAccept, open, preparing, sourceFile, sourceName, submitting])

  return {
    openEditor,
    preparing,
    submitting,
    error,
    modal,
  }
}
