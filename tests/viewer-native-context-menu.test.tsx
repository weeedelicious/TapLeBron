/**
 * 大图查看器里右键要出**浏览器自己的**菜单（2026-08-25 用户要求：
 * 在新标签页中打开图片 / 图片另存为 / 复制图片 / 复制图片地址）。
 *
 * 出不来的原因是个 React portal 的坑，值得单独锁住：
 *   · 查看器是 createPortal 到 document.body 的，DOM 上已经不在画布里；
 *   · 但 **React 合成事件走组件树**，portal 的内容仍然算那个节点的后代 ——
 *     右键会一路冒到 `.react-flow__node` 的 onContextMenu（openNodeMenu）；
 *   · openNodeMenu 第一句是 event.preventDefault()，浏览器菜单就此被吃掉，
 *     取而代之的是「复制节点 / 删除」那个节点菜单，盖在全屏大图之上。
 *
 * 两道防线各自都能单独失效，所以分开测：
 *   ① 查看器自己 stopPropagation（且**绝不** preventDefault）；
 *   ② openNodeMenu / openCanvasMenu 侧的判据：右键 target 不在画布 DOM 里就不算画布右键 ——
 *      这一道兼顾抠像 / 白板 / 灯光 / 局部重绘等同样 portal 出去的浮层。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { ImagePreview } = await import('@/components/ImagePreview')
const { isCanvasContextMenuTarget } = await import('@/lib/canvasContextMenu')

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

/**
 * 复刻真实结构：ReactFlow 的节点包装层上挂着 onContextMenu，查看器由节点渲染、portal 到 body。
 * 这样才测得出「portal 出去的右键仍然冒到节点上」这件事 —— 用一个平的 DOM 测不出来。
 */
function mountInsideNode(onNodeContextMenu: (event: React.MouseEvent) => void) {
  act(() => {
    root.render(
      <div className="react-flow">
        <div className="react-flow__node" onContextMenu={onNodeContextMenu}>
          <span>节点本体</span>
          <ImagePreview url={URL_A} onClose={() => {}} />
        </div>
      </div>,
    )
  })
}

const viewerImage = () =>
  document.querySelector<HTMLImageElement>('.shotflow-image-viewer-stage img')!
const nodeBody = () => container.querySelector<HTMLElement>('.react-flow__node span')!

function rightClick(target: Element) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('① 大图上的右键：浏览器菜单必须活着', () => {
  it('查看器确实 portal 到了 body（不在节点的 DOM 里）—— 这正是坑的前提', () => {
    mountInsideNode(() => {})
    const image = viewerImage()
    expect(image).not.toBeNull()
    expect(container.contains(image)).toBe(false)
    expect(document.body.contains(image)).toBe(true)
  })

  it('右键大图 → 事件没被 preventDefault，浏览器菜单照出', () => {
    mountInsideNode((event) => event.preventDefault())
    const event = rightClick(viewerImage())
    expect(event.defaultPrevented, '右键被 preventDefault 掉了，浏览器菜单出不来').toBe(false)
  })

  it('右键大图 → 不再冒到节点上，节点菜单不会盖在大图上', () => {
    const onNodeContextMenu = vi.fn()
    mountInsideNode(onNodeContextMenu)
    rightClick(viewerImage())
    expect(onNodeContextMenu, '右键冒到节点上了，会弹出「复制节点 / 删除」').not.toHaveBeenCalled()
  })

  it('查看器的背景和信息栏同样交给浏览器（整块浮层一致）', () => {
    const onNodeContextMenu = vi.fn()
    mountInsideNode(onNodeContextMenu)
    const backdrop = document.querySelector<HTMLElement>('.shotflow-image-viewer')!
    const event = rightClick(backdrop)
    expect(event.defaultPrevented).toBe(false)
    expect(onNodeContextMenu).not.toHaveBeenCalled()
  })

  it('节点本体上的右键**照旧**冒到节点上（不能把画布右键菜单也一起废掉）', () => {
    const onNodeContextMenu = vi.fn()
    mountInsideNode(onNodeContextMenu)
    rightClick(nodeBody())
    expect(onNodeContextMenu, '画布上的右键菜单不该受影响').toHaveBeenCalledTimes(1)
  })
})

describe('② 画布侧的判据：portal 出去的浮层不算画布右键', () => {
  it('节点里的元素 → 算', () => {
    mountInsideNode(() => {})
    expect(isCanvasContextMenuTarget(nodeBody())).toBe(true)
  })

  it('画布根元素自己 → 算（closest 包含自身）', () => {
    mountInsideNode(() => {})
    expect(isCanvasContextMenuTarget(container.querySelector('.react-flow'))).toBe(true)
  })

  it('portal 到 body 的大图 → 不算（这一条就是浮层里右键能出浏览器菜单的原因）', () => {
    mountInsideNode(() => {})
    expect(isCanvasContextMenuTarget(viewerImage())).toBe(false)
  })

  it('body 上任意一个跟画布无关的元素 → 不算', () => {
    const stray = document.createElement('div')
    document.body.appendChild(stray)
    expect(isCanvasContextMenuTarget(stray)).toBe(false)
    stray.remove()
  })

  it('不是元素（null / window / 文本节点）→ 不算，且不抛', () => {
    expect(isCanvasContextMenuTarget(null)).toBe(false)
    expect(isCanvasContextMenuTarget(undefined)).toBe(false)
    expect(isCanvasContextMenuTarget(window as unknown as EventTarget)).toBe(false)
    expect(isCanvasContextMenuTarget(document.createTextNode('x') as unknown as EventTarget)).toBe(false)
  })
})

/*
 * 判据本身对、但没人调用的话，抠像 / 白板 / 灯光 / 局部重绘那些同样 portal 出去的浮层
 * 照旧被吃掉右键 —— 上面的断言一条都不会红（大图那边有自己的防线）。
 * Canvas 整棵挂起来需要的上下文太多，所以退一步做接线断言。
 */
describe('③ 画布侧真的接上了这道判据', () => {
  it('openNodeMenu / openCanvasMenu 在 preventDefault 之前先查 target', () => {
    const source = readFileSync(join(__dirname, '..', 'src/canvas/components/Canvas.tsx'), 'utf8')
    expect(source).toContain("from '@/lib/canvasContextMenu'")
    const guards = source.split('if (!isCanvasContextMenuTarget(event.target)) return').length - 1
    expect(guards, '节点右键和画布右键两处都要查，少一处那类浮层就还会被吃掉').toBe(2)
  })
})
