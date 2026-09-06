import type { CanvasNode } from '../../shared/types/canvas'
import type { AppearanceTransferState } from './appearance-transfer-types'
import {
  createAppearanceResolutionPlan,
  type AppearanceResolutionPlanV1,
} from './appearance-transfer-resolution'

export type AppearanceInputRole =
  | 'generation_source'
  | 'source_rgb'
  | 'reference_rgb'
  | 'target_pose_scene'
  | 'source_identity_reference'
  | 'target_subject_mask'
  | 'source_subject_alpha'
  | 'source_subject_mask'
  | 'source_diffuse'
  | 'source_shading'
  | 'source_specular'
  | 'source_shadow'
  | 'source_environment'
  | 'source_residual'
  | 'source_normal'
  | 'source_depth'
  | 'reference_subject_mask'
  | 'reference_lighting_descriptor'
  | 'target_light_mask'
  | 'relit_base'
  | 'composite_seed'

export type AppearanceModelInputV1 = {
  order: number
  role: AppearanceInputRole
  required: boolean
  nodeId?: string
  assetId?: string
  url: string
  width?: number
  height?: number
}

type AppearanceModelInputManifestBase = {
  sourceNodeId: string
  referenceNodeId: string
  mode: 'color-only' | 'preserve-scene-relight' | 'replace-background-relight'
  inputs: AppearanceModelInputV1[]
  output: AppearanceResolutionPlanV1
}

export type AppearanceModelInputManifestV1 =
  | (AppearanceModelInputManifestBase & {
      schemaVersion: 1
      promptSchemaVersion: 2
    })
  | (AppearanceModelInputManifestBase & {
      schemaVersion: 2
      promptSchemaVersion: 3
    })
  | (AppearanceModelInputManifestBase & {
      schemaVersion: 3
      promptSchemaVersion: 4 | 5 | 6
      mode: 'preserve-scene-relight'
    })
  | (AppearanceModelInputManifestBase & {
      schemaVersion: 4
      promptSchemaVersion: 7
      mode: 'preserve-scene-relight'
      referenceAttached: true
    })
  | (AppearanceModelInputManifestBase & {
      schemaVersion: 5
      promptSchemaVersion: 8
      mode: 'replace-background-relight'
      referenceAttached: true
      backgroundMethod: 'semantic-direct'
    })
  | (AppearanceModelInputManifestBase & {
      schemaVersion: 6
      promptSchemaVersion: 9
      mode: 'replace-background-relight'
      referenceAttached: true
      backgroundMethod: 'reference-pixels'
    })
  | (AppearanceModelInputManifestBase & {
      schemaVersion: 7
      promptSchemaVersion: 10
      mode: 'replace-background-relight'
      referenceAttached: true
      backgroundMethod: 'reference-pose-replacement'
      poseReplacementMode: 'identity-only' | 'full-appearance'
    })
  | (AppearanceModelInputManifestBase & {
      schemaVersion: 8
      promptSchemaVersion: 11
      mode: 'replace-background-relight'
      referenceAttached: true
      backgroundMethod: 'reference-pixels-model-fusion'
    })

function nodeUrl(node: CanvasNode) {
  return node.originalUrl || node.previewUrl || node.thumbnailUrl || ''
}

function projectAssetUrl(value?: string) {
  return Boolean(value && !/^(?:data:|blob:)/i.test(value))
}

export function createAppearanceInputManifest(
  sourceNode: CanvasNode,
  referenceNode: CanvasNode,
  state: AppearanceTransferState,
): AppearanceModelInputManifestV1 {
  const inputs: Omit<AppearanceModelInputV1, 'order'>[] = [
    {
      role: 'source_rgb',
      required: true,
      nodeId: sourceNode.id,
      assetId: sourceNode.assetId ?? undefined,
      url: nodeUrl(sourceNode),
      width: sourceNode.imageWidth ?? undefined,
      height: sourceNode.imageHeight ?? undefined,
    },
    {
      role: 'reference_rgb',
      required: true,
      nodeId: referenceNode.id,
      assetId: referenceNode.assetId ?? undefined,
      url: nodeUrl(referenceNode),
      width: referenceNode.imageWidth ?? undefined,
      height: referenceNode.imageHeight ?? undefined,
    },
  ]

  if (state.lightingEnabled) {
    const alphaUrl = state.analysis.subjectAlphaUrl
    const maskUrl = state.analysis.subjectMaskUrl
    if (projectAssetUrl(alphaUrl)) {
      inputs.push({
        role: 'source_subject_alpha',
        required: state.lightingMode === 'replace-background',
        url: alphaUrl!,
      })
    } else if (projectAssetUrl(maskUrl)) {
      inputs.push({
        role: 'source_subject_mask',
        required: false,
        url: maskUrl!,
      })
    }
    if (projectAssetUrl(state.analysis.referenceSubjectMaskUrl)) {
      inputs.push({
        role: 'reference_subject_mask',
        required: state.lightingMode === 'replace-background',
        url: state.analysis.referenceSubjectMaskUrl!,
      })
    }
  }

  return {
    schemaVersion: 2,
    promptSchemaVersion: 3,
    sourceNodeId: sourceNode.id,
    referenceNodeId: referenceNode.id,
    mode: !state.lightingEnabled
      ? 'color-only'
      : state.lightingMode === 'replace-background'
        ? 'replace-background-relight'
        : 'preserve-scene-relight',
    inputs: inputs.map((input, index) => ({ ...input, order: index + 1 })),
    output: createAppearanceResolutionPlan(sourceNode, state.resolution),
  }
}

export function parseAppearanceInputManifest(value?: string | null) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as AppearanceModelInputManifestV1
    const supportedVersion =
      (parsed.schemaVersion === 1 && parsed.promptSchemaVersion === 2) ||
      (parsed.schemaVersion === 2 && parsed.promptSchemaVersion === 3) ||
      (
        parsed.schemaVersion === 3 &&
        (
          parsed.promptSchemaVersion === 4 ||
          parsed.promptSchemaVersion === 5 ||
          parsed.promptSchemaVersion === 6
        )
      ) ||
      (
        parsed.schemaVersion === 4 &&
        parsed.promptSchemaVersion === 7 &&
        parsed.referenceAttached === true
      ) ||
      (
        parsed.schemaVersion === 5 &&
        parsed.promptSchemaVersion === 8 &&
        parsed.mode === 'replace-background-relight' &&
        parsed.referenceAttached === true &&
        parsed.backgroundMethod === 'semantic-direct'
      ) ||
      (
        parsed.schemaVersion === 6 &&
        parsed.promptSchemaVersion === 9 &&
        parsed.mode === 'replace-background-relight' &&
        parsed.referenceAttached === true &&
        parsed.backgroundMethod === 'reference-pixels'
      ) ||
      (
        parsed.schemaVersion === 7 &&
        parsed.promptSchemaVersion === 10 &&
        parsed.mode === 'replace-background-relight' &&
        parsed.referenceAttached === true &&
        parsed.backgroundMethod === 'reference-pose-replacement' &&
        (
          parsed.poseReplacementMode === 'identity-only' ||
          parsed.poseReplacementMode === 'full-appearance'
        )
      ) ||
      (
        parsed.schemaVersion === 8 &&
        parsed.promptSchemaVersion === 11 &&
        parsed.mode === 'replace-background-relight' &&
        parsed.referenceAttached === true &&
        parsed.backgroundMethod === 'reference-pixels-model-fusion'
      )
    const validInputs = Array.isArray(parsed.inputs) && (
      parsed.schemaVersion === 3
        ? parsed.inputs.length === 1 &&
          parsed.inputs[0]?.order === 1 &&
          parsed.inputs[0]?.role === 'generation_source'
        : parsed.schemaVersion === 4
          ? parsed.inputs.length === 2 &&
            parsed.inputs[0]?.order === 1 &&
            parsed.inputs[0]?.role === 'generation_source' &&
            parsed.inputs[1]?.order === 2 &&
            parsed.inputs[1]?.role === 'reference_rgb'
          : parsed.schemaVersion === 5
            ? parsed.inputs.length === 2 &&
              parsed.inputs[0]?.order === 1 &&
              parsed.inputs[0]?.role === 'generation_source' &&
              parsed.inputs[1]?.order === 2 &&
              parsed.inputs[1]?.role === 'reference_rgb'
          : parsed.schemaVersion === 6
            ? parsed.inputs.length === 3 &&
              parsed.inputs[0]?.order === 1 &&
              parsed.inputs[0]?.role === 'source_rgb' &&
              parsed.inputs[1]?.order === 2 &&
              parsed.inputs[1]?.role === 'reference_rgb' &&
              parsed.inputs[2]?.order === 3 &&
              (
                parsed.inputs[2]?.role === 'source_subject_alpha' ||
                parsed.inputs[2]?.role === 'source_subject_mask'
              )
          : parsed.schemaVersion === 7
            ? parsed.inputs.length === 3 &&
              parsed.inputs[0]?.order === 1 &&
              parsed.inputs[0]?.role === 'target_pose_scene' &&
              parsed.inputs[1]?.order === 2 &&
              parsed.inputs[1]?.role === 'source_identity_reference' &&
              parsed.inputs[2]?.order === 3 &&
              parsed.inputs[2]?.role === 'target_subject_mask'
          : parsed.schemaVersion === 8
            ? parsed.inputs.length === 3 &&
              parsed.inputs[0]?.order === 1 &&
              parsed.inputs[0]?.role === 'composite_seed' &&
              parsed.inputs[1]?.order === 2 &&
              parsed.inputs[1]?.role === 'source_identity_reference' &&
              parsed.inputs[2]?.order === 3 &&
              (
                parsed.inputs[2]?.role === 'source_subject_alpha' ||
                parsed.inputs[2]?.role === 'source_subject_mask'
              )
          : parsed.inputs[0]?.role === 'source_rgb' &&
            parsed.inputs[1]?.role === 'reference_rgb'
    )
    if (
      !supportedVersion ||
      !Array.isArray(parsed.inputs) ||
      !validInputs
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function isRouteASingleSourceManifest(
  manifest: AppearanceModelInputManifestV1 | null | undefined,
) {
  return Boolean(
    manifest?.schemaVersion === 3 &&
    (
      manifest.promptSchemaVersion === 4 ||
      manifest.promptSchemaVersion === 5 ||
      manifest.promptSchemaVersion === 6
    ) &&
    manifest.mode === 'preserve-scene-relight' &&
    manifest.inputs.length === 1 &&
    manifest.inputs[0]?.role === 'generation_source',
  )
}

export function isRouteAExperimentalReferenceManifest(
  manifest: AppearanceModelInputManifestV1 | null | undefined,
) {
  return Boolean(
    manifest?.schemaVersion === 4 &&
    manifest.promptSchemaVersion === 7 &&
    manifest.mode === 'preserve-scene-relight' &&
    manifest.referenceAttached === true &&
    manifest.inputs.length === 2 &&
    manifest.inputs[0]?.order === 1 &&
    manifest.inputs[0]?.role === 'generation_source' &&
    manifest.inputs[1]?.order === 2 &&
    manifest.inputs[1]?.role === 'reference_rgb',
  )
}

export function isRouteABackgroundReplacementManifest(
  manifest: AppearanceModelInputManifestV1 | null | undefined,
) {
  return Boolean(
    manifest?.schemaVersion === 5 &&
    manifest.promptSchemaVersion === 8 &&
    manifest.mode === 'replace-background-relight' &&
    manifest.referenceAttached === true &&
    manifest.backgroundMethod === 'semantic-direct' &&
    manifest.inputs.length === 2 &&
    manifest.inputs[0]?.order === 1 &&
    manifest.inputs[0]?.role === 'generation_source' &&
    manifest.inputs[1]?.order === 2 &&
    manifest.inputs[1]?.role === 'reference_rgb',
  )
}

export function isReferencePixelCompositeManifest(
  manifest: AppearanceModelInputManifestV1 | null | undefined,
) {
  return Boolean(
    manifest?.schemaVersion === 6 &&
    manifest.promptSchemaVersion === 9 &&
    manifest.mode === 'replace-background-relight' &&
    manifest.referenceAttached === true &&
    manifest.backgroundMethod === 'reference-pixels' &&
    manifest.inputs.length === 3 &&
    manifest.inputs[0]?.order === 1 &&
    manifest.inputs[0]?.role === 'source_rgb' &&
    manifest.inputs[1]?.order === 2 &&
    manifest.inputs[1]?.role === 'reference_rgb' &&
    manifest.inputs[2]?.order === 3 &&
    (
      manifest.inputs[2]?.role === 'source_subject_alpha' ||
      manifest.inputs[2]?.role === 'source_subject_mask'
    ),
  )
}

export function isReferencePoseReplacementManifest(
  manifest: AppearanceModelInputManifestV1 | null | undefined,
) {
  return Boolean(
    manifest?.schemaVersion === 7 &&
    manifest.promptSchemaVersion === 10 &&
    manifest.mode === 'replace-background-relight' &&
    manifest.referenceAttached === true &&
    manifest.backgroundMethod === 'reference-pose-replacement' &&
    (
      manifest.poseReplacementMode === 'identity-only' ||
      manifest.poseReplacementMode === 'full-appearance'
    ) &&
    manifest.inputs.length === 3 &&
    manifest.inputs[0]?.order === 1 &&
    manifest.inputs[0]?.role === 'target_pose_scene' &&
    manifest.inputs[1]?.order === 2 &&
    manifest.inputs[1]?.role === 'source_identity_reference' &&
    manifest.inputs[2]?.order === 3 &&
    manifest.inputs[2]?.role === 'target_subject_mask',
  )
}

export function isReferencePixelModelFusionManifest(
  manifest: AppearanceModelInputManifestV1 | null | undefined,
) {
  return Boolean(
    manifest?.schemaVersion === 8 &&
    manifest.promptSchemaVersion === 11 &&
    manifest.mode === 'replace-background-relight' &&
    manifest.referenceAttached === true &&
    manifest.backgroundMethod === 'reference-pixels-model-fusion' &&
    manifest.inputs.length === 3 &&
    manifest.inputs[0]?.order === 1 &&
    manifest.inputs[0]?.role === 'composite_seed' &&
    manifest.inputs[1]?.order === 2 &&
    manifest.inputs[1]?.role === 'source_identity_reference' &&
    manifest.inputs[2]?.order === 3 &&
    (
      manifest.inputs[2]?.role === 'source_subject_alpha' ||
      manifest.inputs[2]?.role === 'source_subject_mask'
    ),
  )
}

export function isRouteAManifest(
  manifest: AppearanceModelInputManifestV1 | null | undefined,
) {
  return isRouteASingleSourceManifest(manifest) ||
    isRouteAExperimentalReferenceManifest(manifest) ||
    isRouteABackgroundReplacementManifest(manifest) ||
    isReferencePixelModelFusionManifest(manifest)
}

export type AppearanceManifestImageReference = {
  nodeId: string
  title: string
  url: string
  mimeType: string
  width: number | undefined
  height: number | undefined
}

function isProjectAssetReferenceUrl(value: string) {
  return (
    /^\/assets\/projects\/[^/]+\//i.test(value) ||
    /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/assets\/projects\/[^/]+\//i.test(value)
  )
}

/**
 * Thin execution adapter for Route A. The manifest is the authoritative,
 * ordered provider-input contract, including a persisted deterministic
 * color-base that may not exist as a canvas node.
 */
export function appearanceManifestImageReferences(value?: string | null) {
  const manifest = parseAppearanceInputManifest(value)
  if (!manifest || !isRouteAManifest(manifest)) return null
  const providerInputs = isReferencePixelModelFusionManifest(manifest)
    ? manifest.inputs.filter(
        (input) =>
          input.role === 'composite_seed' ||
          input.role === 'source_identity_reference',
      )
    : manifest.inputs
  const references = providerInputs.map((input) => {
    if (!isProjectAssetReferenceUrl(input.url)) return null
    return {
      nodeId:
        input.nodeId ||
        `${manifest.sourceNodeId}:${input.role.replaceAll('_', '-')}`,
      title:
        input.role === 'generation_source'
          ? 'GENERATION SOURCE'
          : input.role === 'composite_seed'
            ? 'COMPOSITE SEED'
            : input.role === 'source_identity_reference'
              ? 'SOURCE IDENTITY REFERENCE'
              : manifest.mode === 'replace-background-relight'
                ? 'BACKGROUND + LIGHTING REFERENCE'
                : 'LIGHTING REFERENCE',
      url: input.url,
      mimeType: 'image/png',
      width: input.width,
      height: input.height,
    }
  })
  return references.every(
    (reference): reference is AppearanceManifestImageReference => reference !== null,
  )
    ? references
    : null
}

export function appearanceInputSignature(manifest: AppearanceModelInputManifestV1) {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    promptSchemaVersion: manifest.promptSchemaVersion,
    mode: manifest.mode,
    ...('referenceAttached' in manifest
      ? { referenceAttached: manifest.referenceAttached }
      : {}),
    ...('backgroundMethod' in manifest
      ? { backgroundMethod: manifest.backgroundMethod }
      : {}),
    ...('poseReplacementMode' in manifest
      ? { poseReplacementMode: manifest.poseReplacementMode }
      : {}),
    inputs: manifest.inputs.map(({ role, nodeId, assetId, url, width, height }) => ({
      role,
      nodeId,
      assetId,
      url,
      width,
      height,
    })),
    output: manifest.output,
  })
}

export function parseAppearanceManifestFromGenerationSignature(value?: string | null) {
  if (!value) return null
  try {
    const envelope = JSON.parse(value) as { manifest?: unknown }
    const encodedManifest =
      typeof envelope.manifest === 'string'
        ? envelope.manifest
        : JSON.stringify(envelope.manifest ?? null)
    const parsed = parseAppearanceInputManifest(encodedManifest)
    if (!parsed) return null
    return {
      ...parsed,
      sourceNodeId: parsed.sourceNodeId || parsed.inputs[0]?.nodeId || '',
      referenceNodeId: parsed.referenceNodeId || parsed.inputs[1]?.nodeId || '',
    }
  } catch {
    return null
  }
}

export const APPEARANCE_ROLE_TITLES: Record<AppearanceInputRole, string> = {
  generation_source: 'GENERATION SOURCE — the only image sent to the Route A editor',
  source_rgb: 'SOURCE RGB — preserve identity, composition and content',
  reference_rgb: 'LIGHTING REFERENCE — lighting and atmosphere evidence only; never content',
  target_pose_scene: 'TARGET POSE SCENE — preserve scene, pose, framing and illumination',
  source_identity_reference: 'SOURCE IDENTITY REFERENCE — transfer identity without source pose',
  target_subject_mask: 'TARGET SUBJECT MASK — the only region that may be replaced',
  source_subject_alpha: 'SOURCE SUBJECT ALPHA — continuous hair-edge transparency',
  source_subject_mask: 'SOURCE SUBJECT MASK — coarse subject boundary only',
  source_diffuse: 'SOURCE DIFFUSE — bounded de-light approximation',
  source_shading: 'SOURCE SHADING — original baked illumination estimate',
  source_specular: 'SOURCE SPECULAR — material highlight estimate',
  source_shadow: 'SOURCE SHADOW — original cast and contact shadow estimate',
  source_environment: 'SOURCE ENVIRONMENT — ambient and reflection estimate',
  source_residual: 'SOURCE RESIDUAL — detail not explained by intrinsic decomposition',
  source_normal: 'SOURCE NORMAL — surface orientation guide',
  source_depth: 'SOURCE DEPTH — scene distance and atmosphere guide',
  reference_subject_mask: 'REFERENCE SUBJECT MASK — region removed by Big-LaMa',
  reference_lighting_descriptor: 'REFERENCE LIGHTING DESCRIPTOR — extracted light target',
  target_light_mask: 'TARGET LIGHT MASK — bounded region for reconstructed illumination',
  relit_base: 'RELIT BASE — dedicated relighting result before final rendering',
  composite_seed: 'COMPOSITE SEED — deterministic subject/background placement',
}
