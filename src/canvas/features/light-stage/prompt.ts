import { colorTemperatureEstimate, hexToSrgb, lightDirection, LIGHT_STAGE_ANCHOR_BY_ID, lightPosition } from './lightMath'
import { lightStagePlaneLayout } from './light-stage-layout'
import type { LightStageLightConfig, LightStageLightType, LightStageState } from './types'

const TYPE_LABELS: Record<LightStageLightType, string> = {
  directional: '平行方向照明',
  spot: '聚束方向照明',
  area: '大面积柔和照明',
  point: '局部扩散照明',
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 50
  return Math.round(Math.max(-30, Math.min(130, value * 100)))
}

function sideLabel(x: number, y: number) {
  const horizontal = x < 0.08 ? '左侧' : x > 0.92 ? '右侧' : ''
  const vertical = y < 0.08 ? '上方' : y > 0.92 ? '下方' : ''
  return `${vertical}${horizontal}` || '正前方'
}

function offFrameEmitterPlacement(light: LightStageLightConfig, state: LightStageState) {
  const layout = lightStagePlaneLayout(state.geometry?.width, state.geometry?.height)
  const position = lightPosition(light.anchor, light.offset, 3.1, light.rotation, light.direction)
  const projection = {
    x: 0.5 + position.x / Math.max(0.001, layout.width),
    y: 0.5 - position.y / Math.max(0.001, layout.height),
  }
  const direction = {
    x: projection.x - 0.5,
    y: projection.y - 0.5,
  }
  const directionLength = Math.hypot(direction.x, direction.y)
  if (directionLength < 0.015) {
    const lightAxis = lightDirection(light.anchor, light.rotation, light.direction)
    const frontBack = lightAxis.z >= 0 ? '镜头前方画框外' : '主体背后画框外'
    return `控制器投影接近画面中心；真实不可见发射位置沿 Z 轴外推到${frontBack}，不在画面内部。`
  }

  const scaleCandidates = [
    direction.x > 0 ? (1 - 0.5) / direction.x : direction.x < 0 ? (0 - 0.5) / direction.x : Infinity,
    direction.y > 0 ? (1 - 0.5) / direction.y : direction.y < 0 ? (0 - 0.5) / direction.y : Infinity,
  ].filter((value) => Number.isFinite(value) && value > 0)
  const edgeScale = Math.min(...scaleCandidates)
  const margin = 0.11
  const outside = {
    x: 0.5 + direction.x * (edgeScale + margin),
    y: 0.5 + direction.y * (edgeScale + margin),
  }
  return `控制器投影约在画面 ${clampPercent(projection.x)}%, ${clampPercent(projection.y)}%；真实不可见发射位置必须沿中心到该投影点的轴向继续外推到画框外${sideLabel(outside.x, outside.y)}，约 ${clampPercent(outside.x)}%, ${clampPercent(outside.y)}%，不在画面内部。`
}

function lightInstruction(name: string, light: LightStageLightConfig, state: LightStageState) {
  if (!light.enabled || light.intensity <= 0) return null
  const rgb = hexToSrgb(light.color)
  const temperature = colorTemperatureEstimate(light.color)
  const anchor = LIGHT_STAGE_ANCHOR_BY_ID[light.anchor]
  const direction = lightDirection(light.anchor, light.rotation, light.direction)
  const shape = light.type === 'area'
    ? `柔光覆盖宽度权重 ${Math.round(light.width)}、高度权重 ${Math.round(light.height)}、滚转 ${Math.round(light.roll)} 度；这些只控制光照范围，不代表可见灯板形状`
    : light.type === 'spot'
      ? `圆形锥角 ${Math.round(light.coneAngle)} 度，边缘柔度 ${Math.round(light.softness)}%`
    : light.type === 'point'
        ? `球形衰减，作用范围 ${Math.round(light.distance)}%`
        : `平行光束，朝向主体中心；衰减控制沿光源方向到画面远侧的明暗过渡，数值越高远侧越弱、受光边界越明显`
  const rotation = `XYZ 旋转 (${Math.round(light.rotation.x)}°, ${Math.round(light.rotation.y)}°, ${Math.round(light.rotation.z)}°)`
  const offset = `XYZ 位移 (${Math.round(light.offset.x)}, ${Math.round(light.offset.y)}, ${Math.round(light.offset.z)})`
  const placement = offFrameEmitterPlacement(light, state)
  return `${name}：${TYPE_LABELS[light.type]}，只作为画外不可见照明效果；球面锚点“${anchor.label}”，连续方向向量 (${direction.x.toFixed(3)}, ${direction.y.toFixed(3)}, ${direction.z.toFixed(3)})，${placement}光照参数：${shape}，${rotation}，${offset}，强度 ${Math.round(light.intensity)}%，衰减 ${Math.round(light.attenuation)}%，颜色 ${light.color}，精确 sRGB(${rgb.r}, ${rgb.g}, ${rgb.b})，约 ${temperature.kelvin}K ${temperature.label}。`
}

function ratioInstruction(ratio: string, resolution: string) {
  const aspect = ratio === 'auto' ? '严格保持参考图原始宽高比' : `原生生成 ${ratio} 宽高比`
  return `${aspect}，目标清晰度 ${resolution}。禁止后期拉伸、压扁、裁剪、补边或用低分辨率结果冒充。`
}

export function compileLightStagePrompt(input: {
  sourceName?: string
  state: LightStageState
  ratio: string
  resolution: string
}) {
  const { sourceName, state, ratio, resolution } = input
  const enabledLights = [
    lightInstruction('主光', state.main, state),
    lightInstruction('辅光', state.fill, state),
  ].filter(Boolean)
  if (state.ambient.enabled && state.ambient.intensity > 0) {
    const rgb = hexToSrgb(state.ambient.color)
    const temperature = colorTemperatureEstimate(state.ambient.color)
    enabledLights.push(`环境光：非位置全局光，强度 ${Math.round(state.ambient.intensity)}%，颜色 ${state.ambient.color}，精确 sRGB(${rgb.r}, ${rgb.g}, ${rgb.b})，约 ${temperature.kelvin}K ${temperature.label}。`)
  }

  return [
    `基于参考图${sourceName ? `《${sourceName}》` : ''}执行受约束的专业 Light Stage 灯光重塑。`,
    '这是图像重打光任务，不是新增布光道具。只能改变已有画面的明暗、阴影、反射、色温和受光层次，不能新增任何可见物体。',
    '硬性失败条件：最终图中出现可见灯板、发光矩形、灯罩、摄影灯、灯架、光源球、光源点、光束起点、UI 控制器或其它新增发光道具，都视为错误结果。',
    '参考素材按固定顺序提供：1 原图，2 去光照漫反射近似，3 法线，4 16 位深度，5 单色灯光范围遮罩。后四项只用于几何、受光范围和灯光方向约束，不得当作画面内容。',
    '先中和原图中明显的方向性光照和硬阴影，再按以下启用的灯光重新建立光照。没有列出的灯光必须保持为零，不得自行补光。',
    '三维预览里的灯体和发射点只是交互控制器，不是画面内容；如果控制器显示在画面内部，必须沿它相对主体中心的轴向继续外推到画框外作为真实不可见光源。',
    ratioInstruction(ratio, resolution),
    ...enabledLights,
    state.rimLight
      ? '加入克制、连续的轮廓光，只分离主体边缘，不产生夸张光环。'
      : '不要额外加入轮廓光、逆光光环或无参数依据的发光边。',
    state.smartMode
      ? '允许修复重打光产生的边缘、阴影、反射和材质响应，但不得改变身份、脸、发型、服装、身体比例、姿态、镜头、构图、背景结构和画面文字。'
      : '严格执行灯光参数，只修改照明、阴影、明暗层次、反射和色温，不改变任何结构与局部细节。',
    '保持原图材质、纹理、景深、镜头语言、细节和清晰度；不要增加无关主体、水印、边框、UI 或参数文字。只输出最终重打光图像。',
  ].join('\n')
}
