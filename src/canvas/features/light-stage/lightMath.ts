import type { LightStageAnchor, LightStageLightConfig, LightStageVector3 } from './types'

export interface LightStageAnchorDefinition {
  value: LightStageAnchor
  label: string
  group: 'cardinal' | 'upper' | 'middle' | 'lower'
  vector: LightStageVector3
}

const normalized = (x: number, y: number, z: number): LightStageVector3 => {
  const length = Math.hypot(x, y, z) || 1
  return { x: x / length, y: y / length, z: z / length }
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

export const LIGHT_STAGE_ANCHOR_DEFINITIONS: LightStageAnchorDefinition[] = [
  { value: 'front', label: '前方', group: 'cardinal', vector: normalized(0, 0, 1) },
  { value: 'back', label: '后方', group: 'cardinal', vector: normalized(0, 0, -1) },
  { value: 'left', label: '左侧', group: 'cardinal', vector: normalized(-1, 0, 0) },
  { value: 'right', label: '右侧', group: 'cardinal', vector: normalized(1, 0, 0) },
  { value: 'top', label: '顶部', group: 'cardinal', vector: normalized(0, 1, 0) },
  { value: 'bottom', label: '底部', group: 'cardinal', vector: normalized(0, -1, 0) },
  { value: 'front-left', label: '左前', group: 'middle', vector: normalized(-1, 0, 1) },
  { value: 'front-right', label: '右前', group: 'middle', vector: normalized(1, 0, 1) },
  { value: 'back-left', label: '左后', group: 'middle', vector: normalized(-1, 0, -1) },
  { value: 'back-right', label: '右后', group: 'middle', vector: normalized(1, 0, -1) },
  { value: 'top-front', label: '上前', group: 'upper', vector: normalized(0, 1, 1) },
  { value: 'top-back', label: '上后', group: 'upper', vector: normalized(0, 1, -1) },
  { value: 'top-left', label: '左上', group: 'upper', vector: normalized(-1, 1, 0) },
  { value: 'top-right', label: '右上', group: 'upper', vector: normalized(1, 1, 0) },
  { value: 'top-front-left', label: '左上前', group: 'upper', vector: normalized(-1, 1, 1) },
  { value: 'top-front-right', label: '右上前', group: 'upper', vector: normalized(1, 1, 1) },
  { value: 'top-back-left', label: '左上后', group: 'upper', vector: normalized(-1, 1, -1) },
  { value: 'top-back-right', label: '右上后', group: 'upper', vector: normalized(1, 1, -1) },
  { value: 'bottom-front', label: '下前', group: 'lower', vector: normalized(0, -1, 1) },
  { value: 'bottom-back', label: '下后', group: 'lower', vector: normalized(0, -1, -1) },
  { value: 'bottom-left', label: '左下', group: 'lower', vector: normalized(-1, -1, 0) },
  { value: 'bottom-right', label: '右下', group: 'lower', vector: normalized(1, -1, 0) },
  { value: 'bottom-front-left', label: '左下前', group: 'lower', vector: normalized(-1, -1, 1) },
  { value: 'bottom-front-right', label: '右下前', group: 'lower', vector: normalized(1, -1, 1) },
  { value: 'bottom-back-left', label: '左下后', group: 'lower', vector: normalized(-1, -1, -1) },
  { value: 'bottom-back-right', label: '右下后', group: 'lower', vector: normalized(1, -1, -1) },
]

export const LIGHT_STAGE_ANCHOR_BY_ID = Object.fromEntries(
  LIGHT_STAGE_ANCHOR_DEFINITIONS.map((anchor) => [anchor.value, anchor]),
) as Record<LightStageAnchor, LightStageAnchorDefinition>

export function rotateVector(vector: LightStageVector3, rotation?: Partial<LightStageVector3>): LightStageVector3 {
  const rx = (Number(rotation?.x) || 0) * Math.PI / 180
  const ry = (Number(rotation?.y) || 0) * Math.PI / 180
  const rz = (Number(rotation?.z) || 0) * Math.PI / 180

  let x = vector.x
  let y = vector.y
  let z = vector.z

  const cosX = Math.cos(rx)
  const sinX = Math.sin(rx)
  ;[y, z] = [y * cosX - z * sinX, y * sinX + z * cosX]

  const cosY = Math.cos(ry)
  const sinY = Math.sin(ry)
  ;[x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY]

  const cosZ = Math.cos(rz)
  const sinZ = Math.sin(rz)
  ;[x, y] = [x * cosZ - y * sinZ, x * sinZ + y * cosZ]

  return normalized(x, y, z)
}

export function lightDirection(anchor: LightStageAnchor, rotation?: Partial<LightStageVector3>, direction?: Partial<LightStageVector3>) {
  const directionLength = Math.hypot(Number(direction?.x) || 0, Number(direction?.y) || 0, Number(direction?.z) || 0)
  const vector = directionLength > 0.001
    ? normalized(Number(direction?.x) || 0, Number(direction?.y) || 0, Number(direction?.z) || 1)
    : LIGHT_STAGE_ANCHOR_BY_ID[anchor]?.vector ?? LIGHT_STAGE_ANCHOR_BY_ID.front.vector
  return rotateVector(vector, rotation)
}

export function lightPosition(
  anchor: LightStageAnchor,
  offset: LightStageVector3,
  radius = 3.1,
  rotation?: Partial<LightStageVector3>,
  direction?: Partial<LightStageVector3>,
) {
  const vector = lightDirection(anchor, rotation, direction)
  return {
    x: vector.x * radius + (offset.x / 100) * 1.2,
    y: vector.y * radius + (offset.y / 100) * 1.2,
    z: vector.z * radius + (offset.z / 100) * 1.2,
  }
}

export function lightAttenuationRatio(value: unknown, fallback = 48) {
  const next = Number(value)
  return clamp01((Number.isFinite(next) ? next : fallback) / 100)
}

export function directionalLightFootprint(light: LightStageLightConfig, u: number, v: number) {
  const attenuation = lightAttenuationRatio(light.attenuation, 22)
  if (attenuation <= 0.001) return 1

  const vector = lightDirection(light.anchor, light.rotation, light.direction)
  const centerU = 0.5 + (Number(light.offset?.x) || 0) / 280
  const centerV = 0.5 - (Number(light.offset?.y) || 0) / 280
  const axisX = vector.x
  const axisY = -vector.y
  const axisLength = Math.hypot(axisX, axisY)
  let lightSide = 0.5

  if (axisLength > 0.025) {
    const signed = ((u - centerU) * axisX + (v - centerV) * axisY) / axisLength
    lightSide = clamp01(0.5 + signed / 0.72)
  } else {
    const distance = Math.hypot(u - centerU, v - centerV)
    lightSide = 1 - clamp01(distance / 0.76)
  }

  const smoothLightSide = lightSide * lightSide * (3 - 2 * lightSide)
  const minimumReach = 1 - attenuation * 0.78
  return clamp01(minimumReach + (1 - minimumReach) * smoothLightSide)
}

export function nearestAnchor(vector: LightStageVector3) {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1
  const unit = { x: vector.x / length, y: vector.y / length, z: vector.z / length }
  let best = LIGHT_STAGE_ANCHOR_DEFINITIONS[0]
  let score = -Infinity
  for (const anchor of LIGHT_STAGE_ANCHOR_DEFINITIONS) {
    const next = unit.x * anchor.vector.x + unit.y * anchor.vector.y + unit.z * anchor.vector.z
    if (next > score) {
      score = next
      best = anchor
    }
  }
  return best
}

export function hexToSrgb(hex: string) {
  const normalizedHex = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ffffff'
  return {
    r: parseInt(normalizedHex.slice(1, 3), 16),
    g: parseInt(normalizedHex.slice(3, 5), 16),
    b: parseInt(normalizedHex.slice(5, 7), 16),
  }
}

export function colorTemperatureEstimate(hex: string) {
  const { r, g, b } = hexToSrgb(hex)
  if (b > r * 1.12) return { kelvin: 8500, label: '冷蓝' }
  if (r > b * 1.35 && g > b * 1.12) return { kelvin: 3200, label: '暖钨丝' }
  if (r > b * 1.12) return { kelvin: 4300, label: '暖白' }
  if (g > r * 1.12 && g > b * 1.05) return { kelvin: 5600, label: '偏绿日光' }
  return { kelvin: 5600, label: '中性日光' }
}
