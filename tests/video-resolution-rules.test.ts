/**
 * Seedance 2.5 开放 1080P（2026-08-19）。
 *
 * 上游文档（火山方舟 doc 82379/1520757）对 2.5 的 resolution 写得很死：
 *   Seedance 2.5 ：默认值 720p；可选值 480p、720p、1080p
 *   Seedance 2.0 ：默认值 720p；可选值 480p、720p、1080p、4k
 * 所以 2.5 **没有 4k**（营销口径里的"原生 4K"不是这个端点的能力）。这个测试同时锁两头：
 * 1080P 必须能选、能过校验、不被静默降级；4K 必须仍然被拒。
 *
 * 「不被静默降级」是重点：normalizeVideoResolutionValue 对不认识的值是**悄悄换成默认值**
 * 而不是报错，所以配置没同步时用户会选了 1080P 却拿到 720P，界面上还看不出来。
 */
import { describe, expect, it } from 'vitest'
import {
  getVideoResolutionNote,
  getVideoResolutionOptions,
  normalizeVideoResolutionValue,
  validateVideoCapability,
} from '@/lib/videoRules'

/** 别名走 extends 继承基础条目，一起验，避免只改了基础条目而别名没跟上。 */
const SEEDANCE_2_5 = ['Seedance_2_5', 'bytedance/seedance-2.5', 'dreamina-seedance-2-5-260628']

function capability(model: string, resolution: string) {
  return validateVideoCapability({
    model,
    mode: 't2v',
    prompt: '一只猫走过屋顶',
    imageCount: 0,
    videoCount: 0,
    audioCount: 0,
    ratio: '16:9',
    resolution,
    duration: 5,
    count: 1,
  })
}

describe('Seedance 2.5 的清晰度', () => {
  it.each(SEEDANCE_2_5)('%s 可选 480P / 720P / 1080P，且不含 4K', (model) => {
    expect(getVideoResolutionOptions(model)).toEqual(['480P', '720P', '1080P'])
  })

  it.each(SEEDANCE_2_5)('%s 选 1080P 不被静默降级', (model) => {
    expect(normalizeVideoResolutionValue(model, '1080P')).toBe('1080P')
  })

  it.each(SEEDANCE_2_5)('%s 的 1080P 能过能力校验', (model) => {
    expect(capability(model, '1080P')).toBeFalsy()
  })

  it('4K 仍然被拒（上游没给 2.5 开 4k）', () => {
    expect(getVideoResolutionOptions('Seedance_2_5')).not.toContain('4K')
    expect(normalizeVideoResolutionValue('Seedance_2_5', '4K')).toBe('720P')
    expect(capability('Seedance_2_5', '4K')).toBeTruthy()
  })

  it('1080P 会提示 10bit HEVC 的代价，720P 不提示', () => {
    expect(getVideoResolutionNote('Seedance_2_5', '1080P')).toContain('HEVC')
    expect(getVideoResolutionNote('Seedance_2_5', '720P')).toBe('')
  })
})

describe('没被这次改动带跑的模型', () => {
  it('Seedance 2.0 保持 480P / 720P / 1080P / 4K', () => {
    expect(getVideoResolutionOptions('Seedance_2_0')).toEqual(['480P', '720P', '1080P', '4K'])
  })

  it('Seedance 2.0 Fast 仍然只到 720P', () => {
    expect(getVideoResolutionOptions('Seedance_2_0_Fast')).toEqual(['480P', '720P'])
    expect(normalizeVideoResolutionValue('Seedance_2_0_Fast', '1080P')).toBe('720P')
  })

  it('MiniMax H3 不受影响', () => {
    expect(getVideoResolutionOptions('minimax-h3')).toEqual(['768P', '2K'])
  })
})

