import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Cropper, { type ReactCropperElement } from 'react-cropper'
import type CropperJs from 'cropperjs'
import 'cropperjs/dist/cropper.css'
import './ImageCropModal.css'
import {
  Check,
  FlipHorizontal2,
  FlipVertical2,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  Undo2,
  X,
} from 'lucide-react'
import {
  CROP_OUTPUT_SCALE_OPTIONS,
  cropOutputScaleLabel,
  cropOutputSize,
  cropperCanvasOptions,
  type CropOutputScale,
} from '@/lib/cropOutputScale'

type AspectKey = 'free' | 'original' | '1:1' | '4:3' | '3:4' | '16:9' | '9:16'

interface CropSnapshot {
  data: CropperJs.Data
  canvasData: CropperJs.CanvasData
  cropBoxData: CropperJs.CropBoxData
  zoom: number
  rotation: number
  flipHorizontal: boolean
  flipVertical: boolean
  aspectKey: AspectKey
}

export interface ImageCropAcceptPayload {
  file: File
  width: number
  height: number
  crop: CropperJs.Data
  aspect: AspectKey
  rotation: number
  flipHorizontal: boolean
  flipVertical: boolean
  outputScale: CropOutputScale
}

interface ImageCropModalProps {
  sourceName: string
  sourceFile?: File | null
  sourceUrl?: string
  onCancel: () => void
  onAccept: (payload: ImageCropAcceptPayload) => Promise<void> | void
}

const ASPECT_OPTIONS: Array<{ key: AspectKey; label: string; value?: number }> = [
  { key: 'free', label: '自由' },
  { key: 'original', label: '原图' },
  { key: '1:1', label: '1:1', value: 1 },
  { key: '4:3', label: '4:3', value: 4 / 3 },
  { key: '3:4', label: '3:4', value: 3 / 4 },
  { key: '16:9', label: '16:9', value: 16 / 9 },
  { key: '9:16', label: '9:16', value: 9 / 16 },
]

function outputTypeForSource(sourceType: string) {
  if (sourceType === 'image/jpeg' || sourceType === 'image/webp' || sourceType === 'image/png') {
    return sourceType
  }
  return 'image/png'
}

function outputName(sourceName: string, mimeType: string) {
  const clean = sourceName.replace(/\.[^.]+$/, '').trim() || 'image'
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  return `${clean}_裁剪.${extension}`
}

function mimeTypeFromUrl(url?: string) {
  const clean = String(url || '').split('?')[0]?.toLowerCase() ?? ''
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg'
  if (clean.endsWith('.webp')) return 'image/webp'
  if (clean.endsWith('.png')) return 'image/png'
  return 'image/png'
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('裁剪结果导出失败'))),
      mimeType,
      quality,
    )
  })
}

function aspectValueFor(
  aspectKey: AspectKey,
  naturalWidth: number,
  naturalHeight: number,
) {
  if (aspectKey === 'free') return Number.NaN
  if (aspectKey === 'original') {
    return naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : 1
  }
  return ASPECT_OPTIONS.find((option) => option.key === aspectKey)?.value ?? 1
}

function rounded(value: number) {
  return Math.round(value * 1000) / 1000
}

function snapshotKey(snapshot: CropSnapshot) {
  const { data, canvasData, cropBoxData } = snapshot
  return JSON.stringify({
    data: {
      x: rounded(data.x),
      y: rounded(data.y),
      width: rounded(data.width),
      height: rounded(data.height),
      rotate: rounded(data.rotate),
      scaleX: rounded(data.scaleX),
      scaleY: rounded(data.scaleY),
    },
    canvas: {
      left: rounded(canvasData.left),
      top: rounded(canvasData.top),
      width: rounded(canvasData.width),
      height: rounded(canvasData.height),
    },
    cropBox: {
      left: rounded(cropBoxData.left),
      top: rounded(cropBoxData.top),
      width: rounded(cropBoxData.width),
      height: rounded(cropBoxData.height),
    },
    zoom: rounded(snapshot.zoom),
    rotation: snapshot.rotation,
    flipHorizontal: snapshot.flipHorizontal,
    flipVertical: snapshot.flipVertical,
    aspectKey: snapshot.aspectKey,
  })
}

function ToolButton({
  title,
  disabled,
  active,
  onClick,
  children,
}: {
  title: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 34,
        height: 34,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 8,
        border: active ? '1px solid rgba(185,169,255,.52)' : '1px solid rgba(255,255,255,.09)',
        color: disabled ? '#5d566d' : active ? '#fff' : '#c8c0dc',
        background: active ? 'rgba(125,92,252,.2)' : 'rgba(255,255,255,.035)',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}

export function ImageCropModal({
  sourceName,
  sourceFile,
  sourceUrl: sourceUrlProp,
  onCancel,
  onAccept,
}: ImageCropModalProps) {
  const cropperRef = useRef<ReactCropperElement>(null)
  const baseScaleRef = useRef(1)
  const suppressEventsRef = useRef(false)
  const zoomCommitTimerRef = useRef<number | null>(null)
  const sourceRevokeTimerRef = useRef<number | null>(null)
  const historyRef = useRef<CropSnapshot[]>([])
  const historyIndexRef = useRef(-1)

  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [flipHorizontal, setFlipHorizontal] = useState(false)
  const [flipVertical, setFlipVertical] = useState(false)
  const [aspectKey, setAspectKey] = useState<AspectKey>('original')
  const [outputScale, setOutputScale] = useState<CropOutputScale>('original')
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
  const [cropData, setCropData] = useState<CropperJs.Data | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<CropSnapshot[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const objectUrl = useMemo(() => sourceFile ? URL.createObjectURL(sourceFile) : null, [sourceFile])
  const sourceUrl = objectUrl ?? sourceUrlProp ?? ''
  const sourceMimeType = outputTypeForSource(sourceFile?.type || mimeTypeFromUrl(sourceUrlProp))
  const sourceFileName = sourceFile?.name || sourceName
  const previewOutputSize = cropData
    ? cropOutputSize(cropData.width, cropData.height, outputScale)
    : null

  const getCropper = useCallback(() => cropperRef.current?.cropper ?? null, [])

  const captureSnapshot = useCallback((): CropSnapshot | null => {
    const cropper = getCropper()
    if (!cropper) return null
    return {
      data: cropper.getData(false),
      canvasData: cropper.getCanvasData(),
      cropBoxData: cropper.getCropBoxData(),
      zoom,
      rotation,
      flipHorizontal,
      flipVertical,
      aspectKey,
    }
  }, [aspectKey, flipHorizontal, flipVertical, getCropper, rotation, zoom])

  const commitSnapshot = useCallback((snapshot?: CropSnapshot | null) => {
    if (suppressEventsRef.current) return
    const nextSnapshot = snapshot ?? captureSnapshot()
    if (!nextSnapshot) return
    const base = historyRef.current.slice(0, historyIndexRef.current + 1)
    if (base.length > 0 && snapshotKey(base[base.length - 1]) === snapshotKey(nextSnapshot)) return
    const next = [...base, nextSnapshot].slice(-40)
    historyRef.current = next
    historyIndexRef.current = next.length - 1
    setHistory(next)
    setHistoryIndex(next.length - 1)
  }, [captureSnapshot])

  const syncCropData = useCallback(() => {
    const cropper = getCropper()
    if (!cropper) return
    setCropData(cropper.getData(true))
  }, [getCropper])

  const applySnapshot = useCallback((snapshot: CropSnapshot) => {
    const cropper = getCropper()
    if (!cropper) return
    suppressEventsRef.current = true
    setZoom(snapshot.zoom)
    setRotation(snapshot.rotation)
    setFlipHorizontal(snapshot.flipHorizontal)
    setFlipVertical(snapshot.flipVertical)
    setAspectKey(snapshot.aspectKey)
    cropper.setAspectRatio(aspectValueFor(
      snapshot.aspectKey,
      naturalSize.width,
      naturalSize.height,
    ))
    cropper.setData(snapshot.data)
    cropper.setCanvasData(snapshot.canvasData)
    cropper.setCropBoxData(snapshot.cropBoxData)
    window.requestAnimationFrame(() => {
      cropper.setCanvasData(snapshot.canvasData)
      cropper.setCropBoxData(snapshot.cropBoxData)
      syncCropData()
      window.requestAnimationFrame(() => {
        suppressEventsRef.current = false
      })
    })
  }, [getCropper, naturalSize.height, naturalSize.width, syncCropData])

  useEffect(() => {
    if (sourceRevokeTimerRef.current !== null) {
      window.clearTimeout(sourceRevokeTimerRef.current)
      sourceRevokeTimerRef.current = null
    }
    return () => {
      if (objectUrl) {
        sourceRevokeTimerRef.current = window.setTimeout(() => {
          URL.revokeObjectURL(objectUrl)
        }, 0)
      }
      if (zoomCommitTimerRef.current !== null) window.clearTimeout(zoomCommitTimerRef.current)
    }
  }, [objectUrl])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) {
        event.preventDefault()
        onCancel()
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() === 'z' && !event.shiftKey && historyIndexRef.current > 0) {
        event.preventDefault()
        const nextIndex = historyIndexRef.current - 1
        historyIndexRef.current = nextIndex
        setHistoryIndex(nextIndex)
        applySnapshot(historyRef.current[nextIndex])
      } else if (
        (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))
        && historyIndexRef.current < historyRef.current.length - 1
      ) {
        event.preventDefault()
        const nextIndex = historyIndexRef.current + 1
        historyIndexRef.current = nextIndex
        setHistoryIndex(nextIndex)
        applySnapshot(historyRef.current[nextIndex])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [applySnapshot, isSaving, onCancel])

  const handleReady = useCallback(() => {
    const cropper = getCropper()
    if (!cropper) return
    const imageData = cropper.getImageData()
    const width = imageData.naturalWidth
    const height = imageData.naturalHeight
    setNaturalSize({ width, height })
    cropper.setAspectRatio(aspectValueFor('original', width, height))
    window.requestAnimationFrame(() => {
      cropper.setData({
        x: 0,
        y: 0,
        width,
        height,
        rotate: 0,
        scaleX: 1,
        scaleY: 1,
      })
      window.requestAnimationFrame(() => {
        const fittedImageData = cropper.getImageData()
        baseScaleRef.current = fittedImageData.naturalWidth > 0
          ? fittedImageData.width / fittedImageData.naturalWidth
          : 1
        setIsReady(true)
        syncCropData()
        const initialSnapshot: CropSnapshot = {
          data: cropper.getData(false),
          canvasData: cropper.getCanvasData(),
          cropBoxData: cropper.getCropBoxData(),
          zoom: 1,
          rotation: 0,
          flipHorizontal: false,
          flipVertical: false,
          aspectKey: 'original',
        }
        historyRef.current = [initialSnapshot]
        historyIndexRef.current = 0
        setHistory([initialSnapshot])
        setHistoryIndex(0)
      })
    })
  }, [getCropper, syncCropData])

  const scheduleZoomCommit = useCallback(() => {
    if (zoomCommitTimerRef.current !== null) window.clearTimeout(zoomCommitTimerRef.current)
    zoomCommitTimerRef.current = window.setTimeout(() => {
      zoomCommitTimerRef.current = null
      commitSnapshot()
    }, 220)
  }, [commitSnapshot])

  const handleZoom = useCallback((event: CropperJs.ZoomEvent<HTMLImageElement>) => {
    if (baseScaleRef.current > 0) {
      setZoom(Math.max(1, Math.min(5, event.detail.ratio / baseScaleRef.current)))
    }
    if (!suppressEventsRef.current) scheduleZoomCommit()
  }, [scheduleZoomCommit])

  const selectAspect = useCallback((nextAspectKey: AspectKey) => {
    const cropper = getCropper()
    if (!cropper) return
    const currentCropBox = cropper.getCropBoxData()
    setAspectKey(nextAspectKey)
    cropper.setAspectRatio(aspectValueFor(
      nextAspectKey,
      naturalSize.width,
      naturalSize.height,
    ))
    window.requestAnimationFrame(() => {
      if (nextAspectKey === 'original') {
        cropper.setData({
          x: 0,
          y: 0,
          width: naturalSize.width,
          height: naturalSize.height,
          rotate: rotation,
          scaleX: flipHorizontal ? -1 : 1,
          scaleY: flipVertical ? -1 : 1,
        })
      } else if (nextAspectKey === 'free') {
        cropper.setCropBoxData(currentCropBox)
      }
      syncCropData()
      const snapshot = captureSnapshot()
      if (snapshot) commitSnapshot({ ...snapshot, aspectKey: nextAspectKey })
    })
  }, [
    captureSnapshot,
    commitSnapshot,
    flipHorizontal,
    flipVertical,
    getCropper,
    naturalSize.height,
    naturalSize.width,
    rotation,
    syncCropData,
  ])

  const rotateTo = useCallback((nextRotation: number) => {
    const cropper = getCropper()
    if (!cropper) return
    setRotation(nextRotation)
    cropper.rotateTo(nextRotation)
    window.requestAnimationFrame(() => {
      syncCropData()
      const snapshot = captureSnapshot()
      if (snapshot) commitSnapshot({ ...snapshot, rotation: nextRotation })
    })
  }, [captureSnapshot, commitSnapshot, getCropper, syncCropData])

  const setFlip = useCallback((axis: 'horizontal' | 'vertical') => {
    const cropper = getCropper()
    if (!cropper) return
    if (axis === 'horizontal') {
      const next = !flipHorizontal
      setFlipHorizontal(next)
      cropper.scaleX(next ? -1 : 1)
      window.requestAnimationFrame(() => {
        const snapshot = captureSnapshot()
        if (snapshot) commitSnapshot({ ...snapshot, flipHorizontal: next })
      })
    } else {
      const next = !flipVertical
      setFlipVertical(next)
      cropper.scaleY(next ? -1 : 1)
      window.requestAnimationFrame(() => {
        const snapshot = captureSnapshot()
        if (snapshot) commitSnapshot({ ...snapshot, flipVertical: next })
      })
    }
  }, [captureSnapshot, commitSnapshot, flipHorizontal, flipVertical, getCropper])

  const reset = useCallback(() => {
    const cropper = getCropper()
    if (!cropper) return
    setZoom(1)
    setRotation(0)
    setFlipHorizontal(false)
    setFlipVertical(false)
    setAspectKey('original')
    cropper.reset()
    window.requestAnimationFrame(() => {
      const imageData = cropper.getImageData()
      baseScaleRef.current = imageData.naturalWidth > 0
        ? imageData.width / imageData.naturalWidth
        : 1
      cropper.setAspectRatio(aspectValueFor('original', naturalSize.width, naturalSize.height))
      window.requestAnimationFrame(() => {
        syncCropData()
        const snapshot = captureSnapshot()
        if (snapshot) commitSnapshot({
          ...snapshot,
          zoom: 1,
          rotation: 0,
          flipHorizontal: false,
          flipVertical: false,
          aspectKey: 'original',
        })
      })
    })
  }, [captureSnapshot, commitSnapshot, getCropper, naturalSize.height, naturalSize.width, syncCropData])

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) return
    const nextIndex = historyIndexRef.current - 1
    historyIndexRef.current = nextIndex
    setHistoryIndex(nextIndex)
    applySnapshot(historyRef.current[nextIndex])
  }, [applySnapshot])

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    const nextIndex = historyIndexRef.current + 1
    historyIndexRef.current = nextIndex
    setHistoryIndex(nextIndex)
    applySnapshot(historyRef.current[nextIndex])
  }, [applySnapshot])

  const handleSave = useCallback(async () => {
    const cropper = getCropper()
    if (!cropper || !isReady || isSaving) return
    setError(null)
    setIsSaving(true)
    try {
      const mimeType = sourceMimeType
      const data = cropper.getData(true)
      const outputSize = cropOutputSize(data.width, data.height, outputScale)
      const canvas = cropper.getCroppedCanvas(cropperCanvasOptions(outputSize, mimeType))
      if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
        throw new Error('裁剪区域无效，请重新调整裁剪框')
      }
      const blob = await canvasToBlob(canvas, mimeType, mimeType === 'image/png' ? undefined : 0.95)
      await onAccept({
        file: new File([blob], outputName(sourceFileName, mimeType), {
          type: mimeType,
          lastModified: Date.now(),
        }),
        width: canvas.width,
        height: canvas.height,
        crop: data,
        aspect: aspectKey,
        rotation,
        flipHorizontal,
        flipVertical,
        outputScale,
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '裁剪保存失败')
      setIsSaving(false)
    }
  }, [
    aspectKey,
    flipHorizontal,
    flipVertical,
    getCropper,
    isReady,
    isSaving,
    onAccept,
    outputScale,
    rotation,
    sourceFileName,
    sourceMimeType,
  ])

  return createPortal(
    <div
      className="nodrag nowheel"
      data-block-canvas-pan="1"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 250000,
        padding: 24,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(2,2,6,.84)',
        backdropFilter: 'blur(14px)',
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <section
        style={{
          width: 'min(1180px, calc(100vw - 48px))',
          height: 'min(760px, calc(100vh - 48px))',
          display: 'grid',
          gridTemplateRows: '58px minmax(0, 1fr) 78px',
          overflow: 'hidden',
          color: '#f5f2ff',
          background: 'linear-gradient(180deg, #17131f 0%, #100d16 100%)',
          border: '1px solid rgba(201,188,255,.2)',
          borderRadius: 12,
          boxShadow: '0 32px 90px rgba(0,0,0,.62), inset 0 1px rgba(255,255,255,.05)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '0 16px',
            borderBottom: '1px solid rgba(255,255,255,.075)',
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 8,
              color: '#d8ceff',
              background: 'rgba(124,92,252,.16)',
              border: '1px solid rgba(174,151,255,.24)',
            }}
          >
            <Scissors size={16} strokeWidth={1.8} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>裁剪图片</div>
            <div style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#827991', fontSize: 11 }}>
              {sourceName}
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onCancel}
            disabled={isSaving}
            style={{
              width: 32,
              height: 32,
              marginLeft: 'auto',
              display: 'grid',
              placeItems: 'center',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,.09)',
              color: '#aaa2b8',
              background: 'rgba(255,255,255,.035)',
              cursor: isSaving ? 'default' : 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 250px', minHeight: 0 }}>
          <div
            className="shotflow-image-cropper"
            style={{ position: 'relative', minWidth: 0, overflow: 'hidden', background: '#050507' }}
          >
            <Cropper
              ref={cropperRef}
              src={sourceUrl}
              alt={sourceName}
              style={{ width: '100%', height: '100%' }}
              viewMode={1}
              dragMode="move"
              autoCropArea={1}
              responsive
              restore={false}
              guides
              center
              highlight={false}
              background={false}
              movable
              rotatable
              scalable
              zoomable
              zoomOnTouch
              zoomOnWheel
              wheelZoomRatio={0.08}
              cropBoxMovable
              cropBoxResizable
              toggleDragModeOnDblclick={false}
              minCropBoxWidth={48}
              minCropBoxHeight={48}
              ready={handleReady}
              crop={() => syncCropData()}
              cropend={() => commitSnapshot()}
              zoom={handleZoom}
              checkOrientation={false}
            />
            <div
              style={{
                position: 'absolute',
                left: 14,
                bottom: 12,
                padding: '5px 8px',
                borderRadius: 6,
                color: '#b9b1c9',
                background: 'rgba(9,7,13,.76)',
                border: '1px solid rgba(255,255,255,.08)',
                fontSize: 11,
                pointerEvents: 'none',
                zIndex: 2,
              }}
            >
              拖动图片或裁剪框 · 四边四角调整范围 · 滚轮缩放
            </div>
          </div>

          <aside
            style={{
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              borderLeft: '1px solid rgba(255,255,255,.075)',
              background: 'rgba(255,255,255,.018)',
            }}
          >
            <div>
              <div style={{ marginBottom: 8, color: '#91889f', fontSize: 11 }}>画幅比例</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {ASPECT_OPTIONS.map((option) => {
                  const active = option.key === aspectKey
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => selectAspect(option.key)}
                      style={{
                        height: 32,
                        borderRadius: 7,
                        border: active ? '1px solid rgba(180,160,255,.58)' : '1px solid rgba(255,255,255,.08)',
                        color: active ? '#fff' : '#aaa1bb',
                        background: active ? 'rgba(124,92,252,.22)' : 'rgba(255,255,255,.025)',
                        cursor: 'pointer',
                        fontSize: 11,
                      }}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <div style={{ marginBottom: 8, color: '#91889f', fontSize: 11 }}>等比放大</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {CROP_OUTPUT_SCALE_OPTIONS.map((option) => {
                  const active = option.key === outputScale
                  return (
                    <button
                      key={option.key}
                      type="button"
                      title={option.key === 'original' ? '按裁剪框原始像素导出' : `长边放到 ${option.longEdge}px，比例不变`}
                      onClick={() => setOutputScale(option.key)}
                      style={{
                        height: 32,
                        borderRadius: 7,
                        border: active ? '1px solid rgba(180,160,255,.58)' : '1px solid rgba(255,255,255,.08)',
                        color: active ? '#fff' : '#aaa1bb',
                        background: active ? 'rgba(124,92,252,.22)' : 'rgba(255,255,255,.025)',
                        cursor: 'pointer',
                        fontSize: 11,
                      }}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
              <div style={{ marginTop: 6, color: '#6f677c', fontSize: 10, lineHeight: 1.45 }}>
                {outputScale === 'original'
                  ? '按当前裁剪框像素导出'
                  : `${cropOutputScaleLabel(outputScale)}：长边 ${outputScale === '2k' ? 2048 : 4096}px，宽高同比缩放`}
              </div>
            </div>

            <div>
              <div style={{ marginBottom: 8, color: '#91889f', fontSize: 11 }}>变换</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <ToolButton title="向左旋转 90°" onClick={() => rotateTo((rotation - 90 + 360) % 360)}>
                  <RotateCcw size={15} />
                </ToolButton>
                <ToolButton title="向右旋转 90°" onClick={() => rotateTo((rotation + 90) % 360)}>
                  <RotateCw size={15} />
                </ToolButton>
                <ToolButton title="水平翻转" active={flipHorizontal} onClick={() => setFlip('horizontal')}>
                  <FlipHorizontal2 size={15} />
                </ToolButton>
                <ToolButton title="垂直翻转" active={flipVertical} onClick={() => setFlip('vertical')}>
                  <FlipVertical2 size={15} />
                </ToolButton>
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, color: '#91889f', fontSize: 11 }}>
                <span>缩放</span>
                <span style={{ color: '#cbc3da' }}>{Math.round(zoom * 100)}%</span>
              </div>
              <input
                type="range"
                min={1}
                max={5}
                step={0.01}
                value={zoom}
                onChange={(event) => {
                  const nextZoom = Number(event.target.value)
                  setZoom(nextZoom)
                  getCropper()?.zoomTo(baseScaleRef.current * nextZoom)
                }}
                onPointerUp={() => commitSnapshot()}
                style={{ width: '100%', accentColor: '#9476ff' }}
              />
            </div>

            <div
              style={{
                padding: 10,
                display: 'grid',
                gap: 6,
                borderRadius: 8,
                background: 'rgba(255,255,255,.025)',
                border: '1px solid rgba(255,255,255,.07)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#7f768d', fontSize: 11 }}>
                <span>原始尺寸</span>
                <span style={{ color: '#bfb6cd' }}>
                  {naturalSize.width > 0 ? `${naturalSize.width} × ${naturalSize.height}` : '读取中'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#7f768d', fontSize: 11 }}>
                <span>输出尺寸</span>
                <span style={{ color: '#eee9f7', fontWeight: 600 }}>
                  {previewOutputSize
                    ? `${previewOutputSize.width} × ${previewOutputSize.height}`
                    : '计算中'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#7f768d', fontSize: 11 }}>
                <span>旋转</span>
                <span style={{ color: '#bfb6cd' }}>{rotation}°</span>
              </div>
            </div>

            <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <ToolButton title="撤销 Ctrl+Z" disabled={historyIndex <= 0} onClick={undo}>
                <Undo2 size={15} />
              </ToolButton>
              <ToolButton title="重做 Ctrl+Shift+Z" disabled={historyIndex >= history.length - 1} onClick={redo}>
                <Redo2 size={15} />
              </ToolButton>
              <button
                type="button"
                onClick={reset}
                style={{
                  height: 34,
                  marginLeft: 2,
                  padding: '0 10px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,.09)',
                  color: '#aaa1b8',
                  background: 'rgba(255,255,255,.03)',
                  cursor: 'pointer',
                  fontSize: 11,
                }}
              >
                重置
              </button>
            </div>
          </aside>
        </div>

        <footer
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 16px',
            borderTop: '1px solid rgba(255,255,255,.075)',
            background: 'rgba(7,5,10,.52)',
          }}
        >
          <div style={{ minWidth: 0, color: error ? '#fb7185' : '#766e82', fontSize: 11 }}>
            {error || '保存后会在原图下游创建新的图片节点，不会覆盖原图。'}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSaving}
            style={{
              height: 36,
              minWidth: 78,
              marginLeft: 'auto',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,.09)',
              color: '#b8b0c6',
              background: 'rgba(255,255,255,.035)',
              cursor: isSaving ? 'default' : 'pointer',
            }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!isReady || !cropData || isSaving}
            style={{
              height: 36,
              minWidth: 112,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              borderRadius: 8,
              border: '1px solid rgba(222,213,255,.32)',
              color: '#100c18',
              background: 'linear-gradient(135deg, #b49cff, #f1e9ff)',
              boxShadow: '0 8px 22px rgba(133,103,235,.22)',
              cursor: !isReady || !cropData || isSaving ? 'default' : 'pointer',
              opacity: !isReady || !cropData || isSaving ? 0.55 : 1,
              fontWeight: 700,
            }}
          >
            {isSaving ? <span style={{ fontSize: 12 }}>保存中...</span> : <><Check size={15} />完成裁剪</>}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
