import type { CanvasNodeData, ImageParams, VideoParams, AudioParams, TextParams, ScriptParams } from './types'

export const NODE_TYPE_INT: Record<string, number> = {
  text: 1, image: 2, video: 3, video_merge: 4, director_stage: 5, audio: 6, script: 7, upload: 8, group: 9
}

export const NODE_INT_TYPE: Record<number, string> = Object.fromEntries(
  Object.entries(NODE_TYPE_INT).map(([k, v]) => [v, k])
)

export const NODE_LABELS: Record<string, string> = {
  text: '文本节点', image: '图片节点', video: '视频节点',
  video_merge: '视频合成', director_stage: '导演台', audio: '音频节点',
  script: '脚本节点', upload: '上传资源', group: '分组'
}

export function defaultImageParams(): ImageParams {
  return {
    prompt: '',
    model: 'gemini-3-pro-image-preview',
    count: 1,
    settings: { quality: 'medium', ratio: '16:9', resolution: '1K' },
    modeType: 'text2image',
    imageList: [], imageListOrder: [],
    videoList: [], audioList: [], textList: [],
  }
}

export function defaultVideoParams(): VideoParams {
  return {
    prompt: '',
    model: 'Seedance_2_0',
    modeType: 'text2video',
    count: 1,
    imageList: [], imageListOrder: [],
    mixedList: [], mixedListOrder: [],
    videoList: [], audioList: [], textList: [],
    settings: { ratio: '16:9', resolution: '720P', duration: 5, enableSound: 'on' }
  }
}

export function defaultAudioParams(): AudioParams {
  return { type: 'tts', prompt: '', model: 'tts-default', voice: 'default', speed: 1.0 }
}

export function defaultTextParams(): TextParams {
  return { content: '' }
}

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
    case 'director_stage':
      return { type: 'director_stage', name, url: [], action: 'director_stage' }
    case 'upload':
      return { type: 'upload', name, url: [], action: 'image_resource' }
    case 'group':
      return { type: 'group', name, url: [], action: 'image_resource',
        params: { childIds: [], color: '#1a3a2a' } as unknown as Record<string, unknown> }
    default:
      return { type: 'upload', name, url: [], action: 'image_resource' }
  }
}


export const IMAGE_MODELS = [
  { value: 'gemini-3-pro-image-preview', label: 'Gemini 3 Pro' },
  { value: 'gemini-3.1-flash-image-preview', label: 'Gemini Flash' },
  { value: 'gpt-image-2', label: 'GPT Image 2' },
]

export const VIDEO_MODELS = [
  { value: 'Seedance_2_0', label: 'Seedance 2.0' },
  { value: 'Seedance_2_0_Fast', label: 'Seedance 2.0 Fast' },
]
