import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const sharp = require('sharp') as typeof import('sharp')
const axios = require('axios') as typeof import('axios')
const textureClarityService = require('../server/services/TextureClarityService.js') as {
  FALLBACK_SEMANTIC_LABEL_SET: string
  buildRepairPrompt: (context?: Record<string, unknown>) => string
  decodeClassMap: (buffer: Buffer, width: number, height: number) => Promise<Uint8Array>
  requestSemanticParts: (buffer: Buffer, options?: Record<string, unknown>) => Promise<{
    classMapPng: Buffer
    width: number
    height: number
    labelSet: string
    fallback: boolean
    fallbackKind: string
    fallbackReason: string
    foregroundCoverage: number
  }>
}

async function personOnPlainBackground() {
  return sharp({
    create: {
      width: 80,
      height: 60,
      channels: 3,
      background: { r: 8, g: 8, b: 10 },
    },
  })
    .composite([{
      input: {
        create: {
          width: 32,
          height: 44,
          channels: 3,
          background: { r: 220, g: 120, b: 80 },
        },
      },
      left: 24,
      top: 8,
    }])
    .png()
    .toBuffer()
}

describe('细化纹理语义分区降级', () => {
  it('GPU 服务未配置或推理失败时生成安全的人物/背景类别图', async () => {
    const source = await personOnPlainBackground()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await textureClarityService.requestSemanticParts(source, {})
    warning.mockRestore()

    expect(result.fallback).toBe(true)
    expect(result.fallbackKind).toBe('subject-silhouette')
    expect(result.labelSet).toBe(textureClarityService.FALLBACK_SEMANTIC_LABEL_SET)
    expect(result.fallbackReason).toContain('未配置')
    expect(result.foregroundCoverage).toBeGreaterThan(0.05)
    expect(result.foregroundCoverage).toBeLessThan(0.95)

    const classMap = await textureClarityService.decodeClassMap(
      result.classMapPng,
      result.width,
      result.height,
    )
    const values = new Set(classMap)
    expect(values.has(0)).toBe(true)
    expect(values.has(4)).toBe(true)
    expect([...values].every((value) => value === 0 || value === 4)).toBe(true)
  })

  it('GPU 假健康但推理返回 500 时自动降级，并保留可理解的原因', async () => {
    const source = await personOnPlainBackground()
    const post = vi.spyOn(axios, 'post').mockRejectedValueOnce(Object.assign(
      new Error('Request failed with status code 500'),
      { response: { status: 500, data: 'Internal Server Error' } },
    ))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const result = await textureClarityService.requestSemanticParts(source, {
        serviceUrl: 'http://127.0.0.1:8092',
      })
      expect(result.fallback).toBe(true)
      expect(result.fallbackReason).toContain('推理进程异常')
    } finally {
      post.mockRestore()
      warning.mockRestore()
    }
  })

  it('兜底提示词明确它只是人物轮廓，不伪装成脸/头发/服装部位图', () => {
    const prompt = textureClarityService.buildRepairPrompt({ semanticMode: 'subject-silhouette' })
    expect(prompt).toContain('SUBJECT SILHOUETTE')
    expect(prompt).toContain('does NOT identify face, hair, skin or garment parts')
    expect(prompt).not.toContain('SEMANTIC PARTS —')
  })

  it('显式关闭兜底时仍保留原来的硬失败能力', async () => {
    const source = await personOnPlainBackground()
    await expect(textureClarityService.requestSemanticParts(source, {
      allowLocalFallback: false,
    })).rejects.toThrow('语义分区服务未配置')
  })
})
