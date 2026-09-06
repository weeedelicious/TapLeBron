import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { addEdge } from '@xyflow/react'
import { AppearanceTransferEditor } from './AppearanceTransferEditor'
import { DEFAULT_APPEARANCE_BACKENDS } from './appearance-transfer-execution'
import { DEFAULT_APPEARANCE_TRANSFER_STATE, type AppearanceTransferState } from './appearance-transfer-types'
import { analyzeAppearanceSource } from './appearance-transfer-analysis'
import {
  renderImageCoverFileFromUrl,
  renderReferenceBackgroundCompositeFromUrls,
} from './appearance-transfer-reference-composite'
import {
  createRouteAGenerationSpec,
  isRouteASupportedBackend,
  type RouteAGenerationSource,
  type RouteAReferenceMode,
} from './appearance-transfer-route-a'
import { getModelCapability } from './model-capabilities'
import { listAppearanceHistory, projectAppearanceHistoryResults } from './appearance-transfer-history-api'
import type { AppearanceHistoryResult } from './appearance-transfer-history'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { assetsApi, generateApi, subjectMattingApi } from '@/lib/api'
import { defaultImageParams } from '@/lib/nodeData'
import { errorToText } from '@/lib/display'
import { resourceMetaFromUploadPayload } from '@/lib/whiteboard'
import type { CanvasNode } from '../../shared/types/canvas'
import type { CanvasNodeData } from '@/lib/types'
import './atmosphere-transfer.css'

interface UseAtmosphereTransferOptions {
  id: string
  data: CanvasNodeData & { projectUuid: string }
  sourceUrl: string
  sourceName?: string
  shellWidth: number
  /**
   * Node mode: the reference (氛围来源) is supplied by a canvas connection, not the
   * picker. When set, openEditor skips the "选择参考图" step and uses this reference.
   */
  presetReference?: { url: string; name?: string; nodeId?: string; assetId?: string } | null
  /** Seed atState from persisted node params so controls survive reloads. */
  initialState?: AppearanceTransferState
}

interface ReferenceOption { id: string; name: string; url: string }

// tapflow assets are served under /assets/...; the vision proxy and generation
// route only accept that relative form, so strip any absolute origin prefix.
function normalizeAssetUrl(url: string): string {
  if (!url) return url
  return url.replace(/^https?:\/\/[^/]+(?=\/assets\/)/i, '')
}

function loadImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 1024, height: img.naturalHeight || 1024 })
    img.onerror = () => reject(new Error('图片尺寸读取失败'))
    img.src = url
  })
}

// Editor resolution -> gemini/gpt resolution bucket. 'original' picks by long edge.
function mapAppearanceResolution(requested: string, longEdge: number): '1K' | '2K' | '4K' {
  if (requested === '1K' || requested === '2K' || requested === '4K') return requested
  if (longEdge <= 1024) return '1K'
  if (longEdge <= 2048) return '2K'
  return '4K'
}

export function useAtmosphereTransfer({ id, data, sourceUrl, sourceName, shellWidth, presetReference = null, initialState }: UseAtmosphereTransferOptions) {
  const { addNodeAt, edges, nodes, setEdges, updateNodeData } = useCanvasStore()
  const { addTask, startPolling } = useTasksStore()
  const presetUrl = presetReference?.url ?? null
  const presetNodeId = presetReference?.nodeId ?? null
  const presetAssetId = presetReference?.assetId ?? null
  const presetName = presetReference?.name ?? '参考图'
  const [open, setOpen] = useState(false)
  const [editorInstance, setEditorInstance] = useState(0)
  const [picking, setPicking] = useState(!presetUrl)
  const [submitting, setSubmitting] = useState(false)
  const [refLoading, setRefLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [atState, setAtState] = useState<AppearanceTransferState>(() => (initialState ? { ...initialState } : { ...DEFAULT_APPEARANCE_TRANSFER_STATE }))
  const [refUrl, setRefUrl] = useState<string | null>(null)
  const [refName, setRefName] = useState<string>('参考图')
  const [refNodeId, setRefNodeId] = useState<string | null>(null)
  const [refAssetId, setRefAssetId] = useState<string | null>(null)
  const [historyResults, setHistoryResults] = useState<AppearanceHistoryResult[]>([])

  // Always-current mirror so async callbacks read the latest state/reference
  // without widening effect/callback dependency lists.
  const atStateRef = useRef(atState)
  atStateRef.current = atState
  const analysisAbortRef = useRef<AbortController | null>(null)
  const analyzedKeyRef = useRef<string | null>(null)
  const taskVersionRef = useRef(0)
  // Guards the on-demand subject-mask fetch for the experimental remove /
  // replace-pose paths so it does not refire on every unrelated state change.
  const maskFetchKeyRef = useRef<string | null>(null)

  const referenceOptions = useMemo<ReferenceOption[]>(() => {
    const list: ReferenceOption[] = []
    for (const node of nodes) {
      if (node.id === id) continue
      const nd = node.data as CanvasNodeData
      if (nd.type !== 'image' && node.type !== 'image') continue
      const url = nd._primaryAssetUrl || (Array.isArray(nd.url) ? nd.url[0] : undefined)
      if (url) list.push({ id: node.id, name: String(nd.name || node.id), url })
    }
    return list
  }, [nodes, id])

  const resetReference = useCallback(() => {
    setRefUrl(null)
    setRefNodeId(null)
    setRefAssetId(null)
    analyzedKeyRef.current = null
  }, [])

  const openEditor = useCallback(() => {
    if (!sourceUrl || submitting) return
    setError(null)
    if (presetUrl) {
      // Node mode: reference comes from a connection — (re)apply it (it may have been
      // cleared by a prior submit) and go straight to the editor (no picker).
      const normalized = normalizeAssetUrl(presetUrl)
      taskVersionRef.current += 1
      analyzedKeyRef.current = null
      setRefUrl(normalized)
      setRefName(presetName)
      setRefNodeId(presetNodeId || normalized)
      setRefAssetId(presetAssetId || normalized)
      setPicking(false)
      setEditorInstance((value) => value + 1)
    } else {
      setAtState({ ...DEFAULT_APPEARANCE_TRANSFER_STATE })
      resetReference()
      setPicking(true)
    }
    setOpen(true)
  }, [sourceUrl, submitting, resetReference, presetUrl, presetName, presetNodeId, presetAssetId])

  // Node mode: keep the hook's reference in sync with the connected 参考图.
  useEffect(() => {
    if (!presetUrl) return
    const normalized = normalizeAssetUrl(presetUrl)
    taskVersionRef.current += 1
    analyzedKeyRef.current = null
    setRefUrl(normalized)
    setRefName(presetName)
    setRefNodeId(presetNodeId || normalized)
    setRefAssetId(presetAssetId || normalized)
    setPicking(false)
  }, [presetUrl, presetNodeId, presetAssetId, presetName])

  const closeEditor = useCallback(() => {
    if (submitting) return
    analysisAbortRef.current?.abort()
    // In node mode the reference belongs to the canvas connection. Do not clear
    // the hook mirror when merely closing the editor: on the next open, clearing
    // it first creates a one-render empty editor and can leave the editor's
    // prepared-image state stale. The connection remains the source of truth.
    if (!presetUrl) resetReference()
    setOpen(false)
    setError(null)
  }, [submitting, resetReference, presetUrl])

  const chooseCanvasReference = useCallback((url: string, name: string, nodeId: string) => {
    const normalized = normalizeAssetUrl(url)
    taskVersionRef.current += 1
    analyzedKeyRef.current = null
    setRefUrl(normalized)
    setRefName(name)
    setRefNodeId(nodeId)
    setRefAssetId(normalized)
    setPicking(false)
  }, [])

  const chooseUploadReference = useCallback(async (file: File | null) => {
    if (!file) return
    setRefLoading(true)
    setError(null)
    try {
      // Upload so the reference is a real project asset the server can analyze
      // (the vision descriptor route only accepts /assets/ URLs).
      const uploaded = await assetsApi.upload(data.projectUuid, file)
      const meta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
      const normalized = normalizeAssetUrl(uploaded.url)
      taskVersionRef.current += 1
      analyzedKeyRef.current = null
      setRefUrl(normalized)
      setRefName(file.name)
      setRefNodeId(`atmo-ref-${Date.now()}`)
      setRefAssetId((meta as { assetId?: string } | null)?.assetId || normalized)
      setPicking(false)
    } catch (uploadError) {
      setError(errorToText(uploadError, '参考图上传失败'))
    } finally {
      setRefLoading(false)
    }
  }, [data.projectUuid])

  // --- Descriptor (光说明书) analysis: runs when the faithful editor is open,
  // lighting is enabled and a project-asset reference is chosen. Populates
  // atState.analysis so the editor's lighting readout fills in and Route A
  // relighting unlocks (it requires a ready descriptor). ---
  useEffect(() => {
    if (!open || picking || !refUrl || !atState.lightingEnabled || atState.lightingMode === 'replace-background') return
    const normalizedRef = normalizeAssetUrl(refUrl)
    if (!normalizedRef.startsWith('/assets/')) return
    const normalizedSource = normalizeAssetUrl(sourceUrl)
    const key = `${normalizedRef}|${normalizedSource}`
    if (analyzedKeyRef.current === key) return
    analyzedKeyRef.current = key

    analysisAbortRef.current?.abort()
    const controller = new AbortController()
    analysisAbortRef.current = controller

    ;(async () => {
      try {
        setAtState((prev) => ({
          ...prev,
          analysis: { ...prev.analysis, status: 'analyzing', descriptorStatus: 'running' },
        }))
        const result = await analyzeAppearanceSource({
          projectId: data.projectUuid,
          processorNodeId: id,
          sourceNodeId: id,
          sourceAssetId: normalizedSource,
          sourceUrl: normalizedSource,
          referenceNodeId: refNodeId || normalizedRef,
          referenceAssetId: refAssetId || normalizedRef,
          referenceUrl: normalizedRef,
          taskVersion: taskVersionRef.current,
          signal: controller.signal,
          existingAnalysis: atStateRef.current.analysis,
          analysisMode: 'descriptor-only',
          onDescriptorProgress: (progress) => {
            if (controller.signal.aborted) return
            setAtState((prev) => ({ ...prev, analysis: { ...prev.analysis, ...progress } }))
          },
        })
        if (controller.signal.aborted) return
        setAtState((prev) => ({ ...prev, analysis: { ...prev.analysis, ...result } }))
      } catch (analysisError) {
        if (controller.signal.aborted) return
        analyzedKeyRef.current = null // allow a retry on the next trigger
        setAtState((prev) => ({
          ...prev,
          analysis: {
            ...prev.analysis,
            status: 'unavailable',
            descriptorStatus: 'failed',
            analyzerError: errorToText(analysisError, '光说明书分析失败'),
          },
        }))
      }
    })()

    return () => { controller.abort() }
  }, [open, picking, refUrl, refNodeId, refAssetId, sourceUrl, atState.lightingEnabled, atState.lightingMode, id, data.projectUuid])

  // --- Experimental reference-pixels remove / replace-pose need a basic subject
  // mask for the reference image (and, for remove, the source image) before
  // generation can start. The editor gates the generate button on these living in
  // atState.analysis, so fetch them on demand via the shared subject-matting
  // capability. Masks are ephemeral client state (data URLs); the node only ever
  // persists the control subset, so they never bloat the canvas payload. ---
  useEffect(() => {
    if (!open || picking || !refUrl) return
    if (
      !atState.lightingEnabled ||
      atState.lightingMode !== 'replace-background' ||
      atState.backgroundTransferMethod !== 'reference-pixels' ||
      atState.referencePersonAction === 'keep'
    ) return
    const normalizedRef = normalizeAssetUrl(refUrl)
    if (!normalizedRef.startsWith('/assets/')) return
    const normalizedSource = normalizeAssetUrl(sourceUrl)
    const needReferenceMask = !atState.analysis.referenceSubjectMaskUrl
    const needSourceMask =
      atState.referencePersonAction === 'remove' &&
      !(atState.analysis.subjectAlphaUrl || atState.analysis.subjectMaskUrl)
    if (!needReferenceMask && !needSourceMask) return
    const key = `${normalizedRef}|${normalizedSource}|${atState.referencePersonAction}|${needReferenceMask}|${needSourceMask}`
    if (maskFetchKeyRef.current === key) return
    maskFetchKeyRef.current = key
    ;(async () => {
      try {
        const [refMask, srcMask] = await Promise.all([
          needReferenceMask
            ? subjectMattingApi.prepareAutomaticMask(data.projectUuid, `${id}-reference`, normalizedRef)
            : Promise.resolve(null),
          needSourceMask
            ? subjectMattingApi.prepareAutomaticMask(data.projectUuid, id, normalizedSource)
            : Promise.resolve(null),
        ])
        if (needReferenceMask && !refMask?.maskDataUrl) throw new Error('参考图主体抠像失败')
        if (needSourceMask && !srcMask?.maskDataUrl) throw new Error('原图主体抠像失败')
        setAtState((prev) => ({
          ...prev,
          analysis: {
            ...prev.analysis,
            ...(refMask?.maskDataUrl ? { referenceSubjectMaskUrl: refMask.maskDataUrl } : {}),
            ...(srcMask?.maskDataUrl
              ? { subjectMaskUrl: srcMask.maskDataUrl, alphaModel: srcMask.modelId }
              : {}),
          },
        }))
      } catch (maskError) {
        maskFetchKeyRef.current = null // allow a retry on the next trigger
        setError(errorToText(maskError, '参考图主体蒙版准备失败'))
      }
    })()
  }, [
    open,
    picking,
    refUrl,
    sourceUrl,
    id,
    data.projectUuid,
    atState.lightingEnabled,
    atState.lightingMode,
    atState.backgroundTransferMethod,
    atState.referencePersonAction,
    atState.analysis.referenceSubjectMaskUrl,
    atState.analysis.subjectAlphaUrl,
    atState.analysis.subjectMaskUrl,
  ])

  // Phase C: persistent per-processor-node history from the server ledger.
  // Fetch when the editor opens; keep the last good list on failure (never clear).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const page = await listAppearanceHistory(data.projectUuid, id)
        if (cancelled) return
        const items = page && page.schemaVersion === 1 && Array.isArray(page.items) ? page.items : []
        setHistoryResults(projectAppearanceHistoryResults(items, nodes as never))
      } catch {
        // history fetch failure must not erase the last good list
      }
    })()
    return () => { cancelled = true }
  }, [open, id, data.projectUuid])

  // Phase A: deterministic OKLab color transfer -> a static derived node (no AI).
  const submitColorOnly = useCallback(async (colorFile: File) => {
    setError(null)
    setSubmitting(true)
    try {
      const uploaded = await assetsApi.upload(data.projectUuid, colorFile)
      const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
      const sourceNode = nodes.find((node) => node.id === id)
      const sourceRef = { nodeId: id, url: sourceUrl, mediaType: 'image' as const }
      const createdAtMs = Date.now()
      const outgoingCount = edges.filter((edge) => edge.source === id).length
      const createdNode = addNodeAt(
        'upload',
        (sourceNode?.position.x ?? 0) + shellWidth + 140,
        (sourceNode?.position.y ?? 0) + outgoingCount * 44,
        {
          name: `${sourceName || data.name || 'image'} 色彩迁移`,
          url: [uploaded.url],
          action: 'image_resource',
          sourceKind: 'derived',
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          _assetCreatedAtMs: { [uploaded.url]: createdAtMs },
          _assetGenerationMeta: { [uploaded.url]: { model: '色彩迁移', createdAtMs, outputIndex: 0 } },
          params: {
            ...defaultImageParams(),
            imageList: [sourceRef],
            imageListOrder: [id],
            advancedSettings: {
              derivation: {
                kind: 'atmosphere-transfer-color',
                sourceNodeId: id,
                sourceUrl,
                referenceUrl: refUrl ? normalizeAssetUrl(refUrl) : null,
                colorState: atStateRef.current,
                createdAtMs,
              },
            },
          } as unknown as Record<string, unknown>,
        },
      )
      const edgeId = `e-${id}-${createdNode.id}`
      if (!edges.some((edge) => edge.id === edgeId)) {
        setEdges(addEdge({ id: edgeId, source: id, target: createdNode.id, type: 'glow', selectable: true, interactionWidth: 34 }, edges))
      }
      resetReference()
      setOpen(false)
    } catch (submitError) {
      setError(errorToText(submitError, '色彩迁移应用失败'))
    } finally {
      setSubmitting(false)
    }
  }, [data.projectUuid, data.name, nodes, id, sourceUrl, edges, addNodeAt, shellWidth, sourceName, refUrl, setEdges, resetReference])

  // Reference-pixels · keep: deterministic client composite (no model). Matte the
  // source subject with the basic SAM2 mask and lay it over the reference image's
  // own pixels at the exact source dimensions, then write a static derived node.
  const submitReferenceCompositeKeep = useCallback(async () => {
    setError(null)
    setSubmitting(true)
    let createdNodeId: string | null = null
    try {
      const normalizedSource = normalizeAssetUrl(sourceUrl)
      const normalizedRef = normalizeAssetUrl(refUrl || '')
      if (!normalizedRef) throw new Error('请先连接参考图（氛围来源）。')
      const dims = await loadImageSize(sourceUrl)
      const width = dims.width
      const height = dims.height
      // 1. Basic subject mask (SAM2) for the source image.
      const mask = await subjectMattingApi.prepareAutomaticMask(data.projectUuid, id, normalizedSource)
      if (!mask?.maskDataUrl) throw new Error('主体抠像失败，请重试。')
      // 2. Deterministic composite: source subject over the reference background.
      const compositeFile = await renderReferenceBackgroundCompositeFromUrls({
        foregroundUrl: sourceUrl,
        backgroundUrl: normalizedRef,
        subjectMaskUrl: mask.maskDataUrl,
        width,
        height,
      })
      // 3. Upload the composite as a derived asset.
      const uploaded = await assetsApi.upload(data.projectUuid, compositeFile)
      const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
      // 4. Create the finished derived node + glow edge (mirrors submitColorOnly).
      const sourceNode = nodes.find((node) => node.id === id)
      const createdAtMs = Date.now()
      const outgoingCount = edges.filter((edge) => edge.source === id).length
      const createdNode = addNodeAt(
        'upload',
        (sourceNode?.position.x ?? 0) + shellWidth + 140,
        (sourceNode?.position.y ?? 0) + outgoingCount * 44,
        {
          name: `${sourceName || data.name || 'image'} 换景合成`,
          url: [uploaded.url],
          action: 'image_resource',
          sourceKind: 'derived',
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          _assetCreatedAtMs: { [uploaded.url]: createdAtMs },
          _assetGenerationMeta: { [uploaded.url]: { model: '换景合成', createdAtMs, outputIndex: 0 } },
          params: {
            ...defaultImageParams(),
            imageList: [{ nodeId: id, url: sourceUrl, mediaType: 'image' as const }],
            imageListOrder: [id],
            advancedSettings: {
              derivation: {
                kind: 'atmosphere-transfer-reference-composite',
                sourceNodeId: id,
                sourceUrl: normalizedSource,
                referenceUrl: normalizedRef,
                backgroundTransferMethod: 'reference-pixels',
                referencePersonAction: 'keep',
                maskProvider: mask.provider,
                maskModelId: mask.modelId,
                createdAtMs,
              },
            },
          } as unknown as Record<string, unknown>,
        },
      )
      createdNodeId = createdNode.id
      const edgeId = `e-${id}-${createdNode.id}`
      if (!edges.some((edge) => edge.id === edgeId)) {
        setEdges(addEdge({ id: edgeId, source: id, target: createdNode.id, type: 'glow', selectable: true, interactionWidth: 34 }, edges))
      }
      resetReference()
      setOpen(false)
    } catch (submitError) {
      setError(errorToText(submitError, '换景合成失败'))
      if (createdNodeId) {
        updateNodeData(createdNodeId, {
          taskInfo: { taskId: '', loading: false, status: 3, progressPercent: 0, taskKind: 'image', error: errorToText(submitError, '换景合成失败') },
        })
      }
    } finally {
      setSubmitting(false)
    }
  }, [data.projectUuid, data.name, nodes, id, sourceUrl, refUrl, edges, addNodeAt, shellWidth, sourceName, setEdges, resetReference, updateNodeData])

  // Reference-pixels · replace-pose (实验): one two-image edit. IMAGE 1 is the
  // reference (target scene + pose to keep); IMAGE 2 is the source (identity only),
  // with the faithful Dexis replace-pose prompt + poseReplacementMode. Submitted on
  // a detached job key and polled, then the reference-framed result is deterministically
  // cover-cropped back to the exact source dimensions (renderImageCoverFileFromUrl)
  // and written as a static result node. Maskless: tapflow's repaint route carries a
  // single source + mask, so it cannot also attach the identity image across both
  // providers — the reference background is regenerated rather than pixel-preserved.
  const submitReferencePoseReplacement = useCallback(async () => {
    const state = atStateRef.current
    setError(null)
    setSubmitting(true)
    let createdNodeId: string | null = null
    try {
      if (!isRouteASupportedBackend(state.backendId)) {
        throw new Error('替换并继承 Pose 需要选择 Nano Banana Pro 或 Image 2.0。')
      }
      const normalizedRef = normalizeAssetUrl(refUrl || '')
      if (!normalizedRef) throw new Error('请先连接参考图（氛围来源）。')
      const normalizedSource = normalizeAssetUrl(sourceUrl)
      const sourceDims = await loadImageSize(sourceUrl)
      const resolution = mapAppearanceResolution(state.resolution, Math.max(sourceDims.width, sourceDims.height))
      const genModel = getModelCapability(state.backendId).resolvedModel || state.backendId
      const identityInstruction = state.poseReplacementMode === 'full-appearance'
        ? 'Transfer the identity, facial features, hairstyle, body appearance, and clothing appearance from IMAGE 2. Adapt those source appearance traits naturally to the exact pose and occlusions of IMAGE 1.'
        : 'Transfer only the identity, facial features, skin identity, and hairstyle from IMAGE 2. Keep the target body pose, clothing, accessories, and occlusions from IMAGE 1.'
      const prompt = [
        'ROLE BINDING IS AUTHORITATIVE.',
        'IMAGE 1 is the target scene and target person: preserve its camera, framing, background, body pose, silhouette, scale, placement, illumination, shadows, and atmospheric perspective.',
        'IMAGE 2 is the source identity reference only: never copy its pose, camera, background, framing, or lighting.',
        'Replace the person in IMAGE 1 with the source identity while keeping the IMAGE 1 background and pose.',
        identityInstruction,
        'Match the target scene lighting and color on the replacement person so the result belongs physically in IMAGE 1.',
        'Preserve the IMAGE 1 background and every non-person region as closely as possible; do not add duplicate people, extra limbs, text, logos, props, or new objects.',
        'Retain realistic pores, individual hair strands, fabric texture, airborne particles, and natural photographic detail without beauty smoothing.',
        'Return exactly one image using the IMAGE 1 aspect ratio.',
      ].join('\n')
      const imageList = [
        { nodeId: refNodeId || normalizedRef, url: normalizedRef, mediaType: 'image' as const },
        { nodeId: id, url: normalizedSource, mediaType: 'image' as const },
      ]
      const baseParams = defaultImageParams()
      const genParams = {
        ...baseParams,
        model: genModel,
        prompt,
        count: 1,
        modeType: 'image2image',
        settings: { ...baseParams.settings, quality: 'high', ratio: 'auto', resolution },
        imageList,
        imageListOrder: imageList.map((item) => item.nodeId),
        videoList: [],
        audioList: [],
        textList: [],
        advancedSettings: {
          ...(baseParams.advancedSettings ?? {}),
          appearanceTransfer: {
            appearanceProcessorNodeId: id,
            appearanceHistoryCreatedAt: new Date().toISOString(),
            appearanceLightingMode: 'replace-background',
            appearanceBackgroundTransferMethod: 'reference-pose-v1',
            appearanceReferencePersonAction: 'replace-pose-v1',
            appearancePoseReplacementMode: state.poseReplacementMode,
            appearanceReferenceAttached: 'true',
            imageReferenceIds: `${refNodeId || normalizedRef},${id}`,
          },
        },
      } as unknown as Record<string, unknown>
      // Submit on a detached job key (no canvas node) and poll for the URL so the
      // reference-framed result can be cover-cropped to the source dimensions.
      const jobNodeKey = `${id}-atmo-pose-${Date.now()}`
      const response = await generateApi.image(data.projectUuid, jobNodeKey, genParams)
      let generatedUrl = ''
      const maxPolls = 120
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        const res = await generateApi.poll(response.jobId)
        if (res.status === 2 && res.urls?.length) {
          generatedUrl = res.urls[0]
          break
        }
        if (res.status === 3) throw new Error(errorToText(res.error, '替换 Pose 换景失败'))
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
      if (!generatedUrl) throw new Error('替换 Pose 换景超时，请重试。')
      // Cover-crop the reference-framed result back to the exact source dimensions.
      const normalizedFile = await renderImageCoverFileFromUrl({
        imageUrl: normalizeAssetUrl(generatedUrl),
        width: sourceDims.width,
        height: sourceDims.height,
        fileName: `appearance-reference-pose-${id}.png`,
      })
      const uploaded = await assetsApi.upload(data.projectUuid, normalizedFile)
      const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
      const sourceCanvasNode = nodes.find((node) => node.id === id)
      const createdAtMs = Date.now()
      const outgoingCount = edges.filter((edge) => edge.source === id).length
      const createdNode = addNodeAt(
        'upload',
        (sourceCanvasNode?.position.x ?? 0) + shellWidth + 140,
        (sourceCanvasNode?.position.y ?? 0) + outgoingCount * 44,
        {
          name: `${sourceName || data.name || 'image'} 换景·替换Pose`,
          url: [uploaded.url],
          action: 'image_resource',
          sourceKind: 'derived',
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          _assetCreatedAtMs: { [uploaded.url]: createdAtMs },
          _assetGenerationMeta: { [uploaded.url]: { model: '换景·替换Pose', createdAtMs, outputIndex: 0 } },
          params: {
            ...defaultImageParams(),
            imageList: [
              { nodeId: refNodeId || normalizedRef, url: normalizedRef, mediaType: 'image' as const },
              { nodeId: id, url: normalizedSource, mediaType: 'image' as const },
            ],
            imageListOrder: [refNodeId || normalizedRef, id],
            advancedSettings: {
              derivation: {
                kind: 'atmosphere-transfer-reference-pose',
                sourceNodeId: id,
                sourceUrl: normalizedSource,
                referenceUrl: normalizedRef,
                backgroundTransferMethod: 'reference-pixels',
                referencePersonAction: 'replace-pose',
                poseReplacementMode: state.poseReplacementMode,
                poseGeneratedUrl: normalizeAssetUrl(generatedUrl),
                poseModel: genModel,
                createdAtMs,
              },
            },
          } as unknown as Record<string, unknown>,
        },
      )
      createdNodeId = createdNode.id
      const edgeId = `e-${id}-${createdNode.id}`
      if (!edges.some((edge) => edge.id === edgeId)) {
        setEdges(addEdge({ id: edgeId, source: id, target: createdNode.id, type: 'glow', selectable: true, interactionWidth: 34 }, edges))
      }
      resetReference()
      setOpen(false)
    } catch (submitError) {
      const message = errorToText(submitError, '替换 Pose 换景提交失败')
      setError(message)
      if (createdNodeId) {
        updateNodeData(createdNodeId, {
          taskInfo: { taskId: '', loading: false, status: 3, progressPercent: 0, taskKind: 'image', error: message },
        })
      }
    } finally {
      setSubmitting(false)
    }
  }, [data.projectUuid, data.name, id, sourceUrl, sourceName, shellWidth, refUrl, refNodeId, nodes, edges, addNodeAt, setEdges, updateNodeData, resetReference])

  // Reference-pixels · remove (实验, 两段式). 1/2: repaint the reference to erase its
  // own foreground subject and rebuild a clean background — reference = repaint
  // source + reference-subject cleanup mask, a wrapper-correct 1-image+mask edit for
  // both Nano Banana Pro and Image 2.0 — then poll for the cleaned URL. 2/2:
  // deterministically composite the original subject over the cleaned background at
  // the exact source dimensions and write a static result node. The Dexis cleanup
  // prompt is preserved; the final model-fusion pass is replaced by the deterministic
  // composite (the sanctioned tapflow fallback for an experimental path).
  const submitReferenceRemove = useCallback(async (referenceCleanupMaskFile?: File) => {
    const state = atStateRef.current
    setError(null)
    setSubmitting(true)
    let createdNodeId: string | null = null
    try {
      if (!isRouteASupportedBackend(state.backendId)) {
        throw new Error('清除参考图主体需要选择 Nano Banana Pro 或 Image 2.0。')
      }
      if (!referenceCleanupMaskFile) {
        throw new Error('参考图主体清理蒙版尚未准备完成，请稍候重试。')
      }
      const normalizedRef = normalizeAssetUrl(refUrl || '')
      if (!normalizedRef) throw new Error('请先连接参考图（氛围来源）。')
      const normalizedSource = normalizeAssetUrl(sourceUrl)
      // Source subject matte (SAM2) — reuse the effect's fetch, else fetch now.
      let subjectMaskUrl = state.analysis.subjectAlphaUrl || state.analysis.subjectMaskUrl || ''
      let maskProvider: string | undefined
      let maskModelId: string | undefined
      if (!subjectMaskUrl) {
        const srcMask = await subjectMattingApi.prepareAutomaticMask(data.projectUuid, id, normalizedSource)
        if (!srcMask?.maskDataUrl) throw new Error('原图主体抠像失败，请重试。')
        subjectMaskUrl = srcMask.maskDataUrl
        maskProvider = srcMask.provider
        maskModelId = srcMask.modelId
      }
      const sourceDims = await loadImageSize(sourceUrl)
      const referenceDims = await loadImageSize(refUrl || '')
      // Upload the cleanup mask so the repaint route can fetch it as a project asset.
      const uploadedMask = await assetsApi.upload(data.projectUuid, referenceCleanupMaskFile)
      const maskUrl = normalizeAssetUrl(uploadedMask.url)
      const resolution = mapAppearanceResolution(state.resolution, Math.max(referenceDims.width, referenceDims.height))
      const genModel = getModelCapability(state.backendId).resolvedModel || state.backendId
      const cleanupPrompt = [
        'Remove only the detected foreground subject inside the transparent mask.',
        'Reconstruct the occluded background from the surrounding scene with matching perspective, texture, lighting, and depth.',
        'Preserve every unmasked pixel exactly.',
        'Do not add a person, body part, silhouette, text, logo, prop, or new object.',
      ].join('\n')
      const cleanupImageList = [
        { nodeId: refNodeId || normalizedRef, url: normalizedRef, mediaType: 'image' as const },
      ]
      const baseParams = defaultImageParams()
      const cleanupParams = {
        ...baseParams,
        model: genModel,
        prompt: cleanupPrompt,
        count: 1,
        modeType: 'image2image',
        settings: { ...baseParams.settings, quality: 'high', ratio: 'auto', resolution },
        imageList: cleanupImageList,
        imageListOrder: cleanupImageList.map((item) => item.nodeId),
        videoList: [],
        audioList: [],
        textList: [],
        advancedSettings: {
          ...(baseParams.advancedSettings ?? {}),
          repaint: {
            version: 1,
            contract: 'hard-mask-v0.0.1',
            sourceNodeId: refNodeId || normalizedRef,
            sourceUrl: normalizedRef,
            sourceName: refName,
            maskUrl,
            maskWidth: referenceDims.width,
            maskHeight: referenceDims.height,
            maskCoverage: 0,
            commandCount: 0,
            brushSize: 1,
            providerBehavior: 'transparent-editable',
          },
        },
      } as unknown as Record<string, unknown>
      // 1/2: submit the clean-background repaint on a detached job key (no canvas
      // node) and poll for its result URL.
      const cleanupJobNodeKey = `${id}-atmo-clean-${Date.now()}`
      const cleanupResponse = await generateApi.image(data.projectUuid, cleanupJobNodeKey, cleanupParams)
      let cleanBackgroundUrl = ''
      const maxPolls = 120
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        const res = await generateApi.poll(cleanupResponse.jobId)
        if (res.status === 2 && res.urls?.length) {
          cleanBackgroundUrl = res.urls[0]
          break
        }
        if (res.status === 3) throw new Error(errorToText(res.error, '清除参考图人物失败'))
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
      if (!cleanBackgroundUrl) throw new Error('清除参考图人物超时，请重试。')
      const cleanBackgroundAssetUrl = normalizeAssetUrl(cleanBackgroundUrl)
      // 2/2: deterministic composite — original subject over the clean background,
      // cover-cropped to the exact source dimensions.
      const compositeFile = await renderReferenceBackgroundCompositeFromUrls({
        foregroundUrl: sourceUrl,
        backgroundUrl: cleanBackgroundAssetUrl,
        subjectMaskUrl,
        width: sourceDims.width,
        height: sourceDims.height,
      })
      const uploaded = await assetsApi.upload(data.projectUuid, compositeFile)
      const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
      const sourceNode = nodes.find((node) => node.id === id)
      const createdAtMs = Date.now()
      const outgoingCount = edges.filter((edge) => edge.source === id).length
      const createdNode = addNodeAt(
        'upload',
        (sourceNode?.position.x ?? 0) + shellWidth + 140,
        (sourceNode?.position.y ?? 0) + outgoingCount * 44,
        {
          name: `${sourceName || data.name || 'image'} 换景·清除主体`,
          url: [uploaded.url],
          action: 'image_resource',
          sourceKind: 'derived',
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          _assetCreatedAtMs: { [uploaded.url]: createdAtMs },
          _assetGenerationMeta: { [uploaded.url]: { model: '换景·清除主体', createdAtMs, outputIndex: 0 } },
          params: {
            ...defaultImageParams(),
            imageList: [{ nodeId: id, url: sourceUrl, mediaType: 'image' as const }],
            imageListOrder: [id],
            advancedSettings: {
              derivation: {
                kind: 'atmosphere-transfer-reference-composite',
                sourceNodeId: id,
                sourceUrl: normalizedSource,
                referenceUrl: normalizedRef,
                backgroundTransferMethod: 'reference-pixels',
                referencePersonAction: 'remove',
                cleanBackgroundUrl: cleanBackgroundAssetUrl,
                cleanupModel: genModel,
                maskProvider,
                maskModelId,
                createdAtMs,
              },
            },
          } as unknown as Record<string, unknown>,
        },
      )
      createdNodeId = createdNode.id
      const edgeId = `e-${id}-${createdNode.id}`
      if (!edges.some((edge) => edge.id === edgeId)) {
        setEdges(addEdge({ id: edgeId, source: id, target: createdNode.id, type: 'glow', selectable: true, interactionWidth: 34 }, edges))
      }
      resetReference()
      setOpen(false)
    } catch (submitError) {
      const message = errorToText(submitError, '清除主体换景失败')
      setError(message)
      if (createdNodeId) {
        updateNodeData(createdNodeId, {
          taskInfo: { taskId: '', loading: false, status: 3, progressPercent: 0, taskKind: 'image', error: message },
        })
      }
    } finally {
      setSubmitting(false)
    }
  }, [data.projectUuid, data.name, id, sourceUrl, sourceName, shellWidth, refUrl, refNodeId, refName, nodes, edges, addNodeAt, setEdges, updateNodeData, resetReference])

  // Phase B: Route A preserve-scene relight. Reuses the standard image-generation
  // pipeline (/generate/image + tasksStore) with the client-compiled relight
  // prompt; the finished asset is written back into the derived node by polling.
  const submitRelight = useCallback(async (colorFile: File | undefined, referenceMode: RouteAReferenceMode, referenceCleanupMaskFile?: File) => {
    const state = atStateRef.current
    if (state.lightingMode === 'replace-background' && state.backgroundTransferMethod === 'reference-pixels') {
      if (state.referencePersonAction === 'keep') {
        await submitReferenceCompositeKeep()
      } else if (state.referencePersonAction === 'remove') {
        await submitReferenceRemove(referenceCleanupMaskFile)
      } else {
        await submitReferencePoseReplacement()
      }
      return
    }
    if (
      state.lightingMode !== 'replace-background' &&
      (state.analysis.descriptorStatus !== 'ready' || !state.analysis.descriptor || !state.analysis.descriptorHash)
    ) {
      setError('参考图光说明书尚未完成,请等待灯光分析完成后再生成。')
      return
    }
    const normalizedRef = normalizeAssetUrl(refUrl || '')
    setError(null)
    setSubmitting(true)
    let createdNodeId: string | null = null
    try {
      // 1. Resolve the immutable generation base (deterministic color grade if
      //    color is enabled, otherwise the untouched source RGB).
      let generationSource: RouteAGenerationSource
      if (colorFile) {
        const objectUrl = URL.createObjectURL(colorFile)
        let dims: { width: number; height: number }
        try {
          dims = await loadImageSize(objectUrl)
        } finally {
          URL.revokeObjectURL(objectUrl)
        }
        const uploaded = await assetsApi.upload(data.projectUuid, colorFile)
        const meta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
        generationSource = {
          kind: 'color-base',
          url: normalizeAssetUrl(uploaded.url),
          width: dims.width,
          height: dims.height,
          nodeId: id,
          assetId: (meta as { assetId?: string } | null)?.assetId,
        }
      } else {
        const dims = await loadImageSize(sourceUrl)
        generationSource = {
          kind: 'source-rgb',
          url: normalizeAssetUrl(sourceUrl),
          width: dims.width,
          height: dims.height,
          nodeId: id,
        }
      }

      // 2. Adapt tapflow nodes into the CanvasNode shape Route A expects.
      const sourceNode = {
        id,
        imageWidth: generationSource.width,
        imageHeight: generationSource.height,
        originalUrl: normalizeAssetUrl(sourceUrl),
        previewUrl: normalizeAssetUrl(sourceUrl),
      } as unknown as CanvasNode
      const referenceNode = {
        id: refNodeId || normalizedRef,
        originalUrl: normalizedRef,
        previewUrl: normalizedRef,
        thumbnailUrl: normalizedRef,
        assetId: refAssetId || undefined,
      } as unknown as CanvasNode

      // 3. Compile the faithful Route A spec (prompt + manifest + settings).
      const spec = createRouteAGenerationSpec({ sourceNode, referenceNode, state, generationSource, referenceMode })

      // 4. Map to the tapflow generation request.
      const genModel = getModelCapability(spec.model).resolvedModel || spec.model
      const longEdge = Math.max(generationSource.width, generationSource.height)
      const resolution = mapAppearanceResolution(state.resolution, longEdge)
      // Build the model image list from the spec's ordered manifest inputs
      // (IMAGE 1 = generation source; IMAGE 2 = reference for 2-image modes such
      // as replace-background / experimental-attached). No mask is ever attached.
      const manifestInputs = Array.isArray(spec.inputManifest?.inputs) ? spec.inputManifest.inputs : []
      const imageList: Array<{ nodeId: string; url: string; mediaType: 'image' }> = manifestInputs
        .map((input) => ({ nodeId: input.nodeId || id, url: normalizeAssetUrl(input.url || ''), mediaType: 'image' as const }))
        .filter((item) => Boolean(item.url))
      if (imageList.length === 0) {
        imageList.push({ nodeId: id, url: generationSource.url, mediaType: 'image' })
      }
      const baseParams = defaultImageParams()
      const genParams = {
        ...baseParams,
        model: genModel,
        prompt: spec.prompt,
        count: 1,
        modeType: 'image2image',
        settings: { ...baseParams.settings, quality: 'high', ratio: 'auto', resolution },
        imageList,
        imageListOrder: imageList.map((item) => item.nodeId),
        videoList: [],
        audioList: [],
        textList: [],
        advancedSettings: {
          ...(baseParams.advancedSettings ?? {}),
          appearanceTransfer: {
            ...spec.settings,
            appearanceProcessorNodeId: id,
            appearanceHistoryCreatedAt: new Date().toISOString(),
            generationSourceKind: generationSource.kind,
            descriptorHash: state.analysis.descriptorHash ?? '',
          },
        },
      } as unknown as Record<string, unknown>

      // 5. Create the derived node (loading), wire the glow edge, submit + poll.
      const sourceCanvasNode = nodes.find((node) => node.id === id)
      const createdAtMs = Date.now()
      const outgoingCount = edges.filter((edge) => edge.source === id).length
      const createdNode = addNodeAt(
        'image',
        (sourceCanvasNode?.position.x ?? 0) + shellWidth + 140,
        (sourceCanvasNode?.position.y ?? 0) + outgoingCount * 44,
        {
          name: `${sourceName || data.name || 'image'} 灯光氛围迁移`,
          url: [],
          action: 'image_generate',
          sourceKind: 'derived',
          params: genParams,
          taskInfo: {
            taskId: '',
            loading: true,
            status: 1,
            progressPercent: 0,
            taskKind: 'image',
            model: genModel,
            quantity: 1,
            startedAtMs: createdAtMs,
          },
        },
      )
      createdNodeId = createdNode.id
      const edgeId = `e-${id}-${createdNode.id}`
      if (!edges.some((edge) => edge.id === edgeId)) {
        setEdges(addEdge({ id: edgeId, source: id, target: createdNode.id, type: 'glow', selectable: true, interactionWidth: 34 }, edges))
      }

      const response = await generateApi.image(
        data.projectUuid,
        createdNode.id,
        genParams,
      )
      addTask(response.jobId, createdNode.id, response.generationVersion)
      startPolling(response.jobId, data.projectUuid)
      resetReference()
      setOpen(false)
    } catch (submitError) {
      const message = errorToText(submitError, '灯光氛围迁移提交失败')
      setError(message)
      if (createdNodeId) {
        updateNodeData(createdNodeId, {
          taskInfo: { taskId: '', loading: false, status: 3, progressPercent: 0, taskKind: 'image', error: message },
        })
      }
    } finally {
      setSubmitting(false)
    }
  }, [
    data.projectUuid,
    data.name,
    id,
    sourceUrl,
    sourceName,
    shellWidth,
    refUrl,
    refNodeId,
    refAssetId,
    nodes,
    edges,
    addNodeAt,
    setEdges,
    addTask,
    startPolling,
    updateNodeData,
    resetReference,
    submitReferenceCompositeKeep,
    submitReferenceRemove,
    submitReferencePoseReplacement,
  ])

  const handleGenerate = useCallback(async (colorFile?: File, options?: { referenceMode?: RouteAReferenceMode; referenceCleanupMaskFile?: File }) => {
    if (submitting) return
    const referenceMode = options?.referenceMode ?? 'descriptor-only'
    if (atStateRef.current.lightingEnabled) {
      await submitRelight(colorFile, referenceMode, options?.referenceCleanupMaskFile)
      return
    }
    if (colorFile) {
      await submitColorOnly(colorFile)
      return
    }
    setError('请至少开启「色彩迁移」或「灯光氛围迁移」。')
  }, [submitting, submitRelight, submitColorOnly])

  const modal = useMemo(() => {
    if (!open) return null
    if (picking) {
      return createPortal(
        <div className="atmo-ref-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) closeEditor() }}>
          <div className="atmo-ref-dialog">
            <div className="atmo-ref-dialog-head">
              <strong>选择参考图(氛围来源)</strong>
              <button type="button" onClick={closeEditor} aria-label="关闭">×</button>
            </div>
            <p className="atmo-ref-dialog-hint">色彩与灯光氛围将从这张参考图迁移到当前图片。</p>
            {referenceOptions.length > 0 && (
              <div className="atmo-ref-dialog-section">
                <span>从画布选择</span>
                <div className="atmo-ref-grid">
                  {referenceOptions.map((opt) => (
                    <button key={opt.id} type="button" className="atmo-ref-card" disabled={refLoading} onClick={() => chooseCanvasReference(opt.url, opt.name, opt.id)}>
                      <img src={opt.url} alt={opt.name} />
                      <span>{opt.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="atmo-ref-dialog-section">
              <span>或上传</span>
              <label className="atmo-ref-upload">
                {refLoading ? '上传中…' : '选择本地图片'}
                <input type="file" accept="image/*" hidden disabled={refLoading} onChange={(e) => chooseUploadReference(e.currentTarget.files?.[0] ?? null)} />
              </label>
            </div>
          </div>
        </div>,
        document.body,
      )
    }
    return createPortal(
      <AppearanceTransferEditor
        key={editorInstance}
        sourceUrl={sourceUrl}
        referenceUrl={refUrl}
        sourceTitle={sourceName || data.name}
        referenceTitle={refName}
        state={atState}
        backends={DEFAULT_APPEARANCE_BACKENDS}
        historyResults={historyResults}
        open={open}
        generating={submitting}
        generationError={error}
        onChange={setAtState}
        onGenerate={(colorFile, options) => handleGenerate(colorFile, options)}
        onConfirm={() => closeEditor()}
        onDiscard={() => closeEditor()}
        onClose={closeEditor}
      />,
      document.body,
    )
  }, [open, picking, editorInstance, referenceOptions, refLoading, sourceUrl, refUrl, sourceName, data.name, refName, atState, submitting, error, historyResults, closeEditor, chooseCanvasReference, chooseUploadReference, handleGenerate])

  return { openEditor, submitting, error, modal, atState, setAtState, hasReference: Boolean(refUrl) }
}
