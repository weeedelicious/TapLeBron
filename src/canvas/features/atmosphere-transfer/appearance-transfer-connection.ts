import type { WorkflowNodeData } from '../canvas/workflow-types'

export const APPEARANCE_SOURCE_HANDLE = 'appearance-source'
export const APPEARANCE_REFERENCE_HANDLE = 'appearance-reference'

export type AppearanceInputHandle =
  | typeof APPEARANCE_SOURCE_HANDLE
  | typeof APPEARANCE_REFERENCE_HANDLE

export function isAppearanceTransferNode(data?: Pick<WorkflowNodeData, 'settings'> | null) {
  return (
    data?.settings?.actionType === 'appearance-transfer' ||
    data?.settings?.imageEditMode === 'appearance-transfer'
  )
}

export function resolveAppearanceInputHandle(
  settings: Record<string, string> | undefined,
  sourceNodeId: string,
  requestedTargetHandle?: string,
): AppearanceInputHandle {
  if (requestedTargetHandle === APPEARANCE_SOURCE_HANDLE) return APPEARANCE_SOURCE_HANDLE
  if (requestedTargetHandle === APPEARANCE_REFERENCE_HANDLE) return APPEARANCE_REFERENCE_HANDLE
  return sourceNodeId === settings?.sourceNodeId
    ? APPEARANCE_SOURCE_HANDLE
    : APPEARANCE_REFERENCE_HANDLE
}

export function getAppearanceSlotNodeId(
  settings: Record<string, string> | undefined,
  handle: AppearanceInputHandle,
) {
  return handle === APPEARANCE_SOURCE_HANDLE
    ? settings?.sourceNodeId
    : settings?.referenceNodeId
}

export function canAssignAppearanceInput(
  settings: Record<string, string> | undefined,
  sourceNodeId: string,
  handle: AppearanceInputHandle,
) {
  const oppositeNodeId =
    handle === APPEARANCE_SOURCE_HANDLE
      ? settings?.referenceNodeId
      : settings?.sourceNodeId
  return sourceNodeId !== oppositeNodeId
}

export function canConnectAppearanceInput(
  sourceData: Pick<WorkflowNodeData, 'type'> | null | undefined,
  targetData: Pick<WorkflowNodeData, 'settings'> | null | undefined,
  sourceNodeId: string,
  requestedTargetHandle?: string,
) {
  if (sourceData?.type !== 'image' || !isAppearanceTransferNode(targetData)) return false
  const targetHandle = resolveAppearanceInputHandle(
    targetData?.settings,
    sourceNodeId,
    requestedTargetHandle,
  )
  return canAssignAppearanceInput(targetData?.settings, sourceNodeId, targetHandle)
}

export function assignAppearanceInput(
  settings: Record<string, string> | undefined,
  sourceNodeId: string,
  sourcePreviewUrl: string,
  handle: AppearanceInputHandle,
) {
  const next = { ...(settings ?? {}) }
  if (handle === APPEARANCE_SOURCE_HANDLE) {
    next.sourceNodeId = sourceNodeId
    next.appearanceSourcePreviewUrl = sourcePreviewUrl
  } else {
    next.referenceNodeId = sourceNodeId
    next.appearanceReferencePreviewUrl = sourcePreviewUrl
  }

  next.imageReferenceIds = [next.sourceNodeId, next.referenceNodeId]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join(',')

  return next
}
