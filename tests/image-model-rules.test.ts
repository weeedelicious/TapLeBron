/**
 * 图片节点模型：Seedream 5 Pro + Nano-banana Flash（2026-08-28）。
 *
 * Lite 已从下拉拿掉；存量节点上的 seedream-5-lite 读的时候改写成 Pro。
 * Flash 跟 Pro 走同一套 Gemini 出图参数（gemini-params / gemini-interactions）。
 */
import { describe, expect, it } from 'vitest'
import {
  getImageGenerationCounts,
  getImageRatioOptions,
  getImageResolutionOptions,
  listSelectableImageModels,
  normalizeImageGenerationCount,
  normalizeImageModelValue,
  normalizeImageRatioValue,
  normalizeImageResolutionValue,
  validateImageCapability,
} from '@/lib/imageRules'

const openAIImageProvider = require('../server/providers/OpenAIImageProvider')

describe('图片节点可选模型', () => {
  it('下拉是 Nano Pro / Flash / GPT / Seedream Pro，没有 Lite', () => {
    const models = listSelectableImageModels()
    expect(models.map((item) => item.value)).toEqual([
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
      'gpt-image-2',
      'seedream-5-pro',
    ])
    expect(models.map((item) => item.label)).toEqual([
      'Nano-banana Pro',
      'Nano-banana Flash',
      'GPT image 2.0',
      'Seedream 5 Pro',
    ])
  })

  it('已下线的 Lite 读成 Pro，网关 id 也归一', () => {
    expect(normalizeImageModelValue('seedream-5-lite')).toBe('seedream-5-pro')
    expect(normalizeImageModelValue('seedream5lite')).toBe('seedream-5-pro')
    expect(normalizeImageModelValue('bytedance-seed/seedream-5-lite')).toBe('seedream-5-pro')
    expect(normalizeImageModelValue('bytedance-seed/seedream-5-pro')).toBe('seedream-5-pro')
    expect(openAIImageProvider.normalizeImageModel('seedream-5-lite')).toBe('seedream-5-pro')
  })

  it('Flash 别名归一到 gemini-3.1-flash-image', () => {
    expect(normalizeImageModelValue('nano-banana-flash')).toBe('gemini-3.1-flash-image')
    expect(normalizeImageModelValue('gemini-3.1-flash-image-preview')).toBe('gemini-3.1-flash-image')
    expect(openAIImageProvider.normalizeImageModel('Nano-banana Flash')).toBe('gemini-3.1-flash-image')
  })
})

describe('Nano-banana Flash 跟 Pro 同一套参数', () => {
  it('1K / 2K / 4K，比例跟 Pro 一样', () => {
    expect(getImageResolutionOptions('gemini-3.1-flash-image')).toEqual(['1K', '2K', '4K'])
    expect(getImageRatioOptions('gemini-3.1-flash-image').map((item) => item.value)).toEqual(
      getImageRatioOptions('gemini-3-pro-image').map((item) => item.value),
    )
    expect(normalizeImageResolutionValue('gemini-3.1-flash-image', '4K')).toBe('4K')
  })

  it('走 gemini-params + gemini-interactions', () => {
    const rule = openAIImageProvider.getImageModelRule('gemini-3.1-flash-image')
    expect(rule.providerModel).toBe('gemini-3.1-flash-image')
    expect(rule.sizeStrategy).toBe('gemini-params')
    expect(rule.apiStyle).toBe('gemini-interactions')
    expect(openAIImageProvider.isGeminiImageParamModel('gemini-3.1-flash-image')).toBe(true)
    expect(openAIImageProvider.isGeminiInteractionsImageModel('gemini-3.1-flash-image')).toBe(true)
    expect(openAIImageProvider.geminiImageParamsForModel('gemini-3.1-flash-image', '16:9', '2K')).toEqual({
      image_size: '2K',
      aspect_ratio: '16:9',
    })
  })

  it('参考图上限 10，一次 1/2/4 张', () => {
    expect(validateImageCapability({
      model: 'gemini-3.1-flash-image',
      prompt: '一只猫',
      imageCount: 10,
      ratio: '16:9',
      resolution: '1K',
      count: 1,
    })).toBe('')
    expect(validateImageCapability({
      model: 'gemini-3.1-flash-image',
      prompt: '一只猫',
      imageCount: 11,
      ratio: '16:9',
      resolution: '1K',
      count: 1,
    })).toContain('最多支持 10')
    expect(getImageGenerationCounts('gemini-3.1-flash-image')).toEqual([1, 2, 4])
    expect(normalizeImageGenerationCount('gemini-3.1-flash-image', 4)).toBe(4)
  })
})

describe('Seedream 5 Pro 的清晰度 / 比例', () => {
  it('可选 1K / 1.5K / 2K，没有 3K / 4K', () => {
    expect(getImageResolutionOptions('seedream-5-pro')).toEqual(['1K', '1.5K', '2K'])
    expect(getImageResolutionOptions('seedream-5-pro')).not.toContain('3K')
    expect(getImageResolutionOptions('seedream-5-pro')).not.toContain('4K')
  })

  it('从 4K 切过来落到 1K，1.5K 不被降级', () => {
    expect(normalizeImageResolutionValue('seedream-5-pro', '4K')).toBe('1K')
    expect(normalizeImageResolutionValue('seedream-5-pro', '1.5K')).toBe('1.5K')
  })

  it('没有 4:5 / 5:4 / 2:1', () => {
    const ratios = getImageRatioOptions('seedream-5-pro').map((item) => item.value)
    expect(ratios).toContain('auto')
    expect(ratios).toContain('16:9')
    expect(ratios).not.toContain('4:5')
    expect(ratios).not.toContain('2:1')
    expect(normalizeImageRatioValue('seedream-5-pro', '4:5')).toBe('16:9')
  })

  it('参考图上限 10', () => {
    expect(validateImageCapability({
      model: 'seedream-5-pro',
      prompt: '一只猫',
      imageCount: 10,
      ratio: '16:9',
      resolution: '2K',
      count: 1,
    })).toBe('')
    expect(validateImageCapability({
      model: 'seedream-5-pro',
      prompt: '一只猫',
      imageCount: 11,
      ratio: '16:9',
      resolution: '2K',
      count: 1,
    })).toContain('最多支持 10')
  })
})

describe('Seedream Pro 发给网关的请求体', () => {
  it('走目录 id，固定比例写成像素，自适应写成档位，不带 sequential', () => {
    const body = openAIImageProvider.seedreamRequestBody({
      model: 'seedream-5-pro',
      prompt: '一只猫',
      ratio: '16:9',
      resolution: '1.5K',
      count: 2,
      images: ['https://example.com/a.png', 'https://example.com/b.png'],
    })
    expect(body.model).toBe('bytedance-seed/seedream-5-pro')
    expect(body.size).toBe('2048x1152')
    expect(body.watermark).toBe(false)
    expect(body).not.toHaveProperty('sequential_image_generation')
    expect(body.image).toEqual(['https://example.com/a.png', 'https://example.com/b.png'])

    const auto = openAIImageProvider.seedreamRequestBody({
      model: 'seedream-5-pro',
      prompt: '一只猫',
      ratio: 'auto',
      resolution: '2K',
      count: 1,
    })
    expect(auto.size).toBe('2K')
  })

  it('单张参考图写成字符串', () => {
    const body = openAIImageProvider.seedreamRequestBody({
      model: 'seedream-5-pro',
      prompt: '换衣服',
      ratio: '1:1',
      resolution: '2K',
      images: ['https://example.com/a.png'],
    })
    expect(body.image).toBe('https://example.com/a.png')
  })
})

describe('没被这次改动带跑的模型', () => {
  it('Nano-banana Pro 仍是 1K / 2K / 4K', () => {
    expect(getImageResolutionOptions('gemini-3-pro-image')).toEqual(['1K', '2K', '4K'])
    expect(normalizeImageResolutionValue('gemini-3-pro-image', '4K')).toBe('4K')
  })

  it('GPT image 2.0 仍走 computed size', () => {
    expect(openAIImageProvider.getImageModelRule('gpt-image-2').sizeStrategy).toBe('computed')
    expect(openAIImageProvider.isVolcengineImageModel('gpt-image-2')).toBe(false)
  })
})
