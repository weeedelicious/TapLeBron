import { apiFetch } from './host-http'
import type { WorkflowFlowNode } from '../canvas/workflow-types'
import { appearanceBackendLabelFromRuntimeId } from './appearance-transfer-backends'
import type { AppearanceHistoryResult } from './appearance-transfer-history'

export type AppearanceHistoryApiItemV1 = {
  jobId: string
  candidateNodeId: string
  url: string
  mode: 'preserve-scene' | 'replace-background'
  createdAt: string
  backendId: string | null
  confirmed: boolean
  width: number | null
  height: number | null
  referenceAttached: boolean
  backgroundTransferMethod: 'semantic-generate' | 'reference-pixels'
  referencePersonAction: 'keep' | 'remove' | 'replace-pose'
  warningMessage: string | null
}

export type AppearanceHistoryPageV1 = {
  schemaVersion: 1
  items: AppearanceHistoryApiItemV1[]
  nextCursor: string | null
  unclassifiedCount: number
}

function normalizeProjectAssetUrl(value: string) {
  return value.replace(
    /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?=\/assets\/projects\/)/i,
    '',
  )
}

export function projectAppearanceHistoryResults(
  items: AppearanceHistoryApiItemV1[],
  nodes: WorkflowFlowNode[],
): AppearanceHistoryResult[] {
  const confirmedNodeIds = new Set(
    nodes
      .filter((node) => node.data.settings?.appearanceConfirmed === 'true')
      .map((node) => node.id),
  )
  return items.map((item) => ({
    id: item.candidateNodeId,
    jobId: item.jobId,
    url: normalizeProjectAssetUrl(item.url),
    mode: item.mode,
    createdAt: item.createdAt,
    backendLabel:
      item.backgroundTransferMethod === 'reference-pixels' &&
      item.referencePersonAction === 'keep'
        ? '本地像素合成'
        : appearanceBackendLabelFromRuntimeId(item.backendId),
    confirmed: item.confirmed || confirmedNodeIds.has(item.candidateNodeId),
    width: item.width,
    height: item.height,
    referenceAttached: item.referenceAttached,
    backgroundTransferMethod: item.backgroundTransferMethod,
    referencePersonAction: item.referencePersonAction,
    warningMessage: item.warningMessage,
  }))
}

export async function listAppearanceHistory(
  projectId: string,
  processorNodeId: string,
) {
  const query = new URLSearchParams({
    projectId,
    processorNodeId,
    limit: '100',
  })
  return apiFetch<AppearanceHistoryPageV1>(
    `/api/v1/image-features/appearance-transfer/history?${query.toString()}`,
  )
}
