export type LightStageLightType = 'directional' | 'spot' | 'area' | 'point'

export type LightStageAnchor =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'front-left'
  | 'front-right'
  | 'back-left'
  | 'back-right'
  | 'top-front'
  | 'top-back'
  | 'top-left'
  | 'top-right'
  | 'top-front-left'
  | 'top-front-right'
  | 'top-back-left'
  | 'top-back-right'
  | 'bottom-front'
  | 'bottom-back'
  | 'bottom-left'
  | 'bottom-right'
  | 'bottom-front-left'
  | 'bottom-front-right'
  | 'bottom-back-left'
  | 'bottom-back-right'

export type LightStageAovMode = 'diffuse' | 'normal' | 'depth' | 'mask'
export type LightStageSubjectMode = 'color' | 'clay'
export type LightStageViewMode = 'perspective' | 'front'
export type LightStageGeometryStatus = 'idle' | 'loading' | 'ready' | 'fallback' | 'failed'

export interface LightStageVector3 {
  x: number
  y: number
  z: number
}

export interface LightStageLightConfig {
  enabled: boolean
  type: LightStageLightType
  anchor: LightStageAnchor
  intensity: number
  color: string
  width: number
  height: number
  roll: number
  attenuation: number
  coneAngle: number
  softness: number
  distance: number
  direction?: LightStageVector3
  rotation: LightStageVector3
  offset: LightStageVector3
}

export interface LightStageGeometryAssets {
  provider: 'moge-2-vitb-normal' | 'local-2.5d'
  modelId: string
  status: LightStageGeometryStatus
  diffuseUrl?: string
  normalUrl?: string
  depthUrl?: string
  maskUrl?: string
  pointMapUrl?: string
  previewUrl?: string
  manifestUrl?: string
  width?: number
  height?: number
  fov?: number
  intrinsics?: number[]
  assetVersion?: number
  normalConvention?: 'opengl-object'
  generatedAtMs?: number
  error?: string
}

export interface LightStageState {
  version: 3
  viewMode: LightStageViewMode
  subjectMode: LightStageSubjectMode
  aovMode: LightStageAovMode
  smartMode: boolean
  rimLight: boolean
  stageRotation: {
    x: number
    y: number
  }
  main: LightStageLightConfig
  fill: LightStageLightConfig
  ambient: {
    enabled: boolean
    intensity: number
    color: string
  }
  outputQuality: '1K' | '2K' | '4K'
  originalLightReference: {
    mainIntensity: number
    fillIntensity: number
    ambientIntensity: number
  }
  geometry?: LightStageGeometryAssets
}

export interface PersistedLightStageRecord {
  version: 3
  sourceNodeId?: string
  sourceUrl?: string
  sourceName?: string
  state: LightStageState
  prompt?: string
  ratio?: string
  resolution?: string
  geometryUrls?: Partial<Record<LightStageAovMode | 'pointMap' | 'preview' | 'manifest', string>>
  createdAtMs?: number
}

export const LIGHT_STAGE_GEOMETRY_MODEL = 'moge-2-vitb-normal'
export const LIGHT_STAGE_MODEL = 'gemini-3-pro-image'

export const LIGHT_STAGE_RATIO_OPTIONS = [
  'auto',
  '1:1',
  '9:16',
  '16:9',
  '3:4',
  '4:3',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  '21:9',
] as const

export const LIGHT_STAGE_RESOLUTION_OPTIONS = ['1K', '2K', '4K'] as const

const defaultLight = (
  type: LightStageLightType,
  anchor: LightStageAnchor,
  intensity: number,
  color: string,
): LightStageLightConfig => ({
  enabled: true,
  type,
  anchor,
  intensity,
  color,
  width: type === 'area' ? 70 : 54,
  height: type === 'area' ? 46 : 54,
  roll: 0,
  attenuation: type === 'directional' ? 22 : 48,
  coneAngle: 42,
  softness: 44,
  distance: 58,
  rotation: { x: 0, y: 0, z: 0 },
  offset: { x: 0, y: 0, z: 0 },
})

export const DEFAULT_LIGHT_STAGE_STATE: LightStageState = {
  version: 3,
  viewMode: 'front',
  subjectMode: 'clay',
  aovMode: 'diffuse',
  smartMode: true,
  rimLight: false,
  stageRotation: { x: 0, y: 0 },
  main: defaultLight('spot', 'front-left', 77, '#cdaa96'),
  fill: { ...defaultLight('area', 'front', 24, '#9ed2ff'), enabled: false },
  ambient: {
    enabled: false,
    intensity: 16,
    color: '#2b2440',
  },
  outputQuality: '1K',
  originalLightReference: {
    mainIntensity: 60,
    fillIntensity: 24,
    ambientIntensity: 16,
  },
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

export function normalizeHexColor(value: unknown, fallback: string) {
  const raw = String(value || '').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`
  return fallback
}

const LIGHT_TYPES: LightStageLightType[] = ['directional', 'spot', 'area', 'point']
export const LIGHT_STAGE_ANCHORS: LightStageAnchor[] = [
  'front', 'back', 'left', 'right', 'top', 'bottom',
  'front-left', 'front-right', 'back-left', 'back-right',
  'top-front', 'top-back', 'top-left', 'top-right',
  'top-front-left', 'top-front-right', 'top-back-left', 'top-back-right',
  'bottom-front', 'bottom-back', 'bottom-left', 'bottom-right',
  'bottom-front-left', 'bottom-front-right', 'bottom-back-left', 'bottom-back-right',
]

function normalizeLight(raw: unknown, fallback: LightStageLightConfig): LightStageLightConfig {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const direction = (value.direction && typeof value.direction === 'object' ? value.direction : {}) as Record<string, unknown>
  const rotation = (value.rotation && typeof value.rotation === 'object' ? value.rotation : {}) as Record<string, unknown>
  const offset = (value.offset && typeof value.offset === 'object' ? value.offset : {}) as Record<string, unknown>
  const directionX = Number(direction.x)
  const directionY = Number(direction.y)
  const directionZ = Number(direction.z)
  const directionLength = Math.hypot(directionX, directionY, directionZ)
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    type: LIGHT_TYPES.includes(value.type as LightStageLightType) ? value.type as LightStageLightType : fallback.type,
    anchor: LIGHT_STAGE_ANCHORS.includes(value.anchor as LightStageAnchor) ? value.anchor as LightStageAnchor : fallback.anchor,
    intensity: clampNumber(value.intensity, 0, 100, fallback.intensity),
    color: normalizeHexColor(value.color, fallback.color),
    width: clampNumber(value.width, 4, 100, fallback.width),
    height: clampNumber(value.height, 4, 100, fallback.height),
    roll: clampNumber(value.roll, -180, 180, fallback.roll),
    attenuation: clampNumber(value.attenuation, 0, 100, fallback.attenuation),
    coneAngle: clampNumber(value.coneAngle, 5, 120, fallback.coneAngle),
    softness: clampNumber(value.softness, 0, 100, fallback.softness),
    distance: clampNumber(value.distance, 10, 100, fallback.distance),
    direction: directionLength > 0.001
      ? {
          x: clampNumber(directionX / directionLength, -1, 1, 0),
          y: clampNumber(directionY / directionLength, -1, 1, 0),
          z: clampNumber(directionZ / directionLength, -1, 1, 1),
        }
      : fallback.direction ? { ...fallback.direction } : undefined,
    rotation: {
      x: clampNumber(rotation.x, -180, 180, fallback.rotation.x),
      y: clampNumber(rotation.y, -180, 180, fallback.rotation.y),
      z: clampNumber(rotation.z, -180, 180, fallback.rotation.z),
    },
    offset: {
      x: clampNumber(offset.x, -100, 100, fallback.offset.x),
      y: clampNumber(offset.y, -100, 100, fallback.offset.y),
      z: clampNumber(offset.z, -100, 100, fallback.offset.z),
    },
  }
}

function normalizeGeometry(raw: unknown): LightStageGeometryAssets | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const statusValues: LightStageGeometryStatus[] = ['idle', 'loading', 'ready', 'fallback', 'failed']
  const provider = value.provider === 'moge-2-vitb-normal' ? 'moge-2-vitb-normal' : 'local-2.5d'
  return {
    provider,
    modelId: String(value.modelId || (provider === 'moge-2-vitb-normal' ? LIGHT_STAGE_GEOMETRY_MODEL : 'local-relief-v1')),
    status: statusValues.includes(value.status as LightStageGeometryStatus) ? value.status as LightStageGeometryStatus : 'idle',
    diffuseUrl: typeof value.diffuseUrl === 'string' ? value.diffuseUrl : undefined,
    normalUrl: typeof value.normalUrl === 'string' ? value.normalUrl : undefined,
    depthUrl: typeof value.depthUrl === 'string' ? value.depthUrl : undefined,
    maskUrl: typeof value.maskUrl === 'string' ? value.maskUrl : undefined,
    pointMapUrl: typeof value.pointMapUrl === 'string' ? value.pointMapUrl : undefined,
    previewUrl: typeof value.previewUrl === 'string' ? value.previewUrl : undefined,
    manifestUrl: typeof value.manifestUrl === 'string' ? value.manifestUrl : undefined,
    width: clampNumber(value.width, 1, 32768, 0) || undefined,
    height: clampNumber(value.height, 1, 32768, 0) || undefined,
    fov: clampNumber(value.fov, 1, 179, 45),
    intrinsics: Array.isArray(value.intrinsics) ? value.intrinsics.map(Number).filter(Number.isFinite).slice(0, 9) : undefined,
    assetVersion: clampNumber(value.assetVersion, 0, 100, 0) || undefined,
    normalConvention: value.normalConvention === 'opengl-object' ? 'opengl-object' : undefined,
    generatedAtMs: clampNumber(value.generatedAtMs, 0, Number.MAX_SAFE_INTEGER, 0) || undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
  }
}

export function readLightStageState(raw: unknown): LightStageState {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const recordState = (source.state && typeof source.state === 'object' ? source.state : source) as Record<string, unknown>
  const ambient = (recordState.ambient && typeof recordState.ambient === 'object' ? recordState.ambient : {}) as Record<string, unknown>
  const stageRotation = (recordState.stageRotation && typeof recordState.stageRotation === 'object' ? recordState.stageRotation : {}) as Record<string, unknown>
  const original = (recordState.originalLightReference && typeof recordState.originalLightReference === 'object'
    ? recordState.originalLightReference
    : {}) as Record<string, unknown>
  const legacyPreviewMode = String(recordState.previewMode || '')
  const aovModes: LightStageAovMode[] = ['diffuse', 'normal', 'depth', 'mask']
  const subjectModes: LightStageSubjectMode[] = ['color', 'clay']
  const viewModes: LightStageViewMode[] = ['perspective', 'front']
  const outputQuality = LIGHT_STAGE_RESOLUTION_OPTIONS.includes(recordState.outputQuality as typeof LIGHT_STAGE_RESOLUTION_OPTIONS[number])
    ? recordState.outputQuality as LightStageState['outputQuality']
    : LIGHT_STAGE_RESOLUTION_OPTIONS.includes(source.resolution as typeof LIGHT_STAGE_RESOLUTION_OPTIONS[number])
      ? source.resolution as LightStageState['outputQuality']
      : DEFAULT_LIGHT_STAGE_STATE.outputQuality

  return {
    version: 3,
    viewMode: viewModes.includes(recordState.viewMode as LightStageViewMode) ? recordState.viewMode as LightStageViewMode : DEFAULT_LIGHT_STAGE_STATE.viewMode,
    subjectMode: subjectModes.includes(recordState.subjectMode as LightStageSubjectMode)
      ? recordState.subjectMode as LightStageSubjectMode
      : legacyPreviewMode === 'clay' ? 'clay' : DEFAULT_LIGHT_STAGE_STATE.subjectMode,
    aovMode: aovModes.includes(recordState.aovMode as LightStageAovMode)
      ? recordState.aovMode as LightStageAovMode
      : aovModes.includes(legacyPreviewMode as LightStageAovMode) ? legacyPreviewMode as LightStageAovMode : DEFAULT_LIGHT_STAGE_STATE.aovMode,
    smartMode: typeof recordState.smartMode === 'boolean' ? recordState.smartMode : DEFAULT_LIGHT_STAGE_STATE.smartMode,
    rimLight: typeof recordState.rimLight === 'boolean' ? recordState.rimLight : DEFAULT_LIGHT_STAGE_STATE.rimLight,
    stageRotation: {
      x: clampNumber(stageRotation.x, -78, 78, DEFAULT_LIGHT_STAGE_STATE.stageRotation.x),
      y: clampNumber(stageRotation.y, -180, 180, DEFAULT_LIGHT_STAGE_STATE.stageRotation.y),
    },
    main: normalizeLight(recordState.main, DEFAULT_LIGHT_STAGE_STATE.main),
    fill: normalizeLight(recordState.fill, DEFAULT_LIGHT_STAGE_STATE.fill),
    ambient: {
      enabled: typeof ambient.enabled === 'boolean' ? ambient.enabled : DEFAULT_LIGHT_STAGE_STATE.ambient.enabled,
      intensity: clampNumber(ambient.intensity, 0, 100, DEFAULT_LIGHT_STAGE_STATE.ambient.intensity),
      color: normalizeHexColor(ambient.color, DEFAULT_LIGHT_STAGE_STATE.ambient.color),
    },
    outputQuality,
    originalLightReference: {
      mainIntensity: clampNumber(original.mainIntensity, 0, 100, DEFAULT_LIGHT_STAGE_STATE.originalLightReference.mainIntensity),
      fillIntensity: clampNumber(original.fillIntensity, 0, 100, DEFAULT_LIGHT_STAGE_STATE.originalLightReference.fillIntensity),
      ambientIntensity: clampNumber(original.ambientIntensity, 0, 100, DEFAULT_LIGHT_STAGE_STATE.originalLightReference.ambientIntensity),
    },
    geometry: normalizeGeometry(recordState.geometry || source.geometry),
  }
}

export function geometryUrlsFromState(state: LightStageState) {
  const geometry = state.geometry
  if (!geometry) return {}
  return {
    diffuse: geometry.diffuseUrl,
    normal: geometry.normalUrl,
    depth: geometry.depthUrl,
    mask: geometry.maskUrl,
    pointMap: geometry.pointMapUrl,
    preview: geometry.previewUrl,
    manifest: geometry.manifestUrl,
  }
}
