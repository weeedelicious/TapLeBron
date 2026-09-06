import { describe, expect, it } from 'vitest'
import {
  isCanvasMiddleButton,
  isExpandedGalleryPanTarget,
  nextCanvasPanViewport,
} from '@/lib/canvasMiddlePan'

describe('canvas middle pan over expanded gallery', () => {
  it('只有中键触发', () => {
    expect(isCanvasMiddleButton(1)).toBe(true)
    expect(isCanvasMiddleButton(0)).toBe(false)
    expect(isCanvasMiddleButton(2)).toBe(false)
  })

  it('展开后的非主图区域可以拖画布', () => {
    const root = document.createElement('div')
    root.setAttribute('data-shotflow-expanded-gallery', '1')
    const img = document.createElement('img')
    const button = document.createElement('button')
    root.append(img, button)
    document.body.append(root)
    expect(isExpandedGalleryPanTarget(img)).toBe(true)
    expect(isExpandedGalleryPanTarget(root)).toBe(true)
    expect(isExpandedGalleryPanTarget(button)).toBe(false)
    root.remove()
  })

  it('大图查看器和裁剪弹窗不抢画布拖动', () => {
    const viewer = document.createElement('div')
    viewer.className = 'shotflow-image-viewer'
    const viewerImg = document.createElement('img')
    viewer.append(viewerImg)

    const crop = document.createElement('div')
    crop.setAttribute('data-block-canvas-pan', '1')
    const cropImg = document.createElement('img')
    crop.append(cropImg)

    document.body.append(viewer, crop)
    expect(isExpandedGalleryPanTarget(viewerImg)).toBe(false)
    expect(isExpandedGalleryPanTarget(cropImg)).toBe(false)
    viewer.remove()
    crop.remove()
  })

  it('位移按指针增量加到 viewport，不改缩放', () => {
    expect(nextCanvasPanViewport({ x: 10, y: 20, zoom: 1.4 }, 40, 5, 10, 20)).toEqual({
      x: 40,
      y: 5,
      zoom: 1.4,
    })
  })
})
