import {
  DEFAULT_APPEARANCE_FINALIZER_ID,
  getAppearanceBackendDefinition,
  isAppearanceBackendId,
  isAppearanceFinalizerBackendId,
  type AppearanceBackendId,
  type AppearanceFinalizerBackendId,
} from './appearance-transfer-backends'

export const APPEARANCE_TRANSFER_ACTION_TYPE = 'appearance-transfer'

export type {
  AppearanceBackendId,
  AppearanceBackendOption,
  AppearanceCapabilityStatus,
  AppearanceFinalizerBackendId,
} from './appearance-transfer-backends'

export type AppearancePreviewMode = 'source' | 'color' | 'generated'
export type AppearanceLightingMode = 'preserve-scene' | 'replace-background'
export type AppearanceBackgroundTransferMethod =
  | 'semantic-generate'
  | 'reference-pixels'
export type AppearanceReferencePersonAction = 'keep' | 'remove' | 'replace-pose'
export type AppearancePoseReplacementMode = 'identity-only' | 'full-appearance'
export type AppearanceResolution = 'original' | '1K' | '2K' | '4K'

const APPEARANCE_RESOLUTIONS = new Set<AppearanceResolution>([
  'original',
  '1K',
  '2K',
  '4K',
])

export function isAppearanceResolution(value: unknown): value is AppearanceResolution {
  return typeof value === 'string' && APPEARANCE_RESOLUTIONS.has(value as AppearanceResolution)
}

export type AppearancePaletteColor = {
  hex: string
  weight: number
}

export type AppearanceAnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'partial' | 'unavailable'

export type LightingDescriptorV1 = {
  schemaVersion: 1
  coordinateSystem: 'camera'
  confidence: number
  keyLight: {
    directionClass: string
    azimuthDeg?: number | null
    elevationDeg?: number | null
    directionConfidence: number
    sourceType: string
    size: number
    softness: number
    intensity: number
  }
  fillLight: {
    present: boolean
    relativeIntensity: number
    colorHex: string
  }
  rimLight: {
    present: boolean
    directionClass: string
    intensity: number
    colorHex: string
  }
  exposure: {
    style: 'low-key' | 'balanced' | 'high-key'
    shadowAreaRatio: number
    contrast: number
    highlightRollOff: 'soft' | 'medium' | 'hard' | 'clipped'
    blackPoint: number
    whitePoint: number
  }
  color: {
    estimatedCctK: number
    cctConfidence: number
    tint: string
    ambientColorHex: string
    highlightColorHex: string
  }
  atmosphere: {
    haze: number
    aerialPerspective: number
    bloom: number
  }
  globalMood: {
    keywords: string[]
    summary: string
  }
  uncertainties: string[]
}

export type AppearanceDescriptorStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'

export type AppearanceAnalysisState = {
  status: AppearanceAnalysisStatus
  sourceAssetId?: string
  referenceAssetId?: string
  sourceUrl?: string
  referenceUrl?: string
  subjectMaskUrl?: string
  subjectAlphaUrl?: string
  referenceSubjectMaskUrl?: string
  alphaModel?: string
  descriptorStatus?: AppearanceDescriptorStatus
  descriptorJobId?: string
  descriptorHash?: string
  descriptor?: LightingDescriptorV1
  analyzerModel?: string
  analyzerResolvedModel?: string
  analyzerSchemaVersion?: number
  analyzerPromptVersion?: number
  analyzerError?: string
  reason?: string
}

export type AppearanceGenerationStatus = 'idle' | 'queued' | 'running' | 'ready' | 'failed' | 'stale'

export type AppearanceGenerationProvenance = {
  backendId: AppearanceBackendId
  resolution: AppearanceResolution
  colorEnabled: boolean
  lightingEnabled: boolean
  lightingMode: AppearanceLightingMode
  backgroundTransferMethod: AppearanceBackgroundTransferMethod
  /** Optional only for persisted V7 compatibility. */
  referencePersonAction?: AppearanceReferencePersonAction
  /** Optional only for persisted V7 compatibility. */
  poseReplacementMode?: AppearancePoseReplacementMode
  removeGraphicOverlays: boolean
  /**
   * Optional only for persisted V5/V6 compatibility. Newly created and parsed
   * provenance always contains the complete color-control snapshot.
   */
  colorStrength?: number
  luminanceMatch?: number
  temperature?: number
  saturation?: number
  preserveSkin?: boolean
  /**
   * False for the standard descriptor-only Route A contract. True only for
   * the one-shot A8 experiment that also attaches reference RGB.
   */
  referenceAttached?: boolean
}

export type AppearanceGenerationState = {
  status: AppearanceGenerationStatus
  phase?:
    | 'idle'
    | 'analyzing-reference'
    | 'preparing-color-base'
    | 'cleaning-background'
    | 'fusing-subject'
    | 'editing-source'
    | 'checking-quality'
    | 'ready'
    | 'rejected'
    | 'failed'
    | 'reference-solving'
    | 'finalizing'
  candidateNodeId?: string
  localJobId?: string
  progress?: number
  previewUrl?: string
  error?: string
  inputSignature?: string
  provenance?: AppearanceGenerationProvenance
  confirmable?: boolean
  legacyStatus?: 'legacy-experimental'
  qualityGate?: 'pending' | 'passed' | 'failed'
  qualityReason?: string
  qualityReportUrl?: string
  qualityPolicyVersion?: string
  qualityBlockingReasons?: string[]
  qualityWarnings?: string[]
}

export type AppearanceCandidateKind = 'color' | 'lighting' | 'combined'

export type AppearanceCandidateState = AppearanceGenerationState & {
  kind?: AppearanceCandidateKind
}

export type AppearanceCandidateCollection = Record<
  AppearanceCandidateKind,
  AppearanceCandidateState
>

export type AppearanceTransferState = {
  version: 8
  previewMode: AppearancePreviewMode
  colorEnabled: boolean
  lightingEnabled: boolean
  lightingMode: AppearanceLightingMode
  backgroundTransferMethod: AppearanceBackgroundTransferMethod
  referencePersonAction: AppearanceReferencePersonAction
  poseReplacementMode: AppearancePoseReplacementMode
  removeGraphicOverlays: boolean
  colorStrength: number
  luminanceMatch: number
  temperature: number
  saturation: number
  preserveSkin: boolean
  backendId: AppearanceFinalizerBackendId | null
  backendSelectionError?: {
    code: 'invalid-backend'
    rawId: string
  }
  resolution: AppearanceResolution
  lighting: {
    availability: 'rebuilding' | 'available'
    legacyBackendId?: 'ic-light-marigold-reference'
  }
  blend: {
    amount: number
  }
  analysis: AppearanceAnalysisState
  candidates: AppearanceCandidateCollection
  /**
   * Transitional active-candidate projection for the current editor. Serialization
   * always writes it back into `candidates`; later UI phases can consume the slots
   * directly without invalidating V3 jobs.
   */
  generation: AppearanceGenerationState
}

function idleCandidate(kind: AppearanceCandidateKind): AppearanceCandidateState {
  return { kind, status: 'idle' }
}

export const DEFAULT_APPEARANCE_TRANSFER_STATE: AppearanceTransferState = {
  version: 8,
  previewMode: 'color',
  colorEnabled: true,
  lightingEnabled: true,
  lightingMode: 'preserve-scene',
  backgroundTransferMethod: 'semantic-generate',
  referencePersonAction: 'keep',
  poseReplacementMode: 'identity-only',
  removeGraphicOverlays: false,
  colorStrength: 70,
  luminanceMatch: 65,
  temperature: 50,
  saturation: 60,
  preserveSkin: true,
  backendId: DEFAULT_APPEARANCE_FINALIZER_ID,
  resolution: '2K',
  lighting: {
    availability: 'available',
  },
  blend: {
    amount: 100,
  },
  analysis: { status: 'idle' },
  candidates: {
    color: idleCandidate('color'),
    lighting: idleCandidate('lighting'),
    combined: idleCandidate('combined'),
  },
  generation: { status: 'idle' },
}

export function activeAppearanceCandidateKind(
  state: Pick<AppearanceTransferState, 'colorEnabled' | 'lightingEnabled'>,
): AppearanceCandidateKind {
  if (state.colorEnabled && state.lightingEnabled) return 'combined'
  if (state.lightingEnabled) return 'lighting'
  return 'color'
}

export function createAppearanceGenerationProvenance(
  state: AppearanceTransferState,
  options: {
    referenceAttached?: boolean
  } = {},
): AppearanceGenerationProvenance {
  if (!state.backendId) {
    throw new Error('Cannot create generation provenance without a valid finalizer backend.')
  }
  return {
    backendId: state.backendId,
    resolution: state.resolution,
    colorEnabled: state.colorEnabled,
    lightingEnabled: state.lightingEnabled,
    lightingMode: state.lightingMode,
    backgroundTransferMethod: state.backgroundTransferMethod,
    referencePersonAction: state.referencePersonAction,
    poseReplacementMode: state.poseReplacementMode,
    removeGraphicOverlays: state.removeGraphicOverlays,
    colorStrength: state.colorStrength,
    luminanceMatch: state.luminanceMatch,
    temperature: state.temperature,
    saturation: state.saturation,
    preserveSkin: state.preserveSkin,
    referenceAttached: options.referenceAttached ?? false,
  }
}

export function appearanceGenerationProvenanceMatches(
  provenance: AppearanceGenerationProvenance | null | undefined,
  state: AppearanceTransferState,
) {
  const backgroundTransferMethod =
    provenance?.backgroundTransferMethod ?? 'semantic-generate'
  const referencePersonAction = provenance?.referencePersonAction ?? 'keep'
  const poseReplacementMode = provenance?.poseReplacementMode ?? 'identity-only'
  const usesLocalReferencePixels =
    state.lightingEnabled &&
    state.lightingMode === 'replace-background' &&
    state.backgroundTransferMethod === 'reference-pixels' &&
    state.referencePersonAction === 'keep'
  return Boolean(
    provenance &&
    backgroundTransferMethod === state.backgroundTransferMethod &&
    referencePersonAction === state.referencePersonAction &&
    poseReplacementMode === state.poseReplacementMode &&
    (usesLocalReferencePixels || provenance.backendId === state.backendId) &&
    (usesLocalReferencePixels || provenance.resolution === state.resolution) &&
    provenance.colorEnabled === state.colorEnabled &&
    provenance.lightingEnabled === state.lightingEnabled &&
    provenance.lightingMode === state.lightingMode &&
    provenance.removeGraphicOverlays === state.removeGraphicOverlays &&
    provenance.colorStrength === state.colorStrength &&
    provenance.luminanceMatch === state.luminanceMatch &&
    provenance.temperature === state.temperature &&
    provenance.saturation === state.saturation &&
    provenance.preserveSkin === state.preserveSkin
  )
}

export function hasRequiredReplaceBackgroundAnalysis(state: AppearanceTransferState) {
  // Reserved for the future precise-matting mode. Ordinary Route A background
  // replacement intentionally does not use this as a generation prerequisite.
  if (!state.lightingEnabled || state.lightingMode !== 'replace-background') return true
  return Boolean(
    state.analysis.subjectAlphaUrl &&
    state.analysis.referenceSubjectMaskUrl
  )
}

export function appearanceCandidateMatchesCurrentRequest(
  candidateState: AppearanceTransferState | null | undefined,
  currentState: AppearanceTransferState,
) {
  return Boolean(
    candidateState &&
    appearanceGenerationProvenanceMatches(
      currentState.generation.provenance,
      currentState,
    ) &&
    appearanceGenerationProvenanceMatches(
      createAppearanceGenerationProvenance(candidateState),
      currentState,
    )
  )
}

export function appearanceGenerationProgressPercent(progress: number | undefined) {
  if (!Number.isFinite(progress)) return null
  return Math.max(0, Math.min(100, Math.round((progress ?? 0) * 100)))
}

export function applyAppearanceLocalJobUpdate(
  state: AppearanceTransferState,
  jobId: string,
  candidateNodeId: string,
  update: Pick<AppearanceGenerationState, 'status' | 'progress' | 'previewUrl' | 'error'>,
) {
  if (
    state.generation.localJobId !== jobId ||
    state.generation.candidateNodeId !== candidateNodeId ||
    state.generation.status === 'stale' ||
    !appearanceGenerationProvenanceMatches(state.generation.provenance, state)
  ) {
    return state
  }
  const candidateKind = activeAppearanceCandidateKind(state)
  const updatedGeneration = {
    ...state.generation,
    ...update,
  }
  return {
    ...state,
    previewMode: update.status === 'ready' ? 'generated' as const : state.previewMode,
    candidates: {
      ...state.candidates,
      [candidateKind]: {
        ...state.candidates[candidateKind],
        ...updatedGeneration,
        kind: candidateKind,
      },
    },
    generation: updatedGeneration,
  }
}

export function clampAppearancePercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)))
}

function normalizeProjectAssetUrl(value?: string) {
  if (!value) return value
  return value.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?=\/assets\/projects\/)/i, '')
}

type NormalizedBackendSelection = {
  backendId: AppearanceFinalizerBackendId | null
  backendSelectionError?: AppearanceTransferState['backendSelectionError']
  legacyBackendId?: 'ic-light-marigold-reference'
}

function normalizeBackendSelection(
  value: unknown,
  hasPersistedBackendId: boolean,
): NormalizedBackendSelection {
  if (!hasPersistedBackendId) {
    return { backendId: DEFAULT_APPEARANCE_FINALIZER_ID }
  }
  if (isAppearanceFinalizerBackendId(value)) {
    return { backendId: value }
  }
  if (isAppearanceBackendId(value)) {
    const definition = getAppearanceBackendDefinition(value)
    if (definition.stageRole === 'legacy-reference-solver') {
      return {
        backendId: DEFAULT_APPEARANCE_FINALIZER_ID,
        legacyBackendId: 'ic-light-marigold-reference',
      }
    }
  }
  return {
    backendId: null,
    backendSelectionError: {
      code: 'invalid-backend',
      rawId: typeof value === 'string' ? value : String(value),
    },
  }
}

type AppearanceColorControlSnapshot = Pick<
  AppearanceTransferState,
  'colorStrength' | 'luminanceMatch' | 'temperature' | 'saturation' | 'preserveSkin'
>

function normalizeGenerationProvenance(
  provenance: AppearanceGenerationProvenance | undefined,
  colorControls?: AppearanceColorControlSnapshot,
) {
  if (!provenance) return undefined
  return {
    ...provenance,
    removeGraphicOverlays: provenance.removeGraphicOverlays ?? false,
    backgroundTransferMethod:
      provenance.backgroundTransferMethod ?? 'semantic-generate',
    referencePersonAction: provenance.referencePersonAction ?? 'keep',
    poseReplacementMode: provenance.poseReplacementMode ?? 'identity-only',
    referenceAttached: provenance.referenceAttached ?? false,
    ...(colorControls
      ? {
          colorStrength: provenance.colorStrength ?? colorControls.colorStrength,
          luminanceMatch: provenance.luminanceMatch ?? colorControls.luminanceMatch,
          temperature: provenance.temperature ?? colorControls.temperature,
          saturation: provenance.saturation ?? colorControls.saturation,
          preserveSkin: provenance.preserveSkin ?? colorControls.preserveSkin,
        }
      : {}),
  }
}

function normalizeCandidate(
  kind: AppearanceCandidateKind,
  value?: Partial<AppearanceCandidateState>,
  colorControls?: AppearanceColorControlSnapshot,
): AppearanceCandidateState {
  const provenance = normalizeGenerationProvenance(value?.provenance, colorControls)
  return {
    ...idleCandidate(kind),
    ...(value ?? {}),
    kind,
    previewUrl: normalizeProjectAssetUrl(value?.previewUrl),
    provenance,
  }
}

function generationFromCandidate(
  value?: Partial<AppearanceCandidateState>,
  colorControls?: AppearanceColorControlSnapshot,
): AppearanceGenerationState {
  if (!value) return { ...DEFAULT_APPEARANCE_TRANSFER_STATE.generation }
  const provenance = normalizeGenerationProvenance(value.provenance, colorControls)
  return {
    status: value.status ?? 'idle',
    phase: value.phase,
    candidateNodeId: value.candidateNodeId,
    localJobId: value.localJobId,
    progress: value.progress,
    previewUrl: normalizeProjectAssetUrl(value.previewUrl),
    error: value.error,
    inputSignature: value.inputSignature,
    provenance,
    confirmable: value.confirmable,
    legacyStatus: value.legacyStatus,
    qualityGate: value.qualityGate,
    qualityReason: value.qualityReason,
    qualityReportUrl: normalizeProjectAssetUrl(value.qualityReportUrl),
    qualityPolicyVersion: value.qualityPolicyVersion,
    qualityBlockingReasons: value.qualityBlockingReasons,
    qualityWarnings: value.qualityWarnings,
  }
}

function usesCurrentRouteAInput(value?: string) {
  if (!value) return false
  try {
    const envelope = JSON.parse(value) as { manifest?: unknown }
    const manifest =
      typeof envelope.manifest === 'string'
        ? JSON.parse(envelope.manifest) as {
            schemaVersion?: unknown
            promptSchemaVersion?: unknown
            mode?: unknown
            backgroundMethod?: unknown
            poseReplacementMode?: unknown
            inputs?: Array<{ role?: unknown }>
          }
        : envelope.manifest as {
            schemaVersion?: unknown
            promptSchemaVersion?: unknown
            mode?: unknown
            backgroundMethod?: unknown
            poseReplacementMode?: unknown
            inputs?: Array<{ role?: unknown }>
          } | undefined
    return Boolean(
      Array.isArray(manifest?.inputs) &&
      (
        (
          manifest.mode === 'preserve-scene-relight' &&
          (
        (
          manifest.schemaVersion === 3 &&
          (
            manifest.promptSchemaVersion === 4 ||
            manifest.promptSchemaVersion === 5 ||
            manifest.promptSchemaVersion === 6
          ) &&
          manifest.inputs.length === 1 &&
          manifest.inputs[0]?.role === 'generation_source'
        ) ||
        (
          manifest.schemaVersion === 4 &&
          manifest.promptSchemaVersion === 7 &&
          manifest.inputs.length === 2 &&
          manifest.inputs[0]?.role === 'generation_source' &&
          manifest.inputs[1]?.role === 'reference_rgb'
        )
          )
        ) ||
        (
          manifest.mode === 'replace-background-relight' &&
          (
            (
              manifest.schemaVersion === 5 &&
              manifest.promptSchemaVersion === 8 &&
              manifest.inputs.length === 2 &&
              manifest.inputs[0]?.role === 'generation_source' &&
              manifest.inputs[1]?.role === 'reference_rgb'
            ) ||
            (
              manifest.schemaVersion === 6 &&
              manifest.promptSchemaVersion === 9 &&
              manifest.inputs.length === 3 &&
              manifest.inputs[0]?.role === 'source_rgb' &&
              manifest.inputs[1]?.role === 'reference_rgb' &&
              (
                manifest.inputs[2]?.role === 'source_subject_alpha' ||
                manifest.inputs[2]?.role === 'source_subject_mask'
              )
            ) ||
            (
              manifest.schemaVersion === 7 &&
              manifest.promptSchemaVersion === 10 &&
              manifest.backgroundMethod === 'reference-pose-replacement' &&
              (
                manifest.poseReplacementMode === 'identity-only' ||
                manifest.poseReplacementMode === 'full-appearance'
              ) &&
              manifest.inputs.length === 3 &&
              manifest.inputs[0]?.role === 'target_pose_scene' &&
              manifest.inputs[1]?.role === 'source_identity_reference' &&
              manifest.inputs[2]?.role === 'target_subject_mask'
            ) ||
            (
              manifest.schemaVersion === 8 &&
              manifest.promptSchemaVersion === 11 &&
              manifest.backgroundMethod === 'reference-pixels-model-fusion' &&
              manifest.inputs.length === 3 &&
              manifest.inputs[0]?.role === 'composite_seed' &&
              manifest.inputs[1]?.role === 'source_identity_reference' &&
              (
                manifest.inputs[2]?.role === 'source_subject_alpha' ||
                manifest.inputs[2]?.role === 'source_subject_mask'
              )
            )
          )
        )
      )
    )
  } catch {
    return false
  }
}

export function parseAppearanceTransferState(value?: string | null): AppearanceTransferState {
  if (!value) return { ...DEFAULT_APPEARANCE_TRANSFER_STATE }
  try {
    const parsed = JSON.parse(value) as Omit<Partial<AppearanceTransferState>, 'previewMode'> & {
      previewMode?: AppearancePreviewMode | 'atmosphere'
      structureMode?: 'preserve' | 'recompose'
    }
    const migratedLightingMode =
      parsed.lightingMode ??
      (parsed.structureMode === 'recompose' ? 'replace-background' : 'preserve-scene')
    const migratedPreviewMode = parsed.previewMode === 'atmosphere' ? 'generated' : parsed.previewMode
    const colorEnabled = parsed.colorEnabled ?? true
    const lightingEnabled = parsed.lightingEnabled ?? true
    const colorControls: AppearanceColorControlSnapshot = {
      colorStrength: clampAppearancePercent(
        parsed.colorStrength ?? DEFAULT_APPEARANCE_TRANSFER_STATE.colorStrength,
      ),
      luminanceMatch: clampAppearancePercent(
        parsed.luminanceMatch ?? DEFAULT_APPEARANCE_TRANSFER_STATE.luminanceMatch,
      ),
      temperature: clampAppearancePercent(
        parsed.temperature ?? DEFAULT_APPEARANCE_TRANSFER_STATE.temperature,
      ),
      saturation: clampAppearancePercent(
        parsed.saturation ?? DEFAULT_APPEARANCE_TRANSFER_STATE.saturation,
      ),
      preserveSkin: parsed.preserveSkin ?? DEFAULT_APPEARANCE_TRANSFER_STATE.preserveSkin,
    }
    const candidateKind = activeAppearanceCandidateKind({ colorEnabled, lightingEnabled })
    const parsedCandidates = (
      parsed as Partial<AppearanceTransferState> & {
        candidates?: Partial<Record<AppearanceCandidateKind, Partial<AppearanceCandidateState>>>
      }
    ).candidates
    const activeSavedCandidate = parsedCandidates?.[candidateKind]
    const legacyGeneration: Partial<AppearanceGenerationState> =
      activeSavedCandidate ?? parsed.generation ?? {}
    let backendSelection = normalizeBackendSelection(
      parsed.backendId,
      Object.prototype.hasOwnProperty.call(parsed, 'backendId'),
    )
    const legacyReferenceEvidence =
      backendSelection.legacyBackendId === 'ic-light-marigold-reference' ||
      legacyGeneration.provenance?.backendId === 'ic-light-marigold-reference' ||
      legacyGeneration.localJobId?.startsWith('appearance-reference-') === true
    if (
      legacyReferenceEvidence &&
      backendSelection.backendId === null &&
      backendSelection.backendSelectionError?.rawId === 'null'
    ) {
      backendSelection = {
        backendId: DEFAULT_APPEARANCE_FINALIZER_ID,
        legacyBackendId: 'ic-light-marigold-reference',
      }
    }
    const retiredReferencePipeline =
      legacyReferenceEvidence ||
      legacyGeneration.phase === 'reference-solving'
    const candidates: AppearanceCandidateCollection = {
      color: normalizeCandidate('color', parsedCandidates?.color, colorControls),
      lighting: normalizeCandidate('lighting', parsedCandidates?.lighting, colorControls),
      combined: normalizeCandidate('combined', parsedCandidates?.combined, colorControls),
    }
    const parsedGeneration = generationFromCandidate(legacyGeneration, colorControls)
    const currentIntermediateReferenceWorkflow =
      migratedLightingMode === 'replace-background' &&
      parsed.backgroundTransferMethod === 'reference-pixels' &&
      (
        parsed.referencePersonAction === 'remove' ||
        parsed.referencePersonAction === 'replace-pose'
      ) &&
      (
        parsedGeneration.phase === 'editing-source' ||
        parsedGeneration.phase === 'cleaning-background' ||
        parsedGeneration.phase === 'fusing-subject'
      ) &&
      (
        parsedGeneration.status === 'queued' ||
        parsedGeneration.status === 'running'
      ) &&
      Boolean(parsedGeneration.candidateNodeId) &&
      Boolean(parsedGeneration.provenance)
    const retiredPreRouteALightingResult =
      lightingEnabled &&
      (
        parsedGeneration.status !== 'idle' ||
        Boolean(parsedGeneration.previewUrl) ||
        Boolean(parsedGeneration.localJobId)
      ) &&
      !currentIntermediateReferenceWorkflow &&
      !usesCurrentRouteAInput(parsedGeneration.inputSignature)
    const generation = retiredReferencePipeline || retiredPreRouteALightingResult
      ? {
          ...parsedGeneration,
          status: parsedGeneration.previewUrl ? 'stale' as const : 'idle' as const,
          confirmable: false,
          legacyStatus: 'legacy-experimental' as const,
        }
      : parsedGeneration
    candidates[candidateKind] = normalizeCandidate(candidateKind, generation, colorControls)
    const previewMode =
      migratedPreviewMode === 'generated' && !generation.previewUrl
        ? colorEnabled ? 'color' : 'source'
        : migratedPreviewMode ?? DEFAULT_APPEARANCE_TRANSFER_STATE.previewMode
    return {
      ...DEFAULT_APPEARANCE_TRANSFER_STATE,
      version: 8,
      previewMode,
      colorEnabled,
      lightingEnabled,
      lightingMode: migratedLightingMode,
      backgroundTransferMethod:
        parsed.backgroundTransferMethod === 'reference-pixels'
          ? 'reference-pixels'
          : 'semantic-generate',
      referencePersonAction:
        parsed.referencePersonAction === 'remove' ||
        parsed.referencePersonAction === 'replace-pose'
          ? parsed.referencePersonAction
          : 'keep',
      poseReplacementMode:
        parsed.poseReplacementMode === 'full-appearance'
          ? 'full-appearance'
          : 'identity-only',
      removeGraphicOverlays:
        parsed.removeGraphicOverlays
        ?? DEFAULT_APPEARANCE_TRANSFER_STATE.removeGraphicOverlays,
      ...colorControls,
      backendId: backendSelection.backendId,
      backendSelectionError: backendSelection.backendSelectionError,
      resolution: isAppearanceResolution(parsed.resolution)
        ? parsed.resolution
        : DEFAULT_APPEARANCE_TRANSFER_STATE.resolution,
      lighting: {
        availability: 'available',
        legacyBackendId: backendSelection.legacyBackendId,
      },
      blend: {
        amount: clampAppearancePercent(
          parsed.blend?.amount ?? DEFAULT_APPEARANCE_TRANSFER_STATE.blend.amount,
        ),
      },
      analysis: {
        status:
          parsed.analysis?.status
          ?? DEFAULT_APPEARANCE_TRANSFER_STATE.analysis.status,
        sourceAssetId: parsed.analysis?.sourceAssetId,
        referenceAssetId: parsed.analysis?.referenceAssetId,
        sourceUrl: normalizeProjectAssetUrl(parsed.analysis?.sourceUrl),
        referenceUrl: normalizeProjectAssetUrl(parsed.analysis?.referenceUrl),
        subjectMaskUrl: normalizeProjectAssetUrl(parsed.analysis?.subjectMaskUrl),
        subjectAlphaUrl: normalizeProjectAssetUrl(parsed.analysis?.subjectAlphaUrl),
        referenceSubjectMaskUrl: normalizeProjectAssetUrl(
          parsed.analysis?.referenceSubjectMaskUrl,
        ),
        alphaModel: parsed.analysis?.alphaModel,
        descriptorStatus: parsed.analysis?.descriptorStatus,
        descriptorJobId: parsed.analysis?.descriptorJobId,
        descriptorHash: parsed.analysis?.descriptorHash,
        descriptor: parsed.analysis?.descriptor,
        analyzerModel: parsed.analysis?.analyzerModel,
        analyzerResolvedModel: parsed.analysis?.analyzerResolvedModel,
        analyzerSchemaVersion: parsed.analysis?.analyzerSchemaVersion,
        analyzerPromptVersion: parsed.analysis?.analyzerPromptVersion,
        analyzerError: parsed.analysis?.analyzerError,
        reason: parsed.analysis?.reason,
      },
      candidates,
      generation,
    }
  } catch {
    return { ...DEFAULT_APPEARANCE_TRANSFER_STATE }
  }
}

export function serializeAppearanceTransferState(state: AppearanceTransferState) {
  const candidateKind = state.generation.provenance
    ? activeAppearanceCandidateKind(state.generation.provenance)
    : activeAppearanceCandidateKind(state)
  return JSON.stringify({
    ...state,
    version: 8,
    candidates: {
      ...state.candidates,
      [candidateKind]: normalizeCandidate(candidateKind, state.generation, state),
    },
  })
}
