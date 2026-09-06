/**
 * 三维空间节点的状态模型。
 *
 * 两条硬约束决定了这里的写法：
 *
 * ① **必须小。** 这个 state 是存进 `params.stage` 落库的，而画布 payload 曾经把 Node
 *    打到 OOM（资产库一次返回 500 条完整 payload）。所以：姿势只存被改过的关节、
 *    坐标一律砍到 4 位小数、道具没有名字没有历史。有测试守着序列化后的体积。
 *
 * ② **必须容错。** 老画布、插件写入、手改过的 JSON 都可能给出缺字段 / 脏类型 /
 *    超范围的值。`readDirectorStageState` 一律 migration-on-read 回落到默认，
 *    绝不抛 —— 打不开节点比姿势丢了严重得多。
 */
import {
  clampFocalMm,
  clampOrbitDistance,
  clampPitchDeg,
  normalizeYawDeg,
} from './cameraMath'
import { clampJointAngles, isJointId, type JointId, type Pose } from './skeleton'

export type PropKind = 'box' | 'cylinder'

export interface StageProp {
  id: string
  kind: PropKind
  position: [number, number, number]
  /** 度 */
  rotation: [number, number, number]
  scale: [number, number, number]
}

export interface StageCamera {
  yaw: number
  pitch: number
  distance: number
  target: [number, number, number]
  focalMm: number
}

export interface StageScene {
  groundVisible: boolean
  gridVisible: boolean
  backdropVisible: boolean
  /** 背景板 / 环境底色，出图时也是画面底色 */
  backdropColor: string
  groundColor: string
}

export interface DirectorStageState {
  camera: StageCamera
  pose: Pose
  props: StageProp[]
  scene: StageScene
  /** 出图比例（宽:高） */
  ratio: string
  /** 出图短边像素 */
  resolution: string
}

export const DIRECTOR_RATIO_OPTIONS = ['16:9', '9:16', '4:3', '3:4', '1:1', '3:2', '2:3', '21:9'] as const
export const DIRECTOR_RESOLUTION_OPTIONS = ['1K', '2K', '4K'] as const

/** 短边像素。和灯光台 / 全景截图一个口径。 */
export const RESOLUTION_SHORT_EDGE: Record<string, number> = {
  '1K': 1024,
  '2K': 1536,
  '4K': 2048,
}

/** 道具数量上限。够摆构图，又不至于让 state 变大或者场景卡住。 */
export const MAX_STAGE_PROPS = 24

export const DEFAULT_DIRECTOR_STAGE_STATE: DirectorStageState = {
  camera: {
    // 默认站在人物正前方稍偏、比腰高一点往下看一点 —— 打开就是一个能用的机位，
    // 不是「相机在原点、人在脚底下」那种要先转半分钟的初始状态。
    yaw: 18,
    pitch: 6,
    distance: 4.2,
    target: [0, 0.95, 0],
    focalMm: 50,
  },
  pose: {},
  props: [],
  scene: {
    groundVisible: true,
    gridVisible: true,
    backdropVisible: true,
    backdropColor: '#1b1b22',
    groundColor: '#33333d',
  },
  ratio: '16:9',
  resolution: '2K',
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function finite(value: unknown, fallback: number) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

/** 坐标一律砍到 4 位小数：0.1mm 级别的精度，足够构图，又不让 JSON 里躺一串 17 位浮点。 */
export function roundCoord(value: unknown, fallback = 0) {
  return Math.round(finite(value, fallback) * 1e4) / 1e4
}

function readVec3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  const list = Array.isArray(value) ? value : []
  return [
    roundCoord(list[0], fallback[0]),
    roundCoord(list[1], fallback[1]),
    roundCoord(list[2], fallback[2]),
  ]
}

export function normalizeHexColor(value: unknown, fallback: string) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return HEX_COLOR.test(raw) ? raw.toLowerCase() : fallback
}

export function normalizeRatio(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return (DIRECTOR_RATIO_OPTIONS as readonly string[]).includes(raw)
    ? raw
    : DEFAULT_DIRECTOR_STAGE_STATE.ratio
}

export function normalizeResolution(value: unknown) {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return (DIRECTOR_RESOLUTION_OPTIONS as readonly string[]).includes(raw)
    ? raw
    : DEFAULT_DIRECTOR_STAGE_STATE.resolution
}

export function normalizeCamera(value: unknown): StageCamera {
  const source = (value ?? {}) as Record<string, unknown>
  const fallback = DEFAULT_DIRECTOR_STAGE_STATE.camera
  // 先过 finite 再钳制：`?? fallback` 只兜 null/undefined，兜不住 'abc' 这种脏字符串 ——
  // 那种值会被下游当成 0，表现是「打开节点相机莫名归位」而不是回落到默认机位。
  return {
    yaw: roundCoord(normalizeYawDeg(finite(source.yaw, fallback.yaw))),
    pitch: roundCoord(clampPitchDeg(finite(source.pitch, fallback.pitch))),
    distance: roundCoord(clampOrbitDistance(finite(source.distance, fallback.distance))),
    target: readVec3(source.target, fallback.target),
    focalMm: roundCoord(clampFocalMm(finite(source.focalMm, fallback.focalMm))),
  }
}

/**
 * 姿势：**只留被改过的关节**，全 0 的直接丢掉。
 * 自然站立就是空对象，一个 state 里躺 21 个 [0,0,0] 纯属浪费。
 */
export function normalizePose(value: unknown): Pose {
  const source = (value ?? {}) as Record<string, unknown>
  const out: Pose = {}
  for (const [key, raw] of Object.entries(source)) {
    if (!isJointId(key)) continue
    const angles = clampJointAngles(key as JointId, raw)
    if (angles[0] === 0 && angles[1] === 0 && angles[2] === 0) continue
    out[key as JointId] = [roundCoord(angles[0]), roundCoord(angles[1]), roundCoord(angles[2])]
  }
  return out
}

export function normalizeProp(value: unknown, index: number): StageProp | null {
  const source = (value ?? {}) as Record<string, unknown>
  const kind: PropKind = source.kind === 'cylinder' ? 'cylinder' : 'box'
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim().slice(0, 40) : `prop-${index + 1}`
  const scale = readVec3(source.scale, [1, 1, 1])
  return {
    id,
    kind,
    position: readVec3(source.position, [0, 0.5, 0]),
    rotation: readVec3(source.rotation, [0, 0, 0]),
    // 缩放不许为 0 或负数 —— three 会算出退化矩阵，物体直接消失且没有任何报错
    scale: [
      Math.min(20, Math.max(0.02, scale[0])),
      Math.min(20, Math.max(0.02, scale[1])),
      Math.min(20, Math.max(0.02, scale[2])),
    ],
  }
}

export function normalizeProps(value: unknown): StageProp[] {
  const list = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const out: StageProp[] = []
  for (const [index, item] of list.entries()) {
    if (out.length >= MAX_STAGE_PROPS) break
    const prop = normalizeProp(item, index)
    if (!prop) continue
    // id 撞了就顺一个新的：界面按 id 选中和删除，重复 id 会一删两个
    let id = prop.id
    let bump = 2
    while (seen.has(id)) id = `${prop.id}-${bump++}`
    seen.add(id)
    out.push({ ...prop, id })
  }
  return out
}

export function normalizeScene(value: unknown): StageScene {
  const source = (value ?? {}) as Record<string, unknown>
  const fallback = DEFAULT_DIRECTOR_STAGE_STATE.scene
  const bool = (key: keyof StageScene, defaultValue: boolean) =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : defaultValue
  return {
    groundVisible: bool('groundVisible', fallback.groundVisible),
    gridVisible: bool('gridVisible', fallback.gridVisible),
    backdropVisible: bool('backdropVisible', fallback.backdropVisible),
    backdropColor: normalizeHexColor(source.backdropColor, fallback.backdropColor),
    groundColor: normalizeHexColor(source.groundColor, fallback.groundColor),
  }
}

export function normalizeDirectorStageState(value: unknown): DirectorStageState {
  const source = (value ?? {}) as Record<string, unknown>
  return {
    camera: normalizeCamera(source.camera),
    pose: normalizePose(source.pose),
    props: normalizeProps(source.props),
    scene: normalizeScene(source.scene),
    ratio: normalizeRatio(source.ratio),
    resolution: normalizeResolution(source.resolution),
  }
}

/**
 * 从节点 params 里把状态读出来。读不到 / 读坏了都回落到默认，**永不抛**。
 * 节点打不开比姿势丢了严重得多。
 */
export function readDirectorStageState(params: unknown): DirectorStageState {
  try {
    const source = (params ?? {}) as Record<string, unknown>
    return normalizeDirectorStageState(source.stage)
  } catch {
    return normalizeDirectorStageState(undefined)
  }
}

/** 写回 params 时用：只动 `stage` 这一个键，别的（比如引用列表）原样保留。 */
export function writeDirectorStageState(params: unknown, state: DirectorStageState) {
  const source = (params ?? {}) as Record<string, unknown>
  return { ...source, stage: normalizeDirectorStageState(state) }
}

export function makeStagePropId(existing: StageProp[], kind: PropKind) {
  const used = new Set(existing.map((prop) => prop.id))
  let index = existing.length + 1
  let id = `${kind}-${index}`
  while (used.has(id)) id = `${kind}-${++index}`
  return id
}

/** 新道具默认落在人物前方一点、贴地。直接生在人身上会看不见。 */
export function makeStageProp(existing: StageProp[], kind: PropKind): StageProp {
  return {
    id: makeStagePropId(existing, kind),
    kind,
    position: [0.6 + existing.length * 0.1, kind === 'cylinder' ? 0.5 : 0.25, 0.5],
    rotation: [0, 0, 0],
    scale: kind === 'cylinder' ? [0.3, 1, 0.3] : [0.6, 0.5, 0.6],
  }
}
