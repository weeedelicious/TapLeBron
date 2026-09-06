import { useCallback, useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { addEdge, useUpdateNodeInternals, useViewport, useStore } from '@xyflow/react'
import { Copy, Crop as CropIcon, Download, Expand, GitCompare, Globe2, Grid3X3, Lightbulb, Loader2, Lock, Paintbrush, Palette, ScanLine, SquarePen, Trash2, Unlock, Wand2 } from 'lucide-react'
import { MediaNodeToolbar, type MediaNodeToolbarAction } from '@/components/MediaNodeToolbar'
import { GenerationProgress } from '@/components/GenerationProgress'
import { LightStageModal, type LightStageAcceptPayload } from '@/features/light-stage/LightStageModal'
import { TextureClarityEditor } from '@/features/texture-clarity/TextureClarityEditor'
import { startTextureClarityRepair } from '@/features/texture-clarity/textureClarityJob'
import { readTextureClarityResult } from '@/features/texture-clarity/resultMeta'
import { LIGHT_STAGE_MODEL, readLightStageState } from '@/features/light-stage/types'
import { useImageRepaint } from '@/features/image-repaint/useImageRepaint'
import { usePanoramaGeneration } from '@/features/panorama/usePanoramaGeneration'
import { useSubjectMatting } from '@/features/subject-matting/useSubjectMatting'
import { ImageGridConfirmModal } from '@/components/ImageGridConfirmModal'
import { ImageCropModal, type ImageCropAcceptPayload } from '@/components/ImageCropModal'
import { WhiteboardModal } from '@/components/WhiteboardModal'
import { NodeShell } from './NodeShell'
import { NodeTypeIcon } from './nodeTypeIcon'
import { ResizablePanelHandle, readPanelSize, useResizablePanel, type PanelSize } from './ResizablePanelHandle'
import { HoverImagePreview } from '@/components/HoverImagePreview'
import { ImagePreview, type ImagePreviewItem } from '@/components/ImagePreview'
import { PromptEditor } from '@/components/PromptEditor'
import type { ChipRef, PromptEditorHandle, PromptEditorSnapshot } from '@/components/PromptEditor'
import { resolveTextMentionAt, resolveTextMentionsIn as resolveTextMentionsInText } from '@/lib/promptTokenMention'
import { edgesWithoutLink } from '@/lib/referenceEdges'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { assetsApi, generateApi } from '@/lib/api'
import { errorToText } from '@/lib/display'
import { defaultImageParams, IMAGE_MODELS, normalizeImageModel } from '@/lib/nodeData'
import {
  getImageGenerationCounts,
  getImageRatioOptions,
  getImageResolutionOptions,
  normalizeImageGenerationCount,
  normalizeImageRatioValue,
  normalizeImageResolutionValue,
} from '@/lib/imageRules'
import { inferMultiCameraGridRatio, makeMultiCameraGridParams } from '@/lib/multiCameraGrid'
import { textPromptFromRefs } from '@/lib/textPrompt'
import {
  markPromptChipRefsMissingInParams,
  refreshPromptChipUrlsInHtml,
  refreshPromptChipUrlsInParams,
  type PromptChipLiveUrls,
} from '@/lib/promptChips'
import { liveRefUrl } from '@/lib/primaryOutput'
import { mediaPreviewUrl } from '@/lib/mediaPreview'
import { writeTextToClipboard } from '@/lib/clipboard'
import type { AssetGenerationMeta, CanvasNodeData, ImageParams, NodeRef, ResourceMeta } from '@/lib/types'
import { hasPendingUpstream } from '@/lib/autoGenerate'
import {
  dataUrlToFile,
  loadAssetFileFromUrl,
  readWhiteboardState,
  resourceMetaFromUploadPayload,
  writeWhiteboardState,
} from '@/lib/whiteboard'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

function getParams(data: CanvasNodeData): ImageParams {
  if (data.params) return data.params as unknown as ImageParams
  return defaultImageParams()
}

const TOOLBAR_RIGHT = [
  { key: 'edit',       icon: '✏', title: '编辑' },
  { key: 'link',       icon: '⬡', title: '引用' },
  { key: 'download',   icon: '↓', title: '下载' },
  { key: 'fullscreen', icon: '⤢', title: '全屏' },
]

const SUB_TOOLS = [
  { key: 'style',  icon: '⊡', label: '风格' },
  { key: 'mark',   icon: '⚑', label: '标记' },
  { key: 'focus',  icon: '⊙', label: '聚焦' },
]

function RatioIcon({ w, h, active }: { w: number; h: number; active: boolean }) {
  const MAX = 20
  const scale = MAX / Math.max(w, h)
  const rw = Math.max(3, Math.round(w * scale))
  const rh = Math.max(3, Math.round(h * scale))
  return (
    <svg width={rw} height={rh} viewBox={`0 0 ${rw} ${rh}`} fill="none" style={{ display: 'block' }}>
      <rect x="0.75" y="0.75" width={rw - 1.5} height={rh - 1.5} rx="1.5"
        stroke={active ? '#a78bfa' : '#5a5070'} strokeWidth="1.5"
        fill={active ? 'rgba(124,92,252,0.15)' : 'none'} />
    </svg>
  )
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
  width = Math.max(minWidth, width)
  return { width: Math.round(width), height: Math.round(height) }
}

type GalleryItem = {
  url: string
  order: number
  model: string
  resolution: string
}

function galleryItemsFromNodeData(data: CanvasNodeData): GalleryItem[] {
  const seen = new Set<string>()
  const rawUrls = (data.url ?? []).filter((url): url is string => {
    if (typeof url !== 'string') return false
    const clean = url.trim()
    if (!clean || seen.has(clean)) return false
    seen.add(clean)
    return true
  })
  const timestampMap = data._assetCreatedAtMs ?? {}
  const sortable = rawUrls.map((url, index) => {
    const timestamp = Number(timestampMap[url])
    return {
      url,
      index,
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null,
    }
  })
  if (sortable.length > 1 && sortable.every((item) => item.timestamp !== null)) {
    sortable.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return Number(a.timestamp) - Number(b.timestamp)
      return a.index - b.index
    })
  }
  const params = getParams(data)
  const fallbackModel = normalizeImageModel(params.model)
  const fallbackResolution = String(params.settings?.resolution || '1K').toUpperCase()
  const generationMeta = data._assetGenerationMeta ?? {}
  return sortable.map((item, index) => ({
    url: item.url,
    order: index + 1,
    model: normalizeImageModel(generationMeta[item.url]?.model || fallbackModel),
    resolution: String(generationMeta[item.url]?.resolution || fallbackResolution).toUpperCase(),
  }))
}

function galleryModelLabel(model: string) {
  const normalized = normalizeImageModel(model)
  return IMAGE_MODELS.find(option => option.value === normalized)?.label || normalized
}

function primaryGalleryItem(data: CanvasNodeData, items: GalleryItem[]) {
  const primaryUrl = typeof data._primaryAssetUrl === 'string' ? data._primaryAssetUrl : ''
  const firstUrl = (data.url ?? []).find((url): url is string => typeof url === 'string' && url.trim().length > 0)
  return items.find((item) => item.url === primaryUrl) ?? items.find((item) => item.url === firstUrl) ?? items[0]
}

// ── @ Mention dropdown ────────────────────────────────────────────────────────
function AtMentionDropdown({ pos, candidates, onSelect, onClose, activeIndex, onHoverIndex }: {
  pos: { x: number; y: number }
  candidates: ChipRef[]
  onSelect: (chip: ChipRef) => void
  onClose: () => void
  activeIndex?: number
  onHoverIndex?: (index: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [onClose])

  if (candidates.length === 0) return null

  return createPortal(
    <div ref={ref} className="nodrag" data-at-mention-dropdown="1" style={{
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 99999,
      background: '#16121f', border: '1px solid #2d2248', borderRadius: 10,
      boxShadow: '0 8px 32px rgba(0,0,0,0.7)', padding: '6px 0',
      minWidth: 220, maxHeight: 300, overflowY: 'auto',
    }}>
      <div style={{ padding: '4px 12px 6px', fontSize: 11, color: '#5a5070' }}>@引用图片节点</div>
      {candidates.map((chip, index) => {
        const isActive = index === activeIndex
        return (
          <button
            key={chip.nodeId}
            className="nodrag"
            onMouseDown={e => {
              e.preventDefault()
              e.stopPropagation()
              onSelect(chip)
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 12px', background: isActive ? 'rgba(124,92,252,0.12)' : 'none', border: 'none',
              cursor: 'pointer', textAlign: 'left', color: '#d0c8f0',
            }}
            onMouseEnter={() => onHoverIndex?.(index)}
          >
            <img src={chip.url} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
            <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chip.name}</span>
          </button>
        )
      })}
    </div>,
    document.body
  )
}

export function ImageNode({ id, data, selected }: Props) {
  const { addNodeAt, updateNodeData, nodes, edges, setEdges, selectedNodeKeys, activePanelNodeId, pushHistory } = useCanvasStore()
  const [textureClarityOpen, setTextureClarityOpen] = useState(false)
  const [textureClarityCompareOpen, setTextureClarityCompareOpen] = useState(false)
  /**
   * 这个节点是不是一次细化纹理的结果。是的话工具栏多一个「对比」入口，点开能看
   * 原图 / 模型候选 / 融合结果的滑杆对比和当时的质量门禁。
   * 容错读取：老节点缺字段就返回 null，当普通图片节点处理。
   */
  const textureClarityResult = useMemo(() => readTextureClarityResult(data), [data])
  const { addTask, startPolling, cancelTask } = useTasksStore()
  const initialPanelSize = readPanelSize((getParams(data).advancedSettings as Record<string, unknown> | undefined)?.bottomPanelSize)
  const [genError, setGenError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [galleryLocked, setGalleryLocked] = useState(false)
  const [collapsed, setCollapsed] = useState(true)
  const [panelExpanded, setPanelExpanded] = useState(false)
  const [panelSize, setPanelSize] = useState<PanelSize | null>(() => initialPanelSize)
  const [showAtMenu, setShowAtMenu] = useState(false)
  const [atMenuPos, setAtMenuPos] = useState({ x: 0, y: 0 })
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [nameDraft, setNameDraft] = useState(data.name)
  const [isRenaming, setIsRenaming] = useState(false)
  const [hoverPreview, setHoverPreview] = useState<{ url: string; name?: string; rect: DOMRect } | null>(null)
  const [whiteboardOpen, setWhiteboardOpen] = useState(false)
  const [whiteboardSourceFile, setWhiteboardSourceFile] = useState<File | null>(null)
  const [isWhiteboardPreparing, setIsWhiteboardPreparing] = useState(false)
  const [whiteboardLoadError, setWhiteboardLoadError] = useState<string | null>(null)
  const [cropOpen, setCropOpen] = useState(false)
  const [cropSourceFile, setCropSourceFile] = useState<File | null>(null)
  const [isCropPreparing, setIsCropPreparing] = useState(false)
  const [lightingOpen, setLightingOpen] = useState(false)
  const [lightingAnchorRect, setLightingAnchorRect] = useState<DOMRect | null>(null)
  const [isLightingApplying, setIsLightingApplying] = useState(false)
  const [gridOpen, setGridOpen] = useState(false)
  const [isGridSubmitting, setIsGridSubmitting] = useState(false)
  const cancelRequestedRef = useRef(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const promptEditorRef = useRef<PromptEditorHandle>(null)
  const promptWrapRef = useRef<HTMLDivElement>(null)
  const nodeContainerRef = useRef<HTMLDivElement>(null)
  const dividerRef = useRef<HTMLDivElement>(null)      // bottom edge of image area
  const controlsPortalRef = useRef<HTMLDivElement>(null)
  const galleryPortalRef = useRef<HTMLDivElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const settingsPortalRef = useRef<HTMLDivElement>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const activeHoverKeyRef = useRef<string | null>(null)
  const updateNodeInternals = useUpdateNodeInternals()
  const isSoleSelected = selectedNodeKeys.length === 1 && selectedNodeKeys[0] === id
  const isPanelActive = activePanelNodeId === id && isSoleSelected
  const persistPanelSize = useCallback((size: PanelSize) => {
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : getParams(data)
    updateNodeData(id, {
      params: {
        ...currentParams,
        advancedSettings: {
          ...((currentParams.advancedSettings ?? {}) as Record<string, unknown>),
          bottomPanelSize: size,
        },
      } as unknown as Record<string, unknown>,
    })
  }, [data, id, updateNodeData])
  const handlePanelResizeStart = useResizablePanel(controlsPortalRef, setPanelSize, {
    minWidth: 420,
    minHeight: 210,
    onResizeEnd: persistPanelSize,
  })

  // viewport + node absolute position — drive portal re-positioning
  const { zoom, x: vpX, y: vpY } = useViewport()
  const nodeAbsPos = useStore(s => (s.nodeLookup as Map<string, { internals?: { positionAbsolute?: { x: number; y: number } } }>)?.get(id)?.internals?.positionAbsolute)
  const [portalRect, setPortalRect] = useState<DOMRect | null>(null)
  const [settingsRect, setSettingsRect] = useState<DOMRect | null>(null)
  const [galleryRect, setGalleryRect] = useState<DOMRect | null>(null)

  // useLayoutEffect: runs after DOM commit, before paint — gives correct getBoundingClientRect()
  useLayoutEffect(() => {
    setPortalRect(dividerRef.current?.getBoundingClientRect() ?? null)
  }, [collapsed, zoom, vpX, vpY, nodeAbsPos?.x, nodeAbsPos?.y, imgSize?.w, imgSize?.h, data.url?.length])

  useLayoutEffect(() => {
    if (!showSettings) { setSettingsRect(null); return }
    setSettingsRect(settingsButtonRef.current?.getBoundingClientRect() ?? null)
  }, [showSettings, zoom, vpX, vpY, nodeAbsPos?.x, nodeAbsPos?.y])

  useLayoutEffect(() => {
    if (!expanded) { setGalleryRect(null); return }
    setGalleryRect(imgRef.current?.getBoundingClientRect() ?? null)
  }, [expanded, zoom, vpX, vpY, nodeAbsPos?.x, nodeAbsPos?.y, imgSize?.w, imgSize?.h, data.url?.length])

  // Force React Flow to re-measure when the visible node frame changes.
  useEffect(() => { updateNodeInternals(id) }, [collapsed, id, updateNodeInternals, imgSize?.w, imgSize?.h, data.url?.length])

  // Auto-collapse on outside click (checks both node and portal)
  useEffect(() => {
    if (collapsed) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (
        !target?.closest('[data-at-mention-dropdown="1"]') &&
        !nodeContainerRef.current?.contains(e.target as Node) &&
        !controlsPortalRef.current?.contains(e.target as Node) &&
        !settingsPortalRef.current?.contains(e.target as Node)
      ) {
        setCollapsed(true)
        setPanelExpanded(false)
        setShowAtMenu(false)
        setShowSettings(false)
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [collapsed])

  useEffect(() => {
    if (!showSettings) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        settingsPortalRef.current?.contains(target) ||
        settingsButtonRef.current?.contains(target)
      ) return
      setShowSettings(false)
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [showSettings])

  useEffect(() => {
    if (!expanded) return
    const handler = (e: MouseEvent) => {
      if (galleryLocked) return
      const target = e.target as Node
      if (
        nodeContainerRef.current?.contains(target) ||
        galleryPortalRef.current?.contains(target)
      ) return
      setExpanded(false)
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [expanded, galleryLocked])

  useEffect(() => {
    if (isPanelActive) return
    setCollapsed(true)
    if (!galleryLocked) setExpanded(false)
    setPanelExpanded(false)
    setShowAtMenu(false)
    setShowSettings(false)
    setHoverPreview(null)
  }, [galleryLocked, isPanelActive])

  useEffect(() => {
    if (!isPanelActive || collapsed || panelSize) return
    const savedSize = readPanelSize((getParams(data).advancedSettings as Record<string, unknown> | undefined)?.bottomPanelSize)
    if (savedSize) setPanelSize(savedSize)
  }, [collapsed, data, isPanelActive, panelSize])

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const hideHoverPreview = useCallback((key?: string) => {
    if (key && activeHoverKeyRef.current && activeHoverKeyRef.current !== key) return
    clearHoverTimer()
    activeHoverKeyRef.current = null
    setHoverPreview(null)
  }, [clearHoverTimer])

  const scheduleHoverPreview = useCallback((key: string, url: string, name: string, rect: DOMRect) => {
    clearHoverTimer()
    activeHoverKeyRef.current = key
    hoverTimerRef.current = window.setTimeout(() => {
      if (activeHoverKeyRef.current !== key) return
      setHoverPreview({ url, name, rect })
      hoverTimerRef.current = null
    }, 450)
  }, [clearHoverTimer])

  useEffect(() => {
    return () => clearHoverTimer()
  }, [clearHoverTimer])

  useEffect(() => {
    setNameDraft(data.name)
    setIsRenaming(false)
  }, [data.name])

  const setMainImage = useCallback((url: string) => {
    if (!url) return
    pushHistory()
    updateNodeData(id, { _primaryAssetUrl: url, _updatedAtMs: Date.now() })
    setExpanded(false)
  }, [id, pushHistory, updateNodeData])

  const removeImageUrl = useCallback((url: string) => {
    const newUrls = (data.url ?? []).filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
    const nextUrls = newUrls.filter((item) => item !== url)
    if (nextUrls.length === newUrls.length) return
    const patch: Partial<CanvasNodeData> = { url: nextUrls, _updatedAtMs: Date.now() }
    if (data._assetGenerationMeta) {
      const nextGenerationMeta = { ...data._assetGenerationMeta }
      delete nextGenerationMeta[url]
      patch._assetGenerationMeta = nextGenerationMeta
    }
    if (data._primaryAssetUrl === url) patch._primaryAssetUrl = nextUrls[0] ?? ''
    pushHistory()
    updateNodeData(id, patch)
    if (nextUrls.length <= 1) {
      setExpanded(false)
      setGalleryLocked(false)
    }
  }, [data._assetGenerationMeta, data._primaryAssetUrl, data.url, id, pushHistory, updateNodeData])

  const params = getParams(data)
  const advancedSettings = (params.advancedSettings ?? {}) as Record<string, unknown>
  const whiteboardState = readWhiteboardState(advancedSettings)
  const urls = data.url ?? []
  const galleryUrls = urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
  const galleryItems = galleryItemsFromNodeData(data)
  const mainImageItem = primaryGalleryItem(data, galleryItems)
  const mainImageUrl = mainImageItem?.url
  const expandedGalleryItems = galleryItems.filter((item) => item.url !== mainImageUrl)
  const hasImage = galleryItems.length > 0
  const normalizedImageModel = normalizeImageModel(params.model)
  const ratioOptions = getImageRatioOptions(normalizedImageModel)
  const resolutionOptions = getImageResolutionOptions(normalizedImageModel)
  const ratio = normalizeImageRatioValue(normalizedImageModel, params.settings.ratio)
  const resolution = normalizeImageResolutionValue(normalizedImageModel, params.settings.resolution)
  const countOptions = getImageGenerationCounts(normalizedImageModel)
  const normalizedCount = normalizeImageGenerationCount(normalizedImageModel, params.count)
  const currentRatioOption = ratioOptions.find(option => option.value === ratio)
    ?? ratioOptions.find(option => option.value === '16:9')
    ?? ratioOptions[0]
  const rawConnectedImages = (params.imageList as NodeRef[] | undefined)?.filter(r => r.url) ?? []
  const imageListOrder = (params.imageListOrder as string[] | undefined) ?? []
  const orderedConnectedImages = imageListOrder.length > 0
    ? [...rawConnectedImages].sort((a, b) => {
      const aKey = a.nodeId || a.url
      const bKey = b.nodeId || b.url
      const ai = imageListOrder.indexOf(aKey)
      const bi = imageListOrder.indexOf(bKey)
      return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
    })
    : rawConnectedImages
  /**
   * 参考图一律解析成上游**当前的主图**，而不是引用里存的那个快照。
   * 在源节点点「设为主图」之后，这里的缩略图、悬浮预览、@引用、点开的大图全都跟着换。
   * 上游被删掉时 liveRefUrl 会退回快照，参考图不会凭空消失。
   * 只解析一次、后面统一用 ref.url —— 以前缩略图用快照、@引用另算一遍 url[0]，
   * 同一张参考图在一个节点里有两个地址。
   */
  const connectedImages = orderedConnectedImages.map(ref => {
    const srcNode = nodes.find(n => n.id === ref.nodeId)
    return { ...ref, url: liveRefUrl(srcNode?.data as CanvasNodeData | undefined, ref.url) }
  }).filter(ref => ref.url)
  const connectedTextRefs = (params.textList as NodeRef[] | undefined)?.filter(r => r.nodeId) ?? []
  const upstreamTextPrompt = textPromptFromRefs(connectedTextRefs, nodes)
  const mentionCandidates: ChipRef[] = connectedImages
    .map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: `图片${index + 1}` }))
  const mentionOrderMap = Object.fromEntries(mentionCandidates.map(chip => [chip.nodeId, chip.name]))
  /**
   * 提示词里的 @引用也要跟着主图换：服务端算参考素材时把 promptChips 和 imageList 的地址
   * **取并集**，只换一边等于把新旧两张图一起发出去 —— 比不换更糟。
   */
  const liveChipUrls: PromptChipLiveUrls = Object.fromEntries(
    connectedImages.filter(ref => ref.nodeId).map(ref => [ref.nodeId, ref.url]),
  )
  const liveChipUrlsKey = JSON.stringify(liveChipUrls)
  const chips = useMemo(() => {
    const list = (params.promptChips ?? []) as ChipRef[]
    return refreshPromptChipUrlsInParams({ promptChips: list }, liveChipUrls).promptChips as ChipRef[]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.promptChips, liveChipUrlsKey])
  const promptHtmlSnapshot = useMemo(
    () => refreshPromptChipUrlsInHtml(params.promptHtml, liveChipUrls) as string | undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.promptHtml, liveChipUrlsKey],
  )

  const setParam = useCallback(<K extends keyof ImageParams>(key: K, val: ImageParams[K]) => {
    // Read fresh params from store to avoid stale closure overwriting concurrent setParam calls
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    updateNodeData(id, { params: { ...currentParams, [key]: val } as unknown as Record<string, unknown> })
  }, [id, updateNodeData]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePromptChange = useCallback((snapshot: PromptEditorSnapshot) => {
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    updateNodeData(id, {
      params: {
        ...currentParams,
        prompt: snapshot.text,
        promptChips: snapshot.chips,
        promptHtml: snapshot.html,
      } as unknown as Record<string, unknown>,
    })
  }, [id, params, updateNodeData])

  useEffect(() => {
    if (params.model !== normalizedImageModel) {
      setParam('model', normalizedImageModel)
    }
  }, [normalizedImageModel, params.model, setParam])

  useEffect(() => {
    if (data.taskInfo?.loading) {
      setIsSubmitting(false)
    }
  }, [data.taskInfo?.loading])

  const handleAtKey = useCallback(() => {
    if (mentionCandidates.length === 0) return
    if (promptWrapRef.current) {
      const rect = promptWrapRef.current.getBoundingClientRect()
      setAtMenuPos({ x: rect.left, y: rect.bottom + 4 })
    }
    setActiveMentionIndex(0)
    setShowAtMenu(true)
  }, [mentionCandidates.length])

  const handleSelectMention = useCallback((chip: ChipRef) => {
    pushHistory()
    promptEditorRef.current?.insertChip(chip)
    setShowAtMenu(false)
  }, [pushHistory])

  const handleReferenceMention = useCallback((ref: NodeRef, index: number) => {
    const chip = mentionCandidates.find(candidate =>
      (ref.nodeId && candidate.nodeId === ref.nodeId) ||
      (ref.url && candidate.url === ref.url)
    ) ?? {
      nodeId: ref.nodeId || ref.url || `image-ref-${index + 1}`,
      url: ref.url,
      name: `图片${index + 1}`,
      mediaType: 'image' as const,
    }
    if (chip.url) handleSelectMention(chip)
  }, [handleSelectMention, mentionCandidates])

  // 手写 `image1` + 分隔符 → 自动换成对应的 @引用。对不上编号就返回 null，文字原样留着。
  const resolveTextMention = useCallback(
    (textBeforeCaret: string) => resolveTextMentionAt(textBeforeCaret, mentionCandidates),
    [mentionCandidates],
  )

  // 失焦时整段扫一遍：在已有文字中间插的 image1（后面直接跟汉字、没再敲键）
  // 和粘贴进来的提示词都靠这条兜住。
  const resolveTextMentionsIn = useCallback(
    (text: string) => resolveTextMentionsInText(text, mentionCandidates),
    [mentionCandidates],
  )

  const handleSyncTextPrompt = useCallback(() => {
    const text = textPromptFromRefs((params.textList as NodeRef[] | undefined)?.filter(r => r.nodeId), useCanvasStore.getState().nodes)
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    promptEditorRef.current?.setPlainText(text)
    updateNodeData(id, {
      params: {
        ...currentParams,
        prompt: text,
        promptChips: [],
        promptHtml: undefined,
      } as unknown as Record<string, unknown>,
    })
  }, [id, params, updateNodeData])

  const handleCopyPrompt = useCallback(async () => {
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const text = String(currentParams.prompt || '')
    if (!text.trim()) return
    try {
      await writeTextToClipboard(text)
    } catch (error) {
      console.warn('Copy image prompt failed', error)
    }
  }, [id, params])

  const handleClearPrompt = useCallback(() => {
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const hasPromptContent = Boolean(String(currentParams.prompt || '').trim()) ||
      Boolean((currentParams.promptChips as ChipRef[] | undefined)?.length) ||
      Boolean(currentParams.promptHtml)
    if (!hasPromptContent) return
    pushHistory()
    setShowAtMenu(false)
    promptEditorRef.current?.setPlainText('')
    updateNodeData(id, {
      params: {
        ...currentParams,
        prompt: '',
        promptChips: [],
        promptHtml: undefined,
      } as unknown as Record<string, unknown>,
    })
  }, [id, params, pushHistory, updateNodeData])

  const removeConnectedImageRef = useCallback((nodeId: string, url: string) => {
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const nextImageList = (currentParams.imageList ?? []).filter(ref =>
      nodeId ? ref.nodeId !== nodeId : ref.url !== url
    )
    if (nextImageList.length === (currentParams.imageList ?? []).length) return
    const chipRefs = [{ nodeId, url }]
    const nextImageListOrder = (currentParams.imageListOrder ?? []).filter(key => key !== nodeId)
    const nextParams = markPromptChipRefsMissingInParams({
      ...currentParams,
      imageList: nextImageList,
      imageListOrder: nextImageListOrder,
    }, chipRefs)
    pushHistory()
    promptEditorRef.current?.markChipsMissing(chipRefs)
    updateNodeData(id, {
      params: nextParams as unknown as Record<string, unknown>,
    })
    // 取消参考的同时把那根连线也断掉（2026-08-25 用户要求）。视频节点一直是这么做的，
    // 图片节点这里漏了 —— 引用没了线还挂着，看起来像还在参考。
    setEdges(edgesWithoutLink(useCanvasStore.getState().edges, nodeId, id))
  }, [id, params, pushHistory, setEdges, updateNodeData])

  const moveConnectedImageRef = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    const fromRef = connectedImages[fromIndex]
    const toRef = connectedImages[toIndex]
    const fromKey = fromRef?.nodeId || fromRef?.url
    const toKey = toRef?.nodeId || toRef?.url
    if (!fromKey || !toKey) return

    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const nextImageList = [...((currentParams.imageList ?? []) as NodeRef[])]
    const sourceIndex = nextImageList.findIndex(ref => (ref.nodeId || ref.url) === fromKey)
    const targetIndex = nextImageList.findIndex(ref => (ref.nodeId || ref.url) === toKey)
    if (sourceIndex === -1 || targetIndex === -1) return

    const [moved] = nextImageList.splice(sourceIndex, 1)
    nextImageList.splice(targetIndex, 0, moved)
    const nextImageListOrder = nextImageList
      .map(ref => ref.nodeId || ref.url)
      .filter((key): key is string => Boolean(key))

    updateNodeData(id, {
      params: {
        ...currentParams,
        imageList: nextImageList,
        imageListOrder: nextImageListOrder,
      } as unknown as Record<string, unknown>,
    })
  }, [connectedImages, id, params, updateNodeData])

  const handleMentionNavigate = useCallback((direction: 'up' | 'down') => {
    if (mentionCandidates.length === 0) return
    setActiveMentionIndex(current =>
      direction === 'down'
        ? (current + 1) % mentionCandidates.length
        : (current - 1 + mentionCandidates.length) % mentionCandidates.length
    )
  }, [mentionCandidates.length])

  const handleMentionSelect = useCallback(() => {
    const chip = mentionCandidates[activeMentionIndex]
    if (chip) handleSelectMention(chip)
  }, [activeMentionIndex, handleSelectMention, mentionCandidates])

  const setSettings = useCallback((key: string, val: string) => {
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const requestModel = normalizeImageModel(currentParams.model)
    updateNodeData(id, {
      params: {
        ...currentParams,
        settings: {
          ...currentParams.settings,
          [key]: key === 'ratio'
            ? normalizeImageRatioValue(requestModel, val)
            : key === 'resolution'
              ? normalizeImageResolutionValue(requestModel, val)
              : val,
        },
      } as unknown as Record<string, unknown>,
    })
  }, [id, params, updateNodeData])

  useEffect(() => {
    const nextRatio = normalizeImageRatioValue(normalizedImageModel, params.settings.ratio)
    const nextResolution = normalizeImageResolutionValue(normalizedImageModel, params.settings.resolution)
    const nextCount = normalizeImageGenerationCount(normalizedImageModel, params.count)
    if (nextRatio !== params.settings.ratio || nextResolution !== params.settings.resolution || nextCount !== params.count) {
      updateNodeData(id, {
        params: {
          ...params,
          count: nextCount,
          settings: {
            ...params.settings,
            ratio: nextRatio,
            resolution: nextResolution,
          },
        } as unknown as Record<string, unknown>,
      })
    }
  }, [id, normalizedImageModel, params, updateNodeData])

  const handleGenerate = useCallback(async () => {
    const freshNodes = useCanvasStore.getState().nodes
    const prompt = String(params.prompt || '').trim() || textPromptFromRefs(params.textList as NodeRef[] | undefined, freshNodes)
    if (isSubmitting || data.taskInfo?.loading) return
    if (!prompt) {
      setGenError('请先填写提示词，或连接一个文本节点作为提示词来源')
      return
    }
    setGenError(null)
    cancelRequestedRef.current = false
    setIsSubmitting(true)
    /** 药丸按 nodeId 对齐；引用里可能记的是 nodeKey，两个键都收，免得对不上就不换。 */
    const requestChipUrls: PromptChipLiveUrls = {}
    const freshImageRefs = ((params.imageList as NodeRef[] | undefined) ?? [])
      .map(ref => {
        const srcNode = freshNodes.find(n => n.id === ref.nodeId || n.data.nodeKey === ref.nodeId)
        // 发出去的是上游**当前的主图**，不是引用里存的快照，也不是 url[0]。
        const liveUrl = liveRefUrl(srcNode?.data as CanvasNodeData | undefined, ref.url)
        if (!liveUrl) return null
        if (ref.nodeId) requestChipUrls[ref.nodeId] = liveUrl
        if (srcNode?.id) requestChipUrls[srcNode.id] = liveUrl
        return {
          ...ref,
          nodeId: srcNode?.id ?? ref.nodeId,
          url: liveUrl,
          mediaType: 'image' as const,
        }
      })
      .filter((ref): ref is NodeRef => Boolean(ref?.url))
    const requestModeType: ImageParams['modeType'] = freshImageRefs.length ? (params.modeType || 'image2image') : 'text2image'
    const requestModel = normalizeImageModel(params.model)
    const requestRatio = normalizeImageRatioValue(requestModel, params.settings.ratio)
    const requestResolution = normalizeImageResolutionValue(requestModel, params.settings.resolution)
    const requestCount = normalizeImageGenerationCount(requestModel, params.count)
    // 提示词里的 @引用同样换成上游当前的主图 —— 服务端把 imageList 和 promptChips 的地址
    // 取并集当参考，漏掉药丸就会把旧图一起发出去。
    const requestParams = refreshPromptChipUrlsInParams({
      ...params,
      prompt,
      model: requestModel,
      count: requestCount,
      modeType: requestModeType,
      settings: {
        ...params.settings,
        ratio: requestRatio,
        resolution: requestResolution,
      },
      imageList: freshImageRefs,
      imageListOrder: freshImageRefs.map(ref => ref.nodeId),
    }, requestChipUrls)
    if (
      !String(params.prompt || '').trim() ||
      params.modeType !== requestModeType ||
      freshImageRefs.length !== (params.imageList ?? []).length ||
      params.model !== requestModel ||
      params.count !== requestCount ||
      params.settings.ratio !== requestRatio ||
      params.settings.resolution !== requestResolution ||
      requestParams.promptChips !== params.promptChips ||
      requestParams.promptHtml !== params.promptHtml
    ) {
      updateNodeData(id, { params: requestParams as unknown as Record<string, unknown> })
    }
    try {
      const res = await generateApi.image(
        data.projectUuid,
        id,
        requestParams as unknown as Record<string, unknown>
      )
      if (cancelRequestedRef.current) {
        void generateApi.cancel(res.jobId).catch(() => undefined)
        return
      }
      addTask(res.jobId, id, res.generationVersion)
      startPolling(res.jobId, data.projectUuid)
      setIsSubmitting(false)
    } catch (e: unknown) {
      setIsSubmitting(false)
      if (cancelRequestedRef.current) return
      const axErr = e as { response?: { data?: { error?: unknown } }; message?: string }
      setGenError(errorToText(axErr.response?.data?.error ?? axErr.message, '请求失败'))
    }
  }, [data.projectUuid, id, params, normalizedImageModel, nodes, updateNodeData, addTask, startPolling, isSubmitting, data.taskInfo?.loading])

  // Cindy "应用并生成": when this generation node is flagged, fire its own
  // generate exactly once (same path as a manual click), then clear the flag.
  const autoGenerateFiredRef = useRef(false)
  useEffect(() => {
    if (!data._autoGenerate) return
    // Already generating or has output (e.g. the flag survived a reload): clear
    // the flag and never (re)fire, so a refresh never double-charges.
    if (data.taskInfo?.loading || (Array.isArray(data.url) && data.url.length > 0)) {
      autoGenerateFiredRef.current = true
      updateNodeData(id, { _autoGenerate: undefined })
      return
    }
    if (autoGenerateFiredRef.current) return
    // Dependency-ordered "apply & generate": wait until upstream input nodes that
    // are themselves queued/generating have finished, so this node receives their
    // output (e.g. a video waits for its source image). Keep the flag while
    // waiting so our own downstream still treats us as pending; it is cleared only
    // once we actually start generating (the branch above), which closes the race
    // where a downstream might fire during the gap before loading is reflected.
    if (hasPendingUpstream(params as unknown as Record<string, unknown>, (nodeId) =>
      nodes.find(n => n.id === nodeId)?.data as CanvasNodeData | undefined)) return
    autoGenerateFiredRef.current = true
    void handleGenerate()
  }, [data._autoGenerate, data.taskInfo?.loading, data.url, handleGenerate, id, updateNodeData, nodes, params])

  const handleDownload = useCallback((url: string) => {
    const a = document.createElement('a')
    a.href = url
    a.download = data.name || url.split('/').pop() || 'image'
    a.click()
  }, [data.name])

  const imageResolutionLabel = imgSize ? `${imgSize.w} x ${imgSize.h}` : resolution
  const headerIconWidth = 22
  const headerNameWidth = collapsed ? 120 : 168
  const headerResolutionWidth = Math.max(70, Math.ceil(imageResolutionLabel.length * 7 + 18))
  const headerGap = 6
  const previewAspectW = imgSize?.w ?? currentRatioOption.w
  const previewAspectH = imgSize?.h ?? currentRatioOption.h
  const previewFrame = fitFrameToAspect(previewAspectW, previewAspectH, 520, 400, 240)
  const imageNodeWidth = Math.max(previewFrame.width, 220)
  const galleryGap = 8
  const expandedGalleryWidth = galleryItems.length > 1
    ? Math.round(Math.min(1180, Math.max(720, imageNodeWidth * 2 + galleryGap)))
    : imageNodeWidth
  const galleryColumnWidth = galleryItems.length > 1
    ? Math.floor((expandedGalleryWidth - galleryGap) / 2)
    : expandedGalleryWidth
  const galleryTileHeight = Math.max(150, Math.round(galleryColumnWidth * (previewAspectH / previewAspectW)))
  const collapsedNodeMinWidth = Math.max(220, headerIconWidth + headerNameWidth + headerResolutionWidth + headerGap * 2 + 16)
  const expandedNodeMinWidth = Math.max(360, headerIconWidth + 180 + headerResolutionWidth + headerGap * 2 + 16)
  const shellWidth = hasImage ? imageNodeWidth : Math.max(collapsedNodeMinWidth, imageNodeWidth)
  const displayedShellWidth = shellWidth
  const panorama = usePanoramaGeneration({
    id,
    data,
    sourceUrl: mainImageUrl ?? '',
    sourceName: data.name,
    shellWidth,
  })
  const repaint = useImageRepaint({
    id,
    data,
    sourceUrl: mainImageUrl,
    sourceName: data.name,
    shellWidth,
    initialModel: params.model,
  })
  const subjectMatting = useSubjectMatting({
    id,
    data,
    sourceUrl: mainImageUrl,
    sourceName: data.name,
    shellWidth,
  })
  // 色彩与灯光氛围迁移: create a dedicated processor node wired to this image as 原图.
  // The reference (氛围来源) is then supplied by connecting an image into its 参考图
  // handle; generation/editing lives on that node (no picker modal here anymore).
  const createAtmosphereNode = useCallback(() => {
    if (!mainImageUrl) return
    const selfNode = nodes.find(n => n.id === id)
    const outgoing = edges.filter(e => e.source === id).length
    const created = addNodeAt(
      'atmosphere_transfer',
      (selfNode?.position.x ?? 0) + shellWidth + 140,
      (selfNode?.position.y ?? 0) + outgoing * 44,
      {
        name: `${data.name || 'image'} 氛围迁移`,
        params: {
          sourceRef: { nodeId: id, url: mainImageUrl, name: String(data.name || '原图') },
          referenceRef: null,
        } as unknown as Record<string, unknown>,
      },
    )
    const edgeId = `e-${id}-${created.id}-source`
    if (!edges.some(e => e.id === edgeId)) {
      setEdges(addEdge({ id: edgeId, source: id, target: created.id, targetHandle: 'source', type: 'glow', selectable: true, interactionWidth: 34 }, edges))
    }
  }, [id, mainImageUrl, data.name, shellWidth, nodes, edges, addNodeAt, setEdges])

  const openWhiteboard = useCallback(async () => {
    if (!mainImageUrl || isWhiteboardPreparing) return
    setGenError(null)
    setWhiteboardLoadError(null)
    setWhiteboardSourceFile(null)
    setWhiteboardOpen(true)
    setIsWhiteboardPreparing(true)
    try {
      const file = await loadAssetFileFromUrl(mainImageUrl, data.name || 'image')
      setWhiteboardSourceFile(file)
    } catch (error) {
      const message = error instanceof Error ? error.message : '白板资源加载失败'
      setWhiteboardLoadError(message)
      setGenError(error instanceof Error ? error.message : '白板资源加载失败')
    } finally {
      setIsWhiteboardPreparing(false)
    }
  }, [data.name, isWhiteboardPreparing, mainImageUrl])

  const openCrop = useCallback(() => {
    if (!mainImageUrl || isCropPreparing) return
    setGenError(null)
    setCropSourceFile(null)
    setCropOpen(true)
  }, [isCropPreparing, mainImageUrl])

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
    const sourceRef = { nodeId: id, url: mainImageUrl, mediaType: 'image' as const }
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
              sourceUrl: mainImageUrl,
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
  }, [addNodeAt, data.name, data.projectUuid, edges, id, mainImageUrl, nodes, setEdges, shellWidth])

  const handleWhiteboardAccept = useCallback(async ({ dataUrl, snapshot }: { dataUrl: string; snapshot: unknown }) => {
    const file = await dataUrlToFile(dataUrl, data.name || 'image')
    const uploaded = await assetsApi.upload(data.projectUuid, file)
    const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
    const updatedAtMs = Date.now()
    const resultNodeId = whiteboardState?.resultNodeId
    const existingResultNode = resultNodeId ? nodes.find((node) => node.id === resultNodeId) : undefined
    const sourceNode = nodes.find((node) => node.id === id)
    const sourceRef = { nodeId: id, url: mainImageUrl, mediaType: 'image' as const }
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
        ...params,
        advancedSettings: writeWhiteboardState(advancedSettings, {
          snapshot,
          resultNodeId: resolvedResultNodeId,
          updatedAtMs,
        }),
      } as unknown as Record<string, unknown>,
    })

    setPreviewUrl(null)
    setWhiteboardOpen(false)
    setWhiteboardSourceFile(null)
  }, [addNodeAt, advancedSettings, data.name, data.projectUuid, edges, id, mainImageUrl, nodes, params, pushHistory, setEdges, shellWidth, updateNodeData, whiteboardState?.resultNodeId])

  const handleLightStageAccept = useCallback(async ({ state, prompt, ratio: lightRatio, resolution: lightResolution, geometryUrls }: LightStageAcceptPayload) => {
    if (isLightingApplying || !mainImageUrl) return
    setGenError(null)
    setIsLightingApplying(true)
    let createdNodeId: string | null = null
    try {
      const sourceNode = nodes.find((node) => node.id === id)
      const sourceRef = { nodeId: id, url: mainImageUrl, mediaType: 'image' as const }
      const requestRatio = normalizeImageRatioValue(LIGHT_STAGE_MODEL, lightRatio)
      const requestResolution = normalizeImageResolutionValue(LIGHT_STAGE_MODEL, lightResolution)
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
            sourceUrl: mainImageUrl,
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
        setGenError(message)
      }
    } finally {
      setIsLightingApplying(false)
    }
  }, [addNodeAt, addTask, data.name, data.projectUuid, edges, id, isLightingApplying, mainImageUrl, nodes, setEdges, shellWidth, startPolling, updateNodeData])

  const handleGridConfirm = useCallback(async ({ ratio: gridRatio, resolution: gridResolution }: { ratio: string; resolution: string }) => {
    if (!mainImageUrl || isGridSubmitting) return
    setGenError(null)
    setIsGridSubmitting(true)
    let createdNodeId: string | null = null
    try {
      const sourceNode = nodes.find((node) => node.id === id)
      const sourceRef = { nodeId: id, url: mainImageUrl, mediaType: 'image' as const }
      const gridParams = makeMultiCameraGridParams(sourceRef, gridRatio, gridResolution)
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
        setGenError(message)
      }
    } finally {
      setIsGridSubmitting(false)
    }
  }, [addNodeAt, addTask, data.projectUuid, edges, id, isGridSubmitting, mainImageUrl, nodes, setEdges, shellWidth, startPolling, updateNodeData])

  const isLoading = isSubmitting || !!data.taskInfo?.loading
  const isControlsPanelVisible = Boolean(isPanelActive && !expanded && !collapsed && portalRect)
  const showDetachedProgress = Boolean(isLoading && portalRect && !isControlsPanelVisible)
  const handleCancelGeneration = useCallback(() => {
    cancelRequestedRef.current = true
    const taskId = data.taskInfo?.taskId
    updateNodeData(id, { taskInfo: undefined })
    if (taskId) cancelTask(taskId, id)
    setIsSubmitting(false)
    setGenError(null)
  }, [cancelTask, data.taskInfo?.taskId, id, updateNodeData])
  const safeZoom = zoom || 1
  const inverseZoom = 1 / safeZoom
  const controlsPanelWidth = Math.max(420, expandedNodeMinWidth, portalRect ? portalRect.width / zoom : 0)
  const effectiveControlsPanelWidth = panelSize?.width ?? controlsPanelWidth
  const controlsPanelLeft = portalRect
    ? Math.max(
        12,
        Math.min(
          window.innerWidth - effectiveControlsPanelWidth - 12,
          portalRect.left + portalRect.width / 2 - effectiveControlsPanelWidth / 2
        )
      )
    : 12
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720
  const expandedControlsPanelWidth = Math.round(Math.min(
    viewportWidth - 48,
    Math.max(840, controlsPanelWidth * 2)
  ))
  const controlsPromptMaxHeight = panelExpanded
    ? Math.max(360, Math.min(640, viewportHeight - 300))
    : 132
  const expandedTileWidth = Math.max(1, Math.round(galleryRect?.width ?? imageNodeWidth))
  const expandedTileHeight = Math.max(1, Math.round(galleryRect?.height ?? previewFrame.height))
  const expandedGalleryPlacements = galleryRect
    ? expandedGalleryItems.map((item, index) => {
        const rightLeft = galleryRect.right + galleryGap
        const aboveTop = galleryRect.top - expandedTileHeight - galleryGap
        const aboveRightLeft = galleryRect.right + galleryGap

        let left = rightLeft
        let top = galleryRect.top
        if (index === 1) {
          left = galleryRect.left
          top = aboveTop
        } else if (index === 2) {
          left = aboveRightLeft
          top = aboveTop
        } else if (index > 2) {
          const extraIndex = index - 3
          const extraColumn = Math.floor(extraIndex / 2) + 2
          const extraRow = extraIndex % 2
          left = galleryRect.left + extraColumn * (expandedTileWidth + galleryGap)
          top = extraRow === 0 ? aboveTop : galleryRect.top
        }

        return {
          url: item.url,
          order: item.order,
          model: item.model,
          resolution: item.resolution,
          left,
          top,
        }
      })
    : []

  const commitNodeName = useCallback(() => {
    const nextName = nameDraft.trim() || 'image'
    setNameDraft(nextName)
    setIsRenaming(false)
    if (nextName !== data.name) updateNodeData(id, { name: nextName })
  }, [data.name, id, nameDraft, updateNodeData])

  const fixedTopLeft = (top: number, left: number): React.CSSProperties => ({
    position: 'absolute',
    top: top / safeZoom,
    left: left / safeZoom,
    transform: `scale(${inverseZoom})`,
    transformOrigin: 'top left',
  })

  const fixedTopRight = (top: number, right: number): React.CSSProperties => ({
    position: 'absolute',
    top: top / safeZoom,
    right: right / safeZoom,
    transform: `scale(${inverseZoom})`,
    transformOrigin: 'top right',
  })

  const fixedBottomRight = (bottom: number, right: number): React.CSSProperties => ({
    position: 'absolute',
    bottom: bottom / safeZoom,
    right: right / safeZoom,
    transform: `scale(${inverseZoom})`,
    transformOrigin: 'bottom right',
  })

  const floatingNodeControlBarStyle = (): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 1,
    height: 21,
    padding: 1,
    borderRadius: 7,
    background: 'linear-gradient(180deg, rgba(27,24,34,0.88), rgba(12,12,16,0.78))',
    border: '1px solid rgba(255,255,255,0.16)',
    boxShadow: '0 10px 24px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.08)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
  })

  const floatingNodeIconButtonStyle = (active = false): React.CSSProperties => ({
    width: 19,
    height: 19,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    border: active ? '1px solid rgba(255,255,255,0.56)' : '1px solid transparent',
    background: active ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.06)',
    color: active ? '#15111e' : '#f7f5ff',
    cursor: 'pointer',
    padding: 0,
  })

  const galleryActionButton = (variant: 'dark' | 'primary' = 'dark'): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    height: 20,
    border: variant === 'primary' ? '1px solid rgba(255,255,255,0.22)' : '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    padding: '0 6px',
    background: variant === 'primary' ? 'rgba(124,92,252,0.92)' : 'rgba(12,12,14,0.74)',
    color: '#fff',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
    boxShadow: '0 8px 18px rgba(0,0,0,0.24)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    whiteSpace: 'nowrap',
  })

  const galleryOrderBadge = (fixed = false): React.CSSProperties => ({
    ...(fixed ? fixedTopLeft(8, 8) : { position: 'absolute', top: 8, left: 8 }),
    zIndex: 13,
    minWidth: 26,
    height: 26,
    padding: '0 7px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'rgba(10,10,12,0.76)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 900,
    lineHeight: 1,
    boxShadow: '0 8px 20px rgba(0,0,0,0.3)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    pointerEvents: 'none',
  })

  const galleryMetaBadge = (fixed = false): React.CSSProperties => ({
    ...(fixed ? fixedBottomRight(8, 8) : { position: 'absolute', right: 8, bottom: 8 }),
    zIndex: 13,
    height: 23,
    maxWidth: 190,
    padding: '0 8px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    borderRadius: 7,
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(10,10,12,0.7)',
    color: '#eeeaf7',
    fontSize: 10.5,
    fontWeight: 750,
    lineHeight: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    boxShadow: '0 7px 18px rgba(0,0,0,0.28)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    opacity: 0.5,
    pointerEvents: 'none',
  })

  const galleryMetaContent = (item: GalleryItem) => (
    <>{galleryModelLabel(item.model)} · {item.resolution}</>
  )

  const previewResourceMeta = useMemo(() => {
    if (!previewUrl) return undefined
    return data._resourceMeta?.items?.find((item) => item.originalUrl === previewUrl || item.displayUrl === previewUrl) as ResourceMeta | undefined
  }, [data._resourceMeta, previewUrl])
  const previewGenerationMeta = previewUrl ? data._assetGenerationMeta?.[previewUrl] as AssetGenerationMeta | undefined : undefined
  const previewCreatedAtMs = previewUrl ? data._assetCreatedAtMs?.[previewUrl] : undefined
  // 多图节点：把整组图交给查看器，它才能出缩略图轨道和左右翻页。
  // 缩略图走 mediaPreviewUrl（画布用的小图），别拿原图当缩略图——一次渲染十几张原图会卡。
  const previewItems = useMemo<ImagePreviewItem[]>(() => galleryItems.map((item) => ({
    url: item.url,
    name: data.name,
    thumbUrl: mediaPreviewUrl(data, item.url),
    resourceMeta: data._resourceMeta?.items?.find(
      (meta) => meta.originalUrl === item.url || meta.displayUrl === item.url,
    ) as ResourceMeta | undefined,
    generationMeta: data._assetGenerationMeta?.[item.url] as AssetGenerationMeta | undefined,
    createdAtMs: data._assetCreatedAtMs?.[item.url],
    badge: item.resolution,
  })), [galleryItems, data])

  // 选中时贴在节点名字上方那一行（NodeShell 的 selectedMeta）。透明度由外壳统一给 50%，
  // 这里不再需要 paddingLeft —— 位置由外壳按「名字的左边缘」对齐。
  const resolutionMeta = (
    <span
      style={{
        color: '#c8bfe8',
        fontSize: 'calc(11px * var(--canvas-text-scale, 1))',
        lineHeight: 1.1,
      }}
    >
      {imageResolutionLabel}
    </span>
  )

  // 节点工具栏的动作。大图查看器里那排"图标+文字"的按钮用的是同一份，
  // 所以抽成变量而不是写在 JSX 里 —— 复制一份迟早会两边不一致。
  const mediaToolbarActions: MediaNodeToolbarAction[] = [
    {
      key: 'crop',
      label: isCropPreparing ? '正在打开裁剪' : '裁剪',
      icon: isCropPreparing
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <CropIcon size={14} strokeWidth={1.9} />,
      onClick: openCrop,
      disabled: isCropPreparing,
    },
    {
      key: 'whiteboard',
      label: isWhiteboardPreparing ? '正在打开白板' : '白板标注',
      icon: isWhiteboardPreparing
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <SquarePen size={14} strokeWidth={1.9} />,
      onClick: openWhiteboard,
      disabled: isWhiteboardPreparing,
    },
    {
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
      key: 'texture-clarity',
      label: '细化纹理',
      icon: <Wand2 size={14} strokeWidth={1.9} />,
      onClick: () => { if (mainImageUrl) setTextureClarityOpen(true) },
      disabled: !mainImageUrl,
    },
    {
      key: 'lighting',
      label: isLightingApplying ? '正在应用灯光' : '灯光',
      icon: isLightingApplying
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <Lightbulb size={14} strokeWidth={1.9} />,
      onClick: () => {
        if (!mainImageUrl) return
        const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
        setLightingAnchorRect(element?.getBoundingClientRect() ?? null)
        setLightingOpen(true)
      },
      disabled: isLightingApplying,
    },
    {
      key: 'atmosphere-transfer',
      label: '色彩与灯光氛围迁移',
      icon: <Palette size={14} strokeWidth={1.9} />,
      onClick: createAtmosphereNode,
      disabled: !mainImageUrl,
    },
    {
      key: 'multi-camera-grid',
      label: isGridSubmitting ? '正在生成九宫格' : '九宫格',
      icon: isGridSubmitting
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        : <Grid3X3 size={14} strokeWidth={1.9} />,
      onClick: () => mainImageUrl && setGridOpen(true),
      disabled: isGridSubmitting,
    },
    {
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
      disabled: panorama.submitting || !mainImageUrl,
    },
    {
      key: 'download',
      label: '下载',
      icon: <Download size={14} strokeWidth={1.9} />,
      onClick: () => mainImageUrl && handleDownload(mainImageUrl),
    },
{
  key: 'fullscreen',
  label: '全屏',
  icon: <Expand size={14} strokeWidth={1.9} />,
  onClick: () => mainImageUrl && setPreviewUrl(mainImageUrl),
},
  ]

  // Toolbar shown above node when image is selected
  const toolbar = isPanelActive && hasImage ? (
    <MediaNodeToolbar actions={mediaToolbarActions} />
  ) : undefined

  return (
    <>
    <div ref={nodeContainerRef} style={{ display: 'contents' }}>
    <NodeShell
      nodeKey={id}
      data={data}
      selected={selected}
      toolbar={toolbar}
      showFavoriteToolbarFallback={false}
      selectedMeta={resolutionMeta}
      showMenuButton={false}
      minWidth={shellWidth}
      maxWidth={displayedShellWidth}
      minHeight={hasImage ? 140 : previewFrame.height}
      bodyStyle={hasImage ? { background: 'transparent', overflow: 'visible' } : undefined}
    >

      {/* ── Image preview ── */}
      {hasImage ? (
        true ? (
          /* ── Collapsed: single main image ── */
          <div className="relative group shotflow-media-lod-shell shotflow-media-lod-image-shell"
            data-shotflow-expanded-gallery={expanded ? '1' : undefined}
            style={{ background: 'transparent', cursor: collapsed ? 'pointer' : 'default' }}
            onClick={collapsed ? () => setCollapsed(false) : undefined}
          >
            {/* Collapsed overlay: "点击展开" */}
            {false && collapsed && !isLoading && (
              <div style={{ ...fixedBottomRight(8, 8), zIndex: 8, pointerEvents: 'none' }}>
                <span style={{
                  fontSize: 11, color: '#c4b5fd', background: 'rgba(13,10,26,0.75)',
                  borderRadius: 4, padding: '2px 7px',
                }}>点击展开</span>
              </div>
            )}
            {/* Loading overlay — only covers the image area */}
            {isLoading && false && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 10,
                backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                background: 'rgba(13,10,26,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%, -50%) scale(${inverseZoom})`, transformOrigin: 'center' }}>
                <div className="nodrag flex items-center gap-2 px-4 py-2 rounded-full"
                  style={{ background: 'rgba(20,15,40,0.92)', border: '1px solid #312550' }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: 'spin 1s linear infinite' }}>
                    <circle cx="7" cy="7" r="5.5" stroke="#312550" strokeWidth="2" fill="none" />
                    <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" stroke="#7c5cfc" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </svg>
                  <span style={{ fontSize: 12, color: '#c4b5fd', whiteSpace: 'nowrap' }}>
                    生成中 {data.taskInfo?.progressPercent ?? 0}%
                  </span>
                  <button className="nodrag" onClick={() => {}} style={{
                    fontSize: 11, color: '#8a7aaa', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  }}>取消</button>
                </div>
                </div>
              </div>
            )}
            {isLoading && false && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 10,
                backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                background: 'rgba(13,10,26,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%, -50%) scale(${inverseZoom})`, transformOrigin: 'center' }}>
                  <GenerationProgress taskInfo={data.taskInfo} label="生成图片" onCancel={handleCancelGeneration} />
                </div>
              </div>
            )}
            {galleryItems.length > 1 && !expanded && expandedGalleryItems.slice(0, 3).map((item, layerIndex) => {
              const stackUrl = mediaPreviewUrl(data, item.url)
              const offset = layerIndex + 1
              const translateX = offset * 7
              const translateY = offset * 9
              return (
                <div
                  key={`${stackUrl}-${layerIndex}`}
                  className="shotflow-media-lod-content shotflow-media-lod-stack"
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 0,
                    borderRadius: 9,
                    border: '1px solid rgba(255,255,255,0.2)',
                    backgroundColor: '#ded9cc',
                    backgroundImage: `url("${stackUrl}")`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    opacity: 0.72 - layerIndex * 0.12,
                    filter: 'brightness(0.82) saturate(0.86)',
                    transform: `translate(${translateX}px, ${translateY}px) rotate(${offset * 1.25}deg)`,
                    transformOrigin: 'bottom right',
                    boxShadow: `${offset * 2}px ${offset * 6}px ${12 + offset * 7}px rgba(0,0,0,0.36)`,
                    pointerEvents: 'none',
                  }}
                />
              )
            })}
            <img
              ref={imgRef}
              src={mediaPreviewUrl(data, mainImageUrl)} alt=""
              className="w-full block shotflow-media-lod-content shotflow-image-node-main-media"
              draggable={false}
              loading="lazy"
              decoding="async"
              style={{
                position: 'relative',
                zIndex: 1,
                display: 'block',
                objectFit: 'contain',
                maxHeight: 400,
                cursor: 'zoom-in',
                borderRadius: 9,
                // Keep contain (no crop), but leave letterbox pixels transparent.
                // The dark backdrop looked like a real black edge on generated images.
                backgroundColor: 'transparent',
                boxShadow: galleryItems.length > 1 && !expanded ? '0 20px 32px rgba(0,0,0,0.32)' : undefined,
              }}
              onLoad={e => {
                const img = e.currentTarget
                setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
              }}
              onDoubleClick={() => mainImageUrl && setPreviewUrl(mainImageUrl)}
            />
            <div className="shotflow-media-lod-placeholder" aria-hidden="true">
              <NodeTypeIcon type="image" size={18} strokeWidth={1.8} />
              <span>图片</span>
            </div>
            {expanded && galleryItems.length > 1 && mainImageItem && (
              <>
                <div style={galleryOrderBadge(true)}>{mainImageItem.order}</div>
                <div style={galleryMetaBadge(true)}>{galleryMetaContent(mainImageItem)}</div>
              </>
            )}
            {/*
              细化纹理结果节点专属的小按钮，直接压在图片右上角。
              它只在这个节点真的是一次细化纹理的结果时出现（readTextureClarityResult 认得出），
              所以普通图片节点的右上角不会多东西。
              位置用 fixedTopRight：那几个 helper 会按画布缩放反向补偿，按钮在任何缩放下都是同样大小。
              多图角标也占右上角，虽然细化纹理结果只有一张图、实际不会同时出现，
              但真撞上时把这个按钮往左挪，别叠在一起。
            */}
            {textureClarityResult && (
              <div
                role="button"
                className="nodrag"
                title="看原图和细化结果的前后对比"
                style={{
                  ...fixedTopRight(4, galleryItems.length > 1 ? 62 : 4),
                  ...floatingNodeControlBarStyle(),
                  color: '#e8e2ff',
                  fontSize: 11,
                  fontWeight: 800,
                  lineHeight: 1,
                  cursor: 'pointer',
                  padding: '0 7px',
                  gap: 4,
                  zIndex: 12,
                }}
                onClick={event => {
                  event.stopPropagation()
                  setTextureClarityCompareOpen(true)
                }}
              >
                <GitCompare size={12} strokeWidth={2.2} />
                对比
              </div>
            )}
            {/* Multi-image badge */}
            {galleryItems.length > 1 && (
              <div
                role="button"
                className="nodrag"
                style={{
                  ...fixedTopRight(4, 4),
                  ...floatingNodeControlBarStyle(),
                  color: '#f7f5ff',
                  fontSize: 11,
                  cursor: 'pointer',
                  padding: '1px 6px 1px 1px',
                  fontWeight: 900,
                  zIndex: 12,
                  lineHeight: 1,
                }}
                onClick={event => {
                  event.stopPropagation()
                  setCollapsed(true)
                  setShowAtMenu(false)
                  setShowSettings(false)
                  setExpanded(value => {
                    const next = !value
                    if (!next) setGalleryLocked(false)
                    return next
                  })
                }}
              >
                <Expand size={13} strokeWidth={2.2} />
                {expanded && (
                <button
                  type="button"
                  title={galleryLocked ? '已锁定展开状态' : '锁定展开状态'}
                  style={{
                    ...floatingNodeIconButtonStyle(galleryLocked),
                  }}
                  onClick={event => {
                    event.stopPropagation()
                    setGalleryLocked(value => !value)
                  }}
                >
                  {galleryLocked ? <Lock size={11} strokeWidth={2.3} /> : <Unlock size={11} strokeWidth={2.3} />}
                </button>
                )}
                {expanded ? '收起' : `${galleryItems.length}张`}
              </div>
            )}
          </div>
        ) : (
          /* ── Expanded image gallery ── */
          <div style={{
            position: 'relative',
            background: 'transparent',
            display: 'grid',
            gridTemplateColumns: galleryItems.length > 1 ? '1fr 1fr' : '1fr',
            gap: galleryGap,
          }}>
            {galleryItems.map((item, i) => (
              <div key={item.url} className="relative group"
                style={{
                  position: 'relative',
                  overflow: 'hidden',
                  borderRadius: 9,
                  background: '#08070d',
                  boxShadow: '0 12px 26px rgba(0,0,0,0.28)',
                }}>
                <img
                  src={mediaPreviewUrl(data, item.url)} alt=""
                  className="w-full block"
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  style={{ objectFit: 'cover', height: galleryTileHeight, cursor: 'zoom-in', width: '100%' }}
                  onDoubleClick={() => setPreviewUrl(item.url)}
                />
                <div style={galleryOrderBadge()}>{item.order}</div>
                <div style={galleryMetaBadge()}>{galleryMetaContent(item)}</div>
                <div className="nodrag" style={{ ...fixedTopRight(4, 4), display: 'flex', gap: 3, zIndex: 12 }}>
                  <button
                    type="button"
                    style={galleryActionButton('dark')}
                    onClick={event => {
                      event.stopPropagation()
                       handleDownload(item.url)
                    }}
                  >
                    <Download size={13} strokeWidth={2} />
                    下载
                  </button>
                  {i === 0 ? (
                    <button
                      type="button"
                      style={galleryActionButton('dark')}
                      onClick={event => {
                        event.stopPropagation()
                        setExpanded(false)
                      }}
                    >
                      收起
                    </button>
                  ) : (
                    <button
                      type="button"
                      style={galleryActionButton('primary')}
                      onClick={event => {
                        event.stopPropagation()
                        setMainImage(item.url)
                      }}
                    >
                      设为主图
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div
          className="relative flex items-center justify-center"
          style={{
            minHeight: previewFrame.height,
            aspectRatio: `${previewAspectW} / ${previewAspectH}`,
            background: '#0d0b18',
            cursor: collapsed ? 'pointer' : 'default'
          }}
          onClick={collapsed ? () => setCollapsed(false) : undefined}
        >
          {isLoading && false ? (
            <div style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%, -50%) scale(${inverseZoom})`, transformOrigin: 'center' }}>
            <div className="nodrag flex items-center gap-2 px-4 py-2 rounded-full"
              style={{ background: 'rgba(20,15,40,0.92)', border: '1px solid #312550' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" style={{ animation: 'spin 1s linear infinite' }}>
                <circle cx="7" cy="7" r="5.5" stroke="#312550" strokeWidth="2" fill="none" />
                <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" stroke="#7c5cfc" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
              <span style={{ fontSize: 12, color: '#c4b5fd', whiteSpace: 'nowrap' }}>
                生成中 {data.taskInfo?.progressPercent ?? 0}%
              </span>
            </div>
            </div>
          ) : (
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" opacity={0.12}>
              <rect x="3" y="7" width="34" height="26" rx="3" stroke="#c4b5fd" strokeWidth="2" />
              <circle cx="14" cy="18" r="3.5" stroke="#c4b5fd" strokeWidth="2" />
              <path d="M3 28l10-8 8 8 6-5 10 9" stroke="#c4b5fd" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          )}
          {isLoading && false && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 5,
              backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
              background: 'rgba(13,10,26,0.52)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%, -50%) scale(${inverseZoom})`, transformOrigin: 'center' }}>
                <GenerationProgress taskInfo={data.taskInfo} label="生成图片" onCancel={handleCancelGeneration} />
              </div>
            </div>
          )}
          {false && collapsed && !isLoading && (
            <div style={{ ...fixedBottomRight(8, 8), pointerEvents: 'none' }}>
              <span style={{ fontSize: 11, color: '#c4b5fd', background: 'rgba(13,10,26,0.75)', borderRadius: 4, padding: '2px 7px' }}>
                点击展开
              </span>
            </div>
          )}
        </div>
      )}

      {/* Divider ref — marks the bottom edge of the image area for portal positioning */}
      <div ref={dividerRef} style={{ height: 0 }} />
    </NodeShell>
    </div>

      {showDetachedProgress && portalRect && createPortal(
        <div
          className="nodrag nopan"
          style={{
            position: 'fixed',
            top: portalRect.bottom + 6,
            left: portalRect.left + portalRect.width / 2,
            transform: 'translateX(-50%)',
            zIndex: 1050,
            pointerEvents: 'auto',
          }}
        >
          <GenerationProgress
            compact={portalRect.width < 260}
            taskInfo={data.taskInfo}
            label="生成图片"
            onCancel={handleCancelGeneration}
          />
        </div>,
        document.body
      )}

      {expanded && galleryRect && expandedGalleryPlacements.length > 0 && createPortal(
        <div
          ref={galleryPortalRef}
          className="nodrag"
          data-shotflow-expanded-gallery="1"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1300,
            pointerEvents: 'none',
          }}
        >
          {expandedGalleryPlacements.map(({ url, order, model, resolution, left, top }) => (
            <div
              key={`${url}-${order}`}
              className="relative group"
              style={{
                position: 'fixed',
                left,
                top,
                width: expandedTileWidth,
                height: expandedTileHeight,
                overflow: 'hidden',
                borderRadius: 9,
                background: '#08070d',
                boxShadow: '0 12px 26px rgba(0,0,0,0.28)',
                pointerEvents: 'auto',
              }}
            >
              <img
                src={mediaPreviewUrl(data, url)}
                alt=""
                className="w-full block"
                draggable={false}
                loading="lazy"
                decoding="async"
                style={{
                  objectFit: 'cover',
                  height: '100%',
                  cursor: 'zoom-in',
                  width: '100%',
                }}
                onDoubleClick={() => setPreviewUrl(url)}
              />
              <div style={galleryOrderBadge()}>{order}</div>
              <div style={galleryMetaBadge()}>{galleryMetaContent({ url, order, model, resolution })}</div>
              <div className="nodrag" style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 3, zIndex: 12 }}>
                <button
                  type="button"
                  style={galleryActionButton('dark')}
                  onClick={event => {
                    event.stopPropagation()
                    handleDownload(url)
                  }}
                >
                  <Download size={13} strokeWidth={2} />
                  下载
                </button>
                <button
                  type="button"
                  style={galleryActionButton('primary')}
                  onClick={event => {
                    event.stopPropagation()
                    setMainImage(url)
                  }}
                >
                  设为主图
                </button>
                <button
                  type="button"
                  title="删除"
                  style={{
                    ...galleryActionButton('dark'),
                    color: '#fecaca',
                    border: '1px solid rgba(248,113,113,0.36)',
                  }}
                  onClick={event => {
                    event.stopPropagation()
                    removeImageUrl(url)
                  }}
                >
                  <Trash2 size={13} strokeWidth={2} />
                </button>
              </div>
            </div>
          ))}
        </div>,
        document.body
      )}

      {/* ── Controls card — rendered as a portal so it stays fixed-size at any canvas zoom ── */}
      {isPanelActive && !expanded && !collapsed && portalRect && createPortal(
        <div
          ref={controlsPortalRef}
          className={panelExpanded ? 'nodrag shotflow-node-popover-backdrop' : 'nodrag shotflow-node-popover shotflow-node-popover-image'}
          onMouseDown={event => {
            if (panelExpanded && event.target === event.currentTarget) setPanelExpanded(false)
          }}
          style={panelExpanded ? {
            position: 'fixed',
            inset: 0,
            zIndex: 1800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: 'rgba(0,0,0,0.52)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          } : {
            position: 'fixed',
            top: portalRect.bottom + 6,
            left: controlsPanelLeft,
            width: effectiveControlsPanelWidth,
            ...(panelSize ? { height: panelSize.height, overflow: 'visible' } : {}),
            zIndex: 1000,
            background: '#171320',
            borderRadius: '0 0 9px 9px',
            border: '1px solid rgba(124,92,252,0.18)',
            borderTop: 'none',
            boxShadow: '0 10px 30px rgba(0,0,0,0.42)',
          }}
        >
        <div className="shotflow-node-popover-shell" style={panelExpanded ? {
          width: expandedControlsPanelWidth,
          maxHeight: '86vh',
          overflowY: 'auto',
          background: '#1a1625',
          borderRadius: 16,
          border: '1px solid #2d2040',
          boxShadow: '0 24px 80px rgba(0,0,0,0.68)',
        } : panelSize ? { height: '100%', overflow: 'hidden', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' } : {}}>
        <div className="shotflow-node-popover-gutter" style={{ padding: panelExpanded ? 12 : '0 6px 6px', ...(panelSize ? { height: '100%', minHeight: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column' } : {}) }}>
        <div className="shotflow-node-popover-content" style={{
          background: '#14111d', borderRadius: 10,
          border: '1px solid rgba(124,92,252,0.16)', overflow: 'hidden',
          ...(panelSize ? { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } : {}),
        }}>
          {/* Sub-toolbar row */}
          <div className="flex items-center gap-1 px-2 pt-1.5 pb-1.5 shotflow-node-popover-reference-row" style={panelSize ? { flexShrink: 0 } : undefined}>
            {connectedImages.map((ref, i) => (
              <div key={ref.nodeId || `${ref.url}-${i}`} className="relative nodrag reference-thumb"
                style={{ width: 44, height: 42, border: '1px solid rgba(124,92,252,0.18)', borderRadius: 7, flexShrink: 0, cursor: 'zoom-in', overflow: 'visible' }}
                draggable
                onDragStart={event => {
                  event.dataTransfer.setData('image-ref-index', String(i))
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={event => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  const fromIndex = Number(event.dataTransfer.getData('image-ref-index'))
                  if (Number.isFinite(fromIndex)) moveConnectedImageRef(fromIndex, i)
                }}
                onClick={() => setPreviewUrl(ref.url)}
                title={`预览图片${i + 1}`}
                onMouseEnter={e => scheduleHoverPreview(ref.nodeId, ref.url, `图片${i + 1}`, (e.currentTarget as HTMLElement).getBoundingClientRect())}
                onMouseLeave={() => hideHoverPreview(ref.nodeId)}
              >
                <img src={mediaPreviewUrl(nodes.find(node => node.id === ref.nodeId)?.data ?? data, ref.url)} alt="" draggable={false}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 7, display: 'block' }} />
                <button
                  type="button"
                  className="nodrag nopan reference-thumb-action is-at"
                  title="@引用"
                  aria-label="@引用"
                  onPointerDown={event => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onMouseDown={event => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    handleReferenceMention(ref, i)
                  }}
                  style={{
                    position: 'absolute',
                    left: -5,
                    bottom: -5,
                    zIndex: 3,
                    width: 17,
                    height: 17,
                    borderRadius: 999,
                    border: '1px solid rgba(225, 218, 255, 0.5)',
                    background: 'rgba(12, 18, 32, 0.18)',
                    color: 'rgba(246, 243, 255, 0.92)',
                    fontSize: 10,
                    fontWeight: 700,
                    lineHeight: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    boxShadow: '0 3px 10px rgba(0,0,0,0.32)',
                  }}
                >
                  @
                </button>
                <button
                  type="button"
                  className="nodrag nopan reference-thumb-action is-remove"
                  title="取消参考"
                  aria-label="取消参考"
                  onPointerDown={event => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onMouseDown={event => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onClick={event => {
                    event.preventDefault()
                    event.stopPropagation()
                    removeConnectedImageRef(ref.nodeId, ref.url)
                  }}
                  style={{
                    position: 'absolute',
                    top: -6,
                    right: -6,
                    width: 15,
                    height: 15,
                    borderRadius: '50%',
                    background: '#312550',
                    border: '1px solid #5a4080',
                    color: '#efeaff',
                    fontSize: 10,
                    lineHeight: 1,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    zIndex: 2,
                  }}
                >
                  ×
                </button>
                {/* "图片N" label at bottom */}
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0,
                  background: 'rgba(13,10,26,0.72)', fontSize: 8,
                  color: '#c4b5fd', textAlign: 'center', padding: '1px 0',
                }}>图片{i + 1}</div>
              </div>
            ))}
            <div style={{ flex: 1 }} />
          </div>

          {/* Prompt */}
          <div ref={promptWrapRef} className="shotflow-node-popover-prompt-area" style={{ padding: '0 10px 6px', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', ...(panelSize ? { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } : {}) }}>
            <div
              className="nodrag"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                minHeight: 24,
                marginBottom: 2,
              }}
            >
              <span className="shotflow-prompt-title" style={{ color: 'rgba(218,209,245,0.72)', fontSize: 11, fontWeight: 600 }}>
                提示词（{Array.from(String(params.prompt || '').replace(/\s/g, '')).length}字）
              </span>
              <div className="shotflow-prompt-actions" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {connectedTextRefs.length > 0 && (
                  <button
                    type="button"
                    className="nodrag"
                    disabled={!upstreamTextPrompt}
                    onClick={handleSyncTextPrompt}
                    style={{
                      border: '1px solid rgba(124,92,252,0.36)',
                      background: upstreamTextPrompt ? 'rgba(124,92,252,0.14)' : 'rgba(70,60,90,0.16)',
                      color: upstreamTextPrompt ? '#d8ccff' : '#6a5a8a',
                      borderRadius: 6,
                      padding: '2px 7px',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: upstreamTextPrompt ? 'pointer' : 'not-allowed',
                    }}
                    title={upstreamTextPrompt ? '同步上游文本节点内容' : '上游文本节点暂无内容'}
                  >
                    同步
                  </button>
                )}
                <button
                  type="button"
                  className="nodrag nopan shotflow-prompt-icon-button"
                  disabled={!String(params.prompt || '').trim()}
                  onMouseDown={e => e.stopPropagation()}
                  onClick={handleCopyPrompt}
                  title="复制提示词"
                  aria-label="复制提示词"
                >
                  <Copy size={12} strokeWidth={2.1} />
                </button>
                <button
                  type="button"
                  className="nodrag nopan shotflow-prompt-icon-button"
                  disabled={!String(params.prompt || '').trim() && chips.length === 0}
                  onMouseDown={e => e.stopPropagation()}
                  onClick={handleClearPrompt}
                  title="清空提示词"
                  aria-label="清空提示词"
                >
                  <Trash2 size={12} strokeWidth={2.1} />
                </button>
                <button
                  type="button"
                  className="nodrag"
                  onClick={() => {
                    setShowSettings(false)
                    setShowAtMenu(false)
                    setPanelExpanded(value => !value)
                  }}
                  title={panelExpanded ? '收起面板' : '展开面板'}
                  aria-label={panelExpanded ? '收起面板' : '展开面板'}
                  style={{
                    width: 24,
                    height: 24,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    padding: 0,
                    borderRadius: 6,
                    border: '1px solid rgba(124,92,252,0.24)',
                    background: panelExpanded ? 'rgba(124,92,252,0.16)' : 'rgba(36,28,54,0.5)',
                    color: panelExpanded ? '#d8ccff' : '#8f82b4',
                    cursor: 'pointer',
                  }}
                >
                  <Expand size={12} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="nodrag shotflow-node-popover-scroll" style={{
              maxHeight: panelSize ? 'none' : controlsPromptMaxHeight, overflowY: 'auto', overflowX: 'hidden',
              paddingRight: 3, scrollbarWidth: 'thin', scrollbarColor: '#312550 transparent',
              width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
              ...(panelSize ? { flex: '1 1 auto', minHeight: 0 } : {}),
            }}>
            <PromptEditor
              ref={promptEditorRef}
              value={params.prompt}
              chips={chips}
              htmlSnapshot={promptHtmlSnapshot}
              onChange={handlePromptChange}
              onAtKey={handleAtKey}
              onEscape={() => setShowAtMenu(false)}
              mentionMenuOpen={showAtMenu}
              onMentionNavigate={handleMentionNavigate}
              onMentionSelect={handleMentionSelect}
              orderMap={mentionOrderMap}
              resolveTextMention={resolveTextMention}
              resolveTextMentionsIn={resolveTextMentionsIn}
              placeholder="描述你想要生成的画面内容，@引用素材"
              style={{ fontSize: 13, lineHeight: 1.45, color: '#e8e1ff', minHeight: 52 }}
            />
            </div>{/* end scroll wrapper */}
            {showAtMenu && (
              <AtMentionDropdown
                pos={atMenuPos}
                candidates={mentionCandidates}
                onSelect={handleSelectMention}
                onClose={() => setShowAtMenu(false)}
                activeIndex={activeMentionIndex}
                onHoverIndex={setActiveMentionIndex}
              />
            )}
          </div>

          {/* Ratio / Resolution panel */}
          {false && showSettings && (
            <div style={{ padding: '0 14px 12px' }}>
              <div style={{ fontSize: 11, color: '#4a4060', marginBottom: 6 }}>分辨率</div>
              <div className="flex gap-1.5 mb-3">
                {resolutionOptions.map(r => (
                  <button key={r} className="flex-1 rounded-lg nodrag"
                    style={{
                      fontSize: 13, padding: '4px 0',
                      background: resolution === r ? '#7c5cfc' : '#1e1830',
                      color: resolution === r ? '#fff' : '#8a7aaa',
                      border: resolution === r ? 'none' : '1px solid #2a2040', cursor: 'pointer',
                    }}
                    onClick={() => { setSettings('resolution', r); setShowSettings(false) }}
                  >{r}</button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#4a4060', marginBottom: 6 }}>比例</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5 }}>
                {ratioOptions.map(r => {
                  const active = ratio === r.value
                  return (
                    <button key={r.value}
                      className="nodrag flex flex-col items-center justify-end gap-1 py-2 rounded-lg"
                      style={{
                        background: active ? 'rgba(124,92,252,0.15)' : '#1e1830',
                        border: active ? '1px solid #7c5cfc' : '1px solid #2a2040',
                        cursor: 'pointer', color: active ? '#c4b5fd' : '#6a5a8a',
                        fontSize: 11, minHeight: 52,
                      }}
                      onClick={() => { setSettings('ratio', r.value); setShowSettings(false) }}
                    >
                      <RatioIcon w={r.w} h={r.h} active={active} />
                      <span>{r.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Error */}
          {(genError || data.taskInfo?.status === 3) && (
            <div className="shotflow-node-popover-error" style={{ margin: '0 10px 5px', padding: '4px 8px', borderRadius: 7, background: '#2a1020', color: '#f87171', fontSize: 12, ...(panelSize ? { flexShrink: 0 } : {}) }}>
              {genError ?? errorToText(data.taskInfo?.error, '生成失败')}
            </div>
          )}

          {/* Bottom bar — LibLib TV style */}
          <div className="flex items-center nodrag shotflow-node-popover-bottom-bar" style={{
            borderTop: '1px solid rgba(124,92,252,0.12)', padding: '5px 8px', gap: 3,
            ...(panelSize ? { flexShrink: 0 } : {}),
          }}>
            {/* Model selector */}
            <select className="nodrag" value={normalizedImageModel} onChange={e => setParam('model', e.target.value)}
              style={{
                flex: '0 0 176px', width: 176, minWidth: 176, background: 'none', border: 'none',
                color: '#d1c6ff', fontSize: 12, cursor: 'pointer', outline: 'none',
                fontWeight: 500,
              }}
            >
              {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>

            <div style={{ width: 1, height: 14, background: '#2a2040', flexShrink: 0 }} />

            {/* Ratio · Res */}
            <button ref={settingsButtonRef} className="nodrag flex items-center gap-1" onClick={() => setShowSettings(v => !v)}
              style={{
                background: showSettings ? 'rgba(124,92,252,0.16)' : 'none',
                border: showSettings ? '1px solid rgba(124,92,252,0.5)' : '1px solid transparent',
                borderRadius: 7,
                color: showSettings ? '#d7ccff' : '#8a7aaa',
                fontSize: 12,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                padding: '3px 6px',
                boxShadow: showSettings ? '0 0 0 1px rgba(124,92,252,0.08) inset' : 'none',
              }}>
              <span
                style={{
                  width: 18,
                  height: 12,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <RatioIcon
                  w={currentRatioOption.w}
                  h={currentRatioOption.h}
                  active={showSettings}
                />
              </span>
              <span>{ratio === 'auto' ? '自适应' : ratio} · {resolution}</span>
              <span style={{ fontSize: 9, opacity: 0.5 }}>▾</span>
            </button>

            <div style={{ width: 1, height: 14, background: '#2a2040', flexShrink: 0 }} />

            {/* Count */}
            <select className="nodrag" value={normalizedCount} onChange={e => setParam('count', normalizeImageGenerationCount(normalizedImageModel, Number(e.target.value)))}
              style={{
                background: 'none',
                border: 'none',
                color: '#8a7aaa',
                fontSize: 12,
                cursor: 'pointer',
                outline: 'none',
                marginLeft: 'auto',
                width: 42,
                minWidth: 42,
                maxWidth: 42,
                textAlignLast: 'right',
              }}>
              {countOptions.map(n => <option key={n} value={n}>{n}张</option>)}
            </select>

            {/* Generate button */}
            <button className="nodrag flex items-center justify-center shotflow-node-primary-action"
              style={{
                width: 30, height: 30, flexShrink: 0, marginLeft: 3, borderRadius: 8,
                background: isLoading ? '#1e1830' : '#ffffff',
                border: 'none',
                cursor: isLoading ? 'default' : 'pointer',
                color: isLoading ? '#7c5cfc' : '#111',
                boxShadow: isLoading ? 'none' : '0 2px 8px rgba(0,0,0,0.25)',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { if (!isLoading) (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0' }}
              onMouseLeave={e => { if (!isLoading) (e.currentTarget as HTMLButtonElement).style.background = '#ffffff' }}
              onClick={handleGenerate} disabled={isLoading}
              title={isLoading ? `生成中 ${data.taskInfo?.progressPercent ?? 0}%` : '生成'}
            >
              {isLoading
                ? <svg width="15" height="15" viewBox="0 0 14 14" style={{ animation: 'spin 1s linear infinite' }}>
                    <circle cx="7" cy="7" r="5.5" stroke="#312550" strokeWidth="2" fill="none" />
                    <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" stroke="#7c5cfc" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </svg>
                : <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M8 13V3M8 3L4 7M8 3l4 4" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
              }
            </button>
        </div>
        {isLoading && (
          <div className="nodrag shotflow-node-popover-progress-row" style={{ padding: '0 8px 8px', ...(panelSize ? { flexShrink: 0 } : {}) }}>
            <GenerationProgress
              variant="panel"
              taskInfo={data.taskInfo}
              label="生成图片"
              onCancel={handleCancelGeneration}
            />
          </div>
        )}
        </div>
        </div>
        </div>
        {!panelExpanded && <ResizablePanelHandle onPointerDown={handlePanelResizeStart} />}
        </div>,
        document.body
      )}

      {showSettings && settingsRect && createPortal(
        <div
          ref={settingsPortalRef}
          className="nodrag shotflow-node-popover-settings"
          style={{
            position: 'fixed',
            top: settingsRect.top - 8,
            left: Math.max(12, settingsRect.left - 24),
            transform: 'translateY(-100%)',
            width: 320,
            zIndex: 1100,
            background: '#16121f',
            border: '1px solid #2d2248',
            borderRadius: 12,
            boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
            padding: '12px',
          }}
        >
          <div style={{ fontSize: 11, color: '#5a5070', marginBottom: 6 }}>分辨率</div>
          <div className="flex gap-1.5 mb-3">
            {resolutionOptions.map(r => (
              <button
                key={r}
                className="flex-1 rounded-lg nodrag"
                style={{
                  fontSize: 13,
                  padding: '6px 0',
                  background: resolution === r ? '#7c5cfc' : '#1e1830',
                  color: resolution === r ? '#fff' : '#8a7aaa',
                  border: resolution === r ? 'none' : '1px solid #2a2040',
                  cursor: 'pointer',
                }}
                onClick={() => setSettings('resolution', r)}
              >
                {r}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: '#5a5070', marginBottom: 6 }}>比例</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
            {ratioOptions.map(r => {
              const active = ratio === r.value
              return (
                <button
                  key={r.value}
                  className="nodrag flex flex-col items-center justify-end gap-1 py-2 rounded-lg"
                  style={{
                    background: active ? 'rgba(124,92,252,0.15)' : '#1e1830',
                    border: active ? '1px solid #7c5cfc' : '1px solid #2a2040',
                    cursor: 'pointer',
                    color: active ? '#c4b5fd' : '#6a5a8a',
                    fontSize: 11,
                    minHeight: 52,
                  }}
                  onClick={() => setSettings('ratio', r.value)}
                >
                  <RatioIcon w={r.w} h={r.h} active={active} />
                  <span>{r.label}</span>
                </button>
              )
            })}
          </div>
        </div>,
        document.body
      )}

      <HoverImagePreview entry={hoverPreview} />
      {previewUrl && <ImagePreview
        url={previewUrl}
        items={previewItems}
        onSetPrimary={setMainImage}
        primaryUrl={mainImageUrl}
        nodeActions={mediaToolbarActions}
        onRemoveItem={removeImageUrl}
        name={data.name}
        naturalWidth={imgSize?.w}
        naturalHeight={imgSize?.h}
        resourceMeta={previewResourceMeta}
        generationMeta={previewGenerationMeta}
        createdAtMs={previewCreatedAtMs}
        onClose={() => setPreviewUrl(null)}
      />}
      {panorama.viewer}
      {repaint.modal}
      {subjectMatting.modal}
      {cropOpen && mainImageUrl && (
        <ImageCropModal
          sourceName={data.name}
          sourceFile={cropSourceFile}
          sourceUrl={mainImageUrl}
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
          isPreparing={isWhiteboardPreparing}
          loadError={whiteboardLoadError}
          onCancel={() => {
            setWhiteboardOpen(false)
            setWhiteboardSourceFile(null)
            setWhiteboardLoadError(null)
          }}
          onAccept={handleWhiteboardAccept}
        />
      )}
      {/* 对比模式：只看已经生成好的东西，不需要 onGenerate，也不探任何服务 */}
      {textureClarityCompareOpen && textureClarityResult && data.projectUuid && (
        <TextureClarityEditor
          projectUuid={data.projectUuid}
          nodeKey={id}
          sourceUrl={textureClarityResult.sourceUrl}
          result={textureClarityResult}
          onClose={() => setTextureClarityCompareOpen(false)}
        />
      )}
      {textureClarityOpen && mainImageUrl && data.projectUuid && (
        <TextureClarityEditor
          projectUuid={data.projectUuid}
          nodeKey={id}
          sourceUrl={mainImageUrl}
          onClose={() => setTextureClarityOpen(false)}
          onGenerate={(assets, model) => {
            // 立刻在源节点右侧建一个「生成中」的图片节点，源节点一律不动（设计文档 §5）。
            // 连线不用手写：edgesFromNodeReferences 会从 params.imageList 里的 nodeId
            // 推导出边，addNode/addNodeAt 现在会当场重算，所以线立刻就在。
            // assets 可能是 null（没预览过控制素材），任务会自己先准备再修复。
            startTextureClarityRepair({
              projectUuid: data.projectUuid as string,
              sourceNodeId: id,
              sourceNodePos: nodeAbsPos,
              sourceUrl: mainImageUrl,
              assets,
              model,
            })
          }}
        />
      )}
      {lightingOpen && mainImageUrl && (
        <LightStageModal
          sourceName={data.name}
          sourceUrl={mainImageUrl}
          sourceNodeId={id}
          projectUuid={data.projectUuid}
          anchorRect={lightingAnchorRect}
          initialState={readLightStageState(advancedSettings.lightStage)}
          initialRatio={ratio}
          initialResolution="1K"
          busy={isLightingApplying}
          onCancel={() => setLightingOpen(false)}
          onAccept={handleLightStageAccept}
        />
      )}
      {gridOpen && mainImageUrl && (
        <ImageGridConfirmModal
          initialRatio={inferMultiCameraGridRatio(imgSize?.w, imgSize?.h, ratio)}
          busy={isGridSubmitting}
          onCancel={() => setGridOpen(false)}
          onConfirm={handleGridConfirm}
        />
      )}
    </>
  )
}
