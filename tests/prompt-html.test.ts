import { describe, expect, it } from 'vitest'
import {
  normalizeClipboardText,
  plainTextFromClipboard,
  sanitizePromptHtml,
} from '../src/canvas/lib/promptHtml'

/** 跟 PromptEditor 的 buildChipHtml 结构一致的一个 chip。 */
const CHIP =
  '<span contenteditable="false" data-chip="1" data-nodeid="n1" data-url="/a.png" data-name="图片1" data-media-type="image" ' +
  'style="display:inline-flex;align-items:center;max-width:calc(100% - 8px);">' +
  '<span data-chip-preview="1" style="width:14px;height:14px;"></span>' +
  '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#c4b5fd;">图片1</span>' +
  '<span data-del="1" style="font-size:11px;color:#5a5070;">×</span>' +
  '</span>'

describe('sanitizePromptHtml', () => {
  it('剥掉 white-space: nowrap —— 就是不换行的直接原因', () => {
    const out = sanitizePromptHtml('<div style="white-space:nowrap;color:#fff">很长的一段中文</div>')
    expect(out).not.toMatch(/white-space/i)
    // 无关的样式要留着，别顺手把配色也洗掉
    expect(out).toMatch(/color/i)
    expect(out).toContain('很长的一段中文')
  })

  it('剥掉固定 width / height 与老式排版属性', () => {
    const out = sanitizePromptHtml('<p style="width:640px;height:20px;margin:4px" width="640" align="center">正文</p>')
    expect(out).not.toMatch(/width/i)
    expect(out).not.toMatch(/height/i)
    expect(out).not.toMatch(/align=/i)
    expect(out).toMatch(/margin/i)
    expect(out).toContain('正文')
  })

  it('带前缀的同名属性也剥（-webkit-line-height 之类）', () => {
    const out = sanitizePromptHtml('<span style="-webkit-line-height:3;color:red">字</span>')
    expect(out).not.toMatch(/line-height/i)
    expect(out).toMatch(/color/i)
  })

  it('chip 整棵子树一个字节都不动', () => {
    const out = sanitizePromptHtml(`<div style="white-space:nowrap">前${CHIP}后</div>`)
    // chip 内部那个名字 span 本来就要 nowrap，必须保住
    expect(out).toContain('data-chip="1"')
    expect(out).toContain('white-space:nowrap')
    expect(out).toContain('data-del="1"')
    expect(out).toContain('data-chip-preview="1"')
    expect(out).toContain('图片1')
    // 但 chip 外面那层 div 的 nowrap 要被剥掉
    const outerDiv = out.slice(0, out.indexOf('data-chip'))
    expect(outerDiv).not.toMatch(/white-space/i)
  })

  it('删掉 Word 粘贴带来的 style / meta / o:p 这类不渲染元素', () => {
    const out = sanitizePromptHtml(
      '<meta charset="utf-8"><style>.MsoNormal{margin:0}</style><p class="MsoNormal">正文<o:p></o:p></p>',
    )
    expect(out).not.toMatch(/<style/i)
    expect(out).not.toMatch(/<meta/i)
    expect(out).toContain('正文')
  })

  it('不动 DOM 结构：正文顺序与文本完全保留', () => {
    const html = '<div style="width:9px">一</div><p style="white-space:pre">二</p><span>三</span>'
    const out = sanitizePromptHtml(html)
    const container = document.createElement('div')
    container.innerHTML = out
    expect(container.textContent).toBe('一二三')
    expect(container.querySelectorAll('div,p,span').length).toBe(3)
  })

  it('纯文本原样返回，空值给空串', () => {
    expect(sanitizePromptHtml('就是一段没有标签的文字')).toBe('就是一段没有标签的文字')
    expect(sanitizePromptHtml('')).toBe('')
    expect(sanitizePromptHtml(null as unknown as string)).toBe('')
  })

  it('幂等：洗两遍结果一样', () => {
    const once = sanitizePromptHtml(`<div style="white-space:nowrap;width:10px">甲${CHIP}</div>`)
    expect(sanitizePromptHtml(once)).toBe(once)
  })

  /**
   * 把 Chrome 严格的选择器解析装回 jsdom。
   *
   * 'o:p' 按 CSS 语法是「元素 o + 伪类 :p」，:p 不是合法伪类，Chrome 抛 SyntaxError；
   * 而 jsdom 的 nwsapi 宽容、返回空集合。2026-08-18 的线上黑屏就是靠这个差异漏过 199 条
   * 全绿单测的，所以这里必须手动模拟严格行为，否则测了也白测。
   */
  function withStrictSelectorParsing<T>(run: () => T): T {
    const original = Element.prototype.querySelectorAll
    Element.prototype.querySelectorAll = function patched(this: Element, selector: string) {
      // 形如 tag:something 的裸类型选择器 —— Chrome 会当伪类解析并拒绝
      if (/^[a-z][a-z0-9-]*:[a-z]/i.test(selector)) {
        const error = new Error(`'${selector}' is not a valid selector`)
        error.name = 'SyntaxError'
        throw error
      }
      return original.call(this, selector)
    } as typeof Element.prototype.querySelectorAll
    try {
      return run()
    } finally {
      Element.prototype.querySelectorAll = original
    }
  }

  it('标签名当不了 CSS 选择器时（Word 的 <o:p>）照样删掉，且绝不抛异常', () => {
    withStrictSelectorParsing(() => {
      const out = sanitizePromptHtml('<p style="white-space:nowrap">正文<o:p></o:p></p>')
      expect(out).not.toMatch(/o:p/i)
      expect(out).toContain('正文')
      // 顺带确认清洗本身没被这条挡住
      expect(out).not.toMatch(/white-space/i)
    })
  })

  /**
   * 线上实测的脏数据形态（2026-08-18，最近 40 个画布 / 299 个有 promptHtml 的节点）：
   * 固定 width 157 个、white-space:nowrap 97 个、white-space:pre 12 个、MsoNormal 7 个，
   * 另有几个节点的 promptHtml 长到 13~15 万字符。全部在严格选择器解析下跑一遍，
   * 确认既不抛异常、也确实洗干净了。
   */
  it('线上那几种脏数据形态：严格解析下不抛，且都洗干净', () => {
    const bigBlob = `<div style="white-space:nowrap">${'<span style="width:99px;font-size:9px">词</span>'.repeat(4000)}</div>`
    const samples = [
      // Word 整套：meta + style + MsoNormal + o:p + 固定宽度 + nowrap
      '<meta charset="utf-8"><style>.MsoNormal{margin:0}</style>'
      + '<p class="MsoNormal" style="white-space:nowrap;width:640px" width="640"><o:p></o:p>正文</p>',
      // 未闭合标签
      '<div style="white-space:pre">正文<span style="width:10px">断',
      // 冒号标签但不在删除名单里：不能崩，也不该被删掉正文
      '<w:sdt style="white-space:nowrap">正文</w:sdt>',
      // 大写形态
      '<P style="WHITE-SPACE:NOWRAP">正文<O:P></O:P></P>',
      // 13~15 万字符量级
      bigBlob,
    ]
    withStrictSelectorParsing(() => {
      for (const sample of samples) {
        const out = sanitizePromptHtml(sample)
        expect(out).not.toMatch(/white-space/i)
        expect(out).not.toMatch(/<o:p/i)
        expect(out).not.toMatch(/<style/i)
        if (sample !== bigBlob) expect(out).toContain('正文')
      }
    })
    // chip 混在脏数据里也要整棵保住
    withStrictSelectorParsing(() => {
      const out = sanitizePromptHtml(`<p class="MsoNormal" style="white-space:nowrap"><o:p></o:p>${CHIP}正文</p>`)
      expect(out).toContain('data-chip="1"')
      expect(out).toContain('white-space:nowrap') // 来自 chip 内部，必须留
      expect(out).not.toMatch(/<o:p/i)
      expect(out.slice(0, out.indexOf('data-chip'))).not.toMatch(/white-space/i)
    })
  })

  it('清洗过程中万一抛异常，退回原文而不是把调用方带崩', () => {
    const original = Element.prototype.querySelectorAll
    Element.prototype.querySelectorAll = (() => {
      throw new Error('boom')
    }) as unknown as typeof Element.prototype.querySelectorAll
    try {
      const raw = '<div style="white-space:nowrap">正文</div>'
      // 不抛，并且原文一个字节不少 —— 最坏情况只是"这几段不换行"，不是打不开节点
      expect(sanitizePromptHtml(raw)).toBe(raw)
    } finally {
      Element.prototype.querySelectorAll = original
    }
  })
})

describe('normalizeClipboardText', () => {
  it('统一行尾并保留换行', () => {
    expect(normalizeClipboardText('甲\r\n乙\r丙')).toBe('甲\n乙\n丙')
  })

  it('去掉零宽与方向标记、把不换行空格换成普通空格', () => {
    expect(normalizeClipboardText('甲​乙‪丙﻿')).toBe('甲乙丙')
    expect(normalizeClipboardText('a b')).toBe('a b')
  })

  it('行尾空白收干净，三个以上空行压成两个', () => {
    expect(normalizeClipboardText('甲   \n乙\t\n')).toBe('甲\n乙\n')
    expect(normalizeClipboardText('甲\n\n\n\n乙')).toBe('甲\n\n乙')
  })
})

describe('plainTextFromClipboard', () => {
  function clipboard(map: Record<string, string>): DataTransfer {
    return { getData: (type: string) => map[type] ?? '' } as unknown as DataTransfer
  }

  it('优先取 text/plain', () => {
    expect(plainTextFromClipboard(clipboard({
      'text/plain': '纯文本',
      'text/html': '<b>富文本</b>',
    }))).toBe('纯文本')
  })

  it('只有 text/html 时取其文本，并给块级元素补换行', () => {
    const out = plainTextFromClipboard(clipboard({
      'text/html': '<p style="white-space:nowrap">第一段</p><p>第二段</p>',
    }))
    expect(out).toContain('第一段')
    expect(out).toContain('第二段')
    expect(out).not.toMatch(/<|nowrap/i)
    expect(out.indexOf('第一段')).toBeLessThan(out.indexOf('第二段'))
    // 两段之间必须有换行，否则会被挤成一行
    expect(out.slice(out.indexOf('第一段'), out.indexOf('第二段'))).toContain('\n')
  })

  it('空剪贴板给空串', () => {
    expect(plainTextFromClipboard(null)).toBe('')
    expect(plainTextFromClipboard(clipboard({}))).toBe('')
  })
})
