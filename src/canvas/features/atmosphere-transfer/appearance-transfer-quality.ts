import { apiFetch } from './host-http'

export type AppearanceQualityDecision =
  | 'pass'
  | 'warn'
  | 'reject'
  | 'needs-calibration'

export type AppearanceQualityReportV1 = {
  decision: AppearanceQualityDecision
  blockingReasons: string[]
  warnings: string[]
  metricsVersion: 'appearance-quality-v1'
  sourceStructure: { status: string; reason?: string | null }
  subjectGeometry: { status: string; reason?: string | null }
  faceIdentity: { status: string; reason?: string | null }
  skinColor: { status: string; reason?: string | null }
  lightingDistance: { status: string; reason?: string | null }
  referenceLeakage: { status: string; reason?: string | null }
  outputDimensions: { status: string; reason?: string | null }
}

export type AppearanceQualityEvaluationResponseV1 = {
  report: AppearanceQualityReportV1
  reportUrl: string
  policyVersion: string
  resultUrl: string
  resultWidth: number
  resultHeight: number
  providerWidth: number
  providerHeight: number
  detailRestored: boolean
}

export type AppearanceQualityEvaluationInput = {
  projectId: string
  processorNodeId: string
  candidateNodeId: string
  sourceUrl: string
  resultUrl: string
  referenceUrl: string
  expectedWidth: number
  expectedHeight: number
  sourceSubjectMaskUrl?: string
  referenceAttached?: boolean
  lightingMode?: 'preserve-scene' | 'replace-background'
}

export function evaluateAppearanceCandidate(
  input: AppearanceQualityEvaluationInput,
) {
  return apiFetch<AppearanceQualityEvaluationResponseV1>(
    '/api/v1/image-features/appearance-transfer/quality-evaluations',
    {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 1,
        ...input,
      }),
    },
  )
}

const QUALITY_REASON_LABELS: Record<string, string> = {
  source_structure_changed: '原图构图或场景结构发生明显漂移',
  subject_geometry_changed: '人物位置、大小或轮廓发生明显变化',
  face_identity_changed: '人物面部结构发生明显变化',
  skin_color_invalid: '人物肤色出现异常色块或不连续',
  lighting_not_transferred: '结果只有滤色或灯光没有向参考目标靠近',
  reference_content_leaked: '结果复制了参考图内容',
  output_dimensions_mismatch: '输出比例不符合原图',
}

const QUALITY_WARNING_LABELS: Record<string, string> = {
  lighting_filter_only: '结果更像全局调色，空间灯光方向变化不足',
  quality_policy_not_calibrated: '部分质量指标尚未完成真实样本标定',
  reference_content_leakage_suspected:
    '实验结果在结构上过度接近参考图，请检查是否复制了人物、物体、文字、背景或构图',
  basic_subject_matte: '当前使用基础主体蒙版，发丝、透明物和复杂遮挡需放大检查',
  reference_foreground_removed: '参考图主要前景主体已由图片编辑模型清理，请检查背景补全痕迹',
  ordinary_pose_replacement: '当前是普通生成式 Pose 替换，请重点检查身份、脸手、服装、遮挡和背景边界',
  basic_subject_mask: 'Pose 替换只使用基础参考主体蒙版，不代表发丝级或像素级人物替换',
}

export function appearanceQualityWarningLabel(warning: string) {
  return QUALITY_WARNING_LABELS[warning] ?? warning
}

export function appearanceQualityReason(
  response: AppearanceQualityEvaluationResponseV1,
) {
  const labels = response.report.blockingReasons
    .map((reason) => QUALITY_REASON_LABELS[reason] ?? reason)
  if (response.report.decision === 'warn') {
    labels.push('质量检查发现风险；结果已保留，仍可输出或重新生成')
  } else if (response.report.decision === 'needs-calibration') {
    labels.push('质量策略尚未覆盖该结果；结果已保留，仍可输出或重新生成')
  }
  return labels.join('；') || '质量检查发现风险；结果已保留，仍可输出或重新生成'
}
