import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, Eye, EyeOff, Loader2, RotateCcw, SlidersHorizontal, X } from 'lucide-react'

export type VideoColorGradeProfile =
  | 'rec709'
  | 'arri-logc3'
  | 'arri-logc4'
  | 'sony-slog3'
  | 'panasonic-vlog'
  | 'canon-log2'
  | 'canon-log3'
  | 'red-log3g10'

export type VideoColorGradeLook =
  | 'motion-picture'
  | 'daylight-50d'
  | 'tungsten-200t'
  | 'daylight-250d'
  | 'tungsten-500t'
  | 'kodak-portra-400'
  | 'kodak-ektachrome-100d'
  | 'kodak-2383-print'
  | 'fuji-eterna-250d'
  | 'fuji-eterna-500t'
  | 'fuji-velvia-50'
  | 'low-contrast'
  | 'black-and-white'

export type VideoColorGradeParams = {
  inputProfile: VideoColorGradeProfile
  look: VideoColorGradeLook
  exposure: number
  temperature: number
  tint: number
  contrast: number
  saturation: number
  lift: number
  gamma: number
  gain: number
  grain: number
}

const DEFAULT_PARAMS: VideoColorGradeParams = {
  inputProfile: 'rec709',
  look: 'motion-picture',
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 1,
  saturation: 1,
  lift: 0,
  gamma: 1,
  gain: 1,
  grain: 0.12,
}

const PROFILES: Array<{ value: VideoColorGradeProfile; label: string }> = [
  { value: 'rec709', label: 'Rec.709 常规视频' },
  { value: 'arri-logc3', label: 'ARRI LogC3 阿莱日志' },
  { value: 'arri-logc4', label: 'ARRI LogC4 阿莱新日志' },
  { value: 'sony-slog3', label: 'Sony S-Log3 索尼日志' },
  { value: 'panasonic-vlog', label: 'Panasonic V-Log 松下日志' },
  { value: 'canon-log2', label: 'Canon Log2 佳能日志' },
  { value: 'canon-log3', label: 'Canon Log3 佳能日志' },
  { value: 'red-log3g10', label: 'RED Log3G10 红相机日志' },
]

const LOOK_GROUPS: Array<{ family: string; items: Array<{ value: VideoColorGradeLook; label: string; tone: string }> }> = [
  { family: 'BASE 基础', items: [
    { value: 'motion-picture', label: 'Motion Picture 电影底', tone: 'Neutral 中性' },
  ] },
  { family: 'KODAK VISION3 柯达负片', items: [
    { value: 'daylight-50d', label: 'Vision3 50D 日光', tone: '干净日光' },
    { value: 'tungsten-200t', label: 'Vision3 200T 钨丝', tone: '暖钨丝灯' },
    { value: 'daylight-250d', label: 'Vision3 250D 日光', tone: '柔和日光' },
    { value: 'tungsten-500t', label: 'Vision3 500T 钨丝', tone: '夜戏钨丝' },
  ] },
  { family: 'KODAK CLASSIC 柯达经典', items: [
    { value: 'kodak-portra-400', label: 'Portra 400 人像', tone: '暖肤 · 柔和过渡' },
    { value: 'kodak-ektachrome-100d', label: 'Ektachrome 100D 反转', tone: '冷净反转片' },
    { value: 'kodak-2383-print', label: '2383 Print 放映', tone: '电影拷贝反差' },
  ] },
  { family: 'FUJIFILM 富士', items: [
    { value: 'fuji-eterna-250d', label: 'Eterna 250D 日光', tone: '柔和青日光' },
    { value: 'fuji-eterna-500t', label: 'Eterna 500T 钨丝', tone: '冷灰钨丝' },
    { value: 'fuji-velvia-50', label: 'Velvia 50 风光', tone: '浓郁反转片' },
  ] },
  { family: 'CREATIVE 创意', items: [
    { value: 'low-contrast', label: 'Low Contrast 低反差', tone: '柔和宽容度' },
    { value: 'black-and-white', label: 'B&W 黑白', tone: '单色' },
  ] },
]

const LOOKS = LOOK_GROUPS.flatMap((group) => group.items)

const LOOK_PREVIEW: Record<VideoColorGradeLook, { brightness: number; contrast: number; saturate: number; sepia: number; hue: number; grayscale: number }> = {
  'motion-picture': { brightness: 1, contrast: 1.08, saturate: 0.96, sepia: 0.08, hue: 2, grayscale: 0 },
  'daylight-50d': { brightness: 1.06, contrast: 1.14, saturate: 1.04, sepia: 0.02, hue: -8, grayscale: 0 },
  'tungsten-200t': { brightness: 1.02, contrast: 1.1, saturate: 1.05, sepia: 0.22, hue: 8, grayscale: 0 },
  'daylight-250d': { brightness: 1.04, contrast: 1.02, saturate: 0.98, sepia: 0.1, hue: 4, grayscale: 0 },
  'tungsten-500t': { brightness: 0.92, contrast: 1.16, saturate: 0.94, sepia: 0.28, hue: 12, grayscale: 0 },
  'kodak-portra-400': { brightness: 1.05, contrast: 0.96, saturate: 1.08, sepia: 0.18, hue: 6, grayscale: 0 },
  'kodak-ektachrome-100d': { brightness: 1.08, contrast: 1.18, saturate: 1.16, sepia: 0.04, hue: -14, grayscale: 0 },
  'kodak-2383-print': { brightness: 0.98, contrast: 1.28, saturate: 1.12, sepia: 0.14, hue: 5, grayscale: 0 },
  'fuji-eterna-250d': { brightness: 1.03, contrast: 0.94, saturate: 0.92, sepia: 0.06, hue: -18, grayscale: 0 },
  'fuji-eterna-500t': { brightness: 0.94, contrast: 1.04, saturate: 0.82, sepia: 0.08, hue: -10, grayscale: 0 },
  'fuji-velvia-50': { brightness: 1.04, contrast: 1.22, saturate: 1.45, sepia: 0.05, hue: -4, grayscale: 0 },
  'low-contrast': { brightness: 1.08, contrast: 0.78, saturate: 0.9, sepia: 0.04, hue: 0, grayscale: 0 },
  'black-and-white': { brightness: 1.02, contrast: 1.18, saturate: 0, sepia: 0.08, hue: 0, grayscale: 1 },
}

const PROFILE_PREVIEW: Record<VideoColorGradeProfile, { contrast: number; saturate: number }> = {
  rec709: { contrast: 1, saturate: 1 },
  'arri-logc3': { contrast: 0.82, saturate: 0.88 },
  'arri-logc4': { contrast: 0.8, saturate: 0.86 },
  'sony-slog3': { contrast: 0.81, saturate: 0.9 },
  'panasonic-vlog': { contrast: 0.83, saturate: 0.9 },
  'canon-log2': { contrast: 0.78, saturate: 0.87 },
  'canon-log3': { contrast: 0.84, saturate: 0.9 },
  'red-log3g10': { contrast: 0.8, saturate: 0.88 },
}


const CONTROLS: Array<{
  key: Exclude<keyof VideoColorGradeParams, 'inputProfile' | 'look'>
  label: string
  min: number
  max: number
  step: number
}> = [
  { key: 'exposure', label: 'Exposure 曝光', min: -4, max: 4, step: 0.05 },
  { key: 'temperature', label: 'Temperature 色温', min: -100, max: 100, step: 1 },
  { key: 'tint', label: 'Tint 色调', min: -100, max: 100, step: 1 },
  { key: 'contrast', label: 'Contrast 对比', min: 0.5, max: 1.5, step: 0.01 },
  { key: 'saturation', label: 'Saturation 饱和', min: 0, max: 2, step: 0.01 },
  { key: 'lift', label: 'Lift 暗部', min: -0.2, max: 0.2, step: 0.005 },
  { key: 'gamma', label: 'Gamma 中间调', min: 0.5, max: 2, step: 0.01 },
  { key: 'gain', label: 'Gain 亮部', min: 0.5, max: 2, step: 0.01 },
  { key: 'grain', label: 'Film Grain 胶片颗粒', min: 0, max: 1, step: 0.01 },
]

const panelStyle: CSSProperties = {
  width: 'min(1180px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: 20,
  border: '1px solid #34383f',
  background: '#111315',
  boxShadow: '0 30px 100px rgba(0,0,0,0.68)',
}

function formatValue(value: number, step: number) {
  if (step >= 1) return Math.round(value).toString()
  return value.toFixed(step < 0.01 ? 3 : 2).replace(/\.00$/, '')
}

export function VideoColorGradeModal({
  url,
  name,
  onCancel,
  onConfirm,
}: {
  url: string
  name: string
  onCancel: () => void
  onConfirm: (params: VideoColorGradeParams) => Promise<void> | void
}) {
  const [params, setParams] = useState<VideoColorGradeParams>(DEFAULT_PARAMS)
  const [showOriginal, setShowOriginal] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, submitting])

  const previewFilter = useMemo(() => {
    if (showOriginal) return 'none'
    const look = LOOK_PREVIEW[params.look] || LOOK_PREVIEW['motion-picture']
    const profile = PROFILE_PREVIEW[params.inputProfile] || PROFILE_PREVIEW.rec709
    const exposure = Math.pow(2, params.exposure)
    const brightness = Math.max(0.35, Math.min(1.8, look.brightness * exposure * params.gain + params.lift * 0.85))
    const contrast = Math.max(0.35, look.contrast * profile.contrast * params.contrast)
    const saturate = look.grayscale >= 1 ? 0 : Math.max(0, look.saturate * profile.saturate * params.saturation)
    const warmth = params.temperature / 100
    const sepia = Math.max(0, Math.min(0.55, look.sepia + Math.max(0, warmth) * 0.22))
    const hue = look.hue + params.tint * 0.18 - Math.min(0, warmth) * 10
    const grayscale = look.grayscale
    return [
      grayscale ? 'grayscale(1)' : '',
      'brightness(' + brightness.toFixed(3) + ')',
      'contrast(' + contrast.toFixed(3) + ')',
      'saturate(' + saturate.toFixed(3) + ')',
      'sepia(' + sepia.toFixed(3) + ')',
      'hue-rotate(' + hue.toFixed(1) + 'deg)',
    ].filter(Boolean).join(' ')
  }, [params, showOriginal])

  const update = useCallback(<K extends keyof VideoColorGradeParams>(key: K, value: VideoColorGradeParams[K]) => {
    setParams((current) => ({ ...current, [key]: value }))
  }, [])

  const submit = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onConfirm(params)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '影视校色任务创建失败')
      setSubmitting(false)
    }
  }, [onConfirm, params, submitting])

  return createPortal(
    <div
      className="nodrag"
      style={{ position: 'fixed', inset: 0, zIndex: 2147483646, display: 'grid', placeItems: 'center', padding: 16, background: 'rgba(0,0,0,0.76)' }}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onCancel() }}
    >
      <section className="nodrag" style={panelStyle} onMouseDown={(event) => event.stopPropagation()}>
        <header style={{ height: 64, padding: '0 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #2a2d31' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: '#f5f5f4', fontSize: 16, fontWeight: 750 }}><SlidersHorizontal size={18} />影视校色</div>
            <div title={name} style={{ marginTop: 3, maxWidth: 620, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#8b9098', fontSize: 11 }}>{name || '视频'} · OpenColorIO 2 + FFmpeg</div>
          </div>
          <button type="button" aria-label="关闭" disabled={submitting} onClick={onCancel} style={{ width: 34, height: 34, border: 0, borderRadius: 9, display: 'grid', placeItems: 'center', color: '#afb3b8', background: '#202327', cursor: submitting ? 'default' : 'pointer' }}><X size={17} /></button>
        </header>

        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1.65fr) minmax(280px, 0.9fr)', overflow: 'hidden' }}>
          <div style={{ minWidth: 0, padding: 18, display: 'flex', flexDirection: 'column', background: '#090a0b' }}>
            <div style={{ position: 'relative', flex: 1, minHeight: 180, display: 'grid', placeItems: 'center', overflow: 'hidden', borderRadius: 12, border: '1px solid #292c30', background: '#000' }}>
              <video src={url} controls loop playsInline preload="metadata" style={{ display: 'block', maxWidth: '100%', maxHeight: 'calc(100vh - 245px)', filter: previewFilter, transition: 'filter 120ms ease' }} />
              <div style={{ position: 'absolute', left: 12, top: 12, padding: '5px 9px', borderRadius: 7, color: '#f4f4f3', background: 'rgba(10,11,12,.72)', fontSize: 10, letterSpacing: '.08em' }}>{showOriginal ? 'ORIGINAL 原片' : 'PREVIEW 预览'}</div>
            </div>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ color: '#7f858d', fontSize: 11 }}>即时预览为近似效果，最终画面以 OCIO 33³ LUT 渲染为准。</div>
              <button type="button" disabled={submitting} onMouseDown={() => setShowOriginal(true)} onMouseUp={() => setShowOriginal(false)} onMouseLeave={() => setShowOriginal(false)} onTouchStart={() => setShowOriginal(true)} onTouchEnd={() => setShowOriginal(false)} style={{ height: 34, padding: '0 12px', borderRadius: 9, border: '1px solid #3b3f45', background: showOriginal ? '#e9e9e6' : '#202327', color: showOriginal ? '#111' : '#d7d9dc', display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>{showOriginal ? <EyeOff size={14} /> : <Eye size={14} />}按住查看原片</button>
            </div>
          </div>

          <aside style={{ minWidth: 0, minHeight: 0, overflowY: 'scroll', overscrollBehavior: 'contain', padding: 16, borderLeft: '1px solid #2a2d31', background: '#151719', scrollbarGutter: 'stable' }}>
            <label style={{ display: 'grid', gap: 7, color: '#c7cacf', fontSize: 11, fontWeight: 700 }}>
              CAMERA PROFILE 机型色彩
              <select value={params.inputProfile} disabled={submitting} onChange={(event) => update('inputProfile', event.target.value as VideoColorGradeProfile)} style={{ width: '100%', height: 38, padding: '0 10px', borderRadius: 8, border: '1px solid #393d42', background: '#0f1113', color: '#eee', outline: 'none' }}>
                {PROFILES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>

            <div style={{ marginTop: 18, color: '#c7cacf', fontSize: 11, fontWeight: 700 }}>FILM LOOK 胶片风格</div>
            {LOOK_GROUPS.map((group) => (
              <div key={group.family} style={{ marginTop: 10 }}>
                <div style={{ marginBottom: 6, color: '#6f757c', fontSize: 9, fontWeight: 750, letterSpacing: '.1em' }}>{group.family}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 7 }}>
                  {group.items.map((item) => {
                    const selected = params.look === item.value
                    return <button key={item.value} type="button" disabled={submitting} onClick={() => update('look', item.value)} style={{ minHeight: 52, padding: '8px 9px', borderRadius: 8, border: selected ? '1px solid #e6e2d5' : '1px solid #34383d', background: selected ? '#e6e2d5' : '#202327', color: selected ? '#111' : '#e5e6e7', textAlign: 'left', cursor: 'pointer' }}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, fontSize: 12, fontWeight: 750 }}>{item.label}{selected && <Check size={13} />}</span>
                      <span style={{ display: 'block', marginTop: 3, color: selected ? '#555' : '#838991', fontSize: 9 }}>{item.tone}</span>
                    </button>
                  })}
                </div>
              </div>
            ))}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}>
              <span style={{ color: '#c7cacf', fontSize: 11, fontWeight: 700 }}>PRIMARY CORRECTION 基础校正</span>
              <button type="button" disabled={submitting} onClick={() => setParams((current) => ({ ...DEFAULT_PARAMS, inputProfile: current.inputProfile, look: current.look }))} style={{ border: 0, padding: 3, color: '#888e95', background: 'transparent', cursor: 'pointer' }} title="重置参数"><RotateCcw size={14} /></button>
            </div>
            <div style={{ display: 'grid', gap: 11, marginTop: 9 }}>
              {CONTROLS.map((control) => {
                const value = params[control.key]
                const defaultValue = DEFAULT_PARAMS[control.key]
                return <div key={control.key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: '#aeb2b7', fontSize: 10 }}>
                    <span>{control.label}</span>
                    <button type="button" disabled={submitting} onDoubleClick={() => update(control.key, defaultValue)} onClick={() => update(control.key, defaultValue)} title="点击复位" style={{ minWidth: 44, border: 0, padding: 0, color: Math.abs(value - defaultValue) < control.step / 2 ? '#747a81' : '#efefeb', background: 'transparent', textAlign: 'right', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>{formatValue(value, control.step)}</button>
                  </div>
                  <input type="range" min={control.min} max={control.max} step={control.step} value={value} disabled={submitting} onChange={(event) => update(control.key, Number(event.target.value))} style={{ width: '100%', accentColor: '#dcd8cd' }} />
                </div>
              })}
            </div>

            {error && <div style={{ marginTop: 12, padding: '9px 10px', borderRadius: 8, color: '#ffc3c3', background: 'rgba(127,29,29,.38)', fontSize: 11 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, paddingBottom: 2 }}>
              <button type="button" disabled={submitting} onClick={onCancel} style={{ height: 40, padding: '0 14px', borderRadius: 9, border: '1px solid #393d42', background: '#202327', color: '#c5c8cc', cursor: 'pointer' }}>取消</button>
              <button type="button" disabled={submitting} onClick={() => void submit()} style={{ flex: 1, height: 40, border: 0, borderRadius: 9, background: submitting ? '#55585b' : '#efeee9', color: '#111', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, cursor: submitting ? 'wait' : 'pointer', fontWeight: 750 }}>{submitting ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={16} />}{submitting ? '正在创建任务' : '开始校色'}</button>
            </div>
          </aside>
        </div>
      </section>
    </div>,
    document.body,
  )
}
