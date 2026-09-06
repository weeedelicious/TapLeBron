/**
 * 「细化纹理生成的图片节点是特殊的，可以点开看对比」（2026-08-21 用户要求）的判定逻辑。
 *
 * 这个读取器决定一个节点要不要多出「对比」入口，所以它错了有两种代价：
 *   认不出 → 用户点不开对比；
 *   误认 → 点开一个空对比，或者直接把画布带崩。
 *
 * 画布上的 JSON 是几个月里不同版本写进去的，所以重点全在**容错**：
 *   - 今天之前生成的节点没有 candidateUrl / failures，缺字段不能导致不认；
 *   - 还在生成中的节点（url 为空）不算可看的结果；
 *   - `passed` 没记录时必须是 null，**绝不能当成 false** —— 那会把一次成功的生成
 *     显示成"质量门禁未通过"，是纯粹的误告；
 *   - 任何脏数据都只能返回 null，不许抛异常。
 */
import { describe, expect, it } from 'vitest'
import { readTextureClarityResult } from '@/features/texture-clarity/resultMeta'
import type { CanvasNodeData } from '@/lib/types'

function node(partial: Record<string, unknown>): CanvasNodeData {
  return partial as unknown as CanvasNodeData
}

const MODERN = node({
  url: ['/assets/p1/fused.png'],
  params: {
    imageList: [{ nodeId: 'src-1', url: '/assets/p1/source.png' }],
    textureClarity: {
      sourceNodeKey: 'src-1',
      sourceHash: 'hash-1',
      fusionPolicy: 'edge-v2',
      requestModel: 'gemini-3-pro-image',
      resolvedModel: 'gemini-3-pro-image-002',
      semanticModelId: 'sayeed99/segformer_b3_clothes',
      candidateUrl: '/assets/p1/candidate.png',
      outputWidth: 1024,
      outputHeight: 1536,
      generationCalls: 1,
      passed: false,
      failures: [{ code: 'outside-changed', message: '蒙版外有 812 个像素被改动' }],
      diagnostics: { outsideChangedPixels: 812, note: 'edge band 3px' },
    },
  },
})

describe('readTextureClarityResult', () => {
  it('认出完整的结果节点，并把记录读全', () => {
    const r = readTextureClarityResult(MODERN)
    expect(r).not.toBeNull()
    expect(r?.sourceUrl).toBe('/assets/p1/source.png')
    expect(r?.fusedUrl).toBe('/assets/p1/fused.png')
    expect(r?.candidateUrl).toBe('/assets/p1/candidate.png')
    expect(r?.passed).toBe(false)
    expect(r?.failures[0].message).toContain('812')
    expect(r?.outputWidth).toBe(1024)
    expect(r?.generationCalls).toBe(1)
  })

  it('普通图片节点不认（不该多出对比入口）', () => {
    expect(readTextureClarityResult(node({
      url: ['/assets/p1/a.png'],
      params: { imageList: [{ nodeId: 'x', url: '/assets/p1/b.png' }] },
    }))).toBeNull()
  })

  it('还在生成中的节点不认 —— 没有结果图就没有可比的东西', () => {
    expect(readTextureClarityResult(node({
      url: [],
      params: MODERN.params,
    }))).toBeNull()
  })

  it('老节点缺 candidateUrl / failures 仍然要认出来', () => {
    const r = readTextureClarityResult(node({
      url: ['/assets/p1/fused.png'],
      params: {
        imageList: [{ nodeId: 'src-1', url: '/assets/p1/source.png' }],
        textureClarity: { sourceNodeKey: 'src-1', requestModel: 'm', passed: true },
      },
    }))
    expect(r).not.toBeNull()
    expect(r?.candidateUrl).toBeNull()
    expect(r?.failures).toEqual([])
    expect(r?.passed).toBe(true)
  })

  it('passed 没记录时是 null，不是 false —— 否则会把成功的生成误报成门禁未通过', () => {
    const r = readTextureClarityResult(node({
      url: ['/assets/p1/fused.png'],
      params: {
        imageList: [{ nodeId: 's', url: '/assets/p1/source.png' }],
        textureClarity: { sourceNodeKey: 's' },
      },
    }))
    expect(r?.passed).toBeNull()
    expect(r?.passed).not.toBe(false)
  })

  it('没有 imageList 就认不出源图，只能不认', () => {
    expect(readTextureClarityResult(node({
      url: ['/assets/p1/fused.png'],
      params: { textureClarity: { sourceNodeKey: 's' } },
    }))).toBeNull()
  })

  it('诊断只留标量，嵌套对象丢掉（界面上没法显示）', () => {
    const r = readTextureClarityResult(node({
      url: ['/assets/p1/fused.png'],
      params: {
        imageList: [{ nodeId: 's', url: '/assets/p1/source.png' }],
        textureClarity: {
          diagnostics: { pixels: 5, label: 'ok', nested: { a: 1 }, list: [1, 2], empty: '  ' },
        },
      },
    }))
    expect(r?.diagnostics).toEqual({ pixels: 5, label: 'ok' })
  })

  it('failures 里的垃圾项被跳过，不产出空条目', () => {
    const r = readTextureClarityResult(node({
      url: ['/assets/p1/fused.png'],
      params: {
        imageList: [{ nodeId: 's', url: '/assets/p1/source.png' }],
        textureClarity: { failures: [null, {}, 'x', { message: '真的原因' }] },
      },
    }))
    expect(r?.failures).toEqual([{ code: '', message: '真的原因' }])
  })

  it('脏数据一律返回 null 且绝不抛异常', () => {
    expect(readTextureClarityResult(undefined)).toBeNull()
    expect(readTextureClarityResult(node({}))).toBeNull()
    expect(readTextureClarityResult(node({ params: 'nope', url: 'nope' }))).toBeNull()
    expect(readTextureClarityResult(node({ url: [null], params: { textureClarity: [] } }))).toBeNull()
    expect(readTextureClarityResult(node({
      url: ['/a.png'],
      params: { imageList: 'not-an-array', textureClarity: {} },
    }))).toBeNull()
  })
})
