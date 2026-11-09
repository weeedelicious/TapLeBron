/**
 * 图片节点模型：Nano-banana Pro / 2.1、GPT image、Seedream 5 Pro / Lite。
 *
 * 2026-08-28 曾把 Lite 下线，线上后来又放开（RETIRED_IMAGE_MODELS 清空），这里按线上现状。
 * Flash 已从新建菜单移除，旧别名仍归一到 gemini-3.1-flash-image。
 */
import { describe, expect, it } from 'vitest'
import {
  getImageGenerationCounts,
  getImageModelDisplayName,
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
  it('下拉包含 Nano Pro / 2.1、GPT、Image 2.6 和 Seedream Pro / Lite', () => {
    const models = listSelectableImageModels()
    expect(models.map((item) => item.value)).toEqual([
      'gemini-3-pro-image',
      'gemini-nano-banana-2.1',
      'gpt-image-2',
      'gpt-image-2.6-flare',
      'gpt-image-2.6-sunburst',
      'seedream-5-pro',
      'seedream-5-lite',
    ])
    expect(models.map((item) => item.label)).toEqual([
      'Nano-banana Pro',
      'Nano-banana 2.1',
      'GPT image 2.0',
      'GPT image 2.6 Flare',
      'GPT image 2.6 Sunburst',
      'Seedream 5 Pro',
      'Seedream 5 Lite',
    ])
  })

  it('Lite 保持自己的模型，网关 id 也归一', () => {
    expect(normalizeImageModelValue('seedream-5-lite')).toBe('seedream-5-lite')
    expect(normalizeImageModelValue('seedream5lite')).toBe('seedream-5-lite')
    expect(normalizeImageModelValue('bytedance-seed/seedream-5-lite')).toBe('seedream-5-lite')
    expect(normalizeImageModelValue('bytedance-seed/seedream-5-pro')).toBe('seedream-5-pro')
    expect(openAIImageProvider.normalizeImageModel('seedream-5-lite')).toBe('seedream-5-lite')
  })

  it('Flash 别名归一到 gemini-3.1-flash-image', () => {
    expect(normalizeImageModelValue('nano-banana-flash')).toBe('gemini-3.1-flash-image')
    expect(normalizeImageModelValue('gemini-3.1-flash-image-preview')).toBe('gemini-3.1-flash-image')
    expect(openAIImageProvider.normalizeImageModel('Nano-banana Flash')).toBe('gemini-3.1-flash-image')
  })
})

describe('Image 2.6 网关模型', () => {
  it('下拉与生成进度统一显示 GPT 名称', () => {
    expect(getImageModelDisplayName('gpt-image-2.6-flare')).toBe('GPT image 2.6 Flare')
    expect(getImageModelDisplayName('openai/gpt-image-2.6-sunburst')).toBe('GPT image 2.6 Sunburst')
    expect(getImageModelDisplayName('seedance-2.5')).toBe('seedance-2.5')
  })

  it('2.5 下线：旧节点按同款改用 2.6，但出过的图仍显示 2.5 的名字', () => {
    expect(normalizeImageModelValue('gpt-image-2.5-flare')).toBe('gpt-image-2.6-flare')
    expect(normalizeImageModelValue('openai/gpt-image-2.5-sunburst')).toBe('gpt-image-2.6-sunburst')
    expect(openAIImageProvider.normalizeImageModel('gpt-image-2.5-flare')).toBe('gpt-image-2.6-flare')
    expect(openAIImageProvider.providerModelForImage('gpt-image-2.5-sunburst')).toBe('openai/gpt-image-2.6-sunburst')
    expect(listSelectableImageModels().some((item) => item.value.startsWith('gpt-image-2.5'))).toBe(false)
    expect(getImageModelDisplayName('gpt-image-2.5-flare')).toBe('GPT image 2.5 Flare')
    expect(getImageModelDisplayName('openai/gpt-image-2.5-sunburst')).toBe('GPT image 2.5 Sunburst')
  })

  it.each([
    ['gpt-image-2.6-flare', 'openai/gpt-image-2.6-flare'],
    ['gpt-image-2.6-sunburst', 'openai/gpt-image-2.6-sunburst'],
  ])('%s 保留完整 wire model id', (model, providerModel) => {
    expect(normalizeImageModelValue(providerModel)).toBe(model)
    expect(openAIImageProvider.normalizeImageModel(providerModel)).toBe(model)
    expect(openAIImageProvider.providerModelForImage(model)).toBe(providerModel)
    expect(openAIImageProvider.isGptImageModel(model)).toBe(true)
  })

  it.each(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])('%s 沿用 GPT 图片能力', (model) => {
    expect(getImageResolutionOptions(model)).toEqual(['1K', '2K', '4K'])
    expect(getImageRatioOptions(model).map((item) => item.value)).toEqual(
      getImageRatioOptions('gpt-image-2').map((item) => item.value),
    )
    expect(getImageGenerationCounts(model)).toEqual([1, 2, 4])
    expect(openAIImageProvider.getImageModelRule(model).sizeStrategy).toBe('computed')
    expect(validateImageCapability({
      model,
      prompt: '一只猫',
      imageCount: 16,
      ratio: '16:9',
      resolution: '4K',
      count: 4,
    })).toBe('')
    expect(validateImageCapability({
      model,
      prompt: '一只猫',
      imageCount: 17,
      ratio: '16:9',
      resolution: '1K',
      count: 1,
    })).not.toBe('')
  })

  // 2026-11-09 生产网关实测：两款都能出 3840x2160 / 2160x3840 / 2880x2880 / 3840x1920
  it.each(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])('%s 的 4K 是真 4K', (model) => {
    expect(openAIImageProvider.imageSizeForModel(model, '16:9', '4K')).toBe('3840x2160')
    expect(openAIImageProvider.imageSizeForModel(model, '9:16', '4K')).toBe('2160x3840')
    expect(openAIImageProvider.imageSizeForModel(model, '1:1', '4K')).toBe('2880x2880')
    expect(openAIImageProvider.imageSizeForModel(model, '2:1', '4K')).toBe('3840x1920')
    expect(openAIImageProvider.imageSizeForModel(model, '16:9', '2K')).toBe('2048x1152')
    expect(openAIImageProvider.imageSizeForModel(model, '1:1', '1K')).toBe('1024x1024')
  })

  it('GPT image 2.0 的 4K 尺寸不变', () => {
    expect(openAIImageProvider.imageSizeForModel('gpt-image-2', '16:9', '4K')).toBe('2736x1536')
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

describe('GPT Image moderation', () => {
  it.each([
    'gpt-image-2',
    'gpt-image-2.6-flare',
    'gpt-image-2.6-sunburst',
  ])('%s uses low moderation', (model) => {
    expect(openAIImageProvider.imageModerationForModel(model)).toBe('low')
  })

  it.each([
    'gemini-3-pro-image',
    'gemini-3.1-flash-image',
    'seedream-5-pro',
  ])('%s does not receive an OpenAI moderation parameter', (model) => {
    expect(openAIImageProvider.imageModerationForModel(model)).toBe('')
  })
})
