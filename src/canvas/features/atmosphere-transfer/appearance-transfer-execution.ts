import type { CanvasNode } from '../../shared/types/canvas'
import {
  type AppearanceTransferState,
} from './appearance-transfer-types'
import {
  APPEARANCE_ROLE_TITLES,
  createAppearanceInputManifest,
  parseAppearanceInputManifest,
  type AppearanceModelInputManifestV1,
} from './appearance-transfer-input-manifest'

export { DEFAULT_APPEARANCE_BACKENDS } from './appearance-transfer-backends'

export type AppearanceGenerationSpec = {
  actionType: 'appearance-transfer'
  sourceNodeId: string
  referenceNodeId: string
  model: string
  resolution: string
  prompt: string
  settings: Record<string, string>
  inputManifest: AppearanceModelInputManifestV1
}

export function appendAppearanceControlImages(node: CanvasNode, referenceNodes: CanvasNode[]) {
  if (
    node.settings?.actionType !== 'appearance-transfer-result' ||
    !node.settings.appearanceInputManifest
  ) {
    return referenceNodes
  }
  const manifest = parseAppearanceInputManifest(node.settings.appearanceInputManifest)
  if (!manifest) return referenceNodes
  const byId = new Map(referenceNodes.map((reference) => [reference.id, reference]))
  return manifest.inputs.map((input) => {
    if (input.nodeId) {
      const existing = byId.get(input.nodeId)
      if (!existing && input.required) {
        throw new Error(`Appearance transfer input is missing: ${input.role}`)
      }
      if (existing) {
        return {
          ...existing,
          title: APPEARANCE_ROLE_TITLES[input.role],
          originalUrl: input.url,
          previewUrl: input.url,
          thumbnailUrl: input.url,
          imageWidth: input.width ?? existing.imageWidth,
          imageHeight: input.height ?? existing.imageHeight,
        }
      }
    }
    return {
      ...node,
      id: `${node.id}:appearance:${input.role}`,
      title: APPEARANCE_ROLE_TITLES[input.role],
      originalUrl: input.url,
      previewUrl: input.url,
      thumbnailUrl: input.url,
      imageWidth: input.width ?? null,
      imageHeight: input.height ?? null,
      imageMimeType: 'image/png',
    }
  })
}

export function compileAppearanceGenerationPrompt(
  state: AppearanceTransferState,
  manifest?: AppearanceModelInputManifestV1,
) {
  const lightingInstruction = state.lightingEnabled
    ? state.lightingMode === 'preserve-scene'
      ? [
          '严格保留第一张原图中的人物身份、五官、发丝、服装、姿态、镜头、裁切、主体位置、场景几何和所有物体边界。',
          '先去除原图已经烘焙的主光方向、硬阴影、高光、色温与环境包围光，只保留人物、材质、场景结构和构图。',
          '再一比一重建第二张参考图的主光方向、光源大小、软硬度、光比、曝光层级、色温、环境反射、接触阴影、雾气和空气透视。',
          '第二张参考图只是一张灯光探针；严禁复制其中的建筑、窗户、街道、招牌、人物、物体轮廓、纹理或背景结构，也不得把两张场景叠加、拼接或双重曝光。',
          '禁止新增、删除、移动、替换或重绘场景内容，禁止改变脸、发型、身体、服装与构图。',
        ].join(' ')
      : [
          '严格保留第一张原图人物的身份、五官、每根可见发丝、服装、姿态、身体比例、镜头尺度和画面位置。',
          '使用主体 alpha 分离并完全移除原图背景；不要保留原场景、原背景光斑或原环境色。',
          '以第二张参考图的环境为新背景，但排除参考图中的人物、文字和水印；保持原人物构图关系不变。',
          '先去除原人物上已经烘焙的方向光、硬阴影、高光、色温和环境包围光，再让人物一比一匹配新环境的主光方向、光比、曝光、色温、轮廓光、反射光、接触阴影、雾气和空气透视。',
          '人物发丝边缘必须自然保留半透明细节，并接受新背景透色；禁止改变脸、发型、身体、服装与姿态。',
        ].join(' ')
    : '不改变原图的灯光方向、阴影、曝光、环境氛围、雾气和场景结构。'

  const colorInstruction = state.colorEnabled
    ? `只迁移第二张参考图的主色关系、色相分布、黑白点和饱和度；色彩强度 ${state.colorStrength}%，明暗匹配 ${state.luminanceMatch}%，冷暖迁移 ${state.temperature}%，饱和度 ${state.saturation}%。`
    : '不要独立迁移参考图的调色风格；颜色变化只允许来自所要求的新灯光与环境反射。'

  const controlInstruction = [
    state.analysis.subjectAlphaUrl
      ? '后续控制图中的发丝级主体 alpha 用于锁定人物身份、半透明发丝边界和前后景合成，不是新增内容。'
      : state.analysis.subjectMaskUrl
        ? '后续控制图是基础主体遮罩，只能约束人物主体范围，不能把它当作发丝级 alpha。'
      : '',
  ].filter(Boolean).join(' ')

  const roleBinding = manifest
    ? manifest.inputs
      .map((input) => `Image ${input.order}: ${input.role} — ${APPEARANCE_ROLE_TITLES[input.role]}.`)
      .join('\n')
    : 'Image 1: source_rgb.\nImage 2: reference_rgb.'

  return [
    `INPUT ROLE BINDING (authoritative; do not reorder):\n${roleBinding}`,
    'Only source_rgb may define identity, pose, composition, camera, crop, objects and scene content. reference_rgb supplies appearance targets only.',
    '输入顺序固定：第一张原图是唯一的人物、构图和内容来源；第二张图片只提供色彩、灯光与环境氛围参考。',
    lightingInstruction,
    colorInstruction,
    controlInstruction,
    state.preserveSkin ? '保持自然、连续的肤色层次，禁止出现青紫、绿色或块状肤色污染。' : '',
    '输出单张完整结果图，不输出拼图、对比图、色卡、文字、水印或解释。',
  ]
    .filter(Boolean)
    .join('\n')
}

export function compileFlux2KleinAppearancePrompt(
  state: AppearanceTransferState,
  manifest: AppearanceModelInputManifestV1,
  basePrompt = compileAppearanceGenerationPrompt(state, manifest),
) {
  const controlRoles = manifest.inputs
    .slice(2)
    .map((input) => `Image ${input.order} is source-only control data (${input.role}); never render it as visible content.`)
    .join(' ')
  const colorTarget = state.colorEnabled
    ? 'Copy the reference color relationships and grade as part of the relighting.'
    : 'Do not apply an independent color grade, but the new illumination color, color temperature, reflections and atmospheric tint must still match Image 2.'
  const modeInstruction = state.lightingMode === 'replace-background'
    ? [
        'Keep only the exact person from Image 1 using the supplied continuous subject alpha.',
        'Remove the original background completely and use Image 2 as the new environmental background, excluding its people, text and watermarks.',
        'Preserve the source person identity, face, hair, clothing, pose, scale, crop and placement exactly.',
        'Remove the source person baked lighting before matching the new background key light, fill, rim light, shadows, reflections, haze and atmospheric perspective.',
      ].join(' ')
    : [
        'Image 1 is the immutable and only source of identity, face, hair, clothing, pose, silhouette, camera, crop, geometry, objects and scene layout.',
        'Image 2 is only the lighting and atmosphere reference.',
        'First neutralize the baked key-light direction, hard shadows, highlights, exposure bias, color temperature and ambient cast from Image 1.',
        'Then reconstruct Image 2 key direction, source size, softness, contrast, exposure hierarchy, color temperature, bounce light, contact shadows, haze and atmospheric perspective on the unchanged Image 1 composition.',
        'Never copy or blend any person, sign, window, building, street, object, texture or background structure from Image 2.',
        'Do not create a double exposure, collage, scene overlay or background splice.',
      ].join(' ')

  return [
    basePrompt,
    'FLUX.2 KLEIN EXECUTION CONTRACT:',
    modeInstruction,
    colorTarget,
    controlRoles,
    'Output exactly one photorealistic edited version of Image 1 at the requested source aspect ratio. No comparison view, split screen, labels, palette, text or explanation.',
  ]
    .filter(Boolean)
    .join('\n')
}

export function createAppearanceGenerationSpec(
  sourceNode: CanvasNode,
  referenceNode: CanvasNode,
  state: AppearanceTransferState,
): AppearanceGenerationSpec {
  if (!state.backendId) {
    throw new Error(
      state.backendSelectionError?.code === 'invalid-backend'
        ? `Unknown appearance backend: ${state.backendSelectionError.rawId}`
        : 'No appearance finalizer is selected.',
    )
  }
  const inputManifest = createAppearanceInputManifest(sourceNode, referenceNode, state)
  return {
    actionType: 'appearance-transfer',
    sourceNodeId: sourceNode.id,
    referenceNodeId: referenceNode.id,
    model: state.backendId,
    resolution: state.resolution,
    prompt: compileAppearanceGenerationPrompt(state, inputManifest),
    inputManifest,
    settings: {
      actionType: 'appearance-transfer',
      imageEditMode: 'appearance-transfer',
      sourceNodeId: sourceNode.id,
      referenceNodeId: referenceNode.id,
      imageReferenceIds: `${sourceNode.id},${referenceNode.id}`,
      appearanceInputManifest: JSON.stringify(inputManifest),
      appearanceResolutionPlan: JSON.stringify(inputManifest.output),
      appearancePromptSchemaVersion: String(inputManifest.promptSchemaVersion),
      appearanceTransfer: JSON.stringify(state),
      appearanceLightingMode: state.lightingMode,
      appearanceColorEnabled: String(state.colorEnabled),
      appearanceLightingEnabled: String(state.lightingEnabled),
      appearanceAnalysisStatus: state.analysis.status,
    },
  }
}
