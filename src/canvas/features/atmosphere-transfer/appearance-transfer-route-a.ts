import type { CanvasNode } from '../../shared/types/canvas'
import type {
  AppearanceModelInputManifestV1,
} from './appearance-transfer-input-manifest'
import { createAppearanceResolutionPlan } from './appearance-transfer-resolution'
import type {
  AppearanceTransferState,
  LightingDescriptorV1,
} from './appearance-transfer-types'

export const ROUTE_A_COLOR_ALGORITHM_VERSION = 'appearance-color-oklab-v1'
export const ROUTE_A_PROMPT_SCHEMA_VERSION = 6
export const ROUTE_A_EXPERIMENTAL_PROMPT_SCHEMA_VERSION = 7
export const ROUTE_A_BACKGROUND_PROMPT_SCHEMA_VERSION = 12
export const ROUTE_A_SUPPORTED_BACKENDS = [
  'gemini-3-pro-image-preview',
  'gpt-image-2',
] as const
export type RouteASupportedBackend = typeof ROUTE_A_SUPPORTED_BACKENDS[number]
export type RouteAReferenceMode =
  | 'descriptor-only'
  | 'experimental-attached'
  | 'background-attached'

export function isRouteASupportedBackend(
  value: unknown,
): value is RouteASupportedBackend {
  return ROUTE_A_SUPPORTED_BACKENDS.includes(value as RouteASupportedBackend)
}

export type RouteAGenerationSource = {
  kind: 'source-rgb' | 'color-base'
  url: string
  width: number
  height: number
  nodeId?: string
  assetId?: string
  sha256?: string
}

export type RouteAGenerationSpec = {
  actionType: 'appearance-transfer'
  sourceNodeId: string
  referenceNodeId: string
  model: RouteASupportedBackend
  resolution: string
  prompt: string
  settings: Record<string, string>
  inputManifest: AppearanceModelInputManifestV1
}

function assertRouteAInput(
  state: AppearanceTransferState,
  generationSource: RouteAGenerationSource,
  referenceMode: RouteAReferenceMode,
  referenceNode: CanvasNode,
) {
  if (!state.lightingEnabled) {
    throw new Error('路线 A 灯光生成要求开启灯光氛围迁移。')
  }
  if (
    state.lightingMode === 'replace-background' &&
    referenceMode !== 'background-attached'
  ) {
    throw new Error('普通换景必须使用原图与参考背景的双图语义编辑合同。')
  }
  if (!isRouteASupportedBackend(state.backendId)) {
    throw new Error('路线 A 请选择 Nano Banana Pro 或 Image 2.0。')
  }
  if (
    state.lightingMode !== 'replace-background' &&
    (
      state.analysis.descriptorStatus !== 'ready' ||
      !state.analysis.descriptor ||
      !state.analysis.descriptorHash
    )
  ) {
    throw new Error('参考图光说明书尚未完成，请等待分析完成后再生成。')
  }
  if (!generationSource.url || !generationSource.width || !generationSource.height) {
    throw new Error('路线 A 缺少有效的单图生成底图。')
  }
  if (
    (
      referenceMode === 'experimental-attached' ||
      referenceMode === 'background-attached'
    ) &&
    !(referenceNode.originalUrl || referenceNode.previewUrl || referenceNode.thumbnailUrl)
  ) {
    throw new Error('双图编辑缺少可提交的参考图项目素材。')
  }
}

function descriptorLines(
  descriptor: LightingDescriptorV1,
  allowedLightColors: string[],
) {
  const allowed = new Set(allowedLightColors)
  const activeColor = (present: boolean, value: string) => {
    if (!present) return 'inactive'
    const normalized = normalizeLightColor(value)
    return normalized && allowed.has(normalized)
      ? normalized
      : 'suppressed-unmotivated-accent'
  }
  return [
    `key.direction=${descriptor.keyLight.directionClass}`,
    `key.azimuthDeg=${descriptor.keyLight.azimuthDeg ?? 'unknown'}`,
    `key.elevationDeg=${descriptor.keyLight.elevationDeg ?? 'unknown'}`,
    `key.sourceType=${descriptor.keyLight.sourceType}`,
    `key.size=${descriptor.keyLight.size}`,
    `key.softness=${descriptor.keyLight.softness}`,
    `key.intensity=${descriptor.keyLight.intensity}`,
    `fill.present=${descriptor.fillLight.present}`,
    `fill.relativeIntensity=${descriptor.fillLight.relativeIntensity}`,
    `fill.color=${activeColor(descriptor.fillLight.present, descriptor.fillLight.colorHex)}`,
    `rim.present=${descriptor.rimLight.present}`,
    `rim.direction=${descriptor.rimLight.directionClass}`,
    `rim.intensity=${descriptor.rimLight.intensity}`,
    `rim.color=${activeColor(descriptor.rimLight.present, descriptor.rimLight.colorHex)}`,
    `exposure.style=${descriptor.exposure.style}`,
    `exposure.shadowAreaRatio=${descriptor.exposure.shadowAreaRatio}`,
    `exposure.contrast=${descriptor.exposure.contrast}`,
    `exposure.highlightRollOff=${descriptor.exposure.highlightRollOff}`,
    `exposure.blackPoint=${descriptor.exposure.blackPoint}`,
    `exposure.whitePoint=${descriptor.exposure.whitePoint}`,
    `color.cctK=${descriptor.color.estimatedCctK}`,
    `color.tint=${descriptor.color.tint}`,
    `color.ambient=${descriptor.color.ambientColorHex}`,
    `color.highlight=${descriptor.color.highlightColorHex}`,
    `atmosphere.haze=${descriptor.atmosphere.haze}`,
    `atmosphere.aerialPerspective=${descriptor.atmosphere.aerialPerspective}`,
    `atmosphere.bloom=${descriptor.atmosphere.bloom}`,
  ]
}

function normalizeLightColor(value: string) {
  const normalized = value.trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : null
}

function colorHueAndSaturation(value: string) {
  const normalized = normalizeLightColor(value)
  if (!normalized) return null
  const red = Number.parseInt(normalized.slice(1, 3), 16) / 255
  const green = Number.parseInt(normalized.slice(3, 5), 16) / 255
  const blue = Number.parseInt(normalized.slice(5, 7), 16) / 255
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const delta = maximum - minimum
  const lightness = (maximum + minimum) / 2
  const saturation = delta === 0
    ? 0
    : delta / (1 - Math.abs(2 * lightness - 1))
  let hue = 0
  if (delta !== 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6)
    else if (maximum === green) hue = 60 * (((blue - red) / delta) + 2)
    else hue = 60 * (((red - green) / delta) + 4)
  }
  return {
    hue: hue < 0 ? hue + 360 : hue,
    saturation,
  }
}

function circularHueDistance(left: number, right: number) {
  const distance = Math.abs(left - right)
  return Math.min(distance, 360 - distance)
}

function accentMatchesEnvironment(
  value: string,
  environmentColors: string[],
) {
  const accent = colorHueAndSaturation(value)
  if (!accent) return false
  if (accent.saturation <= 0.25) return true
  return environmentColors.some((environmentColor) => {
    const environment = colorHueAndSaturation(environmentColor)
    return Boolean(
      environment &&
      circularHueDistance(accent.hue, environment.hue) <= 45,
    )
  })
}

export function allowedRouteALightColors(descriptor: LightingDescriptorV1) {
  const environmentColors = [
    descriptor.color.ambientColorHex,
    descriptor.color.highlightColorHex,
  ]
  const candidates = [
    ...environmentColors,
    descriptor.fillLight.present &&
      descriptor.fillLight.relativeIntensity > 0.05 &&
      accentMatchesEnvironment(descriptor.fillLight.colorHex, environmentColors)
      ? descriptor.fillLight.colorHex
      : null,
    descriptor.rimLight.present &&
      descriptor.rimLight.intensity > 0.05 &&
      accentMatchesEnvironment(descriptor.rimLight.colorHex, environmentColors)
      ? descriptor.rimLight.colorHex
      : null,
  ]
  return Array.from(new Set(
    candidates
      .map((value) => typeof value === 'string' ? normalizeLightColor(value) : null)
      .filter((value): value is string => Boolean(value)),
  ))
}

export function compileRouteALightingPrompt(
  descriptor: LightingDescriptorV1,
  generationSourceKind: RouteAGenerationSource['kind'],
  options: {
    removeGraphicOverlays?: boolean
    referenceMode?: RouteAReferenceMode
  } = {},
) {
  const referenceMode = options.referenceMode ?? 'descriptor-only'
  const allowedLightColors = allowedRouteALightColors(descriptor)
  const overlayContract = options.removeGraphicOverlays
    ? [
        'Remove only flat composited graphic overlays: watermarks, corner logos, subtitles, timestamps, UI chrome, frame labels and non-diegetic poster typography.',
        'Preserve real in-scene text printed on physical books, signs, packaging, clothing or architecture unless it is unmistakably a later flat overlay.',
        'Inpaint each removed overlay from its immediate surroundings while preserving local texture, grain, lighting continuity and image noise.',
        'Do this cleanup in the same single edit pass; do not create a second-generation cleanup image.',
      ]
    : [
        'Preserve every existing logo, watermark, caption and flat graphic overlay exactly; do not add any new text or graphic mark.',
      ]
  const inputContract = referenceMode === 'experimental-attached'
    ? [
        'ROUTE A EXPERIMENTAL TWO-IMAGE RELIGHT CONTRACT:',
        'IMAGE 1 — GENERATION SOURCE. This is the immutable and authoritative source for every visible person, object, pixel position, geometry, camera, crop, texture, text and scene detail.',
        'IMAGE 2 — LIGHTING REFERENCE. Use it as lighting-only evidence to reinforce the structured lighting specification.',
        'IMAGE 2 is never a content source: never copy its person, face, pose, clothing, object, architecture, sign, text, composition, camera, crop, background layout or spatial geometry.',
        'If IMAGE 2 conflicts with the structured lighting specification or IMAGE 1 content, preserve IMAGE 1 and follow the structured specification.',
      ]
    : [
        'ROUTE A SINGLE-IMAGE RELIGHT CONTRACT:',
        'The only attached image is the immutable generation source.',
      ]
  return [
    ...inputContract,
    'Every generation is a fresh first-generation edit from this immutable source; never use or imitate a previous generated result.',
    generationSourceKind === 'color-base'
      ? 'Its deterministic color grade is already correct; preserve that grade while rebuilding illumination.'
      : 'Its colors and all visible content are the source of truth.',
    'Edit this image in place. Preserve the exact person identity, face, hair, clothing, pose, body proportions, camera, crop, subject scale and position.',
    'Preserve the exact scene geometry, object boundaries, background layout and every semantic object.',
    'Remove the source image baked key-light direction, hard shadows, highlight placement, exposure bias, color temperature and ambient cast before applying the target lighting.',
    'Rebuild only illumination and atmosphere according to the numeric lighting specification below.',
    'Do not add, delete, move, replace or redraw any person, object, texture, window, sign, building or background structure.',
    'Preserve source high-frequency detail at the same pixel locations: natural skin pores and fine lines, eyelashes, individual flyaway and translucent hairs, fabric fibers, surface microtexture, lens grain, image noise, airborne dust motes, haze and smoke wisps, and tiny specular accents.',
    'Do not beautify, retouch, denoise, smooth, wax, plasticize, repaint or hallucinate the face, skin, hair or fine texture. Change low-frequency illumination and atmosphere only.',
    `Allowed illumination colors only: ${allowedLightColors.join(', ') || 'neutral source-derived light'}.`,
    'Do not invent purple, magenta, red, green or any other colored light unless that exact color is present in the allowed illumination color list and belongs to an active light.',
    'A localized saturated colored light requires a physically plausible emitter, reflective surface or motivated off-camera source that is consistent with the immutable source scene and target direction.',
    'If the unchanged source scene cannot physically support that colored light, suppress the localized chromatic cast and use at most a subtle low-saturation ambient bias; never paint an isolated purple, magenta or red rim onto the person.',
    'Do not create a collage, split screen, comparison view, double exposure, palette or explanation.',
    ...overlayContract,
    'Preserve the source image medium, rendering method, realism level, texture language and artistic style, whether it is a photograph, illustration, anime frame, 3D render or other artwork.',
    referenceMode === 'experimental-attached'
      ? 'LIGHTING SPECIFICATION (authoritative structured target; IMAGE 2 may only reinforce these lighting properties):'
      : 'LIGHTING SPECIFICATION (derived earlier; no other image is attached):',
    ...descriptorLines(descriptor, allowedLightColors),
    'Return exactly one edited image in the unchanged source style and source aspect ratio.',
  ].join('\n')
}

export function compileRouteABackgroundReplacementPrompt(
  descriptor: LightingDescriptorV1,
  generationSourceKind: RouteAGenerationSource['kind'],
  options: {
    removeGraphicOverlays?: boolean
  } = {},
) {
  const allowedLightColors = allowedRouteALightColors(descriptor)
  const sourceOverlayContract = options.removeGraphicOverlays
    ? [
        'Remove only flat composited graphic overlays from IMAGE 1: watermarks, corner logos, subtitles, timestamps, UI chrome and non-diegetic poster typography.',
        'Preserve real in-scene text printed on physical objects that belong to the retained foreground subject.',
      ]
    : [
        'Preserve flat graphic overlays that overlap the retained foreground subject; do not invent any new text, logo or watermark.',
      ]
  return [
    'ROUTE A SEMANTIC BACKGROUND REPLACEMENT CONTRACT:',
    'IMAGE 1 — GENERATION SOURCE. It is the authoritative source for the retained person or foreground subject, including identity, face, hairstyle, clothing, pose, body proportions, subject scale, subject position, camera and crop.',
    'IMAGE 2 — BACKGROUND + LIGHTING REFERENCE. IMAGE 2 is the target environment and background reference, and the authoritative target for lighting, atmosphere, depth, materials and environmental colour.',
    'This is ordinary generative background replacement. It does not use or claim a precision hair matte.',
    'Every generation is a fresh first-generation edit from IMAGE 1 and IMAGE 2; never edit, reuse or imitate a previous generated result.',
    generationSourceKind === 'color-base'
      ? 'The deterministic colour treatment already present on IMAGE 1 is intentional; retain it where compatible with the new environment.'
      : 'Retain the visible foreground subject appearance from IMAGE 1 as closely as possible.',
    'Fully replace the complete background from IMAGE 1. Do not preserve its walls, windows, scenery, practical lights, reflections, haze or environmental colour.',
    'Do not blend, splice, double expose, ghost or collage the old background with the new background.',
    'Reconstruct a coherent unobstructed version of the environment shown in IMAGE 2 behind and around the retained subject, with consistent perspective and spatial depth.',
    'Ignore and remove every person, face, body, text, logo and watermark from IMAGE 2. Never copy a reference person, their clothing, pose or identity into the result.',
    'Preserve the IMAGE 1 subject identity, face, hairstyle, clothing, pose, body proportions, scale and frame position as closely as the image editor allows.',
    'Do not beautify, retouch, denoise, smooth, wax, plasticize or redesign the retained subject.',
    'Preserve natural skin pores, eyelashes, flyaway hair, translucent hair edges, fabric fibres and surface microtexture wherever visible in IMAGE 1.',
    'Remove the old background-driven colour spill, baked key light, hard shadows, highlight placement and ambient cast from the retained subject before integrating the new environment.',
    'Relight the retained subject so key direction, fill, rim light, contact shadow, reflections, exposure hierarchy, haze and atmospheric perspective agree with IMAGE 2 and the structured lighting specification.',
    `Allowed illumination colours only: ${allowedLightColors.join(', ') || 'neutral environment-derived light'}.`,
    'Do not invent an isolated purple, magenta, red or green rim unless it is motivated by a visible emitter or reflected surface in the new environment.',
    ...sourceOverlayContract,
    'Preserve the source image medium, realism level and rendering language, whether it is a photograph, illustration, anime frame or 3D render.',
    'LIGHTING SPECIFICATION (authoritative structured target extracted from IMAGE 2):',
    ...descriptorLines(descriptor, allowedLightColors),
    'Return exactly one complete edited image using the IMAGE 1 aspect ratio. Do not return a comparison, split screen, palette, text or explanation.',
  ].join('\n')
}

// replace-background-direct-v1 (人物背景氛围融合): a single 2-image semantic edit
// — IMAGE 1 (source person) placed into IMAGE 2 (reference environment). No
// lighting descriptor, no mask/collage; the reference image IS the target scene.
export function compileReplaceBackgroundDirectPrompt(
  options: {
    removeGraphicOverlays?: boolean
  } = {},
) {
  const overlayInstruction = options.removeGraphicOverlays
    ? [
        'Remove only flat composited graphic overlays from IMAGE 1, such as watermarks, corner logos, subtitles, timestamps, UI chrome and non-diegetic poster typography. Preserve real text printed on physical subject objects.',
      ]
    : []
  return [
    'IMAGE 1 is the sole identity and subject reference.',
    'IMAGE 2 is the target environment, background, lighting and atmosphere reference.',
    '',
    'Place the person from IMAGE 1 naturally into the environment of IMAGE 2.',
    "Preserve IMAGE 1's identity, facial features, hairstyle, clothing, body proportions and pose.",
    "Do not preserve or copy IMAGE 1's original background.",
    'Remove every person from IMAGE 2 and never copy their identity, face, body or clothing.',
    'Adapt subject scale and placement only as needed for plausible perspective; do not redesign the subject.',
    "Match IMAGE 2's light direction, color temperature, exposure, contrast, cast shadows, contact shadow, reflections and haze.",
    'Preserve photographic detail including skin texture, individual hair strands, fabric texture, particles and film grain. No beauty retouching.',
    ...overlayInstruction,
    "Generate one image using IMAGE 1's aspect ratio.",
  ].join('\n')
}

export function createRouteAGenerationSpec({
  sourceNode,
  referenceNode,
  state,
  generationSource,
  referenceMode = 'descriptor-only',
}: {
  sourceNode: CanvasNode
  referenceNode: CanvasNode
  state: AppearanceTransferState
  generationSource: RouteAGenerationSource
  referenceMode?: RouteAReferenceMode
}): RouteAGenerationSpec {
  const effectiveReferenceMode: RouteAReferenceMode =
    state.lightingMode === 'replace-background'
      ? 'background-attached'
      : referenceMode
  assertRouteAInput(
    state,
    generationSource,
    effectiveReferenceMode,
    referenceNode,
  )
  if (
    generationSource.kind === 'source-rgb' &&
    generationSource.nodeId &&
    generationSource.nodeId !== sourceNode.id
  ) {
    throw new Error('Route A generation source must be the immutable original source node.')
  }
  const output = createAppearanceResolutionPlan(sourceNode, state.resolution)
  const referenceUrl =
    referenceNode.originalUrl ||
    referenceNode.previewUrl ||
    referenceNode.thumbnailUrl ||
    ''
  const generationInput = {
    order: 1,
    role: 'generation_source' as const,
    required: true,
    nodeId: generationSource.nodeId,
    assetId: generationSource.assetId,
    url: generationSource.url,
    width: generationSource.width,
    height: generationSource.height,
  }
  const inputManifest: AppearanceModelInputManifestV1 =
    effectiveReferenceMode === 'background-attached'
      ? {
          schemaVersion: 9,
          promptSchemaVersion: ROUTE_A_BACKGROUND_PROMPT_SCHEMA_VERSION,
          pipelineVersion: 'replace-background-direct-v1',
          sourceNodeId: sourceNode.id,
          referenceNodeId: referenceNode.id,
          mode: 'replace-background-relight',
          referenceAttached: true,
          backgroundMethod: 'ai-semantic',
          inputs: [
            generationInput,
            {
              order: 2,
              role: 'reference_rgb',
              required: true,
              nodeId: referenceNode.id,
              assetId: referenceNode.assetId ?? undefined,
              url: referenceUrl,
              width: referenceNode.imageWidth ?? undefined,
              height: referenceNode.imageHeight ?? undefined,
            },
          ],
          output,
        }
      : effectiveReferenceMode === 'experimental-attached'
      ? {
          schemaVersion: 4,
          promptSchemaVersion: ROUTE_A_EXPERIMENTAL_PROMPT_SCHEMA_VERSION,
          sourceNodeId: sourceNode.id,
          referenceNodeId: referenceNode.id,
          mode: 'preserve-scene-relight',
          referenceAttached: true,
          inputs: [
            generationInput,
            {
              order: 2,
              role: 'reference_rgb',
              required: true,
              nodeId: referenceNode.id,
              assetId: referenceNode.assetId ?? undefined,
              url: referenceUrl,
              width: referenceNode.imageWidth ?? undefined,
              height: referenceNode.imageHeight ?? undefined,
            },
          ],
          output,
        }
      : {
          schemaVersion: 3,
          promptSchemaVersion: ROUTE_A_PROMPT_SCHEMA_VERSION,
          sourceNodeId: sourceNode.id,
          referenceNodeId: referenceNode.id,
          mode: 'preserve-scene-relight',
          inputs: [generationInput],
          output,
        }
  const promptSchemaVersion = inputManifest.promptSchemaVersion
  const referenceAttached = effectiveReferenceMode !== 'descriptor-only'
  const colorBaseMetadata = {
    schemaVersion: 1,
    algorithmVersion: ROUTE_A_COLOR_ALGORITHM_VERSION,
    kind: generationSource.kind,
    sha256: generationSource.sha256 ?? null,
    width: generationSource.width,
    height: generationSource.height,
    parameters: {
      colorEnabled: state.colorEnabled,
      colorStrength: state.colorStrength,
      luminanceMatch: state.luminanceMatch,
      temperature: state.temperature,
      saturation: state.saturation,
      preserveSkin: state.preserveSkin,
    },
  }
  return {
    actionType: 'appearance-transfer',
    sourceNodeId: sourceNode.id,
    referenceNodeId: referenceNode.id,
    model: state.backendId as RouteASupportedBackend,
    resolution: state.resolution,
    prompt: state.lightingMode === 'replace-background'
      ? compileReplaceBackgroundDirectPrompt({
          removeGraphicOverlays: state.removeGraphicOverlays,
        })
      : compileRouteALightingPrompt(
          state.analysis.descriptor!,
          generationSource.kind,
          {
            removeGraphicOverlays: state.removeGraphicOverlays,
            referenceMode: effectiveReferenceMode,
          },
        ),
    inputManifest,
    settings: {
      actionType: 'appearance-transfer',
      imageEditMode: 'appearance-transfer-route-a',
      sourceNodeId: sourceNode.id,
      referenceNodeId: referenceNode.id,
      imageReferenceIds: referenceAttached
        ? `${sourceNode.id},${referenceNode.id}`
        : sourceNode.id,
      appearanceInputManifest: JSON.stringify(inputManifest),
      appearanceResolutionPlan: JSON.stringify(output),
      appearancePromptSchemaVersion: String(promptSchemaVersion),
      appearanceTransfer: JSON.stringify(state),
      appearanceLightingMode: state.lightingMode,
      appearanceColorEnabled: String(state.colorEnabled),
      appearanceLightingEnabled: 'true',
      appearanceRouteA: 'true',
      appearanceRouteAReferenceRgbSent: String(referenceAttached),
      appearanceReferenceAttached: String(referenceAttached),
      appearanceReferenceMode: effectiveReferenceMode,
      appearanceDescriptorHash: state.analysis.descriptorHash ?? '',
      appearanceGenerationSourceKind: generationSource.kind,
      appearanceGenerationDepth: '1',
      appearanceRootSourceNodeId: sourceNode.id,
      appearanceRemoveGraphicOverlays: String(state.removeGraphicOverlays),
      appearanceAllowedLightColors: JSON.stringify(
        state.analysis.descriptor ? allowedRouteALightColors(state.analysis.descriptor) : [],
      ),
      appearanceColorBaseAlgorithm: ROUTE_A_COLOR_ALGORITHM_VERSION,
      appearanceColorBaseMetadata: JSON.stringify(colorBaseMetadata),
      ...(state.lightingMode === 'replace-background'
        ? {
            appearancePipelineVersion: 'replace-background-direct-v1',
            appearancePromptVersion: 'replace-background-direct-prompt-v1',
            appearancePipelineStage: 'direct-generation',
            appearanceBackgroundTransferMethod: 'ai-semantic',
            appearanceReferencePersonAction: 'remove-v1',
            appearanceBackendId: state.backendId as RouteASupportedBackend,
            appearancePreciseMatting: 'false',
          }
        : {}),
    },
  }
}
