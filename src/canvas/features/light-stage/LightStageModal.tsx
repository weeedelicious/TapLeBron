import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2, RotateCcw, Sun, X } from 'lucide-react'
import { lightStageApi } from '@/lib/api'
import { colorTemperatureEstimate, hexToSrgb, LIGHT_STAGE_ANCHOR_DEFINITIONS } from './lightMath'
import { lightStagePlaneLayout } from './light-stage-layout'
import { compileLightStagePrompt } from './prompt'
import { LightStageThreePreview } from './LightStageThreePreview'
import { LightStageMaskPreview } from './LightStageMaskPreview'
import {
  DEFAULT_LIGHT_STAGE_STATE,
  LIGHT_STAGE_RATIO_OPTIONS,
  LIGHT_STAGE_RESOLUTION_OPTIONS,
  geometryUrlsFromState,
  normalizeHexColor,
  readLightStageState,
  type LightStageAnchor,
  type LightStageAovMode,
  type LightStageGeometryAssets,
  type LightStageLightConfig,
  type LightStageState,
  type LightStageViewMode,
} from './types'
import './light-stage.css'

// Kept here for the node adapters that already import this public payload.
export interface LightStageAcceptPayload {
  state: LightStageState
  prompt: string
  ratio: string
  resolution: string
  geometryUrls: ReturnType<typeof geometryUrlsFromState>
}

interface LightStageModalProps {
  sourceUrl: string
  sourceName?: string
  sourceNodeId?: string
  projectUuid?: string
  anchorRect?: DOMRect | null
  initialState?: LightStageState
  initialRatio?: string
  initialResolution?: string
  busy?: boolean
  onCancel: () => void
  onAccept: (payload: LightStageAcceptPayload) => void | Promise<void>
}

type LightTab = 'main' | 'fill' | 'ambient'
type LightStageSnapshot = {
  state: LightStageState
  ratio: string
}
type LightStageStateUpdate = LightStageState | ((current: LightStageState) => LightStageState)

const LIGHT_STAGE_HISTORY_LIMIT = 80

const LIGHT_TYPE_LABELS: Record<LightStageLightConfig['type'], string> = {
  directional: '方向',
  spot: '聚光',
  area: '面积',
  point: '点光',
}

const AOV_ITEMS: Array<{ key: LightStageAovMode; label: string }> = [
  { key: 'diffuse', label: 'Diffuse 去光照' },
  { key: 'normal', label: 'Normal' },
  { key: 'depth', label: 'Depth' },
  { key: 'mask', label: '灯光范围' },
]

const CARDINAL_ANCHORS = LIGHT_STAGE_ANCHOR_DEFINITIONS.filter((anchor) => anchor.group === 'cardinal')
const ANCHOR_GROUPS = [
  { key: 'upper', label: '上方斜角' },
  { key: 'middle', label: '水平斜角' },
  { key: 'lower', label: '下方斜角' },
] as const

function clampUiNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function resolveLightStageStateUpdate(update: LightStageStateUpdate, current: LightStageState) {
  return typeof update === 'function'
    ? (update as (current: LightStageState) => LightStageState)(current)
    : update
}

function sameLightStageSnapshot(a: LightStageSnapshot, b: LightStageSnapshot) {
  return a.ratio === b.ratio && JSON.stringify(a.state) === JSON.stringify(b.state)
}

function isTextEditingKeyTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.isContentEditable) return true
  const tagName = element.tagName.toLowerCase()
  if (tagName === 'textarea') return true
  if (tagName !== 'input') return false
  const input = element as HTMLInputElement
  return ['email', 'number', 'password', 'search', 'tel', 'text', 'url'].includes(input.type)
}

function geometryImage(geometry: LightStageGeometryAssets | undefined, key: LightStageAovMode, sourceUrl: string) {
  if (key === 'diffuse') return geometry?.diffuseUrl || sourceUrl
  if (key === 'normal') return geometry?.normalUrl
  if (key === 'depth') return geometry?.depthUrl
  return geometry?.maskUrl
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="light-stage-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span aria-hidden="true" />
      <b>{label}</b>
    </label>
  )
}

function SliderRow({
  label,
  value,
  min = 0,
  max = 100,
  original,
  suffix = '%',
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  original?: number
  suffix?: string
  onChange: (value: number) => void
}) {
  const originalPct = original == null ? null : ((original - min) / Math.max(1, max - min)) * 100
  return (
    <label className="light-stage-slider-row">
      <span>{label}</span>
      <span className="light-stage-slider-track">
        <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} />
        {originalPct != null && <i className="light-stage-original-tick" style={{ left: `${Math.max(0, Math.min(100, originalPct))}%` }} />}
      </span>
      <strong>{Math.round(value)}{suffix}</strong>
    </label>
  )
}

function DegreeRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(Math.round(value)))
  useEffect(() => setDraft(String(Math.round(value))), [value])
  const commit = (nextDraft = draft) => {
    const parsed = Number(nextDraft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(Math.round(value)))
      return
    }
    const nextValue = Math.round(clampUiNumber(parsed, -180, 180))
    setDraft(String(nextValue))
    onChange(nextValue)
  }
  return (
    <label className="light-stage-slider-row light-stage-degree-row">
      <span>{label}</span>
      <span className="light-stage-slider-track">
        <input type="range" min={-180} max={180} step={1} value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} />
      </span>
      <span className="light-stage-degree-input-wrap">
        <input
          type="number"
          min={-180}
          max={180}
          step={1}
          value={draft}
          onChange={(event) => {
            const nextDraft = event.currentTarget.value
            setDraft(nextDraft)
            const parsed = Number(nextDraft)
            if (Number.isFinite(parsed)) onChange(Math.round(clampUiNumber(parsed, -180, 180)))
          }}
          onBlur={() => commit()}
          onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
        />
        <b>°</b>
      </span>
    </label>
  )
}

function ColorRow({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  const [draft, setDraft] = useState(color)
  useEffect(() => setDraft(color), [color])
  const commit = () => onChange(normalizeHexColor(draft, color))
  return (
    <div className="light-stage-color-row">
      <span>颜色</span>
      <input className="light-stage-color-swatch" type="color" value={color} onChange={(event) => onChange(event.currentTarget.value)} />
      <input
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
      />
    </div>
  )
}

function ColorReport({ color }: { color: string }) {
  const rgb = hexToSrgb(color)
  const temperature = colorTemperatureEstimate(color)
  return (
    <div className="light-stage-color-report">
      <span style={{ background: color }} />
      <div>
        <strong>HEX {color.toUpperCase()}</strong>
        <b>RGB {rgb.r}, {rgb.g}, {rgb.b}</b>
        <small>约 {temperature.kelvin}K · {temperature.label}估算色温</small>
      </div>
    </div>
  )
}

function AnchorControls({ light, onChange }: { light: LightStageLightConfig; onChange: (patch: Partial<LightStageLightConfig>) => void }) {
  return (
    <div className="light-stage-anchor-controls">
      <div className="light-stage-cardinal-grid">
        {CARDINAL_ANCHORS.map((anchor) => (
          <button
            key={anchor.value}
            type="button"
            className={light.anchor === anchor.value ? 'is-active' : ''}
            onClick={() => onChange({ anchor: anchor.value, direction: undefined })}
          >
            {anchor.label}
          </button>
        ))}
      </div>
      <div className="light-stage-diagonal-row">
        {ANCHOR_GROUPS.map((group) => {
          const anchors = LIGHT_STAGE_ANCHOR_DEFINITIONS.filter((anchor) => anchor.group === group.key)
          const selected = anchors.some((anchor) => anchor.value === light.anchor)
          return (
            <label key={group.key} className={selected ? 'is-active' : ''}>
              <span>{selected ? anchors.find((anchor) => anchor.value === light.anchor)?.label : group.label}</span>
              <ChevronDown size={11} />
              <select value={selected ? light.anchor : ''} onChange={(event) => onChange({ anchor: event.currentTarget.value as LightStageAnchor, direction: undefined })}>
                <option value="" disabled>{group.label}</option>
                {anchors.map((anchor) => <option key={anchor.value} value={anchor.value}>{anchor.label}</option>)}
              </select>
            </label>
          )
        })}
      </div>
    </div>
  )
}

function LightEditor({
  light,
  originalIntensity,
  onChange,
}: {
  light: LightStageLightConfig
  originalIntensity: number
  onChange: (light: LightStageLightConfig) => void
}) {
  const update = (patch: Partial<LightStageLightConfig>) => onChange({ ...light, ...patch })
  return (
    <div className="light-stage-light-editor">
      <div className="light-stage-type-grid">
        {(Object.keys(LIGHT_TYPE_LABELS) as LightStageLightConfig['type'][]).map((type) => (
          <button key={type} type="button" className={light.type === type ? 'is-active' : ''} onClick={() => update({ type })}>
            {LIGHT_TYPE_LABELS[type]}
          </button>
        ))}
      </div>
      <AnchorControls light={light} onChange={update} />
      <div className="light-stage-transform-card">
        <div className="light-stage-section-title">
          <strong>灯光变换</strong>
          <span>目标锁定主体中心</span>
        </div>
        <div className="light-stage-transform-columns">
          <div>
            <b>轨道旋转</b>
            {(['x', 'y', 'z'] as const).map((axis) => (
              <DegreeRow
                key={`rotation-${axis}`}
                label={`旋转 ${axis.toUpperCase()}`}
                value={light.rotation[axis]}
                onChange={(value) => update({ rotation: { ...light.rotation, [axis]: value }, direction: undefined })}
              />
            ))}
          </div>
          <div>
            <b>世界位移</b>
            {(['x', 'y', 'z'] as const).map((axis) => (
              <SliderRow
                key={`offset-${axis}`}
                label={`位移 ${axis.toUpperCase()}`}
                value={light.offset[axis]}
                min={-100}
                max={100}
                suffix=""
                onChange={(value) => update({ offset: { ...light.offset, [axis]: value } })}
              />
            ))}
          </div>
        </div>
      </div>
      <SliderRow label="强度" value={light.intensity} original={originalIntensity} onChange={(intensity) => update({ intensity })} />
      <ColorRow color={light.color} onChange={(color) => update({ color })} />
      {light.type === 'area' && (
        <>
          <SliderRow label="宽度" value={light.width} onChange={(width) => update({ width })} />
          <SliderRow label="高度" value={light.height} onChange={(height) => update({ height })} />
          <SliderRow label="滚转" value={light.roll} min={-180} max={180} suffix="°" onChange={(roll) => update({ roll })} />
        </>
      )}
      {light.type === 'spot' && (
        <>
          <SliderRow label="锥角" value={light.coneAngle} min={5} max={120} suffix="°" onChange={(coneAngle) => update({ coneAngle })} />
          <SliderRow label="柔度" value={light.softness} onChange={(softness) => update({ softness })} />
        </>
      )}
      {light.type === 'point' && <SliderRow label="距离" value={light.distance} min={10} onChange={(distance) => update({ distance })} />}
      <SliderRow label="衰减" value={light.attenuation} onChange={(attenuation) => update({ attenuation })} />
      <ColorReport color={light.color} />
    </div>
  )
}

function anchoredPanelStyle(anchorRect?: DOMRect | null) {
  const width = Math.min(1480, window.innerWidth - 24)
  const height = Math.min(790, window.innerHeight - 24)
  if (!anchorRect) return { left: (window.innerWidth - width) / 2, top: (window.innerHeight - height) / 2, width, height }
  const desiredTop = anchorRect.bottom + 14
  const top = desiredTop + height <= window.innerHeight - 12
    ? desiredTop
    : Math.max(12, anchorRect.top - height - 14)
  const center = anchorRect.left + anchorRect.width / 2
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, center - width / 2))
  return { left, top, width, height }
}

export function LightStageModal({
  sourceUrl,
  sourceName,
  sourceNodeId,
  projectUuid,
  anchorRect,
  initialState,
  initialRatio = 'auto',
  initialResolution = '1K',
  busy = false,
  onCancel,
  onAccept,
}: LightStageModalProps) {
  const [state, setState] = useState(() => {
    const next = readLightStageState(initialState ?? DEFAULT_LIGHT_STAGE_STATE)
    if (LIGHT_STAGE_RESOLUTION_OPTIONS.includes(initialResolution as (typeof LIGHT_STAGE_RESOLUTION_OPTIONS)[number])) {
      next.outputQuality = initialResolution as LightStageState['outputQuality']
    }
    return next
  })
  const [ratio, setRatio] = useState(initialRatio || 'auto')
  const [activeTab, setActiveTab] = useState<LightTab>('main')
  const [geometryLoading, setGeometryLoading] = useState(false)
  const [maskSaving, setMaskSaving] = useState(false)
  const [geometryError, setGeometryError] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const snapshotRef = useRef<LightStageSnapshot>({ state, ratio })
  const undoStackRef = useRef<LightStageSnapshot[]>([])
  const redoStackRef = useRef<LightStageSnapshot[]>([])
  const [panelStyle, setPanelStyle] = useState(() => anchoredPanelStyle(anchorRect))

  useEffect(() => {
    const resize = () => setPanelStyle(anchoredPanelStyle(anchorRect))
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [anchorRect])

  useEffect(() => {
    snapshotRef.current = { state, ratio }
  }, [ratio, state])

  const applyState = useCallback((update: LightStageStateUpdate) => {
    setState((current) => {
      const next = resolveLightStageStateUpdate(update, current)
      snapshotRef.current = { ...snapshotRef.current, state: next }
      return next
    })
  }, [])

  const pushSnapshot = useCallback((snapshot: LightStageSnapshot) => {
    undoStackRef.current = [...undoStackRef.current, snapshot].slice(-LIGHT_STAGE_HISTORY_LIMIT)
    redoStackRef.current = []
  }, [])

  const restoreSnapshot = useCallback((snapshot: LightStageSnapshot) => {
    const currentGeometry = snapshotRef.current.state.geometry
    const nextState = {
      ...snapshot.state,
      geometry: currentGeometry,
    }
    const nextSnapshot = { state: nextState, ratio: snapshot.ratio }
    snapshotRef.current = nextSnapshot
    setState(nextState)
    setRatio(snapshot.ratio)
  }, [])

  const commitState = useCallback((update: LightStageStateUpdate) => {
    const current = snapshotRef.current
    const nextState = resolveLightStageStateUpdate(update, current.state)
    const nextSnapshot = { state: nextState, ratio: current.ratio }
    if (sameLightStageSnapshot(current, nextSnapshot)) return
    pushSnapshot(current)
    snapshotRef.current = nextSnapshot
    setState(nextState)
  }, [pushSnapshot])

  const commitRatio = useCallback((nextRatio: string) => {
    const current = snapshotRef.current
    if (current.ratio === nextRatio) return
    const nextSnapshot = { state: current.state, ratio: nextRatio }
    pushSnapshot(current)
    snapshotRef.current = nextSnapshot
    setRatio(nextRatio)
  }, [pushSnapshot])

  const undoLightStage = useCallback(() => {
    const history = undoStackRef.current
    const snapshot = history[history.length - 1]
    if (!snapshot) return false
    undoStackRef.current = history.slice(0, -1)
    redoStackRef.current = [...redoStackRef.current, snapshotRef.current].slice(-LIGHT_STAGE_HISTORY_LIMIT)
    restoreSnapshot(snapshot)
    return true
  }, [restoreSnapshot])

  const redoLightStage = useCallback(() => {
    const history = redoStackRef.current
    const snapshot = history[history.length - 1]
    if (!snapshot) return false
    redoStackRef.current = history.slice(0, -1)
    undoStackRef.current = [...undoStackRef.current, snapshotRef.current].slice(-LIGHT_STAGE_HISTORY_LIMIT)
    restoreSnapshot(snapshot)
    return true
  }, [restoreSnapshot])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      if (isTextEditingKeyTarget(event.target)) return
      const key = event.key.toLowerCase()
      const wantsUndo = key === 'z' && !event.shiftKey
      const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey)
      if (!wantsUndo && !wantsRedo) return
      event.preventDefault()
      event.stopPropagation()
      if (wantsUndo) {
        undoLightStage()
      } else {
        redoLightStage()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [redoLightStage, undoLightStage])

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onCancel()
    }
    const timer = window.setTimeout(() => document.addEventListener('pointerdown', closeOutside, true), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('pointerdown', closeOutside, true)
    }
  }, [onCancel])

  useEffect(() => {
    if (!projectUuid || !sourceNodeId || !sourceUrl) return
    const geometryReady = state.geometry?.status === 'ready'
    const geometryCurrent = (state.geometry?.assetVersion || 0) >= 4
      && state.geometry?.normalConvention === 'opengl-object'
    if (geometryReady && geometryCurrent) return
    let cancelled = false
    setGeometryLoading(true)
    setGeometryError('')
    applyState((current) => ({
      ...current,
      geometry: {
        provider: 'moge-2-vitb-normal',
        modelId: 'moge-2-vitb-normal',
        status: 'loading',
      },
    }))
    lightStageApi.prepareGeometry(projectUuid, sourceNodeId, sourceUrl)
      .then(({ geometry }) => {
        if (cancelled) return
        applyState((current) => ({ ...current, geometry }))
        setGeometryError(geometry.error || '')
      })
      .catch((error) => {
        if (cancelled) return
        const message = String(error?.response?.data?.error || error?.message || '几何资产准备失败')
        setGeometryError(message)
        applyState((current) => ({
          ...current,
          geometry: {
            provider: 'local-2.5d',
            modelId: 'local-relief-v1',
            status: 'failed',
            error: message,
          },
        }))
      })
      .finally(() => { if (!cancelled) setGeometryLoading(false) })
    return () => { cancelled = true }
  }, [applyState, projectUuid, sourceNodeId, sourceUrl])

  const resetLights = useCallback(() => {
    commitState((current) => ({
      ...DEFAULT_LIGHT_STAGE_STATE,
      outputQuality: current.outputQuality,
      geometry: current.geometry,
    }))
  }, [commitState])

  const updateLightDirection = useCallback((
    key: 'main' | 'fill',
    anchor: LightStageAnchor,
    rotation: LightStageLightConfig['rotation'],
  ) => {
    commitState((current) => ({ ...current, [key]: { ...current[key], anchor, rotation, direction: undefined } }))
  }, [commitState])

  const updateStageRotation = useCallback((stageRotation: LightStageState['stageRotation']) => {
    commitState((current) => ({ ...current, stageRotation }))
  }, [commitState])

  const updateViewMode = useCallback((viewMode: LightStageViewMode) => {
    commitState((current) => ({ ...current, viewMode }))
  }, [commitState])

  const geometry = state.geometry
  const sourceLayout = lightStagePlaneLayout(geometry?.width, geometry?.height)
  const geometryFallbackMessage = geometry?.status === 'fallback'
    ? geometry.error || 'MoGe-2 unavailable; using local 2.5D fallback'
    : ''
  const geometryFailureMessage = geometryError && geometryError !== geometryFallbackMessage
    ? geometryError
    : ''
  const acceptLightStage = useCallback(async () => {
    if (busy || maskSaving) return
    let nextState = state
    if (projectUuid && sourceNodeId && geometry?.normalUrl) {
      setMaskSaving(true)
      setGeometryError('')
      try {
        const { maskUrl } = await lightStageApi.prepareMask(projectUuid, sourceNodeId, geometry.normalUrl, state)
        nextState = {
          ...state,
          geometry: {
            ...geometry,
            maskUrl,
          },
        }
        applyState(nextState)
      } catch (error: any) {
        setGeometryError(String(error?.response?.data?.error || error?.message || '灯光范围遮罩保存失败'))
        return
      } finally {
        setMaskSaving(false)
      }
    }
    const nextPrompt = compileLightStagePrompt({
      sourceName,
      state: nextState,
      ratio,
      resolution: nextState.outputQuality,
    })
    await onAccept({
      state: nextState,
      prompt: nextPrompt,
      ratio,
      resolution: nextState.outputQuality,
      geometryUrls: geometryUrlsFromState(nextState),
    })
  }, [busy, geometry, maskSaving, onAccept, projectUuid, ratio, sourceName, sourceNodeId, state])
  const shell = (
    <div className="light-stage-popover-layer nodrag nowheel">
      <div
        ref={panelRef}
        className="light-stage-workbench"
        style={{ left: panelStyle.left, top: panelStyle.top, width: panelStyle.width, height: panelStyle.height }}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <section className="light-stage-aov-column">
          <div className="light-stage-column-heading">
            <span>几何与光照通道</span>
            <small className={geometry?.status === 'ready' ? 'is-ready' : ''}>
              {geometryLoading ? '处理中' : geometry?.status === 'ready' ? 'MoGe-2' : geometry?.status === 'fallback' ? '本地 2.5D' : '待准备'}
            </small>
          </div>
          <div className="light-stage-aov-grid">
            {AOV_ITEMS.map((item) => {
              const imageUrl = geometryImage(geometry, item.key, sourceUrl)
              return (
                <button
                  type="button"
                  key={item.key}
                  className={state.aovMode === item.key ? 'is-active' : ''}
                  onClick={() => commitState((current) => ({ ...current, aovMode: item.key }))}
                >
                  <span
                    className="light-stage-aov-image"
                    style={{ aspectRatio: sourceLayout.cssAspectRatio }}
                  >
                    {item.key === 'mask'
                      ? <LightStageMaskPreview normalUrl={geometry?.normalUrl} state={state} />
                      : imageUrl ? <img src={imageUrl} alt="" draggable={false} /> : <i />}
                    {geometryLoading && item.key !== 'diffuse' && <Loader2 size={16} />}
                  </span>
                  <b>{item.label}</b>
                </button>
              )
            })}
          </div>
          {geometryFallbackMessage && <div className="light-stage-geometry-notice">{geometryFallbackMessage}</div>}
          {geometryFailureMessage && <div className="light-stage-geometry-error">{geometryFailureMessage}</div>}
        </section>

        <section className="light-stage-center-column">
          <div className="light-stage-stage-bar">
            <div>
              <Sun size={15} />
              <strong>光场重塑</strong>
            </div>
            <div className="light-stage-segmented">
              {(['color', 'clay'] as const).map((mode) => (
                <button key={mode} type="button" className={state.subjectMode === mode ? 'is-active' : ''} onClick={() => commitState((current) => ({ ...current, subjectMode: mode }))}>
                  {mode === 'color' ? '彩色' : '白模'}
                </button>
              ))}
            </div>
            <div className="light-stage-segmented">
              {(['perspective', 'front'] as LightStageViewMode[]).map((mode) => (
                <button key={mode} type="button" className={state.viewMode === mode ? 'is-active' : ''} onClick={() => commitState((current) => ({ ...current, viewMode: mode }))}>
                  {mode === 'perspective' ? '透视' : '正面'}
                </button>
              ))}
            </div>
          </div>
          <div className="light-stage-stage-frame">
            <LightStageThreePreview
              sourceUrl={sourceUrl}
              state={state}
              geometry={geometry}
              onLightDirectionChange={updateLightDirection}
              onStageRotationChange={updateStageRotation}
              onViewModeChange={updateViewMode}
            />
          </div>
          <div className="light-stage-center-footer">
            <button type="button" onClick={resetLights} disabled={busy}><RotateCcw size={14} />重置灯光</button>
            <span>拖动主体旋转 2.5D 浮雕 · 拖动灯体调整球面灯位</span>
          </div>
        </section>

        <aside className="light-stage-control-column">
          <div className="light-stage-control-head">
            <div className="light-stage-control-tabs">
              {(['main', 'fill', 'ambient'] as LightTab[]).map((tab) => (
                <button key={tab} type="button" className={activeTab === tab ? 'is-active' : ''} onClick={() => setActiveTab(tab)}>
                  {tab === 'main'
                    ? `主光 ${LIGHT_TYPE_LABELS[state.main.type]}`
                    : tab === 'fill'
                      ? `辅光 ${LIGHT_TYPE_LABELS[state.fill.type]}`
                      : '环境光'}
                </button>
              ))}
            </div>
            <button type="button" className="light-stage-close" onClick={onCancel} aria-label="关闭"><X size={16} /></button>
          </div>

          <div className="light-stage-control-options">
            <Toggle checked={state.smartMode} label="智能模式" onChange={(smartMode) => commitState((current) => ({ ...current, smartMode }))} />
            <Toggle checked={state.rimLight} label="轮廓光" onChange={(rimLight) => commitState((current) => ({ ...current, rimLight }))} />
          </div>

          <div className="light-stage-capability-row">
            <strong>Nano Banana Pro</strong>
            <span>几何 {geometry?.provider === 'moge-2-vitb-normal' ? 'MoGe-2' : '2.5D'}</span>
            <span>预览 {state.subjectMode === 'color' ? '彩色' : '白模'}</span>
            <span>原图估算 {state.originalLightReference.mainIntensity}%</span>
          </div>

          <div className="light-stage-control-scroll">
            {activeTab === 'main' && (
              <>
                <Toggle checked={state.main.enabled} label={`主光 · ${LIGHT_TYPE_LABELS[state.main.type]}`} onChange={(enabled) => commitState((current) => ({ ...current, main: { ...current.main, enabled } }))} />
                <LightEditor light={state.main} originalIntensity={state.originalLightReference.mainIntensity} onChange={(main) => commitState((current) => ({ ...current, main }))} />
              </>
            )}
            {activeTab === 'fill' && (
              <>
                <Toggle checked={state.fill.enabled} label={`辅光 · ${LIGHT_TYPE_LABELS[state.fill.type]}`} onChange={(enabled) => commitState((current) => ({ ...current, fill: { ...current.fill, enabled } }))} />
                <LightEditor light={state.fill} originalIntensity={state.originalLightReference.fillIntensity} onChange={(fill) => commitState((current) => ({ ...current, fill }))} />
              </>
            )}
            {activeTab === 'ambient' && (
              <div className="light-stage-ambient-editor">
                <Toggle checked={state.ambient.enabled} label="环境光" onChange={(enabled) => commitState((current) => ({ ...current, ambient: { ...current.ambient, enabled } }))} />
                <SliderRow label="强度" value={state.ambient.intensity} original={state.originalLightReference.ambientIntensity} onChange={(intensity) => commitState((current) => ({ ...current, ambient: { ...current.ambient, intensity } }))} />
                <ColorRow color={state.ambient.color} onChange={(color) => commitState((current) => ({ ...current, ambient: { ...current.ambient, color } }))} />
                <p>环境光不具有方向和位置；关闭后对预览、遮罩和最终提示词的贡献严格为零。</p>
              </div>
            )}
          </div>

          <div className="light-stage-output-panel">
            <label>
              <span>比例</span>
              <select value={ratio} onChange={(event) => commitRatio(event.currentTarget.value)}>
                {LIGHT_STAGE_RATIO_OPTIONS.map((item) => <option key={item} value={item}>{item === 'auto' ? '保持原图' : item}</option>)}
              </select>
            </label>
            <label>
              <span>输出</span>
              <select value={state.outputQuality} onChange={(event) => commitState((current) => ({ ...current, outputQuality: event.currentTarget.value as LightStageState['outputQuality'] }))}>
                {LIGHT_STAGE_RESOLUTION_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <div className="light-stage-actions">
            <button type="button" className="is-secondary" onClick={onCancel} disabled={busy}>取消</button>
            <button
              type="button"
              className="is-primary"
              disabled={busy || maskSaving}
              onClick={acceptLightStage}
            >
              {busy || maskSaving ? <><Loader2 size={15} className="is-spinning" />处理中</> : <>生成灯光节点<Check size={15} /></>}
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
  return createPortal(shell, document.body)
}
