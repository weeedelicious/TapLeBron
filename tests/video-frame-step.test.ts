import { describe, expect, it } from 'vitest'
import {
  frameNumberFromTime,
  frameStepSecondsForFps,
  formatVideoFps,
  nextVideoFrameTime,
  parseVideoFps,
} from '@/lib/videoFrame'

describe('瑙嗛逐帧播放按源帧率步进', () => {
  it('24fps 使用 1/24 秒，而不是固定 1/30 秒', () => {
    expect(frameStepSecondsForFps(24)).toBeCloseTo(1 / 24, 10)
    expect(nextVideoFrameTime(0, 1, 24, 1)).toBeCloseTo(1 / 24, 10)
    expect(nextVideoFrameTime(1 / 24, 1, 24, 1)).toBeCloseTo(2 / 24, 10)
    expect(frameNumberFromTime(1 / 24, 24)).toBe(2)
  })

  it('支持 ffprobe 分数帧率并在缺失元数据时兼容 30fps', () => {
    expect(parseVideoFps('24000/1001')).toBeCloseTo(23.976, 3)
    expect(frameStepSecondsForFps('24000/1001')).toBeCloseTo(1001 / 24000, 10)
    expect(frameStepSecondsForFps(undefined)).toBeCloseTo(1 / 30, 10)
  })

  it('不会越过视频最后一帧，信息显示保留有效小数', () => {
    expect(nextVideoFrameTime(0.99, 1, 24, 1)).toBeCloseTo(23 / 24, 10)
    expect(formatVideoFps(24)).toBe('24 fps')
    expect(formatVideoFps('30000/1001')).toBe('29.97 fps')
    expect(formatVideoFps(undefined)).toBe('—')
  })
})
