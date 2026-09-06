import { defaultImageParams } from './nodeData'
import type { ImageParams, NodeRef } from './types'

export const MULTI_CAMERA_GRID_PROMPT = `基于参考图生成一张 3x3 多机位九宫格分镜图。
保持同一个角色、服装、场景、夜晚蓝色幽光、魔法光效和整体电影质感一致。
九个画面分别展示不同镜头语言：
1 远景环境
2 全景人物与环境
3 中景主角
4 侧面构图
5 正面英雄镜头
6 近景表情
7 特写脸部
8 俯视角
9 低角度仰拍
每一格都是 16:9 电影画幅，用细白线分隔成整齐九宫格。
不要改变角色身份，不要增加无关主体。
不要镜头语言的文字描述`

export const MULTI_CAMERA_GRID_RATIOS = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  '21:9',
]

export const MULTI_CAMERA_GRID_RESOLUTIONS = ['1K', '2K', '4K']

const RATIO_DEFINITIONS = [
  { value: '1:1', w: 1, h: 1 },
  { value: '16:9', w: 16, h: 9 },
  { value: '9:16', w: 9, h: 16 },
  { value: '4:3', w: 4, h: 3 },
  { value: '3:4', w: 3, h: 4 },
  { value: '3:2', w: 3, h: 2 },
  { value: '2:3', w: 2, h: 3 },
  { value: '4:5', w: 4, h: 5 },
  { value: '5:4', w: 5, h: 4 },
  { value: '21:9', w: 21, h: 9 },
]

export function normalizeMultiCameraGridRatio(ratio?: string) {
  const value = String(ratio || '').trim()
  return MULTI_CAMERA_GRID_RATIOS.includes(value) ? value : '16:9'
}

export function inferMultiCameraGridRatio(width?: number, height?: number, fallback?: string) {
  const safeWidth = Math.round(Number(width))
  const safeHeight = Math.round(Number(height))
  if (safeWidth > 0 && safeHeight > 0) {
    const matchedRatio = RATIO_DEFINITIONS.find((ratio) => safeWidth * ratio.h === safeHeight * ratio.w)
    if (matchedRatio) return matchedRatio.value
  }
  return normalizeMultiCameraGridRatio(fallback)
}

export function makeMultiCameraGridParams(
  sourceRef: NodeRef,
  ratio: string,
  resolution: string
): ImageParams {
  const base = defaultImageParams()
  return {
    ...base,
    prompt: MULTI_CAMERA_GRID_PROMPT,
    model: 'gpt-image-2',
    count: 1,
    modeType: 'image2image',
    settings: {
      ...base.settings,
      quality: 'auto',
      ratio: normalizeMultiCameraGridRatio(ratio),
      resolution: MULTI_CAMERA_GRID_RESOLUTIONS.includes(resolution) ? resolution : '1K',
    },
    imageList: [sourceRef],
    imageListOrder: [sourceRef.nodeId],
    advancedSettings: {
      ...(base.advancedSettings ?? {}),
      multiCameraGrid: {
        sourceNodeId: sourceRef.nodeId,
        updatedAtMs: Date.now(),
      },
    },
  }
}
