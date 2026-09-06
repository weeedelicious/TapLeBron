import type { CanvasNodeData, ImageParams, VideoParams, AudioParams, TextParams, ScriptParams } from './types'
import { IMAGE_DEFAULTS, listSelectableImageModels, normalizeImageModelValue } from './imageRules'
import { VIDEO_DEFAULTS, listSelectableVideoModels } from './videoRules'

export const NODE_TYPE_INT: Record<string, number> = {
  text: 1, image: 2, video: 3, video_merge: 4, director_stage: 5, audio: 6, script: 7, upload: 8, group: 9,
  panorama_viewer: 10, image_compare: 11, video_compare: 12,
}

export const NODE_INT_TYPE: Record<number, string> = Object.fromEntries(
  Object.entries(NODE_TYPE_INT).map(([k, v]) => [v, k])
)

export const NODE_LABELS: Record<string, string> = {
  text: '文本节点', image: '图片节点', video: '视频节点',
  video_merge: '视频合成', director_stage: '三维空间', audio: '音频节点',
  script: '脚本节点', upload: '上传资源', group: '分组', panorama_viewer: '360°查看器',
  image_compare: '图片对比', video_compare: '视频对比'
}

export const DEFAULT_IMAGE_MODEL = IMAGE_DEFAULTS.model

export function normalizeImageModel(model?: string): string {
  return normalizeImageModelValue(model)
}

export function defaultImageParams(): ImageParams {
  return {
    prompt: '',
    model: DEFAULT_IMAGE_MODEL,
    count: IMAGE_DEFAULTS.count,
    settings: {
      quality: IMAGE_DEFAULTS.quality,
      ratio: IMAGE_DEFAULTS.ratio,
      resolution: IMAGE_DEFAULTS.resolution,
    },
    modeType: 'text2image',
    imageList: [], imageListOrder: [],
    videoList: [], audioList: [], textList: [],
  }
}

export function defaultVideoParams(): VideoParams {
  return {
    prompt: '',
    model: VIDEO_DEFAULTS.model,
    modeType: VIDEO_DEFAULTS.mode,
    count: VIDEO_DEFAULTS.count,
    imageList: [], imageListOrder: [],
    mixedList: [], mixedListOrder: [],
    videoList: [], audioList: [], textList: [],
    settings: {
      ratio: VIDEO_DEFAULTS.ratio,
      resolution: VIDEO_DEFAULTS.resolution,
      duration: VIDEO_DEFAULTS.duration,
      enableSound: VIDEO_DEFAULTS.enableSound,
    }
  }
}

export function defaultAudioParams(): AudioParams {
  return { type: 'tts', prompt: '', model: 'tts-default', voice: 'default', speed: 1.0 }
}

export function defaultTextParams(): TextParams {
  return {
    content: '',
    model: DEFAULT_TEXT_MODEL,
    thinkingMode: 'fast',
    performanceMode: 'highest',
    reasoningEffort: 'high',
    prompt: '',
    imageList: [], videoList: [], textList: [],
    displayStyle: { fontSize: 16, lineHeight: 1.75, color: '#f3f0ff' },
  }
}

/** 文字节点的默认模型。2026-08-17 从 gpt-5.5 换成 GPT-5.6 Sol：网关账号的白名单里
 *  已经没有 gpt-5.5 了（claude-opus-4-8 也没有），点生成会直接报
 *  "user not allowed to access model"。目录里没有裸的 gpt-5.6-sol —— Sol 只有
 *  codex/ 这一条路由，而白名单里有 codex/*，实调通过。 */
export const DEFAULT_TEXT_MODEL = 'codex/gpt-5.6-sol'

export const TEXT_MODELS = [
  { value: DEFAULT_TEXT_MODEL, label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.6-luna',     label: 'GPT-5.6 Luna' },
]

/** 已经从白名单里下掉的旧模型 → 现在拿谁顶上。
 *  模型 id 是存进节点 params 落库的，画布里已经躺着一堆写着 gpt-5.5 的文字节点；
 *  只换上面那张表的话，它们的下拉会渲染成空白选项、点生成照旧失败。这里在读的时候
 *  统一改写，不动库里的存量数据（用户在节点上选一次就自然写回新值）。 */
const RETIRED_TEXT_MODELS: Record<string, string> = {
  'gpt-5.5': DEFAULT_TEXT_MODEL,
  'gpt-5.4': DEFAULT_TEXT_MODEL,
  'claude-opus-4-8': DEFAULT_TEXT_MODEL,
}

export function normalizeTextModel(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return DEFAULT_TEXT_MODEL
  if (RETIRED_TEXT_MODELS[raw]) return RETIRED_TEXT_MODELS[raw]
  // 认不出来的值也回退到默认 —— 下拉只有上面两项，认不出来就会渲染成空白选项。
  return TEXT_MODELS.some((item) => item.value === raw) ? raw : DEFAULT_TEXT_MODEL
}

export const TEXT_THINKING_MODES = [
  { value: 'fast', label: '快速' },
  { value: 'deep', label: '深度思考' },
] as const

export function defaultScriptParams(): ScriptParams {
  return { description: '', rows: [] }
}

export function makeNodeData(type: string, name: string): CanvasNodeData {
  switch (type) {
    case 'image':
      return { type: 'image', name, url: [], action: 'image_generate', params: defaultImageParams() as unknown as Record<string, unknown> }
    case 'video':
      return { type: 'video', name, url: [], action: 'video_generate', params: defaultVideoParams() as unknown as Record<string, unknown> }
    case 'audio':
      return { type: 'audio', name, url: [], action: 'audio_generate', params: defaultAudioParams() as unknown as Record<string, unknown> }
    case 'text':
      return { type: 'text', name, url: [], action: 'text_node', params: defaultTextParams() as unknown as Record<string, unknown> }
    case 'script':
      return { type: 'script', name, url: [], action: 'script_node', params: defaultScriptParams() as unknown as Record<string, unknown> }
    case 'video_merge':
      return { type: 'video_merge', name, url: [], action: 'video_merge', params: defaultVideoParams() as unknown as Record<string, unknown> }
    case 'atmosphere_transfer':
      // Processor node: 原图/参考图 are supplied by connections (params.sourceRef /
      // params.referenceRef); atState is seeded lazily from DEFAULT by the node.
      return { type: 'atmosphere_transfer', name, url: [], action: 'atmosphere_transfer',
        params: { sourceRef: null, referenceRef: null } as unknown as Record<string, unknown> }
    case 'panorama_viewer':
      return { type: 'panorama_viewer', name, url: [], action: 'panorama_viewer',
        params: { panoramaRef: null } as unknown as Record<string, unknown> }
    case 'image_compare':
      // 只看不生成的查看器节点：两路图片输入由连线写进 params.compareRefA / compareRefB。
      // compareMode 只是下次打开全屏的初始模式，滑杆位置和透明度一律不落库。
      return { type: 'image_compare', name, url: [], action: 'image_compare',
        params: { compareRefA: null, compareRefB: null, compareMode: 'side-by-side' } as unknown as Record<string, unknown> }
    case 'video_compare':
      // 和图片对比一样：槽位身份必须落在节点 params 里，边从不单独持久化。
      return { type: 'video_compare', name, url: [], action: 'video_compare',
        params: {
          compareRefA: null, compareRefB: null, compareRefC: null, compareRefD: null,
          compareMode: 'side-by-side',
        } as unknown as Record<string, unknown> }
    case 'director_stage':
      // params.stage 留空即可 —— readDirectorStageState 读不到会回落到默认机位和自然站姿，
      // 在这里塞一份默认值只会让每个新节点的 payload 白白多几百字节。
      return {
        type: 'director_stage', name, url: [], action: 'director_stage',
        contentWidth: 420, contentHeight: 340,
      }
    case 'upload':
      return { type: 'upload', name, url: [], action: 'image_resource' }
    case 'group':
      return { type: 'group', name, url: [], action: 'image_resource',
        params: { childIds: [], color: '#252525' } as unknown as Record<string, unknown> }
    default:
      return { type: 'upload', name, url: [], action: 'image_resource' }
  }
}


export const IMAGE_MODELS = [
  ...listSelectableImageModels(),
]

export const VIDEO_MODELS = [
  ...listSelectableVideoModels(),
]
