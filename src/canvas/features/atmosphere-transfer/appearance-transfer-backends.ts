import { getModelCapability } from './model-capabilities'

export type AppearanceCapabilityStatus =
  | 'available'
  | 'checking'
  | 'unavailable'
  | 'planned'
  | 'rebuilding'

export type AppearanceBackendStageRole = 'finalizer' | 'legacy-reference-solver'
export type AppearanceBackendGroup = '云端 API' | '本地模型'

type AppearanceBackendDefinition = {
  label: string
  group: AppearanceBackendGroup
  stageRole: AppearanceBackendStageRole
  jobCollection: 'executions' | 'local-jobs' | 'reference-jobs'
  capabilityId: string
  availability: AppearanceCapabilityStatus
  selectable: boolean
  local: boolean
  nonCommercial?: boolean
  reason?: string
}

export const APPEARANCE_BACKEND_DEFINITIONS = {
  'ic-light-marigold-reference': {
    label: 'IC-Light + Marigold｜历史参考解算',
    group: '本地模型',
    stageRole: 'legacy-reference-solver',
    jobCollection: 'reference-jobs',
    capabilityId: 'relighting.reference-transfer',
    availability: 'rebuilding',
    selectable: false,
    local: true,
    nonCommercial: true,
    reason: '实验链已停用，仅保留历史任务诊断。',
  },
  'gemini-3-pro-image-preview': {
    label: 'Nano Banana Pro',
    group: '云端 API',
    stageRole: 'finalizer',
    jobCollection: 'executions',
    capabilityId: 'image-edit',
    availability: 'available',
    selectable: true,
    local: false,
  },
  'gpt-image-2': {
    label: 'Image 2.0',
    group: '云端 API',
    stageRole: 'finalizer',
    jobCollection: 'executions',
    capabilityId: 'image-edit',
    availability: 'available',
    selectable: true,
    local: false,
  },
  'flux-2-klein-4b-fp8': {
    label: 'FLUX 4B',
    group: '本地模型',
    stageRole: 'finalizer',
    jobCollection: 'local-jobs',
    capabilityId: 'relighting.local',
    availability: 'checking',
    selectable: true,
    local: true,
    nonCommercial: true,
    reason: '正在检测本地 FLUX.2 Klein 4B 运行能力…',
  },
} as const satisfies Record<string, AppearanceBackendDefinition>

export type AppearanceBackendId = keyof typeof APPEARANCE_BACKEND_DEFINITIONS
export type AppearanceFinalizerBackendId = {
  [Id in AppearanceBackendId]:
    typeof APPEARANCE_BACKEND_DEFINITIONS[Id]['stageRole'] extends 'finalizer'
      ? Id
      : never
}[AppearanceBackendId]

export type AppearanceBackendOption = {
  id: AppearanceFinalizerBackendId
  label: string
  group: AppearanceBackendGroup
  status: AppearanceCapabilityStatus
  reason?: string | null
  nonCommercial?: boolean
}

export const DEFAULT_APPEARANCE_FINALIZER_ID: AppearanceFinalizerBackendId =
  'gemini-3-pro-image-preview'

const appearanceBackendIds = Object.keys(
  APPEARANCE_BACKEND_DEFINITIONS,
) as AppearanceBackendId[]

export function isAppearanceBackendId(value: unknown): value is AppearanceBackendId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(APPEARANCE_BACKEND_DEFINITIONS, value)
  )
}

export function isAppearanceFinalizerBackendId(
  value: unknown,
): value is AppearanceFinalizerBackendId {
  return (
    isAppearanceBackendId(value) &&
    APPEARANCE_BACKEND_DEFINITIONS[value].stageRole === 'finalizer'
  )
}

export function getAppearanceBackendDefinition(id: AppearanceBackendId) {
  return APPEARANCE_BACKEND_DEFINITIONS[id]
}

export function appearanceBackendLabel(id: AppearanceBackendId | null | undefined) {
  return id ? APPEARANCE_BACKEND_DEFINITIONS[id].label : '未选择最终处理器'
}

export function appearanceBackendLabelFromRuntimeId(
  runtimeId: string | null | undefined,
) {
  const normalized = runtimeId?.trim()
  if (!normalized) return appearanceBackendLabel(undefined)
  const matchedId = appearanceBackendIds.find((id) => {
    if (id === normalized) return true
    return getModelCapability(id).resolvedModel === normalized
  })
  return matchedId
    ? appearanceBackendLabel(matchedId)
    : normalized
}

function providerStatus(modelId: AppearanceFinalizerBackendId): {
  status: AppearanceCapabilityStatus
  reason: string | null
} {
  const definition = APPEARANCE_BACKEND_DEFINITIONS[modelId]
  if (definition.local) {
    return {
      status: definition.availability,
      reason: definition.reason ?? null,
    }
  }
  const capability = getModelCapability(modelId)
  return {
    status:
      capability.status === 'available'
        ? 'available'
        : capability.status === 'planned'
          ? 'planned'
          : 'unavailable',
    reason:
      capability.status === 'available'
        ? null
        : capability.notes || 'Provider Registry 标记为不可用',
  }
}

export function createAppearanceBackendOptions(): AppearanceBackendOption[] {
  return appearanceBackendIds
    .filter(isAppearanceFinalizerBackendId)
    .flatMap((id) => {
    const definition = APPEARANCE_BACKEND_DEFINITIONS[id]
    if (!definition.selectable) return []
    const readiness = providerStatus(id)
    return [{
      id,
      label: definition.label,
      group: definition.group,
      status: readiness.status,
      reason: readiness.reason,
      nonCommercial:
        'nonCommercial' in definition
          ? definition.nonCommercial
          : undefined,
    }]
  })
}

export const DEFAULT_APPEARANCE_BACKENDS = createAppearanceBackendOptions()
