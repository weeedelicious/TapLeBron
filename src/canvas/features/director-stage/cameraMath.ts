/**
 * 三维空间节点的镜头数学。全是纯函数 —— jsdom 里跑不了 WebGL，
 * 所以「视角能自由变换 + 能变焦距」这件事的正确性必须住在这里、能单测。
 *
 * 焦距用**35mm 全画幅**换算（感光面 36×24mm）。为什么不直接暴露 FOV：
 * 摄影和分镜的人说的是「35mm 广一点、85mm 拍脸」，不是「垂直视场角 28.8 度」。
 * three 的 PerspectiveCamera.fov 是**垂直**视场角，所以用 24mm 那一边换算。
 */

/** 35mm 全画幅感光面。焦距换算的唯一基准，改这里等于改成别的画幅。 */
export const SENSOR_WIDTH_MM = 36
export const SENSOR_HEIGHT_MM = 24

/** 焦距范围。14mm 以下畸变得没法当构图参考，200mm 以上轨道推拉已经没意义。 */
export const MIN_FOCAL_MM = 14
export const MAX_FOCAL_MM = 200

/** 常用镜头。分镜里最常说的就这几个。 */
export const FOCAL_PRESETS_MM = [24, 35, 50, 85, 135] as const

/** 俯仰限制：正负 89 度。到 90 度时相机正上/正下看，OrbitControls 的 up 向量会翻，画面会跳。 */
export const MAX_PITCH_DEG = 89

export const MIN_ORBIT_DISTANCE = 0.4
export const MAX_ORBIT_DISTANCE = 40

const DEG = Math.PI / 180

function finite(value: unknown, fallback: number) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

export function clampFocalMm(value: unknown) {
  return Math.min(MAX_FOCAL_MM, Math.max(MIN_FOCAL_MM, finite(value, 50)))
}

export function clampPitchDeg(value: unknown) {
  return Math.min(MAX_PITCH_DEG, Math.max(-MAX_PITCH_DEG, finite(value, 0)))
}

export function clampOrbitDistance(value: unknown) {
  return Math.min(MAX_ORBIT_DISTANCE, Math.max(MIN_ORBIT_DISTANCE, finite(value, 4)))
}

/** yaw 归一化到 [0, 360)，转够一圈不会让数字一直涨。 */
export function normalizeYawDeg(value: unknown) {
  const raw = finite(value, 0) % 360
  return raw < 0 ? raw + 360 : raw
}

/**
 * 焦距 → three 的**垂直** FOV（度）。
 * 常见对照：24mm≈53.1°、35mm≈37.8°、50mm≈27.0°、85mm≈16.1°、135mm≈10.2°。
 */
export function focalToFovDeg(focalMm: unknown) {
  const focal = clampFocalMm(focalMm)
  return 2 * Math.atan(SENSOR_HEIGHT_MM / 2 / focal) / DEG
}

/** 垂直 FOV（度）→ 焦距。和 focalToFovDeg 互逆（在钳制范围内）。 */
export function fovDegToFocalMm(fovDeg: unknown) {
  const fov = Math.min(179, Math.max(0.1, finite(fovDeg, 27)))
  return clampFocalMm(SENSOR_HEIGHT_MM / 2 / Math.tan(fov * DEG / 2))
}

/**
 * 水平 FOV（度）。出图比例不是 3:2 时画面横向能看到多少由它决定，
 * 面板上要显示「等效 xx mm / 水平 xx°」才好判断构图。
 */
export function horizontalFovDeg(focalMm: unknown, aspect = SENSOR_WIDTH_MM / SENSOR_HEIGHT_MM) {
  const focal = clampFocalMm(focalMm)
  const safeAspect = finite(aspect, SENSOR_WIDTH_MM / SENSOR_HEIGHT_MM)
  const halfHeight = SENSOR_HEIGHT_MM / 2
  const halfWidth = halfHeight * (safeAspect > 0 ? safeAspect : 1)
  return 2 * Math.atan(halfWidth / focal) / DEG
}

export interface OrbitAngles {
  /** 水平角，度。0 = 从 +Z 方向看向目标（正面）。 */
  yaw: number
  /** 俯仰角，度。正数 = 相机在目标上方往下看。 */
  pitch: number
  /** 相机到目标的距离。 */
  distance: number
  /** 目标点（看哪儿）。 */
  target: [number, number, number]
}

/**
 * 轨道角度 → 相机世界坐标。
 *
 * 约定 yaw=0 / pitch=0 时相机在 +Z 上、与目标同高，也就是「正面平视」——
 * 白模面朝 +Z，所以默认机位就是看着脸，不用先转半圈才看得见人。
 */
export function orbitToPosition({ yaw, pitch, distance, target }: OrbitAngles): [number, number, number] {
  const yawRad = normalizeYawDeg(yaw) * DEG
  const pitchRad = clampPitchDeg(pitch) * DEG
  const radius = clampOrbitDistance(distance)
  const horizontal = radius * Math.cos(pitchRad)
  return [
    target[0] + horizontal * Math.sin(yawRad),
    target[1] + radius * Math.sin(pitchRad),
    target[2] + horizontal * Math.cos(yawRad),
  ]
}

/**
 * 相机世界坐标 → 轨道角度。OrbitControls 是自己改 camera.position 的，
 * 拖完之后要把结果读回状态里存库，就得靠这个反解。
 */
export function positionToOrbit(
  position: [number, number, number],
  target: [number, number, number],
): OrbitAngles {
  const dx = position[0] - target[0]
  const dy = position[1] - target[1]
  const dz = position[2] - target[2]
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (!(distance > 1e-6)) {
    return { yaw: 0, pitch: 0, distance: clampOrbitDistance(distance), target }
  }
  const horizontal = Math.sqrt(dx * dx + dz * dz)
  return {
    yaw: normalizeYawDeg(Math.atan2(dx, dz) / DEG),
    pitch: clampPitchDeg(Math.atan2(dy, horizontal) / DEG),
    distance: clampOrbitDistance(distance),
    target,
  }
}

/**
 * 出图像素尺寸。比例是 `宽:高` 字符串，分辨率是短边像素数 ——
 * 跟灯光台 / 全景截图一套口径，出来的图直接能当参考图喂给图片模型。
 */
export function captureSize(ratio: string, shortEdge: number) {
  const [rawW, rawH] = String(ratio).split(':')
  const w = finite(rawW, 1)
  const h = finite(rawH, 1)
  const aspect = w > 0 && h > 0 ? w / h : 1
  const short = Math.max(64, Math.round(finite(shortEdge, 1024)))
  if (aspect >= 1) {
    return { width: Math.round(short * aspect), height: short, aspect }
  }
  return { width: short, height: Math.round(short / aspect), aspect }
}
