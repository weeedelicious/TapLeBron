import { apiFetch } from './host-http'
import { getModelsForCapability } from './model-capabilities'
import type {
  AppearanceAnalysisState,
  LightingDescriptorV1,
} from './appearance-transfer-types'

type LocalJob = {
  jobId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  artifacts: Array<{ kind: string; url: string }>
  errorCode?: string | null
  errorMessage?: string | null
  capability?: {
    backend?: string | null
  }
}

type SubjectLayerExport = {
  alphaUrl: string
  maskUrl: string
}

type SubjectLayers = {
  subjectMaskUrl: string
  subjectAlphaUrl?: string
  alphaModel?: string
  alphaReason?: string
}

type DescriptorJob = {
  jobId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  descriptor?: LightingDescriptorV1 | null
  descriptorHash?: string | null
  requestedModel: string
  resolvedModel: string
  schemaVersion: number
  promptVersion: number
  errorCode?: string | null
  errorMessage?: string | null
}

type DescriptorProgress = Pick<
  AppearanceAnalysisState,
  | 'descriptorStatus'
  | 'descriptorJobId'
  | 'descriptorHash'
  | 'descriptor'
  | 'analyzerModel'
  | 'analyzerResolvedModel'
  | 'analyzerSchemaVersion'
  | 'analyzerPromptVersion'
  | 'analyzerError'
>

const REFERENCE_DESCRIPTOR_CAPABILITY = 'lighting.reference-descriptor'

function referenceDescriptorModel() {
  const model = getModelsForCapability(REFERENCE_DESCRIPTOR_CAPABILITY)[0]
  if (!model) {
    throw new Error('没有已登记的参考光说明书分析器')
  }
  return model.id
}

const resolveUrl = (url: string) =>
  url.startsWith('/') || /^https?:/i.test(url) ? url : `/${url}`

function stableSubjectExportFingerprint(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function appearanceSubjectExportNodeId(
  processorNodeId: string,
  sourceAssetId: string,
  sourceUrl: string,
) {
  const safeProcessorId = processorNodeId
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const fingerprint = stableSubjectExportFingerprint(`${sourceAssetId}\n${sourceUrl}`)
  return `appearance-${safeProcessorId.slice(0, 98)}-${fingerprint}`.slice(0, 120)
}

async function waitForJob(
  job: LocalJob,
  signal: AbortSignal,
  jobUrl: (jobId: string) => string,
) {
  let current = job
  while (current.status === 'queued' || current.status === 'running') {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 350)
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
    current = await apiFetch<LocalJob>(
      jobUrl(current.jobId),
    )
  }
  if (current.status !== 'succeeded') {
    throw new Error(current.errorMessage || current.errorCode || '主体遮罩分析失败')
  }
  return current
}

async function requestSubjectMask(
  projectId: string,
  processorNodeId: string,
  sourceNodeId: string,
  sourceAssetId: string,
  sourceUrl: string,
  taskVersion: number,
  signal: AbortSignal,
  existing?: Pick<AppearanceAnalysisState, 'subjectMaskUrl' | 'subjectAlphaUrl' | 'alphaModel'>,
  refineAlpha = true,
): Promise<SubjectLayers> {
  let subjectMaskUrl = existing?.subjectMaskUrl
  if (existing?.subjectAlphaUrl) {
    return {
      subjectMaskUrl: resolveUrl(subjectMaskUrl || existing.subjectAlphaUrl),
      subjectAlphaUrl: resolveUrl(existing.subjectAlphaUrl),
      alphaModel: existing.alphaModel,
    }
  }
  if (!subjectMaskUrl) {
    const job = await apiFetch<LocalJob>('/api/v1/image-features/subject-matting/jobs', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        sourceNodeId,
        sourceAssetId,
        sourceUrl,
        taskScope: `appearance-transfer:${sourceNodeId}`,
        taskVersion,
        operation: 'segment',
        selection: { mode: 'automatic' },
        outputPrecision: 'preview',
      }),
    })
    const completed = await waitForJob(
      job,
      signal,
      (jobId) => `/api/v1/image-features/subject-matting/jobs/${encodeURIComponent(jobId)}`,
    )
    const previewArtifact = completed.artifacts.find((item) => item.kind === 'mask' || item.kind === 'alpha')
    if (!previewArtifact) throw new Error('主体分析未返回遮罩资产')
    const exportNodeId = appearanceSubjectExportNodeId(
      processorNodeId,
      sourceAssetId,
      sourceUrl,
    )
    let exported: SubjectLayerExport
    try {
      exported = await apiFetch<SubjectLayerExport>(
        `/api/v1/image-features/subject-matting/jobs/${encodeURIComponent(completed.jobId)}/export`,
        {
          method: 'POST',
          body: JSON.stringify({
            nodeId: exportNodeId,
            refinement: {
              edgeOffsetPx: 0,
              featherPx: 1.5,
              decontamination: 0,
              binaryThreshold: 128,
              removeWhiteFringe: false,
              removeBlackFringe: false,
              preserveHoles: true,
              strokes: [],
            },
          }),
        },
      )
    } catch (error: unknown) {
      const conflict = Boolean(
        error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 409 &&
        (
          !('responseBody' in error) ||
          typeof error.responseBody !== 'string' ||
          error.responseBody.includes('matting_export_conflict')
        ),
      )
      if (!conflict) throw error
      const existingAlphaUrl =
        `/assets/projects/${encodeURIComponent(projectId)}/derived/subject-matting/`
        + `${encodeURIComponent(exportNodeId)}/alpha.png`
      exported = {
        alphaUrl: existingAlphaUrl,
        maskUrl: existingAlphaUrl,
      }
    }
    subjectMaskUrl = resolveUrl(exported.alphaUrl || exported.maskUrl || previewArtifact.url)
  }
  if (!refineAlpha) return { subjectMaskUrl }
  try {
    const matte = await apiFetch<LocalJob>(
      '/api/v1/image-features/appearance-transfer/alpha-jobs',
      {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        processorNodeId,
        sourceAssetId,
        sourceUrl,
        baseMaskUrl: subjectMaskUrl,
        taskVersion,
      }),
      },
    )
    const matteCompleted = await waitForJob(
      matte,
      signal,
      (jobId) =>
        `/api/v1/image-features/appearance-transfer/alpha-jobs/${encodeURIComponent(jobId)}`,
    )
    const alphaArtifact = matteCompleted.artifacts.find((item) => item.kind === 'alpha')
    if (!alphaArtifact) throw new Error('发丝级 Alpha 分析未返回资产')
    return {
      subjectMaskUrl,
      subjectAlphaUrl: resolveUrl(alphaArtifact.url),
      alphaModel:
        matteCompleted.capability?.backend
        || 'hustvl/vitmatte-small-composition-1k',
    }
  } catch (error: unknown) {
    return {
      subjectMaskUrl,
      alphaReason: error instanceof Error ? error.message : '发丝级 alpha 能力未就绪',
    }
  }
}

function descriptorProgress(job: DescriptorJob): DescriptorProgress {
  const ready = job.status === 'succeeded' && Boolean(job.descriptor)
  const descriptorStatus =
    ready
      ? 'ready' as const
      : job.status === 'failed'
        || job.status === 'cancelled'
        || job.status === 'succeeded'
        ? 'failed' as const
        : job.status
  return {
    descriptorStatus,
    descriptorJobId: job.jobId,
    descriptorHash: job.descriptorHash ?? undefined,
    descriptor: job.descriptor ?? undefined,
    analyzerModel: job.requestedModel,
    analyzerResolvedModel: job.resolvedModel,
    analyzerSchemaVersion: job.schemaVersion,
    analyzerPromptVersion: job.promptVersion,
    analyzerError: job.errorMessage || job.errorCode || undefined,
  }
}

async function waitForDescriptorJob(
  initialJob: DescriptorJob,
  projectId: string,
  processorNodeId: string,
  signal: AbortSignal,
  onProgress?: (progress: DescriptorProgress) => void,
) {
  let current = initialJob
  onProgress?.(descriptorProgress(current))
  while (current.status === 'queued' || current.status === 'running') {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        window.clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const timer = window.setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, 500)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    current = await apiFetch<DescriptorJob>(
      `/api/v1/image-features/appearance-transfer/descriptor-jobs/${
        encodeURIComponent(projectId)
      }/${encodeURIComponent(processorNodeId)}/${encodeURIComponent(current.jobId)}`,
    )
    onProgress?.(descriptorProgress(current))
  }
  if (current.status !== 'succeeded' || !current.descriptor) {
    throw new Error(
      current.errorMessage
      || current.errorCode
      || '参考图没有生成有效的结构化光说明书',
    )
  }
  return descriptorProgress(current)
}

async function requestLightingDescriptor(
  input: {
    projectId: string
    processorNodeId: string
    referenceNodeId: string
    referenceAssetId: string
    referenceUrl: string
    signal: AbortSignal
    existingAnalysis?: AppearanceAnalysisState
    onProgress?: (progress: DescriptorProgress) => void
  },
): Promise<DescriptorProgress> {
  const analyzerModel = referenceDescriptorModel()
  const sameReference =
    input.existingAnalysis?.referenceAssetId === input.referenceAssetId
    && input.existingAnalysis?.referenceUrl === input.referenceUrl
  if (
    sameReference
    && input.existingAnalysis?.descriptorStatus === 'ready'
    && input.existingAnalysis.descriptor
    && input.existingAnalysis.analyzerModel === analyzerModel
  ) {
    const existing = {
      descriptorStatus: 'ready' as const,
      descriptorJobId: input.existingAnalysis.descriptorJobId,
      descriptorHash: input.existingAnalysis.descriptorHash,
      descriptor: input.existingAnalysis.descriptor,
      analyzerModel: input.existingAnalysis.analyzerModel,
      analyzerResolvedModel: input.existingAnalysis.analyzerResolvedModel,
      analyzerSchemaVersion: input.existingAnalysis.analyzerSchemaVersion,
      analyzerPromptVersion: input.existingAnalysis.analyzerPromptVersion,
    }
    input.onProgress?.(existing)
    return existing
  }

  const recoverableJobId =
    sameReference
    && input.existingAnalysis?.analyzerModel === analyzerModel
    && (
      input.existingAnalysis.descriptorStatus === 'queued'
      || input.existingAnalysis.descriptorStatus === 'running'
    )
      ? input.existingAnalysis.descriptorJobId
      : undefined
  const initialJob = recoverableJobId
    ? await apiFetch<DescriptorJob>(
        `/api/v1/image-features/appearance-transfer/descriptor-jobs/${
          encodeURIComponent(input.projectId)
        }/${encodeURIComponent(input.processorNodeId)}/${
          encodeURIComponent(recoverableJobId)
        }`,
      )
    : await apiFetch<DescriptorJob>(
        '/api/v1/image-features/appearance-transfer/descriptor-jobs',
        {
          method: 'POST',
          body: JSON.stringify({
            projectId: input.projectId,
            processorNodeId: input.processorNodeId,
            referenceNodeId: input.referenceNodeId,
            referenceAssetId: input.referenceAssetId,
            referenceUrl: input.referenceUrl,
            modelId: analyzerModel,
          }),
        },
      )
  return waitForDescriptorJob(
    initialJob,
    input.projectId,
    input.processorNodeId,
    input.signal,
    input.onProgress,
  )
}

export async function analyzeAppearanceSource(input: {
  projectId: string
  processorNodeId: string
  sourceNodeId: string
  sourceAssetId: string
  sourceUrl: string
  referenceNodeId: string
  referenceAssetId: string
  referenceUrl: string
  taskVersion: number
  signal: AbortSignal
  existingAnalysis?: AppearanceAnalysisState
  onDescriptorProgress?: (progress: DescriptorProgress) => void
  analysisMode?: 'descriptor-only' | 'full'
}): Promise<AppearanceAnalysisState> {
  const analyzerModel = referenceDescriptorModel()
  if (input.analysisMode === 'descriptor-only') {
    try {
      const descriptorResult = await requestLightingDescriptor({
        projectId: input.projectId,
        processorNodeId: input.processorNodeId,
        referenceNodeId: input.referenceNodeId,
        referenceAssetId: input.referenceAssetId,
        referenceUrl: input.referenceUrl,
        signal: input.signal,
        existingAnalysis: input.existingAnalysis,
        onProgress: input.onDescriptorProgress,
      })
      return {
        ...input.existingAnalysis,
        status: descriptorResult.descriptorStatus === 'ready' ? 'ready' : 'partial',
        sourceAssetId: input.sourceAssetId,
        referenceAssetId: input.referenceAssetId,
        sourceUrl: input.sourceUrl,
        referenceUrl: input.referenceUrl,
        ...descriptorResult,
      }
    } catch (error: unknown) {
      return {
        ...input.existingAnalysis,
        status: 'unavailable',
        sourceAssetId: input.sourceAssetId,
        referenceAssetId: input.referenceAssetId,
        sourceUrl: input.sourceUrl,
        referenceUrl: input.referenceUrl,
        descriptorStatus: 'failed',
        analyzerModel,
        analyzerError: error instanceof Error ? error.message : String(error),
      }
    }
  }
  const reusableSourceAnalysis =
    input.existingAnalysis?.sourceAssetId === input.sourceAssetId &&
    input.existingAnalysis?.sourceUrl === input.sourceUrl
      ? input.existingAnalysis
      : undefined
  const reusableReferenceMask =
    input.existingAnalysis?.referenceAssetId === input.referenceAssetId &&
    input.existingAnalysis?.referenceUrl === input.referenceUrl
      ? input.existingAnalysis.referenceSubjectMaskUrl
      : undefined
  const existingReferenceSubject = reusableReferenceMask
    ? Promise.resolve({
        subjectMaskUrl: reusableReferenceMask,
      })
    : requestSubjectMask(
        input.projectId,
        `${input.processorNodeId}-reference`.slice(0, 120),
        input.referenceNodeId,
        input.referenceAssetId,
        input.referenceUrl,
        input.taskVersion,
        input.signal,
        undefined,
        false,
      )
  const [subject, referenceSubject, descriptorResult] = await Promise.allSettled([
    requestSubjectMask(
      input.projectId,
      input.processorNodeId,
      input.sourceNodeId,
      input.sourceAssetId,
      input.sourceUrl,
      input.taskVersion,
      input.signal,
      reusableSourceAnalysis,
    ),
    existingReferenceSubject,
    requestLightingDescriptor({
      projectId: input.projectId,
      processorNodeId: input.processorNodeId,
      referenceNodeId: input.referenceNodeId,
      referenceAssetId: input.referenceAssetId,
      referenceUrl: input.referenceUrl,
      signal: input.signal,
      existingAnalysis: input.existingAnalysis,
      onProgress: input.onDescriptorProgress,
    }),
  ])
  if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const result: AppearanceAnalysisState = {
    status: 'partial',
    sourceAssetId: input.sourceAssetId,
    referenceAssetId: input.referenceAssetId,
    sourceUrl: input.sourceUrl,
    referenceUrl: input.referenceUrl,
  }
  if (subject.status === 'fulfilled') {
    result.subjectMaskUrl = subject.value.subjectMaskUrl
    result.subjectAlphaUrl = subject.value.subjectAlphaUrl
    result.alphaModel = subject.value.alphaModel
  }
  if (referenceSubject.status === 'fulfilled') {
    result.referenceSubjectMaskUrl = referenceSubject.value.subjectMaskUrl
  }
  if (descriptorResult.status === 'fulfilled') {
    Object.assign(result, descriptorResult.value)
  } else {
    result.descriptorStatus = 'failed'
    result.analyzerModel = analyzerModel
    result.analyzerError =
      descriptorResult.reason instanceof Error
        ? descriptorResult.reason.message
        : String(descriptorResult.reason)
  }
  if (
    subject.status === 'fulfilled'
    && referenceSubject.status === 'fulfilled'
    && descriptorResult.status === 'fulfilled'
  ) {
    result.status =
      subject.value.subjectAlphaUrl
      && descriptorResult.value.descriptorStatus === 'ready'
        ? 'ready'
        : 'partial'
  } else {
    result.status =
      subject.status === 'fulfilled'
      || referenceSubject.status === 'fulfilled'
      || descriptorResult.status === 'fulfilled'
        ? 'partial'
        : 'unavailable'
  }
  const reasons = [
    ...(subject.status === 'fulfilled' && subject.value.alphaReason ? [subject.value.alphaReason] : []),
    ...[subject, referenceSubject, descriptorResult]
    .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    .map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason)),
  ]
  if (reasons.length) {
    result.reason = [result.reason, ...reasons].filter(Boolean).join('；')
  }
  return result
}
