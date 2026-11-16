/**
 * Seedance 2.5 开放 1080P（2026-08-19）。
 *
 * 上游文档（火山方舟 doc 82379/1520757）对 2.5 的 resolution 写得很死：
 *   Seedance 2.5 ：默认值 720p；可选值 480p、720p、1080p
 *   Seedance 2.0 ：默认值 720p；可选值 480p、720p、1080p、4k
 * 当时 2.5 **没有 4k**。2026-11-16 上游给 2.5 标准版开了 4K（网关已配计费），同时新增
 * Seedance 2.5 Flash（最高 720P）。这个测试锁：2.5 的 1080P / 4K 能选、能过校验、不被静默降级，
 * 点 4K 要弹成本警示；Flash 只有 480P / 720P，1080P / 4K 被拒。
 *
 * 「不被静默降级」是重点：normalizeVideoResolutionValue 对不认识的值是**悄悄换成默认值**
 * 而不是报错，所以配置没同步时用户会选了 1080P 却拿到 720P，界面上还看不出来。
 */
import { describe, expect, it } from 'vitest'
import {
  getVideoResolutionNote,
  getVideoResolutionOptions,
  getVideoResolutionWarning,
  videoModelSupportsDraft,
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
  it.each(SEEDANCE_2_5)('%s 可选 480P / 720P / 1080P / 4K', (model) => {
    expect(getVideoResolutionOptions(model)).toEqual(['480P', '720P', '1080P', '4K'])
  })

  it.each(SEEDANCE_2_5)('%s 选 4K 不被静默降级、能过能力校验', (model) => {
    expect(normalizeVideoResolutionValue(model, '4K')).toBe('4K')
    expect(capability(model, '4K')).toBeFalsy()
  })

  it.each(SEEDANCE_2_5)('%s 选 1080P 不被静默降级', (model) => {
    expect(normalizeVideoResolutionValue(model, '1080P')).toBe('1080P')
  })

  it.each(SEEDANCE_2_5)('%s 的 1080P 能过能力校验', (model) => {
    expect(capability(model, '1080P')).toBeFalsy()
  })

  it('点 2.5 的 4K 要弹成本警示，其他清晰度不弹', () => {
    expect(getVideoResolutionWarning('Seedance_2_5', '4K')).toBe('您用的是seedance2.5 4k 成本较高 请谨慎使用')
    expect(getVideoResolutionWarning('Seedance_2_5', '1080P')).toBe('')
    expect(getVideoResolutionWarning('Seedance_2_0', '4K')).toBe('')
  })

  it('1080P 会提示 10bit HEVC 的代价，720P 不提示', () => {
    expect(getVideoResolutionNote('Seedance_2_5', '1080P')).toContain('HEVC')
    expect(getVideoResolutionNote('Seedance_2_5', '720P')).toBe('')
  })
})

describe('Seedance 2.5 Flash', () => {
  const FLASH = ['Seedance_2_5_Flash', 'bytedance/seedance-2.5-flash', 'doubao-seedance-2-5-flash']
  it.each(FLASH)('%s 只有 480P / 720P，1080P 和 4K 被拒', (model) => {
    expect(getVideoResolutionOptions(model)).toEqual(['480P', '720P'])
    expect(normalizeVideoResolutionValue(model, '4K')).toBe('720P')
    expect(capability(model, '1080P')).toBeTruthy()
    expect(capability(model, '4K')).toBeTruthy()
    expect(capability(model, '720P')).toBeFalsy()
  })
  it('不走 480P 草稿再转 1080P', () => {
    expect(videoModelSupportsDraft('Seedance_2_5_Flash')).toBe(false)
    expect(videoModelSupportsDraft('Seedance_2_5')).toBe(true)
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

