/**
 * 提示词排版瘦身：只去掉药丸以外元素上从网页带进来的 style / class / data-*，
 * 文字逐字不变、药丸逐字节不变，否则原样返回。见 server/services/PromptHtmlCleaner.js。
 */
import { describe, expect, it } from 'vitest'

const { cleanPromptHtml, chipFragments } = require('../server/services/PromptHtmlCleaner')

const CHIP = '<span contenteditable="false" data-chip="1" data-nodeid="n1" data-url="/assets/1/a.png" data-name="图片1" style="display:inline-flex;gap:4px">'
  + '<img src="/assets/1/a.png" draggable="false" data-chip-preview="1" style="width:16px;height:16px">图片1</span>'

describe('提示词排版瘦身', () => {
  it('去掉网页带进来的 style / class / data-*，文字不变', () => {
    const html = '<div class="qMYqUG_root" data-turn-id="x"><p style="color:rgb(1,2,3);font-size:16px" data-pm-slice="1 1 []">狮子 <strong style="font-weight:600">冲刺</strong></p></div>'
    const result = cleanPromptHtml(html)
    expect(result.changed).toBe(true)
    expect(result.html).toBe('<div><p>狮子 <strong>冲刺</strong></p></div>')
    expect(result.savedBytes).toBeGreaterThan(0)
  })

  it('图片药丸整段原样保留（含药丸里的 style 和 data-*）', () => {
    const html = `<p style="margin:0">参考 ${CHIP} 的角色</p>`
    const result = cleanPromptHtml(html)
    expect(result.changed).toBe(true)
    expect(result.html).toBe(`<p>参考 ${CHIP} 的角色</p>`)
    expect(chipFragments(result.html)).toEqual([CHIP])
  })

  it('多个药丸、嵌套标签都不受影响', () => {
    const html = `<ul class="x"><li style="a:b"><p>${CHIP}和${CHIP.replace(/n1/g, 'n2')}</p></li></ul>`
    const result = cleanPromptHtml(html)
    expect(chipFragments(result.html)).toEqual(chipFragments(html))
    expect(result.html.startsWith('<ul><li><p>')).toBe(true)
  })

  it('没有可去的属性时原样返回', () => {
    const html = `<p>纯文字 ${CHIP}</p>`
    expect(cleanPromptHtml(html)).toEqual({ html, changed: false, savedBytes: 0 })
  })

  it('空值 / 非字符串原样返回', () => {
    expect(cleanPromptHtml(undefined).changed).toBe(false)
    expect(cleanPromptHtml('').changed).toBe(false)
  })
})
