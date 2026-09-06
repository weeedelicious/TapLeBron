export type ModelCategory = 'chat' | 'image-generation' | 'video-generation'

export type ModelStatus = 'available' | 'disabled' | 'planned'

export type ModelMode =
  | 'instant'
  | 'thinking'
  | 'pro'
  | 'fast'
  | 'reference'
  | 'start-end'
  | 'extend'
  | 'edit'
  | 't2v'
  | 'i2v'
  | 'r2v'
  | 'video-edit'
  | 'text'
  | 'image-vision'
  | 'video-keyframes'
  | 'direct-video'
  | 'image-generation'
  | 'image-edit'

export type ModelCapabilities = {
  supportsText: boolean
  supportsImageVision: boolean
  supportsVideoKeyframes: boolean
  supportsDirectVideo: boolean
  supportsImageGeneration: boolean
  supportsImageEdit: boolean
  supportsVideoGeneration: boolean
  supportsBatchGeneration: boolean
  maxBatchCount: number
}

export type ModelRegistryEntry = ModelCapabilities & {
  id: string
  model: string
  label: string
  displayName: string
  family: string
  version: string
  provider: string
  category: ModelCategory
  modes: ModelMode[]
  defaultMode: ModelMode
  capabilities: ModelCapabilities
  resolvedModel: string
  status: ModelStatus
  notes?: string
  capabilityIds: string[]
  override?: Partial<ModelRegistryDefinition>
}

type ModelRegistryDefinition = {
  id: string
  displayName: string
  provider: string
  category: ModelCategory
  resolvedModel?: string
  status?: ModelStatus
  notes?: string
  capabilityIds?: string[]
  override?: {
    family?: string
    version?: string
    modes?: ModelMode[]
    defaultMode?: ModelMode
    capabilities?: Partial<ModelCapabilities>
  }
}

export const EXCLUDED_MODEL_IDS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'z-ai/glm-5.1',
  'moonshotai/kimi-k2.6',
] as const

const MODEL_REGISTRY_DEFINITIONS: ModelRegistryDefinition[] = [
  { id: 'gpt-5.5', displayName: 'GPT 5.5', provider: 'openai', category: 'chat' },
  { id: 'gpt-5.4', displayName: 'GPT 5.4', provider: 'openai', category: 'chat' },
  { id: 'gpt-5.4-mini', displayName: 'GPT 5.4 Mini', provider: 'openai', category: 'chat' },
  {
    id: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    provider: 'google',
    category: 'chat',
    capabilityIds: ['lighting.reference-descriptor'],
  },
  { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash', provider: 'google', category: 'chat' },
  {
    id: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    category: 'chat',
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    category: 'chat',
  },
  { id: 'gpt-image-2', displayName: 'GPT Image 2.0', provider: 'openai', category: 'image-generation' },
  { id: 'gpt-image-1.5', displayName: 'GPT Image 1.5', provider: 'openai', category: 'image-generation' },
  {
    id: 'mivo-nano-banana-pro',
    displayName: 'Mivo Nano-banana Pro',
    provider: 'mivo',
    category: 'image-generation',
    resolvedModel: 'NANOBANANA/gemini-3-pro-image-preview',
    override: {
      family: 'mivo-nano-banana',
      version: 'pro',
    },
  },
  {
    id: 'mivo-image-2',
    displayName: 'Mivo Image 2.0',
    provider: 'mivo',
    category: 'image-generation',
    resolvedModel: 'GPT/gpt-image-2',
    override: {
      family: 'mivo-image',
      version: '2',
    },
  },
  {
    id: 'gemini-3-pro-image-preview',
    displayName: 'Gemini 3 Pro Image',
    provider: 'google',
    category: 'image-generation',
    resolvedModel: 'gemini-3-pro-image',
    notes: '保留旧画布模型 ID，并映射到公司 API 当前提供的 Gemini 3 Pro Image 模型。',
  },
  {
    id: 'gemini-3.1-flash-image-preview',
    displayName: 'Gemini 3.1 Flash Image',
    provider: 'google',
    category: 'image-generation',
    resolvedModel: 'gemini-3.1-flash-image',
    notes: '映射到公司 API 当前提供的 Gemini 3.1 Flash Image 模型。',
  },
  {
    id: 'gemini-3.1-flash-image',
    displayName: 'Nano-banana Flash',
    provider: 'google',
    category: 'image-generation',
  },
  {
    id: 'seedream-5-pro',
    displayName: 'Seedream 5 Pro',
    provider: 'volcengine',
    category: 'image-generation',
    resolvedModel: 'bytedance-seed/seedream-5-pro',
  },
  {
    id: 'doubao-seedance-2-0-260128',
    displayName: 'Seedance 2.0',
    provider: 'doubao',
    category: 'video-generation',
  },
  {
    id: 'doubao-seedance-2-0-fast-260128',
    displayName: 'Seedance 2.0 Fast',
    provider: 'doubao',
    category: 'video-generation',
  },
  {
    id: 'doubao-seedance-2-0-mini',
    displayName: 'Seedance 2.0 Mini',
    provider: 'doubao',
    category: 'video-generation',
  },
  {
    id: 'mivo-seedance-2',
    displayName: 'Mivo Seedance 2.0',
    provider: 'mivo',
    category: 'video-generation',
    resolvedModel: 'Seedance_2_0',
    override: {
      family: 'mivo-seedance',
      version: '2.0',
      modes: ['t2v', 'i2v', 'start-end', 'reference', 'video-edit', 'extend'],
      defaultMode: 't2v',
      capabilities: {
        supportsVideoGeneration: true,
      },
    },
  },
  {
    id: 'happyhorse-1.0-t2v',
    displayName: 'HappyHorse T2V',
    provider: 'happyhorse',
    category: 'video-generation',
  },
  {
    id: 'happyhorse-1.0-i2v',
    displayName: 'HappyHorse I2V',
    provider: 'happyhorse',
    category: 'video-generation',
  },
  {
    id: 'happyhorse-1.0-r2v',
    displayName: 'HappyHorse R2V',
    provider: 'happyhorse',
    category: 'video-generation',
  },
  {
    id: 'happyhorse-1.0-video-edit',
    displayName: 'HappyHorse Video Edit',
    provider: 'happyhorse',
    category: 'video-generation',
  },
]

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  supportsText: false,
  supportsImageVision: false,
  supportsVideoKeyframes: false,
  supportsDirectVideo: false,
  supportsImageGeneration: false,
  supportsImageEdit: false,
  supportsVideoGeneration: false,
  supportsBatchGeneration: false,
  maxBatchCount: 1,
}

function inferFamily(id: string) {
  if (id.startsWith('gpt-image-')) return 'gpt-image'
  if (id.startsWith('gpt-')) return 'gpt'
  if (id.startsWith('gemini-')) return 'gemini'
  if (id.startsWith('deepseek/')) return 'deepseek'
  if (id.startsWith('doubao-seedance-')) return 'seedance'
  if (id.startsWith('seedream-')) return 'seedream'
  if (id.startsWith('happyhorse-')) return 'happyhorse'
  return id.split(/[/-]/)[0] || 'custom'
}

function inferVersion(id: string, family: string) {
  if (family === 'gpt-image') return id.replace('gpt-image-', '')
  if (family === 'gpt') return id.replace('gpt-', '')
  if (family === 'gemini') return id.replace('gemini-', '').replace('-image-preview', '-image-preview')
  if (family === 'deepseek') return id.replace('deepseek/deepseek-', '')
  if (family === 'seedance') {
    if (id.includes('-fast-')) return '2.0-fast'
    if (id.includes('-mini')) return '2.0-mini'
    return '2.0'
  }
  if (family === 'happyhorse') return id.replace('happyhorse-1.0-', '')
  return 'custom'
}

function defaultModesForFamily(family: string, version: string, category: ModelCategory): ModelMode[] {
  if (category === 'image-generation') return ['image-generation', ...(family === 'gpt-image' && version === '2' ? (['image-edit'] as ModelMode[]) : [])]
  if (category === 'video-generation') {
    if (family === 'happyhorse') return [version as ModelMode]
    return ['reference', 'start-end', 'extend', 'edit']
  }
  if (family === 'gpt') return ['instant', 'thinking', 'pro']
  if (family === 'gemini') return version.includes('flash') ? ['fast', 'thinking'] : ['fast', 'thinking', 'pro']
  if (family === 'deepseek') return []
  return ['instant']
}

function defaultModeForModes(modes: ModelMode[], family: string): ModelMode {
  if (family === 'gpt' && modes.includes('thinking')) return 'thinking'
  if (family === 'gemini' && modes.includes('fast')) return 'fast'
  return modes[0] ?? 'instant'
}

function defaultCapabilitiesForEntry(definition: ModelRegistryDefinition, family: string, version: string) {
  const capabilities = { ...DEFAULT_CAPABILITIES }

  if (definition.category === 'chat') {
    capabilities.supportsText = true
    capabilities.supportsImageVision = family === 'gpt' || family === 'gemini'
    capabilities.supportsVideoKeyframes = capabilities.supportsImageVision
  }

  if (definition.category === 'image-generation') {
    capabilities.supportsImageGeneration = true
    capabilities.supportsImageEdit = family === 'gpt-image' && version === '2'
    capabilities.supportsBatchGeneration = family === 'gpt-image' && version === '2'
    capabilities.maxBatchCount = capabilities.supportsBatchGeneration ? 4 : 1
  }

  if (definition.category === 'video-generation') {
    capabilities.supportsVideoGeneration = true
  }

  return capabilities
}

function buildRegistryEntry(definition: ModelRegistryDefinition): ModelRegistryEntry {
  const family = definition.override?.family ?? inferFamily(definition.id)
  const version = definition.override?.version ?? inferVersion(definition.id, family)
  const modes = definition.override?.modes ?? defaultModesForFamily(family, version, definition.category)
  const defaultMode = definition.override?.defaultMode ?? defaultModeForModes(modes, family)
  const capabilities = {
    ...defaultCapabilitiesForEntry(definition, family, version),
    ...(definition.override?.capabilities ?? {}),
  }

  return {
    id: definition.id,
    model: definition.id,
    label: definition.displayName,
    displayName: definition.displayName,
    family,
    version,
    provider: definition.provider,
    category: definition.category,
    modes,
    defaultMode,
    capabilities,
    resolvedModel: definition.resolvedModel ?? definition.id,
    status: definition.status ?? 'available',
    notes: definition.notes,
    capabilityIds: definition.capabilityIds ?? [],
    override: definition,
    ...capabilities,
  }
}

export const MODEL_REGISTRY = Object.fromEntries(
  MODEL_REGISTRY_DEFINITIONS.map((definition) => {
    const entry = buildRegistryEntry(definition)
    return [entry.id, entry]
  }),
) as Record<string, ModelRegistryEntry>

export function normalizeModelId(model?: string | null) {
  return (model ?? '').trim().toLowerCase()
}

export function getModelRegistryEntries() {
  return Object.values(MODEL_REGISTRY)
}

export function getSelectableModelsByCategory(category: ModelCategory) {
  return getModelRegistryEntries().filter((entry) => entry.category === category && entry.status === 'available')
}

export function getModelsForCapability(capabilityId: string) {
  const normalized = capabilityId.trim()
  if (!normalized) return []
  return getModelRegistryEntries().filter(
    (entry) =>
      entry.status === 'available' && entry.capabilityIds.includes(normalized),
  )
}

export function getModelCapability(model?: string | null): ModelRegistryEntry {
  const normalized = normalizeModelId(model)
  const registered = MODEL_REGISTRY[normalized]
  if (registered) return registered

  return buildRegistryEntry({
    id: normalized || 'custom',
    displayName: model?.trim() || 'Custom',
    provider: 'custom',
    category: 'chat',
    status: 'disabled',
    override: {
      family: normalized.split(/[/-]/)[0] || 'custom',
      version: 'custom',
      modes: ['instant'],
      capabilities: { supportsText: Boolean(normalized) },
    },
  })
}

export function modelDeclaresCapability(
  model: string | null | undefined,
  capabilityId: string,
) {
  const normalized = normalizeModelId(model)
  const entry = MODEL_REGISTRY[normalized]
  return Boolean(entry && entry.capabilityIds.includes(capabilityId.trim()))
}

export function getVisionDisabledReason(model?: string | null) {
  return getModelCapability(model).supportsImageVision
    ? null
    : '\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u8bc6\u522b\u56fe\u7247\u53c2\u8003'
}

export function getVideoKeyframeDisabledReason(model?: string | null) {
  return getModelCapability(model).supportsVideoKeyframes
    ? null
    : '\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u5173\u952e\u5e27\u89c6\u89c9\u7406\u89e3'
}

export function modelSupports(model: string | null | undefined, mode: ModelMode) {
  const capability = getModelCapability(model)
  if (mode === 'text') return capability.supportsText
  if (mode === 'image-vision') return capability.supportsImageVision
  if (mode === 'video-keyframes') return capability.supportsVideoKeyframes
  if (mode === 'direct-video') return capability.supportsDirectVideo
  if (mode === 'image-generation') return capability.supportsImageGeneration
  if (mode === 'image-edit') return capability.supportsImageEdit
  return capability.modes.includes(mode)
}
