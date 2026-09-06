import type {
  AppearanceBackgroundTransferMethod,
  AppearanceLightingMode,
  AppearanceReferencePersonAction,
} from './appearance-transfer-types'

export type AppearanceHistoryResult = {
  id: string
  jobId?: string
  url: string
  mode: AppearanceLightingMode
  createdAt: string | null
  backendLabel: string
  confirmed: boolean
  width: number | null
  height: number | null
  referenceAttached: boolean
  backgroundTransferMethod: AppearanceBackgroundTransferMethod
  referencePersonAction: AppearanceReferencePersonAction
  warningMessage?: string | null
}

export function appearanceHistoryModeLabel(mode: AppearanceLightingMode) {
  return mode === 'preserve-scene'
    ? '保持场景迁移氛围'
    : '替换场景融入氛围'
}

export function appearanceHistoryResultLabel(
  result: AppearanceHistoryResult,
  index: number,
) {
  const timestamp = result.createdAt
    ? result.createdAt.slice(5, 16).replace('T', ' ')
    : `历史 ${index + 1}`
  return `${timestamp} · ${result.backendLabel}${
    result.mode === 'replace-background'
      ? result.backgroundTransferMethod === 'reference-pixels'
        ? result.referencePersonAction === 'remove'
          ? ' · 参考图背景 · 已清除参考主体 · 已融合原图主体'
          : result.referencePersonAction === 'replace-pose'
            ? ' · 参考 Pose 替换'
            : ' · 参考图背景 · 原样合成'
        : ' · AI 生成换景'
      : result.referenceAttached
        ? ' · 实验参考'
        : ' · 标准'
  }${result.confirmed ? ' · 已输出' : ''}`
}
