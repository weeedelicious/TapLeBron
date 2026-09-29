import { useCallback, useRef, useState, useEffect, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { addEdge, useUpdateNodeInternals, useViewport, useStore } from '@xyflow/react'
import { Camera, Copy, Crop, Download, Expand, Gauge, Library, Loader2, Lock, Scissors, Sparkles, SquarePen, Trash2, Unlock, Wand2 } from 'lucide-react'
import { MediaNodeToolbar } from '@/components/MediaNodeToolbar'
import type { MediaNodeToolbarAction } from '@/components/MediaNodeToolbar'
import { GenerationProgress } from '@/components/GenerationProgress'
import { VideoCropModal } from '@/components/VideoCropModal'
import { VideoTrimModal } from '@/components/VideoTrimModal'
import { VideoFrameInterpolationModal, type VideoFrameInterpolationMethod } from '@/components/VideoFrameInterpolationModal'
import { VideoUiRemovalModal, type VideoUiRemovalMethod } from '@/components/VideoUiRemovalModal'
import { useMediaEnhance } from '@/features/media-enhance/useMediaEnhance'
import { WhiteboardModal } from '@/components/WhiteboardModal'
import { NodeShell } from './NodeShell'
import { NodeTypeIcon } from './nodeTypeIcon'
import { ResizablePanelHandle, readPanelSize, useResizablePanel, type PanelSize } from './ResizablePanelHandle'
import { HoverImagePreview } from '@/components/HoverImagePreview'
import { ImagePreview } from '@/components/ImagePreview'
import type { ImagePreviewItem } from '@/components/ImagePreview'
import { PromptEditor, buildPromptHtmlFromMentions } from '@/components/PromptEditor'
import type { ChipRef, PromptEditorHandle, PromptEditorSnapshot } from '@/components/PromptEditor'
import { resolveTextMentionAt, resolveTextMentionsIn as resolveTextMentionsInText } from '@/lib/promptTokenMention'
import { edgesWithoutLink } from '@/lib/referenceEdges'
import { useCanvasStore } from '@/store/canvasStore'
import { useTasksStore } from '@/store/tasksStore'
import { assetsApi, generateApi, toolboxApi } from '@/lib/api'
import { errorToText } from '@/lib/display'
import { defaultImageParams, defaultVideoParams, VIDEO_MODELS } from '@/lib/nodeData'
import { textPromptFromRefs } from '@/lib/textPrompt'
import {
  markPromptChipRefsMissingInParams,
  refreshPromptChipUrlsInHtml,
  refreshPromptChipUrlsInParams,
  type PromptChipLiveUrls,
} from '@/lib/promptChips'
import { liveRefUrl, primaryOutputUrl } from '@/lib/primaryOutput'
import { mediaPreviewUrl } from '@/lib/mediaPreview'
import { videoDownloadFileName } from '@/lib/videoFileName'
import { writeTextToClipboard } from '@/lib/clipboard'
import {
  VIDEO_RATIO_OPTIONS,
  getVideoDurationRule,
  getVideoGenerationCounts,
  getVideoModeOptions,
  getVideoModelRule,
  getVideoRatioOptions,
  getVideoRefRule,
  getVideoResolutionNote,
  getVideoResolutionOptions,
  videoRefCountError,
  videoReferenceNote,
  normalizeVideoDurationValue,
  normalizeVideoGenerationCount,
  normalizeVideoModeKey,
  normalizeVideoRatioValue,
  normalizeVideoResolutionValue,
  validateVideoCapability,
  type VideoModeKey,
} from '@/lib/videoRules'
import { popoverPlacement, type PopoverPlacement } from '@/lib/popoverFit'
import { modelPromptFromNodeParams } from '@/lib/modelPrompt'
import { SEEDANCE_PROMPT_SKILL_CATEGORIES, SEEDANCE_PROMPT_SKILLS, seedancePromptSkillById } from '@/lib/seedancePromptSkills'
import type { AssetGenerationMeta, CanvasNodeData, VideoParams, NodeRef, ResourceMeta, TaskInfo, FailedGeneration } from '@/lib/types'
import { hasPendingUpstream } from '@/lib/autoGenerate'
import {
  captureVideoFrameFile,
  captureVideoFrameFileFromUrl,
  dataUrlToFile,
  readWhiteboardState,
  resourceMetaFromUploadPayload,
  writeWhiteboardState,
} from '@/lib/whiteboard'
import {
  frameNumberFromTime,
  nextVideoFrameTime,
  resolveVideoFps,
} from '@/lib/videoFrame'

interface Props {
  id: string
  data: CanvasNodeData & { nodeKey: string; projectUuid: string }
  selected?: boolean
}

function getParams(data: CanvasNodeData): VideoParams {
  if (data.params) return data.params as unknown as VideoParams
  return defaultVideoParams()
}

type VideoMode = VideoModeKey

type PromptWashMode = 'conservative' | 'cinematic' | 'references' | 'timeline' | 'minimax'

type PromptWashTextChoice = 'opus' | 'luna'

const PROMPT_WASH_TEXT_CHOICES: Array<{ value: PromptWashTextChoice; label: string; model: string }> = [
  { value: 'opus', label: 'Opus', model: 'anthropic/claude-opus-5-5' },
  { value: 'luna', label: 'GPT Luna', model: 'gpt-5.6-luna' },
]

function promptWashTextModelId(value: unknown) {
  const raw = String(value || '').trim()
  return PROMPT_WASH_TEXT_CHOICES.find(item => item.value === raw || item.model === raw)?.model || PROMPT_WASH_TEXT_CHOICES[0].model
}

const PROMPT_WASH_MODES: Array<{ value: PromptWashMode; label: string; description: string }> = [
  { value: 'conservative', label: '保守优化', description: '保留原意，只补齐必要细节' },
  { value: 'cinematic', label: '电影化', description: '强化镜头、光影、节奏与声音' },
  { value: 'references', label: '参考素材强化', description: '明确 @图片/@视频 的职责' },
  { value: 'timeline', label: '时间轴分镜', description: '整理动作和镜头时间段' },
  { value: 'minimax', label: 'MiniMax 官方优化', description: '按 MiniMax 官方镜头指令与模型限制优化' },
]

function promptWashResultName(_sourceName: unknown, mode: PromptWashMode, choice: PromptWashTextChoice, skillId?: string) {
  const skillLabel = seedancePromptSkillById(skillId)?.shortName
  const modeLabel = skillLabel || PROMPT_WASH_MODES.find(item => item.value === mode)?.label || '保守优化'
  const modelLabel = choice === 'luna' ? 'Luna' : 'Opus'
  return '洗提示词_' + modeLabel + '_' + modelLabel
}

// 页面刷新后会重新挂载节点；这个集合只用于防止“当前页面”里原请求和
// 恢复 effect 重复提交，刷新后集合自然清空，节点上的持久化标记会触发恢复。
const activePromptWashNodeKeys = new Set<string>()

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

type GalleryItem = {
  url: string
  order: number
}

/** 生成按钮点一次后锁多久。只为防手抖连点，不等视频跑完。 */
const GENERATE_COOLDOWN_MS = 5000

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
  return sortable.map((item, index) => ({ url: item.url, order: index + 1 }))
}

function primaryGalleryItem(data: CanvasNodeData, items: GalleryItem[]) {
  const primaryUrl = typeof data._primaryAssetUrl === 'string' ? data._primaryAssetUrl : ''
  const firstUrl = (data.url ?? []).find((url): url is string => typeof url === 'string' && url.trim().length > 0)
  return items.find((item) => item.url === primaryUrl) ?? items.find((item) => item.url === firstUrl) ?? items[0]
}

function extensionFromUrl(url?: string) {
  const clean = String(url || '').split('#')[0].split('?')[0]
  const match = clean.match(/\.([a-z0-9]+)$/i)
  return match ? match[1].toLowerCase() : ''
}

function mimeTypeFromVideoExtension(extension?: string) {
  if (extension === 'mov') return 'video/quicktime'
  if (extension === 'mp4') return 'video/mp4'
  return undefined
}

function primaryVideoMeta(nodeData?: CanvasNodeData, fallbackUrl?: string): ResourceMeta | null {
  const rawItems = (nodeData?._resourceMeta?.items ?? []) as ResourceMeta[]
  const matchesUrl = (item: ResourceMeta) => {
    if (!fallbackUrl) return false
    return item.originalUrl === fallbackUrl || item.displayUrl === fallbackUrl
  }
  const videoMeta = rawItems.find((item) => item?.kind === 'video' && matchesUrl(item))
    ?? rawItems.find((item) => item?.kind === 'video')
    ?? null
  if (videoMeta) {
    return {
      ...videoMeta,
      extension: videoMeta.extension || extensionFromUrl(fallbackUrl),
      mimeType: videoMeta.mimeType || mimeTypeFromVideoExtension(videoMeta.extension || extensionFromUrl(fallbackUrl)),
    }
  }

  const extension = extensionFromUrl(fallbackUrl)
  if (!extension) return null
  return {
    kind: 'video',
    extension,
    mimeType: mimeTypeFromVideoExtension(extension),
  }
}

function videoPreviewSrc(url: string) {
  return url.includes('#') ? url : `${url}#t=0.001`
}

function videoPosterFromNode(nodeData: CanvasNodeData | undefined) {
  const poster = typeof nodeData?.poster === 'string' ? nodeData.poster.trim() : ''
  return poster || undefined
}

function ReferenceVideoCover({
  src,
  poster,
  iconSize = 13,
}: {
  src: string
  poster?: string
  iconSize?: number
}) {
  return (
    <>
      <video
        src={src}
        poster={poster || undefined}
        muted
        playsInline
        preload="metadata"
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#efeaff',
          background: 'linear-gradient(180deg, rgba(10,6,18,0.04), rgba(10,6,18,0.28))',
          pointerEvents: 'none',
        }}
      >
        <NodeTypeIcon type="video" size={iconSize} />
      </div>
    </>
  )
}

function floatingNodeControlBarStyle(): React.CSSProperties {
  return {
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
  }
}

function floatingNodeTextButtonStyle(active = false, minWidth = 46): React.CSSProperties {
  return {
    minWidth,
    height: 19,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    border: active ? '1px solid rgba(255,255,255,0.52)' : '1px solid transparent',
    background: active ? 'rgba(255,255,255,0.94)' : 'rgba(255,255,255,0.06)',
    color: active ? '#14111f' : '#f7f5ff',
    fontSize: 11,
    fontWeight: 900,
    lineHeight: 1,
    padding: '0 6px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}

function floatingNodeIconButtonStyle(active = false, disabled = false): React.CSSProperties {
  return {
    width: 19,
    height: 19,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    border: active ? '1px solid rgba(255,255,255,0.56)' : '1px solid transparent',
    background: active ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.06)',
    color: active ? '#15111e' : '#f7f5ff',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.66 : 1,
    padding: 0,
  }
}

function videoGalleryActionButton(kind: 'dark' | 'primary'): React.CSSProperties {
  const primary = kind === 'primary'
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    height: 20,
    borderRadius: 6,
    border: primary ? '1px solid rgba(255,255,255,0.22)' : '1px solid rgba(255,255,255,0.14)',
    background: primary ? 'rgba(124,92,252,0.86)' : 'rgba(10,10,12,0.72)',
    color: '#fff',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
    padding: '0 6px',
    boxShadow: '0 8px 18px rgba(0,0,0,0.26)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    whiteSpace: 'nowrap',
  }
}

type ConnectedMediaRef = NodeRef & {
  orderName: string
  previewKind: 'image' | 'video' | 'audio'
  poster?: string
  coverSrc?: string
}

export function VideoNode({ id, data, selected }: Props) {
  const { addNodeAt, updateNodeData, nodes, edges, setEdges, selectedNodeKeys, activePanelNodeId, setActivePanelNode, setSelected, pushHistory, persistNodesAndWait } = useCanvasStore()
  const { addTask, startPolling, cancelTask } = useTasksStore()
  /** 真正还在轮询的任务表。进度条只信这个，不信节点上残留的 loading 标记。 */
  const liveTasks = useTasksStore(state => state.tasks)
  const initialPanelSize = readPanelSize((getParams(data).advancedSettings as Record<string, unknown> | undefined)?.bottomPanelSize)
  const videoRef = useRef<HTMLVideoElement>(null)
  const hoverPreviewMutedRef = useRef(false)
  const editorRef = useRef<PromptEditorHandle>(null)
  const promptPanelRef = useRef<HTMLDivElement>(null)
  const [showSettings, setShowSettings] = useState(false)
  const bottomWrapRef = useRef<HTMLDivElement | null>(null)
  const settingsPopoverRef = useRef<HTMLDivElement | null>(null)
  const promptWashWrapRef = useRef<HTMLDivElement | null>(null)
  const promptSkillWrapRef = useRef<HTMLDivElement | null>(null)
  /** 设置弹层的锚点（底栏在屏幕上的位置）；null = 弹层没开 */
  const [settingsAnchor, setSettingsAnchor] = useState<{ left: number; width: number; top: number; bottom: number } | null>(null)
  /** 弹层最终的定位：往上（bottom）还是往下（top），装不下时才带 maxHeight */
  const [settingsPlacement, setSettingsPlacement] = useState<PopoverPlacement>({})
  const [genError, setGenError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isTranslating, setIsTranslating] = useState(false)
  const [nameDraft, setNameDraft] = useState(data.name)
  const [isRenaming, setIsRenaming] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  /**
   * 视频大图查看器。跟上面那个 previewUrl 分开：previewUrl 预览的是**连进来的参考图**
   * （图片，走 <img>），这个装的是本节点自己的视频。合用一个 state 就会出现
   * 拿 <img> 渲染 mp4 或者拿 <video> 渲染 png 的情况。
  */
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null)
  /** 同一 URL 只跑一个 ffprobe 请求；成功后结果会进入节点元数据，后续无需再探测。 */
  const videoMetaProbeRequestsRef = useRef<Map<string, Promise<ResourceMeta | null>>>(new Map())
  const [whiteboardOpen, setWhiteboardOpen] = useState(false)
  const [whiteboardSourceFile, setWhiteboardSourceFile] = useState<File | null>(null)
  const [whiteboardPreparing, setWhiteboardPreparing] = useState(false)
  const [whiteboardError, setWhiteboardError] = useState<string | null>(null)
  const [cropOpen, setCropOpen] = useState(false)
  const [cropSubmitting, setCropSubmitting] = useState(false)
  const [trimOpen, setTrimOpen] = useState(false)
  const [trimSubmitting, setTrimSubmitting] = useState(false)
  const [frameInterpolationOpen, setFrameInterpolationOpen] = useState(false)
  const [frameInterpolationSubmitting, setFrameInterpolationSubmitting] = useState(false)
  const [uiRemovalOpen, setUiRemovalOpen] = useState(false)
  const [uiRemovalSubmitting, setUiRemovalSubmitting] = useState(false)
  const [frameMode, setFrameMode] = useState(false)
  const [frameNumber, setFrameNumber] = useState(1)
  const [frameCapturing, setFrameCapturing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [galleryLocked, setGalleryLocked] = useState(false)
  const [panelExpanded, setPanelExpanded] = useState(false)
  const [panelSize, setPanelSize] = useState<PanelSize | null>(() => initialPanelSize)
  const [promptWashOpen, setPromptWashOpen] = useState(false)
  const [promptWashHoverMode, setPromptWashHoverMode] = useState<PromptWashMode | null>(null)
  const [promptWashModelMenu, setPromptWashModelMenu] = useState<PromptWashMode | null>(null)
  const [promptSkillOpen, setPromptSkillOpen] = useState(false)
  const [promptSkillCategory, setPromptSkillCategory] = useState(SEEDANCE_PROMPT_SKILL_CATEGORIES[0]?.id || 'structure')
  const [promptSkillHoverId, setPromptSkillHoverId] = useState<string | null>(null)
  const [promptSkillMenu, setPromptSkillMenu] = useState<string | null>(null)

  useEffect(() => {
    if (data.taskInfo?.loading) {
      setIsSubmitting(false)
    }
  }, [data.taskInfo?.loading])

  /**
   * 生成按钮的短冷却。
   *
   * 以前按钮是 disabled={isSubmitting || taskInfo.loading} —— 视频要跑几分钟，这几分钟里
   * 按钮一直是灰的。现在改成只锁 5 秒（防手抖连点），5 秒后就算上一次还在跑也能再点。
   *
   * 注意这不是"排队跑两个"：节点的 taskInfo 只存一个任务，再点一次会把它顶掉，
   * 于是**上一次的结果生成完也不会被采用**（tasksStore 的 isCurrentTask 按 taskId 比对，
   * 服务端还会把旧任务标成 shouldApply=false）。所以按钮 title 里会写明这一点。
   */
  const [generateCooldown, setGenerateCooldown] = useState(false)
  const cooldownTimerRef = useRef<number | undefined>(undefined)
  const startGenerateCooldown = useCallback(() => {
    window.clearTimeout(cooldownTimerRef.current)
    setGenerateCooldown(true)
    cooldownTimerRef.current = window.setTimeout(() => setGenerateCooldown(false), GENERATE_COOLDOWN_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(cooldownTimerRef.current), [])
  const [hoverThumb, setHoverThumb] = useState<{ url: string; name: string; rect: DOMRect; kind?: 'image' | 'video' } | null>(null)
  const [atMenu, setAtMenu] = useState(false)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const dividerRef = useRef<HTMLDivElement>(null)
  const videoAreaRef = useRef<HTMLDivElement>(null)
  const panelPortalRef = useRef<HTMLDivElement>(null)
  const galleryPortalRef = useRef<HTMLDivElement>(null)
  const updateNodeInternals = useUpdateNodeInternals()

  const { zoom, x: vpX, y: vpY } = useViewport()
  const nodeAbsPos = useStore(s => (s.nodeLookup as Map<string, { internals?: { positionAbsolute?: { x: number; y: number } } }>)?.get(id)?.internals?.positionAbsolute)
  const [portalRect, setPortalRect] = useState<DOMRect | null>(null)
  const [galleryRect, setGalleryRect] = useState<DOMRect | null>(null)
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
  const handlePanelResizeStart = useResizablePanel(panelPortalRef, setPanelSize, {
    minWidth: 520,
    minHeight: 220,
    onResizeEnd: persistPanelSize,
  })

  const isGenerateVideoNode = data.action === 'video_generate'
  const isPanelOpen = Boolean(isPanelActive && isGenerateVideoNode)

  useLayoutEffect(() => {
    setPortalRect(dividerRef.current?.getBoundingClientRect() ?? null)
  }, [isPanelOpen, zoom, vpX, vpY, nodeAbsPos?.x, nodeAbsPos?.y])

  useLayoutEffect(() => {
    if (!expanded) { setGalleryRect(null); return }
    setGalleryRect(videoRef.current?.getBoundingClientRect() ?? null)
  }, [expanded, zoom, vpX, vpY, nodeAbsPos?.x, nodeAbsPos?.y, videoSize?.w, videoSize?.h, data.url?.length])

  // Force React Flow to re-measure handles after collapse/expand
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, isPanelOpen, updateNodeInternals])

  useEffect(() => {
    if (!isPanelOpen) {
      setShowSettings(false)
      setAtMenu(false)
      setHoverThumb(null)
      setPanelExpanded(false)
      setPromptWashOpen(false)
      setPromptWashModelMenu(null)
      setPromptSkillOpen(false)
      setPromptSkillMenu(null)
    }
  }, [isPanelOpen])

  /** 量设置弹层的锚点（底栏），弹层 portal 到 body 后靠它定位 */
  useLayoutEffect(() => {
    if (!showSettings) {
      setSettingsAnchor(null)
      return
    }
    const measure = () => {
      const wrap = bottomWrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      setSettingsAnchor({ left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [showSettings, panelSize?.height, panelExpanded, expanded, zoom, vpX, vpY, portalRect?.top, portalRect?.left])


  useEffect(() => {
    if (!isPanelOpen || panelSize) return
    const savedSize = readPanelSize((getParams(data).advancedSettings as Record<string, unknown> | undefined)?.bottomPanelSize)
    if (savedSize) setPanelSize(savedSize)
  }, [data, isPanelOpen, panelSize])

  useEffect(() => {
    if (!expanded) return
    const handler = (event: MouseEvent) => {
      if (galleryLocked) return
      const target = event.target as Node
      if (
        videoAreaRef.current?.contains(target) ||
        galleryPortalRef.current?.contains(target)
      ) return
      setExpanded(false)
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [expanded, galleryLocked])

  useEffect(() => {
    if (!promptWashOpen && !promptSkillOpen) return
    const handler = (event: MouseEvent) => {
      const target = event.target as Node
      if (promptWashWrapRef.current?.contains(target) || promptSkillWrapRef.current?.contains(target)) return
      setPromptWashOpen(false)
      setPromptWashModelMenu(null)
      setPromptSkillOpen(false)
      setPromptSkillMenu(null)
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [promptWashOpen, promptSkillOpen])

  useEffect(() => {
    if (!isPanelActive) {
      if (!galleryLocked) setExpanded(false)
      setPanelExpanded(false)
    }
  }, [galleryLocked, isPanelActive])

  const hoverTimerRef = useRef<number | null>(null)
  const activeHoverKeyRef = useRef<string | null>(null)

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
    setHoverThumb(null)
  }, [clearHoverTimer])

  const scheduleHoverPreview = useCallback((key: string, url: string, name: string, rect: DOMRect, kind: 'image' | 'video' = 'image') => {
    clearHoverTimer()
    activeHoverKeyRef.current = key
    hoverTimerRef.current = window.setTimeout(() => {
      if (activeHoverKeyRef.current !== key) return
      setHoverThumb({ url, name, rect, kind })
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

  const params = getParams(data)
  const advancedSettings = (params.advancedSettings ?? {}) as Record<string, unknown>
  const whiteboardState = readWhiteboardState(advancedSettings)
  const model = params.model || 'Seedance_2_0'
  const mode = normalizeVideoModeKey(params.modeType as string | undefined)
  const modeOptions = getVideoModeOptions(model)
  const ratioOptions = getVideoRatioOptions(model, mode)
  const resolutionOptions = getVideoResolutionOptions(model)
  const durationRule = getVideoDurationRule(model, mode)
  const urls = data.url ?? []
  const videoUrls = urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
  const galleryItems = galleryItemsFromNodeData(data)
  const mainVideoItem = primaryGalleryItem(data, galleryItems)
  const videoUrl = mainVideoItem?.url
  const expandedVideoItems = galleryItems.filter((item) => item.url !== videoUrl)
  const currentVideoMeta = primaryVideoMeta(data, videoUrl)
  const displayVideoUrl = mediaPreviewUrl(data, videoUrl)
  const currentVideoGenerationMeta = videoUrl
    ? data._assetGenerationMeta?.[videoUrl] as AssetGenerationMeta | undefined
    : undefined
  // HTMLVideoElement doesn't expose FPS, so prefer the persisted ffprobe value
  // and then the generation metadata. The modal still lets the server re-probe
  // the real source before starting a task.
  const sourceFpsHint = Number(
    currentVideoMeta?.fps || currentVideoGenerationMeta?.fps || currentVideoGenerationMeta?.targetFps || 0,
  ) || undefined
  const frameFps = resolveVideoFps(sourceFpsHint)
  const sourceWidthHint = Number(currentVideoMeta?.width || currentVideoMeta?.displayWidth || 0) || undefined
  const sourceHeightHint = Number(currentVideoMeta?.height || currentVideoMeta?.displayHeight || 0) || undefined
  const sourceDurationHint = Number(currentVideoMeta?.durationSec || currentVideoMeta?.displayDurationSec || currentVideoGenerationMeta?.durationSec || 0) || undefined
  const frameInterpolationParams = (params as unknown as Record<string, unknown>).frameInterpolation
  const isFrameInterpolationNode = Boolean(frameInterpolationParams && typeof frameInterpolationParams === 'object')

  const ratio = normalizeVideoRatioValue(model, params.settings.ratio, mode)
  const resolution = normalizeVideoResolutionValue(model, params.settings.resolution)
  const duration = normalizeVideoDurationValue(model, params.settings.duration, mode)
  const sound = params.settings.enableSound ?? 'on'

  /**
   * 决定设置弹层往上还是往下展开。目标是**完整显示**：
   * 上方装得下就往上（习惯位置）；装不下但下方装得下就翻到下方；
   * 两边都装不下才取空间大的一侧限高滚动 —— 那是兜底，不是常态。
   * 放在这里是因为要用到 resolutionOptions / ratioOptions（选项数量决定内容高度），
   * 它们在上面才声明；同时仍在任何早退之前，不会动到 hook 数量。
   */
  useLayoutEffect(() => {
    if (!showSettings || !settingsAnchor) return
    const element = settingsPopoverRef.current
    setSettingsPlacement(popoverPlacement({
      anchorTop: settingsAnchor.top,
      anchorBottom: settingsAnchor.bottom,
      contentHeight: element ? element.scrollHeight : 0,
      viewportHeight: typeof window === 'undefined' ? 800 : window.innerHeight,
    }))
  }, [showSettings, settingsAnchor, resolutionOptions.length, ratioOptions.length])
  const durationLockedToInput = durationRule.min === durationRule.max && durationRule.default === durationRule.min && durationRule.min < 0
  const durationLabel = durationLockedToInput ? '跟随输入视频' : `${duration}s`

  // Auto-sync: resolve live URLs + assign order-based names 鈥?memoized to avoid nodes.find per render
  const connectedImageRefs = useMemo(
    () => {
      const refs = (params.imageList as NodeRef[] | undefined)?.filter(r => r.nodeId) ?? []
      const order = (params.imageListOrder as string[] | undefined) ?? []
      if (order.length === 0) return refs
      const indexByNodeId = new Map(order.map((nodeId, index) => [nodeId, index]))
      return [...refs].sort((a, b) => {
        const ai = indexByNodeId.get(a.nodeId) ?? Number.MAX_SAFE_INTEGER
        const bi = indexByNodeId.get(b.nodeId) ?? Number.MAX_SAFE_INTEGER
        return ai - bi
      })
    },
    [params.imageList, params.imageListOrder]
  )
  /**
   * 参考素材一律解析成上游**当前的主图 / 主视频**（liveRefUrl），不是 url[0]。
   * 以前取 url[0] 等于永远拿上游第一次生成的那个，在源节点点「设为主图 / 设为主视频」
   * 之后这里不跟着换 —— 2026-08-25 用户报的就是这个。上游被删掉时退回引用里的快照。
   */
  const connectedImages = useMemo<ConnectedMediaRef[]>(() =>
    connectedImageRefs.map((ref, i) => {
      const srcNode = nodes.find(n => n.id === ref.nodeId)
      const liveUrl = liveRefUrl(srcNode?.data as CanvasNodeData, ref.url)
      return { ...ref, url: liveUrl, orderName: `图片${i + 1}`, previewKind: 'image' as const }
    }).filter(r => r.url),
    [connectedImageRefs, nodes]
  )
  const generationCount = normalizeVideoGenerationCount(model, params.count, connectedImages.length > 0, resolution)
  const generationCountOptions = getVideoGenerationCounts(model, connectedImages.length > 0, resolution)
  const canChooseGenerationCount = generationCountOptions.length > 1

  const connectedVideoRefs = useMemo(
    () => (params.videoList as NodeRef[] | undefined)?.filter(r => r.nodeId) ?? [],
    [params.videoList]
  )
  const connectedVideos = useMemo<ConnectedMediaRef[]>(() =>
    connectedVideoRefs.map((ref, i) => {
      const srcNode = nodes.find(n => n.id === ref.nodeId)
      const liveUrl = liveRefUrl(srcNode?.data as CanvasNodeData, ref.url)
      const nodeData = (srcNode?.data ?? data) as CanvasNodeData
      return {
        ...ref,
        url: liveUrl,
        orderName: `视频${i + 1}`,
        previewKind: 'video' as const,
        poster: videoPosterFromNode(srcNode?.data as CanvasNodeData | undefined),
        coverSrc: videoPreviewSrc(mediaPreviewUrl(nodeData, liveUrl)),
      }
    }).filter(r => r.url),
    [connectedVideoRefs, data, nodes]
  )

  const connectedAudioRefs = useMemo(
    () => (params.audioList as NodeRef[] | undefined)?.filter(r => r.nodeId) ?? [],
    [params.audioList]
  )
  const connectedAudios = useMemo<ConnectedMediaRef[]>(() =>
    connectedAudioRefs.map((ref, i) => {
      const srcNode = nodes.find(n => n.id === ref.nodeId)
      const liveUrl = liveRefUrl(srcNode?.data as CanvasNodeData, ref.url)
      return { ...ref, url: liveUrl, orderName: `音频${i + 1}`, previewKind: 'audio' as const }
    }).filter(r => r.url),
    [connectedAudioRefs, nodes]
  )
  const connectedTextRefs = useMemo(
    () => (params.textList as NodeRef[] | undefined)?.filter(r => r.nodeId) ?? [],
    [params.textList]
  )
  const upstreamTextPrompt = useMemo(
    () => textPromptFromRefs(connectedTextRefs, nodes),
    [connectedTextRefs, nodes]
  )

  const connectedMedia = useMemo(
    () => [...connectedImages, ...connectedVideos, ...connectedAudios],
    [connectedImages, connectedVideos, connectedAudios]
  )

  /**
   * 当前模式**用不上**的那几类参考素材（2026-08-26 用户反馈）。
   *
   * 连线是跨模式共用的：在「多模态」里连了参考图，切到「视频编辑」那张图还挂着，
   * 但这个模式一张图都不收 —— 以前要点了生成才知道，而且报的是
   * 「视频编辑最多支持 0 个图片参考」。现在缩略图上直接标出来，点之前就看得见。
   */
  const unusableRefKinds = useMemo(() => ({
    images: connectedImages.length > 0 && getVideoRefRule(model, mode, 'images').max === 0,
    videos: connectedVideos.length > 0 && getVideoRefRule(model, mode, 'videos').max === 0,
    audios: connectedAudios.length > 0 && getVideoRefRule(model, mode, 'audios').max === 0,
  }), [connectedAudios.length, connectedImages.length, connectedVideos.length, mode, model])

  /** 参考素材超限 / 不支持时的那句话，点生成之前就显示出来。 */
  const refKindWarning = useMemo(() => (
    videoRefCountError(model, mode, 'images', connectedImages.length) ||
    videoRefCountError(model, mode, 'videos', connectedVideos.length) ||
    videoRefCountError(model, mode, 'audios', connectedAudios.length)
  ), [connectedAudios.length, connectedImages.length, connectedVideos.length, mode, model])

  /** 参考视频的格式 / 时长 / 条数说明，从模型规则算，不写死 */
  const referenceVideoNote = useMemo(() => videoReferenceNote(model, mode), [mode, model])
  const mentionCandidates = useMemo(
    () => connectedMedia.map(ref => ({
      nodeId: ref.nodeId,
      url: ref.url,
      name: ref.orderName,
      mediaType: ref.previewKind,
    })),
    [connectedMedia]
  )

  /**
   * 提示词里的 @引用也跟着上游主图 / 主视频换。
   * 服务端算参考素材时把 imageList / videoList 和 promptChips 的地址**取并集**，
   * 只换缩略图不换药丸，等于把新旧两个素材一起发出去 —— 比不换更糟。
   * 声明在这里是因为要用 connectedMedia 解析出来的实时地址。
   */
  const liveChipUrls = useMemo<PromptChipLiveUrls>(
    () => Object.fromEntries(connectedMedia.filter(ref => ref.nodeId).map(ref => [ref.nodeId, ref.url])),
    [connectedMedia]
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

  // 手写 `image1` / `video1` / `audio1` + 分隔符 → 自动换成对应的 @引用。
  // 视频节点的引用可以是图片、视频、音频三种，名字分别是 图片N / 视频N / 音频N，都能对上。
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

  // orderMap must be declared here at component body level 鈥?NOT inline in JSX (hooks rule)
  const orderMap = useMemo(
    () => Object.fromEntries(connectedMedia.map(r => [r.nodeId, r.orderName])),
    [connectedMedia]
  )

  const setParam = useCallback(<K extends keyof VideoParams>(key: K, val: VideoParams[K]) => {
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

  // Remove connected media + disconnect edge
  const removeConnectedRef = useCallback((listKey: 'imageList' | 'videoList' | 'audioList', nodeId: string) => {
    const state = useCanvasStore.getState()
    const freshNode = state.nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const originalList = (currentParams[listKey] as NodeRef[] | undefined) ?? []
    const removedRef = originalList.find(r => r.nodeId === nodeId)
    if (!removedRef) return
    const currentList = originalList.filter(r => r.nodeId !== nodeId)
    const chipRefs = [{ nodeId, url: removedRef.url }]
    let nextParams: Record<string, unknown> = { ...currentParams, [listKey]: currentList }
    if (listKey === 'imageList') {
      nextParams.imageListOrder = ((currentParams.imageListOrder as string[] | undefined) ?? []).filter(key => key !== nodeId)
    }
    if (listKey === 'videoList') {
      nextParams.mixedList = ((currentParams.mixedList as NodeRef[] | undefined) ?? []).filter(r => r.nodeId !== nodeId)
      nextParams.mixedListOrder = ((currentParams.mixedListOrder as string[] | undefined) ?? []).filter(key => key !== nodeId)
    }
    nextParams = markPromptChipRefsMissingInParams(nextParams, chipRefs)
    pushHistory()
    editorRef.current?.markChipsMissing(chipRefs)
    updateNodeData(id, { params: nextParams })
    setEdges(edgesWithoutLink(useCanvasStore.getState().edges, nodeId, id))
  }, [id, params, pushHistory, updateNodeData, setEdges])

  // Reorder connected images by drag; persist both the visible list and its explicit order.
  const moveConnectedImage = useCallback((fromConnIdx: number, toConnIdx: number) => {
    if (fromConnIdx === toConnIdx) return
    const connList = connectedImageRefs
    const fromId = connList[fromConnIdx]?.nodeId
    const toId = connList[toConnIdx]?.nodeId
    if (!fromId || !toId) return
    const fullList = [...(params.imageList as NodeRef[] ?? [])]
    const fromReal = fullList.findIndex(r => r.nodeId === fromId)
    const toReal = fullList.findIndex(r => r.nodeId === toId)
    if (fromReal === -1 || toReal === -1) return
    const [item] = fullList.splice(fromReal, 1)
    fullList.splice(toReal, 0, item)
    const imageListOrder = fullList.map(ref => ref.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId))
    updateNodeData(id, {
      params: {
        ...params,
        imageList: fullList,
        imageListOrder,
      } as unknown as Record<string, unknown>,
    })
  }, [connectedImageRefs, id, params, updateNodeData])

  // @mention: insert chip inline via PromptEditor
  const handleAtInsert = useCallback((ref: ChipRef) => {
    setAtMenu(false)
    pushHistory()
    editorRef.current?.insertChip(ref)
  }, [pushHistory])

  const handleReferenceMention = useCallback((ref: ConnectedMediaRef) => {
    handleAtInsert({
      nodeId: ref.nodeId,
      url: ref.url,
      name: ref.orderName,
      mediaType: ref.previewKind,
    })
  }, [handleAtInsert])

  const handleSyncTextPrompt = useCallback(() => {
    const text = textPromptFromRefs((params.textList as NodeRef[] | undefined)?.filter(r => r.nodeId), useCanvasStore.getState().nodes)
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    editorRef.current?.setPlainText(text)
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
      console.warn('Copy video prompt failed', error)
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
    setAtMenu(false)
    editorRef.current?.setPlainText('')
    updateNodeData(id, {
      params: {
        ...currentParams,
        prompt: '',
        promptChips: [],
        promptHtml: undefined,
      } as unknown as Record<string, unknown>,
    })
  }, [id, params, pushHistory, updateNodeData])

  const handleTranslatePrompt = useCallback(async () => {
    if (isTranslating) return
    const state = useCanvasStore.getState()
    const freshNode = state.nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const sourceText = String(currentParams.prompt || '').trim()
    if (!sourceText) {
      setGenError('请先填写需要翻译的提示词')
      return
    }

    setIsTranslating(true)
    setGenError(null)
    try {
      const result = await generateApi.translate(sourceText)
      const translated = String(result.translated || '').trim()
      if (!translated) throw new Error('翻译结果为空')

      const latestNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
      const latestParams = latestNode ? getParams(latestNode.data as CanvasNodeData) : currentParams
      if (String(latestParams.prompt || '').trim() !== sourceText) {
        setGenError('提示词已被修改，翻译结果未覆盖')
        return
      }

      pushHistory()
      updateNodeData(id, {
        params: {
          ...latestParams,
          prompt: translated,
          promptChips: latestParams.promptChips ?? currentParams.promptChips ?? [],
          promptHtml: undefined,
        } as unknown as Record<string, unknown>,
      })
    } catch (error) {
      setGenError(errorToText(error, '翻译失败'))
    } finally {
      setIsTranslating(false)
    }
  }, [id, isTranslating, params, pushHistory, updateNodeData])

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
    if (chip) handleAtInsert(chip)
  }, [activeMentionIndex, handleAtInsert, mentionCandidates])

  const setSettings = useCallback((key: string, val: unknown) => {
    setParam('settings', { ...params.settings, [key]: val })
  }, [params, setParam])

  const setVideoResolution = useCallback((value: string) => {
    const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
    const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
    const nextModel = currentParams.model || 'Seedance_2_0'
    const nextResolution = normalizeVideoResolutionValue(nextModel, value)
    const hasImageReference = (currentParams.imageList as NodeRef[] | undefined)?.some(ref => Boolean(ref.url)) ?? false
    const nextCount = normalizeVideoGenerationCount(nextModel, currentParams.count, hasImageReference, nextResolution)
    updateNodeData(id, {
      params: {
        ...currentParams,
        count: nextCount,
        settings: { ...currentParams.settings, resolution: nextResolution },
      } as unknown as Record<string, unknown>,
    })
  }, [id, params, updateNodeData])

  const handleGenerate = useCallback(async () => {
    // 只挡"请求还在飞"和 5 秒冷却。故意不再挡 taskInfo.loading —— 上一次还在跑也允许再发。
    if (isSubmitting || generateCooldown) return
    setGenError(null)
    try {
      /** 发出去的地址跟着上游**当前的主图 / 主视频**走，同时记下来给药丸对齐。 */
      const requestChipUrls: PromptChipLiveUrls = {}
      const refreshRefList = (list?: NodeRef[]) => (list ?? []).map(ref => {
        const srcNode = nodes.find(n => n.id === ref.nodeId)
        const liveUrl = primaryOutputUrl(srcNode?.data as CanvasNodeData)
        if (liveUrl && ref.nodeId) requestChipUrls[ref.nodeId] = liveUrl
        return liveUrl ? { ...ref, url: liveUrl } : ref
      })
      const freshImageList = refreshRefList(params.imageList as NodeRef[] | undefined).filter(ref => ref.url)
      const freshVideoList = refreshRefList(params.videoList as NodeRef[] | undefined).filter(ref => ref.url)
      const freshAudioList = refreshRefList(params.audioList as NodeRef[] | undefined).filter(ref => ref.url)
      const requestModel = params.model || 'Seedance_2_0'
      const normalizedMode = normalizeVideoModeKey(params.modeType as string | undefined)
      const normalizedRatio = normalizeVideoRatioValue(requestModel, params.settings.ratio, normalizedMode)
      const normalizedResolution = normalizeVideoResolutionValue(requestModel, params.settings.resolution)
      const normalizedDuration = normalizeVideoDurationValue(requestModel, params.settings.duration, normalizedMode)
      const prompt = String(params.prompt || '').trim() || textPromptFromRefs(params.textList as NodeRef[] | undefined, nodes)
      const hasVisualRef = freshImageList.length > 0 || freshVideoList.length > 0
      const hasAnyRef = hasVisualRef || freshAudioList.length > 0
      const submitCount = normalizeVideoGenerationCount(requestModel, params.count, freshImageList.length > 0, normalizedResolution)
      const capabilityError = validateVideoCapability({
        model: requestModel,
        mode: normalizedMode,
        prompt,
        imageCount: freshImageList.length,
        videoCount: freshVideoList.length,
        audioCount: freshAudioList.length,
        ratio: normalizedRatio,
        resolution: normalizedResolution,
        duration: normalizedDuration,
        count: submitCount,
      })

      if (!prompt && !hasAnyRef) {
        setGenError('请填写提示词或连接素材')
        return
      }
      if (capabilityError) {
        setGenError(capabilityError)
        return
      }
      if (freshAudioList.length > 0 && !hasVisualRef) {
        setGenError('音频不能单独输入，至少需要 1 个图片或视频素材')
        return
      }
      const currentReferenceVideoRule = getVideoModelRule(requestModel).referenceVideo
      if (currentReferenceVideoRule && freshVideoList.length > currentReferenceVideoRule.maxCount) {
        setGenError(`参考视频最多支持 ${currentReferenceVideoRule.maxCount} 个`)
        return
      }

      const videoReferenceEntries = freshVideoList.map((ref, index) => {
        const srcNode = nodes.find((node) => node.id === ref.nodeId)
        const nodeData = srcNode?.data as CanvasNodeData | undefined
        const meta = primaryVideoMeta(nodeData, ref.url)
        const durationSec = Number(meta?.durationSec)
        return {
          index,
          extension: String(meta?.extension || extensionFromUrl(ref.url)).toLowerCase(),
          durationSec,
          width: Number(meta?.width),
          height: Number(meta?.height),
        }
      })

      const invalidVideoDuration = videoReferenceEntries.find(
        (entry) =>
          currentReferenceVideoRule &&
          Number.isFinite(entry.durationSec) &&
          (entry.durationSec < currentReferenceVideoRule.minDurationSec || entry.durationSec > currentReferenceVideoRule.maxDurationSec)
      )
      if (invalidVideoDuration && currentReferenceVideoRule) {
        setGenError(
          `参考视频 ${invalidVideoDuration.index + 1} 时长需在 ${currentReferenceVideoRule.minDurationSec}-${currentReferenceVideoRule.maxDurationSec} 秒之间`
        )
        return
      }

      const knownVideoDurationCount = videoReferenceEntries.filter((entry) => Number.isFinite(entry.durationSec)).length
      const totalVideoDuration = videoReferenceEntries.reduce(
        (sum, entry) => sum + (Number.isFinite(entry.durationSec) ? entry.durationSec : 0),
        0
      )
      if (
        currentReferenceVideoRule &&
        knownVideoDurationCount === videoReferenceEntries.length &&
        totalVideoDuration > currentReferenceVideoRule.maxTotalDurationSec + 0.01
      ) {
        setGenError(`参考视频总时长不能超过 ${currentReferenceVideoRule.maxTotalDurationSec} 秒`)
        return
      }

      // 提示词里的 @引用同样换成上游当前的主图 / 主视频 —— 服务端把素材列表和 promptChips
      // 的地址取并集当参考，漏掉药丸就会把旧素材一起发出去。
      const freshParams = refreshPromptChipUrlsInParams({
        ...params,
        model: requestModel,
        prompt,
        imageList: freshImageList,
        videoList: freshVideoList,
        audioList: freshAudioList,
        modeType: normalizedMode,
        settings: {
          ...params.settings,
          ratio: normalizedRatio,
          resolution: normalizedResolution,
          duration: normalizedDuration,
        },
        count: submitCount,
      }, requestChipUrls)
      if (
        !String(params.prompt || '').trim() ||
        params.modeType !== normalizedMode ||
        params.settings.ratio !== normalizedRatio ||
        params.settings.resolution !== normalizedResolution ||
        params.settings.duration !== normalizedDuration ||
        params.count !== submitCount ||
        freshParams.promptChips !== params.promptChips ||
        freshParams.promptHtml !== params.promptHtml
      ) {
        updateNodeData(id, { params: freshParams as unknown as Record<string, unknown> })
      }
      setIsSubmitting(true)
      // 发给模型的文本要把药丸按原位展开成 @图片1（上游文档要求的指代惯例）。
      // 只放进请求、**不写回节点** —— 写回去会让编辑器的兜底渲染变成"文本里一个 @图片1、
      // 末尾再挂一个药丸"的重复显示。
      const modelPrompt = modelPromptFromNodeParams({
        prompt,
        promptHtml: params.promptHtml as string | undefined,
      })
      const submitParams = modelPrompt && modelPrompt !== prompt
        ? { ...freshParams, modelPrompt }
        : freshParams
      const res = await generateApi.video(data.projectUuid, id, submitParams as unknown as Record<string, unknown>)
      addTask(res.jobId, id, res.generationVersion)
      startPolling(res.jobId, data.projectUuid)
      // 提交成功才起冷却：失败的话应该能立刻重试
      startGenerateCooldown()
    } catch (e: unknown) {
      setIsSubmitting(false)
      const axErr = e as { response?: { data?: { error?: unknown } }; message?: string }
      setGenError(errorToText(axErr.response?.data?.error ?? axErr.message, '生成失败'))
    }
  }, [data.projectUuid, id, params, nodes, updateNodeData, addTask, startPolling, isSubmitting, generateCooldown, startGenerateCooldown])

  const isSeedanceModel = /seedance/i.test(String(model))
  const isMiniMaxModel = /minimax/i.test(String(model))
  const isPromptWashModel = isSeedanceModel || isMiniMaxModel

  /** 复制当前视频节点并在副本上执行洗提示词，原节点不被改写。 */
  const washVideoPrompt = useCallback(async (requestedMode: PromptWashMode, requestedTextChoice: PromptWashTextChoice = 'opus', requestedSkillId = '') => {
    if (!isPromptWashModel) return
    const skillId = isSeedanceModel ? (seedancePromptSkillById(requestedSkillId)?.id || '') : ''
    const state = useCanvasStore.getState()
    const sourceNode = state.nodes.find(node => node.id === id || node.data.nodeKey === id)
    if (!sourceNode) return
    const sourceParams = getParams(sourceNode.data as CanvasNodeData)
    const sourceText = modelPromptFromNodeParams({ prompt: sourceParams.prompt, promptHtml: sourceParams.promptHtml as string | undefined }).trim()
      || textPromptFromRefs(sourceParams.textList as NodeRef[] | undefined, state.nodes)
    const sourceImages = (sourceParams.imageList as NodeRef[] | undefined) ?? []
    const sourceVideos = (sourceParams.videoList as NodeRef[] | undefined) ?? []
    const sourceAudios = (sourceParams.audioList as NodeRef[] | undefined) ?? []
    if (!skillId && !sourceText && sourceImages.length === 0 && sourceVideos.length === 0) {
      setGenError('请先填写视频提示词或连接参考素材')
      return
    }
    const freshRefList = (list: NodeRef[]) => list.map(ref => {
      const refNode = state.nodes.find(node => node.id === ref.nodeId)
      const liveUrl = primaryOutputUrl(refNode?.data as CanvasNodeData)
      return liveUrl ? { ...ref, url: liveUrl } : ref
    }).filter(ref => ref.url)
    const imageList = freshRefList(sourceImages)
    const videoList = freshRefList(sourceVideos)
    const audioList = freshRefList(sourceAudios)
    const names = [...imageList, ...videoList, ...audioList].map(ref => {
      const refNode = state.nodes.find(node => node.id === ref.nodeId)
      return String(refNode?.data.name || ref.nodeId || '').trim()
    }).filter(Boolean)
    const copiedParams = { ...sourceParams, prompt: sourceText, promptHtml: undefined, promptChips: [], imageList, videoList, audioList, imageListOrder: imageList.map(ref => ref.nodeId), settings: { ...sourceParams.settings } } as unknown as Record<string, unknown>
    const sourceWidth = Number(sourceNode.measured?.width || sourceNode.width || 620)
    const sourceName = String(sourceNode.data.name || data.name || '')
    const created = addNodeAt('video', (sourceNode.position?.x ?? 0) + sourceWidth + 100, sourceNode.position?.y ?? 0, {
      name: promptWashResultName(sourceName, requestedMode, requestedTextChoice, skillId), url: [], action: 'video_generate', taskInfo: undefined, params: copiedParams,
      _promptWashStatus: 'loading', _promptWashProgress: 8, _promptWashMode: requestedMode, _promptWashModel: requestedTextChoice, _promptWashSkillId: skillId || undefined, _promptWashSourceName: sourceName, _promptWashStarted: false,
    })
    setSelected([created.id])
    setActivePanelNode(created.id)
    // addNodeAt only schedules a debounced save. Make the copied node and its
    // reference edges durable before the long-running wash request starts, so
    // a refresh cannot reload the canvas without this node.
    // React Flow may still have a pending node-save pass when the copy is
    // created (especially on MiniMax nodes whose model/settings were just
    // changed). Give the queue one short retry before reporting a real failure.
    let initialSave = await persistNodesAndWait()
    if (!initialSave) {
      await new Promise(resolve => window.setTimeout(resolve, 650))
      initialSave = await persistNodesAndWait()
    }
    if (!initialSave) {
      updateNodeData(created.id, {
        _promptWashStatus: 'error',
        _promptWashProgress: 0,
        _promptWashMessage: '复制节点保存失败，请重试',
      })
      await persistNodesAndWait()
      return
    }
    // 先把“请求已经启动”写入节点，再发起 LLM 请求。刷新后由节点自身的
    // 恢复 effect 接管；当前页面则由这个集合避免重复请求。
    activePromptWashNodeKeys.add(created.id)
    updateNodeData(created.id, { _promptWashStarted: true })
    await persistNodesAndWait()
    let progressTimer = 0
    const updateProgress = (progress: number) => updateNodeData(created.id, { _promptWashProgress: progress })
    progressTimer = window.setInterval(() => {
      const current = Number(useCanvasStore.getState().nodes.find(node => node.id === created.id)?.data._promptWashProgress ?? 8)
      updateProgress(Math.min(92, current + Math.max(1, Math.round((92 - current) / 7))))
    }, 420)
    try {
      const targetSettings = sourceParams.settings ?? defaultVideoParams().settings
      const result = await generateApi.promptWash({
        projectUuid: data.projectUuid, nodeKey: created.id, sourceText, mode: requestedMode,
        skillId: skillId || undefined, nodeName: sourceName,
        textModel: promptWashTextModelId(requestedTextChoice), thinkingMode: 'fast',
        target: { model: sourceParams.model || 'Seedance_2_0', modeType: sourceParams.modeType || 'omni', duration: targetSettings.duration, ratio: targetSettings.ratio, resolution: targetSettings.resolution, enableSound: targetSettings.enableSound ?? 'on' },
        references: { imageCount: imageList.length, videoCount: videoList.length, audioCount: audioList.length, names },
      })
      const requiredMentions = Array.from(new Set([
        ...Array.from(sourceText.matchAll(/@(图片\d+|视频\d+|音频\d+)/g)).map(match => '@' + match[1]),
        ...imageList.map((_, index) => '@图片' + (index + 1)), ...videoList.map((_, index) => '@视频' + (index + 1)), ...audioList.map((_, index) => '@音频' + (index + 1)),
      ]))
      const washedPrompt = requiredMentions.some(token => !result.prompt.includes(token)) ? result.prompt.trim() + '\n参考素材：' + requiredMentions.join(' ') : result.prompt
       const washCandidates: ChipRef[] = [
         ...imageList.map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: '图片' + (index + 1), mediaType: 'image' as const })),
         ...videoList.map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: '视频' + (index + 1), mediaType: 'video' as const })),
         ...audioList.map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: '音频' + (index + 1), mediaType: 'audio' as const })),
       ]
       const formattedPrompt = buildPromptHtmlFromMentions(washedPrompt, washCandidates)
       updateNodeData(created.id, { params: { ...copiedParams, prompt: washedPrompt, promptHtml: formattedPrompt.chips.length ? formattedPrompt.html : undefined, promptChips: formattedPrompt.chips }, _promptWashStatus: 'done', _promptWashProgress: 100, _promptWashMessage: '洗提示词完成，可直接检查或生成' })
       await persistNodesAndWait()
    } catch (error) {
       const message = (error as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error || (error instanceof Error ? error.message : String(error))
       updateNodeData(created.id, { _promptWashStatus: 'error', _promptWashProgress: 0, _promptWashMessage: message })
       await persistNodesAndWait()
    } finally { window.clearInterval(progressTimer); activePromptWashNodeKeys.delete(created.id) }
  }, [addNodeAt, data.name, data.projectUuid, id, isMiniMaxModel, isPromptWashModel, isSeedanceModel, persistNodesAndWait, setActivePanelNode, setSelected, updateNodeData])

  // 洗词请求本身是一次页面内的 HTTP Promise，刷新会让它消失；节点数据已经
  // 落库，因此重新挂载时用节点里的 prompt/mode/references 再执行一次，避免
  // 永远停在 8%/92%。完成或失败状态仍然写回同一个副本节点。
  useEffect(() => {
    const legacyWashNeedsResume = data._promptWashStarted == null && Boolean(data._promptWashMode)
    if (String(data._promptWashStatus || '') !== 'loading' || (data._promptWashStarted !== true && !legacyWashNeedsResume)) return
    if (activePromptWashNodeKeys.has(id)) return
    activePromptWashNodeKeys.add(id)
    let timer = 0
    const liveState = useCanvasStore.getState()
    const liveNode = liveState.nodes.find(node => node.id === id || node.data.nodeKey === id)
    if (!liveNode) { activePromptWashNodeKeys.delete(id); return }
    const washParams = getParams(liveNode.data as CanvasNodeData)
    const sourceText = modelPromptFromNodeParams({ prompt: washParams.prompt, promptHtml: washParams.promptHtml as string | undefined }).trim()
    const imageList = ((washParams.imageList as NodeRef[] | undefined) ?? []).filter(ref => ref.url)
    const videoList = ((washParams.videoList as NodeRef[] | undefined) ?? []).filter(ref => ref.url)
    const audioList = ((washParams.audioList as NodeRef[] | undefined) ?? []).filter(ref => ref.url)
    const names = [...imageList, ...videoList, ...audioList].map(ref => String(liveState.nodes.find(node => node.id === ref.nodeId)?.data.name || ref.nodeId || '').trim()).filter(Boolean)
    const mode = (String(data._promptWashMode || 'conservative') as PromptWashMode)
    const skillId = seedancePromptSkillById(data._promptWashSkillId)?.id || ''
    const nodeName = String(data._promptWashSourceName || '')
    const targetSettings = washParams.settings ?? defaultVideoParams().settings
    const updateProgress = (progress: number) => updateNodeData(id, { _promptWashProgress: progress })
    timer = window.setInterval(() => {
      const current = Number(useCanvasStore.getState().nodes.find(node => node.id === id)?.data._promptWashProgress ?? 8)
      updateProgress(Math.min(92, current + Math.max(1, Math.round((92 - current) / 7))))
    }, 420)
    void (async () => {
      try {
        const result = await generateApi.promptWash({
          projectUuid: data.projectUuid, nodeKey: id, sourceText, mode,
          skillId: skillId || undefined, nodeName,
          textModel: promptWashTextModelId(data._promptWashModel), thinkingMode: 'fast',
          target: { model: washParams.model || 'Seedance_2_0', modeType: washParams.modeType || 'omni', duration: targetSettings.duration, ratio: targetSettings.ratio, resolution: targetSettings.resolution, enableSound: targetSettings.enableSound ?? 'on' },
          references: { imageCount: imageList.length, videoCount: videoList.length, audioCount: audioList.length, names },
        })
        const requiredMentions = Array.from(new Set([
          ...Array.from(sourceText.matchAll(/@(图片\d+|视频\d+|音频\d+)/g)).map(match => '@' + match[1]),
          ...imageList.map((_, index) => '@图片' + (index + 1)), ...videoList.map((_, index) => '@视频' + (index + 1)), ...audioList.map((_, index) => '@音频' + (index + 1)),
        ]))
        const washedPrompt = requiredMentions.some(token => !result.prompt.includes(token)) ? result.prompt.trim() + '\n参考素材：' + requiredMentions.join(' ') : result.prompt
        const washCandidates: ChipRef[] = [
          ...imageList.map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: '图片' + (index + 1), mediaType: 'image' as const })),
          ...videoList.map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: '视频' + (index + 1), mediaType: 'video' as const })),
          ...audioList.map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: '音频' + (index + 1), mediaType: 'audio' as const })),
        ]
        const formattedPrompt = buildPromptHtmlFromMentions(washedPrompt, washCandidates)
        updateNodeData(id, { params: { ...washParams, prompt: washedPrompt, promptHtml: formattedPrompt.chips.length ? formattedPrompt.html : undefined, promptChips: formattedPrompt.chips }, _promptWashStatus: 'done', _promptWashProgress: 100, _promptWashMessage: '洗提示词完成，可直接检查或生成' })
        await persistNodesAndWait()
      } catch (error) {
        const message = (error as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error || (error instanceof Error ? error.message : String(error))
        updateNodeData(id, { _promptWashStatus: 'error', _promptWashProgress: 0, _promptWashMessage: message })
        await persistNodesAndWait()
      } finally {
        window.clearInterval(timer)
        activePromptWashNodeKeys.delete(id)
      }
    })()
  }, [data._promptWashMode, data._promptWashModel, data._promptWashSkillId, data._promptWashSourceName, data._promptWashStarted, data._promptWashStatus, data.projectUuid, id, isMiniMaxModel, persistNodesAndWait, updateNodeData])

  // 兼容旧版本已经完成的洗词节点：旧写回逻辑会把 promptChips/promptHtml 清空，
  // 这里在重新挂载时按保存的引用列表补回药丸，避免用户必须重新执行一次洗词。
  useEffect(() => {
    if (String(data._promptWashStatus || '') !== 'done') return
    const storedPromptHtml = String(params.promptHtml || '')
    const hasStrayAtBeforeChip = /@\s*(?=<span[^>]*data-chip=["']1["'])/i.test(storedPromptHtml)
    if (Array.isArray(params.promptChips) && params.promptChips.length > 0 && !hasStrayAtBeforeChip) return
    const candidates: ChipRef[] = [
      ...((params.imageList as NodeRef[] | undefined) ?? []).filter(ref => ref.url).map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: '图片' + (index + 1), mediaType: 'image' as const })),
      ...((params.videoList as NodeRef[] | undefined) ?? []).filter(ref => ref.url).map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: '视频' + (index + 1), mediaType: 'video' as const })),
      ...((params.audioList as NodeRef[] | undefined) ?? []).filter(ref => ref.url).map((ref, index) => ({ nodeId: ref.nodeId, url: ref.url, name: '音频' + (index + 1), mediaType: 'audio' as const })),
    ]
    const formatted = buildPromptHtmlFromMentions(String(params.prompt || ''), candidates)
    if (!formatted.chips.length) return
    updateNodeData(id, { params: { ...params, promptHtml: formatted.html, promptChips: formatted.chips } as unknown as Record<string, unknown> })
  }, [data._promptWashStatus, id, params, updateNodeData])

  // Cindy "应用并生成": fire this video node's own generate once when flagged.
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
    a.download = videoDownloadFileName(data.name, url)
    a.click()
  }, [data.name])

  /**
   * 双击 / 「查看」打开画布内查看器。
   *
   * 以前这里是 window.open(url) —— 直接把裸视频地址扔进新标签页，没有缩略图轨道、没有翻页、
   * 没有主视频按钮、没有节点功能行，跟图片节点的查看器完全不是一个东西。现在复用
   * ImagePreview（kind="video"），跟图片那边同一套外观与快捷键。
   */
  const openVideoPreview = useCallback((url: string) => {
    if (url) setVideoPreviewUrl(url)
  }, [])

  // Chromium 的原生 video controls 会自行处理双击全屏，React 的 dblclick
  // preventDefault 在部分版本里拦不住。除了 controlsList 禁用入口，再监听
  // Fullscreen API / Safari 旧事件兜底：一旦原生播放器尝试全屏，立即退出并
  // 打开 Shotflow 自己的查看器。
  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & {
      webkitExitFullscreen?: () => void
    }) | null
    if (!video || !videoUrl) return undefined

    const exitNativeFullscreen = () => {
      openVideoPreview(videoUrl)
      if (document.fullscreenElement === video && typeof document.exitFullscreen === 'function') {
        const result = document.exitFullscreen()
        if (result && typeof result.catch === 'function') void result.catch(() => undefined)
      }
      try { video.webkitExitFullscreen?.() } catch { /* old Safari best effort */ }
    }
    const handleFullscreenChange = () => {
      if (document.fullscreenElement === video) exitNativeFullscreen()
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    video.addEventListener('webkitbeginfullscreen', exitNativeFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      video.removeEventListener('webkitbeginfullscreen', exitNativeFullscreen)
    }
  }, [openVideoPreview, videoUrl])

  const openWhiteboard = useCallback(async () => {
    if (!videoRef.current || !videoUrl || whiteboardPreparing) return
    setGenError(null)
    setWhiteboardError(null)
    setWhiteboardSourceFile(null)
    setWhiteboardOpen(true)
    setWhiteboardPreparing(true)
    try {
      const file = await captureVideoFrameFile(videoRef.current, data.name || 'video')
      setWhiteboardSourceFile(file)
    } catch (error) {
      const message = error instanceof Error ? error.message : '白板资源加载失败'
      setGenError(message)
      setWhiteboardError(message)
    } finally {
      setWhiteboardPreparing(false)
    }
  }, [data.name, videoUrl, whiteboardPreparing])

  const openTrimModal = useCallback(() => {
    if (!videoUrl || trimSubmitting) return
    setGenError(null)
    setTrimOpen(true)
  }, [trimSubmitting, videoUrl])

  const openCropModal = useCallback(() => {
    if (!videoUrl || cropSubmitting) return
    setGenError(null)
    setCropOpen(true)
  }, [cropSubmitting, videoUrl])

  const updateFrameNumberFromVideo = useCallback((video = videoRef.current) => {
    if (!video) return
    setFrameNumber(frameNumberFromTime(video.currentTime, frameFps))
  }, [frameFps])

  const seekFrame = useCallback((direction: -1 | 1) => {
    const video = videoRef.current
    if (!video || !videoUrl) return
    video.pause()
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null
    const nextTime = nextVideoFrameTime(video.currentTime, direction, frameFps, duration)
    try {
      video.currentTime = nextTime
      setFrameNumber(frameNumberFromTime(nextTime, frameFps))
    } catch {
      // ignore seek errors while metadata is still settling
    }
  }, [frameFps, videoUrl])

  const toggleFrameMode = useCallback(() => {
    const video = videoRef.current
    if (video) {
      video.pause()
      updateFrameNumberFromVideo(video)
    }
    useCanvasStore.getState().setSelected([id])
    setFrameMode(value => !value)
  }, [id, updateFrameNumberFromVideo])

  useEffect(() => {
    setFrameMode(false)
    setFrameNumber(1)
  }, [videoUrl])

  useEffect(() => {
    if (!frameMode || !isSoleSelected) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      seekFrame(event.key === 'ArrowRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [frameMode, isSoleSelected, seekFrame])

  const handleVideoMouseEnter = useCallback(() => {
    const video = videoRef.current
    if (!video || !videoUrl) return
    hoverPreviewMutedRef.current = !video.muted
    video.muted = true
    video.currentTime = 0
    void video.play().catch(() => {})
  }, [videoUrl])

  const handleVideoMouseLeave = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    try {
      video.currentTime = 0
    } catch {
      // ignore seek errors for videos that are not ready yet
    }
    if (hoverPreviewMutedRef.current) {
      video.muted = false
      hoverPreviewMutedRef.current = false
    }
  }, [])

  const isLoading = isSubmitting || !!data.taskInfo?.loading
  /**
   * 生成按钮自己的锁：**不含 taskInfo.loading**。
   * 上一次还在跑也允许再点，只锁 5 秒防手拖连点。
   * isLoading 保持原语义（任务在跑），进度条那些还靠它。
   */
  const generateLocked = isSubmitting || generateCooldown
  const runningPercent = data.taskInfo?.progressPercent ?? 0
  const generateLockTitle = generateLocked
    ? (isSubmitting ? '正在提交…' : '刚发过一次，5 秒后可再点')
    : data.taskInfo?.loading
      ? `生成（上一次还在跑 ${runningPercent}%，再点会取代它，旧的结果不会采用）`
      : '生成'
  const promptWashStatus = String(data._promptWashStatus || '')
  const promptWashProgress = Math.max(0, Math.min(100, Number(data._promptWashProgress || 0)))
  const promptWashMessage = String(data._promptWashMessage || '')
  /**
   * 要画的进度条：以 _pendingTasks 为准（并发时可能好几条），老画布没这个字段就回落到
   * 单个 taskInfo，行为跟改造前一致。按开始时间排，先点的在上面。
   */
  const progressRows = useMemo<TaskInfo[]>(() => {
    const pending = data._pendingTasks
    // 只画**真的还有轮询在跑**的任务。光看节点上的 loading 会画出僵尸进度条：
    // 任务被取消 / 被作废之后如果没摘干净，那条 loading:true 会永远挂着、计时一直涨
    // （2026-08-19 线上实证）。以 tasksStore 里有没有这个任务为准，等于自动愈合历史脏数据。
    const rows = pending
      ? Object.entries(pending)
        .filter(([jobId, info]) => info?.loading && Object.prototype.hasOwnProperty.call(liveTasks, jobId))
        .map(([, info]) => info)
      : []
    if (rows.length > 0) return rows.sort((a, b) => Number(a.startedAtMs || 0) - Number(b.startedAtMs || 0))
    // 刚点下生成、任务还没登记进 tasksStore 的那一瞬间，先按 taskInfo 顶一下，别闪空
    if (data.taskInfo?.loading && (isSubmitting || Object.prototype.hasOwnProperty.call(liveTasks, data.taskInfo.taskId))) {
      return [data.taskInfo]
    }
    return []
  }, [data._pendingTasks, data.taskInfo, isSubmitting, liveTasks])
  const cancelProgressRow = useCallback((taskId?: string) => {
    if (taskId) cancelTask(taskId)
    setIsSubmitting(false)
    window.clearTimeout(cooldownTimerRef.current)
    setGenerateCooldown(false)
  }, [cancelTask])
  const isControlsPanelVisible = Boolean(isPanelOpen && !expanded && portalRect)
  /**
   * 进度条放在**整个弹窗下面**，不占面板内部高度。
   * 面板开着就贴在面板下沿（跟面板同宽同左），面板收起就贴在节点下沿。
   * 全屏模式不走这条 —— 那时面板铺满视口，"下面"没有位置，改成画在面板最后一行。
   */
  const [panelRect, setPanelRect] = useState<{ left: number; width: number; bottom: number } | null>(null)
  useLayoutEffect(() => {
    if (!isControlsPanelVisible || progressRows.length === 0) {
      setPanelRect(null)
      return
    }
    const measure = () => {
      const element = panelPortalRef.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      setPanelRect({ left: rect.left, width: rect.width, bottom: rect.bottom })
    }
    measure()
    const raf = window.requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [isControlsPanelVisible, progressRows.length, panelSize?.height, panelExpanded, portalRect?.bottom, portalRect?.left, zoom, vpX, vpY])
  const showDetachedProgress = Boolean(progressRows.length > 0 && !panelExpanded && (panelRect || portalRect))
  const handleCancelGeneration = useCallback(() => {
    const taskId = data.taskInfo?.taskId
    if (taskId) cancelTask(taskId)
    else updateNodeData(id, { taskInfo: undefined })
    setIsSubmitting(false)
    // 取消了就别再让 5 秒冷却拦着重发
    window.clearTimeout(cooldownTimerRef.current)
    setGenerateCooldown(false)
  }, [cancelTask, data.taskInfo?.taskId, id, updateNodeData])
  const safeZoom = zoom || 1
  const inverseZoom = 1 / safeZoom
  const currentRatioOption = ratioOptions.find((option) => option.value === ratio)
    ?? VIDEO_RATIO_OPTIONS.find((option) => option.value === '16:9')
    ?? VIDEO_RATIO_OPTIONS[0]
  const sourceResolutionLabel = currentVideoMeta?.width && currentVideoMeta?.height
    ? `${currentVideoMeta.width} x ${currentVideoMeta.height}`
    : ''
  const videoResolutionLabel = sourceResolutionLabel || (videoSize ? `${videoSize.w} x ${videoSize.h}` : resolution)
  const uploadInfo = data.uploadInfo
  const uploadProgress = Math.max(0, Math.min(100, Number(uploadInfo?.progressPercent ?? 0)))
  const isUploadActive = Boolean(uploadInfo?.loading)
  const uploadStatusText = uploadInfo?.status === 'processing'
    ? '压缩显示版中'
    : uploadInfo?.status === 'failed'
      ? String(uploadInfo.error || '上传失败')
      : `上传中 ${uploadProgress}%`
  const headerIconWidth = 22
  const headerNameWidth = 128
  const headerResolutionWidth = Math.max(70, Math.ceil(videoResolutionLabel.length * 7 + 18))
  const headerGap = 6
  const previewAspectW = currentVideoMeta?.displayWidth ?? videoSize?.w ?? currentVideoMeta?.width ?? currentRatioOption.w
  const previewAspectH = currentVideoMeta?.displayHeight ?? videoSize?.h ?? currentVideoMeta?.height ?? currentRatioOption.h
  const previewFrame = fitFrameToAspect(previewAspectW, previewAspectH, 520, 400, 220)
  const shellWidth = previewFrame.width
  const mediaEnhance = useMediaEnhance({
    id,
    data,
    sourceUrl: videoUrl ?? '',
    sourceName: data.name,
    mediaType: 'video',
    shellWidth,
    sourceWidth: sourceWidthHint ?? videoSize?.w,
    sourceHeight: sourceHeightHint ?? videoSize?.h,
    sourceFps: sourceFpsHint,
    sourceDurationSec: sourceDurationHint,
  })
  const galleryGap = 8
  const expandedTileWidth = Math.max(1, Math.round(galleryRect?.width ?? shellWidth))
  const expandedTileHeight = Math.max(1, Math.round(galleryRect?.height ?? previewFrame.height))
  // 失败的生成也在多视频里占一个位：一个空的视频位 + 红色报错。并发之后同时可能有好几条在跑，
  // 光靠一个 taskInfo.error 说不清是哪条挂了，所以按任务分别留痕。
  const failedGenerations = Array.isArray(data._failedGenerations) ? data._failedGenerations : []
  const expandedTileSources: Array<{ url: string; order: number; failed?: FailedGeneration }> = [
    ...expandedVideoItems.map((item) => ({ url: item.url, order: item.order })),
    ...failedGenerations.map((failed, index) => ({
      url: '',
      order: galleryItems.length + index + 1,
      failed,
    })),
  ]
  const expandedVideoPlacements = galleryRect
    ? expandedTileSources.map((item, index) => {
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
          failed: item.failed,
          left,
          top,
        }
      })
    : []
  const panelWidth = Math.max(560, shellWidth)
  const effectivePanelWidth = panelSize?.width ?? panelWidth
  const panelLeft = portalRect
    ? Math.min(
        Math.max(16, portalRect.left + (portalRect.width - effectivePanelWidth) / 2),
        Math.max(16, window.innerWidth - effectivePanelWidth - 16)
      )
    : 16
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720
  const mentionMenuRect = atMenu ? promptPanelRef.current?.getBoundingClientRect() : null
  const mentionMenuEstimatedHeight = Math.min(320, 28 + connectedMedia.length * 38)
  const mentionMenuTop = mentionMenuRect
    ? (
      mentionMenuRect.top - mentionMenuEstimatedHeight - 6 > 12
        ? mentionMenuRect.top - mentionMenuEstimatedHeight - 6
        : Math.min(mentionMenuRect.bottom + 6, viewportHeight - mentionMenuEstimatedHeight - 12)
    )
    : 12
  const mentionMenuLeft = mentionMenuRect
    ? Math.min(Math.max(12, mentionMenuRect.left + 12), Math.max(12, viewportWidth - 260))
    : 12
  const expandedPanelWidth = Math.round(Math.min(
    viewportWidth - 48,
    Math.max(960, panelWidth * 2)
  ))
  const panelPromptMaxHeight = panelExpanded
    ? Math.max(380, Math.min(680, viewportHeight - 360))
    : 132

  const commitNodeName = useCallback(() => {
    const nextName = nameDraft.trim() || 'video'
    setNameDraft(nextName)
    setIsRenaming(false)
    if (nextName !== data.name) updateNodeData(id, { name: nextName })
  }, [data.name, id, nameDraft, updateNodeData])

  /**
   * 设为主视频，并把**底栏的生成参数**换成这条视频当初用的那套（模型 / 比例 / 清晰度 / 时长）。
   * 这样你挑中哪条，接着生成就是从那条的设置继续，不用手动回忆再调一遍。
   *
   * 刻意不动的两样：
   *   - 提示词：那是你正在编辑的东西，悄悄替换掉等于把你刚写的字弄丢；
   *   - 模式（文生/图生/多模态…）：那是工作流分页、不在这个弹窗里，换了还可能让参考素材不合规。
   * 参数一律过一遍归一化 —— 老视频可能是别的模型生成的，它的清晰度在新模型上不一定合法
   * （比如 4K 只有 2.0 有），不归一化会留下一个提交就报错的非法组合。
   */
  const setMainVideo = useCallback((url: string) => {
    if (!url) return
    pushHistory()
    const patch: Partial<CanvasNodeData> = { _primaryAssetUrl: url, _updatedAtMs: Date.now() }
    const meta = data._assetGenerationMeta?.[url] as AssetGenerationMeta | undefined
    if (meta && (meta.model || meta.ratio || meta.resolution || meta.durationSec)) {
      const freshNode = useCanvasStore.getState().nodes.find(n => n.id === id || n.data.nodeKey === id)
      const currentParams = freshNode ? getParams(freshNode.data as CanvasNodeData) : params
      const nextModel = meta.model || currentParams.model || 'Seedance_2_0'
      const nextMode = normalizeVideoModeKey(currentParams.modeType as string | undefined)
      patch.params = {
        ...currentParams,
        model: nextModel,
        settings: {
          ...currentParams.settings,
          ratio: normalizeVideoRatioValue(nextModel, meta.ratio ?? currentParams.settings.ratio, nextMode),
          resolution: normalizeVideoResolutionValue(nextModel, meta.resolution ?? currentParams.settings.resolution),
          duration: normalizeVideoDurationValue(nextModel, meta.durationSec ?? currentParams.settings.duration, nextMode),
        },
      } as unknown as Record<string, unknown>
    }
    updateNodeData(id, patch)
    setExpanded(false)
  }, [id, pushHistory, updateNodeData, data._assetGenerationMeta, params])

  const removeVideoUrl = useCallback((url: string) => {
    const newUrls = [...((data.url ?? []).filter((url): url is string => typeof url === 'string' && url.trim().length > 0))]
    const nextUrls = newUrls.filter((item) => item !== url)
    if (nextUrls.length === newUrls.length) return
    const patch: Partial<CanvasNodeData> = { url: nextUrls, _updatedAtMs: Date.now() }
    if (data._primaryAssetUrl === url) patch._primaryAssetUrl = nextUrls[0] ?? ''
    pushHistory()
    updateNodeData(id, patch)
    if (nextUrls.length <= 1) {
      setExpanded(false)
      setGalleryLocked(false)
    }
  }, [data._primaryAssetUrl, data.url, id, pushHistory, updateNodeData])

  const persistPrimaryVideoMeta = useCallback((patch: Partial<ResourceMeta>) => {
    const currentItems = (data._resourceMeta?.items ?? []) as ResourceMeta[]
    const videoItems = currentItems.filter((item) => item?.kind === 'video')
    const currentVideoMeta = videoItems.find((item) => (
      item.originalUrl === videoUrl || item.displayUrl === videoUrl
    )) ?? (videoItems.length === 1 ? videoItems[0] : null)
    const fallbackExtension = extensionFromUrl(videoUrl)
    const nextVideoMeta: ResourceMeta = {
      kind: 'video',
      ...currentVideoMeta,
      ...patch,
      originalUrl: currentVideoMeta?.originalUrl || videoUrl || undefined,
      extension: patch.extension || currentVideoMeta?.extension || fallbackExtension || undefined,
      mimeType:
        patch.mimeType ||
        currentVideoMeta?.mimeType ||
        mimeTypeFromVideoExtension(patch.extension || currentVideoMeta?.extension || fallbackExtension),
    }
    const remainingItems = currentVideoMeta
      ? currentItems.filter((item) => item !== currentVideoMeta)
      : currentItems
    const currentKey = JSON.stringify(currentVideoMeta ?? null)
    const nextKey = JSON.stringify(nextVideoMeta)
    if (currentKey === nextKey) return
    updateNodeData(id, { _resourceMeta: { items: [nextVideoMeta, ...remainingItems] } })
  }, [data._resourceMeta?.items, id, updateNodeData, videoUrl])

  const handleTrimAccept = useCallback(async ({ startSec, endSec }: { startSec: number; endSec: number }) => {
    if (!videoUrl || trimSubmitting) return
    setGenError(null)
    setTrimSubmitting(true)
    try {
      const result = await toolboxApi.videoTrim(data.projectUuid, id, videoUrl, startSec, endSec)
      const resourceMeta = resourceMetaFromUploadPayload(result.meta as Record<string, unknown> | undefined, 'video')
      const sourceNode = nodes.find((node) => node.id === id)
      const createdNode = addNodeAt('video', (sourceNode?.position.x ?? 0) + shellWidth + 140, sourceNode?.position.y ?? 0, {
        name: `${data.name || '视频'} 剪辑`,
        url: [result.url],
        action: 'image_resource',
        ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
      })

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

      setTrimOpen(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : '视频裁剪失败'
      setGenError(message)
      throw error instanceof Error ? error : new Error(message)
    } finally {
      setTrimSubmitting(false)
    }
  }, [addNodeAt, data.name, data.projectUuid, edges, id, nodes, setEdges, shellWidth, trimSubmitting, videoUrl])

  const handleCropAccept = useCallback(async ({ x, y, width, height }: { x: number; y: number; width: number; height: number }) => {
    if (!videoUrl || cropSubmitting) return
    setGenError(null)
    setCropSubmitting(true)
    try {
      const result = await toolboxApi.videoCrop(data.projectUuid, id, videoUrl, { x, y, width, height })
      const resourceMeta = resourceMetaFromUploadPayload(result.meta as Record<string, unknown> | undefined, 'video')
      const sourceNode = nodes.find((node) => node.id === id)
      const createdNode = addNodeAt('video', (sourceNode?.position.x ?? 0) + shellWidth + 140, sourceNode?.position.y ?? 0, {
        name: `${data.name || '视频'} 裁剪`,
        url: [result.url],
        action: 'image_resource',
        ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
      })

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

      setCropOpen(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : '视频裁剪失败'
      setGenError(message)
      throw error instanceof Error ? error : new Error(message)
    } finally {
      setCropSubmitting(false)
    }
  }, [addNodeAt, cropSubmitting, data.name, data.projectUuid, edges, id, nodes, setEdges, shellWidth, videoUrl])

  const handleUiRemovalPreview = useCallback(async () => {
    if (!videoUrl) throw new Error('没有可预览的视频')
    return toolboxApi.videoUiRemovalPreview(data.projectUuid, videoUrl)
  }, [data.projectUuid, videoUrl])

  const handleUiRemovalAccept = useCallback(async (method: VideoUiRemovalMethod) => {
    if (!videoUrl || uiRemovalSubmitting) return
    setGenError(null)
    setUiRemovalSubmitting(true)
    let createdNodeId = ''
    let taskStarted = false
    try {
      const state = useCanvasStore.getState()
      const sourceNode = state.nodes.find((node) => node.id === id || node.data.nodeKey === id)
      const sourcePosition = sourceNode?.position ?? { x: 0, y: 0 }
      const outgoingCount = state.edges.filter((edge) => edge.source === id || edge.source === sourceNode?.id).length
      const sourceRef = { nodeId: id, url: videoUrl, mediaType: 'video' as const }
      const implementation = method === 'diffueraser'
        ? { provider: 'diffueraser', model: 'SAM 2 + DiffuEraser' }
        : { provider: 'propainter', model: 'SAM 2 + ProPainter' }
      const createdNode = addNodeAt('video', sourcePosition.x + shellWidth + 140, sourcePosition.y + outgoingCount * 44, {
        name: (data.name || '视频') + ' · 去除UI',
        url: [], action: 'image_resource', sourceKind: 'ui_removal',
        params: { ...defaultVideoParams(), modeType: 'video-edit', videoList: [sourceRef], mixedList: [sourceRef], mixedListOrder: [id], uiRemoval: { method, ...implementation } } as unknown as Record<string, unknown>,
      })
      createdNodeId = createdNode.id
      const saved = await persistNodesAndWait()
      if (!saved) throw new Error('去除 UI 输出节点保存失败，请刷新画布后重试')
      const result = await toolboxApi.videoUiRemoval(data.projectUuid, createdNode.id, videoUrl, method, id)
      if (!result?.jobId) throw new Error('去除 UI 任务未创建')
      taskStarted = true
      addTask(result.jobId, createdNode.id, result.generationVersion, { phaseLabel: '去除 UI', model: implementation.model, taskKind: 'video' })
      startPolling(result.jobId, data.projectUuid)
      setUiRemovalOpen(false)
    } catch (error) {
      const message = errorToText(error, '去除 UI 失败')
      setGenError(message)
      if (createdNodeId && !taskStarted) {
        const liveNode = useCanvasStore.getState().nodes.find((node) => node.id === createdNodeId)
        if (liveNode) useCanvasStore.getState().deleteNodes([createdNodeId])
      }
      throw error instanceof Error ? error : new Error(message)
    } finally {
      setUiRemovalSubmitting(false)
    }
  }, [addNodeAt, addTask, data.name, data.projectUuid, id, persistNodesAndWait, shellWidth, startPolling, uiRemovalSubmitting, videoUrl])

  const openFrameInterpolationModal = useCallback(() => {
    if (!videoUrl || frameInterpolationSubmitting) return
    setGenError(null)
    setFrameInterpolationOpen(true)
  }, [frameInterpolationSubmitting, videoUrl])

  const handleFrameInterpolationAccept = useCallback(async (targetFps: number, method: VideoFrameInterpolationMethod) => {
    if (!videoUrl || frameInterpolationSubmitting) return
    setGenError(null)
    setFrameInterpolationSubmitting(true)
    let createdNodeId = ''
    let taskStarted = false
    try {
      const state = useCanvasStore.getState()
      const sourceNode = state.nodes.find((node) => node.id === id || node.data.nodeKey === id)
      const sourcePosition = sourceNode?.position ?? { x: 0, y: 0 }
      const outgoingCount = state.edges.filter((edge) => edge.source === id || edge.source === sourceNode?.id).length
      const sourceRef = { nodeId: id, url: videoUrl, mediaType: 'video' as const }
      const implementation = method === 'openflowframes'
        ? { provider: 'openflowframes', model: 'OpenFlowFrames · RIFE 4.26', preset: 'slow' }
        : method === 'video2x'
          ? { provider: 'video2x', model: 'Video2X 6.4 · RIFE 4.26', preset: 'slow' }
          : { provider: 'ffmpeg-minterpolate', model: 'FFmpeg MCI 光流', preset: 'medium' }
      const marker = {
        sourceFps: sourceFpsHint,
        targetFps,
        width: sourceWidthHint,
        height: sourceHeightHint,
        durationSec: sourceDurationHint,
        qualityMode: 'quality',
        method,
        crf: 12,
        preset: implementation.preset,
        provider: implementation.provider,
        model: implementation.model,
      }
      const createdNode = addNodeAt(
        'video',
        sourcePosition.x + shellWidth + 140,
        sourcePosition.y + outgoingCount * 44,
        {
          name: `${data.name || '视频'} ${targetFps}fps`,
          url: [],
          action: 'image_resource',
          sourceKind: 'frame_interpolation',
          params: {
            ...defaultVideoParams(),
            modeType: 'video-edit',
            videoList: [sourceRef],
            mixedList: [sourceRef],
            mixedListOrder: [id],
            frameInterpolation: marker,
          } as unknown as Record<string, unknown>,
        },
      )
      createdNodeId = createdNode.id

      // addNodeAt schedules a debounced save. Wait for the node and its
      // reference edge to be durable before creating the server task; otherwise
      // a fast FFmpeg run could finish before the output node exists remotely.
      const saved = await persistNodesAndWait()
      if (!saved) throw new Error('补帧输出节点保存失败，请刷新画布后重试')

      const result = await toolboxApi.videoFrameInterpolation(
        data.projectUuid,
        createdNode.id,
        videoUrl,
        targetFps,
        method,
        id,
      )
      if (!result?.jobId) throw new Error('补帧任务未创建')
      taskStarted = true
      addTask(result.jobId, createdNode.id, result.generationVersion, {
        phaseLabel: '视频补帧',
        model: implementation.model,
        taskKind: 'video',
      })
      startPolling(result.jobId, data.projectUuid)
      setFrameInterpolationOpen(false)
    } catch (error) {
      const message = errorToText(error, '视频补帧失败')
      setGenError(message)
      // If the server task was never accepted, remove only the fresh output
      // node so a failed save/request cannot leave an orphaned blank node.
      if (createdNodeId && !taskStarted) {
        const liveNode = useCanvasStore.getState().nodes.find((node) => node.id === createdNodeId)
        if (liveNode) useCanvasStore.getState().deleteNodes([createdNodeId])
      }
      throw error instanceof Error ? error : new Error(message)
    } finally {
      setFrameInterpolationSubmitting(false)
    }
  }, [addNodeAt, addTask, data.name, data.projectUuid, frameInterpolationSubmitting, id, persistNodesAndWait, shellWidth, sourceDurationHint, sourceFpsHint, sourceHeightHint, sourceWidthHint, startPolling, videoUrl])

  const captureCurrentFrameToImageNode = useCallback(async () => {
    const video = videoRef.current
    if (!videoUrl || !video || frameCapturing) return
    setGenError(null)
    setFrameCapturing(true)
    video.pause()
    try {
      const captureSourceUrl = currentVideoMeta?.originalUrl || videoUrl || displayVideoUrl
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0
      const file = await captureVideoFrameFileFromUrl(captureSourceUrl, currentTime, data.name || 'video')
      const uploaded = await assetsApi.upload(data.projectUuid, file)
      const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
      const sourceNode = nodes.find((node) => node.id === id)
      const sourceRef = { nodeId: id, url: videoUrl, mediaType: 'video' as const }
      const createdNode = addNodeAt('image', (sourceNode?.position.x ?? 0) + shellWidth + 140, sourceNode?.position.y ?? 0, {
        name: `${data.name || '视频'} 当前帧`,
        url: [uploaded.url],
        action: 'image_resource',
        ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
        params: {
          ...defaultImageParams(),
          videoList: [sourceRef],
        } as unknown as Record<string, unknown>,
      })

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
    } catch (error) {
      setGenError(error instanceof Error ? error.message : '截取当前帧失败')
    } finally {
      setFrameCapturing(false)
    }
  }, [addNodeAt, currentVideoMeta?.originalUrl, data.name, data.projectUuid, displayVideoUrl, edges, frameCapturing, id, nodes, setEdges, shellWidth, videoUrl])

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

  const videoGalleryOrderBadge = (fixed = false): React.CSSProperties => ({
    ...(fixed ? fixedTopLeft(8, 8) : { position: 'absolute', top: 8, left: 8 }),
    zIndex: 13,
    minWidth: 26,
    height: 26,
    padding: '0 8px',
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

  // 选中时贴在节点名字上方那一行（NodeShell 的 selectedMeta）。透明度由外壳统一给 50%。
  const resolutionMeta = (
    <span
      style={{
        color: '#c8bfe8',
        fontSize: 'calc(11px * var(--canvas-text-scale, 1))',
        lineHeight: 1.1,
      }}
    >
      {videoResolutionLabel}
    </span>
  )

  /**
   * 查看器缩略图轨道 / 计数 / 信息面板要的那份清单。
   * 不给 thumbUrl —— 视频没给 thumbUrl 时查看器会用 <video preload="metadata"> 取首帧，
   * 给了反而会被当图片塞进 <img>，mp4 会画成裂图。
   */
  const videoPreviewItems = useMemo<ImagePreviewItem[]>(() => {
    const resourceItems = (data._resourceMeta?.items ?? []) as ResourceMeta[]
    const videoResourceItems = resourceItems.filter((meta) => meta?.kind === 'video')
    return galleryItems.map((item) => ({
      url: item.url,
      name: data.name,
      resourceMeta: videoResourceItems.find(
        (meta) => meta.originalUrl === item.url || meta.displayUrl === item.url,
      ) ?? (galleryItems.length === 1 && videoResourceItems.length === 1 ? videoResourceItems[0] : undefined),
      generationMeta: data._assetGenerationMeta?.[item.url] as AssetGenerationMeta | undefined,
      createdAtMs: data._assetCreatedAtMs?.[item.url],
      badge: (data._assetGenerationMeta?.[item.url] as AssetGenerationMeta | undefined)?.resolution,
    }))
  }, [galleryItems, data])

  const loadVideoResourceMeta = useCallback((url: string) => {
    const sourceUrl = String(url || '').trim()
    if (!sourceUrl.startsWith('/assets/')) return Promise.resolve(null)
    const existing = videoMetaProbeRequestsRef.current.get(sourceUrl)
    if (existing) return existing

    let request!: Promise<ResourceMeta | null>
    request = assetsApi.metadata(data.projectUuid, sourceUrl)
      .then((result) => {
        const rawMeta = result?.meta
        if (!rawMeta || typeof rawMeta !== 'object' || String(rawMeta.kind || '') !== 'video') return null

        // Read the latest store state after ffprobe returns. Multiple videos can
        // finish probing out of order; using the render-time `data` snapshot here
        // would let the last response overwrite metadata saved by earlier ones.
        const state = useCanvasStore.getState()
        const liveNode = state.nodes.find((node) => node.id === id || node.data.nodeKey === id)
        if (!liveNode) return null
        const liveData = liveNode.data as CanvasNodeData
        const currentItems = (liveData._resourceMeta?.items ?? []) as ResourceMeta[]
        const videoItemIndexes = currentItems
          .map((item, index) => item?.kind === 'video' ? index : -1)
          .filter((index) => index >= 0)
        const exactIndex = currentItems.findIndex((item) => (
          item?.kind === 'video'
          && (item.originalUrl === sourceUrl || item.displayUrl === sourceUrl)
        ))
        const liveGalleryItems = galleryItemsFromNodeData(liveData)
        const targetIndex = exactIndex >= 0
          ? exactIndex
          : liveGalleryItems.length === 1 && videoItemIndexes.length === 1
            ? videoItemIndexes[0]
            : -1
        const currentMeta = targetIndex >= 0 ? currentItems[targetIndex] : undefined
        const probedCreatedAtMs = Number(rawMeta.createdAtMs)
        const nextMeta: ResourceMeta = {
          ...currentMeta,
          ...(rawMeta as Partial<ResourceMeta>),
          kind: 'video',
          originalUrl: currentMeta?.originalUrl || sourceUrl,
          createdAtMs: currentMeta?.createdAtMs
            ?? (Number.isFinite(probedCreatedAtMs) && probedCreatedAtMs > 0 ? probedCreatedAtMs : undefined),
        }
        const nextItems = targetIndex >= 0
          ? currentItems.map((item, index) => index === targetIndex ? nextMeta : item)
          : [nextMeta, ...currentItems]
        state.updateNodeData(liveNode.data.nodeKey || liveNode.id, {
          _resourceMeta: { items: nextItems },
        })
        return nextMeta
      })
      .catch(() => null)
      .finally(() => {
        if (videoMetaProbeRequestsRef.current.get(sourceUrl) === request) {
          videoMetaProbeRequestsRef.current.delete(sourceUrl)
        }
      })
    videoMetaProbeRequestsRef.current.set(sourceUrl, request)
    return request
  }, [data.projectUuid, id])

  // 提成变量是为了让大图查看器（ImagePreview kind="video"）复用同一份 —— 图片节点那边
  // 也是把 mediaToolbarActions 直接传进查看器，两边不各写一份，改一处两边都跟上。
  // 查看器内部会把 'fullscreen' 过滤掉（已经在大图里了）。
  const mediaToolbarActions: MediaNodeToolbarAction[] = [
        {
          key: 'trim',
          label: trimSubmitting ? '正在剪辑' : '剪辑',
          icon: trimSubmitting
            ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <Scissors size={14} strokeWidth={1.9} />,
          onClick: openTrimModal,
          disabled: trimSubmitting,
        },
        {
          key: 'crop',
          label: cropSubmitting ? '正在裁剪' : '裁剪',
          icon: cropSubmitting
            ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <Crop size={14} strokeWidth={1.9} />,
          onClick: openCropModal,
          disabled: cropSubmitting,
        },
        {
          key: 'ui-removal',
          label: uiRemovalSubmitting ? '正在去除UI' : '去除UI',
          icon: uiRemovalSubmitting ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Scissors size={14} strokeWidth={1.9} />,
          onClick: () => { if (videoUrl && !uiRemovalSubmitting) { setGenError(null); setUiRemovalOpen(true) } },
          disabled: uiRemovalSubmitting,
        },
        {
          key: 'frame-interpolation',
          label: frameInterpolationSubmitting ? '正在补帧' : '补帧',
          icon: frameInterpolationSubmitting
            ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <Gauge size={14} strokeWidth={1.9} />,
          onClick: openFrameInterpolationModal,
          disabled: frameInterpolationSubmitting,
        },
        {
          key: 'media-enhance',
          label: mediaEnhance.submitting ? '正在创建高清增强' : 'AI 高清增强',
          icon: mediaEnhance.submitting
            ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <Sparkles size={14} strokeWidth={1.9} />,
          onClick: mediaEnhance.openModal,
          disabled: mediaEnhance.submitting,
        },
        {
          key: 'whiteboard',
          label: whiteboardPreparing ? '正在打开白板' : '白板标注',
          icon: whiteboardPreparing
            ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <SquarePen size={14} strokeWidth={1.9} />,
          onClick: openWhiteboard,
          disabled: whiteboardPreparing,
        },
        {
          key: 'capture-frame',
          label: frameCapturing ? '正在截取当前帧' : '截取当前帧',
          icon: frameCapturing
            ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            : <Camera size={14} strokeWidth={1.9} />,
          onClick: captureCurrentFrameToImageNode,
          disabled: frameCapturing,
        },
        {
          key: 'download',
          label: '下载',
          icon: <Download size={14} strokeWidth={1.9} />,
          onClick: () => handleDownload(videoUrl),
        },
        {
          key: 'fullscreen',
          label: '查看',
          icon: <Expand size={14} strokeWidth={1.9} />,
          onClick: () => openVideoPreview(videoUrl),
        },
  ]

  const toolbar = isPanelActive && videoUrl ? (
    <MediaNodeToolbar actions={mediaToolbarActions} />
  ) : undefined

  const handleWhiteboardAccept = useCallback(async ({ dataUrl, snapshot }: { dataUrl: string; snapshot: unknown }) => {
    const file = await dataUrlToFile(dataUrl, data.name || 'video')
    const uploaded = await assetsApi.upload(data.projectUuid, file)
    const resourceMeta = resourceMetaFromUploadPayload(uploaded.meta as Record<string, unknown> | undefined, 'image')
    const updatedAtMs = Date.now()
    const resultNodeId = whiteboardState?.resultNodeId
    const existingResultNode = resultNodeId ? nodes.find((node) => node.id === resultNodeId) : undefined
    const sourceNode = nodes.find((node) => node.id === id)
    const sourceRef = { nodeId: id, url: videoUrl, mediaType: 'video' as const }
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
        ...params,
        advancedSettings: writeWhiteboardState(advancedSettings, {
          snapshot,
          resultNodeId: resolvedResultNodeId,
          updatedAtMs,
        }),
      } as unknown as Record<string, unknown>,
    })

    setWhiteboardOpen(false)
    setWhiteboardSourceFile(null)
    setPreviewUrl(null)
  }, [addNodeAt, advancedSettings, data.name, data.projectUuid, edges, id, nodes, params, pushHistory, setEdges, shellWidth, updateNodeData, videoUrl, whiteboardState?.resultNodeId])

  return (
    <>
    <NodeShell nodeKey={id} data={data} selected={selected} selectedMeta={resolutionMeta} toolbar={toolbar} showFavoriteToolbarFallback={false} showMenuButton={false}
      minWidth={shellWidth}
      maxWidth={shellWidth}
      minHeight={previewFrame.height}
      bodyStyle={videoUrl ? { background: 'transparent', overflow: 'visible' } : undefined}
    >
      <div
        ref={videoAreaRef}
        className="relative shotflow-media-lod-shell shotflow-media-lod-video-shell"
        data-shotflow-expanded-gallery={expanded ? '1' : undefined}
        style={{
          background: videoUrl ? 'transparent' : '#0d0b18',
          minHeight: previewFrame.height,
          overflow: 'visible',
        }}
        onMouseEnter={videoUrl && !frameMode ? handleVideoMouseEnter : undefined}
        onMouseLeave={videoUrl && !frameMode ? handleVideoMouseLeave : undefined}
      >
        {videoUrl ? (
          <>
          {!expanded && (
          <div
            className="nodrag"
            style={{
              ...fixedTopLeft(5, 5),
              zIndex: 18,
              ...floatingNodeControlBarStyle(),
            }}
          >
            <button
              type="button"
              title="逐帧模式：使用左右方向键控制上一帧 / 下一帧"
              aria-pressed={frameMode}
              onClick={event => {
                event.stopPropagation()
                toggleFrameMode()
              }}
              style={floatingNodeTextButtonStyle(frameMode, frameMode ? Math.max(23, String(frameNumber).length * 7.5 + 10) : 35)}
            >
              {frameMode ? frameNumber : '逐帧'}
            </button>
            <button
              type="button"
              title="截取当前帧"
              aria-label="截取当前帧"
              disabled={frameCapturing}
              onClick={event => {
                event.stopPropagation()
                captureCurrentFrameToImageNode()
              }}
              style={floatingNodeIconButtonStyle(false, frameCapturing)}
            >
              {frameCapturing ? (
                <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <Camera size={13} strokeWidth={2} />
              )}
            </button>
          </div>
          )}
          {galleryItems.length > 1 && !expanded && expandedVideoItems.slice(0, 3).map((item, layerIndex) => {
            const url = item.url
            const offset = layerIndex + 1
            return (
              <div
                key={`${url}-${layerIndex}`}
                className="shotflow-media-lod-content shotflow-media-lod-stack"
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 0,
                  borderRadius: 9,
                  overflow: 'hidden',
                  border: '1px solid rgba(255,255,255,0.18)',
                  background: '#090812',
                  opacity: 0.7 - layerIndex * 0.12,
                  filter: 'brightness(0.78) saturate(0.86)',
                  transform: `translate(${offset * 7}px, ${offset * 9}px) rotate(${offset * 1.25}deg)`,
                  transformOrigin: 'bottom right',
                  boxShadow: `${offset * 2}px ${offset * 6}px ${12 + offset * 7}px rgba(0,0,0,0.36)`,
                  pointerEvents: 'none',
                }}
              >
                <video
                  src={videoPreviewSrc(mediaPreviewUrl(data, url))}
                  muted
                  playsInline
                  preload="none"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </div>
            )
          })}
          <video
            ref={videoRef}
            src={displayVideoUrl}
            className="w-full shotflow-media-lod-content"
            style={{
              position: 'relative',
              zIndex: 1,
              width: shellWidth,
              maxWidth: '100%',
              height: 'auto',
              maxHeight: previewFrame.height,
              display: 'block',
              borderRadius: 9,
              boxShadow: galleryItems.length > 1 && !expanded ? '0 20px 32px rgba(0,0,0,0.32)' : undefined,
            }}
            controls={frameMode || isPanelOpen || !isGenerateVideoNode}
            controlsList="nofullscreen"
            playsInline
            preload="metadata"
            onError={() => {
              if (/^https?:\/\//i.test(String(displayVideoUrl || videoUrl)) && !genError) {
                setGenError('视频链接已失效，请重新生成或重新导入')
              }
            }}
            onDoubleClickCapture={(event) => {
              event.preventDefault()
              event.stopPropagation()
              event.nativeEvent.stopImmediatePropagation()
              openVideoPreview(videoUrl)
            }}
            onLoadedMetadata={e => {
              const video = e.currentTarget
              updateFrameNumberFromVideo(video)
              setVideoSize({ w: video.videoWidth, h: video.videoHeight })
              const durationSec = Number.isFinite(video.duration) && video.duration > 0
                ? Number(video.duration.toFixed(3))
                : undefined
              if (displayVideoUrl && displayVideoUrl !== videoUrl) {
                persistPrimaryVideoMeta({
                  displayWidth: video.videoWidth || undefined,
                  displayHeight: video.videoHeight || undefined,
                  displayDurationSec: durationSec,
                })
              } else {
                persistPrimaryVideoMeta({
                  width: video.videoWidth || undefined,
                  height: video.videoHeight || undefined,
                  durationSec,
                  extension: extensionFromUrl(videoUrl) || undefined,
                  mimeType: mimeTypeFromVideoExtension(extensionFromUrl(videoUrl)),
                })
              }
            }}
            onSeeked={e => updateFrameNumberFromVideo(e.currentTarget)}
            onTimeUpdate={e => {
              if (frameMode) updateFrameNumberFromVideo(e.currentTarget)
            }}
          />
          <div className="shotflow-media-lod-placeholder" aria-hidden="true">
            <NodeTypeIcon type="video" size={18} strokeWidth={1.8} />
            <span>视频</span>
          </div>
          {expanded && galleryItems.length > 1 && mainVideoItem && (
            <div style={videoGalleryOrderBadge(true)}>{mainVideoItem.order}</div>
          )}
          {galleryItems.length > 1 && (
            <div
              role="button"
              className="nodrag"
              style={{
                ...fixedTopRight(4, 4),
                ...floatingNodeControlBarStyle(),
                color: '#f7f5ff',
                fontSize: 14,
                cursor: 'pointer',
                fontWeight: 900,
                zIndex: 12,
                lineHeight: 1,
                padding: '1px 6px 1px 1px',
              }}
              onClick={event => {
                event.stopPropagation()
                setShowSettings(false)
                setAtMenu(false)
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
              {expanded ? '收起' : `${galleryItems.length}个`}
            </div>
          )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2"
            style={{ height: previewFrame.height, padding: 24 }}
          >
            {isFrameInterpolationNode && progressRows.length > 0 ? (
              <div
                className="nodrag"
                aria-label="视频补帧进度"
                style={{
                  width: 'min(238px, 92%)',
                  transform: `scale(${inverseZoom})`,
                  transformOrigin: 'center',
                }}
              >
                {progressRows.map((info) => (
                  <GenerationProgress
                    key={info.taskId}
                    variant="card"
                    compact
                    taskInfo={info}
                    label="视频补帧"
                    onCancel={() => cancelProgressRow(info.taskId)}
                  />
                ))}
              </div>
            ) : uploadInfo ? (
              <div
                className="nodrag"
                style={{
                  width: 'min(260px, 82%)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                  color: uploadInfo.status === 'failed' ? '#ff8a8a' : '#c4b5fd',
                  transform: `scale(${inverseZoom})`,
                  transformOrigin: 'center',
                }}
              >
                {isUploadActive ? (
                  <svg width="28" height="28" viewBox="0 0 28 28" style={{ animation: 'spin 1s linear infinite' }}>
                    <circle cx="14" cy="14" r="10.5" stroke="#312550" strokeWidth="3" fill="none" />
                    <path d="M14 3.5A10.5 10.5 0 0 1 24.5 14" stroke="#8f73ff" strokeWidth="3" strokeLinecap="round" fill="none" />
                  </svg>
                ) : (
                  <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
                    <circle cx="15" cy="15" r="11" stroke="#ff6b8a" strokeWidth="2" />
                    <path d="M11 11l8 8M19 11l-8 8" stroke="#ff6b8a" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                )}
                <div style={{ fontSize: 13, fontWeight: 650, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {uploadStatusText}
                </div>
                <div
                  style={{
                    width: '100%',
                    height: 7,
                    borderRadius: 999,
                    overflow: 'hidden',
                    background: 'rgba(196,181,253,0.16)',
                    border: '1px solid rgba(124,92,252,0.32)',
                  }}
                >
                  <div
                    style={{
                      width: `${uploadInfo.status === 'failed' ? 100 : uploadProgress}%`,
                      height: '100%',
                      borderRadius: 999,
                      background: uploadInfo.status === 'failed'
                        ? 'rgba(248,113,113,0.72)'
                        : 'linear-gradient(90deg, #7c5cfc, #bba7ff)',
                      transition: 'width 180ms ease',
                    }}
                  />
                </div>
                {uploadInfo.status === 'processing' && (
                  <div style={{ fontSize: 11, color: '#8f82b5', textAlign: 'center' }}>
                    原视频已上传，正在生成浏览压缩版
                  </div>
                )}
              </div>
            ) : (
              <svg width="36" height="36" viewBox="0 0 40 40" fill="none" opacity={0.15}>
                <polygon points="14,10 32,20 14,30" fill="#fff" />
              </svg>
            )}
          </div>
        )}
      </div>

      {/* Divider ref 鈥?bottom of video area, used for portal positioning */}
      <div ref={dividerRef} style={{ height: 0 }} />
    </NodeShell>

    {/*
      进度条挂在**整个弹窗下面**：面板开着就贴面板下沿、跟面板同宽同左；面板收起就贴节点下沿。
      放在面板里会占掉内部高度、把提示词输入区挤没（2026-08-19 用户反馈），所以一律放外面。
    */}
    {showDetachedProgress && createPortal(
      <div
        className="nodrag nopan"
        style={panelRect ? {
          position: 'fixed',
          top: panelRect.bottom + 6,
          left: panelRect.left,
          width: panelRect.width,
          zIndex: 1050,
          pointerEvents: 'auto',
        } : {
          position: 'fixed',
          top: (portalRect?.bottom ?? 0) + 6,
          left: (portalRect?.left ?? 0) + (portalRect?.width ?? 0) / 2,
          transform: 'translateX(-50%)',
          zIndex: 1050,
          pointerEvents: 'auto',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {progressRows.map((info, index) => (
            <GenerationProgress
              key={info.taskId}
              variant={panelRect ? 'panel' : 'card'}
              compact={!panelRect && (portalRect?.width ?? 0) < 260}
              taskInfo={info}
              label={progressRows.length > 1 ? `生成视频 ${index + 1}/${progressRows.length}` : '生成视频'}
              onCancel={() => cancelProgressRow(info.taskId)}
            />
          ))}
        </div>
      </div>,
      document.body
    )}

    {expanded && galleryRect && expandedVideoPlacements.length > 0 && createPortal(
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
        {expandedVideoPlacements.map(({ url, order, left, top, failed }) => failed ? (
          <div
            key={`failed-${failed.taskId}`}
            style={{
              position: 'fixed',
              left,
              top,
              width: expandedTileWidth,
              height: expandedTileHeight,
              overflow: 'auto',
              borderRadius: 9,
              background: '#1a0c10',
              border: '1px solid rgba(248,113,113,0.45)',
              boxShadow: '0 12px 26px rgba(0,0,0,0.28)',
              pointerEvents: 'auto',
              padding: 12,
              boxSizing: 'border-box',
            }}
          >
            <div style={{ color: '#fca5a5', fontSize: 12, fontWeight: 800, marginBottom: 6 }}>生成失败</div>
            <div style={{ color: '#f87171', fontSize: 11, lineHeight: 1.5, wordBreak: 'break-word' }}>{failed.error}</div>
            <div style={{ color: '#8f7a86', fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>
              {[failed.model, failed.ratio, failed.resolution, failed.durationSec ? `${failed.durationSec}s` : ''].filter(Boolean).join(' · ')}
              {failed.prompt ? <><br />{failed.prompt}</> : null}
            </div>
            <button
              className="nodrag"
              style={{ marginTop: 10, background: 'rgba(248,113,113,0.14)', border: '1px solid rgba(248,113,113,0.4)', color: '#fca5a5', borderRadius: 6, fontSize: 11, padding: '4px 10px', cursor: 'pointer' }}
              onClick={() => updateNodeData(id, {
                _failedGenerations: failedGenerations.filter((item) => item.taskId !== failed.taskId),
              })}
            >
              知道了，移除
            </button>
          </div>
        ) : (
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
            <video
              src={mediaPreviewUrl(data, url)}
              controls
              playsInline
              preload="metadata"
              style={{
                objectFit: 'cover',
                height: '100%',
                width: '100%',
                display: 'block',
              }}
            />
            <div style={videoGalleryOrderBadge()}>{order}</div>
            <div className="nodrag" style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 3, zIndex: 12 }}>
              <button
                type="button"
                style={videoGalleryActionButton('dark')}
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
                style={videoGalleryActionButton('primary')}
                onClick={event => {
                  event.stopPropagation()
                  setMainVideo(url)
                }}
              >
                设为主视频
              </button>
              <button
                type="button"
                title="删除"
                style={{
                  ...videoGalleryActionButton('dark'),
                  color: '#fecaca',
                  border: '1px solid rgba(248,113,113,0.36)',
                }}
                onClick={event => {
                  event.stopPropagation()
                  removeVideoUrl(url)
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

    {/* Panel 鈥?rendered as portal so it stays fixed-size at any canvas zoom */}
    {isPanelOpen && !expanded && portalRect && createPortal(
      <div
        ref={panelPortalRef}
        className={panelExpanded ? 'nodrag shotflow-node-popover-backdrop' : 'nodrag shotflow-node-popover shotflow-node-popover-video'}
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
          left: panelLeft,
          width: effectivePanelWidth,
          ...(panelSize ? { height: panelSize.height, overflow: 'visible' } : {}),
          zIndex: 1000,
          background: '#171320',
          borderRadius: 10,
          border: '1px solid rgba(124,92,252,0.18)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.42)',
        }}
      >
      <div className="shotflow-node-popover-shell" style={panelExpanded ? {
        width: expandedPanelWidth,
        maxHeight: '86vh',
        overflowY: 'auto',
        background: '#1a1625',
        borderRadius: 16,
        border: '1px solid #2d2040',
        boxShadow: '0 24px 80px rgba(0,0,0,0.68)',
      } : panelSize ? { height: '100%', overflow: 'hidden', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0 } : {}}>
      <>

      {/* Mode tabs + expand */}
      <div
        className="flex items-center nodrag shotflow-node-popover-tabs"
        role="tablist"
        aria-label="视频生成模式"
        style={{ borderBottom: '1px solid rgba(124,92,252,0.12)', ...(panelSize ? { flexShrink: 0 } : {}) }}
      >
        <div className="flex flex-1 px-1.5 pt-0.5 gap-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {modeOptions.map(m => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={mode === m.key}
              className={`text-sm px-2.5 py-1.5 whitespace-nowrap nodrag${mode === m.key ? ' is-active' : ''}`}
              style={{
                background: 'none',
                color: mode === m.key ? '#c4b5fd' : '#5a5070',
                border: 'none',
                cursor: 'pointer',
                borderBottom: mode === m.key ? '2px solid #7c5cfc' : '2px solid transparent',
                fontWeight: mode === m.key ? 500 : 400,
                transition: 'color 0.15s',
              }}
              onPointerDown={event => event.stopPropagation()}
              onClick={event => {
                event.preventDefault()
                event.stopPropagation()
                setParam('modeType', m.key as never)
              }}
            >{m.label}</button>
          ))}
        </div>
        <button
          className="nodrag"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7b6fa0', fontSize: 13, padding: '0 8px 0 3px' }}
          title={panelExpanded ? '收起面板' : '展开面板'}
          onClick={() => {
            setShowSettings(false)
            setAtMenu(false)
            setPanelExpanded(value => !value)
          }}
        >
          {panelExpanded ? '↙' : '⤢'}
        </button>
      </div>

      <div className="flex items-center gap-1 px-2 py-1.5 nodrag shotflow-node-popover-reference-row" style={{ borderBottom: '1px solid rgba(124,92,252,0.12)', ...(panelSize ? { flexShrink: 0 } : {}) }}>
        {/* Connected image thumbnails 鈥?drag reorder, 脳 delete, hover zoom */}
        {connectedImages.map((ref, i) => (
          <div key={ref.nodeId}
            className="relative nodrag reference-thumb"
            style={{ flexShrink: 0, width: 44, height: 42, overflow: 'visible' }}
            draggable
            onDragStart={e => e.dataTransfer.setData('thumb-idx', String(i))}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); moveConnectedImage(Number(e.dataTransfer.getData('thumb-idx')), i) }}
            onMouseEnter={e => {
              scheduleHoverPreview(ref.nodeId, ref.url, ref.orderName, (e.currentTarget as HTMLElement).getBoundingClientRect())
            }}
            onMouseLeave={() => hideHoverPreview(ref.nodeId)}
          >
            <div
              className="rounded overflow-hidden"
              style={{
                width: 44, height: 42, border: '1px solid rgba(124,92,252,0.18)', cursor: 'zoom-in',
                // 当前模式收不了这类素材：置灰 + 说明，别等点了生成才知道
                ...(unusableRefKinds.images ? { filter: 'grayscale(1)', opacity: 0.42 } : {}),
              }}
              onClick={() => setPreviewUrl(ref.url)}
              title={unusableRefKinds.images ? `${ref.orderName}：当前模式不用参考图` : `预览${ref.orderName}`}
            >
              <img src={ref.url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <button
              type="button"
              className="nodrag nopan reference-thumb-action is-at"
              title="@引用"
              aria-label="@引用"
              onPointerDown={e => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onMouseDown={e => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                handleReferenceMention(ref)
              }}
              style={{
                position: 'absolute', left: -5, bottom: -5, zIndex: 3, width: 17, height: 17,
                borderRadius: 999, border: '1px solid rgba(225,218,255,0.5)',
                background: 'rgba(12,18,32,0.18)', color: 'rgba(246,243,255,0.92)',
                fontSize: 10, fontWeight: 700, lineHeight: 1, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 3px 10px rgba(0,0,0,0.32)',
              }}
            >@</button>
            {/* 脳 delete button */}
            <button
              type="button"
              className="nodrag reference-thumb-action is-remove"
              title="取消参考"
              aria-label="取消参考"
              onPointerDown={e => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onMouseDown={e => {
                e.preventDefault()
                e.stopPropagation()
              }}
              style={{
                position: 'absolute', top: -6, right: -6, width: 15, height: 15,
                borderRadius: '50%', background: '#312550', border: '1px solid #5a4080',
                color: '#c4b5fd', fontSize: 9, cursor: 'pointer', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                removeConnectedRef('imageList', ref.nodeId)
              }}
            >×</button>
            {/* Order label */}
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center',
              fontSize: 7, color: 'rgba(255,255,255,0.66)', background: 'rgba(0,0,0,0.5)',
              lineHeight: '12px', pointerEvents: 'none',
            }}>{ref.orderName}</div>
          </div>
        ))}
        {connectedVideos.map(ref => (
          <div key={ref.nodeId}
            className="relative nodrag reference-thumb"
            style={{ flexShrink: 0, width: 44, height: 42, overflow: 'visible' }}
            onMouseEnter={e => {
              scheduleHoverPreview(
                ref.nodeId,
                ref.coverSrc || videoPreviewSrc(ref.url),
                ref.orderName,
                (e.currentTarget as HTMLElement).getBoundingClientRect(),
                'video',
              )
            }}
            onMouseLeave={() => hideHoverPreview(ref.nodeId)}
          >
            <div
              className="rounded overflow-hidden"
              title={unusableRefKinds.videos ? `${ref.orderName}：当前模式不用参考视频` : `预览${ref.orderName}`}
              style={{
                width: 44, height: 42, border: '1px solid rgba(124,92,252,0.18)', background: '#151022', position: 'relative', cursor: 'zoom-in',
                ...(unusableRefKinds.videos ? { filter: 'grayscale(1)', opacity: 0.42 } : {}),
              }}
            >
              <ReferenceVideoCover src={ref.coverSrc || videoPreviewSrc(ref.url)} poster={ref.poster} iconSize={13} />
            </div>
            <button
              type="button"
              className="nodrag nopan reference-thumb-action is-at"
              title="@引用"
              aria-label="@引用"
              onPointerDown={e => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onMouseDown={e => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                handleReferenceMention(ref)
              }}
              style={{
                position: 'absolute', left: -5, bottom: -5, zIndex: 3, width: 17, height: 17,
                borderRadius: 999, border: '1px solid rgba(225,218,255,0.5)',
                background: 'rgba(12,18,32,0.18)', color: 'rgba(246,243,255,0.92)',
                fontSize: 10, fontWeight: 700, lineHeight: 1, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 3px 10px rgba(0,0,0,0.32)',
              }}
            >@</button>
            <button
              type="button"
              className="nodrag reference-thumb-action is-remove"
              title="取消参考"
              aria-label="取消参考"
              onPointerDown={e => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onMouseDown={e => {
                e.preventDefault()
                e.stopPropagation()
              }}
              style={{
                position: 'absolute', top: -6, right: -6, width: 15, height: 15,
                borderRadius: '50%', background: '#312550', border: '1px solid #5a4080',
                color: '#c4b5fd', fontSize: 9, cursor: 'pointer', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                removeConnectedRef('videoList', ref.nodeId)
              }}
            >×</button>
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center',
              fontSize: 7, color: 'rgba(255,255,255,0.72)', background: 'rgba(0,0,0,0.5)',
              lineHeight: '12px', pointerEvents: 'none',
            }}>{ref.orderName}</div>
          </div>
        ))}
        {connectedAudios.map(ref => (
          <div key={ref.nodeId}
            className="relative nodrag"
            style={{ flexShrink: 0, width: 34, height: 32 }}
          >
            <div className="rounded overflow-hidden" style={{ width: 34, height: 32, border: '1px solid rgba(124,92,252,0.18)', background: '#151022', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#efeaff' }}>
              <NodeTypeIcon type="audio" size={15} />
            </div>
            <button
              className="nodrag"
              style={{
                position: 'absolute', top: -4, right: -4, width: 13, height: 13,
                borderRadius: '50%', background: '#312550', border: '1px solid #5a4080',
                color: '#c4b5fd', fontSize: 9, cursor: 'pointer', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onClick={() => removeConnectedRef('audioList', ref.nodeId)}
            >×</button>
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center',
              fontSize: 7, color: 'rgba(255,255,255,0.72)', background: 'rgba(0,0,0,0.5)',
              lineHeight: '12px', pointerEvents: 'none',
            }}>{ref.orderName}</div>
          </div>
        ))}
      </div>
      {connectedVideos.length > 0 && referenceVideoNote && (
        <div
          className="px-3 py-2 nodrag shotflow-node-popover-reference-note"
          style={{ borderBottom: '1px solid rgba(124,92,252,0.12)', fontSize: 10, color: '#6a5a8a', ...(panelSize ? { flexShrink: 0 } : {}) }}
        >
          {referenceVideoNote}
        </div>
      )}
      {/* 参考素材和当前模式不匹配时，点生成之前就说清楚（2026-08-26 用户反馈：
          以前要点了生成才看到「视频编辑最多支持 0 个图片参考」这种话） */}
      {refKindWarning && (
        <div
          className="px-3 py-2 nodrag shotflow-node-popover-reference-note"
          style={{
            borderBottom: '1px solid rgba(255,170,90,0.2)', fontSize: 10, lineHeight: 1.5,
            color: '#e8b478', background: 'rgba(255,170,90,0.08)',
            ...(panelSize ? { flexShrink: 0 } : {}),
          }}
        >
          {refKindWarning}
        </div>
      )}

      {/* Prompt 鈥?PromptEditor with scrollable area */}
      <div ref={promptPanelRef} className="px-2 pt-1.5 pb-1 nodrag shotflow-node-popover-prompt-area" style={{ position: 'relative', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', ...(panelSize ? { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } : {}) }}>
        <div
          className="nodrag shotflow-prompt-header"
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
          </div>
        </div>
        {/* Scrollable wrapper with styled scrollbar */}
        <div
          className="nodrag shotflow-node-popover-scroll"
          style={{
            maxHeight: panelSize ? 'none' : panelPromptMaxHeight,
            overflowY: 'auto',
            overflowX: 'hidden',
            paddingRight: 3,
            scrollbarWidth: 'thin',
            scrollbarColor: '#312550 transparent',
            width: '100%',
            maxWidth: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            ...(panelSize ? { flex: '1 1 auto', minHeight: 0 } : {}),
          }}
        >
          <PromptEditor
            ref={editorRef}
            value={params.prompt}
            chips={chips}
            htmlSnapshot={promptHtmlSnapshot}
            onChange={handlePromptChange}
            onAtKey={() => {
              if (connectedMedia.length === 0) return
              setActiveMentionIndex(0)
              setAtMenu(true)
            }}
            onEscape={() => setAtMenu(false)}
            mentionMenuOpen={atMenu}
            onMentionNavigate={handleMentionNavigate}
            onMentionSelect={handleMentionSelect}
            placeholder="描述你想要生成的视频内容，@引用素材"
            orderMap={orderMap}
            resolveTextMention={resolveTextMention}
            resolveTextMentionsIn={resolveTextMentionsIn}
            style={{ fontSize: 13, lineHeight: 1.45, minHeight: 56, color: '#e8e1ff' }}
          />
        </div>

        {/* @ dropdown */}
        {atMenu && connectedMedia.length > 0 && createPortal(
          <div className="nodrag" data-at-mention-dropdown="1" style={{
            position: 'fixed',
            left: mentionMenuLeft,
            top: Math.max(12, mentionMenuTop),
            background: '#16112a', border: '1px solid #312550',
            borderRadius: 10,
            overflowY: 'auto',
            overflowX: 'hidden',
            minWidth: 220,
            maxWidth: 320,
            maxHeight: Math.min(320, Math.max(150, viewportHeight - 32)),
            boxShadow: '0 18px 44px rgba(0,0,0,0.72)',
            zIndex: 2600,
          }}>
            <div style={{ padding: '5px 10px 4px', fontSize: 10, color: '#5a5070' }}>引用素材</div>
            {connectedMedia.map((ref, index) => (
              <button key={ref.nodeId} className="nodrag flex items-center gap-2 w-full"
                style={{
                  background: index === activeMentionIndex ? 'rgba(124,92,252,0.15)' : 'none',
                  border: 'none', cursor: 'pointer', padding: '6px 10px', color: '#c4b5fd', fontSize: 12,
                }}
                onMouseEnter={() => setActiveMentionIndex(index)}
                onMouseDown={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleAtInsert({ nodeId: ref.nodeId, url: ref.url, name: ref.orderName, mediaType: ref.previewKind })
                }}
              >
                {ref.previewKind === 'image' ? (
                    <img src={mediaPreviewUrl(nodes.find(node => node.id === ref.nodeId)?.data ?? data, ref.url)} draggable={false} style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />
                ) : ref.previewKind === 'video' ? (
                  <span style={{ width: 24, height: 24, position: 'relative', display: 'block', borderRadius: 3, overflow: 'hidden', background: '#221a36', flexShrink: 0 }}>
                    <ReferenceVideoCover src={ref.coverSrc || videoPreviewSrc(ref.url)} poster={ref.poster} iconSize={11} />
                  </span>
                ) : (
                  <span style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 3, background: '#221a36', color: '#efeaff', flexShrink: 0 }}>
                    <NodeTypeIcon type={ref.previewKind} size={12} />
                  </span>
                )}
                <span>{ref.orderName}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
      </div>

      {/* Error */}
      {(genError || data.taskInfo?.status === 3) && (
        <div className="mx-2 mb-1 px-2 py-0.5 rounded text-xs nodrag flex items-center justify-between shotflow-node-popover-error"
          style={{ background: '#2a1020', color: '#f87171', ...(panelSize ? { flexShrink: 0 } : {}) }}>
          <span>{genError ?? errorToText(data.taskInfo?.error, '生成失败')}</span>
          <button className="nodrag" style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 10 }}
            onClick={() => { setGenError(null); updateNodeData(id, { taskInfo: undefined }) }}>清除</button>
        </div>
      )}

      {promptWashStatus && (
        <div className="mx-2 mb-2 nodrag" style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid ' + (promptWashStatus === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(124,92,252,0.25)'), background: promptWashStatus === 'error' ? 'rgba(127,29,29,0.18)' : 'rgba(124,92,252,0.08)', color: promptWashStatus === 'error' ? '#fca5a5' : '#cfc3ff', fontSize: 11 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span>{promptWashStatus === 'loading' ? '正在洗提示词…' : promptWashMessage || (promptWashStatus === 'done' ? '洗提示词完成' : '洗提示词失败')}</span>
            {promptWashStatus === 'loading' && <span>{promptWashProgress}%</span>}
          </div>
          {promptWashStatus === 'loading' && <div style={{ height: 4, marginTop: 6, borderRadius: 99, overflow: 'hidden', background: 'rgba(196,181,253,0.14)' }}><div style={{ width: promptWashProgress + '%', height: '100%', borderRadius: 99, background: 'linear-gradient(90deg, #7c5cfc, #c4b5fd)', transition: 'width .3s ease' }} /></div>}
        </div>
      )}

      {/* 进度条只在两处渲染，且互斥：面板内那条（本文件下方 shotflow-node-popover-progress-row）
          和面板收起时游离在节点下方那条（showDetachedProgress）。这里原先还有第三处，被
          `isLoading && false` 长期关着，是死代码，已删。 */}

      {/* Bottom bar wrapper 鈥?settings popup floats above */}
      <div ref={bottomWrapRef} className="relative nodrag shotflow-node-popover-bottom-wrap" style={{ borderTop: '1px solid rgba(124,92,252,0.12)', ...(panelSize ? { flexShrink: 0 } : {}) }}>
        {/*
          这个弹层必须 portal 到 body，不能留在面板里：留在里面它就被面板上边裁掉，
          被裁掉的正是最上面的「比例」「清晰度」两行（2026-08-19 的"改不了分辨率"）。
          出去之后按视口决定往上还是往下展开，目标是**完整显示**，限高滚动只作最后兜底。
        */}
        {showSettings && settingsAnchor && createPortal(
          <div
            ref={settingsPopoverRef}
            className="nodrag nowheel shotflow-node-popover-settings"
            style={{
              position: 'fixed',
              left: settingsAnchor.left,
              width: settingsAnchor.width,
              ...settingsPlacement,
              background: '#13102a', border: '1px solid #312550',
              borderRadius: 9, padding: '10px 12px',
              boxShadow: '0 -8px 24px rgba(0,0,0,0.6)', zIndex: 1100,
              overflowY: settingsPlacement.maxHeight ? 'auto' : 'visible',
              boxSizing: 'border-box',
            }}
          >
            <div className="mb-3">
              <div className="text-xs mb-2" style={{ color: '#5a5070' }}>比例</div>
              <div className="flex flex-wrap gap-2">
                {ratioOptions.map(r => {
                  const active = ratio === r.value
                  return (
                    <button key={r.value}
                      className="flex flex-col items-center justify-end gap-1 rounded nodrag"
                      style={{ background: active ? '#2a1f50' : '#1e1830', border: active ? '1px solid #7c5cfc' : '1px solid #312550', cursor: 'pointer', padding: '7px 10px 6px', minWidth: 46 }}
                      onClick={() => setSettings('ratio', r.value)}
                    >
                      <div style={{ width: 28, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ width: r.w, height: r.h, border: `1.5px solid ${active ? '#a78bfa' : '#5a5070'}`, borderRadius: 2, background: active ? 'rgba(124,92,252,0.18)' : 'transparent' }} />
                      </div>
                      <span style={{ fontSize: 10, color: active ? '#c4b5fd' : '#6a5a8a' }}>{r.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="mb-3">
              <div className="text-xs mb-2" style={{ color: '#5a5070' }}>清晰度</div>
              <div className="flex gap-2">
                {resolutionOptions.map(r => (
                  <button key={r} className="flex-1 text-sm py-1.5 rounded nodrag"
                    style={{ background: resolution === r ? '#7c5cfc' : '#1e1830', color: resolution === r ? '#fff' : '#8a7aaa', border: resolution === r ? 'none' : '1px solid #312550', cursor: 'pointer' }}
                    // 提示只能挂在 title 上，**不许**在弹层里多加一行：这个弹层是 bottom:100% 向上
                    // 展开的，多一行就把最上面的「比例」「清晰度」顶出屏幕顶部，而且超出视口的部分
                    // 既看不见也滚不到 —— 2026-08-19「不能调分辨率了」就是这么来的。
                    title={getVideoResolutionNote(model, r) || undefined}
                    onClick={() => setVideoResolution(r)}>{r}</button>
                ))}
              </div>
            </div>
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs" style={{ color: '#5a5070' }}>视频时长</span>
                <span className="text-sm font-medium" style={{ color: '#c4b5fd' }}>{durationLabel}</span>
              </div>
              {durationLockedToInput ? (
                <div className="text-xs rounded nodrag" style={{ background: '#1e1830', border: '1px solid #312550', color: '#8a7aaa', padding: '8px 10px' }}>
                  当前模式按输入视频时长生成
                </div>
              ) : (
                <>
                  <input type="range" min={durationRule.min} max={durationRule.max} step={durationRule.step || 1} value={duration}
                    className="w-full nodrag" style={{ accentColor: '#7c5cfc', cursor: 'pointer' }}
                    onChange={e => setSettings('duration', Number(e.target.value))} />
                  <div className="flex justify-between mt-1">
                    <span style={{ fontSize: 10, color: '#5a5070' }}>{durationRule.min}s</span>
                    <span style={{ fontSize: 10, color: '#5a5070' }}>{durationRule.max}s</span>
                  </div>
                </>
              )}
            </div>
            <div>
              <div className="text-xs mb-2" style={{ color: '#5a5070' }}>生成音频</div>
              <div className="flex gap-2">
                {(['on', 'off'] as const).map(v => (
                  <button key={v} className="flex-1 text-sm py-2 rounded nodrag"
                    style={{ background: sound === v ? '#7c5cfc' : '#1e1830', color: sound === v ? '#fff' : '#8a7aaa', border: sound === v ? 'none' : '1px solid #312550', cursor: 'pointer', fontWeight: sound === v ? 600 : 400, transition: 'background 0.15s' }}
                    onClick={() => setSettings('enableSound', v)}>
                    {v === 'on' ? '开启' : '关闭'}
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
      <div
        className="flex items-center gap-1 px-2 py-1.5 nodrag shotflow-node-popover-bottom-bar"
        style={{ flexWrap: 'wrap', rowGap: 5 }}
      >
        {/* Model selector */}
        <select
          className="text-sm rounded px-2 py-1 nodrag"
          style={{
            background: '#1e1830', border: '1px solid #312550',
            color: '#d1c6ff',
            width: 156,
            minWidth: 156,
            maxWidth: 190,
            flex: '0 0 156px',
            fontSize: 12,
            fontWeight: 600,
            outline: 'none',
          }}
          value={model}
          onChange={e => setParam('model', e.target.value)}
        >
          {VIDEO_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>

        {/* Settings pill */}
        <button
          className="flex items-center gap-1 text-xs px-2 py-1 rounded nodrag"
          style={{
            background: '#1e1830', border: '1px solid #312550',
            color: '#8a7aaa', cursor: 'pointer', whiteSpace: 'nowrap',
            width: 'auto',
            minWidth: 132,
            flex: '0 0 auto',
            boxSizing: 'border-box',
            justifyContent: 'center',
          }}
          title={`${ratio === 'adaptive' ? '自适应' : ratio} · ${resolution} · ${durationLabel}${sound === 'on' ? ' · 开启声音' : ''}`}
          onClick={() => setShowSettings(v => !v)}
        >
          <span style={{ flexShrink: 0 }}>{ratio === 'adaptive' ? '自适应' : ratio}</span>
          <span style={{ opacity: 0.3 }}>·</span>
          <span style={{ flexShrink: 0 }}>{resolution}</span>
          <span style={{ opacity: 0.3 }}>·</span>
          <span style={{ flexShrink: 0 }}>{durationLabel}</span>
          {sound === 'on' && <span style={{ fontSize: 11, flexShrink: 0 }}>·🔊</span>}
        </button>

        {/* Translate */}
        <button
          className="text-xs px-1.5 py-1 rounded nodrag"
          style={{
            background: '#1e1830', border: '1px solid #312550',
            color: isTranslating ? '#c4b5fd' : '#8a7aaa',
            cursor: isTranslating ? 'wait' : 'pointer',
            fontWeight: 500,
            width: 34,
            minWidth: 34,
            maxWidth: 34,
            height: 28,
            flex: '0 0 34px',
            whiteSpace: 'nowrap',
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: isTranslating ? 0.92 : 1,
          }}
          title="翻译为英文提示词，保留 @ 图片/视频引用"
          type="button"
          disabled={isTranslating}
          onClick={handleTranslatePrompt}
        >
          {isTranslating ? <Loader2 size={13} className="animate-spin" /> : '文A'}
        </button>

        <div style={{ flex: 1 }} />

        <div className="flex items-center nodrag" style={{ gap: 3, flexShrink: 0 }}>
          {canChooseGenerationCount && (
            <select
              className="nodrag"
              value={generationCount}
              onChange={e => setParam('count', Number(e.target.value))}
              title="生成个数"
              style={{
                height: 28,
                background: '#1e1830',
                border: '1px solid #312550',
                borderRadius: 7,
                color: '#c4b5fd',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                outline: 'none',
                padding: '0 6px',
                width: 52,
                minWidth: 52,
                maxWidth: 52,
                flex: '0 0 52px',
              }}
            >
              {generationCountOptions.map(n => <option key={n} value={n}>{n}个</option>)}
            </select>
          )}
          {isSeedanceModel && (
            <div ref={promptSkillWrapRef} className="relative nodrag" style={{ flexShrink: 0 }}>
              <button
                type="button"
                className="nodrag"
                aria-label="Seedance Skill 库"
                title="按片种 Skill 复制节点并洗提示词"
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); setPromptWashOpen(false); setPromptWashModelMenu(null); setPromptSkillMenu(null); setPromptSkillOpen(value => !value) }}
                style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(124,92,252,0.35)', background: promptSkillOpen ? '#2a1f50' : '#1e1830', color: '#c4b5fd', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Library size={15} strokeWidth={1.8} />
              </button>
              {promptSkillOpen && (
                <div className="nodrag nopan" style={{ position: 'absolute', right: 0, bottom: 38, width: 300, maxHeight: 420, overflow: 'hidden', padding: 6, borderRadius: 10, background: '#171320', border: '1px solid rgba(124,92,252,0.3)', boxShadow: '0 12px 30px rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ padding: '4px 7px 6px', color: '#9488ad', fontSize: 10, flexShrink: 0 }}>切换分组后点 Skill，再选 Opus 或 GPT Luna。无提示词时按节点名和参考图扩写。</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0 4px 8px', flexShrink: 0 }}>
                    {SEEDANCE_PROMPT_SKILL_CATEGORIES.map(category => {
                      const selected = promptSkillCategory === category.id
                      return (
                        <button
                          key={category.id}
                          type="button"
                          className="nodrag nopan"
                          onPointerDown={event => event.stopPropagation()}
                          onClick={event => { event.stopPropagation(); setPromptSkillCategory(category.id); setPromptSkillMenu(null); setPromptSkillHoverId(null) }}
                          style={{ height: 24, padding: '0 8px', borderRadius: 999, border: '1px solid ' + (selected ? 'rgba(196,181,253,0.55)' : 'rgba(124,92,252,0.22)'), background: selected ? 'rgba(124,92,252,0.38)' : '#1e1830', color: selected ? '#f4efff' : '#b9a9ef', fontSize: 10, fontWeight: selected ? 750 : 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
                        >
                          {category.label}
                        </button>
                      )
                    })}
                  </div>
                  <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
                    {SEEDANCE_PROMPT_SKILLS.filter(skill => skill.category === promptSkillCategory).map(skill => {
                      const modelMenuOpen = promptSkillMenu === skill.id
                      const hovered = promptSkillHoverId === skill.id || modelMenuOpen
                      return (
                        <div key={skill.id}>
                          <button type="button" className="nodrag nopan" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setPromptSkillMenu(modelMenuOpen ? null : skill.id) }} onMouseEnter={() => setPromptSkillHoverId(skill.id)} onMouseLeave={() => setPromptSkillHoverId(null)} style={{ width: '100%', display: 'block', padding: '6px 8px', textAlign: 'left', border: '1px solid ' + (hovered ? 'rgba(196,181,253,0.42)' : 'transparent'), borderRadius: 7, background: hovered ? 'rgba(124,92,252,0.28)' : 'transparent', color: '#e8e1f7', cursor: 'pointer' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ fontSize: 11, fontWeight: 700 }}>{skill.name}</span>
                              <span style={{ color: '#c4b5fd', fontSize: 10 }}>{modelMenuOpen ? '收起' : '选模型'}</span>
                            </div>
                            <div style={{ marginTop: 2, color: '#9488ad', fontSize: 10 }}>{skill.description}</div>
                          </button>
                          {modelMenuOpen && (
                            <div className="nodrag nopan" style={{ display: 'flex', gap: 6, padding: '0 4px 6px' }}>
                              {PROMPT_WASH_TEXT_CHOICES.map(choice => (
                                <button key={choice.value} type="button" className="nodrag nopan" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setPromptSkillOpen(false); setPromptSkillMenu(null); void washVideoPrompt('conservative', choice.value, skill.id) }} style={{ flex: 1, height: 28, borderRadius: 7, border: '1px solid rgba(196,181,253,0.4)', background: '#2a2140', color: '#f4efff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                  {choice.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          {isPromptWashModel && (
            <div ref={promptWashWrapRef} className="relative nodrag" style={{ flexShrink: 0 }}>
              <button
                type="button"
                className="nodrag"
                aria-label="洗提示词"
                title="洗提示词并复制视频节点"
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); setPromptSkillOpen(false); setPromptSkillMenu(null); setPromptWashModelMenu(null); setPromptWashOpen(value => !value) }}
                style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(124,92,252,0.35)', background: promptWashOpen ? '#2a1f50' : '#1e1830', color: '#c4b5fd', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Wand2 size={15} strokeWidth={1.8} />
              </button>
              {promptWashOpen && (
                <div className="nodrag nopan" style={{ position: 'absolute', right: 0, bottom: 38, width: 228, padding: 6, borderRadius: 10, background: '#171320', border: '1px solid rgba(124,92,252,0.3)', boxShadow: '0 12px 30px rgba(0,0,0,0.5)', zIndex: 1200 }}>
                  <div style={{ padding: '4px 7px 6px', color: '#9488ad', fontSize: 10 }}>{'\u70b9\u9009\u6a21\u5f0f\uff0c\u518d\u9009 Opus \u6216 GPT Luna'}</div>
                  {PROMPT_WASH_MODES.filter(option => isMiniMaxModel ? option.value === 'minimax' : option.value !== 'minimax').map(option => {
                    const modelMenuOpen = promptWashModelMenu === option.value
                    return (
                    <div key={option.value}>
                      <button type="button" className="nodrag nopan" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setPromptWashModelMenu(modelMenuOpen ? null : option.value) }} onMouseEnter={() => setPromptWashHoverMode(option.value)} onMouseLeave={() => setPromptWashHoverMode(null)} style={{ width: '100%', display: 'block', padding: '7px 8px', textAlign: 'left', border: '1px solid ' + ((promptWashHoverMode === option.value || modelMenuOpen) ? 'rgba(196,181,253,0.42)' : 'transparent'), borderRadius: 7, background: (promptWashHoverMode === option.value || modelMenuOpen) ? 'rgba(124,92,252,0.28)' : 'transparent', color: '#e8e1f7', cursor: 'pointer' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700 }}>{option.label}</span>
                          <span style={{ color: '#c4b5fd', fontSize: 10 }}>{modelMenuOpen ? '\u6536\u8d77' : '\u9009\u6a21\u578b'}</span>
                        </div>
                        <div style={{ marginTop: 2, color: '#9488ad', fontSize: 10 }}>{option.description}</div>
                      </button>
                      {modelMenuOpen && (
                        <div className="nodrag nopan" style={{ display: 'flex', gap: 6, padding: '0 4px 6px' }}>
                          {PROMPT_WASH_TEXT_CHOICES.map(choice => (
                            <button key={choice.value} type="button" className="nodrag nopan" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setPromptWashOpen(false); setPromptWashModelMenu(null); void washVideoPrompt(option.value, choice.value) }} style={{ flex: 1, height: 28, borderRadius: 7, border: '1px solid rgba(196,181,253,0.4)', background: '#2a2140', color: '#f4efff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                              {choice.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {/* Generate button */}
          <button
            className="flex items-center justify-center nodrag shotflow-node-primary-action"
            style={{
              width: 30, height: 30, borderRadius: 8, flexShrink: 0,
              background: generateLocked ? '#1e1830' : '#ffffff',
              border: 'none',
              cursor: generateLocked ? 'default' : 'pointer',
              color: generateLocked ? '#7c5cfc' : '#111',
              boxShadow: generateLocked ? 'none' : '0 2px 8px rgba(0,0,0,0.25)',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { if (!generateLocked) (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0' }}
            onMouseLeave={e => { if (!generateLocked) (e.currentTarget as HTMLButtonElement).style.background = '#ffffff' }}
            onClick={handleGenerate}
            disabled={generateLocked}
            title={generateLockTitle}
          >
            {generateLocked
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
      </div>
      </div>{/* end bottom bar wrapper */}
      {/*
        进度条**只有全屏模式**才画在面板里 —— 全屏时面板就是整个弹窗，最后一行本身就是"下面"。
        普通模式下画在面板里会占掉内部高度，把提示词输入区挤没（2026-08-19 用户反馈），
        所以那种情况改成挂在面板外、整个弹窗下方，见下方 progressBelowPanel 那个 portal。
      */}
      {panelExpanded && progressRows.length > 0 && (
        <div className="px-2 pb-2 nodrag shotflow-node-popover-progress-row" style={panelSize ? { flexShrink: 0 } : undefined}>
          {progressRows.map((info, index) => (
            <GenerationProgress
              key={info.taskId}
              variant="panel"
              taskInfo={info}
              label={progressRows.length > 1 ? `生成视频 ${index + 1}/${progressRows.length}` : '生成视频'}
              onCancel={() => cancelProgressRow(info.taskId)}
            />
          ))}
        </div>
      )}

      </>
      </div>
      {!panelExpanded && <ResizablePanelHandle onPointerDown={handlePanelResizeStart} />}
      </div>,
      document.body
    )}{/* end controls portal */}

    {/* Hover zoom Portal 鈥?outside overflow-hidden */}
    <HoverImagePreview entry={hoverThumb} />
    {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    {/* 视频大图查看器：跟图片节点同一个组件、同一套外观（顶部工具条 / 计数 / 缩略图轨道 /
        主视频按钮 / 节点功能行），只是 kind="video"。
        items 一律用**原始地址**：设为主视频比的是 data._primaryAssetUrl，下载也以它为准，
        换成 mediaPreviewUrl 那个轻量预览地址会把这两件事都对不上。 */}
    {videoPreviewUrl && <ImagePreview
      kind="video"
      url={videoPreviewUrl}
      items={videoPreviewItems}
      onSetPrimary={setMainVideo}
      primaryUrl={videoUrl}
      nodeActions={mediaToolbarActions}
      onRemoveItem={removeVideoUrl}
      name={data.name}
      loadVideoResourceMeta={loadVideoResourceMeta}
      onClose={() => setVideoPreviewUrl(null)}
    />}
    {trimOpen && videoUrl && (
      <VideoTrimModal
        url={videoUrl}
        name={data.name || '视频'}
        durationHintSec={Number(currentVideoMeta?.durationSec) || undefined}
        onCancel={() => {
          if (!trimSubmitting) setTrimOpen(false)
        }}
        onConfirm={handleTrimAccept}
      />
    )}
    {cropOpen && videoUrl && (
      <VideoCropModal
        url={videoUrl}
        name={data.name || '视频'}
        sourceWidthHint={Number(currentVideoMeta?.width) || undefined}
        sourceHeightHint={Number(currentVideoMeta?.height) || undefined}
        onCancel={() => {
          if (!cropSubmitting) setCropOpen(false)
        }}
        onConfirm={handleCropAccept}
      />
    )}
    {uiRemovalOpen && videoUrl && (
      <VideoUiRemovalModal
        name={data.name || '视频'}
        durationHintSec={sourceDurationHint}
        onCancel={() => { if (!uiRemovalSubmitting) setUiRemovalOpen(false) }}
        onPreview={handleUiRemovalPreview}
        onConfirm={handleUiRemovalAccept}
      />
    )}
    {frameInterpolationOpen && videoUrl && (
      <VideoFrameInterpolationModal
        url={videoUrl}
        name={data.name || '视频'}
        sourceFpsHint={sourceFpsHint}
        sourceWidthHint={sourceWidthHint}
        sourceHeightHint={sourceHeightHint}
        durationHintSec={sourceDurationHint}
        onCancel={() => {
          if (!frameInterpolationSubmitting) setFrameInterpolationOpen(false)
        }}
        onConfirm={handleFrameInterpolationAccept}
      />
    )}
    {mediaEnhance.modal}
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
    </>
  )
}
