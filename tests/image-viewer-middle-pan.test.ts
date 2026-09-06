/**
 * 大图滚轮放大后，按住中键上下左右拖动看细节。
 *
 * 2026-08-26：原先 React onMouseDown 也接中键，但 Chrome/Edge 点滚轮会进自动滚屏，
 * 捕获阶段不 preventDefault 的话，看起来就像中键拖不动。
 */
import { describe, expect, it } from 'vitest'
import {
  isViewerChromeTarget,
  isViewerPanButton,
  nextPanOffset,
  shouldPreventAutoscroll,
  shouldStartViewerPan,
} from '@/lib/imageViewerPan'

describe('imageViewerPan helpers', () => {
  it('左键和中键都能拖，右键不能', () => {
    expect(isViewerPanButton(0)).toBe(true)
    expect(isViewerPanButton(1)).toBe(true)
    expect(isViewerPanButton(2)).toBe(false)
  })

  it('只有中键需要挡住浏览器自动滚屏', () => {
    expect(shouldPreventAutoscroll(1)).toBe(true)
    expect(shouldPreventAutoscroll(0)).toBe(false)
    expect(shouldPreventAutoscroll(2)).toBe(false)
  })

  it('拖动偏移按指针位移累加，上下左右都算', () => {
    expect(nextPanOffset({ x: 10, y: 20 }, 40, 5, 10, 20)).toEqual({ x: 40, y: 5 })
    expect(nextPanOffset({ x: 0, y: 0 }, 0, 80, 0, 0)).toEqual({ x: 0, y: 80 })
    expect(nextPanOffset({ x: 8, y: 8 }, -12, 8, 8, 8)).toEqual({ x: -12, y: 8 })
  })

  it('工具条 / 信息栏 / 按钮上不开始拖动', () => {
    const button = document.createElement('button')
    const info = document.createElement('aside')
    info.className = 'shotflow-image-viewer-info'
    const img = document.createElement('img')
    document.body.append(button, info, img)
    expect(isViewerChromeTarget(button)).toBe(true)
    expect(isViewerChromeTarget(info)).toBe(true)
    expect(isViewerChromeTarget(img)).toBe(false)
    expect(shouldStartViewerPan({ button: 1, isVideo: false, scale: 2, target: button })).toBe(false)
    expect(shouldStartViewerPan({ button: 1, isVideo: false, scale: 2, target: img })).toBe(true)
    button.remove(); info.remove(); img.remove()
  })

  it('视频未放大时左键不拖（留给原生控件），中键仍然拖', () => {
    const video = document.createElement('video')
    expect(shouldStartViewerPan({ button: 0, isVideo: true, scale: 1, target: video })).toBe(false)
    expect(shouldStartViewerPan({ button: 1, isVideo: true, scale: 1, target: video })).toBe(true)
    expect(shouldStartViewerPan({ button: 0, isVideo: true, scale: 2, target: video })).toBe(true)
  })
})
