import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RotateCcw, Sparkles, X } from 'lucide-react'
import type { CSSProperties } from 'react'

type LightDirection = 'left' | 'top' | 'right' | 'front' | 'bottom' | 'back'
type LightViewMode = 'perspective' | 'front'

interface LightingSettings {
  viewMode: LightViewMode
  smartMode: boolean
  brightness: number
  color: string
  direction: LightDirection
  rim: boolean
}

export interface ImageLightingAcceptPayload {
  dataUrl: string
  settings: LightingSettings
}

interface ImageLightingModalProps {
  sourceUrl: string
  sourceName?: string
  onCancel: () => void
  onAccept: (payload: ImageLightingAcceptPayload) => Promise<void> | void
  busy?: boolean
}

const DEFAULT_SETTINGS: LightingSettings = {
  viewMode: 'perspective',
  smartMode: true,
  brightness: 50,
  color: '#ffffff',
  direction: 'front',
  rim: false,
}

const DIRECTION_OPTIONS: Array<{ value: LightDirection; label: string }> = [
  { value: 'left', label: '左侧' },
  { value: 'top', label: '顶部' },
  { value: 'right', label: '右侧' },
  { value: 'front', label: '前方' },
  { value: 'bottom', label: '底部' },
  { value: 'back', label: '后方' },
]

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = url
  })
}

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '')
  const value = clean.length === 3
    ? clean.split('').map(c => `${c}${c}`).join('')
    : clean.padEnd(6, 'f').slice(0, 6)
  const num = Number.parseInt(value, 16)
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  }
}

function rgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`
}

function drawLight(ctx: CanvasRenderingContext2D, width: number, height: number, settings: LightingSettings) {
  const strength = Math.max(0, Math.min(100, settings.brightness)) / 100
  const lightAlpha = strength * (settings.smartMode ? 0.56 : 0.44)
  const shadowAlpha = settings.smartMode ? strength * 0.18 : strength * 0.1

  ctx.save()
  ctx.globalCompositeOperation = 'screen'

  let light: CanvasGradient
  if (settings.direction === 'front') {
    light = ctx.createRadialGradient(width * 0.5, height * 0.46, 0, width * 0.5, height * 0.46, Math.max(width, height) * 0.72)
  } else if (settings.direction === 'back') {
    light = ctx.createRadialGradient(width * 0.5, height * 1.08, 0, width * 0.5, height * 0.5, Math.max(width, height) * 0.92)
  } else if (settings.direction === 'left') {
    light = ctx.createLinearGradient(0, height * 0.5, width, height * 0.5)
  } else if (settings.direction === 'right') {
    light = ctx.createLinearGradient(width, height * 0.5, 0, height * 0.5)
  } else if (settings.direction === 'top') {
    light = ctx.createLinearGradient(width * 0.5, 0, width * 0.5, height)
  } else {
    light = ctx.createLinearGradient(width * 0.5, height, width * 0.5, 0)
  }

  light.addColorStop(0, rgba(settings.color, lightAlpha))
  light.addColorStop(0.38, rgba(settings.color, lightAlpha * 0.28))
  light.addColorStop(1, rgba(settings.color, 0))
  ctx.fillStyle = light
  ctx.fillRect(0, 0, width, height)
  ctx.restore()

  if (shadowAlpha > 0) {
    ctx.save()
    ctx.globalCompositeOperation = 'multiply'
    let shadow: CanvasGradient
    if (settings.direction === 'left') {
      shadow = ctx.createLinearGradient(width, 0, 0, 0)
    } else if (settings.direction === 'right') {
      shadow = ctx.createLinearGradient(0, 0, width, 0)
    } else if (settings.direction === 'top') {
      shadow = ctx.createLinearGradient(0, height, 0, 0)
    } else if (settings.direction === 'bottom') {
      shadow = ctx.createLinearGradient(0, 0, 0, height)
    } else {
      shadow = ctx.createRadialGradient(width * 0.5, height * 0.5, Math.min(width, height) * 0.25, width * 0.5, height * 0.5, Math.max(width, height) * 0.75)
    }
    shadow.addColorStop(0, `rgba(12, 10, 24, ${shadowAlpha})`)
    shadow.addColorStop(1, 'rgba(12, 10, 24, 0)')
    ctx.fillStyle = shadow
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
  }

  if (settings.rim) {
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    ctx.strokeStyle = rgba(settings.color, 0.78)
    ctx.lineWidth = Math.max(3, Math.round(Math.min(width, height) * 0.012))
    ctx.shadowColor = rgba(settings.color, 0.68)
    ctx.shadowBlur = Math.max(12, Math.round(Math.min(width, height) * 0.03))
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth)
    ctx.restore()
  }
}

function renderLighting(canvas: HTMLCanvasElement, img: HTMLImageElement, settings: LightingSettings, maxSize?: number) {
  const naturalWidth = img.naturalWidth || img.width
  const naturalHeight = img.naturalHeight || img.height
  const scale = maxSize ? Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight)) : 1
  const width = Math.max(1, Math.round(naturalWidth * scale))
  const height = Math.max(1, Math.round(naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建图片画布')

  canvas.width = width
  canvas.height = height
  const baseBrightness = 1 + (settings.brightness - 50) / 180
  const contrast = settings.smartMode ? 1.04 : 1
  ctx.clearRect(0, 0, width, height)
  ctx.filter = `brightness(${Math.round(baseBrightness * 100)}%) contrast(${Math.round(contrast * 100)}%)`
  ctx.drawImage(img, 0, 0, width, height)
  ctx.filter = 'none'
  drawLight(ctx, width, height, settings)
}

export function ImageLightingModal({ sourceUrl, sourceName, onCancel, onAccept, busy = false }: ImageLightingModalProps) {
  const [settings, setSettings] = useState<LightingSettings>(DEFAULT_SETTINGS)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renderTick, setRenderTick] = useState(0)
  const previewRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    loadImage(sourceUrl)
      .then(img => {
        if (!cancelled) setImage(img)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : '图片加载失败')
      })
    return () => { cancelled = true }
  }, [sourceUrl])

  useEffect(() => {
    if (!image || !previewRef.current) return
    try {
      renderLighting(previewRef.current, image, settings, 720)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '灯光预览失败')
    }
  }, [image, settings, renderTick])

  const updateSetting = useCallback(<K extends keyof LightingSettings,>(key: K, value: LightingSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }, [])

  const apply = useCallback(async () => {
    if (!image || busy) return
    try {
      const canvas = document.createElement('canvas')
      renderLighting(canvas, image, settings)
      await onAccept({ dataUrl: canvas.toDataURL('image/png'), settings })
    } catch (err) {
      setError(err instanceof Error ? err.message : '灯光应用失败')
    }
  }, [busy, image, onAccept, settings])

  const sphereStyle = useMemo<CSSProperties>(() => {
    const x = {
      left: '18%',
      right: '82%',
      top: '50%',
      bottom: '50%',
      front: '50%',
      back: '50%',
    }[settings.direction]
    const y = {
      left: '58%',
      right: '58%',
      top: '20%',
      bottom: '86%',
      front: '48%',
      back: '80%',
    }[settings.direction]
    return {
      background: `radial-gradient(circle at ${x} ${y}, ${rgba(settings.color, 0.9)} 0, ${rgba(settings.color, 0.38)} 18%, rgba(255,255,255,0.06) 46%, rgba(255,255,255,0.02) 72%)`,
    }
  }, [settings.color, settings.direction])

  return createPortal(
    <div
      className="nodrag"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(0,0,0,0.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        style={{
          width: 720,
          maxWidth: 'calc(100vw - 32px)',
          background: '#222124',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.58)',
          color: '#f4f1ff',
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Sparkles size={16} />
            <span style={{ fontSize: 15, fontWeight: 800 }}>灯光效果</span>
            {sourceName && <span style={{ color: '#8b8794', fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sourceName}</span>}
          </div>
          <button aria-label="关闭" onClick={onCancel} style={{ background: 'none', border: 'none', color: '#aaa4b6', cursor: 'pointer', padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 290px', gap: 16, padding: 16 }}>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'inline-flex', width: 220, padding: 4, borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', background: '#1b1a1e' }}>
              {(['perspective', 'front'] as LightViewMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => updateSetting('viewMode', mode)}
                  style={{
                    flex: 1,
                    height: 34,
                    border: 'none',
                    borderRadius: 9,
                    background: settings.viewMode === mode ? '#343237' : 'transparent',
                    color: settings.viewMode === mode ? '#fff' : '#9a94a7',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  {mode === 'perspective' ? '透视' : '正面'}
                </button>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: 14 }}>
              <div style={{ height: 210, borderRadius: 10, background: '#1b1a1e', position: 'relative', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
                <div style={{ width: 150, height: 150, borderRadius: '50%', position: 'relative', boxShadow: 'inset 0 0 42px rgba(255,255,255,0.08)', ...sphereStyle }}>
                  <div style={{ position: 'absolute', inset: 36, transform: settings.viewMode === 'perspective' ? 'skewY(12deg) rotateY(18deg)' : 'none', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 4, overflow: 'hidden' }}>
                    <img src={sourceUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </div>
                </div>
              </div>
              <div style={{ minHeight: 210, borderRadius: 10, background: '#17151d', border: '1px solid rgba(255,255,255,0.06)', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
                {image ? (
                  <canvas ref={previewRef} style={{ maxWidth: '100%', maxHeight: 210, display: 'block' }} />
                ) : (
                  <span style={{ color: '#827993', fontSize: 13 }}>正在加载图片...</span>
                )}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>全局</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#91899f', fontSize: 12 }}>
                智能模式
                <input
                  type="checkbox"
                  checked={settings.smartMode}
                  onChange={event => updateSetting('smartMode', event.target.checked)}
                />
              </label>
            </div>

            <label style={{ display: 'grid', gridTemplateColumns: '54px 1fr 58px', gap: 10, alignItems: 'center', color: '#bdb5cd', fontSize: 13 }}>
              亮度
              <input
                type="range"
                min={0}
                max={100}
                value={settings.brightness}
                onChange={event => updateSetting('brightness', Number(event.target.value))}
              />
              <span style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '6px 0', textAlign: 'center', color: '#8f879d' }}>{settings.brightness}%</span>
            </label>

            <label style={{ display: 'grid', gridTemplateColumns: '54px 1fr', gap: 10, alignItems: 'center', color: '#bdb5cd', fontSize: 13 }}>
              颜色
              <input
                type="color"
                value={settings.color}
                onChange={event => updateSetting('color', event.target.value)}
                style={{ width: 52, height: 28, border: '1px solid rgba(255,255,255,0.22)', borderRadius: 5, background: 'transparent' }}
              />
            </label>

            <div style={{ display: 'grid', gap: 8 }}>
              <span style={{ color: '#bdb5cd', fontSize: 13 }}>主光源</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {DIRECTION_OPTIONS.map(option => (
                  <button
                    key={option.value}
                    onClick={() => updateSetting('direction', option.value)}
                    style={{
                      height: 34,
                      borderRadius: 8,
                      border: `1px solid ${settings.direction === option.value ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.08)'}`,
                      background: settings.direction === option.value ? '#48464f' : '#252329',
                      color: settings.direction === option.value ? '#fff' : '#a59daf',
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#bdb5cd', fontSize: 13 }}>
              轮廓光
              <input type="checkbox" checked={settings.rim} onChange={event => updateSetting('rim', event.target.checked)} />
            </label>
          </div>
        </div>

        {error && <div style={{ margin: '0 16px 12px', color: '#ff7b7b', background: 'rgba(128,0,32,0.18)', borderRadius: 8, padding: '9px 12px', fontSize: 13 }}>{error}</div>}

        <div style={{ height: 56, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px' }}>
          <button
            onClick={() => {
              setSettings(DEFAULT_SETTINGS)
              setRenderTick(t => t + 1)
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', color: '#9a94a7', cursor: 'pointer', fontWeight: 700 }}
          >
            <RotateCcw size={15} />
            重置参数
          </button>
          <button
            disabled={!image || busy}
            onClick={apply}
            style={{
              minWidth: 92,
              height: 38,
              borderRadius: 10,
              border: 'none',
              background: !image || busy ? '#4a4653' : '#f3f0ff',
              color: '#17141f',
              fontWeight: 900,
              cursor: !image || busy ? 'default' : 'pointer',
            }}
          >
            {busy ? '应用中...' : '应用'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
