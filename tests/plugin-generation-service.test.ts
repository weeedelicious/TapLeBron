import { describe, expect, it } from 'vitest'

process.env.DB_USER ||= 'test'
process.env.DB_PASSWORD ||= 'test'
process.env.DB_NAME ||= 'test'
process.env.SESSION_SECRET ||= 'test'
process.env.INITIAL_ADMIN_PASSWORD ||= 'test'

const service = require('../server/services/PluginGenerationService.js') as {
  _validateAndNormalize: (node: Record<string, unknown>) => Record<string, unknown>
  hasScope: (scopes: string[], required: string) => boolean
}
const { assertBillingAllowed } = require('../server/services/generationErrors.js') as {
  assertBillingAllowed: (input: Record<string, unknown>) => void
}
const { _resolveGenerationParams } = require('../server/services/PluginCanvasService.js') as {
  _resolveGenerationParams: (params: Record<string, unknown>, nodes: Record<string, unknown>[]) => Record<string, any>
}

describe('Shotflow plugin generation safety', () => {
  it('normalizes an image plan without creating any task or calling a provider', () => {
    const plan = service._validateAndNormalize({
      key: 'image-1',
      type: 'image',
      params: {
        prompt: 'cinematic portrait',
        model: 'gemini-3-pro-image',
        count: 1,
        settings: { ratio: '16:9', resolution: '1K', quality: 'high' },
        imageList: [],
      },
    })

    expect(plan).toMatchObject({
      dispatcher: 'image', model: 'gemini-3-pro-image', mode: 'text2image', quantity: 1,
    })
  })

  it('rejects a paid start without explicit confirmation', () => {
    expect(() => assertBillingAllowed({
      estimate: { billable: true, billingUnit: 'image', quantity: 1 },
      confirmBillable: false,
      nodeKey: 'image-1',
    })).toThrowError(expect.objectContaining({ code: 'BILLING_CONFIRMATION_REQUIRED', statusCode: 402 }))
  })

  it('uses separate scopes for image and video generation', () => {
    expect(service.hasScope(['generate:image'], 'generate:image')).toBe(true)
    expect(service.hasScope(['generate:image'], 'generate:video')).toBe(false)
    expect(service.hasScope(['generate'], 'generate:video')).toBe(true)
  })

  it('rejects empty prompts during the read-only planning phase', () => {
    expect(() => service._validateAndNormalize({
      key: 'video-1',
      type: 'video',
      params: { prompt: '', model: 'Seedance_2_0' },
    })).toThrowError(expect.objectContaining({ code: 'PROMPT_EMPTY' }))
  })

  it('resolves connected media to the upstream current primary output before planning', () => {
    const params = _resolveGenerationParams({
      prompt: 'keep the character',
      imageList: [{ nodeId: 'image-upstream', url: '' }],
      promptChips: [{ nodeId: 'image-upstream', url: '/assets/old.jpg', name: '图片1' }],
    }, [{
      nodeKey: 'image-upstream',
      data: JSON.stringify({
        nodeKey: 'image-upstream',
        type: 'image',
        url: ['/assets/first.jpg', '/assets/current.jpg'],
        _primaryAssetUrl: '/assets/current.jpg',
      }),
    }])

    expect(params.imageList).toEqual([{
      nodeId: 'image-upstream',
      url: '/assets/current.jpg',
      mediaType: 'image',
    }])
    expect(params.promptChips[0].url).toBe('/assets/current.jpg')
  })

  it('resolves an empty generation prompt from the latest linked text node', () => {
    const params = _resolveGenerationParams({
      prompt: '',
      textList: [{ nodeId: 'text-upstream', content: 'stale text' }],
    }, [{
      nodeKey: 'text-upstream',
      data: JSON.stringify({
        nodeKey: 'text-upstream',
        type: 'text',
        params: { content: 'latest story text' },
      }),
    }])

    expect(params.prompt).toBe('latest story text')
  })
})
