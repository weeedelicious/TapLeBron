export type VideoDepthProvider = 'video-depth-anything' | 'depthcrafter'
export type VideoDepthEncoder = 'vits' | 'vitb' | 'vitl' | 'svd'
export type VideoDepthNear = 'bright' | 'dark'
export type VideoDepthPreset = 480 | 720 | 1080

export interface VideoDepthRequest {
  provider: VideoDepthProvider
  encoder: VideoDepthEncoder
  maxRes: VideoDepthPreset
  near: VideoDepthNear
}

export const VIDEO_DEPTH_PRESETS: Array<{ id: VideoDepthPreset; label: string; maxSide: number }> = [
  { id: 480, label: '480P', maxSide: 854 },
  { id: 720, label: '720P', maxSide: 1280 },
]

export const VIDEO_DEPTH_ENCODERS: Array<{ id: Exclude<VideoDepthEncoder, 'svd'>; label: string; detail: string }> = [
  { id: 'vits', label: 'Small', detail: '更快，边缘略粗' },
  { id: 'vitb', label: 'Base', detail: '速度和细节比较均衡' },
  { id: 'vitl', label: 'Large', detail: '细节最好，也最慢' },
]

export function videoDepthMaxDurationSec(provider: VideoDepthProvider) {
  return provider === 'depthcrafter' ? 30 : 180
}

export function videoDepthModelLabel(provider: VideoDepthProvider, encoder: VideoDepthEncoder) {
  if (provider === 'depthcrafter') return 'DepthCrafter'
  if (encoder === 'vits') return 'Video Depth Anything Small'
  if (encoder === 'vitb') return 'Video Depth Anything Base'
  return 'Video Depth Anything Large'
}

export function videoDepthPhaseLabel(provider: VideoDepthProvider) {
  return provider === 'depthcrafter' ? 'DepthCrafter' : 'Video Depth Anything'
}

export function videoDepthNodeName(sourceName: string, provider: VideoDepthProvider) {
  const base = sourceName.trim() || '视频'
  return provider === 'depthcrafter' ? base + ' DepthCrafter 深度' : base + ' VDA 深度'
}
