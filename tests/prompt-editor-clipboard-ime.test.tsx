/**
 * 2026-08-25 用户实测报的两个问题：
 *   ① 关键字不实时变 @，要再点一下节点；
 *   ② 复制带 @引用的文字再粘回来，引用处会换行、还多出一个「×」。
 *
 * 两条的根子都不在判断逻辑，而在「谁来触发」和「谁来序列化」：
 *
 * ① 中文输入法**组字期间** handleInput 被 composingRef 挡掉，而中文提示词里
 *    `image1` 后面紧跟的正是拼音打出来的汉字 —— 那一次检查永远等不到，
 *    只能靠失焦扫描，表现出来就是"要再点下节点"。修法是组字结束后补做一次。
 *
 * ② 复制时让浏览器自己序列化 chip：chip 里还有个删除按钮「×」，会被当成文字带走；
 *    又因为 chip 是 inline-flex，前后被塞了换行。粘回来时 `图片1` 被认回成 chip，
 *    但那个 × 和换行留在了正文里。修法是复制/剪切时自己写剪贴板。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { PromptEditor, clipboardTextFromFragment } = await import('@/components/PromptEditor')
const { resolveTextMentionAt, resolveTextMentionsIn } = await import('@/lib/promptTokenMention')

const CANDIDATES = [
  { nodeId: 'n1', url: '/assets/1/a.png', name: '图片1' },
  { nodeId: 'n2', url: '/assets/1/b.mp4', name: '视频1' },
]

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

function mount() {
  act(() => {
    root.render(
      <PromptEditor
        value=""
        chips={[]}
        onChange={() => {}}
        onAtKey={() => {}}
        onEscape={() => {}}
        resolveTextMention={(t) => resolveTextMentionAt(t, CANDIDATES)}
        resolveTextMentionsIn={(t) => resolveTextMentionsIn(t, CANDIDATES)}
      />,
    )
  })
  return container.querySelector('[contenteditable]') as HTMLElement
}

const chips = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-chip]'))
/** chip 之外的正文 —— 判断有没有多出来的 × / 换行要看这个，chip 自己的标签里就带着 × */
function textOutsideChips(el: HTMLElement) {
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[data-chip]').forEach((chip) => chip.remove())
  return (clone.textContent ?? '').replace(/​/g, '')
}

/**
 * 把光标放到末尾，**并且落在文本节点里面**。
 *
 * 不能只用 selectNodeContents + collapse：那样 startContainer 是编辑器这个元素节点，
 * 而真实打字时光标一定在文本节点里。放在元素节点上测出来的是一个现实中不存在的场景。
 */
function caretToEnd(el: HTMLElement) {
  const range = document.createRange()
  const last = el.lastChild
  if (last && last.nodeType === Node.TEXT_NODE) {
    range.setStart(last, (last.textContent ?? '').length)
  } else {
    range.selectNodeContents(el)
    range.collapse(false)
  }
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

describe('① 中文输入法：组字结束后要立刻转，不用再点节点', () => {
  it('打完 image1 再用输入法打「保」→ 组字结束时就变成 chip', () => {
    const el = mount()
    el.focus()
    // 组字开始：这期间的 input 会被 composingRef 挡掉
    act(() => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    el.textContent = '以输入图片作为首帧，image1保'
    caretToEnd(el)
    act(() => el.dispatchEvent(new Event('input', { bubbles: true })))
    // 组字期间不该动
    expect(chips(el)).toHaveLength(0)

    act(() => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    expect(chips(el), '组字结束后应该已经转成 chip，而不是等失焦').toHaveLength(1)
    expect(chips(el)[0].getAttribute('data-nodeid')).toBe('n1')
    expect(textOutsideChips(el)).toContain('保')
    expect(textOutsideChips(el)).not.toContain('image1')
  })

  it('组字结束时若还没打完（image1 后面什么都没有）→ 不抢', () => {
    const el = mount()
    el.focus()
    act(() => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    el.textContent = 'image1'
    caretToEnd(el)
    act(() => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    expect(chips(el)).toHaveLength(0)
  })
})

describe('② 复制时自己写剪贴板：chip 写成 image1', () => {
  function fragmentOf(html: string) {
    const holder = document.createElement('div')
    holder.innerHTML = html
    return holder
  }
  const CHIP =
    '<span data-chip="1" data-nodeid="n1" data-url="/a.png" data-name="图片1">' +
    '<img data-chip-preview="1" /><span>图片1</span><span data-del="1">×</span></span>'

  it('chip 写成 image1，删除按钮的 × 不带走', () => {
    const text = clipboardTextFromFragment(fragmentOf(`前，${CHIP}后`))
    expect(text).toBe('前，image1后')
    expect(text).not.toContain('×')
    expect(text).not.toContain('图片1')
  })

  it('chip 前后不加换行（浏览器那份会加，因为 chip 是 inline-flex）', () => {
    expect(clipboardTextFromFragment(fragmentOf(`A${CHIP}B`))).toBe('Aimage1B')
    expect(clipboardTextFromFragment(fragmentOf(`A${CHIP}B`))).not.toContain('\n')
  })

  it('多个 chip 都按英文编号写', () => {
    const two = CHIP + '中间' + CHIP.replace(/图片1/g, '视频1')
    expect(clipboardTextFromFragment(fragmentOf(two))).toBe('image1中间video1')
  })

  it('真正的换行（<br> / 块级）还是要保留', () => {
    expect(clipboardTextFromFragment(fragmentOf('第一行<br>第二行'))).toBe('第一行\n第二行')
    expect(clipboardTextFromFragment(fragmentOf('<div>A</div><div>B</div>'))).toBe('A\nB')
  })

  it('零宽字符不带进剪贴板（chip 后面那个占位符）', () => {
    expect(clipboardTextFromFragment(fragmentOf('A​B'))).toBe('AB')
  })

  it('选区片段首尾的空格保留（不 trim，那可能正是用户选中的）', () => {
    expect(clipboardTextFromFragment(fragmentOf(' 中间 '))).toBe(' 中间 ')
  })

  it('空片段 → 空串', () => {
    expect(clipboardTextFromFragment(fragmentOf(''))).toBe('')
  })
})

describe('② 复制事件真的把干净文本写进剪贴板', () => {
  function dispatchClipboard(el: HTMLElement, type: 'copy' | 'cut') {
    const setData = vi.fn()
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData, getData: () => '' } })
    act(() => {
      el.dispatchEvent(event)
    })
    return setData
  }

  it('复制整段（含 chip）→ 写进去的是「前，image1后」这种干净文本', () => {
    const el = mount()
    el.focus()
    el.textContent = ''
    el.innerHTML =
      '前，<span data-chip="1" data-nodeid="n1" data-url="/a.png" data-name="图片1">' +
      '<span>图片1</span><span data-del="1">×</span></span>后'
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const setData = dispatchClipboard(el, 'copy')
    expect(setData).toHaveBeenCalledTimes(1)
    const [mime, text] = setData.mock.calls[0]
    expect(mime).toBe('text/plain')
    expect(text).toBe('前，image1后')
    expect(text).not.toContain('×')
    expect(text).not.toContain('\n')
  })

  it('没有选区（光标折叠）→ 不插手，让浏览器按默认走', () => {
    const el = mount()
    el.focus()
    el.textContent = 'abc'
    caretToEnd(el)
    expect(dispatchClipboard(el, 'copy')).not.toHaveBeenCalled()
  })
})

describe('② 一来一回：复制再粘贴，看起来必须没变过', () => {
  it('粘回来是 1 个 chip，正文里既没有多出的 × 也没有换行', () => {
    const el = mount()
    el.focus()
    el.innerHTML =
      '以输入图片作为首帧，<span data-chip="1" data-nodeid="n1" data-url="/assets/1/a.png" ' +
      'data-name="图片1"><span>图片1</span><span data-del="1">×</span></span>保持一致。'

    // 1) 复制：走我们自己的序列化
    const holder = document.createElement('div')
    const all = document.createRange()
    all.selectNodeContents(el)
    holder.appendChild(all.cloneContents())
    const copied = clipboardTextFromFragment(holder)
    expect(copied).toBe('以输入图片作为首帧，image1保持一致。')

    // 2) 清空后粘贴那段文字
    el.innerHTML = ''
    caretToEnd(el)
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (mime: string) => (mime === 'text/plain' ? copied : '') },
    })
    act(() => {
      el.dispatchEvent(paste)
    })

    // 3) 失焦扫描把 图片1 认回成 chip
    act(() => el.blur())

    expect(chips(el), '粘回来应该正好一个引用').toHaveLength(1)
    expect(chips(el)[0].getAttribute('data-nodeid')).toBe('n1')
    const outside = textOutsideChips(el)
    expect(outside, '不该多出一个 ×').not.toContain('×')
    expect(outside, '不该多出换行').not.toContain('\n')
    expect(outside).toBe('以输入图片作为首帧，保持一致。')
  })
})

describe('③ 粘贴当场就转，不用再点一下', () => {
  function paste(el: HTMLElement, text: string) {
    caretToEnd(el)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (mime: string) => (mime === 'text/plain' ? text : '') },
    })
    act(() => {
      el.dispatchEvent(event)
    })
  }

  it('粘一段带引用的提示词 → 立刻变 chip（不用失焦）', () => {
    const el = mount()
    el.focus()
    el.innerHTML = ''
    paste(el, '以输入图片作为首帧，图片1保持一致。')
    expect(chips(el), '粘贴后就该是 chip，而不是等再点一下').toHaveLength(1)
    expect(chips(el)[0].getAttribute('data-nodeid')).toBe('n1')
    expect(textOutsideChips(el)).toBe('以输入图片作为首帧，保持一致。')
  })

  it('一段里多个引用一次全转', () => {
    const el = mount()
    el.focus()
    el.innerHTML = ''
    paste(el, '先 图片1 后 视频1 完')
    expect(chips(el)).toHaveLength(2)
    expect(chips(el).map(c => c.getAttribute('data-nodeid'))).toEqual(['n1', 'n2'])
  })

  it('两个引用紧挨着（图片1视频1）也一次全转 —— 不用点两下', () => {
    const el = mount()
    el.focus()
    el.innerHTML = ''
    paste(el, '图片1视频1')
    expect(chips(el)).toHaveLength(2)
    expect(textOutsideChips(el).replace(/\s/g, '')).toBe('')
  })

  it('粘进来对不上编号的不动（图片9 只接了 1 张图）', () => {
    const el = mount()
    el.focus()
    el.innerHTML = ''
    paste(el, '用 图片9 那张')
    expect(chips(el)).toHaveLength(0)
    expect(el.textContent).toContain('图片9')
  })
})
