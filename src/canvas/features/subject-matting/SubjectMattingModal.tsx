import {
  Brush,
  Check,
  Eraser,
  Loader2,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  ScanLine,
  SquareDashed,
  Undo2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { subjectMattingApi, type SubjectMattingAutomaticMask } from '@/lib/api'
import './SubjectMattingModal.css'

type MattingTool = 'point' | 'brush' | 'box'
type PaintIntent = 'keep' | 'exclude'
type InspectMode = 'overlay' | 'inside' | 'outside'
type PreviewMode = 'transparent' | 'black' | 'white' | 'mask'
const MIN_BOX_SIZE_PX = 3

interface MattingPoint {
  x: number
  y: number
}

type MattingCommand =
  | { kind: 'stroke'; intent: PaintIntent; size: number; softness?: number; points: MattingPoint[] }
  | { kind: 'box'; intent: PaintIntent; x: number; y: number; width: number; height: number }
  | { kind: 'region'; intent: PaintIntent; point: MattingPoint; tolerance: number; radius: number }
  | {
      kind: 'sam'
      intent: PaintIntent
      sourceKind: 'point' | 'box'
      maskCanvas: HTMLCanvasElement
      taskVersion: number
      point?: MattingPoint
      box?: { x: number; y: number; width: number; height: number }
    }

interface LoggedMattingCommand {
  id: string
  command: MattingCommand
}

interface MattingPointMarker {
  id: string
  intent: PaintIntent
  point: MattingPoint
}

interface BrushCursorPoint extends MattingPoint {}

interface BrushSizePreviewPoint {
  clientX: number
  clientY: number
}

interface MattingHistorySnapshot {
  mask: ImageData
  commands: LoggedMattingCommand[]
  markers: MattingPointMarker[]
}

interface StageViewTransform {
  scale: number
  x: number
  y: number
}

interface PanDragState {
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
}

export interface SubjectMattingAcceptPayload {
  file: File
  width: number
  height: number
  maskCoverage: number
  settings: Record<string, unknown>
}

interface SubjectMattingModalProps {
  projectUuid: string
  nodeKey: string
  sourceUrl: string
  sourceFile?: File | null
  sourceName?: string
  busy?: boolean
  loadingSource?: boolean
  automaticMask?: SubjectMattingAutomaticMask | null
  automaticMaskLoading?: boolean
  error?: string | null
  onCancel: () => void
  onAccept: (payload: SubjectMattingAcceptPayload) => void | Promise<void>
}

const AUTO_MASK_MAX_EDGE = 920
const AUTO_MASK_MIN_RELIABLE_COVERAGE = 0.015
const AUTO_MASK_MAX_RELIABLE_COVERAGE = 0.96
const AUTO_MASK_MAX_BORDER_COVERAGE = 0.55
const POINT_REGION_MAX_EDGE = 720
const POINT_REGION_TOLERANCE = 52
const POINT_REGION_RADIUS = 0.24
const MIN_STAGE_ZOOM = 0.3
const MAX_STAGE_ZOOM = 8

function stripExtension(name: string) {
  return String(name || 'image').replace(/\.[a-z0-9]+$/i, '') || 'image'
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('抠像导出失败，请重试'))
    }, 'image/png')
  })
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function isAutomaticMaskCoverageUsable(value?: number | null) {
  const coverage = Number(value)
  return Number.isFinite(coverage)
    && coverage >= AUTO_MASK_MIN_RELIABLE_COVERAGE
    && coverage <= AUTO_MASK_MAX_RELIABLE_COVERAGE
}

function isAutomaticMaskUsable(mask?: SubjectMattingAutomaticMask | null) {
  if (!mask || mask.status !== 'ready' || !mask.maskDataUrl) return false
  if (mask.maskReliable === false) return false
  if (!isAutomaticMaskCoverageUsable(mask.maskCoverage)) return false
  const borderCoverage = Number(mask.maskBorderCoverage)
  return !Number.isFinite(borderCoverage) || borderCoverage <= AUTO_MASK_MAX_BORDER_COVERAGE
}

function normalizeMaskImageToAlphaCanvas(image: HTMLImageElement, width: number, height: number) {
  const tempCanvas = document.createElement('canvas')
  tempCanvas.width = width
  tempCanvas.height = height
  const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })
  if (!tempCtx) return null
  tempCtx.drawImage(image, 0, 0, width, height)
  const pixels = tempCtx.getImageData(0, 0, width, height)
  const data = pixels.data
  let hasUsefulAlpha = false
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 250) {
      hasUsefulAlpha = true
      break
    }
  }
  for (let index = 0; index < data.length; index += 4) {
    const alpha = hasUsefulAlpha
      ? data[index + 3]
      : Math.round(data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722)
    data[index] = 255
    data[index + 1] = 255
    data[index + 2] = 255
    data[index + 3] = alpha
  }
  tempCtx.putImageData(pixels, 0, 0)
  return tempCanvas
}

function colorDistance(data: Uint8ClampedArray, index: number, color: [number, number, number]) {
  const dr = data[index] - color[0]
  const dg = data[index + 1] - color[1]
  const db = data[index + 2] - color[2]
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function makePointRegionCanvas(
  imageCanvas: HTMLCanvasElement,
  seed: MattingPoint,
  tolerance = POINT_REGION_TOLERANCE,
  radiusRatio = POINT_REGION_RADIUS,
) {
  const width = imageCanvas.width
  const height = imageCanvas.height
  const scale = Math.min(1, POINT_REGION_MAX_EDGE / Math.max(width, height))
  const workWidth = Math.max(1, Math.round(width * scale))
  const workHeight = Math.max(1, Math.round(height * scale))
  const workCanvas = document.createElement('canvas')
  workCanvas.width = workWidth
  workCanvas.height = workHeight
  const workCtx = workCanvas.getContext('2d', { willReadFrequently: true })
  if (!workCtx) return null
  workCtx.drawImage(imageCanvas, 0, 0, workWidth, workHeight)
  const pixels = workCtx.getImageData(0, 0, workWidth, workHeight)
  const data = pixels.data
  const seedX = clamp(Math.round(seed.x * scale), 0, workWidth - 1)
  const seedY = clamp(Math.round(seed.y * scale), 0, workHeight - 1)
  const seedOffset = seedY * workWidth + seedX
  const seedIndex = seedOffset * 4
  if (data[seedIndex + 3] < 8) return null

  const seedColor: [number, number, number] = [data[seedIndex], data[seedIndex + 1], data[seedIndex + 2]]
  const visited = new Uint8Array(workWidth * workHeight)
  const selected = new Uint8Array(workWidth * workHeight)
  const queue = new Int32Array(workWidth * workHeight)
  let head = 0
  let tail = 0
  const maxRadius = Math.max(14, Math.round(Math.max(workWidth, workHeight) * radiusRatio))
  const maxRadiusSq = maxRadius * maxRadius
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= workWidth || y >= workHeight) return
    const dx = x - seedX
    const dy = y - seedY
    if ((dx * dx + dy * dy) > maxRadiusSq) return
    const offset = y * workWidth + x
    if (visited[offset]) return
    visited[offset] = 1
    const index = offset * 4
    if (data[index + 3] < 8) return
    if (colorDistance(data, index, seedColor) > tolerance) return
    selected[offset] = 1
    queue[tail++] = offset
  }

  push(seedX, seedY)
  while (head < tail) {
    const offset = queue[head++]
    const x = offset % workWidth
    const y = Math.floor(offset / workWidth)
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }

  const regionCanvas = document.createElement('canvas')
  regionCanvas.width = workWidth
  regionCanvas.height = workHeight
  const regionCtx = regionCanvas.getContext('2d')
  if (!regionCtx) return null
  const region = regionCtx.createImageData(workWidth, workHeight)
  let count = 0
  for (let index = 0; index < selected.length; index += 1) {
    if (!selected[index]) continue
    count += 1
    const dataIndex = index * 4
    region.data[dataIndex] = 255
    region.data[dataIndex + 1] = 255
    region.data[dataIndex + 2] = 255
    region.data[dataIndex + 3] = 255
  }
  if (count < 10) {
    regionCtx.fillStyle = '#fff'
    regionCtx.beginPath()
    regionCtx.arc(seedX, seedY, Math.max(10, Math.round(18 * scale)), 0, Math.PI * 2)
    regionCtx.fill()
  } else {
    regionCtx.putImageData(region, 0, 0)
  }

  const fullCanvas = document.createElement('canvas')
  fullCanvas.width = width
  fullCanvas.height = height
  const fullCtx = fullCanvas.getContext('2d')
  if (!fullCtx) return null
  fullCtx.imageSmoothingEnabled = true
  fullCtx.filter = 'blur(1.2px)'
  fullCtx.drawImage(regionCanvas, 0, 0, width, height)
  fullCtx.filter = 'none'
  return fullCanvas
}

function drawStrokeShape(
  ctx: CanvasRenderingContext2D,
  command: Extract<MattingCommand, { kind: 'stroke' }>,
  size: number,
) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1, size)
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
  if (command.points.length === 1) {
    const point = command.points[0]
    ctx.beginPath()
    ctx.arc(point.x, point.y, Math.max(0.5, size / 2), 0, Math.PI * 2)
    ctx.fill()
  } else if (command.points.length > 1) {
    ctx.beginPath()
    ctx.moveTo(command.points[0].x, command.points[0].y)
    for (const point of command.points.slice(1)) ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }
}

function drawStrokeCommand(ctx: CanvasRenderingContext2D, command: Extract<MattingCommand, { kind: 'stroke' }>) {
  const softness = clamp(Number(command.softness || 0), 0, Math.max(0, command.size / 2))
  if (softness <= 0.01) {
    drawStrokeShape(ctx, command, command.size)
    return
  }
  const width = ctx.canvas.width
  const height = ctx.canvas.height
  const stampCanvas = document.createElement('canvas')
  stampCanvas.width = width
  stampCanvas.height = height
  const stampCtx = stampCanvas.getContext('2d')
  if (!stampCtx) {
    drawStrokeShape(ctx, command, command.size)
    return
  }
  drawStrokeShape(stampCtx, command, Math.max(1, command.size - softness * 2))

  const softCanvas = document.createElement('canvas')
  softCanvas.width = width
  softCanvas.height = height
  const softCtx = softCanvas.getContext('2d')
  if (!softCtx) {
    ctx.drawImage(stampCanvas, 0, 0)
    return
  }
  softCtx.filter = `blur(${softness}px)`
  softCtx.drawImage(stampCanvas, 0, 0)
  softCtx.filter = 'none'
  ctx.drawImage(softCanvas, 0, 0)
}

function drawCommand(ctx: CanvasRenderingContext2D, command: MattingCommand, imageCanvas?: HTMLCanvasElement | null) {
  ctx.save()
  ctx.globalCompositeOperation = command.intent === 'exclude' ? 'destination-out' : 'source-over'
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
  if (command.kind === 'stroke') {
    drawStrokeCommand(ctx, command)
  } else if (command.kind === 'box') {
    ctx.fillRect(command.x, command.y, command.width, command.height)
  } else if (command.kind === 'sam') {
    ctx.drawImage(command.maskCanvas, 0, 0)
  } else {
    const regionCanvas = imageCanvas ? makePointRegionCanvas(imageCanvas, command.point, command.tolerance, command.radius) : null
    if (regionCanvas) {
      ctx.drawImage(regionCanvas, 0, 0)
    } else {
      ctx.beginPath()
      ctx.arc(command.point.x, command.point.y, 18, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

function cloneMattingCommand(command: MattingCommand): MattingCommand {
  if (command.kind === 'stroke') {
    return {
      kind: 'stroke',
      intent: command.intent,
      size: command.size,
      softness: command.softness ?? 0,
      points: command.points.map((point) => ({ ...point })),
    }
  }
  if (command.kind === 'box') {
    return { ...command }
  }
  if (command.kind === 'sam') {
    const clone = document.createElement('canvas')
    clone.width = command.maskCanvas.width
    clone.height = command.maskCanvas.height
    const ctx = clone.getContext('2d')
    if (ctx) ctx.drawImage(command.maskCanvas, 0, 0)
    return {
      kind: 'sam',
      intent: command.intent,
      sourceKind: command.sourceKind,
      maskCanvas: clone,
      taskVersion: command.taskVersion,
      point: command.point ? { ...command.point } : undefined,
      box: command.box ? { ...command.box } : undefined,
    }
  }
  return {
    kind: 'region',
    intent: command.intent,
    point: { ...command.point },
    tolerance: command.tolerance,
    radius: command.radius,
  }
}

function cloneLoggedCommands(commands: LoggedMattingCommand[]) {
  return commands.map((item) => ({
    id: item.id,
    command: cloneMattingCommand(item.command),
  }))
}

function clonePointMarkers(markers: MattingPointMarker[]) {
  return markers.map((marker) => ({
    id: marker.id,
    intent: marker.intent,
    point: { ...marker.point },
  }))
}

function cloneCanvas(source: HTMLCanvasElement) {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.drawImage(source, 0, 0)
  return canvas
}

function readMaskAlpha(maskCanvas: HTMLCanvasElement) {
  const width = maskCanvas.width
  const height = maskCanvas.height
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const pixels = ctx.getImageData(0, 0, width, height).data
  const alpha = new Uint8ClampedArray(width * height)
  for (let sourceIndex = 3, targetIndex = 0; sourceIndex < pixels.length; sourceIndex += 4, targetIndex += 1) {
    alpha[targetIndex] = pixels[sourceIndex]
  }
  return alpha
}

function writeAlphaMaskCanvas(alpha: Uint8ClampedArray, width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const imageData = ctx.createImageData(width, height)
  const pixels = imageData.data
  for (let alphaIndex = 0, pixelIndex = 0; alphaIndex < alpha.length; alphaIndex += 1, pixelIndex += 4) {
    pixels[pixelIndex] = 255
    pixels[pixelIndex + 1] = 255
    pixels[pixelIndex + 2] = 255
    pixels[pixelIndex + 3] = alpha[alphaIndex]
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

function filterAlphaLine(
  source: Uint8ClampedArray,
  target: Uint8ClampedArray,
  start: number,
  stride: number,
  length: number,
  radius: number,
  mode: 'max' | 'min',
) {
  const deque = new Int32Array(length)
  let head = 0
  let tail = 0
  let added = -1
  for (let index = 0; index < length; index += 1) {
    const right = Math.min(length - 1, index + radius)
    while (added < right) {
      added += 1
      const value = source[start + added * stride]
      while (head < tail) {
        const lastIndex = deque[tail - 1]
        const lastValue = source[start + lastIndex * stride]
        if (mode === 'max' ? lastValue > value : lastValue < value) break
        tail -= 1
      }
      deque[tail] = added
      tail += 1
    }
    const left = index - radius
    while (head < tail && deque[head] < left) head += 1
    const value = source[start + deque[head] * stride]
    target[start + index * stride] = mode === 'min' && (left < 0 || index + radius >= length) ? 0 : value
  }
}

function morphMaskAlpha(alpha: Uint8ClampedArray, width: number, height: number, radius: number, mode: 'max' | 'min') {
  if (radius <= 0) return alpha
  const temp = new Uint8ClampedArray(alpha.length)
  const output = new Uint8ClampedArray(alpha.length)
  for (let y = 0; y < height; y += 1) {
    filterAlphaLine(alpha, temp, y * width, 1, width, radius, mode)
  }
  for (let x = 0; x < width; x += 1) {
    filterAlphaLine(temp, output, x, width, height, radius, mode)
  }
  return output
}

function makeEdgeShiftedMaskCanvas(maskCanvas: HTMLCanvasElement, edgeShift: number) {
  const shift = Number(edgeShift)
  const radius = Math.round(Math.abs(shift))
  if (!Number.isFinite(shift) || radius <= 0) return maskCanvas
  const alpha = readMaskAlpha(maskCanvas)
  if (!alpha) return maskCanvas
  const mode = shift > 0 ? 'max' : 'min'
  const shiftedAlpha = morphMaskAlpha(alpha, maskCanvas.width, maskCanvas.height, radius, mode)
  return writeAlphaMaskCanvas(shiftedAlpha, maskCanvas.width, maskCanvas.height) || maskCanvas
}

function invertMaskAlphaCanvas(maskCanvas: HTMLCanvasElement) {
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return maskCanvas
  const imageData = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
  for (let index = 3; index < imageData.data.length; index += 4) {
    imageData.data[index] = 255 - imageData.data[index]
  }
  const inverted = document.createElement('canvas')
  inverted.width = maskCanvas.width
  inverted.height = maskCanvas.height
  const invertedCtx = inverted.getContext('2d')
  if (!invertedCtx) return maskCanvas
  invertedCtx.putImageData(imageData, 0, 0)
  return inverted
}

async function dataUrlToMaskCanvas(dataUrl: string, width: number, height: number) {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('SAM 遮罩加载失败'))
    image.src = dataUrl
  })
  const normalized = normalizeMaskImageToAlphaCanvas(image, width, height)
  if (normalized) return normalized

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器无法创建 SAM 遮罩画布')
  ctx.drawImage(image, 0, 0, width, height)
  return canvas
}

function isEditableKeyTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'))
}

function getCanvasPoint(event: ReactPointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: clamp(((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width, 0, canvas.width),
    y: clamp(((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height, 0, canvas.height),
  }
}

function normalizePoint(point: MattingPoint, width: number, height: number) {
  return {
    x: clamp(point.x / Math.max(1, width), 0, 1),
    y: clamp(point.y / Math.max(1, height), 0, 1),
  }
}

function normalizeBox(box: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const x1 = clamp(Math.min(box.x, box.x + box.width), 0, width)
  const y1 = clamp(Math.min(box.y, box.y + box.height), 0, height)
  const x2 = clamp(Math.max(box.x, box.x + box.width), 0, width)
  const y2 = clamp(Math.max(box.y, box.y + box.height), 0, height)
  return {
    x: x1 / Math.max(1, width),
    y: y1 / Math.max(1, height),
    width: (x2 - x1) / Math.max(1, width),
    height: (y2 - y1) / Math.max(1, height),
  }
}

function estimateBorderColor(data: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  const step = Math.max(1, Math.floor(Math.min(width, height) / 64))
  const add = (x: number, y: number) => {
    const index = (y * width + x) * 4
    r += data[index]
    g += data[index + 1]
    b += data[index + 2]
    count += 1
  }
  for (let x = 0; x < width; x += step) {
    add(x, 0)
    add(x, height - 1)
  }
  for (let y = 0; y < height; y += step) {
    add(0, y)
    add(width - 1, y)
  }
  return [r / Math.max(1, count), g / Math.max(1, count), b / Math.max(1, count)]
}

function makeAutomaticMask(imageCanvas: HTMLCanvasElement, threshold = 54) {
  const width = imageCanvas.width
  const height = imageCanvas.height
  const scale = Math.min(1, AUTO_MASK_MAX_EDGE / Math.max(width, height))
  const workWidth = Math.max(1, Math.round(width * scale))
  const workHeight = Math.max(1, Math.round(height * scale))
  const workCanvas = document.createElement('canvas')
  workCanvas.width = workWidth
  workCanvas.height = workHeight
  const workCtx = workCanvas.getContext('2d', { willReadFrequently: true })
  if (!workCtx) return null
  workCtx.drawImage(imageCanvas, 0, 0, workWidth, workHeight)
  const pixels = workCtx.getImageData(0, 0, workWidth, workHeight)
  const data = pixels.data
  const bgColor = estimateBorderColor(data, workWidth, workHeight)
  const visited = new Uint8Array(workWidth * workHeight)
  const queue = new Int32Array(workWidth * workHeight)
  let head = 0
  let tail = 0
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= workWidth || y >= workHeight) return
    const offset = y * workWidth + x
    if (visited[offset]) return
    const index = offset * 4
    if (data[index + 3] < 8 || colorDistance(data, index, bgColor) <= threshold) {
      visited[offset] = 1
      queue[tail++] = offset
    }
  }
  for (let x = 0; x < workWidth; x++) {
    push(x, 0)
    push(x, workHeight - 1)
  }
  for (let y = 0; y < workHeight; y++) {
    push(0, y)
    push(workWidth - 1, y)
  }
  while (head < tail) {
    const offset = queue[head++]
    const x = offset % workWidth
    const y = Math.floor(offset / workWidth)
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }

  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = workWidth
  maskCanvas.height = workHeight
  const maskCtx = maskCanvas.getContext('2d')
  if (!maskCtx) return null
  const mask = maskCtx.createImageData(workWidth, workHeight)
  let selected = 0
  for (let index = 0; index < visited.length; index += 1) {
    const alpha = visited[index] ? 0 : 255
    if (alpha) selected += 1
    const dataIndex = index * 4
    mask.data[dataIndex] = 255
    mask.data[dataIndex + 1] = 255
    mask.data[dataIndex + 2] = 255
    mask.data[dataIndex + 3] = alpha
  }
  maskCtx.putImageData(mask, 0, 0)
  const coverage = selected / Math.max(1, visited.length)
  if (coverage < 0.025 || coverage > 0.96) {
    maskCtx.clearRect(0, 0, workWidth, workHeight)
    const radiusX = workWidth * 0.34
    const radiusY = workHeight * 0.42
    maskCtx.fillStyle = '#fff'
    maskCtx.beginPath()
    maskCtx.ellipse(workWidth / 2, workHeight / 2, radiusX, radiusY, 0, 0, Math.PI * 2)
    maskCtx.fill()
  }
  const fullCanvas = document.createElement('canvas')
  fullCanvas.width = width
  fullCanvas.height = height
  const fullCtx = fullCanvas.getContext('2d')
  if (!fullCtx) return null
  fullCtx.imageSmoothingEnabled = true
  fullCtx.drawImage(maskCanvas, 0, 0, width, height)
  return fullCanvas
}

function drawChecker(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const size = 24
  ctx.fillStyle = '#18202a'
  ctx.fillRect(0, 0, width, height)
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#222c38' : '#151c26'
      ctx.fillRect(x, y, size, size)
    }
  }
}

function drawPreviewBackground(ctx: CanvasRenderingContext2D, width: number, height: number, previewMode: PreviewMode) {
  if (previewMode === 'transparent') drawChecker(ctx, width, height)
  else if (previewMode === 'black') {
    ctx.fillStyle = '#050508'
    ctx.fillRect(0, 0, width, height)
  } else if (previewMode === 'white') {
    ctx.fillStyle = '#f7f5ef'
    ctx.fillRect(0, 0, width, height)
  }
}

function makeMaskedImageCanvas(imageCanvas: HTMLCanvasElement, maskCanvas: HTMLCanvasElement, mode: 'inside' | 'outside') {
  const width = imageCanvas.width
  const height = imageCanvas.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(imageCanvas, 0, 0)
  ctx.globalCompositeOperation = mode === 'inside' ? 'destination-in' : 'destination-out'
  ctx.drawImage(maskCanvas, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  return canvas
}

function drawMaskTint(ctx: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement, color: string) {
  const width = maskCanvas.width
  const height = maskCanvas.height
  const tintCanvas = document.createElement('canvas')
  tintCanvas.width = width
  tintCanvas.height = height
  const tintCtx = tintCanvas.getContext('2d')
  if (!tintCtx) return
  tintCtx.fillStyle = color
  tintCtx.fillRect(0, 0, width, height)
  tintCtx.globalCompositeOperation = 'destination-in'
  tintCtx.drawImage(maskCanvas, 0, 0)
  ctx.drawImage(tintCanvas, 0, 0)
}

function drawMaskGuide(ctx: CanvasRenderingContext2D, maskCanvas: HTMLCanvasElement) {
  const width = maskCanvas.width
  const height = maskCanvas.height
  const guideCanvas = document.createElement('canvas')
  guideCanvas.width = width
  guideCanvas.height = height
  const guideCtx = guideCanvas.getContext('2d')
  if (!guideCtx) return
  guideCtx.filter = 'blur(3px)'
  guideCtx.drawImage(maskCanvas, 0, 0)
  guideCtx.filter = 'none'
  guideCtx.globalCompositeOperation = 'destination-out'
  guideCtx.drawImage(maskCanvas, 0, 0)
  guideCtx.globalCompositeOperation = 'source-in'
  guideCtx.fillStyle = 'rgba(129, 156, 255, 0.76)'
  guideCtx.fillRect(0, 0, width, height)
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  ctx.drawImage(guideCanvas, 0, 0)
  ctx.restore()
}

export function SubjectMattingModal({
  projectUuid,
  nodeKey,
  sourceUrl,
  sourceFile,
  sourceName,
  busy = false,
  loadingSource = false,
  automaticMask = null,
  automaticMaskLoading = false,
  error,
  onCancel,
  onAccept,
}: SubjectMattingModalProps) {
  const stageRef = useRef<HTMLElement | null>(null)
  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<{
    pointerId: number
    commandId: string
    command: MattingCommand
    baseMask: ImageData | null
    baseSnapshot: MattingHistorySnapshot | null
  } | null>(null)
  const panDragRef = useRef<PanDragState | null>(null)
  const baseMaskRef = useRef<ImageData | null>(null)
  const commandLogRef = useRef<LoggedMattingCommand[]>([])
  const commandIdRef = useRef(0)
  const pointMarkersRef = useRef<MattingPointMarker[]>([])
  const spacePressedRef = useRef(false)
  const correctionVersionRef = useRef(0)
  const pendingCorrectionIdsRef = useRef(new Set<string>())
  const maskTouchedRef = useRef(false)
  const autoMaskAppliedKeyRef = useRef<string | null>(null)

  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const [maskVersion, setMaskVersion] = useState(0)
  const [tool, setTool] = useState<MattingTool>('brush')
  const [intent, setIntent] = useState<PaintIntent>('keep')
  const [brushSize, setBrushSize] = useState(36)
  const [edgeSoftness, setEdgeSoftness] = useState(4)
  const [edgeShift, setEdgeShift] = useState(0)
  const [backgroundClean, setBackgroundClean] = useState(24)
  const [removeWhiteEdge, setRemoveWhiteEdge] = useState(true)
  const [removeBlackEdge, setRemoveBlackEdge] = useState(false)
  const [reverseOutput, setReverseOutput] = useState(false)
  const [inspectMode, setInspectMode] = useState<InspectMode>('overlay')
  const [hideGuides, setHideGuides] = useState(false)
  const [previewMode, setPreviewMode] = useState<PreviewMode>('transparent')
  const [history, setHistory] = useState<MattingHistorySnapshot[]>([])
  const [redoStack, setRedoStack] = useState<MattingHistorySnapshot[]>([])
  const [pointMarkers, setPointMarkers] = useState<MattingPointMarker[]>([])
  const [brushCursor, setBrushCursor] = useState<BrushCursorPoint | null>(null)
  const [brushSizePreview, setBrushSizePreview] = useState<BrushSizePreviewPoint | null>(null)
  const [boxPreview, setBoxPreview] = useState<{
    kind: 'box'
    intent: PaintIntent
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const [viewTransform, setViewTransform] = useState<StageViewTransform>({ scale: 1, x: 0, y: 0 })
  const [spacePanning, setSpacePanning] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [correctionBusy, setCorrectionBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const displayName = sourceName || sourceFile?.name || 'image'
  const hasSource = Boolean(sourceFile && naturalSize)
  const brushCursorEnabled = tool === 'brush' && hasSource && !busy && !correctionBusy && !isPanning && !spacePanning
  const autoMaskStatusText = automaticMaskLoading
    ? 'BiRefNet 自动识别中'
    : isAutomaticMaskUsable(automaticMask)
      ? 'BiRefNet 自动识别完成'
      : automaticMask?.status === 'ready'
        ? '本地预选，BiRefNet 结果异常'
      : automaticMask?.warning
        ? '本地预选，BiRefNet 未可用'
        : '自动识别完成'

  const captureHistorySnapshot = useCallback((): MattingHistorySnapshot | null => {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !ctx) return null
    return {
      mask: ctx.getImageData(0, 0, canvas.width, canvas.height),
      commands: cloneLoggedCommands(commandLogRef.current),
      markers: clonePointMarkers(pointMarkersRef.current),
    }
  }, [])

  const applyHistorySnapshot = useCallback((snapshot: MattingHistorySnapshot) => {
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !ctx) return
    ctx.putImageData(snapshot.mask, 0, 0)
    const commands = cloneLoggedCommands(snapshot.commands)
    const markers = clonePointMarkers(snapshot.markers)
    commandLogRef.current = commands
    pointMarkersRef.current = markers
    setPointMarkers(markers)
    setMaskVersion((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!brushCursorEnabled) setBrushCursor(null)
  }, [brushCursorEnabled])

  const rememberMask = useCallback(() => {
    const snapshot = captureHistorySnapshot()
    if (!snapshot) return
    setHistory((items) => [...items.slice(-24), snapshot])
    setRedoStack([])
  }, [captureHistorySnapshot])

  const nextCommandId = useCallback(() => {
    commandIdRef.current += 1
    return `matting-command-${Date.now().toString(36)}-${commandIdRef.current}`
  }, [])

  const resetCommandTracking = useCallback((maskCanvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    baseMaskRef.current = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
    commandLogRef.current = []
    pointMarkersRef.current = []
    setPointMarkers([])
  }, [])

  const rebuildMaskFromCommands = useCallback((commands: LoggedMattingCommand[] = commandLogRef.current) => {
    const maskCanvas = maskCanvasRef.current
    const ctx = maskCanvas?.getContext('2d')
    const baseMask = baseMaskRef.current
    if (!maskCanvas || !ctx || !baseMask) return
    ctx.putImageData(baseMask, 0, 0)
    for (const item of commands) {
      drawCommand(ctx, item.command, imageCanvasRef.current)
    }
    setMaskVersion((value) => value + 1)
  }, [])

  const applyAutomaticMaskDataUrl = useCallback((maskDataUrl: string, key: string, preserveHistory = false) => {
    const maskCanvas = maskCanvasRef.current
    if (!maskCanvas || !maskDataUrl || maskTouchedRef.current || autoMaskAppliedKeyRef.current === key) return
    const maskCtx = maskCanvas.getContext('2d')
    if (!maskCtx) return
    const image = new Image()
    image.onload = () => {
      if (maskTouchedRef.current || autoMaskAppliedKeyRef.current === key) return
      maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
      const alphaMask = normalizeMaskImageToAlphaCanvas(image, maskCanvas.width, maskCanvas.height)
      if (alphaMask) maskCtx.drawImage(alphaMask, 0, 0)
      else maskCtx.drawImage(image, 0, 0, maskCanvas.width, maskCanvas.height)
      autoMaskAppliedKeyRef.current = key
      resetCommandTracking(maskCanvas, maskCtx)
      if (!preserveHistory) {
        setHistory([])
        setRedoStack([])
      }
      setMaskVersion((value) => value + 1)
    }
    image.src = maskDataUrl
  }, [resetCommandTracking])

  const redrawView = useCallback(() => {
    const imageCanvas = imageCanvasRef.current
    const maskCanvas = maskCanvasRef.current
    const viewCanvas = viewCanvasRef.current
    if (!imageCanvas || !maskCanvas || !viewCanvas) return
    const width = imageCanvas.width
    const height = imageCanvas.height
    if (viewCanvas.width !== width) viewCanvas.width = width
    if (viewCanvas.height !== height) viewCanvas.height = height
    const ctx = viewCanvas.getContext('2d')
    if (!ctx) return
    const refinedMask = makeEdgeShiftedMaskCanvas(maskCanvas, edgeShift)
    const displayMaskCanvas = reverseOutput ? invertMaskAlphaCanvas(refinedMask) : refinedMask

    if (previewMode === 'mask') {
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#050508'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(displayMaskCanvas, 0, 0)
      if (!hideGuides) drawMaskGuide(ctx, displayMaskCanvas)
      return
    }

    ctx.clearRect(0, 0, width, height)
    if (inspectMode === 'overlay') {
      ctx.drawImage(imageCanvas, 0, 0)
      drawMaskTint(ctx, displayMaskCanvas, 'rgba(92, 121, 255, 0.42)')
      if (!hideGuides) drawMaskGuide(ctx, displayMaskCanvas)
      return
    }

    drawPreviewBackground(ctx, width, height, previewMode)
    const clipped = makeMaskedImageCanvas(imageCanvas, displayMaskCanvas, inspectMode)
    if (clipped) ctx.drawImage(clipped, 0, 0)
    if (!hideGuides) drawMaskGuide(ctx, displayMaskCanvas)
  }, [edgeShift, hideGuides, inspectMode, previewMode, reverseOutput])

  useEffect(() => {
    if (!sourceFile) return
    let cancelled = false
    setLocalError(null)
    maskTouchedRef.current = false
    autoMaskAppliedKeyRef.current = null
    correctionVersionRef.current += 1
    pendingCorrectionIdsRef.current.clear()
    setViewTransform({ scale: 1, x: 0, y: 0 })
    setIsPanning(false)
    setSpacePanning(false)
    setCorrectionBusy(false)
    const url = URL.createObjectURL(sourceFile)
    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      const width = image.naturalWidth || image.width
      const height = image.naturalHeight || image.height
      const imageCanvas = document.createElement('canvas')
      imageCanvas.width = width
      imageCanvas.height = height
      const imageCtx = imageCanvas.getContext('2d')
      if (!imageCtx) {
        setLocalError('浏览器无法读取图片，请换一张图片重试')
        return
      }
      imageCtx.drawImage(image, 0, 0, width, height)
      imageCanvasRef.current = imageCanvas

      const maskCanvas = document.createElement('canvas')
      maskCanvas.width = width
      maskCanvas.height = height
      const maskCtx = maskCanvas.getContext('2d')
      if (!maskCtx) {
        setLocalError('浏览器无法创建遮罩，请重试')
        return
      }
      const autoMask = makeAutomaticMask(imageCanvas)
      if (autoMask) maskCtx.drawImage(autoMask, 0, 0, width, height)
      else {
        maskCtx.fillStyle = '#fff'
        maskCtx.fillRect(0, 0, width, height)
      }
      maskCanvasRef.current = maskCanvas
      resetCommandTracking(maskCanvas, maskCtx)
      setNaturalSize({ width, height })
      setHistory([])
      setRedoStack([])
      setMaskVersion((value) => value + 1)
    }
    image.onerror = () => {
      if (!cancelled) setLocalError('图片加载失败，请重新打开抠像工具')
    }
    image.src = url
    return () => {
      cancelled = true
      URL.revokeObjectURL(url)
    }
  }, [resetCommandTracking, sourceFile])

  useEffect(() => {
    if (!naturalSize || !automaticMask?.maskDataUrl || automaticMask.status !== 'ready') return
    if (!isAutomaticMaskUsable(automaticMask)) return
    const key = `${automaticMask.modelId || 'BiRefNet'}:${automaticMask.sha1 || automaticMask.maskDataUrl.slice(0, 80)}`
    applyAutomaticMaskDataUrl(automaticMask.maskDataUrl, key)
  }, [applyAutomaticMaskDataUrl, automaticMask, naturalSize])

  useEffect(() => {
    redrawView()
  }, [maskVersion, redrawView])

  const applyCommand = useCallback((command: MattingCommand, snapshot?: ImageData | null) => {
    const maskCanvas = maskCanvasRef.current
    const ctx = maskCanvas?.getContext('2d')
    if (!maskCanvas || !ctx) return
    if (snapshot) ctx.putImageData(snapshot, 0, 0)
    drawCommand(ctx, command, imageCanvasRef.current)
    setMaskVersion((value) => value + 1)
  }, [])

  const applySamCorrection = useCallback(async (params: {
    commandId: string
    intent: PaintIntent
    sourceKind: 'point' | 'box'
    point?: MattingPoint
    box?: { x: number; y: number; width: number; height: number }
    baseSnapshot: MattingHistorySnapshot | null
  }) => {
    const imageSize = naturalSize
    if (!imageSize) return
    const taskVersion = ++correctionVersionRef.current
    pendingCorrectionIdsRef.current.add(params.commandId)
    setCorrectionBusy(true)
    setLocalError(null)
    try {
      const response = await subjectMattingApi.correctMask(projectUuid, nodeKey, sourceUrl, {
        taskVersion,
        intent: params.intent,
        promptType: params.sourceKind,
        point: params.point ? normalizePoint(params.point, imageSize.width, imageSize.height) : undefined,
        box: params.box ? normalizeBox(params.box, imageSize.width, imageSize.height) : undefined,
      })
      if (correctionVersionRef.current !== taskVersion) return
      if (Number(response.taskVersion || taskVersion) !== taskVersion) return
      if (!pendingCorrectionIdsRef.current.has(params.commandId)) return
      const maskCanvas = await dataUrlToMaskCanvas(response.maskDataUrl, imageSize.width, imageSize.height)
      const currentMask = maskCanvasRef.current
      const ctx = currentMask?.getContext('2d')
      if (!currentMask || !ctx) throw new Error('浏览器无法应用 SAM 遮罩')
      if (params.baseSnapshot) {
        applyHistorySnapshot(params.baseSnapshot)
        setHistory((items) => [...items.slice(-24), params.baseSnapshot as MattingHistorySnapshot])
        setRedoStack([])
      }
      const command: MattingCommand = {
        kind: 'sam',
        intent: params.intent,
        sourceKind: params.sourceKind,
        maskCanvas,
        taskVersion,
        point: params.point ? { ...params.point } : undefined,
        box: params.box ? { ...params.box } : undefined,
      }
      drawCommand(ctx, command, imageCanvasRef.current)
      commandLogRef.current = [...commandLogRef.current, { id: params.commandId, command }]
      if (params.sourceKind === 'point' && params.point) {
        const marker = { id: params.commandId, intent: params.intent, point: { ...params.point } }
        const nextMarkers = [...pointMarkersRef.current.filter((item) => item.id !== params.commandId), marker]
        pointMarkersRef.current = nextMarkers
        setPointMarkers(nextMarkers)
      }
      setMaskVersion((value) => value + 1)
    } catch (error) {
      if (params.baseSnapshot) {
        applyHistorySnapshot(params.baseSnapshot)
      }
      const message = error instanceof Error ? error.message : 'SAM 修正失败，请重试'
      setLocalError(message)
      if (params.sourceKind === 'point') {
        const nextMarkers = pointMarkersRef.current.filter((item) => item.id !== params.commandId)
        pointMarkersRef.current = nextMarkers
        setPointMarkers(nextMarkers)
      }
    } finally {
      pendingCorrectionIdsRef.current.delete(params.commandId)
      setCorrectionBusy(false)
    }
  }, [applyHistorySnapshot, naturalSize, nodeKey, projectUuid, sourceUrl])

  const removePointMarker = useCallback((markerId: string) => {
    const maskCanvas = maskCanvasRef.current
    const ctx = maskCanvas?.getContext('2d', { willReadFrequently: true })
    if (!maskCanvas || !ctx) return
    const wasPending = pendingCorrectionIdsRef.current.delete(markerId)
    if (wasPending) {
      correctionVersionRef.current += 1
      setCorrectionBusy(false)
    }
    const current = captureHistorySnapshot()
    if (current) setHistory((items) => [...items.slice(-24), current])
    setRedoStack([])
    const nextCommands = commandLogRef.current.filter((item) => item.id !== markerId)
    commandLogRef.current = nextCommands
    const nextMarkers = pointMarkersRef.current.filter((item) => item.id !== markerId)
    pointMarkersRef.current = nextMarkers
    setPointMarkers(nextMarkers)
    rebuildMaskFromCommands(nextCommands)
  }, [captureHistorySnapshot, rebuildMaskFromCommands])

  const handleStageWheel = useCallback((event: ReactWheelEvent<HTMLElement>) => {
    if (!hasSource) return
    event.preventDefault()
    event.stopPropagation()
    const stageRect = stageRef.current?.getBoundingClientRect()
    const cursorX = stageRect ? event.clientX - (stageRect.left + stageRect.width / 2) : 0
    const cursorY = stageRect ? event.clientY - (stageRect.top + stageRect.height / 2) : 0
    setViewTransform((current) => {
      const zoomFactor = Math.exp(-event.deltaY * 0.0012)
      const nextScale = clamp(current.scale * zoomFactor, MIN_STAGE_ZOOM, MAX_STAGE_ZOOM)
      if (Math.abs(nextScale - current.scale) < 0.001) return current
      const ratio = nextScale / Math.max(0.0001, current.scale)
      return {
        scale: nextScale,
        x: cursorX - (cursorX - current.x) * ratio,
        y: cursorY - (cursorY - current.y) * ratio,
      }
    })
  }, [hasSource])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = viewCanvasRef.current
    const maskCanvas = maskCanvasRef.current
    const ctx = maskCanvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !maskCanvas || !ctx || busy || correctionBusy) return
    event.preventDefault()
    event.stopPropagation()
    if (event.button === 1 || (spacePressedRef.current && event.button === 0)) {
      setBrushCursor(null)
      panDragRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: viewTransform.x,
        startY: viewTransform.y,
      }
      setIsPanning(true)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0) return
    const point = getCanvasPoint(event, canvas)
    if (tool === 'brush' && brushCursorEnabled) {
      setBrushCursor(point)
    }
    const baseSnapshot = captureHistorySnapshot()
    const commandId = nextCommandId()
    if (tool === 'point') {
      maskTouchedRef.current = true
      const marker = { id: commandId, intent, point: { ...point } }
      const nextMarkers = [...pointMarkersRef.current, marker]
      pointMarkersRef.current = nextMarkers
      setPointMarkers(nextMarkers)
      void applySamCorrection({
        commandId,
        intent,
        sourceKind: 'point',
        point,
        baseSnapshot,
      })
      return
    }
    maskTouchedRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    const baseMask = baseSnapshot?.mask ?? ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
    const command: MattingCommand = tool === 'box'
      ? { kind: 'box', intent, x: point.x, y: point.y, width: 1, height: 1 }
      : { kind: 'stroke', intent, size: brushSize, softness: edgeSoftness, points: [point] }
    dragRef.current = { pointerId: event.pointerId, commandId, command, baseMask, baseSnapshot }
    if (command.kind === 'box') {
      setBoxPreview(command)
      return
    }
    applyCommand(command, baseMask)
  }, [applyCommand, applySamCorrection, brushCursorEnabled, brushSize, busy, captureHistorySnapshot, correctionBusy, edgeSoftness, intent, nextCommandId, tool, viewTransform])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const panDrag = panDragRef.current
    if (panDrag && panDrag.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      setBrushCursor(null)
      setViewTransform((current) => ({
        ...current,
        x: panDrag.startX + event.clientX - panDrag.startClientX,
        y: panDrag.startY + event.clientY - panDrag.startClientY,
      }))
      return
    }
    const drag = dragRef.current
    const canvas = viewCanvasRef.current
    if (!canvas) return
    const point = getCanvasPoint(event, canvas)
    if (brushCursorEnabled) {
      setBrushCursor(point)
    }
    if (drag && drag.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.command.kind === 'stroke') {
      drag.command.points = [...drag.command.points, point]
      applyCommand(drag.command, drag.baseMask)
    } else {
      drag.command.width = point.x - drag.command.x
      drag.command.height = point.y - drag.command.y
      setBoxPreview(drag.command)
    }
  }, [applyCommand, brushCursorEnabled])

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const panDrag = panDragRef.current
    if (panDrag && panDrag.pointerId === event.pointerId) {
      event.preventDefault()
      event.stopPropagation()
      panDragRef.current = null
      setIsPanning(false)
      if (!brushCursorEnabled) setBrushCursor(null)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      return
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = null
    setBoxPreview(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.command.kind === 'box') {
      const boxWidth = Math.abs(drag.command.width)
      const boxHeight = Math.abs(drag.command.height)
      if (boxWidth < MIN_BOX_SIZE_PX || boxHeight < MIN_BOX_SIZE_PX) {
        if (!brushCursorEnabled) setBrushCursor(null)
        return
      }
      applyCommand(drag.command, drag.baseMask)
      if (drag.baseSnapshot) {
        setHistory((items) => [...items.slice(-24), drag.baseSnapshot as MattingHistorySnapshot])
        setRedoStack([])
      }
      const command = cloneMattingCommand(drag.command)
      commandLogRef.current = [...commandLogRef.current, { id: drag.commandId, command }]
      if (!brushCursorEnabled) setBrushCursor(null)
      return
    }
    if (drag.baseSnapshot) {
      setHistory((items) => [...items.slice(-24), drag.baseSnapshot as MattingHistorySnapshot])
      setRedoStack([])
    }
    const command = cloneMattingCommand(drag.command)
    commandLogRef.current = [...commandLogRef.current, { id: drag.commandId, command }]
    if (!brushCursorEnabled) setBrushCursor(null)
  }, [brushCursorEnabled])

  const handlePointerLeave = useCallback(() => {
    setBrushCursor(null)
  }, [])

  const resetMask = useCallback(() => {
    const imageCanvas = imageCanvasRef.current
    const maskCanvas = maskCanvasRef.current
    const maskCtx = maskCanvas?.getContext('2d')
    if (!imageCanvas || !maskCanvas || !maskCtx || correctionBusy) return
    rememberMask()
    maskTouchedRef.current = false
    autoMaskAppliedKeyRef.current = null
    if (
      automaticMask?.maskDataUrl
      && automaticMask.status === 'ready'
      && isAutomaticMaskUsable(automaticMask)
    ) {
      const key = `${automaticMask.modelId || 'BiRefNet'}:${automaticMask.sha1 || automaticMask.maskDataUrl.slice(0, 80)}:reset`
      applyAutomaticMaskDataUrl(automaticMask.maskDataUrl, key, true)
      return
    }
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
    const autoMask = makeAutomaticMask(imageCanvas)
    if (autoMask) maskCtx.drawImage(autoMask, 0, 0, maskCanvas.width, maskCanvas.height)
    else {
      maskCtx.fillStyle = '#fff'
      maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
    }
    resetCommandTracking(maskCanvas, maskCtx)
    setMaskVersion((value) => value + 1)
  }, [applyAutomaticMaskDataUrl, automaticMask, correctionBusy, rememberMask, resetCommandTracking])

  const undo = useCallback(() => {
    if (correctionBusy || !history.length) return
    const current = captureHistorySnapshot()
    if (!current) return
    const previous = history[history.length - 1]
    applyHistorySnapshot(previous)
    setHistory((items) => items.slice(0, -1))
    setRedoStack((items) => [...items.slice(-24), current])
  }, [applyHistorySnapshot, captureHistorySnapshot, correctionBusy, history])

  const redo = useCallback(() => {
    if (correctionBusy || !redoStack.length) return
    const current = captureHistorySnapshot()
    if (!current) return
    const next = redoStack[redoStack.length - 1]
    applyHistorySnapshot(next)
    setRedoStack((items) => items.slice(0, -1))
    setHistory((items) => [...items.slice(-24), current])
  }, [applyHistorySnapshot, captureHistorySnapshot, correctionBusy, redoStack])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableKeyTarget(event.target)) return
      if (event.code === 'Space') {
        event.preventDefault()
        spacePressedRef.current = true
        setSpacePanning(true)
        return
      }
      const key = event.key.toLowerCase()
      const mod = event.ctrlKey || event.metaKey
      if (!mod && key === 'b') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setTool('box')
        setIntent(event.shiftKey ? 'exclude' : 'keep')
        return
      }
      if (!mod) return
      if (key === 'z') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (key === 'y') {
        event.preventDefault()
        event.stopImmediatePropagation()
        redo()
      }
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      spacePressedRef.current = false
      setSpacePanning(false)
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 1) return
      if (!stageRef.current?.contains(event.target as Node)) return
      event.preventDefault()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('mousedown', handleMouseDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('mousedown', handleMouseDown, true)
    }
  }, [redo, undo])

  const exportCutout = useCallback(async () => {
    try {
      setLocalError(null)
      const imageCanvas = imageCanvasRef.current
      const maskCanvas = maskCanvasRef.current
      if (!imageCanvas || !maskCanvas || !naturalSize) return
      const width = naturalSize.width
      const height = naturalSize.height
      const resultCanvas = document.createElement('canvas')
      resultCanvas.width = width
      resultCanvas.height = height
      const ctx = resultCanvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('浏览器无法导出抠像结果')
      ctx.drawImage(imageCanvas, 0, 0)
      ctx.globalCompositeOperation = 'destination-in'
      const refinedMask = makeEdgeShiftedMaskCanvas(maskCanvas, edgeShift)
      const outputMask = reverseOutput ? invertMaskAlphaCanvas(refinedMask) : refinedMask
      ctx.drawImage(outputMask, 0, 0)
      ctx.globalCompositeOperation = 'source-over'

      if (removeWhiteEdge || removeBlackEdge || backgroundClean > 0) {
        const imageData = ctx.getImageData(0, 0, width, height)
        const pixels = imageData.data
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3]
          if (alpha > 0 && alpha < 255) {
            const clean = clamp(backgroundClean / 100, 0, 1)
            pixels[i + 3] = clamp(alpha - clean * (255 - alpha) * 0.22, 0, 255)
          }
          if (removeWhiteEdge && pixels[i + 3] > 0) {
            pixels[i] = Math.max(0, pixels[i] - 2)
            pixels[i + 1] = Math.max(0, pixels[i + 1] - 2)
            pixels[i + 2] = Math.max(0, pixels[i + 2] - 2)
          }
          if (removeBlackEdge && pixels[i + 3] > 0) {
            pixels[i] = Math.min(255, pixels[i] + 2)
            pixels[i + 1] = Math.min(255, pixels[i + 1] + 2)
            pixels[i + 2] = Math.min(255, pixels[i + 2] + 2)
          }
        }
        ctx.putImageData(imageData, 0, 0)
      }

      const coverageCtx = outputMask.getContext('2d', { willReadFrequently: true })
      const maskPixels = coverageCtx?.getImageData(0, 0, width, height).data
      let selected = 0
      if (maskPixels) {
        for (let index = 3; index < maskPixels.length; index += 4) {
          if (maskPixels[index] > 16) selected += 1
        }
      }
      const blob = await canvasToBlob(resultCanvas)
      const file = new File([blob], `${stripExtension(displayName)}_主体抠像.png`, {
        type: 'image/png',
        lastModified: Date.now(),
      })
      await onAccept({
        file,
        width,
        height,
        maskCoverage: selected / Math.max(1, width * height),
        settings: {
          tool: 'subject-matting',
          version: 1,
          autoMask: automaticMask?.status === 'ready'
            ? `${automaticMask.modelId}${automaticMask.modelRevision ? `@${automaticMask.modelRevision}` : ''}`
            : 'canvas-border-flood-fill-fallback',
          autoMaskStatus: automaticMask?.status || 'fallback',
          autoMaskWarning: automaticMask?.warning || undefined,
          intendedAutoModel: 'ZhengPeng7/BiRefNet@e2bf8e4',
          intendedCorrectionModel: 'facebook/sam2.1-hiera-large@2.1',
          brushSize,
          edgeSoftness,
          edgeShift,
          backgroundClean,
          removeWhiteEdge,
          removeBlackEdge,
          reverseOutput,
          previewMode,
          inspectMode,
          hideGuides,
        },
      })
    } catch (submitError) {
      setLocalError(submitError instanceof Error ? submitError.message : '抠像生成失败，请重试')
    }
  }, [
    backgroundClean,
    brushSize,
    displayName,
    edgeShift,
    edgeSoftness,
    inspectMode,
    hideGuides,
    naturalSize,
    onAccept,
    previewMode,
    removeBlackEdge,
    removeWhiteEdge,
    reverseOutput,
    automaticMask,
  ])

  const stageStyle = useMemo(() => {
    if (!naturalSize) return undefined
    return {
      aspectRatio: `${naturalSize.width} / ${naturalSize.height}`,
      width: naturalSize.width >= naturalSize.height ? 'min(74vw, 760px)' : 'min(42vw, 520px)',
      maxHeight: 'calc(100vh - 220px)',
      transform: `translate3d(${viewTransform.x}px, ${viewTransform.y}px, 0) scale(${viewTransform.scale})`,
      transformOrigin: 'center center',
    }
  }, [naturalSize, viewTransform])

  const brushCursorStyle = useMemo<CSSProperties | undefined>(() => {
    if (!brushCursor || !naturalSize) return undefined
    const canvas = viewCanvasRef.current
    const canvasWidth = canvas?.offsetWidth || 0
    const canvasHeight = canvas?.offsetHeight || 0
    if (!canvas || canvasWidth <= 0 || canvasHeight <= 0) {
      return {
        left: `${(brushCursor.x / Math.max(1, naturalSize.width)) * 100}%`,
        top: `${(brushCursor.y / Math.max(1, naturalSize.height)) * 100}%`,
        width: `${(brushSize / Math.max(1, naturalSize.width)) * 100}%`,
        height: `${(brushSize / Math.max(1, naturalSize.height)) * 100}%`,
      }
    }

    const imageWidth = canvas.width || naturalSize.width
    const imageHeight = canvas.height || naturalSize.height
    return {
      left: `${canvas.offsetLeft + (brushCursor.x / Math.max(1, imageWidth)) * canvasWidth}px`,
      top: `${canvas.offsetTop + (brushCursor.y / Math.max(1, imageHeight)) * canvasHeight}px`,
      width: `${(brushSize / Math.max(1, imageWidth)) * canvasWidth}px`,
      height: `${(brushSize / Math.max(1, imageHeight)) * canvasHeight}px`,
    }
  }, [brushCursor, brushSize, naturalSize, viewTransform])

  const boxPreviewStyle = useMemo<CSSProperties | undefined>(() => {
    if (!boxPreview || !naturalSize) return undefined
    const left = Math.min(boxPreview.x, boxPreview.x + boxPreview.width)
    const top = Math.min(boxPreview.y, boxPreview.y + boxPreview.height)
    const width = Math.abs(boxPreview.width)
    const height = Math.abs(boxPreview.height)
    return {
      left: `${(left / Math.max(1, naturalSize.width)) * 100}%`,
      top: `${(top / Math.max(1, naturalSize.height)) * 100}%`,
      width: `${(width / Math.max(1, naturalSize.width)) * 100}%`,
      height: `${(height / Math.max(1, naturalSize.height)) * 100}%`,
    }
  }, [boxPreview, naturalSize])

  const brushSizePreviewStyle = useMemo<CSSProperties | undefined>(() => {
    if (!brushSizePreview || !naturalSize) return undefined
    const canvas = viewCanvasRef.current
    const canvasWidth = canvas?.offsetWidth || 0
    const imageWidth = canvas?.width || naturalSize.width
    if (!canvas || canvasWidth <= 0 || imageWidth <= 0) return undefined
    const diameter = (brushSize / imageWidth) * canvasWidth * Math.max(0.0001, viewTransform.scale)
    return {
      left: `${brushSizePreview.clientX}px`,
      top: `${brushSizePreview.clientY}px`,
      width: `${diameter}px`,
      height: `${diameter}px`,
    }
  }, [brushSize, brushSizePreview, naturalSize, viewTransform.scale])

  const showBrushSizePreview = useCallback((event: ReactPointerEvent<HTMLInputElement>) => {
    setBrushSizePreview({ clientX: event.clientX, clientY: event.clientY })
  }, [])

  const moveBrushSizePreview = useCallback((event: ReactPointerEvent<HTMLInputElement>) => {
    if (event.buttons !== 0 || event.currentTarget.hasPointerCapture(event.pointerId)) {
      setBrushSizePreview({ clientX: event.clientX, clientY: event.clientY })
    }
  }, [])

  const hideBrushSizePreview = useCallback(() => {
    setBrushSizePreview(null)
  }, [])

  const toolButtons = [
    { key: 'keep', label: '保留主体', icon: <Plus size={16} />, active: intent === 'keep' && tool === 'point', click: () => { setIntent('keep'); setTool('point') } },
    { key: 'exclude', label: '排除区域', icon: <Minus size={16} />, active: intent === 'exclude' && tool === 'point', click: () => { setIntent('exclude'); setTool('point') } },
    { key: 'box-keep', label: '矩形加选', icon: <SquareDashed size={16} />, active: tool === 'box' && intent === 'keep', click: () => { setTool('box'); setIntent('keep') } },
    { key: 'box-exclude', label: '矩形减选', icon: <SquareDashed size={16} />, active: tool === 'box' && intent === 'exclude', click: () => { setTool('box'); setIntent('exclude') } },
    { key: 'brush', label: '画笔', icon: <Brush size={16} />, active: tool === 'brush' && intent === 'keep', click: () => { setTool('brush'); setIntent('keep') } },
    { key: 'eraser', label: '橡皮擦', icon: <Eraser size={16} />, active: tool === 'brush' && intent === 'exclude', click: () => { setTool('brush'); setIntent('exclude') } },
  ]

  return createPortal(
    <div className="subject-matting-backdrop nodrag" onPointerDown={(event) => event.stopPropagation()}>
      <div className="subject-matting-shell">
        <header className="subject-matting-header">
          <div className="subject-matting-title">
            <div className="subject-matting-title-icon"><ScanLine size={18} /></div>
            <div>
              <h2>快速抠图</h2>
              <p>{displayName}</p>
            </div>
          </div>
          <button type="button" className="subject-matting-close" onClick={onCancel} disabled={busy}>
            <X size={18} />
          </button>
        </header>

        <div className="subject-matting-body">
          <aside className="subject-matting-subjects">
            <div className="subject-matting-subject-pill"><span />主体 1</div>
          </aside>

          <main ref={stageRef} className="subject-matting-stage" onWheel={handleStageWheel}>
            {loadingSource || !hasSource ? (
              <div className="subject-matting-stage-loading">
                <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
                <span>{loadingSource ? '正在载入图片...' : localError || '等待图片载入'}</span>
              </div>
            ) : (
              <>
                <div className="subject-matting-help">点击主体、空格或中键拖动画面，滚轮缩放</div>
                <div className="subject-matting-canvas-wrap" style={stageStyle}>
                  <canvas
                    ref={viewCanvasRef}
                    className={`subject-matting-canvas ${tool === 'brush' && brushCursorEnabled ? 'is-brush' : ''} ${isPanning || spacePanning ? 'is-pan' : ''} ${isPanning ? 'is-panning' : ''}`}
                    style={{ width: '100%', height: '100%' }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onPointerLeave={handlePointerLeave}
                    onAuxClick={(event) => event.preventDefault()}
                  />
                  {boxPreviewStyle && boxPreview && (
                    <div
                      className={`subject-matting-box-preview is-${boxPreview.intent}`}
                      style={boxPreviewStyle}
                      aria-hidden="true"
                    />
                  )}
                  {brushCursorEnabled && brushCursor && (
                    <div
                      className={`subject-matting-brush-cursor is-${intent}`}
                      style={brushCursorStyle}
                      aria-hidden="true"
                    />
                  )}
                  {!hideGuides && naturalSize && pointMarkers.length > 0 && (
                    <div className="subject-matting-point-layer">
                      {pointMarkers.map((marker) => (
                        <button
                          type="button"
                          key={marker.id}
                          className={`subject-matting-point-marker is-${marker.intent}`}
                          style={{
                            left: `${(marker.point.x / Math.max(1, naturalSize.width)) * 100}%`,
                            top: `${(marker.point.y / Math.max(1, naturalSize.height)) * 100}%`,
                            '--marker-scale': `${1 / Math.max(0.0001, viewTransform.scale)}`,
                          } as CSSProperties}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation()
                            removePointMarker(marker.id)
                          }}
                          aria-label={marker.intent === 'keep' ? '取消保留区域' : '取消排除区域'}
                        >
                          {marker.intent === 'keep' ? <Plus size={8} /> : <Minus size={8} />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="subject-matting-view-switch">
                  <button type="button" className={inspectMode === 'overlay' ? 'is-active' : ''} onClick={() => setInspectMode('overlay')}>原图+遮罩</button>
                  <button type="button" className={inspectMode === 'inside' ? 'is-active' : ''} onClick={() => setInspectMode('inside')}>遮罩内</button>
                  <button type="button" className={inspectMode === 'outside' ? 'is-active' : ''} onClick={() => setInspectMode('outside')}>遮罩外</button>
                  <button type="button" className={hideGuides ? 'is-active' : ''} onClick={() => setHideGuides((value) => !value)}>隐藏点</button>
                </div>
              </>
            )}
          </main>

          <aside className="subject-matting-panel">
            <div className="subject-matting-status">
              <span className="subject-matting-status-dot" />
              <span>{loadingSource ? '正在载入图片...' : autoMaskStatusText}</span>
            </div>
            {(error || localError) && <div className="subject-matting-error">{error || localError}</div>}
            <div className="subject-matting-panel-scroll">
              <section className="subject-matting-section">
                <div className="subject-matting-section-title">
                  <span>精修</span>
                  <div className="subject-matting-mini-actions">
                    <button type="button" className="subject-matting-mini-button" title="撤销" onClick={undo} disabled={!history.length}>
                      <Undo2 size={15} />
                    </button>
                    <button type="button" className="subject-matting-mini-button" title="重做" onClick={redo} disabled={!redoStack.length}>
                      <Redo2 size={15} />
                    </button>
                    <button type="button" className="subject-matting-mini-button" title="恢复自动选择" onClick={resetMask}>
                      <RotateCcw size={15} />
                    </button>
                  </div>
                </div>
                <div className="subject-matting-tool-grid">
                  {toolButtons.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`subject-matting-tool-button ${item.active ? 'is-active' : ''}`}
                      onClick={item.click}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
                <div className="subject-matting-slider-row">
                  <span>画笔大小</span>
                  <input
                    type="range"
                    min={8}
                    max={240}
                    value={brushSize}
                    onChange={(event) => setBrushSize(Number(event.target.value))}
                    onPointerDown={showBrushSizePreview}
                    onPointerMove={moveBrushSizePreview}
                    onPointerUp={hideBrushSizePreview}
                    onPointerCancel={hideBrushSizePreview}
                  />
                  <strong>{brushSize}px</strong>
                </div>
                <div className="subject-matting-slider-row">
                  <span>画笔边缘柔化</span>
                  <input type="range" min={0} max={18} value={edgeSoftness} onChange={(event) => setEdgeSoftness(Number(event.target.value))} />
                  <strong>{edgeSoftness}px</strong>
                </div>
              </section>

              <section className="subject-matting-section">
                <div className="subject-matting-section-title"><span>边缘处理</span></div>
                <div className="subject-matting-slider-row">
                  <span>边缘收缩 / 扩张</span>
                  <input type="range" min={-24} max={24} value={edgeShift} onChange={(event) => setEdgeShift(Number(event.target.value))} />
                  <strong>{edgeShift}px</strong>
                </div>
                <div className="subject-matting-slider-row">
                  <span>背景色净化</span>
                  <input type="range" min={0} max={100} value={backgroundClean} onChange={(event) => setBackgroundClean(Number(event.target.value))} />
                  <strong>{backgroundClean}%</strong>
                </div>
                <div className="subject-matting-check-row">
                  <button type="button" className={`subject-matting-chip ${removeWhiteEdge ? 'is-active' : ''}`} onClick={() => setRemoveWhiteEdge((value) => !value)}>去除白边</button>
                  <button type="button" className={`subject-matting-chip ${removeBlackEdge ? 'is-active' : ''}`} onClick={() => setRemoveBlackEdge((value) => !value)}>去除黑边</button>
                  <button type="button" className={`subject-matting-chip ${reverseOutput ? 'is-active' : ''}`} onClick={() => setReverseOutput((value) => !value)}>反选输出</button>
                </div>
              </section>

              <section className="subject-matting-section">
                <div className="subject-matting-section-title"><span>预览背景</span></div>
                <div className="subject-matting-preview-switch">
                  {[
                    ['transparent', '透明'],
                    ['black', '黑'],
                    ['white', '白'],
                    ['mask', 'Mask'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={previewMode === value ? 'is-active' : ''}
                      onClick={() => setPreviewMode(value as PreviewMode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </section>
            </div>
            <div className="subject-matting-actions">
              <button type="button" className="subject-matting-cancel" onClick={onCancel} disabled={busy}>取消</button>
              <button type="button" className="subject-matting-submit" onClick={() => void exportCutout()} disabled={busy || !hasSource}>
                {busy ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle' }} /> : <Check size={15} style={{ verticalAlign: 'middle' }} />}
                {' '}生成抠像节点
              </button>
            </div>
          </aside>
        </div>
      </div>
      {brushSizePreviewStyle && (
        <div
          className={`subject-matting-brush-size-preview is-${intent}`}
          style={brushSizePreviewStyle}
          aria-hidden="true"
        >
          <span>{brushSize}px</span>
        </div>
      )}
    </div>,
    document.body,
  )
}
