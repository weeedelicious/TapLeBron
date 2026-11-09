import { describe, expect, it } from 'vitest'
import { displayGenerationProgress, estimateTaskFromNodeData } from '@/lib/generationProgress'
import type { CanvasNodeData } from '@/lib/types'

function imageNode(model: string, options: { references?: number; resolution?: string; count?: number } = {}) {
  return {
    type: 'image',
    params: {
      model,
      count: options.count ?? 1,
      imageList: Array.from({ length: options.references ?? 0 }, (_, index) => ({ nodeId: `ref-${index}` })),
      settings: { ratio: '16:9', resolution: options.resolution ?? '1K' },
    },
  } as unknown as CanvasNodeData
}

// 2026-11-09 生产网关实测：Flare 文生图约 12s、1 张参考约 14s；Sunburst 文生图约 48s、1 张参考约 72s
describe('Image 2.6 generation progress estimates', () => {
  it('uses production-calibrated estimates for text and image generation', () => {
    expect(estimateTaskFromNodeData(imageNode('gpt-image-2.6-flare')).estimatedMs).toBe(12_000)
    expect(estimateTaskFromNodeData(imageNode('gpt-image-2.6-sunburst')).estimatedMs).toBe(48_000)
    expect(estimateTaskFromNodeData(imageNode('gpt-image-2.6-sunburst', { references: 1 })).estimatedMs).toBe(72_000)
    expect(estimateTaskFromNodeData(imageNode('gpt-image-2.6-sunburst', {
      references: 1,
      resolution: '4K',
      count: 2,
    })).estimatedMs).toBe(89_856)
  })

  it('old 2.5 nodes estimate as the matching 2.6 model', () => {
    expect(estimateTaskFromNodeData(imageNode('gpt-image-2.5-flare')).estimatedMs).toBe(12_000)
  })

  it('does not derive a short ETA from the synthetic 6% visual head start', () => {
    const progress = displayGenerationProgress({
      loading: true,
      status: 1,
      progressPercent: 6,
      startedAtMs: 1_000,
      estimatedMs: 17_000,
    }, 3_000)

    expect(progress.percent).toBe(16)
    expect(progress.elapsedMs).toBe(2_000)
    expect(progress.remainingMs).toBe(15_000)
  })
})
