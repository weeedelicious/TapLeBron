import { useCallback, useRef, useState, useEffect } from 'react'
import { addEdge } from '@xyflow/react'
import { Crop as CropIcon, Download, Expand, Globe2, Grid3X3, Lightbulb, Loader2, Paintbrush, Palette, ScanLine, Sparkles, SquarePen, Wand2 } from 'lucide-react'
import { MediaNodeToolbar, type MediaNodeToolbarAction } from '@/components/MediaNodeToolbar'
import { LightStageModal, type LightStageAcceptPayload } from '@/features/light-stage/LightStageModal'
import { LIGHT_STAGE_MODEL, readLightStageState } from '@/features/light-stage/types'
import { useImageRepaint } from '@/features/image-repaint/useImageRepaint'
import { usePanoramaGeneration } from '@/features/panorama/usePanoramaGeneration'
import { useSubjectMatting } from '@/features/subject-matting/useSubjectMatting'
import { useMediaEnhance } from '@/features/media-enhance/useMediaEnhance'
import { TextureClarityEditor } from '@/features/texture-clarity/TextureClarityEditor'
import { startTextureClarityRepair } from '@/features/texture-clarity/textureClarityJob'
import { ImageGridConfirmModal } from '@/components/ImageGridConfirmModal'
import { ImageCropModal, type ImageCropAcceptPayload } from '@/components/ImageCropModal'
import { WhiteboardModal } from '@/components/WhiteboardModal'
import { NodeShell } from './NodeShell'
import { NodeTypeIcon } from './nodeTypeIcon'
import { ImagePreview } from '@/components/ImagePreview'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { assetsApi, generateApi } from '@/lib/api'
import { errorToText } from '@/lib/display'
import { defaultImageParams, defaultVideoParams } from '@/lib/nodeData'
import { normalizeImageRatioValue, normalizeImageResolutionValue } from '@/lib/imageRules'
import { inferMultiCameraGridRatio, makeMultiCameraGridParams } from '@/lib/multiCameraGrid'
import type { CanvasNodeData, ImageParams, ResourceMeta } from '@/lib/types'
import { mergeAssetCreatedAtMap } from '@/lib/assetTimestamps'
import { mediaPreviewUrl } from '@/lib/mediaPreview'
import {
  captureVideoFrameFile,
  dataUrlToFile,
  loadAssetFileFromUrl,
  readWhiteboardState,
  resourceMetaFromUploadPayload,
} from '@/lib/whiteboard'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

const TOOLBAR_RIGHT = [
  { key: 'edit',       icon: '✏', title: '编辑' },
  { key: 'link',       icon: '⬡', title: '引用' },
  { key: 'download',   icon: '↓', title: '下载' },
  { key: 'fullscreen', icon: '⤢', title: '全屏' },
]

const isImage = (url: string) => /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(url)
const isVideo = (url: string) => /\.(mp4|webm|mov)$/i.test(url)
const isAudio = (url: string) => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(url)

function stripFileExtension(name: string) {
  return String(name || '').replace(/\.[a-z0-9]+$/i, '') || '上传资源'
}

function fitFrameToAspect(w: number, h: number, maxWidth: number, maxHeight: number, minWidth: number) {
  const safeW = Math.max(1, w)
  const safeH = Math.max(1, h)
  let width = maxWidth
  let height = width * (safeH / safeW)
  if (height > maxHeight) {
    height = maxHeight
    width = height * (safeW / safeH)
  }
  if (width < minWidth) {
    width = minWidth
    height = width * (safeH / safeW)
    if (height > maxHeight) {
      height = maxHeight
      width = height * (safeW / safeH)
    }
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
  }
}

export function UploadNode({ id, data, selected }: Props) {
  const {
    addNodeAt,
    edges,
    nodes,
    pushHistory,
    selectedNodeKeys,
    activePanelNodeId,
    setEdges,
    updateNodeData,
  } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const nodeRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null)
  const [showToolbar, setShowToolbar] = useState(false)
  const [whiteboardOpen, setWhiteboardOpen] = useState(false)
  const [whiteboardSourceFile, setWhiteboardSourceFile] = useState<File | null>(null)
  const [whiteboardPreparing, setWhiteboardPreparing] = useState(false)
  const [whiteboardError, setWhiteboardError] = useState<string | null>(null)
  const [cropOpen, setCropOpen] = useState(false)
  const [cropSourceFile, setCropSourceFile] = useState<File | null>(null)
  const [cropPreparing, setCropPreparing] = useState(false)
  const [lightingOpen, setLightingOpen] = useState(false)
  const [lightingAnchorRect, setLightingAnchorRect] = useState<DOMRect | null>(null)
  const [lightingApplying, setLightingApplying] = useState(false)
  const [gridOpen, setGridOpen] = useState(false)
  const [textureClarityOpen, setTextureClarityOpen] = useState(false)
  const [gridSubmitting, setGridSubmitting] = useState(false)
  const isSoleSelected = selectedNodeKeys.length === 1 && selectedNodeKeys[0] === id
  const isPanelActive = activePanelNodeId === id && isSoleSelected

  const urls = data.url ?? []
  const thumbUrls = ((data.params as Record<string, unknown>)?.thumbUrls ?? []) as string[]
  const uploadParams = (data.params as Record<string, unknown> | undefined) ?? {}
  const uploadAdvancedSettings = (
    uploadParams.advancedSettings && typeof uploadParams.advancedSettings === 'object'
      ? uploadParams.advancedSettings
      : {}
  ) as Record<string, unknown>
  const whiteboardState = readWhiteboardState(uploadParams)
  const mainUrl = urls[0] ?? ''
  // Use thumbnail for display (smaller file), fallback to original
  const mainDisplayUrl = mediaPreviewUrl(data, mainUrl, 0)
  const hasContent = urls.length > 0
  const hasImage = hasContent && isImage(mainUrl)
  const hasVideo = hasContent && isVideo(mainUrl)
  const headerIconType = hasImage ? 'image' : isVideo(mainUrl) ? 'video' : isAudio(mainUrl) ? 'audio' : 'upload'
  const previewAspectW = hasImage ? (imgSize?.w ?? 4) : hasVideo ? (videoSize?.w ?? 16) : 4
  const previewAspectH = hasImage ? (imgSize?.h ?? 3) : hasVideo ? (videoSize?.h ?? 9) : 3
  const previewFrame = fitFrameToAspect(previewAspectW, previewAspectH, 520, 400, 220)
  const shellWidth = hasImage || hasVideo ? previewFrame.width : 240
  const resourceItems = (data._resourceMeta?.items ?? []) as ResourceMeta[]
  const mainResourceMeta = resourceItems.find((item) => (
    item?.originalUrl === mainUrl || item?.displayUrl === mainUrl
  )) ?? resourceItems.find((item) => item?.kind === (hasVideo ? 'video' : 'image'))
  const mediaEnhance = useMediaEnhance({
    id,
    data,
    sourceUrl: hasImage || hasVideo ? mainUrl : '',
    sourceName: data.name,
    mediaType: hasVideo ? 'video' : 'image',
    shellWidth,
    sourceWidth: Number(mainResourceMeta?.width || mainResourceMeta?.displayWidth || (hasVideo ? videoSize?.w : imgSize?.w) || 0) || undefined,
    sourceHeight: Number(mainResourceMeta?.height || mainResourceMeta?.displayHeight || (hasVideo ? videoSize?.h : imgSize?.h) || 0) || undefined,
    sourceFps: Number(mainResourceMeta?.fps || 0) || undefined,
    sourceDurationSec: Number(mainResourceMeta?.durationSec || mainResourceMeta?.displayDurationSec || 0) || undefined,
  })
  const panorama = usePanoramaGeneration({
    id,
    data,
    sourceUrl: hasImage ? mainUrl : '',
    sourceName: data.name,
    shellWidth,
  })
  const repaint = useImageRepaint({
    id,
    data,
    sourceUrl: hasImage ? mainUrl : '',
    sourceName: data.name,
    shellWidth,
    initialModel: String((data.params as Record<string, unknown> | undefined)?.model || ''),
  })
  const subjectMatting = useSubjectMatting({
    id,
    data,
    sourceUrl: hasImage ? mainUrl : '',
    sourceName: data.name,
    shellWidth,
  })
  // 色彩与灯光氛围迁移: create the processor node wired to this image as 原图; the
  // 参考图 is supplied by connecting an image into its 参考图 handle (no picker).
  const createAtmosphereNode = useCallback(() => {
    if (!hasImage || !mainUrl) return
    const selfNode = nodes.find(n => n.id === id)
    const outgoing = edges.filter(e => e.source === id).length
    const created = addNodeAt(
      'atmosphere_transfer',
      (selfNode?.position.x ?? 0) + shellWidth + 140,
      (selfNode?.position.y ?? 0) + outgoing * 44,
      {
        name: `${data.name || 'image'} 氛围迁移`,
        params: {
          sourceRef: { nodeId: id, url: mainUrl, name: String(data.name || '原图') },
          referenceRef: null,
        } as unknown as Record<string, unknown>,
      },
    )
    const edgeId = `e-${id}-${created.id}-source`
    if (!edges.some(e => e.id === edgeId)) {
      setEdges(addEdge({ id: edgeId, source: id, target: created.id, targetHandle: 'source', type: 'glow', selectable: true, interactionWidth: 34 }, edges))
    }
  }, [id, hasImage, mainUrl, data.name, shellWidth, nodes, edges, addNodeAt, setEdges])

  // Hide toolbar when clicking outside the node
  useEffect(() => {
    if (!showToolbar) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-media-node-toolbar="true"]')) return
      if (!nodeRef.current?.contains(target)) {
        setShowToolbar(false)
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [showToolbar])

  // Also hide when node gets deselected
  useEffect(() => {
    if (!isPanelActive) setShowToolbar(false)
  }, [isPanelActive])

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    const uploaded: Array<{
      file: File
      url: string
      thumbUrl?: string
      kind: ResourceMeta['kind']
      meta?: ResourceMeta
    }> = []
    for (const file of Array.from(files)) {
      try {
        const res = await assetsApi.upload(data.projectUuid, file)
        const kind: ResourceMeta['kind'] = file.type.startsWith('video/')
          ? 'video'
          : file.type.startsWith('audio/')
            ? 'audio'
            : 'image'
        uploaded.push({
          file,
          url: res.url,
          thumbUrl: res.thumbUrl,
          kind,
          meta: resourceMetaFromUploadPayload(res.meta as Record<string, unknown> | undefined, kind),
        })
      } catch (e) { console.error(e) }
    }

    if (!uploaded.length) return

    const createExtraNode = (item: typeof uploaded[number], index: number) => {
      const sourceNode = nodes.find((node) => node.id === id)
      const nodeType = item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'audio' : 'upload'
      const extraData: Partial<CanvasNodeData> = {
        url: [item.url],
        action: 'image_resource',
        name: stripFileExtension(item.file.name),
        _assetCreatedAtMs: mergeAssetCreatedAtMap(undefined, [
          item.url,
          item.thumbUrl,
          item.meta?.displayUrl,
          item.meta?.originalUrl,
        ], item.meta?.createdAtMs ?? Date.now()),
        _updatedAtMs: item.meta?.createdAtMs ?? Date.now(),
        ...(item.meta ? { _resourceMeta: { items: [item.meta] } } : {}),
      }
      if (item.kind === 'video') {
        extraData.params = defaultVideoParams() as unknown as Record<string, unknown>
      } else if (item.kind === 'image') {
        extraData.params = {
          thumbUrls: [item.thumbUrl ?? item.url],
        } as unknown as Record<string, unknown>
      }
      addNodeAt(
        nodeType,
        (sourceNode?.position.x ?? 0) + (index + 1) * 34,
        (sourceNode?.position.y ?? 0) + (index + 1) * 34,
        extraData
      )
    }

    const [first, ...rest] = uploaded
    if (!hasContent && first.kind === 'video') {
      updateNodeData(id, {
        type: 'video',
        name: stripFileExtension(first.file.name),
        url: [first.url],
        action: 'image_resource',
        params: defaultVideoParams() as unknown as Record<string, unknown>,
        _assetCreatedAtMs: mergeAssetCreatedAtMap(data._assetCreatedAtMs, [
          first.url,
          first.thumbUrl,
          first.meta?.displayUrl,
          first.meta?.originalUrl,
        ], first.meta?.createdAtMs ?? Date.now()),
        _updatedAtMs: first.meta?.createdAtMs ?? Date.now(),
        ...(first.meta ? { _resourceMeta: { items: [first.meta] } } : {}),
      })
      rest.forEach(createExtraNode)
      return
    }

    for (const item of uploaded.filter((entry) => entry.kind === 'video')) {
      createExtraNode(item, uploaded.indexOf(item))
    }

    const nonVideoUploads = uploaded.filter((entry) => entry.kind !== 'video')
    if (!nonVideoUploads.length) return

    const uploadedUrls = nonVideoUploads.map((item) => item.url)
    const thumbs = nonVideoUploads.map((item) => item.thumbUrl ?? item.url)
    const existingThumbs = ((data.params as Record<string, unknown>)?.thumbUrls ?? []) as string[]
    const nextAssetCreatedAtMs = nonVideoUploads.reduce(
      (map, item) => mergeAssetCreatedAtMap(map, [
        item.url,
        item.thumbUrl,
        item.meta?.displayUrl,
        item.meta?.originalUrl,
      ], item.meta?.createdAtMs ?? Date.now()),
      data._assetCreatedAtMs
    )
    updateNodeData(id, {
      url: [...urls, ...uploadedUrls],
      params: { ...(data.params as Record<string, unknown>), thumbUrls: [...existingThumbs, ...thumbs] },
      _assetCreatedAtMs: nextAssetCreatedAtMs,
      _updatedAtMs: Date.now(),
    })
  }, [addNodeAt, data._assetCreatedAtMs, data.params, data.projectUuid, hasContent, id, nodes, updateNodeData, urls])

  const handleDownload = useCallback((url: string) => {
    const a = document.createElement('a')
    a.href = url
    a.download = data.name || url.split('/').pop() || 'file'
    a.click()
  }, [data.name])

  const openWhiteboard = useCallback(async () => {
    if (!mainUrl || whiteboardPreparing) return
    setWhiteboardError(null)
    setWhiteboardSourceFile(null)
    setWhiteboardOpen(true)
    setWhiteboardPreparing(true)
    try {
      const file = hasVideo
        ? await captureVideoFrameFile(videoRef.current as HTMLVideoElement, data.name || 'video')
        : await loadAssetFileFromUrl(mainUrl, data.name || 'image')
      setWhiteboardSourceFile(file)
    } catch (error) {
      setWhiteboardError(error instanceof Error ? error.message : '白板资源加载失败')
    } finally {
      setWhiteboardPreparing(false)
    }
  }, [data.name, hasVideo, mainUrl, whiteboardPreparing])

  const openCrop = useCallback(() => {
    if (!hasImage || !mainUrl || cropPreparing) return
    setWhiteboardError(null)
    setCropSourceFile(null)
    setCropOpen(true)
  }, [cropPreparing, hasImage, mainUrl])

  const handleCropAccept = useCallback(async ({
    file,
    width,
    height,
    crop,
    aspect,
    rotation,
    flipHorizontal,
    flipVertical,
    outputScale,
  }: ImageCropAcceptPayload) => {
    const uploaded = await assetsApi.upload(data.projectUuid, file)
    const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
    const sourceNode = nodes.find((node) => node.id === id)
    const sourceRef = { nodeId: id, url: mainUrl, mediaType: 'image' as const }
    const createdAtMs = Date.now()
    const outgoingCount = edges.filter((edge) => edge.source === id).length
    const createdNode = addNodeAt(
      'upload',
      (sourceNode?.position.x ?? 0) + shellWidth + 140,
      (sourceNode?.position.y ?? 0) + outgoingCount * 44,
      {
        name: `${data.name || 'image'} 裁剪`,
        url: [uploaded.url],
        action: 'image_resource',
        sourceKind: 'derived',
        ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
        _assetCreatedAtMs: { [uploaded.url]: createdAtMs },
        _assetGenerationMeta: {
          [uploaded.url]: {
            model: '图片裁剪',
            resolution: `${width}×${height}`,
            createdAtMs,
            outputIndex: 0,
          },
        },
        params: {
          ...defaultImageParams(),
          imageList: [sourceRef],
          imageListOrder: [id],
          advancedSettings: {
            derivation: {
              kind: 'crop',
              sourceNodeId: id,
              sourceUrl: mainUrl,
              crop,
              aspect,
              rotation,
              flipHorizontal,
              flipVertical,
              outputScale,
              width,
              height,
              createdAtMs,
            },
          },
        } as unknown as Record<string, unknown>,
      },
    )

    const edgeId = `e-${id}-${createdNode.id}`
    setEdges(addEdge({
      id: edgeId,
      source: id,
      target: createdNode.id,
      type: 'glow',
      selectable: true,
      interactionWidth: 34,
    }, edges))

    setCropOpen(false)
    setCropSourceFile(null)
  }, [addNodeAt, data.name, data.projectUuid, edges, id, mainUrl, nodes, setEdges, shellWidth])

  const handleWhiteboardAccept = useCallback(async ({ dataUrl, snapshot }: { dataUrl: string; snapshot: unknown }) => {
    const file = await dataUrlToFile(dataUrl, data.name || (hasVideo ? 'video' : 'image'))
    const uploaded = await assetsApi.upload(data.projectUuid, file)
    const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
    const updatedAtMs = Date.now()

    if (hasVideo) {
      const sourceNode = nodes.find((node) => node.id === id)
      const resultNodeId = whiteboardState?.resultNodeId
      const existingResultNode = resultNodeId ? nodes.find((node) => node.id === resultNodeId) : undefined
      const sourceRef = { nodeId: id, url: mainUrl, mediaType: 'video' as const }
      let resolvedResultNodeId = existingResultNode?.id

      if (existingResultNode) {
        pushHistory()
        const resultParams = ((existingResultNode.data.params as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>
        const existingImageList = Array.isArray(resultParams.imageList) ? resultParams.imageList : []
        const existingOrder = Array.isArray(resultParams.imageListOrder) ? resultParams.imageListOrder as string[] : []

        updateNodeData(existingResultNode.id, {
          type: 'upload',
          url: [uploaded.url],
          action: 'image_resource',
          sourceKind: 'derived',
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          params: {
            ...resultParams,
            imageList: existingImageList.some((entry) => (entry as { nodeId?: string }).nodeId === id)
              ? existingImageList
              : [...existingImageList, sourceRef],
            imageListOrder: existingOrder.includes(id) ? existingOrder : [...existingOrder, id],
            whiteboard: {
              ...(readWhiteboardState(resultParams) ?? {}),
              snapshot,
              updatedAtMs,
            },
          },
        })
      } else {
        const createdNode = addNodeAt('upload', (sourceNode?.position.x ?? 0) + shellWidth + 140, sourceNode?.position.y ?? 0, {
          name: `${data.name || '视频'} 标注`,
          url: [uploaded.url],
          action: 'image_resource',
          sourceKind: 'derived',
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          params: {
            ...defaultImageParams(),
            imageList: [sourceRef],
            imageListOrder: [id],
            whiteboard: {
              snapshot,
              updatedAtMs,
            },
          } as unknown as Record<string, unknown>,
        })

        resolvedResultNodeId = createdNode.id
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
      }

      updateNodeData(id, {
        params: {
          ...uploadParams,
          whiteboard: {
            ...(whiteboardState ?? {}),
            snapshot,
            resultNodeId: resolvedResultNodeId,
            updatedAtMs,
          },
        },
      })
    } else {
      const sourceNode = nodes.find((node) => node.id === id)
      const resultNodeId = whiteboardState?.resultNodeId
      const existingResultNode = resultNodeId ? nodes.find((node) => node.id === resultNodeId) : undefined
      const sourceRef = { nodeId: id, url: mainUrl, mediaType: 'image' as const }
      let resolvedResultNodeId = existingResultNode?.id

      if (existingResultNode) {
        pushHistory()
        const resultParams = ((existingResultNode.data.params as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>
        const existingImageList = Array.isArray(resultParams.imageList) ? resultParams.imageList : []
        const existingOrder = Array.isArray(resultParams.imageListOrder) ? resultParams.imageListOrder as string[] : []

        updateNodeData(existingResultNode.id, {
          type: 'upload',
          url: [uploaded.url],
          action: 'image_resource',
          sourceKind: 'derived',
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          params: {
            ...resultParams,
            imageList: existingImageList.some((entry) => (entry as { nodeId?: string }).nodeId === id)
              ? existingImageList
              : [...existingImageList, sourceRef],
            imageListOrder: existingOrder.includes(id) ? existingOrder : [...existingOrder, id],
            whiteboard: {
              ...(readWhiteboardState(resultParams) ?? {}),
              snapshot,
              updatedAtMs,
            },
          },
        })
      } else {
        const createdNode = addNodeAt('upload', (sourceNode?.position.x ?? 0) + shellWidth + 140, sourceNode?.position.y ?? 0, {
          name: `${data.name || 'image'} 标注`,
          url: [uploaded.url],
          action: 'image_resource',
          sourceKind: 'derived',
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          params: {
            ...defaultImageParams(),
            imageList: [sourceRef],
            imageListOrder: [id],
            whiteboard: {
              snapshot,
              updatedAtMs,
            },
          } as unknown as Record<string, unknown>,
        })

        resolvedResultNodeId = createdNode.id
      }

      const edgeId = `e-${id}-${resolvedResultNodeId}`
      if (resolvedResultNodeId && !edges.some((edge) => edge.id === edgeId)) {
        setEdges(addEdge({
          id: edgeId,
          source: id,
          target: resolvedResultNodeId,
          type: 'glow',
          selectable: true,
          interactionWidth: 34,
        }, edges))
      }

      updateNodeData(id, {
        params: {
          ...uploadParams,
          whiteboard: {
            ...(whiteboardState ?? {}),
            snapshot,
            resultNodeId: resolvedResultNodeId,
            updatedAtMs,
          },
        },
      })
    }

    setPreviewUrl(null)
    setWhiteboardOpen(false)
    setWhiteboardSourceFile(null)
  }, [addNodeAt, data.name, data.projectUuid, edges, hasVideo, id, mainUrl, nodes, pushHistory, setEdges, shellWidth, thumbUrls, updateNodeData, uploadParams, urls, whiteboardState])

  const handleLightStageAccept = useCallback(async ({ state, prompt, ratio, resolution, geometryUrls }: LightStageAcceptPayload) => {
    if (!hasImage || !mainUrl || lightingApplying) return
    setWhiteboardError(null)
    setLightingApplying(true)
    let createdNodeId: string | null = null
    try {
      const sourceNode = nodes.find((node) => node.id === id)
      const sourceRef = { nodeId: id, url: mainUrl, mediaType: 'image' as const }
      const requestRatio = normalizeImageRatioValue(LIGHT_STAGE_MODEL, ratio)
      const requestResolution = normalizeImageResolutionValue(LIGHT_STAGE_MODEL, resolution)
      const baseParams = defaultImageParams()
      const lightStageParams: ImageParams = {
        ...baseParams,
        prompt,
        model: LIGHT_STAGE_MODEL,
        count: 1,
        modeType: 'image2image',
        settings: {
          ...baseParams.settings,
          quality: 'high',
          ratio: requestRatio,
          resolution: requestResolution,
        },
        imageList: [sourceRef],
        imageListOrder: [id],
        videoList: [],
        audioList: [],
        textList: [],
        advancedSettings: {
          lightStage: {
            version: 3,
            sourceNodeId: id,
            sourceUrl: mainUrl,
            sourceName: data.name || 'image',
            state,
            prompt,
            ratio: requestRatio,
            resolution: requestResolution,
            geometryUrls,
            createdAtMs: Date.now(),
          },
        },
      }
      const createdNode = addNodeAt('image', (sourceNode?.position.x ?? 0) + shellWidth + 140, sourceNode?.position.y ?? 0, {
        name: `灯光重塑_${String(Date.now()).slice(-4)}`,
        url: [],
        action: 'image_generate',
        params: lightStageParams as unknown as Record<string, unknown>,
        taskInfo: { taskId: '', loading: true, status: 1, progressPercent: 0 },
      })
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

      const res = await generateApi.image(
        data.projectUuid,
        createdNode.id,
        lightStageParams as unknown as Record<string, unknown>
      )
      addTask(res.jobId, createdNode.id, res.generationVersion)
      startPolling(res.jobId, data.projectUuid)
      setLightingOpen(false)
    } catch (error) {
      const axErr = error as { response?: { data?: { error?: unknown } }; message?: string }
      const message = errorToText(axErr.response?.data?.error ?? axErr.message, '灯光重塑提交失败')
      if (createdNodeId) {
        updateNodeData(createdNodeId, {
          taskInfo: { taskId: '', loading: false, status: 3, progressPercent: 0, error: message },
        })
      } else {
        setWhiteboardError(message)
      }
    } finally {
      setLightingApplying(false)
    }
  }, [addNodeAt, addTask, data.name, data.projectUuid, edges, hasImage, id, lightingApplying, mainUrl, nodes, setEdges, shellWidth, startPolling, updateNodeData])

  const handleGridConfirm = useCallback(async ({ ratio, resolution }: { ratio: string; resolution: string }) => {
    if (!hasImage || !mainUrl || gridSubmitting) return
    setWhiteboardError(null)
    setGridSubmitting(true)
    let createdNodeId: string | null = null
    try {
      const sourceNode = nodes.find((node) => node.id === id)
      const sourceRef = { nodeId: id, url: mainUrl, mediaType: 'image' as const }
      const gridParams = makeMultiCameraGridParams(sourceRef, ratio, resolution)
      const createdNode = addNodeAt('image', (sourceNode?.position.x ?? 0) + shellWidth + 140, sourceNode?.position.y ?? 0, {
        name: '九宫格',
        url: [],
        action: 'image_generate',
        params: gridParams as unknown as Record<string, unknown>,
        taskInfo: { taskId: '', loading: true, status: 1, progressPercent: 0 },
      })
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

      const res = await generateApi.image(
        data.projectUuid,
        createdNode.id,
        gridParams as unknown as Record<string, unknown>
      )
      addTask(res.jobId, createdNode.id, res.generationVersion)
      startPolling(res.jobId, data.projectUuid)
      setGridOpen(false)
    } catch (error) {
      const axErr = error as { response?: { data?: { error?: unknown } }; message?: string }
      const message = errorToText(axErr.response?.data?.error ?? axErr.message, '九宫格生成失败')
      if (createdNodeId) {
        updateNodeData(createdNodeId, {
          taskInfo: { taskId: '', loading: false, status: 3, progressPercent: 0, error: message },
        })
      } else {
        setWhiteboardError(message)
      }
    } finally {
      setGridSubmitting(false)
    }
  }, [addNodeAt, addTask, data.projectUuid, edges, gridSubmitting, hasImage, id, mainUrl, nodes, setEdges, shellWidth, startPolling, updateNodeData])

  // 和 ImageNode 一样：动作抽成变量，节点工具栏和大图查看器共用同一份
  const mediaToolbarActions: MediaNodeToolbarAction[] = [
    ...(hasImage ? [{
      key: 'crop',
      label: cropPreparing ? '正在打开裁剪' : '裁剪',
      icon: cropPreparing
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <CropIcon size={14} strokeWidth={1.9} />,
      onClick: openCrop,
      disabled: cropPreparing,
    }] : []),
    {
      key: 'whiteboard',
      label: whiteboardPreparing ? '正在打开白板' : '白板标注',
      icon: whiteboardPreparing
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <SquarePen size={14} strokeWidth={1.9} />,
      onClick: openWhiteboard,
      disabled: whiteboardPreparing,
    },
    ...(hasImage ? [{
      key: 'repaint',
      label: repaint.preparing ? '正在打开局部重绘' : repaint.submitting ? '正在提交局部重绘' : '局部重绘',
      icon: repaint.preparing || repaint.submitting
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <Paintbrush size={14} strokeWidth={1.9} />,
      onClick: repaint.openEditor,
      disabled: repaint.preparing || repaint.submitting,
    },
    {
      key: 'subject-matting',
      label: subjectMatting.preparing ? '正在打开抠像' : subjectMatting.submitting ? '正在生成抠像' : '抠像',
      icon: subjectMatting.preparing || subjectMatting.submitting
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <ScanLine size={14} strokeWidth={1.9} />,
      onClick: subjectMatting.openEditor,
      disabled: subjectMatting.preparing || subjectMatting.submitting,
    },
    {
      // 细化纹理。上传节点原来漏了这一项，而图片生成节点有 —— 两种节点的工具必须一致。
      key: 'texture-clarity',
      label: '细化纹理',
      icon: <Wand2 size={14} strokeWidth={1.9} />,
      onClick: () => { if (mainUrl) setTextureClarityOpen(true) },
      disabled: !mainUrl,
    }] : []),
    ...(hasImage ? [{
      key: 'lighting',
      label: lightingApplying ? '正在应用灯光' : '灯光',
      icon: lightingApplying
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <Lightbulb size={14} strokeWidth={1.9} />,
      onClick: () => {
        const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
        setLightingAnchorRect(element?.getBoundingClientRect() ?? null)
        setLightingOpen(true)
      },
      disabled: lightingApplying,
    },
    {
      key: 'atmosphere-transfer',
      label: '色彩与灯光氛围迁移',
      icon: <Palette size={14} strokeWidth={1.9} />,
      onClick: createAtmosphereNode,
      disabled: !hasImage || !mainUrl,
    },
    {
      key: 'multi-camera-grid',
      label: gridSubmitting ? '正在生成九宫格' : '九宫格',
      icon: gridSubmitting
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <Grid3X3 size={14} strokeWidth={1.9} />,
      onClick: () => setGridOpen(true),
      disabled: gridSubmitting,
    }] : []),
    ...(hasImage ? [{
      key: 'panorama-360x180',
      label: panorama.isPanorama
        ? '360°查看'
        : panorama.submitting
          ? '正在提交HDR全景'
          : 'HDR',
      icon: panorama.submitting
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <Globe2 size={14} strokeWidth={1.9} />,
      onClick: panorama.isPanorama ? panorama.openViewer : panorama.openGenerator,
      disabled: panorama.submitting || !mainUrl,
    }] : []),
    ...((hasImage || hasVideo) ? [{
      key: 'media-enhance',
      label: mediaEnhance.submitting ? '正在创建高清增强' : 'AI 高清增强',
      icon: mediaEnhance.submitting
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <Sparkles size={14} strokeWidth={1.9} />,
      onClick: mediaEnhance.openModal,
      disabled: mediaEnhance.submitting || !mainUrl,
    }] : []),
    {
      key: 'download',
      label: '下载',
      icon: <Download size={14} strokeWidth={1.9} />,
      onClick: () => handleDownload(mainUrl),
    },
{
  key: 'fullscreen',
  label: '全屏',
  icon: <Expand size={14} strokeWidth={1.9} />,
  onClick: () => setPreviewUrl(mainUrl),
},
  ]

  const toolbar = isPanelActive && showToolbar && (hasImage || hasVideo) ? (
    <MediaNodeToolbar actions={mediaToolbarActions} />
  ) : undefined

  const headerMeta = imgSize ? (
    <span
      style={{
        fontSize: 'calc(11px * var(--canvas-text-scale, 1))',
        color: '#8a7aaa',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {imgSize.w} × {imgSize.h}
    </span>
  ) : undefined

  const headerIcon = <NodeTypeIcon type={headerIconType} size={13} strokeWidth={1.9} />

  return (
    <div ref={nodeRef} style={{ display: 'contents' }}>
      <NodeShell
        nodeKey={id}
        data={data}
        selected={selected}
        toolbar={toolbar}
        showFavoriteToolbarFallback={false}
        headerMeta={headerMeta}
        headerIcon={headerIcon}
        showMenuButton={false}
        minWidth={shellWidth}
        maxWidth={shellWidth}
        minHeight={hasImage || hasVideo ? previewFrame.height : 160}
        bodyStyle={hasImage || hasVideo ? {
          background: 'transparent',
        } : undefined}
      >

        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />

        {hasContent ? (
          <div style={{ background: hasImage || hasVideo ? 'transparent' : '#0d0b18' }}>
            <div className="relative group">
              {isImage(mainUrl) && (
                <img
                  src={mainDisplayUrl} alt=""
                  className="w-full block"
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  style={{
                    width: shellWidth,
                    maxWidth: '100%',
                    height: 'auto',
                    maxHeight: previewFrame.height,
                    display: 'block',
                    cursor: 'pointer',
                    background: 'transparent',
                  }}
                  onLoad={e => {
                    const img = e.currentTarget
                    setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
                  }}
                  onClick={() => setShowToolbar(v => !v)}
                  onDoubleClick={() => setPreviewUrl(mainUrl)}
                />
              )}
              {isVideo(mainUrl) && (
                <video
                  ref={videoRef}
                  src={mediaPreviewUrl(data, mainUrl, 0)}
                  controls
                  preload="metadata"
                  className="w-full block nodrag"
                  style={{ width: shellWidth, maxWidth: '100%', height: 'auto', maxHeight: previewFrame.height, display: 'block' }}
                  onLoadedMetadata={e => {
                    const video = e.currentTarget
                    setVideoSize({ w: video.videoWidth, h: video.videoHeight })
                  }}
                  onClick={() => setShowToolbar(v => !v)}
                />
              )}
              {!isImage(mainUrl) && !isVideo(mainUrl) && (
                <div className="flex items-center gap-2 p-3 text-xs" style={{ color: '#8a7aaa' }}>
                  <span style={{ fontSize: 20 }}>📄</span>
                  <span className="truncate">{mainUrl.split('/').pop()}</span>
                </div>
              )}

              {/* Dimensions badge */}
              {false && imgSize && (
                <div style={{
                  position: 'absolute', top: 8, left: 10, fontSize: 10, color: '#8a7aaa',
                  background: 'rgba(13,11,24,0.6)', borderRadius: 4, padding: '1px 6px',
                  pointerEvents: 'none',
                }}>{imgSize.w} × {imgSize.h}</div>
              )}

              {/* Hover download button */}
              {isImage(mainUrl) && (
                <button
                  className="nodrag opacity-0 group-hover:opacity-100"
                  style={{
                    position: 'absolute', top: 8, right: 8,
                    width: 28, height: 28, borderRadius: '50%',
                    background: 'rgba(13,11,24,0.85)', border: '1px solid #312550',
                    color: '#c4b5fd', fontSize: 14, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'opacity 0.15s',
                  }}
                  onClick={() => handleDownload(mainUrl)}
                  title="下载"
                >↑</button>
              )}
            </div>

            {/* Extra files strip (no add button) */}
            {urls.length > 1 && (
              <div className="flex gap-1 p-2">
                {urls.slice(1).map((url, i) => (
                  isImage(url) ? (
                    <img key={i} src={url} alt=""
                      className="rounded"
                      draggable={false}
                      style={{ width: 48, height: 48, objectFit: 'cover', cursor: 'zoom-in', border: '1px solid #312550' }}
                      onClick={() => setPreviewUrl(url)}
                    />
                  ) : (
                    <div key={i} className="text-xs truncate" style={{ color: '#6a5a8a', maxWidth: 80 }}>
                      {url.split('/').pop()}
                    </div>
                  )
                ))}
              </div>
            )}
          </div>
        ) : (
          /* Empty drop zone */
          <div
            className="flex flex-col items-center justify-center gap-2 cursor-pointer nodrag"
            style={{
              minHeight: 160, background: '#0d0b18',
              border: '2px dashed #2a2040', borderRadius: 8, margin: 8,
              color: '#4a4060', transition: 'border-color 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = '#312550')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a2040')}
            onClick={() => inputRef.current?.click()}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" opacity={0.4}>
              <path d="M16 22V10M10 16l6-6 6 6" stroke="#c4b5fd" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="4" y="4" width="24" height="24" rx="4" stroke="#c4b5fd" strokeWidth="1.5" />
            </svg>
            <span style={{ fontSize: 11 }}>点击上传图片 / 视频 / 音频</span>
          </div>
        )}

        {previewUrl && (
          <ImagePreview
            url={previewUrl}
            name={data.name}
            nodeActions={mediaToolbarActions}
            onClose={() => setPreviewUrl(null)}
          />
        )}
        {panorama.viewer}
        {repaint.modal}
        {subjectMatting.modal}
        {mediaEnhance.modal}
        {cropOpen && hasImage && (
          <ImageCropModal
            sourceName={data.name}
            sourceFile={cropSourceFile}
            sourceUrl={mainUrl}
            onCancel={() => {
              setCropOpen(false)
              setCropSourceFile(null)
            }}
            onAccept={handleCropAccept}
          />
        )}
        {whiteboardOpen && (
          <WhiteboardModal
            sourceName={data.name}
            sourceFile={whiteboardSourceFile}
            isPreparing={whiteboardPreparing}
            loadError={whiteboardError}
            onCancel={() => {
              setWhiteboardOpen(false)
              setWhiteboardSourceFile(null)
              setWhiteboardError(null)
            }}
            onAccept={handleWhiteboardAccept}
          />
        )}
        {textureClarityOpen && mainUrl && data.projectUuid && (
          <TextureClarityEditor
            projectUuid={data.projectUuid}
            nodeKey={id}
            sourceUrl={mainUrl}
            onClose={() => setTextureClarityOpen(false)}
            onGenerate={(assets, model) => {
              // 跟 ImageNode 同一套（共用 startTextureClarityRepair，别再各写一遍）：
              // 立刻建一个「生成中」的图片节点，源节点一律不动，等待发生在新节点上。
              const selfNode = nodes.find(n => n.id === id)
              startTextureClarityRepair({
                projectUuid: data.projectUuid as string,
                sourceNodeId: id,
                sourceNodePos: selfNode?.position ?? null,
                // UploadNode 比 ImageNode 宽，按自身壳宽偏移，别压在源节点上
                offsetX: shellWidth + 140,
                sourceUrl: mainUrl,
                assets,
                model,
              })
            }}
          />
        )}
        {lightingOpen && hasImage && mainUrl && (
          <LightStageModal
            sourceName={data.name}
            sourceUrl={mainUrl}
            sourceNodeId={id}
            projectUuid={data.projectUuid}
            anchorRect={lightingAnchorRect}
            initialState={readLightStageState(uploadAdvancedSettings.lightStage)}
            initialRatio={inferMultiCameraGridRatio(imgSize?.w, imgSize?.h)}
            initialResolution="1K"
            busy={lightingApplying}
            onCancel={() => setLightingOpen(false)}
            onAccept={handleLightStageAccept}
          />
        )}
        {gridOpen && hasImage && mainUrl && (
          <ImageGridConfirmModal
            initialRatio={inferMultiCameraGridRatio(imgSize?.w, imgSize?.h)}
            busy={gridSubmitting}
            onCancel={() => setGridOpen(false)}
            onConfirm={handleGridConfirm}
          />
        )}
      </NodeShell>
      {whiteboardError && (
        <div
          className="nodrag"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -32,
            transform: 'translateX(-50%)',
            padding: '5px 10px',
            borderRadius: 8,
            background: '#2a1020',
            color: '#f87171',
            fontSize: 12,
            whiteSpace: 'nowrap',
          }}
        >
          {whiteboardError}
        </div>
      )}
    </div>
  )
}
