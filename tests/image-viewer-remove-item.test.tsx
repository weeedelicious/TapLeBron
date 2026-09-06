/**
 * 大图查看器顶部缩略图轨道上的删除按钮
 * （2026-08-24 用户要求：「点开多图片多视频节点，弹窗上方的视频/图片加上删除按钮」）。
 *
 * 这里最容易写错的是 **index 的账**：list 由父组件传下来，删完少一格重新渲染，
 * 而 index 是查看器自己的 state。算错的表现不是报错，而是**画面莫名跳到另一张**——
 * 用户以为自己删错了，再点一次，就真的多删一张（每张都是付过费的）。所以三种相对位置各有用例。
 *
 * 另外锁住两件事：
 *   · 不传 onRemoveItem 就完全没有这个按钮 —— UploadNode 等调用点行为一个字不变；
 *   · 「×」必须是缩略图按钮的**兄弟**节点。button 套 button 是非法 HTML，
 *     React 会警告、点击行为也不可靠，而这种错误在肉眼看界面时完全看不出来。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { ImagePreview } = await import('@/components/ImagePreview')

type Item = { url: string; name?: string; thumbUrl?: string }

const ITEMS: Item[] = [
  { url: '/assets/p1/a.png', name: 'A', thumbUrl: '/assets/p1/a-thumb.png' },
  { url: '/assets/p1/b.png', name: 'B', thumbUrl: '/assets/p1/b-thumb.png' },
  { url: '/assets/p1/c.png', name: 'C', thumbUrl: '/assets/p1/c-thumb.png' },
]

let container: HTMLDivElement
let root: Root

// jsdom 没实现 scrollIntoView，而轨道会调它把当前格滚进视野。缺了它整个组件挂载就抛异常。
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const removeButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.shotflow-image-viewer-thumb-remove'))
const thumbs = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.shotflow-image-viewer-thumb'))
/** 大图当前显示的是哪一张。信息面板的标题跟着 active 走，用它判断画面有没有跳。 */
const activeTitle = () => document.querySelector('.shotflow-image-viewer-info h2')?.textContent
const activeThumbIndex = () =>
  thumbs().findIndex((t) => t.classList.contains('is-active'))

function renderStatic(props: Record<string, unknown>) {
  act(() => {
    root.render(<ImagePreview url={ITEMS[0].url} onClose={() => {}} {...props} />)
  })
}

/**
 * 真实用法的模拟：父组件持有 items，onRemoveItem 把那一项从 state 里摘掉再重渲染。
 * 静态 props 测不出 index 的账，必须让 list 真的少一格。
 */
function renderLive(startUrl: string, onClose = () => {}) {
  const removed: string[] = []
  function Host() {
    const [items, setItems] = useState(ITEMS)
    return (
      <ImagePreview
        url={startUrl}
        items={items}
        onClose={onClose}
        onRemoveItem={(url: string) => {
          removed.push(url)
          setItems((current) => current.filter((item) => item.url !== url))
        }}
      />
    )
  }
  act(() => {
    root.render(<Host />)
  })
  return removed
}

const clickRemove = (i: number) => {
  act(() => {
    removeButtons()[i]?.click()
  })
}

describe('按钮出现的条件', () => {
  it('多图 + 传了 onRemoveItem → 每一格都有一个删除按钮', () => {
    renderStatic({ items: ITEMS, onRemoveItem: vi.fn() })
    expect(thumbs()).toHaveLength(3)
    expect(removeButtons()).toHaveLength(3)
  })

  it('没传 onRemoveItem → 一个删除按钮都没有（其它调用点行为不变）', () => {
    renderStatic({ items: ITEMS })
    expect(thumbs()).toHaveLength(3)
    expect(removeButtons()).toHaveLength(0)
  })

  it('只有一项 → 连轨道都没有，自然也没有删除按钮', () => {
    renderStatic({ items: [ITEMS[0]], onRemoveItem: vi.fn() })
    expect(thumbs()).toHaveLength(0)
    expect(removeButtons()).toHaveLength(0)
  })

  it('视频节点（kind=video）一样有', () => {
    renderStatic({ items: ITEMS, onRemoveItem: vi.fn(), kind: 'video' })
    expect(removeButtons()).toHaveLength(3)
  })
})

describe('「×」不能嵌在缩略图按钮里（非法 HTML，肉眼看不出来）', () => {
  it('缩略图 button 内部没有任何 button', () => {
    renderStatic({ items: ITEMS, onRemoveItem: vi.fn() })
    for (const thumb of thumbs()) {
      expect(thumb.querySelector('button')).toBeNull()
    }
  })

  it('删除按钮和缩略图是同一个父节点下的兄弟', () => {
    renderStatic({ items: ITEMS, onRemoveItem: vi.fn() })
    const remove = removeButtons()[0]
    expect(remove.parentElement).toBe(thumbs()[0].parentElement)
    expect(remove.parentElement?.className).toContain('shotflow-image-viewer-thumb-cell')
  })
})

describe('删的是哪一个', () => {
  it('点第 2 格的「×」→ 删的是第 2 项，不是当前正看的那项', () => {
    const onRemoveItem = vi.fn()
    // 当前停在第 1 张（url=a），却去点第 2 格
    renderStatic({ items: ITEMS, url: ITEMS[0].url, onRemoveItem })
    clickRemove(1)
    expect(onRemoveItem).toHaveBeenCalledWith('/assets/p1/b.png')
    expect(onRemoveItem).toHaveBeenCalledTimes(1)
  })

  it('点「×」不会顺带把大图切到那一格（别让删除变成翻页）', () => {
    renderLive(ITEMS[0].url)
    expect(activeTitle()).toBe('A')
    clickRemove(2) // 删最后一格，当前在第一格
    expect(activeTitle()).toBe('A')
  })
})

describe('index 的账（算错就会画面乱跳）', () => {
  it('删当前这张之前的 → 画面还是同一张，下标前移一格', () => {
    renderLive(ITEMS[1].url) // 停在 B（index 1）
    expect(activeTitle()).toBe('B')
    clickRemove(0) // 删 A
    expect(activeTitle()).toBe('B')
    expect(activeThumbIndex()).toBe(0) // B 现在是第一格
  })

  it('删当前这张 → 后面那张顶上来', () => {
    renderLive(ITEMS[1].url) // 停在 B
    clickRemove(1) // 删 B
    expect(activeTitle()).toBe('C')
    expect(activeThumbIndex()).toBe(1) // 位置不变，内容换成了 C
  })

  it('删的是当前且已是最后一张 → 退回上一张，不能停在越界的下标上', () => {
    renderLive(ITEMS[2].url) // 停在 C（最后一格）
    expect(activeTitle()).toBe('C')
    clickRemove(2)
    expect(activeTitle()).toBe('B')
    expect(activeThumbIndex()).toBe(1)
  })

  it('删当前之后的 → 画面和下标都不动', () => {
    renderLive(ITEMS[0].url) // 停在 A
    clickRemove(1) // 删 B
    expect(activeTitle()).toBe('A')
    expect(activeThumbIndex()).toBe(0)
  })

  it('连着删也不乱：A、C 都删掉后剩 B 且正常显示', () => {
    const removed = renderLive(ITEMS[1].url) // 停在 B
    clickRemove(0) // 删 A → B 变成第 0 格
    clickRemove(1) // 此时轨道是 [B, C]，删 C
    expect(removed).toEqual(['/assets/p1/a.png', '/assets/p1/c.png'])
    expect(activeTitle()).toBe('B')
  })
})

describe('删完之后的缩放状态', () => {
  const stageTransform = () =>
    document.querySelector<HTMLImageElement>('.shotflow-image-viewer-stage img')?.style.transform ?? ''
  const zoomIn = () => {
    act(() => {
      document.querySelector('.shotflow-image-viewer-stage')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
  }

  it('删掉当前这张 → 顶上来的下一张不能带着上一张的缩放', () => {
    renderLive(ITEMS[1].url) // 停在 B
    zoomIn()
    expect(stageTransform()).toContain('scale(2)')
    clickRemove(1) // 删 B，C 顶上来
    expect(activeTitle()).toBe('C')
    expect(stageTransform()).toContain('scale(1)')
  })

  it('删的是别的那张 → 当前放大倍数保留（画面没换，凭什么把用户的缩放抹掉）', () => {
    renderLive(ITEMS[1].url) // 停在 B
    zoomIn()
    expect(stageTransform()).toContain('scale(2)')
    clickRemove(0) // 删 A，画面还是 B
    expect(activeTitle()).toBe('B')
    expect(stageTransform()).toContain('scale(2)')
  })
})

describe('剩最后一项时的边界（轨道自己会消失）', () => {
  /*
   * 故意不做「删光就关掉查看器」那件事：轨道只在两项以上渲染，所以从轨道上根本删不到
   * 最后一项。写一个处理"删光"的分支只会是永远走不到的死代码 —— 看着像有保护，其实没有。
   * 最后那一项在节点展开的画廊里删（那儿用的是同一个 remove 函数）。
   */
  it('一路删到只剩一项：轨道消失，剩下那项还正常显示，查看器不关', () => {
    const onClose = vi.fn()
    renderLive(ITEMS[0].url, onClose)
    clickRemove(2) // 删 C → [A, B]
    expect(thumbs()).toHaveLength(2)
    clickRemove(1) // 删 B → [A]
    expect(thumbs()).toHaveLength(0) // 只剩一项，不再有轨道
    expect(removeButtons()).toHaveLength(0)
    expect(activeTitle()).toBe('A')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('单项时压根没有删除按钮（不给一个点不动的东西）', () => {
    const onClose = vi.fn()
    renderStatic({ items: [ITEMS[0]], url: ITEMS[0].url, onRemoveItem: vi.fn(), onClose })
    expect(removeButtons()).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
  })
})
