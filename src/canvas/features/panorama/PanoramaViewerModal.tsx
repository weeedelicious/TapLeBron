import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Grid3X3, Image, Info, Loader2, Minus, Plus, RotateCcw, X } from 'lucide-react'
import {
  DEFAULT_PANORAMA_EXPOSURE,
  DEFAULT_PANORAMA_VIEW,
  PanoramaViewport,
  clampPanoramaExposure,
  normalizePanoramaView,
  type PanoramaCaptureResult,
  type PanoramaView,
  type PanoramaViewportHandle,
} from './PanoramaViewport'
import {
  DEFAULT_PANORAMA_CAPTURE_RATIO,
  DEFAULT_PANORAMA_CAPTURE_RESOLUTION,
  PANORAMA_CAPTURE_RATIO_OPTIONS,
  PANORAMA_CAPTURE_RESOLUTION_OPTIONS,
  panoramaCaptureDimensions,
  panoramaCaptureFileName,
  type PanoramaCaptureRatio,
  type PanoramaCaptureResolution,
} from './panorama-capture'
import './panorama-viewer.css'

interface PanoramaViewerModalProps {
  url: string
  name?: string
  sourceWidth?: number
  sourceHeight?: number
  initialView?: PanoramaView
  initialExposure?: number
  onViewChange?: (view: PanoramaView) => void
  onExposureChange?: (exposure: number) => void
  onCapture?: (result: PanoramaCaptureResult & {
    file: File
    ratio: PanoramaCaptureRatio
    resolution: PanoramaCaptureResolution
  }) => void | Promise<void>
  onClose: () => void
}

function nextExposure(current: number, delta: number) {
  return clampPanoramaExposure(Math.round((current + delta) * 100) / 100)
}

export function PanoramaViewerModal({
  url,
  name = 'HDR全景',
  sourceWidth,
  sourceHeight,
  initialView = DEFAULT_PANORAMA_VIEW,
  initialExposure = DEFAULT_PANORAMA_EXPOSURE,
  onViewChange,
  onExposureChange,
  onCapture,
  onClose,
}: PanoramaViewerModalProps) {
  const shellRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<PanoramaViewportHandle>(null)
  const [view, setView] = useState<PanoramaView>(normalizePanoramaView(initialView))
  const [exposure, setExposure] = useState(clampPanoramaExposure(initialExposure))
  const [flat, setFlat] = useState(false)
  const [grid, setGrid] = useState(false)
  const [showInfo, setShowInfo] = useState(true)
  const [ratio, setRatio] = useState<PanoramaCaptureRatio>(DEFAULT_PANORAMA_CAPTURE_RATIO)
  const [resolution, setResolution] = useState<PanoramaCaptureResolution>(DEFAULT_PANORAMA_CAPTURE_RESOLUTION)
  const [capturing, setCapturing] = useState(false)
  const [captureMessage, setCaptureMessage] = useState('')
  const [fullscreen, setFullscreen] = useState(false)

  const updateView = useCallback((next: PanoramaView) => {
    setView(next)
    onViewChange?.(next)
  }, [onViewChange])

  const updateExposure = useCallback((next: number) => {
    const normalized = clampPanoramaExposure(next)
    setExposure(normalized)
    onExposureChange?.(normalized)
  }, [onExposureChange])

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === shellRef.current)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.fullscreenElement) onClose()
      if (event.key === 'ArrowLeft') updateView({ ...view, yaw: view.yaw - (event.shiftKey ? 5 : 1) })
      if (event.key === 'ArrowRight') updateView({ ...view, yaw: view.yaw + (event.shiftKey ? 5 : 1) })
      if (event.key === 'ArrowUp') updateView({ ...view, pitch: view.pitch + (event.shiftKey ? 5 : 1) })
      if (event.key === 'ArrowDown') updateView({ ...view, pitch: view.pitch - (event.shiftKey ? 5 : 1) })
      if (event.key === '+' || event.key === '=') updateView({ ...view, fov: view.fov - 2 })
      if (event.key === '-' || event.key === '_') updateView({ ...view, fov: view.fov + 2 })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose, updateView, view])

  const download = useCallback(() => {
    const anchor = document.createElement('a')
    anchor.href = url
    const extMatch = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)
    const ext = extMatch ? extMatch[1] : 'jpg'
    anchor.download = `${name || 'HDR全景'}.${ext}`
    anchor.click()
  }, [name, url])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === shellRef.current) await document.exitFullscreen()
      else if (shellRef.current?.requestFullscreen) await shellRef.current.requestFullscreen()
      else throw new Error('当前浏览器不支持查看器全屏')
    } catch (error) {
      setCaptureMessage(error instanceof Error ? error.message : '切换全屏失败')
    }
  }, [])

  const capture = useCallback(async () => {
    if (capturing) return
    if (flat) {
      setCaptureMessage('请先进入 720°球面查看再截取机位')
      return
    }
    const viewport = viewportRef.current
    if (!viewport?.ready()) {
      setCaptureMessage('全景纹理尚未加载完成')
      return
    }
    setCapturing(true)
    setCaptureMessage('')
    try {
      const dimensions = panoramaCaptureDimensions(ratio, resolution, sourceWidth, sourceHeight)
      const result = await viewport.capture(dimensions)
      const file = new File([
        result.blob,
      ], panoramaCaptureFileName(name, result.view.yaw, result.view.pitch, ratio, resolution), {
        type: 'image/png',
        lastModified: Date.now(),
      })
      if (onCapture) {
        await onCapture({ ...result, file, ratio, resolution })
        setCaptureMessage(`机位截图已保存 · ${result.width} × ${result.height}`)
      } else {
        const objectUrl = URL.createObjectURL(file)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = file.name
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
        setCaptureMessage(`机位截图已下载 · ${result.width} × ${result.height}`)
      }
    } catch (error) {
      setCaptureMessage(error instanceof Error ? error.message : '机位截图失败')
    } finally {
      setCapturing(false)
    }
  }, [capturing, flat, name, onCapture, ratio, resolution, sourceHeight, sourceWidth])

  return createPortal(
    <div className="panorama-viewer-backdrop nodrag" role="dialog" aria-modal="true" aria-label="HDR 360度全景预览">
      <div ref={shellRef} className="panorama-viewer-shell">
        <header className="panorama-viewer-header">
          <div>
            <strong>HDR · 360°×180°全景</strong>
            <span>{name}</span>
          </div>
          {showInfo && (
            <div className="panorama-viewer-readout">
              <b>YAW {Math.round(view.yaw)}°</b>
              <b>PITCH {Math.round(view.pitch)}°</b>
              <b>FOV {Math.round(view.fov)}°</b>
            </div>
          )}
          <div className="panorama-viewer-actions">
            <button type="button" className={grid ? 'is-active' : ''} onClick={() => setGrid((current) => !current)} disabled={flat} title="参考网格"><Grid3X3 size={16} /></button>
            <button type="button" className={showInfo ? 'is-active' : ''} onClick={() => setShowInfo((current) => !current)} title="机位信息"><Info size={16} /></button>
            <span className="panorama-viewer-exposure">
              <button type="button" onClick={() => updateExposure(nextExposure(exposure, -0.1))} title="降低显示亮度"><Minus size={14} /></button>
              <b>{Math.round(exposure * 100)}%</b>
              <button type="button" onClick={() => updateExposure(nextExposure(exposure, 0.1))} title="提高显示亮度"><Plus size={14} /></button>
            </span>
            <button type="button" onClick={download} title="下载2:1全景原图"><Download size={16} /></button>
            <button type="button" onClick={onClose} title="关闭"><X size={18} /></button>
          </div>
        </header>
        <PanoramaViewport
          ref={viewportRef}
          url={url}
          view={view}
          exposure={exposure}
          flat={flat}
          grid={grid}
          onViewChange={updateView}
          help="拖拽环视 · 滚轮缩放 · 方向键微调 · ESC 关闭"
        />
        <div className="panorama-viewer-capture-bar nodrag">
          <button type="button" onClick={() => setFlat((current) => !current)}>{flat ? '进入720°查看' : '查看平铺图'}</button>
          <button type="button" onClick={() => updateView(normalizePanoramaView(DEFAULT_PANORAMA_VIEW))}><RotateCcw size={14} />回到中心</button>
          <select value={ratio} onChange={(event) => setRatio(event.target.value as PanoramaCaptureRatio)} aria-label="截屏画幅">
            {PANORAMA_CAPTURE_RATIO_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select value={resolution} onChange={(event) => setResolution(event.target.value as PanoramaCaptureResolution)} aria-label="截屏清晰度">
            {PANORAMA_CAPTURE_RESOLUTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button type="button" className="is-primary" onClick={capture} disabled={flat || capturing}>
            {capturing && <Loader2 size={14} className="is-spinning" />}
            {capturing ? '正在截取' : '截取机位'}
          </button>
          <button type="button" onClick={toggleFullscreen}>{fullscreen ? '退出全屏' : '全屏'}</button>
        </div>
        {captureMessage && <div className="panorama-viewer-capture-message">{captureMessage}</div>}
      </div>
    </div>,
    document.body,
  )
}
