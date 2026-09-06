/**
 * `image1` 在编辑器里真的被换成 chip（2026-08-25）。
 *
 * 上一个测试文件锁的是「什么算一个 token」的判断；这里锁**真实的 DOM 替换**，
 * 因为出错的地方全在光标算术上：
 *   · 删多了会把前面的字一起吃掉（`给 image1/` 变成 `chip`，"给 " 没了）；
 *   · 删少了会留下残字（`image` 还在，只删掉了 `1/`）；
 *   · 分隔符不补回来，用户提示词里的 `/` 就凭空消失了。
 * 这些错法在界面上都只是"看着怪"，不会报错，所以必须逐条断言。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { PromptEditor } = await import('@/components/PromptEditor')
const { resolveTextMentionAt, resolveTextMentionsIn } = await import('@/lib/promptTokenMention')

const CANDIDATES = [
  { nodeId: 'n1', url: '/assets/1/a.png', name: '图片1' },
  { nodeId: 'n2', url: '/assets/1/b.png', name: '图片2' },
]

let container: HTMLDivElement
let root: Root
let onAtKey: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onAtKey = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mount(candidates = CANDIDATES) {
  act(() => {
    root.render(
      <PromptEditor
        value=""
        chips={[]}
        onChange={() => {}}
        onAtKey={onAtKey}
        onEscape={() => {}}
        resolveTextMention={(t) => resolveTextMentionAt(t, candidates)}
        resolveTextMentionsIn={(t) => resolveTextMentionsIn(t, candidates)}
      />,
    )
  })
  return container.querySelector('[contenteditable]') as HTMLElement
}

/**
 * 模拟「已经打完这段文字、光标停在末尾」然后触发一次 input。
 *
 * 必须先 focus 再放光标：input 事件只可能发生在**已聚焦**的可编辑元素上，
 * 而 insertChip 里那句 el.focus() 在 jsdom 下会把未聚焦元素的光标重置到开头 ——
 * 不先聚焦的话测出来的是一个现实中不存在的场景（chip 插到开头、原文留在后面）。
 */
function typeInto(el: HTMLElement, text: string) {
  el.focus()
  el.textContent = text
  const textNode = el.firstChild!
  const range = document.createRange()
  range.setStart(textNode, text.length)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const chips = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-chip]'))

describe('转换成功时', () => {
  it('image1 + 空格 → 出现 chip，字面文字没了', () => {
    const el = mount()
    typeInto(el, 'image1 ')
    expect(chips(el)).toHaveLength(1)
    expect(chips(el)[0].getAttribute('data-nodeid')).toBe('n1')
    expect(el.textContent).not.toContain('image1')
  })

  it('image2 对上第二个引用', () => {
    const el = mount()
    typeInto(el, 'image2 ')
    expect(chips(el)[0].getAttribute('data-nodeid')).toBe('n2')
  })

  it('前面的文字一个字都不能少（删多了的典型症状）', () => {
    const el = mount()
    typeInto(el, '给 image1 加雨')
    // 光标停在末尾时不该触发（末字不是分隔符），先验证这一点
    expect(chips(el)).toHaveLength(0)
    typeInto(el, '给 image1/')
    expect(chips(el)).toHaveLength(1)
    expect(el.textContent).toContain('给')
  })

  it('用户敲的分隔符补回来了（提示词里的 / 不能凭空消失）', () => {
    const el = mount()
    typeInto(el, 'image1/')
    expect(chips(el)).toHaveLength(1)
    expect(el.textContent).toContain('/')
  })

  it('没有残字：chip 之外只剩用户敲的那个分隔符', () => {
    const el = mount()
    typeInto(el, 'image1 ')
    // chip 自己的文字（图片1×）也在 textContent 里，所以要先把 chip 摘掉再看剩下什么
    const clone = el.cloneNode(true) as HTMLElement
    clone.querySelectorAll('[data-chip]').forEach((chip) => chip.remove())
    const outside = (clone.textContent ?? '').replace(/​/g, '')
    expect(outside).not.toContain('image')
    expect(outside).not.toContain('1')
    expect(outside.trim()).toBe('')
  })
})

describe('不该转换时一个 chip 都不出', () => {
  it('还没敲分隔符 → 不转（否则想打 image15 会被抢）', () => {
    const el = mount()
    typeInto(el, 'image1')
    expect(chips(el)).toHaveLength(0)
    expect(el.textContent).toContain('image1')
  })

  it('编号对不上（只接了 2 张，写 image5）→ 不转，文字留着', () => {
    const el = mount()
    typeInto(el, 'image5 ')
    expect(chips(el)).toHaveLength(0)
    expect(el.textContent).toContain('image5')
  })

  it('粘在别的词里（myimage1）→ 不转', () => {
    const el = mount()
    typeInto(el, 'myimage1 ')
    expect(chips(el)).toHaveLength(0)
    expect(el.textContent).toContain('myimage1')
  })

  it('一个引用都没接 → 不转', () => {
    const el = mount([])
    typeInto(el, 'image1 ')
    expect(chips(el)).toHaveLength(0)
  })

  it('没传 resolveTextMention（别处复用这个编辑器）→ 完全不插手', () => {
    act(() => {
      root.render(
        <PromptEditor value="" chips={[]} onChange={() => {}} onAtKey={onAtKey} onEscape={() => {}} />,
      )
    })
    const el = container.querySelector('[contenteditable]') as HTMLElement
    typeInto(el, 'image1 ')
    expect(chips(el)).toHaveLength(0)
    expect(el.textContent).toContain('image1')
  })
})

describe('不影响原来的 @ 菜单', () => {
  it('打 @ 时照旧弹候选菜单，不走 token 转换', () => {
    const el = mount()
    typeInto(el, '@')
    expect(onAtKey).toHaveBeenCalled()
    expect(chips(el)).toHaveLength(0)
  })

  it('@ 正在输入时即使含 image1 也优先走 @ 那条路', () => {
    const el = mount()
    onAtKey.mockClear()
    typeInto(el, '@image1')
    expect(onAtKey).toHaveBeenCalled()
    expect(chips(el)).toHaveLength(0)
  })
})

describe('中文紧跟在后面（用户实测的那种提示词）', () => {
  it('image1 后面直接是汉字 → 边打边转', () => {
    const el = mount()
    typeInto(el, '以输入图片作为首帧，image1保')
    expect(chips(el)).toHaveLength(1)
    expect(chips(el)[0].getAttribute('data-nodeid')).toBe('n1')
    // 那个「保」是用户敲的正文，必须留着
    expect(el.textContent).toContain('保')
    expect(el.textContent).not.toContain('image1')
  })
})

describe('失焦时整段扫一遍', () => {
  /** 在已有文字中间插入 image1、且没再敲任何键 —— 边打边转覆盖不到的情形 */
  function setTextWithoutTyping(el: HTMLElement, text: string) {
    el.focus()
    el.textContent = text
  }

  /**
   * 用真实的 blur()，不要手造 `new FocusEvent('blur')`：
   * React 的 onBlur 挂的是原生 **focusout**（blur 本身不冒泡），手造 blur 事件根本进不了
   * React 的处理函数 —— 那样测出来永远是"什么都没发生"，看着像功能坏了其实是测法错了。
   */
  const blurEditor = (el: HTMLElement) => act(() => el.blur())

  it('中间插入、没敲尾随字符 → 失焦后补上转换', () => {
    const el = mount()
    setTextWithoutTyping(el, '以输入图片作为首帧，image1保持主体一致。')
    expect(chips(el)).toHaveLength(0)
    blurEditor(el)
    expect(chips(el)).toHaveLength(1)
    expect(chips(el)[0].getAttribute('data-nodeid')).toBe('n1')
    expect(el.textContent).not.toContain('image1')
    expect(el.textContent).toContain('保持主体一致')
  })

  it('结尾就是 image1（后面什么都没有）→ 失焦后也转', () => {
    const el = mount()
    setTextWithoutTyping(el, '风格参考 image1')
    blurEditor(el)
    expect(chips(el)).toHaveLength(1)
  })

  it('一段里多个 → 全部转，前后文字不乱', () => {
    const el = mount()
    setTextWithoutTyping(el, 'A image1 B image2 C')
    blurEditor(el)
    expect(chips(el)).toHaveLength(2)
    const text = el.textContent ?? ''
    expect(text).toContain('A')
    expect(text).toContain('B')
    expect(text).toContain('C')
    expect(text).not.toContain('image1')
    expect(text).not.toContain('image2')
  })

  it('已经是 chip 的不会被再扫一遍（chip 标签里也写着「图片1」）', () => {
    const el = mount()
    typeInto(el, 'image1 ')
    expect(chips(el)).toHaveLength(1)
    blurEditor(el)
    expect(chips(el)).toHaveLength(1)
    blurEditor(el)
    expect(chips(el)).toHaveLength(1)
  })

  it('对不上编号的失焦后也不动（image9 只接了 2 张）', () => {
    const el = mount()
    setTextWithoutTyping(el, '用 image9 那张')
    blurEditor(el)
    expect(chips(el)).toHaveLength(0)
    expect(el.textContent).toContain('image9')
  })

  it('没传 resolveTextMentionsIn → 失焦什么都不做', () => {
    act(() => {
      root.render(
        <PromptEditor value="" chips={[]} onChange={() => {}} onAtKey={onAtKey} onEscape={() => {}} />,
      )
    })
    const el = container.querySelector('[contenteditable]') as HTMLElement
    el.focus()
    el.textContent = 'image1 保持'
    blurEditor(el)
    expect(chips(el)).toHaveLength(0)
  })
})
