/**
 * 大图上按住中键必须能拖，并且中键 mousedown 要被 preventDefault（挡住自动滚屏）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { ImagePreview } = await import('@/components/ImagePreview')

const URL_A = '/assets/1/a.png'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mountViewer() {
  act(() => {
    root.render(<ImagePreview url={URL_A} onClose={() => {}} />)
  })
}

const viewer = () => document.querySelector<HTMLElement>('.shotflow-image-viewer')!
const image = () => document.querySelector<HTMLImageElement>('.shotflow-image-viewer-stage img')!

function fire<T extends Event>(target: EventTarget, event: T) {
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('大图中键拖动看细节', () => {
  it('中键 mousedown 在捕获阶段被 preventDefault，不会进浏览器自动滚屏', () => {
    mountViewer()
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1, clientX: 80, clientY: 80 })
    fire(image(), event)
    expect(event.defaultPrevented, '中键没被拦住，Chrome 会弹出自动滚屏圆圈').toBe(true)
  })

  it('中键按下后移动，图片 translate 跟着走', () => {
    mountViewer()
    const img = image()
    const host = viewer()
    fire(img, new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1, clientX: 100, clientY: 120 }))
    expect(host.className, 'mousedown 之后应该进入拖动').toContain('is-dragging')
    fire(window, new MouseEvent('mousemove', { bubbles: true, cancelable: true, button: 1, buttons: 4, clientX: 140, clientY: 90 }))
    fire(host, new MouseEvent('mousemove', { bubbles: true, cancelable: true, button: 1, buttons: 4, clientX: 140, clientY: 90 }))
    expect(img.style.transform).toContain('translate(40px, -30px)')
    expect(host.className).toContain('is-dragging')
  })

  it('左键同样能拖（放大后看细节不只能用中键）', () => {
    mountViewer()
    const img = image()
    fire(img, new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }))
    fire(viewer(), new MouseEvent('mousemove', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 10, clientY: 40 }))
    expect(img.style.transform).toContain('translate(0px, 30px)')
  })

  it('点工具条不会把图拖走', () => {
    mountViewer()
    const toolbar = document.querySelector('.shotflow-image-viewer-toolbar')!
    const img = image()
    const before = img.style.transform
    fire(toolbar, new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1, clientX: 20, clientY: 20 }))
    fire(window, new MouseEvent('mousemove', { bubbles: true, cancelable: true, button: 1, clientX: 80, clientY: 80 }))
    expect(img.style.transform).toBe(before)
  })
})

describe('接线：捕获阶段真的挂上了', () => {
  it('源码用原生 capture 监听 pointerdown/mousedown/auxclick 拦中键', () => {
    const source = readFileSync(join(__dirname, '..', 'src/canvas/components/ImagePreview.tsx'), 'utf8')
    expect(source).toContain("from '@/lib/imageViewerPan'")
    expect(source).toContain('shouldPreventAutoscroll')
    expect(source).toContain("addEventListener('mousedown', killAutoscroll, capture)")
    expect(source).toContain("addEventListener('pointerdown', killAutoscroll, capture)")
    expect(source).toContain("addEventListener('mousedown', onDown, capture)")
    expect(source).not.toContain('const handleMouseDown')
  })
})
