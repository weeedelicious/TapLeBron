import { describe, expect, it } from 'vitest'
import { cropOutputSize, cropperCanvasOptions } from '@/lib/cropOutputScale'

describe('crop output 2K / 4K scale', () => {
  it('原尺寸保持裁剪框像素', () => {
    expect(cropOutputSize(800, 450, 'original')).toEqual({
      width: 800,
      height: 450,
      longEdge: 800,
      scaled: false,
    })
  })

  it('2K 按长边 2048 等比放大', () => {
    expect(cropOutputSize(800, 450, '2k')).toEqual({
      width: 2048,
      height: 1152,
      longEdge: 2048,
      scaled: true,
    })
  })

  it('4K 按长边 4096 等比放大', () => {
    expect(cropOutputSize(1920, 1080, '4k')).toEqual({
      width: 4096,
      height: 2304,
      longEdge: 4096,
      scaled: true,
    })
  })

  it('竖图也按长边缩放，比例不变', () => {
    const result = cropOutputSize(1080, 1920, '2k')
    expect(result).toEqual({
      width: 1152,
      height: 2048,
      longEdge: 2048,
      scaled: true,
    })
    expect(result.width / result.height).toBeCloseTo(1080 / 1920, 5)
  })

  it('已经大于目标边长时等比收到 2K / 4K', () => {
    expect(cropOutputSize(4096, 2304, '2k')).toEqual({
      width: 2048,
      height: 1152,
      longEdge: 2048,
      scaled: true,
    })
  })

  it('交给 cropper 的画布上限是 4096', () => {
    const options = cropperCanvasOptions({ width: 2048, height: 1152 }, 'image/jpeg')
    expect(options.maxWidth).toBe(4096)
    expect(options.maxHeight).toBe(4096)
    expect(options.width).toBe(2048)
    expect(options.height).toBe(1152)
    expect(options.fillColor).toBe('#fff')
    expect(options.imageSmoothingQuality).toBe('high')
  })
})
