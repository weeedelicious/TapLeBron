import {
  Brush,
  Check,
  Eraser,
  Eye,
  EyeOff,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  SquareDashed,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { inferMultiCameraGridRatio } from '@/lib/multiCameraGrid'
import { normalizeImageRatioValue, normalizeImageResolutionValue } from '@/lib/imageRules'

type RepaintTool = 'brush' | 'rectangle' | 'eraser'
type PaintMode = 'paint' | 'erase'

interface RepaintPoint {
  x: number
  y: number
}

type RepaintCommand =
  | {
      kind: 'stroke'
      mode: PaintMode
      size: number
      points: RepaintPoint[]
    }
  | {
      kind: 'rectangle'
      mode: PaintMode
      x: number
      y: number
      width: number
      height: number
    }

export interface ImageRepaintAcceptPayload {
  file: File
  prompt: string
  model: string
  ratio: string
  resolution: string
  width: number
  height: number
  maskCoverage: number
  commandCount: number
  brushSize: number
}

interface ImageRepaintModalProps {
  sourceFile?: File | null
  sourceName?: string
  initialModel?: string
  busy?: boolean
  loadingSource?: boolean
  error?: string | null
  onCancel: () => void
  onAccept: (payload: ImageRepaintAcceptPayload) => void | Promise<void>
}

const REPAINT_MODELS = [
  { value: 'gemini-3-pro-image', label: 'Nano-banana Pro' },
  { value: 'gemini-3.1-flash-image', label: 'Nano-banana Flash' },
  { value: 'gpt-image-2', label: 'GPT image 2.0' },
  { value: 'seedream-5-pro', label: 'Seedream 5 Pro' },
]

// 局部重绘是硬遮罩（hard-mask-v0.0.1）：每个像素只能"选中"或"未选中"，
// 不允许 0~1 的中间值。所以遮罩一律用不透明颜色画到独立图层上（重叠不会越涂越深），
// 再把整层 alpha 二值化掉画布 2D 无法关闭的抗锯齿，最后整层按统一透明度贴到预览上。
const MASK_COLOR = '#8b70ff'
const MASK_PREVIEW_ALPHA = 0.62
const MASK_ALPHA_THRESHOLD = 128

function drawStroke(
  context: CanvasRenderingContext2D,
  command: Extract<RepaintCommand, { kind: 'stroke' }>,
  color: string,
) {
  const points = command.points
  if (!points.length) return
  context.save()
  context.globalCompositeOperation = command.mode === 'erase' ? 'destination-out' : 'source-over'
  context.strokeStyle = color
  context.fillStyle = color
  context.lineWidth = command.size
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (points.length === 1) {
    context.beginPath()
    context.arc(points[0].x, points[0].y, command.size / 2, 0, Math.PI * 2)
    context.fill()
  } else {
    context.beginPath()
    context.moveTo(points[0].x, points[0].y)
    for (const point of points.slice(1)) context.lineTo(point.x, point.y)
    context.stroke()
  }
  context.restore()
}

function drawRectangle(
  context: CanvasRenderingContext2D,
  command: Extract<RepaintCommand, { kind: 'rectangle' }>,
  color: string,
) {
  context.save()
  context.globalCompositeOperation = command.mode === 'erase' ? 'destination-out' : 'source-over'
  context.fillStyle = color
  // 取整，避免小数坐标让矩形边缘也被抗锯齿成半透明
  context.fillRect(
    Math.round(command.x),
    Math.round(command.y),
    Math.round(command.width),
    Math.round(command.height),
  )
  context.restore()
}

function drawCommand(context: CanvasRenderingContext2D, command: RepaintCommand, color: string) {
  if (command.kind === 'stroke') drawStroke(context, command, color)
  else drawRectangle(context, command, color)
}

/** 把一块区域的 alpha 压成 0 或 255，消掉抗锯齿留下的过渡带。 */
function binarizeAlpha(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  if (width <= 0 || height <= 0) return
  const image = context.getImageData(x, y, width, height)
  const pixels = image.data
  for (let index = 3; index < pixels.length; index += 4) {
    pixels[index] = pixels[index] >= MASK_ALPHA_THRESHOLD ? 255 : 0
  }
  context.putImageData(image, x, y)
}

/** 单条命令影响到的像素范围，用于只对改动区域做二值化。 */
function commandBounds(command: RepaintCommand, width: number, height: number) {
  let left: number
  let top: number
  let right: number
  let bottom: number
  if (command.kind === 'stroke') {
    if (!command.points.length) return null
    const radius = command.size / 2 + 2
    left = top = Number.POSITIVE_INFINITY
    right = bottom = Number.NEGATIVE_INFINITY
    for (const point of command.points) {
      left = Math.min(left, point.x - radius)
      top = Math.min(top, point.y - radius)
      right = Math.max(right, point.x + radius)
      bottom = Math.max(bottom, point.y + radius)
    }
  } else {
    left = Math.min(command.x, command.x + command.width) - 2
    top = Math.min(command.y, command.y + command.height) - 2
    right = Math.max(command.x, command.x + command.width) + 2
    bottom = Math.max(command.y, command.y + command.height) + 2
  }
  const x = Math.max(0, Math.floor(left))
  const y = Math.max(0, Math.floor(top))
  return {
    x,
    y,
    width: Math.min(width, Math.ceil(right)) - x,
    height: Math.min(height, Math.ceil(bottom)) - y,
  }
}

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}

/** 把命令渲染成一层不透明的二值遮罩。 */
function renderMaskLayer(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  commands: RepaintCommand[],
  color: string = MASK_COLOR,
) {
  sizeCanvas(canvas, width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.clearRect(0, 0, width, height)
  for (const command of commands) drawCommand(context, command, color)
  if (commands.length) binarizeAlpha(context, 0, 0, width, height)
  return context
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('遮罩导出失败，请重试'))
    }, 'image/png')
  })
}

async function buildProviderMask(
  commands: RepaintCommand[],
  width: number,
  height: number,
  sourceName: string,
) {
  const authorCanvas = document.createElement('canvas')
  const authorContext = renderMaskLayer(authorCanvas, width, height, commands, '#ffffff')
  if (!authorContext) throw new Error('浏览器无法创建遮罩')
  // renderMaskLayer 已把 alpha 二值化，这里只会数到 0 或 255
  const pixels = authorContext.getImageData(0, 0, width, height).data
  let selectedPixels = 0
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] === 255) selectedPixels += 1
  }
  if (!selectedPixels) throw new Error('请先涂抹需要局部重绘的区域')

  const providerCanvas = document.createElement('canvas')
  providerCanvas.width = width
  providerCanvas.height = height
  const providerContext = providerCanvas.getContext('2d', { willReadFrequently: true })
  if (!providerContext) throw new Error('浏览器无法创建供应商遮罩')
  providerContext.imageSmoothingEnabled = false
  providerContext.fillStyle = '#ffffff'
  providerContext.fillRect(0, 0, width, height)
  providerContext.globalCompositeOperation = 'destination-out'
  providerContext.drawImage(authorCanvas, 0, 0)
  providerContext.globalCompositeOperation = 'source-over'
  // 兜底：交付给模型和服务端合成的遮罩必须严格是 0/255，不能有过渡
  binarizeAlpha(providerContext, 0, 0, width, height)

  const blob = await canvasToBlob(providerCanvas)
  const baseName = String(sourceName || 'image').replace(/\.[a-z0-9]+$/i, '')
  return {
    file: new File([blob], `${baseName}_局部重绘遮罩.png`, { type: 'image/png' }),
    coverage: selectedPixels / Math.max(1, width * height),
  }
}

function sourcePointFromEvent(
  event: ReactPointerEvent<HTMLCanvasElement>,
  width: number,
  height: number,
) {
  const rect = event.currentTarget.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(width, ((event.clientX - rect.left) / Math.max(1, rect.width)) * width)),
    y: Math.max(0, Math.min(height, ((event.clientY - rect.top) / Math.max(1, rect.height)) * height)),
  }
}

function resolutionForSize(width: number, height: number) {
  const longest = Math.max(width, height)
  if (longest >= 3000) return '4K'
  if (longest >= 1800) return '2K'
  return '1K'
}

function toolButtonStyle(active: boolean) {
  return {
    height: 34,
    minWidth: 34,
    padding: '0 10px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 7,
    border: active ? '1px solid rgba(190, 174, 255, 0.52)' : '1px solid rgba(255,255,255,0.1)',
    background: active ? 'rgba(124, 92, 252, 0.22)' : 'rgba(255,255,255,0.035)',
    color: active ? '#ffffff' : '#bdb5d5',
    cursor: 'pointer',
    fontSize: 12,
  } as const
}

// 缩放范围。zoom 是"适应窗口"之上的倍数：zoom=1 就是刚好铺满视口，
// 放大到 8 倍是为了能框很小的细节（比如发丝、文字边缘）。
const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const ZOOM_STEP = 1.25
const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))

export function ImageRepaintModal({
  sourceFile,
  sourceName = 'image',
  initialModel,
  busy = false,
  loadingSource = false,
  error,
  onCancel,
  onAccept,
}: ImageRepaintModalProps) {
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const drawingRef = useRef(false)
  const draftRef = useRef<RepaintCommand | null>(null)
  // 已提交命令的二值遮罩层，只在命令变化时重建；草稿单独叠在副本上，避免每帧重算全图
  const committedLayerRef = useRef<HTMLCanvasElement | null>(null)
  const frameLayerRef = useRef<HTMLCanvasElement | null>(null)
  const rectangleStartRef = useRef<RepaintPoint | null>(null)
  // 缩放后要把"光标下的那一点"重新挪回光标位置，否则放大就跑偏、没法对着细节框。
  // 记的是画布内的相对位置（0~1）加上当时的视口客户端坐标，等尺寸变完再补滚动。
  const zoomAnchorRef = useRef<{ ratioX: number; ratioY: number; clientX: number; clientY: number } | null>(null)
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number } | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const [sourceUrl, setSourceUrl] = useState('')
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [viewportSize, setViewportSize] = useState({ width: 900, height: 640 })
  const [commands, setCommands] = useState<RepaintCommand[]>([])
  const [redoCommands, setRedoCommands] = useState<RepaintCommand[]>([])
  const [tool, setTool] = useState<RepaintTool>('brush')
  const [brushSize, setBrushSize] = useState(72)
  const [zoom, setZoom] = useState(1)
  const [maskVisible, setMaskVisible] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(
    REPAINT_MODELS.some((item) => item.value === initialModel) ? String(initialModel) : 'gemini-3-pro-image',
  )
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!sourceFile) {
      setSourceUrl('')
      setDimensions({ width: 0, height: 0 })
      setCommands([])
      setRedoCommands([])
      draftRef.current = null
      return
    }
    const url = URL.createObjectURL(sourceFile)
    setSourceUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [sourceFile])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => {
      const rect = element.getBoundingClientRect()
      setViewportSize({
        width: Math.max(320, rect.width),
        height: Math.max(280, rect.height),
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const paintOverlay = useCallback((draft: RepaintCommand | null) => {
    const canvas = overlayCanvasRef.current
    const committed = committedLayerRef.current
    const { width, height } = dimensions
    if (!canvas || !committed || !width || !height) return
    sizeCanvas(canvas, width, height)
    const context = canvas.getContext('2d')
    if (!context) return

    let layer: HTMLCanvasElement = committed
    if (draft) {
      if (!frameLayerRef.current) frameLayerRef.current = document.createElement('canvas')
      const frame = frameLayerRef.current
      sizeCanvas(frame, width, height)
      const frameContext = frame.getContext('2d', { willReadFrequently: true })
      if (frameContext) {
        frameContext.imageSmoothingEnabled = false
        frameContext.clearRect(0, 0, width, height)
        frameContext.drawImage(committed, 0, 0)
        drawCommand(frameContext, draft, MASK_COLOR)
        // 只二值化这一笔覆盖到的范围，长笔画也不会掉帧
        const bounds = commandBounds(draft, width, height)
        if (bounds) binarizeAlpha(frameContext, bounds.x, bounds.y, bounds.width, bounds.height)
        layer = frame
      }
    }

    context.clearRect(0, 0, width, height)
    context.save()
    context.imageSmoothingEnabled = false
    // 整层一次性上色：重叠区域不会叠加透明度，所以不会出现"越涂越深"的压感
    context.globalAlpha = MASK_PREVIEW_ALPHA
    context.drawImage(layer, 0, 0)
    context.restore()
  }, [dimensions])

  useEffect(() => {
    const { width, height } = dimensions
    if (!width || !height) return
    if (!committedLayerRef.current) committedLayerRef.current = document.createElement('canvas')
    renderMaskLayer(committedLayerRef.current, width, height, commands)
    paintOverlay(draftRef.current)
  }, [commands, dimensions, paintOverlay])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTextInput = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT'
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (isTextInput) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          setRedoCommands((redo) => {
            const command = redo[0]
            if (!command) return redo
            setCommands((current) => [...current, command])
            return redo.slice(1)
          })
        } else {
          setCommands((current) => {
            const command = current[current.length - 1]
            if (!command) return current
            setRedoCommands((redo) => [command, ...redo])
            return current.slice(0, -1)
          })
        }
      }
      if (event.key.toLowerCase() === 'b') setTool('brush')
      if (event.key.toLowerCase() === 'r') setTool('rectangle')
      if (event.key.toLowerCase() === 'e') setTool('eraser')
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onCancel])

  const fitScale = useMemo(() => {
    if (!dimensions.width || !dimensions.height) return 1
    return Math.min(
      1,
      Math.max(0.05, (viewportSize.width - 64) / dimensions.width),
      Math.max(0.05, (viewportSize.height - 64) / dimensions.height),
    )
  }, [dimensions, viewportSize])
  const displayWidth = Math.max(1, Math.round(dimensions.width * fitScale * zoom))
  const displayHeight = Math.max(1, Math.round(dimensions.height * fitScale * zoom))
  // 对外只显示一个数：真实像素比例（1 图片像素 = 多少屏幕像素）。
  // zoom 本身是"适应窗口"之上的倍数，直接拿它当百分比会跟 1:1 对不上。
  const displayScale = fitScale * zoom
  const displayPercent = Math.round(displayScale * 100)
  const sourceReady = Boolean(sourceUrl && dimensions.width && dimensions.height)
  const sourceError = Boolean(error && !sourceFile)
  const displayBoxWidth = sourceReady ? displayWidth : Math.min(620, Math.max(360, viewportSize.width - 96))
  const displayBoxHeight = sourceReady ? displayHeight : Math.min(420, Math.max(260, viewportSize.height - 96))

  // 以某个客户端坐标为锚点缩放：先记下这一点落在图上的相对位置，改完 zoom 之后
  // 由下面的 layout effect 调整滚动，让同一点仍停在光标底下。
  const zoomAt = useCallback((nextZoom: number, clientX?: number, clientY?: number) => {
    const target = clampZoom(nextZoom)
    const canvas = overlayCanvasRef.current
    if (canvas && clientX !== undefined && clientY !== undefined) {
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        zoomAnchorRef.current = {
          ratioX: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
          ratioY: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
          clientX,
          clientY,
        }
      }
    }
    setZoom(target)
  }, [])

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current
    const viewport = viewportRef.current
    const canvas = overlayCanvasRef.current
    if (!anchor || !viewport || !canvas) return
    zoomAnchorRef.current = null
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    viewport.scrollLeft += rect.left + anchor.ratioX * rect.width - anchor.clientX
    viewport.scrollTop += rect.top + anchor.ratioY * rect.height - anchor.clientY
  }, [displayWidth, displayHeight])

  // 滚轮缩放。必须用 addEventListener 并且 passive:false，否则 preventDefault 无效、
  // 视口会跟着一起滚。
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      if (!sourceReady) return
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.0015)
      zoomAt(zoom * factor, event.clientX, event.clientY)
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [sourceReady, zoom, zoomAt])

  // 空格按住 = 临时切成抓手。左键要留给画笔，所以平移只走空格或中键。
  useEffect(() => {
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement
      && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || isTyping(event.target)) return
      event.preventDefault()
      setSpaceHeld(true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const beginPan = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const viewport = viewportRef.current
    if (!viewport) return false
    if (event.button !== 1 && !(event.button === 0 && spaceHeld)) return false
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    }
    setPanning(true)
    return true
  }, [spaceHeld])

  const movePan = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pan = panRef.current
    const viewport = viewportRef.current
    if (!pan || !viewport || pan.pointerId !== event.pointerId) return false
    viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX)
    viewport.scrollTop = pan.scrollTop - (event.clientY - pan.startY)
    return true
  }, [])

  const endPan = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return false
    panRef.current = null
    setPanning(false)
    return true
  }, [])

  const redrawWithDraft = useCallback((draft: RepaintCommand | null) => {
    draftRef.current = draft
    paintOverlay(draft)
  }, [paintOverlay])

  const commitDraft = useCallback(() => {
    const draft = draftRef.current
    if (!draft) return
    draftRef.current = null
    setCommands((current) => [...current, draft])
    setRedoCommands([])
  }, [])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (busy || loadingSource || !dimensions.width || !dimensions.height) return
    // 空格按住或中键按下时这一下是平移，不是画笔——交给外层视口处理。
    if (event.button === 1 || spaceHeld) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    const point = sourcePointFromEvent(event, dimensions.width, dimensions.height)
    if (tool === 'rectangle') {
      rectangleStartRef.current = point
      redrawWithDraft({ kind: 'rectangle', mode: 'paint', x: point.x, y: point.y, width: 0, height: 0 })
      return
    }
    redrawWithDraft({
      kind: 'stroke',
      mode: tool === 'eraser' ? 'erase' : 'paint',
      size: brushSize,
      points: [point],
    })
  }, [brushSize, busy, dimensions, loadingSource, redrawWithDraft, tool])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !draftRef.current) return
    event.preventDefault()
    const point = sourcePointFromEvent(event, dimensions.width, dimensions.height)
    if (draftRef.current.kind === 'rectangle') {
      const start = rectangleStartRef.current
      if (!start) return
      redrawWithDraft({
        kind: 'rectangle',
        mode: 'paint',
        x: start.x,
        y: start.y,
        width: point.x - start.x,
        height: point.y - start.y,
      })
      return
    }
    redrawWithDraft({
      ...draftRef.current,
      points: [...draftRef.current.points, point],
    })
  }, [dimensions, redrawWithDraft])

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    event.preventDefault()
    drawingRef.current = false
    rectangleStartRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    commitDraft()
  }, [commitDraft])

  const handleUndo = useCallback(() => {
    setCommands((current) => {
      const command = current[current.length - 1]
      if (!command) return current
      setRedoCommands((redo) => [command, ...redo])
      return current.slice(0, -1)
    })
  }, [])

  const handleRedo = useCallback(() => {
    setRedoCommands((redo) => {
      const command = redo[0]
      if (!command) return redo
      setCommands((current) => [...current, command])
      return redo.slice(1)
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    if (busy || loadingSource || !sourceFile || !dimensions.width || !dimensions.height) return
    setLocalError(null)
    if (!prompt.trim()) {
      setLocalError('请填写局部重绘提示词')
      return
    }
    try {
      const mask = await buildProviderMask(commands, dimensions.width, dimensions.height, sourceName)
      const inferredRatio = inferMultiCameraGridRatio(dimensions.width, dimensions.height, 'auto')
      const ratio = normalizeImageRatioValue(model, inferredRatio)
      const resolution = normalizeImageResolutionValue(model, resolutionForSize(dimensions.width, dimensions.height))
      await onAccept({
        file: mask.file,
        prompt: prompt.trim(),
        model,
        ratio,
        resolution,
        width: dimensions.width,
        height: dimensions.height,
        maskCoverage: mask.coverage,
        commandCount: commands.length,
        brushSize,
      })
    } catch (submitError) {
      setLocalError(submitError instanceof Error ? submitError.message : '局部重绘提交失败')
    }
  }, [brushSize, busy, commands, dimensions, loadingSource, model, onAccept, prompt, sourceFile, sourceName])

  const modal = (
    <div
      className="nodrag nowheel"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 22,
        background: 'rgba(4, 3, 9, 0.82)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div
        style={{
          width: 'min(1480px, calc(100vw - 44px))',
          height: 'min(900px, calc(100vh - 44px))',
          display: 'grid',
          gridTemplateRows: '58px minmax(0, 1fr) 62px',
          overflow: 'hidden',
          borderRadius: 12,
          border: '1px solid rgba(188, 169, 255, 0.2)',
          background: 'linear-gradient(180deg, rgba(25,20,40,0.99), rgba(15,12,25,0.99))',
          boxShadow: '0 28px 90px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '0 16px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{
            width: 34,
            height: 34,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 8,
            background: 'rgba(124,92,252,0.15)',
            border: '1px solid rgba(176,154,255,0.25)',
            color: '#ded7ff',
          }}>
            <Brush size={17} strokeWidth={1.9} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: '#f5f2ff', fontSize: 15, fontWeight: 700 }}>局部重绘</div>
            <div style={{ color: '#817890', fontSize: 11, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {sourceName} · {dimensions.width || '—'} × {dimensions.height || '—'}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
            <button type="button" title="撤销" aria-label="撤销" onClick={handleUndo} disabled={!commands.length || busy} style={toolButtonStyle(false)}>
              <Undo2 size={15} />
            </button>
            <button type="button" title="重做" aria-label="重做" onClick={handleRedo} disabled={!redoCommands.length || busy} style={toolButtonStyle(false)}>
              <Redo2 size={15} />
            </button>
            <button
              type="button"
              title="关闭"
              aria-label="关闭"
              onClick={onCancel}
              disabled={busy}
              style={{ ...toolButtonStyle(false), marginLeft: 6 }}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <main style={{ position: 'relative', minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 330px' }}>
          <section
            ref={viewportRef}
            onPointerDown={beginPan}
            onPointerMove={movePan}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            style={{
              position: 'relative',
              minWidth: 0,
              minHeight: 0,
              overflow: 'auto',
              display: 'grid',
              // 不能用 placeItems:'center'：放大到溢出之后被居中的内容左上角会滚不到。
              // 改成给子元素 margin:auto——有余量时居中，溢出时自动贴到起点，两边都能滚。
              padding: 32,
              backgroundColor: '#050507',
              backgroundImage: 'radial-gradient(circle, rgba(171,153,255,0.15) 1px, transparent 1px)',
              backgroundSize: '18px 18px',
              cursor: panning ? 'grabbing' : spaceHeld ? 'grab' : undefined,
            }}
          >
            <div
              style={{
                position: 'relative',
                width: displayBoxWidth,
                height: displayBoxHeight,
                flex: '0 0 auto',
                margin: 'auto',
                background: '#090812',
                boxShadow: '0 18px 60px rgba(0,0,0,0.48)',
                cursor: panning
                  ? 'grabbing'
                  : spaceHeld
                    ? 'grab'
                    : sourceReady
                      ? (tool === 'eraser' ? 'cell' : 'crosshair')
                      : 'default',
              }}
            >
              {sourceUrl && (
                <img
                  src={sourceUrl}
                  alt=""
                  draggable={false}
                  onLoad={(event) => {
                    const image = event.currentTarget
                    setDimensions({ width: image.naturalWidth, height: image.naturalHeight })
                  }}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
                />
              )}
              <canvas
                ref={overlayCanvasRef}
                // 这个类名同时作为发布对账标记：遮罩为硬边二值，不含 0~1 过渡
                className="shotflow-repaint-mask-hard"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  display: sourceReady ? 'block' : 'none',
                  opacity: maskVisible ? 1 : 0,
                  touchAction: 'none',
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              />
              {!sourceReady ? (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'grid',
                    placeItems: 'center',
                    padding: 24,
                    background:
                      'linear-gradient(135deg, rgba(124,92,252,0.08), rgba(70,185,255,0.05)), radial-gradient(circle at 50% 42%, rgba(190,174,255,0.12), transparent 42%)',
                    color: sourceError ? '#ff9aa7' : '#efeaff',
                    textAlign: 'center',
                  }}
                >
                  <div>
                    {sourceError ? null : (
                      <Loader2 size={22} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
                    )}
                    <div style={{ fontSize: 13, fontWeight: 750 }}>
                      {sourceError ? (error || '局部重绘原图加载失败') : '正在准备局部重绘素材...'}
                    </div>
                    <div style={{ marginTop: 7, color: '#8d84a2', fontSize: 11 }}>
                      {sourceError ? '可以关闭后重试' : '大图会先转成本地编辑素材'}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <aside
            style={{
              minHeight: 0,
              overflow: 'auto',
              padding: '16px 16px 24px',
              scrollbarGutter: 'stable',
              borderLeft: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(18,14,30,0.82)',
            }}
          >
            <div style={{ color: '#d8d1e8', fontSize: 12, fontWeight: 650, marginBottom: 9 }}>遮罩工具</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
              <button type="button" onClick={() => setTool('brush')} style={toolButtonStyle(tool === 'brush')}>
                <Brush size={15} />画笔
              </button>
              <button type="button" onClick={() => setTool('rectangle')} style={toolButtonStyle(tool === 'rectangle')}>
                <SquareDashed size={15} />矩形
              </button>
              <button type="button" onClick={() => setTool('eraser')} style={toolButtonStyle(tool === 'eraser')}>
                <Eraser size={15} />橡皮
              </button>
            </div>

            <label style={{ display: 'block', color: '#9188a5', fontSize: 11, marginTop: 18 }}>
              笔刷大小 <span style={{ float: 'right', color: '#cfc7e5' }}>{brushSize}px</span>
              <input
                type="range"
                min={8}
                max={320}
                step={2}
                value={brushSize}
                onChange={(event) => setBrushSize(Number(event.target.value))}
                style={{ width: '100%', marginTop: 8, accentColor: '#8b6cff' }}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 12 }}>
              <button type="button" onClick={() => setMaskVisible((value) => !value)} style={toolButtonStyle(maskVisible)}>
                {maskVisible ? <Eye size={15} /> : <EyeOff size={15} />}
                {maskVisible ? '显示遮罩' : '隐藏遮罩'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCommands([])
                  setRedoCommands([])
                  redrawWithDraft(null)
                }}
                disabled={!commands.length || busy}
                style={toolButtonStyle(false)}
              >
                <Trash2 size={15} />清空
              </button>
            </div>

            <div style={{
              marginTop: 14,
              padding: '10px 11px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.025)',
              border: '1px solid rgba(255,255,255,0.07)',
              color: '#847b99',
              fontSize: 11,
              lineHeight: 1.65,
            }}>
              紫色区域会被重新生成，未涂抹区域会保留原图。遮罩以原图分辨率保存，不做羽化或模糊。
            </div>

            <label style={{ display: 'block', marginTop: 14 }}>
              <span style={{ color: '#d8d1e8', fontSize: 12, fontWeight: 650 }}>提示词</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="描述选中区域需要变成什么，未选区域无需重复描述。"
                style={{
                  width: '100%',
                  height: 132,
                  marginTop: 8,
                  resize: 'vertical',
                  borderRadius: 8,
                  border: '1px solid rgba(174,151,255,0.18)',
                  outline: 'none',
                  padding: 11,
                  background: 'rgba(7,5,14,0.72)',
                  color: '#f3efff',
                  fontSize: 13,
                  lineHeight: 1.65,
                }}
              />
            </label>

            <label style={{ display: 'block', marginTop: 14 }}>
              <span style={{ color: '#d8d1e8', fontSize: 12, fontWeight: 650 }}>图片模型</span>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                style={{
                  width: '100%',
                  height: 36,
                  marginTop: 8,
                  padding: '0 10px',
                  borderRadius: 7,
                  border: '1px solid rgba(174,151,255,0.18)',
                  background: '#120e20',
                  color: '#eee9ff',
                  outline: 'none',
                }}
              >
                {REPAINT_MODELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>

            <label style={{ display: 'block', color: '#9188a5', fontSize: 11, marginTop: 18 }}>
              画布缩放 <span style={{ float: 'right', color: '#cfc7e5' }}>{displayPercent}%</span>
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.05}
                value={zoom}
                onChange={(event) => zoomAt(Number(event.target.value))}
                style={{ width: '100%', marginTop: 8, accentColor: '#8b6cff' }}
              />
            </label>
          </aside>

          {/* 缩放工具条。放在 main 上而不是可滚动的视口里，否则一滚就跟着跑掉。
              左键要留给画笔，所以平移用空格拖或中键拖。 */}
          {sourceReady && (
            <div
              style={{
                position: 'absolute',
                left: 20,
                bottom: 20,
                zIndex: 2,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: 6,
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(14, 11, 24, 0.9)',
                boxShadow: '0 12px 34px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(14px)',
              }}
            >
              <button
                type="button"
                title="缩小"
                onClick={() => zoomAt(zoom / ZOOM_STEP)}
                disabled={zoom <= MIN_ZOOM}
                style={toolButtonStyle(false)}
              >
                <Minus size={15} />
              </button>
              <span
                style={{
                  minWidth: 54,
                  textAlign: 'center',
                  fontSize: 12,
                  color: '#cfc7e5',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {displayPercent}%
              </span>
              <button
                type="button"
                title="放大"
                onClick={() => zoomAt(zoom * ZOOM_STEP)}
                disabled={zoom >= MAX_ZOOM}
                style={toolButtonStyle(false)}
              >
                <Plus size={15} />
              </button>
              <button type="button" title="适应窗口" onClick={() => zoomAt(1)} style={toolButtonStyle(false)}>
                <Maximize2 size={14} />
              </button>
              <button
                type="button"
                title="按图片原始像素显示"
                onClick={() => zoomAt(1 / Math.max(0.0001, fitScale))}
                style={toolButtonStyle(Math.abs(displayScale - 1) < 0.005)}
              >
                1:1
              </button>
              <span style={{ marginLeft: 4, fontSize: 11, color: '#6f6785' }}>
                滚轮缩放 · 空格/中键拖动
              </span>
            </div>
          )}
        </main>

        <footer
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 16px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ color: '#776f87', fontSize: 11 }}>
            B 画笔 · R 矩形 · E 橡皮 · Ctrl/⌘ + Z 撤销
          </div>
          {(localError || error) && (
            <div style={{
              marginLeft: 12,
              maxWidth: 520,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: '#ff8f9d',
              fontSize: 12,
            }}>
              {localError || error}
            </div>
          )}
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{ ...toolButtonStyle(false), marginLeft: 'auto', minWidth: 76 }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy || loadingSource || !sourceReady}
            style={{
              height: 36,
              minWidth: 154,
              padding: '0 16px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'linear-gradient(135deg, #8b6cff, #c8b5ff)',
              color: '#130d24',
              fontWeight: 750,
              cursor: (busy || loadingSource || !sourceReady) ? 'default' : 'pointer',
              opacity: (busy || loadingSource || !sourceReady) ? 0.72 : 1,
            }}
          >
            {busy ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={16} />}
            {busy ? '正在提交' : '生成局部重绘节点'}
          </button>
        </footer>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
