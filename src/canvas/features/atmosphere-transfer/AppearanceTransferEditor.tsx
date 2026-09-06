import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  analyzeAppearanceImage,
  renderAppearancePreview,
  type AppearancePreviewControls,
  type AppearanceReferenceProfile,
} from './appearance-transfer-color'
import { DEFAULT_APPEARANCE_BACKENDS } from './appearance-transfer-execution'
import {
  clampPreviewZoom,
  computeContainedPreviewSize,
  computePreviewPanScroll,
  computePreviewZoomScroll,
  computePreviewZoomSpace,
  nextPreviewZoom,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
  PREVIEW_ZOOM_STEP,
} from './appearance-transfer-layout'
import { createAppearanceResolutionPlan } from './appearance-transfer-resolution'
import {
  computeReferenceCoverCrop,
  renderReferenceCleanupMaskFile,
} from './appearance-transfer-reference-composite'
import {
  appearanceBackendLabel,
  getAppearanceBackendDefinition,
  type AppearanceFinalizerBackendId,
} from './appearance-transfer-backends'
import {
  appearanceHistoryModeLabel,
  appearanceHistoryResultLabel,
  type AppearanceHistoryResult,
} from './appearance-transfer-history'
import {
  allowedRouteALightColors,
  isRouteASupportedBackend,
  ROUTE_A_EXPERIMENTAL_PROMPT_SCHEMA_VERSION,
  ROUTE_A_PROMPT_SCHEMA_VERSION,
  type RouteAReferenceMode,
} from './appearance-transfer-route-a'
import { AppearanceReferenceExperimentDialog } from './AppearanceReferenceExperimentDialog'
import { appearanceQualityWarningLabel } from './appearance-transfer-quality'
import {
  clampAppearancePercent,
  type AppearanceBackendOption,
  type AppearanceTransferState,
} from './appearance-transfer-types'
import './appearance-transfer.css'

type AppearanceTransferEditorProps = {
  sourceUrl: string
  referenceUrl?: string | null
  sourceTitle?: string
  referenceTitle?: string
  state: AppearanceTransferState
  historyResults?: AppearanceHistoryResult[]
  backends?: AppearanceBackendOption[]
  open?: boolean
  generating?: boolean
  generationError?: string | null
  onChange: (state: AppearanceTransferState) => void
  onReferenceProfile?: (profile: AppearanceReferenceProfile) => void
  onGenerate: (
    colorFile?: File,
    options?: {
      referenceMode?: RouteAReferenceMode
      referenceCompositeFile?: File
      referenceCleanupMaskFile?: File
    },
  ) => void | Promise<void>
  onConfirm: (blendFile?: File) => void | Promise<void>
  onDiscard: () => void
  onClose: () => void
}

type PreparedImage = {
  url: string
  image: HTMLImageElement
  data: ImageData
  profile: AppearanceReferenceProfile
}

type AppearancePreviewAssetKind =
  | 'source'
  | 'reference'
  | 'color'
  | 'preserve-scene'
  | 'replace-background'

type AppearancePreviewSelection = {
  kind: AppearancePreviewAssetKind
  historyId?: string
}

type AppearanceViewerMode = 'compare' | 'single'

const APPEARANCE_PREVIEW_ASSET_OPTIONS: Array<{
  value: AppearancePreviewAssetKind
  label: string
}> = [
  { value: 'source', label: '原图' },
  { value: 'reference', label: '参考图' },
  { value: 'color', label: '色彩迁移' },
  { value: 'preserve-scene', label: '保持场景迁移氛围' },
  { value: 'replace-background', label: '替换场景融入氛围' },
]

function historyModeForAsset(
  kind: AppearancePreviewAssetKind,
): AppearanceHistoryResult['mode'] | null {
  if (kind === 'preserve-scene') return 'preserve-scene'
  if (kind === 'replace-background') return 'replace-background'
  return null
}

const MAX_PREVIEW_EDGE = 512
const NATIVE_PREVIEW_ZOOM_THRESHOLD = 1

// A cross-origin asset needs crossOrigin='anonymous' for canvas pixel access.
// Same-origin project assets ( /assets/… , relative, blob:, data: ) do NOT — and
// forcing crossOrigin there makes the browser issue a *separate* CORS request that
// can't reuse the on-screen <img> cache, so the full 2K/4K original is downloaded
// twice. Only set it when the URL is genuinely cross-origin.
function isCrossOriginAsset(url: string): boolean {
  if (typeof window === 'undefined') return false
  if (/^(?:blob:|data:)/i.test(url)) return false
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return false
  try {
    return new URL(url, window.location.href).origin !== window.location.origin
  } catch {
    return false
  }
}

async function prepareImageRaw(url: string): Promise<PreparedImage> {
  const image = new Image()
  if (isCrossOriginAsset(url)) image.crossOrigin = 'anonymous'
  image.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('图片无法读取，请确认素材仍在项目中。'))
    image.src = url
  })
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法创建实时预览画布。')
  context.drawImage(image, 0, 0, width, height)
  const data = context.getImageData(0, 0, width, height)
  return { url, image, data, profile: analyzeAppearanceImage(data) }
}

// Cache prepared previews per URL so reopening the editor (or re-running the color
// preview) is instant instead of re-downloading + re-decoding + re-analyzing the
// same image. Bounded to avoid unbounded memory growth across many assets.
const preparedImageCache = new Map<string, Promise<PreparedImage>>()
const PREPARED_IMAGE_CACHE_LIMIT = 8

function prepareImage(url: string): Promise<PreparedImage> {
  const cached = preparedImageCache.get(url)
  if (cached) return cached
  const pending = prepareImageRaw(url).catch((error) => {
    preparedImageCache.delete(url)
    throw error
  })
  preparedImageCache.set(url, pending)
  if (preparedImageCache.size > PREPARED_IMAGE_CACHE_LIMIT) {
    const oldest = preparedImageCache.keys().next().value
    if (oldest !== undefined) preparedImageCache.delete(oldest)
  }
  return pending
}

async function prepareControl(url: string, width: number, height: number) {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('控制图读取失败'))
    image.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('控制图画布不可用')
  context.drawImage(image, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
}

function canvasToPngFile(canvas: HTMLCanvasElement, name: string) {
  return new Promise<File>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The browser could not encode the full-resolution color result.'))
        return
      }
      resolve(new File([blob], name, { type: 'image/png' }))
    }, 'image/png')
  })
}

async function renderFullResolutionColorFile(
  source: PreparedImage,
  reference: PreparedImage,
  state: AppearanceTransferState,
  resolution: AppearanceTransferState['resolution'] = state.resolution,
) {
  const plan = createAppearanceResolutionPlan(
    {
      imageWidth: source.image.naturalWidth,
      imageHeight: source.image.naturalHeight,
    },
    resolution,
  )
  const canvas = document.createElement('canvas')
  canvas.width = plan.targetWidth
  canvas.height = plan.targetHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('The browser could not create the full-resolution color renderer.')
  context.drawImage(source.image, 0, 0, plan.targetWidth, plan.targetHeight)
  const sourceData = context.getImageData(0, 0, plan.targetWidth, plan.targetHeight)
  const subjectUrl = state.analysis.subjectAlphaUrl ?? state.analysis.subjectMaskUrl
  const subjectMask = subjectUrl
    ? await prepareControl(subjectUrl, plan.targetWidth, plan.targetHeight).catch(() => null)
    : null
  const output = renderAppearancePreview(
    sourceData,
    source.profile,
    reference.profile,
    { ...state, previewMode: 'color' },
    { subjectMask },
  )
  context.putImageData(output, 0, 0)
  return canvasToPngFile(canvas, `appearance-color-${plan.targetWidth}x${plan.targetHeight}.png`)
}

async function renderReferenceBackgroundCompositeFile(
  source: PreparedImage,
  reference: PreparedImage,
  state: AppearanceTransferState,
) {
  const width = source.image.naturalWidth
  const height = source.image.naturalHeight
  const subjectUrl = state.analysis.subjectAlphaUrl ?? state.analysis.subjectMaskUrl
  if (!subjectUrl) {
    throw new Error('直接使用参考图背景需要先完成基础主体抠像。')
  }
  const subjectMask = await prepareControl(subjectUrl, width, height)
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = width
  sourceCanvas.height = height
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
  if (!sourceContext) throw new Error('浏览器无法创建主体像素合成画布。')
  sourceContext.drawImage(source.image, 0, 0, width, height)
  let foreground = sourceContext.getImageData(0, 0, width, height)
  if (state.colorEnabled) {
    foreground = renderAppearancePreview(
      foreground,
      source.profile,
      reference.profile,
      { ...state, previewMode: 'color' },
      { subjectMask },
    )
  }
  for (let offset = 0; offset < foreground.data.length; offset += 4) {
    const maskAlpha = subjectMask.data[offset + 3] / 255
    const maskLuminance = (
      subjectMask.data[offset] +
      subjectMask.data[offset + 1] +
      subjectMask.data[offset + 2]
    ) / (3 * 255)
    foreground.data[offset + 3] = Math.round(
      foreground.data[offset + 3] * maskAlpha * maskLuminance,
    )
  }
  sourceContext.clearRect(0, 0, width, height)
  sourceContext.putImageData(foreground, 0, 0)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建参考图背景合成画布。')
  const crop = computeReferenceCoverCrop(
    reference.image.naturalWidth,
    reference.image.naturalHeight,
    width,
    height,
  )
  context.drawImage(
    reference.image,
    crop.sourceX,
    crop.sourceY,
    crop.sourceWidth,
    crop.sourceHeight,
    0,
    0,
    width,
    height,
  )
  context.drawImage(sourceCanvas, 0, 0, width, height)
  return canvasToPngFile(
    canvas,
    `appearance-reference-background-${width}x${height}.png`,
  )
}

async function renderBlendedResultFile(
  source: PreparedImage,
  resultUrl: string,
  amount: number,
) {
  const result = new Image()
  result.crossOrigin = 'anonymous'
  result.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    result.onload = () => resolve()
    result.onerror = () => reject(new Error('模型结果无法读取，不能创建混合输出。'))
    result.src = resultUrl
  })
  const width = source.image.naturalWidth
  const height = source.image.naturalHeight
  if (result.naturalWidth !== width || result.naturalHeight !== height) {
    throw new Error(
      `模型结果尺寸 ${result.naturalWidth}×${result.naturalHeight} 与原图 ${width}×${height} 不一致，已阻止输出。`,
    )
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建结果混合画布。')
  context.drawImage(source.image, 0, 0, width, height)
  context.globalAlpha = clampAppearancePercent(amount) / 100
  context.drawImage(result, 0, 0, width, height)
  context.globalAlpha = 1
  return canvasToPngFile(
    canvas,
    `appearance-blend-${clampAppearancePercent(amount)}-${width}x${height}.png`,
  )
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="appearance-transfer__slider">
      <span>{label}</span>
      <input
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={(event) => onChange(clampAppearancePercent(Number(event.target.value)))}
      />
      <output>{value}</output>
    </label>
  )
}

function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={`appearance-transfer__toggle${disabled ? ' is-disabled' : ''}`}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  )
}

function PaletteStrip({
  label,
  profile,
}: {
  label: string
  profile: AppearanceReferenceProfile | null | undefined
}) {
  return (
    <div className="appearance-transfer__palette-row">
      <header>
        <span>{label}</span>
        <small>{profile ? `${profile.palette.length} 色` : '分析中'}</small>
      </header>
      <div className="appearance-transfer__palette" aria-label={label}>
        {(profile?.palette ?? []).map((color) => (
          <span
            key={color.hex}
            title={`${color.hex} · ${Math.round(color.weight * 100)}%`}
            style={{
              backgroundColor: color.hex,
              flexGrow: Math.max(1, color.weight * 10),
            }}
          />
        ))}
        {!profile ? <em>正在识别色彩…</em> : null}
      </div>
    </div>
  )
}

function PreviewSourcePicker({
  label,
  selection,
  historyResults,
  onChange,
  compact = false,
}: {
  label: string
  selection: AppearancePreviewSelection
  historyResults: AppearanceHistoryResult[]
  onChange: (selection: AppearancePreviewSelection) => void
  compact?: boolean
}) {
  const historyMode = historyModeForAsset(selection.kind)
  const modeHistory = historyMode
    ? historyResults.filter((result) => result.mode === historyMode)
    : []
  const selectedHistoryId =
    modeHistory.some((result) => result.id === selection.historyId)
      ? selection.historyId
      : modeHistory[0]?.id

  return (
    <div className={[
      'appearance-transfer__preview-picker',
      compact ? 'is-compact' : '',
    ].filter(Boolean).join(' ')}>
      <label>
        <span>{label}</span>
        <select
          aria-label={`${label}内容`}
          value={selection.kind}
          onChange={(event) => {
            const kind = event.target.value as AppearancePreviewAssetKind
            const nextMode = historyModeForAsset(kind)
            onChange({
              kind,
              historyId: nextMode
                ? historyResults.find((result) => result.mode === nextMode)?.id
                : undefined,
            })
          }}
        >
          {APPEARANCE_PREVIEW_ASSET_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {historyMode ? (
        <label className="appearance-transfer__history-picker">
          <span>{appearanceHistoryModeLabel(historyMode)}历史</span>
          <select
            aria-label={`${label}历史结果`}
            value={selectedHistoryId ?? ''}
            disabled={!modeHistory.length}
            onChange={(event) => onChange({
              ...selection,
              historyId: event.target.value,
            })}
          >
            {!modeHistory.length ? <option value="">暂无历史生成图</option> : null}
            {modeHistory.map((result, index) => (
              <option key={result.id} value={result.id}>
                {appearanceHistoryResultLabel(result, index)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  )
}

export function AppearanceTransferEditor({
  sourceUrl,
  referenceUrl,
  sourceTitle = '原图',
  referenceTitle = '参考图',
  state,
  historyResults = [],
  backends = DEFAULT_APPEARANCE_BACKENDS,
  open = true,
  generating = false,
  generationError = null,
  onChange,
  onReferenceProfile,
  onGenerate,
  onConfirm,
  onDiscard,
  onClose,
}: AppearanceTransferEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const leftColorCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rightColorCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const singleColorCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const previewViewportRef = useRef<HTMLDivElement | null>(null)
  const previewPanRef = useRef<{
    startPointerX: number
    startPointerY: number
    startScrollLeft: number
    startScrollTop: number
  } | null>(null)
  const initialGenerationSelection: AppearancePreviewSelection | null =
    state.generation.previewUrl
      ? {
          kind:
            state.generation.provenance?.lightingMode
            ?? state.lightingMode,
          historyId: state.generation.candidateNodeId,
        }
      : null
  const [source, setSource] = useState<PreparedImage | null>(null)
  const [reference, setReference] = useState<PreparedImage | null>(null)
  const [previewError, setPreviewError] = useState<{ url: string; message: string } | null>(null)
  const [compare, setCompare] = useState(50)
  const [viewerMode, setViewerMode] = useState<AppearanceViewerMode>('compare')
  const [leftSelection, setLeftSelection] = useState<AppearancePreviewSelection>({
    kind: 'source',
  })
  const [rightSelection, setRightSelection] = useState<AppearancePreviewSelection>(
    initialGenerationSelection ?? { kind: 'color' },
  )
  const [singleSelection, setSingleSelection] = useState<AppearancePreviewSelection>(
    initialGenerationSelection ?? { kind: 'source' },
  )
  const [controls, setControls] = useState<AppearancePreviewControls>({})
  const [preparingColor, setPreparingColor] = useState(false)
  const [confirmingBlend, setConfirmingBlend] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [referenceMode, setReferenceMode] = useState<RouteAReferenceMode>('descriptor-only')
  const [experimentConfirmationOpen, setExperimentConfirmationOpen] = useState(false)
  const [experimentSubmitting, setExperimentSubmitting] = useState(false)
  const [previewPanning, setPreviewPanning] = useState(false)
  const [previewViewportSize, setPreviewViewportSize] = useState({ width: 0, height: 0 })
  const [previewZoomState, setPreviewZoomState] = useState({
    sourceUrl,
    value: 1,
  })
  const previewZoom =
    previewZoomState.sourceUrl === sourceUrl ? previewZoomState.value : 1
  const preparedSource = source?.url === sourceUrl ? source : null
  const preparedReference = referenceUrl && reference?.url === referenceUrl ? reference : null
  const activePreviewError =
    previewError && (
      previewError.url === sourceUrl ||
      previewError.url === referenceUrl
    )
      ? previewError.message
      : null

  useEffect(() => {
    let cancelled = false
    prepareImage(sourceUrl)
      .then((prepared) => {
        if (!cancelled) {
          setSource(prepared)
          setPreviewError((current) => current?.url === sourceUrl ? null : current)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreviewError({ url: sourceUrl, message: error instanceof Error ? error.message : '原图读取失败。' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [sourceUrl])

  useEffect(() => {
    let cancelled = false
    if (!referenceUrl) return () => {
      cancelled = true
    }
    prepareImage(referenceUrl)
      .then((prepared) => {
        if (!cancelled) {
          setReference(prepared)
          setPreviewError((current) => current?.url === referenceUrl ? null : current)
          onReferenceProfile?.(prepared.profile)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreviewError({ url: referenceUrl, message: error instanceof Error ? error.message : '参考图读取失败。' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [onReferenceProfile, referenceUrl])

  useEffect(() => {
    if (!preparedSource) return
    let cancelled = false
    const entries = [
      ['subjectMask', state.analysis.subjectAlphaUrl ?? state.analysis.subjectMaskUrl],
    ] as const
    void Promise.all(entries.map(async ([key, url]) => {
      if (!url) return [key, null] as const
      try {
        return [key, await prepareControl(url, preparedSource.data.width, preparedSource.data.height)] as const
      } catch {
        return [key, null] as const
      }
    })).then((values) => {
      if (!cancelled) setControls(Object.fromEntries(values))
    })
    return () => {
      cancelled = true
    }
  }, [
    preparedSource,
    state.analysis.subjectAlphaUrl,
    state.analysis.subjectMaskUrl,
  ])

  const paintColorPreview = useCallback((output: ImageData) => {
    const canvases = [
      canvasRef.current,
      leftColorCanvasRef.current,
      rightColorCanvasRef.current,
      singleColorCanvasRef.current,
    ]
    for (const canvas of canvases) {
      if (!canvas) continue
      canvas.width = output.width
      canvas.height = output.height
      canvas.getContext('2d')?.putImageData(output, 0, 0)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !preparedSource || !preparedReference) return
    const previewState = {
      ...state,
      previewMode: state.colorEnabled ? 'color' as const : 'source' as const,
    }
    const output = renderAppearancePreview(
      preparedSource.data,
      preparedSource.profile,
      preparedReference.profile,
      previewState,
      controls,
    )
    paintColorPreview(output)
  }, [
    controls,
    leftSelection.kind,
    paintColorPreview,
    preparedReference,
    preparedSource,
    rightSelection.kind,
    singleSelection.kind,
    state,
    viewerMode,
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    if (
      !canvas ||
      !preparedSource ||
      !preparedReference ||
      previewZoom <= NATIVE_PREVIEW_ZOOM_THRESHOLD
    ) {
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        const width = preparedSource.image.naturalWidth
        const height = preparedSource.image.naturalHeight
        const renderCanvas = document.createElement('canvas')
        renderCanvas.width = width
        renderCanvas.height = height
        const renderContext = renderCanvas.getContext('2d', { willReadFrequently: true })
        if (!renderContext) return
        renderContext.drawImage(preparedSource.image, 0, 0, width, height)
        const sourceData = renderContext.getImageData(0, 0, width, height)
        const subjectUrl = state.analysis.subjectAlphaUrl ?? state.analysis.subjectMaskUrl
        const subjectMask = subjectUrl
          ? await prepareControl(subjectUrl, width, height).catch(() => null)
          : null
        if (cancelled) return
        const output = renderAppearancePreview(
          sourceData,
          preparedSource.profile,
          preparedReference.profile,
          {
            ...state,
            previewMode: state.colorEnabled ? 'color' as const : 'source' as const,
          },
          { subjectMask },
        )
        if (cancelled || canvasRef.current !== canvas) return
        paintColorPreview(output)
      })()
    }, 140)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    leftSelection.kind,
    paintColorPreview,
    preparedReference,
    preparedSource,
    previewZoom,
    rightSelection.kind,
    singleSelection.kind,
    state,
    viewerMode,
  ])

  useLayoutEffect(() => {
    const viewport = previewViewportRef.current
    if (!viewport) return

    const measure = () => {
      const rect = viewport.getBoundingClientRect()
      setPreviewViewportSize({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
      })
    }
    measure()

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(viewport)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open])

  useEffect(() => {
    const viewport = previewViewportRef.current
    if (viewport) {
      viewport.scrollLeft = 0
      viewport.scrollTop = 0
    }
  }, [sourceUrl])

  const selectedBackend = useMemo(
    () => backends.find((backend) => backend.id === state.backendId) ?? backends[0],
    [backends, state.backendId],
  )
  const backendAvailable = selectedBackend?.status === 'available'
  const selectedBackendIsLocal = state.backendId
    ? getAppearanceBackendDefinition(state.backendId).local
    : false
  const lightingRebuilding = state.lighting.availability === 'rebuilding'
  const lightingGenerationEnabled = state.lightingEnabled && !lightingRebuilding
  const routeADescriptorReady =
    state.analysis.descriptorStatus === 'ready' &&
    Boolean(state.analysis.descriptor && state.analysis.descriptorHash)
  const routeABackendReady =
    isRouteASupportedBackend(state.backendId) && backendAvailable
  const hasGeneratedPreview =
    (state.generation.status === 'ready' || state.generation.status === 'stale') &&
    Boolean(state.generation.previewUrl)
  const previewHistoryResults = useMemo(() => {
    if (!hasGeneratedPreview || !state.generation.previewUrl) return historyResults
    const currentId = state.generation.candidateNodeId ?? 'current-generation'
    if (historyResults.some((result) => result.id === currentId)) return historyResults
    return [{
      id: currentId,
      url: state.generation.previewUrl,
      mode: state.generation.provenance?.lightingMode ?? state.lightingMode,
      createdAt: null,
      backendLabel:
        state.generation.provenance?.backgroundTransferMethod === 'reference-pixels'
          ? state.generation.provenance?.referencePersonAction === 'remove'
            ? appearanceBackendLabel(
                state.generation.provenance?.backendId ?? state.backendId,
              )
            : '本地像素合成'
          : appearanceBackendLabel(
              state.generation.provenance?.backendId ?? state.backendId,
            ),
      confirmed: false,
      width: preparedSource?.image.naturalWidth ?? null,
      height: preparedSource?.image.naturalHeight ?? null,
      referenceAttached:
        state.generation.provenance?.referenceAttached === true,
      backgroundTransferMethod:
        state.generation.provenance?.backgroundTransferMethod ??
        state.backgroundTransferMethod,
      referencePersonAction:
        state.generation.provenance?.referencePersonAction ??
        state.referencePersonAction,
    }, ...historyResults]
  }, [
    hasGeneratedPreview,
    historyResults,
    preparedSource?.image.naturalHeight,
    preparedSource?.image.naturalWidth,
    state.backendId,
    state.backgroundTransferMethod,
    state.referencePersonAction,
    state.generation.candidateNodeId,
    state.generation.previewUrl,
    state.generation.provenance,
    state.lightingMode,
  ])
  const selectableHistoryResults = useMemo(() => {
    const seen = new Set(previewHistoryResults.map((result) => result.id))
    const localResults: AppearanceHistoryResult[] = []
    const addCandidate = (
      generation: AppearanceTransferState['generation'],
      fallbackId: string,
    ) => {
      if (
        (generation.status !== 'ready' && generation.status !== 'stale') ||
        !generation.previewUrl
      ) {
        return
      }
      const lightingEnabled =
        generation.provenance?.lightingEnabled ?? state.lightingEnabled
      if (!lightingEnabled) return
      const id = generation.candidateNodeId ?? fallbackId
      if (seen.has(id)) return
      seen.add(id)
      localResults.push({
        id,
        url: generation.previewUrl,
        mode: generation.provenance?.lightingMode ?? state.lightingMode,
        createdAt: null,
        backendLabel:
          generation.provenance?.backgroundTransferMethod === 'reference-pixels'
            ? generation.provenance?.referencePersonAction === 'remove'
              ? appearanceBackendLabel(
                  generation.provenance?.backendId ?? state.backendId,
                )
              : '鏈湴鍍忕礌鍚堟垚'
            : appearanceBackendLabel(
                generation.provenance?.backendId ?? state.backendId,
              ),
        confirmed: false,
        width: preparedSource?.image.naturalWidth ?? null,
        height: preparedSource?.image.naturalHeight ?? null,
        referenceAttached:
          generation.provenance?.referenceAttached === true,
        backgroundTransferMethod:
          generation.provenance?.backgroundTransferMethod ??
          state.backgroundTransferMethod,
        referencePersonAction:
          generation.provenance?.referencePersonAction ??
          state.referencePersonAction,
      })
    }
    addCandidate(state.candidates.lighting, 'current-lighting-generation')
    addCandidate(state.candidates.combined, 'current-combined-generation')
    return [...localResults, ...previewHistoryResults]
  }, [
    preparedSource?.image.naturalHeight,
    preparedSource?.image.naturalWidth,
    previewHistoryResults,
    state.backendId,
    state.backgroundTransferMethod,
    state.candidates.combined,
    state.candidates.lighting,
    state.lightingEnabled,
    state.lightingMode,
    state.referencePersonAction,
  ])
  const historyResultForSelection = useCallback((
    selection: AppearancePreviewSelection,
  ) => {
    const mode = historyModeForAsset(selection.kind)
    if (!mode) return null
    const modeHistory = selectableHistoryResults.filter((result) => result.mode === mode)
    return (
      modeHistory.find((result) => result.id === selection.historyId)
      ?? modeHistory[0]
      ?? null
    )
  }, [selectableHistoryResults])
  const assetUrlForSelection = useCallback((
    selection: AppearancePreviewSelection,
  ) => {
    if (selection.kind === 'source') return sourceUrl
    if (selection.kind === 'reference') return referenceUrl ?? null
    if (selection.kind === 'color') return null
    return historyResultForSelection(selection)?.url ?? null
  }, [historyResultForSelection, referenceUrl, sourceUrl])
  const legacyGeneratedPreview =
    hasGeneratedPreview &&
    state.generation.legacyStatus === 'legacy-experimental'
  const generatingResult =
    preparingColor ||
    generating ||
    state.generation.status === 'queued' ||
    state.generation.status === 'running'
  const generationPhaseLabel =
    state.generation.phase === 'cleaning-background'
      ? '第 1/2 步：正在清除参考图人物并重建空背景…'
      : state.generation.phase === 'fusing-subject'
        ? '第 2/2 步：正在将原图人物与空背景进行模型融合…'
        : state.generation.phase === 'checking-quality'
      ? '正在检查构图、肤色与灯光…'
      : state.generation.phase === 'finalizing'
        ? '正在执行所选最终修复…'
        : state.lightingMode === 'replace-background'
          ? state.backgroundTransferMethod === 'reference-pixels'
            ? state.referencePersonAction === 'remove'
              ? '正在清理参考图主要前景主体并自动融合…'
              : state.referencePersonAction === 'replace-pose'
                ? '正在替换参考人物并继承 Pose…'
                : '正在合成参考图背景…'
            : '正在生成普通换景并匹配环境灯光…'
          : '正在提取参考灯光并重布光…'
  const generationStatusLabel = {
    idle: '尚未生成',
    queued: '等待执行',
    running: '生成中',
    ready: '结果已返回',
    failed: '生成失败',
    stale: '参数已变化，结果待更新',
  }[state.generation.status]
  const activeGenerationError = generationError || state.generation.error
  const diagnosticsNeedsAttention = Boolean(
    activeGenerationError ||
    selectedBackend?.reason ||
    state.analysis.analyzerError ||
    state.generation.qualityGate === 'failed' ||
    state.generation.qualityBlockingReasons?.length ||
    state.generation.qualityWarnings?.length,
  )
  const allowedLightColors = state.analysis.descriptor
    ? allowedRouteALightColors(state.analysis.descriptor)
    : []
  const qualityRejected =
    state.generation.status === 'ready' &&
    state.generation.phase === 'rejected' &&
    state.generation.qualityGate === 'failed'
  const usingReferencePixels =
    lightingGenerationEnabled &&
    state.lightingMode === 'replace-background' &&
    state.backgroundTransferMethod === 'reference-pixels'
  const directCompositeReady = Boolean(
    state.analysis.subjectAlphaUrl ?? state.analysis.subjectMaskUrl,
  )
  const referenceCleanupReady = Boolean(
    directCompositeReady &&
    state.analysis.referenceSubjectMaskUrl &&
    routeABackendReady,
  )
  const referencePoseReady = Boolean(
    state.analysis.referenceSubjectMaskUrl &&
    routeABackendReady,
  )
  const generationDisabled =
    generatingResult ||
    (
      lightingGenerationEnabled &&
      (
        usingReferencePixels
          ? state.referencePersonAction === 'remove'
            ? !referenceCleanupReady
            : state.referencePersonAction === 'replace-pose'
              ? !referencePoseReady
              : false // keep: the basic subject mask is fetched on demand at generate time
          : !routeABackendReady || (state.lightingMode !== 'replace-background' && !routeADescriptorReady)
      )
    ) ||
    !preparedSource ||
    !preparedReference ||
    (!state.colorEnabled && !lightingGenerationEnabled)
  const previewStageSize = useMemo(
    () => preparedSource
      ? computeContainedPreviewSize(
          preparedSource.data.width,
          preparedSource.data.height,
          previewViewportSize.width,
          previewViewportSize.height,
        )
      : null,
    [preparedSource, previewViewportSize.height, previewViewportSize.width],
  )
  const exactOutputSize = preparedSource
    ? `${preparedSource.image.naturalWidth}×${preparedSource.image.naturalHeight}`
    : '—'
  const previewZoomSpace = previewStageSize
    ? computePreviewZoomSpace(
        previewStageSize.width,
        previewStageSize.height,
        previewViewportSize.width,
        previewViewportSize.height,
        previewZoom,
      )
    : null
  const previewStageStyle = previewZoomSpace
    ? ({
        '--appearance-preview-width': `${previewZoomSpace.stageWidth}px`,
        '--appearance-preview-height': `${previewZoomSpace.stageHeight}px`,
      } as CSSProperties)
    : undefined
  const previewSpaceStyle = previewZoomSpace
    ? ({
        width: `${previewZoomSpace.spaceWidth}px`,
        height: `${previewZoomSpace.spaceHeight}px`,
      } as CSSProperties)
    : undefined
  const updatePreviewZoom = useCallback((
    requestedZoom: number,
    pointer?: { x: number; y: number },
  ) => {
    const nextZoom = clampPreviewZoom(requestedZoom)
    if (nextZoom === previewZoom) return
    const viewport = previewViewportRef.current
    const base = previewStageSize
    if (!viewport || !base) {
      setPreviewZoomState({ sourceUrl, value: nextZoom })
      return
    }
    const rect = viewport.getBoundingClientRect()
    const point = pointer ?? {
      x: Math.max(0, viewport.clientWidth / 2),
      y: Math.max(0, viewport.clientHeight / 2),
    }
    const nextScroll = computePreviewZoomScroll({
      baseWidth: base.width,
      baseHeight: base.height,
      viewportWidth: viewport.clientWidth || rect.width,
      viewportHeight: viewport.clientHeight || rect.height,
      oldZoom: previewZoom,
      newZoom: nextZoom,
      pointerX: point.x,
      pointerY: point.y,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    })
    setPreviewZoomState({ sourceUrl, value: nextZoom })
    window.requestAnimationFrame(() => {
      viewport.scrollLeft = nextScroll.left
      viewport.scrollTop = nextScroll.top
    })
  }, [previewStageSize, previewZoom, sourceUrl])
  const handlePreviewWheel = useCallback((event: WheelEvent) => {
    event.preventDefault()
    const viewport = previewViewportRef.current
    const rect = viewport?.getBoundingClientRect()
    updatePreviewZoom(
      nextPreviewZoom(previewZoom, event.deltaY),
      rect
        ? {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          }
        : undefined,
    )
  }, [previewZoom, updatePreviewZoom])

  useEffect(() => {
    const viewport = previewViewportRef.current
    if (!open || !viewport) return
    viewport.addEventListener('wheel', handlePreviewWheel, { passive: false })
    return () => {
      viewport.removeEventListener('wheel', handlePreviewWheel)
    }
  }, [handlePreviewWheel, open])
  const handlePreviewPointerDown = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 1 || previewZoom <= 1) return
    const viewport = previewViewportRef.current
    if (!viewport) return
    event.preventDefault()
    event.stopPropagation()
    previewPanRef.current = {
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startScrollLeft: viewport.scrollLeft,
      startScrollTop: viewport.scrollTop,
    }
    setPreviewPanning(true)
  }, [previewZoom])

  useEffect(() => {
    if (!previewPanning) return
    const move = (event: PointerEvent) => {
      const start = previewPanRef.current
      const viewport = previewViewportRef.current
      if (!start || !viewport) return
      event.preventDefault()
      const next = computePreviewPanScroll({
        ...start,
        pointerX: event.clientX,
        pointerY: event.clientY,
        maxScrollLeft: viewport.scrollWidth - viewport.clientWidth,
        maxScrollTop: viewport.scrollHeight - viewport.clientHeight,
      })
      viewport.scrollLeft = next.left
      viewport.scrollTop = next.top
    }
    const end = () => {
      previewPanRef.current = null
      setPreviewPanning(false)
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [previewPanning])
  const patch = <Key extends keyof AppearanceTransferState>(key: Key, value: AppearanceTransferState[Key]) =>
    onChange({ ...state, [key]: value })
  const patchColorControl = <
    Key extends 'colorStrength' | 'luminanceMatch' | 'temperature' | 'saturation' | 'preserveSkin',
  >(
    key: Key,
    value: AppearanceTransferState[Key],
  ) => {
    const colorSelection = { kind: 'color' as const }
    setRightSelection(colorSelection)
    setSingleSelection(colorSelection)
    onChange({
      ...state,
      [key]: value,
      previewMode: 'color',
    })
  }
  const performGeneration = async (
    selectedReferenceMode: RouteAReferenceMode,
  ) => {
    if (!preparedSource || !preparedReference) return
    const generatedSelection: AppearancePreviewSelection = lightingGenerationEnabled
      ? { kind: state.lightingMode }
      : { kind: 'color' }
    setRightSelection(generatedSelection)
    setSingleSelection(generatedSelection)
    if (usingReferencePixels) {
      setPreparingColor(true)
      try {
        if (state.referencePersonAction === 'remove') {
          const referenceSubjectMaskUrl = state.analysis.referenceSubjectMaskUrl
          if (!referenceSubjectMaskUrl) {
            throw new Error('参考图主要前景主体蒙版尚未准备完成。')
          }
          const referenceCleanupMaskFile = await renderReferenceCleanupMaskFile(
            referenceSubjectMaskUrl,
            preparedReference.image.naturalWidth,
            preparedReference.image.naturalHeight,
          )
          const colorFile = state.colorEnabled
            ? await renderFullResolutionColorFile(
                preparedSource,
                preparedReference,
                state,
                'original',
              )
            : undefined
          await onGenerate(colorFile, {
            referenceMode: 'background-attached',
            referenceCleanupMaskFile,
          })
          return
        }
        if (state.referencePersonAction === 'replace-pose') {
          const referenceSubjectMaskUrl = state.analysis.referenceSubjectMaskUrl
          if (!referenceSubjectMaskUrl) {
            throw new Error('参考图主要前景主体蒙版尚未准备完成。')
          }
          const referenceCleanupMaskFile = await renderReferenceCleanupMaskFile(
            referenceSubjectMaskUrl,
            preparedReference.image.naturalWidth,
            preparedReference.image.naturalHeight,
          )
          await onGenerate(undefined, {
            referenceMode: 'background-attached',
            referenceCleanupMaskFile,
          })
          return
        }
        // keep · 原样保留: the hook fetches the subject mask on demand (SAM2) and
        // composites the source subject over the reference background, so no
        // editor-side precomputed file (which would require a state mask) is needed.
        await onGenerate(undefined, {
          referenceMode: 'background-attached',
        })
      } catch (error: unknown) {
        setPreviewError({
          url: sourceUrl,
          message: error instanceof Error ? error.message : '参考图背景像素合成失败。',
        })
      } finally {
        setPreparingColor(false)
      }
      return
    }
    // Replace-background (AI semantic 换景) must attach the reference RGB as the
    // target background; only preserve-scene uses the descriptor-only/attached modes.
    const effectiveReferenceMode: RouteAReferenceMode =
      state.lightingMode === 'replace-background' ? 'background-attached' : selectedReferenceMode
    if (!state.colorEnabled) {
      await onGenerate(undefined, { referenceMode: effectiveReferenceMode })
      return
    }
    setPreparingColor(true)
    try {
      const file = await renderFullResolutionColorFile(preparedSource, preparedReference, state)
      await onGenerate(file, { referenceMode: effectiveReferenceMode })
    } catch (error: unknown) {
      setPreviewError({
        url: sourceUrl,
        message: error instanceof Error ? error.message : 'Failed to create the full-resolution color result.',
      })
    } finally {
      setPreparingColor(false)
    }
  }
  const submitGeneration = async () => {
    if (referenceMode === 'experimental-attached' && lightingGenerationEnabled) {
      setExperimentConfirmationOpen(true)
      return
    }
    await performGeneration('descriptor-only')
  }
  const cancelExperimentalGeneration = () => {
    if (experimentSubmitting) return
    setExperimentConfirmationOpen(false)
    setReferenceMode('descriptor-only')
  }
  const confirmExperimentalGeneration = async () => {
    if (experimentSubmitting) return
    setExperimentSubmitting(true)
    try {
      await performGeneration('experimental-attached')
      setExperimentConfirmationOpen(false)
      setReferenceMode('descriptor-only')
    } finally {
      setExperimentSubmitting(false)
    }
  }
  const submitConfirm = async () => {
    if (confirmingBlend) return
    if (state.blend.amount >= 100) {
      await onConfirm()
      return
    }
    if (!preparedSource || !state.generation.previewUrl) {
      setPreviewError({
        url: sourceUrl,
        message: '原图或模型结果尚未准备完成，不能创建混合输出。',
      })
      return
    }
    setConfirmingBlend(true)
    try {
      const file = await renderBlendedResultFile(
        preparedSource,
        state.generation.previewUrl,
        state.blend.amount,
      )
      await onConfirm(file)
    } catch (error: unknown) {
      setPreviewError({
        url: sourceUrl,
        message: error instanceof Error ? error.message : '创建混合输出失败。',
      })
    } finally {
      setConfirmingBlend(false)
    }
  }

  const renderPreviewAsset = (
    selection: AppearancePreviewSelection,
    colorCanvasRef: RefObject<HTMLCanvasElement | null>,
    label: string,
  ) => {
    if (selection.kind === 'color') {
      return (
        <canvas
          ref={colorCanvasRef}
          className="appearance-transfer__preview-asset"
          aria-label={`${label}：色彩迁移`}
        />
      )
    }
    const result = historyResultForSelection(selection)
    const url = assetUrlForSelection(selection)
    if (!url) {
      return (
        <div className="appearance-transfer__preview-empty">
          {historyModeForAsset(selection.kind)
            ? '该模式还没有可用的历史生成图'
            : '图片尚未准备完成'}
        </div>
      )
    }
    const currentCandidateId =
      state.generation.candidateNodeId
      ?? (hasGeneratedPreview ? 'current-generation' : null)
    const blendCurrentResult = Boolean(
      result
      && result.id === currentCandidateId
      && state.blend.amount < 100,
    )
    if (blendCurrentResult) {
      return (
        <div className="appearance-transfer__preview-asset-stack">
          <img src={sourceUrl} alt="" draggable={false} />
          <img
            className="appearance-transfer__generated-preview"
            src={url}
            alt={label}
            draggable={false}
            style={{ opacity: state.blend.amount / 100 }}
          />
        </div>
      )
    }
    return (
      <img
        className={[
          'appearance-transfer__preview-asset',
          result ? 'appearance-transfer__generated-preview' : '',
        ].filter(Boolean).join(' ')}
        src={url}
        alt={label}
        draggable={false}
      />
    )
  }

  if (!open) return null

  return (
    <div className="appearance-transfer nodrag nopan" role="dialog" aria-label="色彩与灯光氛围迁移">
      <header className="appearance-transfer__header">
        <div>
          <strong>色彩与灯光氛围迁移</strong>
          <span><i /> 本地近似预览</span>
        </div>
        <button type="button" aria-label="关闭" onClick={onClose}>×</button>
      </header>

      <div className="appearance-transfer__body">
        <aside className="appearance-transfer__references">
          <figure>
            <figcaption>原图 <small>{sourceTitle}</small></figcaption>
            <img src={sourceUrl} alt="原图" draggable={false} />
          </figure>
          <figure>
            <figcaption>参考图 <small>{referenceTitle}</small></figcaption>
            {referenceUrl ? (
              <img src={referenceUrl} alt="参考图" draggable={false} />
            ) : (
              <div className="appearance-transfer__reference-empty">请从左侧第二个端口连接参考图片</div>
            )}
          </figure>
          <section className="appearance-transfer__palette-comparison">
            <h3>色卡对照</h3>
            <div className="appearance-transfer__palette-pair">
              <PaletteStrip label="原图色卡" profile={preparedSource?.profile} />
              <PaletteStrip label="参考色卡" profile={preparedReference?.profile} />
            </div>
            <small>原图色彩基线 → 参考图迁移目标</small>
          </section>
          <section>
            <h3>灯光分析</h3>
            {state.analysis.descriptor ? (
              <div className="appearance-transfer__chips" data-testid="lighting-descriptor">
                <span>主光 {state.analysis.descriptor.keyLight.directionClass}</span>
                <span>
                  色温 {state.analysis.descriptor.color.estimatedCctK}K ·{' '}
                  {state.analysis.descriptor.color.tint}
                </span>
                <span>
                  {state.analysis.descriptor.exposure.style} · 置信度{' '}
                  {Math.round(state.analysis.descriptor.confidence * 100)}%
                </span>
              </div>
            ) : null}
            <div
              className="appearance-transfer__chips"
              hidden={Boolean(state.analysis.descriptor)}
            >
              <span>{(preparedReference?.profile.stats.warmBias ?? 0) >= 0 ? '暖色主光' : '冷色主光'}</span>
              <span>{(preparedReference?.profile.stats.contrast ?? 0) > 0.2 ? '高反差' : '柔和光比'}</span>
              <span>{preparedReference ? '本地粗分析已完成' : '等待参考图'}</span>
            </div>
            <small
              className="appearance-transfer__analysis-status"
              data-status={state.analysis.descriptorStatus ?? 'idle'}
            >
              {state.analysis.descriptorStatus === 'ready'
                ? state.lightingMode === 'replace-background'
                  ? state.backgroundTransferMethod === 'reference-pixels'
                    ? state.referencePersonAction === 'remove'
                      ? '参考图分析已完成；第 1 次模型调用清理主要前景主体，第 2 次模型调用自动融合原图主体与空背景。'
                      : '参考图分析已完成；直接背景模式只使用参考图像素和原图主体蒙版，不调用生图模型。'
                    : '结构化光说明书已生成；AI 换景会把参考图作为目标背景与环境灯光证据。'
                  : '结构化光说明书已生成；参考图内容不会进入后续保场景生成。'
                : state.analysis.descriptorStatus === 'queued'
                  || state.analysis.descriptorStatus === 'running'
                  ? '参考分析器正在读取光向、光比、色温与空气感；关闭窗口不会取消后台任务。'
                  : state.analysis.descriptorStatus === 'failed'
                    ? `参考分析失败${state.analysis.analyzerError ? `：${state.analysis.analyzerError}` : ''}`
                    : '等待参考分析器生成结构化光说明书。'}
            </small>
            {state.lightingMode === 'replace-background' ? (
              <small className="appearance-transfer__analysis-status" data-status={state.analysis.status}>
                {state.backgroundTransferMethod === 'reference-pixels'
                  ? state.referencePersonAction === 'remove'
                    ? state.analysis.referenceSubjectMaskUrl &&
                      (state.analysis.subjectAlphaUrl || state.analysis.subjectMaskUrl)
                      ? '原图主体与参考图主要前景主体蒙版均已就绪；最终合成保持原图尺寸。'
                      : '正在准备原图主体与参考图主要前景主体蒙版；当前不会假装具备发丝级精度。'
                    : state.analysis.subjectAlphaUrl || state.analysis.subjectMaskUrl
                      ? '基础主体蒙版已就绪；合成将保持原图尺寸。'
                      : '正在准备基础主体蒙版；该模式不会假装具备发丝级精度。'
                  : 'AI 生成换景不依赖当前主体 Alpha；已有主体分析仅供风险提示，不作为生成前置条件。'}
              </small>
            ) : null}
          </section>
        </aside>

        <main className="appearance-transfer__preview">
          <div className="appearance-transfer__preview-toolbar" aria-label="预览内容选择">
            <PreviewSourcePicker
              label="左图"
              selection={leftSelection}
              historyResults={selectableHistoryResults}
              onChange={setLeftSelection}
            />
            <div className="appearance-transfer__view-mode">
              <span>查看方式</span>
              <div className="appearance-transfer__segmented" role="group" aria-label="查看方式">
                <button
                  type="button"
                  className={viewerMode === 'compare' ? 'is-active' : ''}
                  onClick={() => setViewerMode('compare')}
                >
                  左右对比
                </button>
                <button
                  type="button"
                  className={viewerMode === 'single' ? 'is-active' : ''}
                  onClick={() => setViewerMode('single')}
                >
                  完整查看
                </button>
              </div>
              {viewerMode === 'single' ? (
                <PreviewSourcePicker
                  label="查看图片"
                  selection={singleSelection}
                  historyResults={selectableHistoryResults}
                  onChange={setSingleSelection}
                  compact
                />
              ) : (
                <small>左右图均可独立选择</small>
              )}
            </div>
            <PreviewSourcePicker
              label="右图"
              selection={rightSelection}
              historyResults={selectableHistoryResults}
              onChange={setRightSelection}
            />
          </div>
          <div className="appearance-transfer__canvas-shell">
            <div className="appearance-transfer__zoom-controls" aria-label="预览缩放">
              <button
                type="button"
                aria-label="缩小预览"
                disabled={previewZoom <= PREVIEW_ZOOM_MIN}
                onClick={() => updatePreviewZoom(previewZoom - PREVIEW_ZOOM_STEP)}
              >
                −
              </button>
              <button
                type="button"
                className="appearance-transfer__zoom-value"
                aria-label="恢复适合视窗"
                title="恢复适合视窗"
                onClick={() => updatePreviewZoom(1)}
              >
                {Math.round(previewZoom * 100)}%
              </button>
              <button
                type="button"
                aria-label="放大预览"
                disabled={previewZoom >= PREVIEW_ZOOM_MAX}
                onClick={() => updatePreviewZoom(previewZoom + PREVIEW_ZOOM_STEP)}
              >
                +
              </button>
            </div>
            <div
              className={[
                'appearance-transfer__canvas-wrap',
                previewZoom > 1 ? 'is-pannable' : '',
                previewPanning ? 'is-panning' : '',
              ].filter(Boolean).join(' ')}
              ref={previewViewportRef}
              onPointerDown={handlePreviewPointerDown}
              onAuxClick={(event) => {
                if (event.button === 1) event.preventDefault()
              }}
            >
              <div className="appearance-transfer__preview-space" style={previewSpaceStyle}>
                <div className="appearance-transfer__preview-stage" style={previewStageStyle}>
                  <canvas
                    ref={canvasRef}
                    className="appearance-transfer__color-buffer"
                    aria-label="实时效果预览"
                  />
                  {viewerMode === 'compare' ? (
                    <>
                      <div className="appearance-transfer__preview-base">
                        {renderPreviewAsset(rightSelection, rightColorCanvasRef, '右图')}
                      </div>
                      <div
                        className="appearance-transfer__compare"
                        style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}
                      >
                        {renderPreviewAsset(leftSelection, leftColorCanvasRef, '左图')}
                      </div>
                      <div
                        className="appearance-transfer__compare-divider"
                        style={{ left: `${compare}%` }}
                        aria-hidden="true"
                      >
                        <span>‹</span>
                        <span>›</span>
                      </div>
                      <input
                        className="appearance-transfer__compare-range"
                        type="range"
                        min="0"
                        max="100"
                        value={compare}
                        aria-label="拖动查看左右图片"
                        onChange={(event) => setCompare(Number(event.target.value))}
                      />
                    </>
                  ) : (
                    <div className="appearance-transfer__preview-single">
                      {renderPreviewAsset(singleSelection, singleColorCanvasRef, '完整查看')}
                    </div>
                  )}
                  {!preparedSource || !preparedReference ? <div className="appearance-transfer__loading">正在建立实时预览…</div> : null}
                  {generatingResult ? (
                    <div className="appearance-transfer__loading">
                      {generationPhaseLabel}
                    </div>
                  ) : null}
                  {activePreviewError ? <div className="appearance-transfer__error">{activePreviewError}</div> : null}
                </div>
              </div>
            </div>
          </div>
          <p>
            {viewerMode === 'compare'
              ? '左右图可独立选择；拖动分割线对比，滚轮缩放，中键拖拽平移。'
              : '完整查看不显示分割线；可选择任意输入、色彩结果或历史氛围结果。'}
          </p>
        </main>

        <aside className="appearance-transfer__controls">
          <section>
            <h3>处理器</h3>
            <Toggle
              label="色彩迁移"
              checked={state.colorEnabled}
              onChange={(value) => onChange({
                ...state,
                colorEnabled: value,
                previewMode: value ? 'color' : state.lightingEnabled ? 'generated' : 'source',
              })}
            />
            <Toggle
              label="灯光氛围迁移"
              checked={state.lightingEnabled}
              disabled={lightingRebuilding}
              onChange={(value) => onChange({
                ...state,
                lightingEnabled: value,
                previewMode: value ? state.previewMode : state.colorEnabled ? 'color' : 'source',
              })}
            />
            <small className="appearance-transfer__capability-note">
              {lightingRebuilding
                ? '灯光氛围迁移正在按路线 A 重建，当前暂不可生成。色彩迁移仍可正常预览和输出。'
                : routeADescriptorReady
                  ? state.lightingMode === 'replace-background'
                    ? state.backgroundTransferMethod === 'reference-pixels'
                      ? state.referencePersonAction === 'remove'
                        ? referenceCleanupReady
                          ? '原图主体蒙版、参考图清理蒙版与两段式云端编辑模型均已就绪。'
                          : '正在准备基础主体蒙版、参考图清理蒙版或云端编辑模型。'
                        : directCompositeReady
                          ? '基础主体 Alpha 已就绪；可以直接合成参考图背景，不调用生图模型。'
                          : '正在准备基础主体 Alpha；完成后即可直接合成参考图背景。'
                      : 'AI 生成换景已就绪；生成阶段会按顺序发送原图主体与目标背景参考图。'
                    : '路线 A 光说明书已就绪；生成阶段不会把参考图发送给图片模型。'
                  : '正在把参考图转换为光说明书；完成后即可生成。'}
            </small>
          </section>
          <section>
            <h3>色彩实时预览</h3>
            <fieldset disabled={!state.colorEnabled}>
              <Slider label="色彩强度" value={state.colorStrength} onChange={(value) => patchColorControl('colorStrength', value)} />
              <Slider label="明暗匹配" value={state.luminanceMatch} onChange={(value) => patchColorControl('luminanceMatch', value)} />
              <Slider label="冷暖迁移" value={state.temperature} onChange={(value) => patchColorControl('temperature', value)} />
              <Slider label="饱和度" value={state.saturation} onChange={(value) => patchColorControl('saturation', value)} />
              <Toggle label="保护肤色" checked={state.preserveSkin} onChange={(value) => patchColorControl('preserveSkin', value)} />
            </fieldset>
          </section>
          <section>
            <h3>灯光氛围模式</h3>
            <div className="appearance-transfer__segmented">
              <button
                type="button"
                disabled={lightingRebuilding || !state.lightingEnabled}
                className={state.lightingMode === 'preserve-scene' ? 'is-active' : ''}
                onClick={() => patch('lightingMode', 'preserve-scene')}
              >
                保留原场景重布光
              </button>
              <button
                type="button"
                disabled={lightingRebuilding || !state.lightingEnabled}
                className={state.lightingMode === 'replace-background' ? 'is-active' : ''}
                onClick={() => patch('lightingMode', 'replace-background')}
              >
                替换背景并融入
              </button>
            </div>
            <small className="appearance-transfer__capability-note">
              {lightingRebuilding
                ? '灯光氛围迁移正在按路线 A 重建，当前暂不可生成。'
                : state.lightingMode === 'replace-background'
                  ? state.backgroundTransferMethod === 'reference-pixels'
                    ? state.referencePersonAction === 'remove'
                      ? '一次点击顺序执行两次图片模型：先清除参考图主要人物并重建空背景，再以原图人物身份与细节为约束完成人景融合；只有第二次结果允许输出。主体蒙版仍是基础精度，发丝级精确换景后续更新。'
                      : '直接像素合成保留参考图背景，不调用生图模型；主体边缘使用当前基础抠像，发丝级精确换景后续更新。'
                    : 'AI 换景由所选图片模型直接生成完整画面，不依赖当前主体 Alpha；人物身份、位置与发丝可能发生轻微变化。精确换景（发丝级抠像）后续更新。'
                  : '参考图只用于提取结构化光说明书；生成阶段仅使用原图或确定性色彩底图。AI 换景由所选图片模型直接生成；精确换景（发丝级抠像）后续更新。'}
            </small>
          </section>
          {lightingGenerationEnabled && state.lightingMode === 'replace-background' ? (
            <section>
              <h3>背景使用方式</h3>
              <div className="appearance-transfer__segmented">
                <button
                  type="button"
                  className={state.backgroundTransferMethod === 'semantic-generate' ? 'is-active' : ''}
                  onClick={() => patch('backgroundTransferMethod', 'semantic-generate')}
                >
                  AI 生成换景
                </button>
                <button
                  type="button"
                  className={state.backgroundTransferMethod === 'reference-pixels' ? 'is-active' : ''}
                  onClick={() => patch('backgroundTransferMethod', 'reference-pixels')}
                >
                  直接使用参考图背景
                </button>
              </div>
              <small
                className="appearance-transfer__capability-note"
                data-tone={state.backgroundTransferMethod === 'reference-pixels' ? 'warning' : 'normal'}
              >
                {state.backgroundTransferMethod === 'reference-pixels'
                  ? '「原样保留」为客户端直接合成，不调用生图模型：把原图人物按基础抠像贴到参考图的原始背景上，输出严格保持原图尺寸。「清除主要前景主体」「替换并继承 Pose」为实验换景，会调用所选图片模型。基础抠像的发丝与边缘偏粗，最适合无人物遮挡的干净背景参考图。'
                  : '一次点击只提交原始人物图与原始参考环境图，执行一次图片模型调用并返回一个候选结果；不会使用上一次生成结果继续生成。'}
              </small>
            </section>
          ) : null}
          {usingReferencePixels ? (
            <section>
              <h3>背景人物处理</h3>
              <div className="appearance-transfer__segmented">
                <button
                  type="button"
                  className={state.referencePersonAction === 'keep' ? 'is-active' : ''}
                  onClick={() => patch('referencePersonAction', 'keep')}
                >
                  原样保留
                </button>
                <button
                  type="button"
                  className={state.referencePersonAction === 'remove' ? 'is-active' : ''}
                  onClick={() => patch('referencePersonAction', 'remove')}
                >
                  清除主要前景主体
                </button>
                <button
                  type="button"
                  className={state.referencePersonAction === 'replace-pose' ? 'is-active' : ''}
                  onClick={() => patch('referencePersonAction', 'replace-pose')}
                >
                  替换并继承 Pose
                </button>
              </div>
              <small
                className="appearance-transfer__capability-note"
                data-tone={state.referencePersonAction === 'keep' ? 'normal' : 'warning'}
              >
                {state.referencePersonAction === 'remove'
                  ? referenceCleanupReady
                    ? '原图与参考图基础主体蒙版均已就绪。点击生成会先用所选模型清理参考图人物并重建空背景，再把原图人物按基础抠像合成到空背景上（严格保持原图尺寸）。属于实验换景，基础抠像不是发丝级精确抠像。'
                    : '正在准备参考图主要前景主体蒙版，或所选云端图片编辑模型尚不可用。基础蒙版可能清理显著前景物体，复杂多人背景仍需检查。'
                  : state.referencePersonAction === 'replace-pose'
                    ? referencePoseReady
                      ? '普通生成式人物替换已就绪：继承参考人物 Pose 与场景光照，原图 Pose 不参与；不是像素级身份复制或发丝级抠像，结果需检查脸、手、服装和遮挡。'
                      : '普通生成式人物替换正在准备参考主体蒙版，或 Nano Banana Pro / Image 2.0 尚不可用；不是像素级身份复制或发丝级抠像，且不会提交两次模型任务。'
                    : '参考图中的人物和物体会原样保留，不调用图片编辑模型。适合本身就是无人纯背景的参考图。'}
              </small>
              {state.referencePersonAction === 'replace-pose' ? (
                <>
                  <h3>人物继承方式</h3>
                  <div className="appearance-transfer__segmented">
                    <button
                      type="button"
                      className={state.poseReplacementMode === 'identity-only' ? 'is-active' : ''}
                      onClick={() => patch('poseReplacementMode', 'identity-only')}
                    >
                      仅继承身份与脸发
                    </button>
                    <button
                      type="button"
                      className={state.poseReplacementMode === 'full-appearance' ? 'is-active' : ''}
                      onClick={() => patch('poseReplacementMode', 'full-appearance')}
                    >
                      身份与服装外观
                    </button>
                  </div>
                </>
              ) : null}
            </section>
          ) : null}
          {lightingGenerationEnabled && state.lightingMode === 'preserve-scene' ? (
            <section>
              <h3>参考图使用方式</h3>
              <div className="appearance-transfer__segmented appearance-transfer__reference-mode">
                <button
                  type="button"
                  className={referenceMode === 'descriptor-only' ? 'is-active' : ''}
                  onClick={() => setReferenceMode('descriptor-only')}
                >
                  标准 · 仅光说明书
                </button>
                <button
                  type="button"
                  className={referenceMode === 'experimental-attached' ? 'is-active' : ''}
                  onClick={() => setReferenceMode('experimental-attached')}
                >
                  实验 · 附加参考图
                </button>
              </div>
              <small
                className="appearance-transfer__capability-note"
                data-tone={referenceMode === 'experimental-attached' ? 'warning' : 'normal'}
              >
                {referenceMode === 'experimental-attached'
                  ? '仅对下一次生成生效；点击生成后还需二次确认。可能增强复杂氛围，也可能复制参考图内容。'
                  : '默认安全路径：生图模型只收到生成底图与结构化光说明书，不会收到参考图像素。'}
              </small>
            </section>
          ) : null}
          <section>
            <h3>素材清理</h3>
            <Toggle
              label="移除水印、Logo 与平面叠字"
              checked={state.removeGraphicOverlays}
              disabled={!lightingGenerationEnabled || usingReferencePixels}
              onChange={(value) => patch('removeGraphicOverlays', value)}
            />
            <small className="appearance-transfer__capability-note">
              {usingReferencePixels
                ? '直接使用参考图背景时不会调用模型，素材清理不执行；参考图内的文字和物体会原样保留。'
                : '只清理后期叠加的水印、角标、字幕和界面文字；真实场景内的书籍、招牌与包装文字会保留。清理与重布光在同一轮原图编辑中完成，不会二次生成。'}
            </small>
          </section>
          {hasGeneratedPreview ? (
            <section>
              <h3>结果混合</h3>
              <Slider
                label="结果强度"
                value={state.blend.amount}
                onChange={(amount) => patch('blend', { amount })}
              />
              <small className="appearance-transfer__capability-note">
                本地确定性混合，不会再次调用模型；100% 保留完整生成结果。
              </small>
            </section>
          ) : null}
        </aside>
      </div>

      {diagnosticsOpen ? (
        <aside
          className="appearance-transfer__diagnostics"
          role="dialog"
          aria-label="运行信息"
          aria-modal="false"
        >
          <header>
            <div>
              <strong>运行信息</strong>
              <span data-attention={diagnosticsNeedsAttention ? 'true' : 'false'}>
                {diagnosticsNeedsAttention ? '需要检查' : '链路正常'}
              </span>
            </div>
            <button
              type="button"
              aria-label="关闭运行信息"
              onClick={() => setDiagnosticsOpen(false)}
            >
              ×
            </button>
          </header>
          <dl>
            <div>
              <dt>任务状态</dt>
              <dd>{generationStatusLabel}</dd>
            </div>
            <div>
              <dt>当前阶段</dt>
              <dd>{generatingResult ? generationPhaseLabel : state.generation.phase ?? 'idle'}</dd>
            </div>
            <div>
              <dt>最终处理器</dt>
              <dd>{selectedBackend?.label ?? state.backendId ?? '未选择'}</dd>
            </div>
            <div>
              <dt>生成输入</dt>
              <dd>不可变原图{state.colorEnabled ? '生成的确定性色彩底图' : ''} · 每次深度 1</dd>
            </div>
            <div>
              <dt>参考图传给生图模型</dt>
              <dd>
                {
                  state.generation.provenance?.referenceAttached === true ||
                  (
                    state.generation.status === 'idle' &&
                    referenceMode === 'experimental-attached'
                  )
                    ? '是，实验灯光证据图（内容泄漏风险）'
                    : '否，只传结构化光说明书'
                }
              </dd>
            </div>
            <div>
              <dt>提示词合同</dt>
              <dd>
                Route A v{
                  state.generation.provenance?.referenceAttached === true ||
                  (
                    state.generation.status === 'idle' &&
                    referenceMode === 'experimental-attached'
                  )
                    ? ROUTE_A_EXPERIMENTAL_PROMPT_SCHEMA_VERSION
                    : ROUTE_A_PROMPT_SCHEMA_VERSION
                }
              </dd>
            </div>
            <div>
              <dt>允许光色</dt>
              <dd>{allowedLightColors.join('、') || '等待参考光分析'}</dd>
            </div>
            <div>
              <dt>素材清理</dt>
              <dd>{state.removeGraphicOverlays ? '同轮清理平面水印与叠字' : '关闭'}</dd>
            </div>
            <div>
              <dt>质量门</dt>
              <dd>
                {state.generation.qualityGate ?? '尚未检查'}
                {state.generation.qualityPolicyVersion
                  ? ` · ${state.generation.qualityPolicyVersion}`
                  : ''}
              </dd>
            </div>
          </dl>
          {selectedBackend?.reason ? (
            <section>
              <h4>处理器说明</h4>
              <p>{selectedBackend.reason}</p>
            </section>
          ) : null}
          {state.analysis.analyzerError ? (
            <section>
              <h4>参考分析错误</h4>
              <p>{state.analysis.analyzerError}</p>
            </section>
          ) : null}
          {state.generation.qualityBlockingReasons?.length ? (
            <section>
              <h4>质量风险提示</h4>
              <ul>
                {state.generation.qualityBlockingReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {state.generation.qualityWarnings?.length ? (
            <section>
              <h4>质量提醒</h4>
              <ul>
                {state.generation.qualityWarnings.map((warning) => (
                  <li key={warning}>{appearanceQualityWarningLabel(warning)}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {activeGenerationError ? (
            <section className="appearance-transfer__diagnostics-error" role="alert">
              <h4>完整错误信息</h4>
              <p>{activeGenerationError}</p>
            </section>
          ) : null}
        </aside>
      ) : null}

      <footer className="appearance-transfer__footer">
        <span>结果先返回本节点对比；确认后再显示为新图片节点并保留连线</span>
        <span className="appearance-transfer__exact-output-size">
          最终尺寸：跟随原图 {exactOutputSize}
        </span>
        <label>
          {usingReferencePixels && state.referencePersonAction !== 'keep'
            ? state.referencePersonAction === 'remove'
              ? '清背景与融合模型'
              : '人物替换模型'
            : '最终处理'}
          <select
            value={state.backendId ?? ''}
            disabled={
              lightingRebuilding ||
              (usingReferencePixels && state.referencePersonAction === 'keep')
            }
            onChange={(event) => {
              const backendId = event.target.value as AppearanceFinalizerBackendId
              onChange({
                ...state,
                backendId,
                backendSelectionError: undefined,
                resolution: (
                  backendId === 'flux-2-klein-4b-fp8'
                ) && state.resolution === '4K'
                  ? '2K'
                  : state.resolution,
              })
            }}
          >
            {!state.backendId ? <option value="">无有效最终处理器</option> : null}
            {(['云端 API', '本地模型'] as const).map((group) => (
              <optgroup key={group} label={group}>
                {backends.filter((backend) => backend.group === group).map((backend) => (
                  <option
                    key={backend.id}
                    value={backend.id}
                    disabled={
                      backend.status !== 'available' ||
                      (lightingGenerationEnabled && !isRouteASupportedBackend(backend.id))
                    }
                  >
                    {backend.label}
                    {backend.nonCommercial ? '（非商用）' : ''}
                    {backend.status === 'checking' ? ' · 检测中' : ''}
                    {backend.status === 'unavailable' || backend.status === 'planned' ? ' · 未就绪' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          生成尺寸
          <select
            value={usingReferencePixels ? 'original' : state.resolution}
            disabled={usingReferencePixels}
            onChange={(event) => patch('resolution', event.target.value as AppearanceTransferState['resolution'])}
          >
            <option value="original">原图尺寸</option>
            <option value="1K">1K</option>
            <option value="2K">2K</option>
            <option value="4K" disabled={selectedBackendIsLocal}>4K</option>
          </select>
        </label>
        <button
          type="button"
          className="appearance-transfer__diagnostics-button"
          aria-label="运行信息"
          aria-expanded={diagnosticsOpen}
          onClick={() => setDiagnosticsOpen((current) => !current)}
        >
          <i data-attention={diagnosticsNeedsAttention ? 'true' : 'false'} />
          运行信息
        </button>
        {qualityRejected ? (
          <>
            <small className="appearance-transfer__quality-advisory">
              质量门发现风险，结果已保留
            </small>
            <button
              type="button"
              className="appearance-transfer__secondary"
              disabled={generationDisabled}
              onClick={() => void submitGeneration()}
            >
              重新生成
            </button>
            <button
              type="button"
              className="appearance-transfer__generate"
              disabled={confirmingBlend}
              onClick={() => void submitConfirm()}
            >
              {confirmingBlend ? '正在保存混合结果…' : '仍然输出'}
            </button>
          </>
        ) : state.generation.status === 'ready' && state.generation.confirmable !== false ? (
          <>
            <button type="button" className="appearance-transfer__secondary" onClick={onDiscard}>丢弃结果</button>
            <button
              type="button"
              className="appearance-transfer__generate"
              disabled={confirmingBlend}
              onClick={() => void submitConfirm()}
            >
              {confirmingBlend ? '正在保存混合结果…' : '确认输出'}
            </button>
          </>
        ) : legacyGeneratedPreview ? (
          <>
            <small className="appearance-transfer__capability-note">
              历史实验结果仅供查看，不能确认输出。
            </small>
            <button
              type="button"
              className="appearance-transfer__secondary"
              onClick={onDiscard}
            >
              关闭历史结果
            </button>
            <button
              type="button"
              className="appearance-transfer__generate"
              disabled={generationDisabled}
              onClick={() => void submitGeneration()}
            >
              {state.lightingMode === 'replace-background'
                ? usingReferencePixels
                  ? state.referencePersonAction === 'remove'
                    ? '重新清理并融合'
                    : state.referencePersonAction === 'replace-pose'
                      ? '重新替换并继承 Pose'
                      : '重新合成参考图背景'
                  : '生成新 AI 换景预览'
                : '生成新灯光预览'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="appearance-transfer__generate"
            disabled={generationDisabled}
            onClick={() => void submitGeneration()}
          >
            {preparingColor
              ? '正在准备持久化输入…'
              : generatingResult
                ? generationPhaseLabel
                : lightingGenerationEnabled
                ? state.lightingMode === 'replace-background'
                    ? usingReferencePixels
                      ? state.referencePersonAction === 'remove'
                        ? '清除主体并融合'
                        : state.referencePersonAction === 'replace-pose'
                          ? '替换人物并继承 Pose'
                          : '合成参考图背景预览'
                      : '生成 AI 换景预览'
                    : referenceMode === 'experimental-attached'
                    ? '生成实验灯光预览'
                    : '生成灯光预览'
                  : '生成色彩结果'}
          </button>
        )}
      </footer>
      <AppearanceReferenceExperimentDialog
        open={experimentConfirmationOpen}
        submitting={experimentSubmitting}
        onCancel={cancelExperimentalGeneration}
        onConfirm={() => void confirmExperimentalGeneration()}
      />
    </div>
  )
}
