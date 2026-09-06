/**
 * 右键「添加节点」必须**看得见**每一项。
 *
 * 2026-08-26 的真实事故：三维空间节点上线了、代码在包里、`CANVAS_NODE_ITEMS` 里也有它，
 * 但它是第 9 项，而子菜单 `max-height` 写死 420px（整页选择器 390px），只装得下 6 项半。
 * 用户右键翻了一遍回来说「没有啊」。
 *
 * 已有的 director-stage-node 测试只断言了「列表里有这一项」——那条是绿的，照样漏了。
 * 所以这里断言的是**装得下**：项数增加而高度没跟上就必须变红。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const {
  NODE_PICKER_TITLE_HEIGHT,
  NODE_PICKER_ITEM_HEIGHT,
  NODE_PICKER_ITEM_GAP,
  NODE_PICKER_PADDING,
  NODE_PICKER_BORDER,
  NODE_PICKER_SLACK,
  NODE_PICKER_MIN_HEIGHT,
  NODE_PICKER_VIEWPORT_MARGIN,
  nodePickerContentHeight,
  nodePickerMaxHeight,
  nodePickerFitsWithoutScroll,
  shouldFlyoutOpenUpward,
  nodePickerFlyoutFixedStyle,
} = await import('@/lib/nodePickerLayout')

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const path = require('node:path') as typeof import('node:path')
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

const CANVAS_SOURCE = read('src/canvas/components/Canvas.tsx')
const CSS_SOURCE = read('src/canvas/styles.css')

/** 从 Canvas.tsx 里数出当前到底有几个菜单项 —— 不写死数字，加节点时自动跟上。 */
const MENU_ITEMS = (() => {
  const start = CANVAS_SOURCE.indexOf('const CANVAS_NODE_ITEMS')
  const list = CANVAS_SOURCE.slice(start, CANVAS_SOURCE.indexOf('type CanvasMenuMode', start))
  const types = [...list.matchAll(/type: '([a-z_0-9]+)'/g)].map((m) => m[1])
  return types
})()

/** 常见笔记本视口高度。1440×900 是最矮的主流档，能装下就基本都能装下。 */
const LAPTOP_VIEWPORT = 900

describe('菜单项数量与高度对得上', () => {
  it('先确认真数到了菜单项（数不到的话下面全是假绿）', () => {
    expect(MENU_ITEMS.length).toBeGreaterThanOrEqual(9)
    expect(new Set(MENU_ITEMS).size, `有重复的 type：${MENU_ITEMS.join(', ')}`).toBe(MENU_ITEMS.length)
    expect(MENU_ITEMS).toContain('director_stage')
  })

  it('★ 笔记本视口下全部菜单项都装得下，不出滚动条', () => {
    expect(
      nodePickerFitsWithoutScroll(MENU_ITEMS.length, LAPTOP_VIEWPORT),
      `${MENU_ITEMS.length} 项需要 ${nodePickerContentHeight(MENU_ITEMS.length)}px，` +
        `${LAPTOP_VIEWPORT}px 视口只给到 ${nodePickerMaxHeight(MENU_ITEMS.length, LAPTOP_VIEWPORT)}px`,
    ).toBe(true)
  })

  it('★ 最后一项也在可视范围内（被折起来的就是最后一项）', () => {
    const height = nodePickerMaxHeight(MENU_ITEMS.length, LAPTOP_VIEWPORT)
    const lastItemBottom = nodePickerContentHeight(MENU_ITEMS.length)
    expect(lastItemBottom, `最后一项 ${MENU_ITEMS[MENU_ITEMS.length - 1]} 露不出来`).toBeLessThanOrEqual(height)
  })

  it('再多加一项也还装得下（留了成长空间，别下次又踩）', () => {
    expect(nodePickerFitsWithoutScroll(MENU_ITEMS.length + 1, LAPTOP_VIEWPORT)).toBe(true)
  })
})

describe('高度算式', () => {
  it('按 项数×行高 + 间隙 + 标题 + 内边距 + 边框 + 余量 算', () => {
    const chrome = NODE_PICKER_TITLE_HEIGHT + NODE_PICKER_PADDING + NODE_PICKER_BORDER + NODE_PICKER_SLACK
    expect(nodePickerContentHeight(1)).toBe(chrome + NODE_PICKER_ITEM_HEIGHT)
    expect(nodePickerContentHeight(3)).toBe(chrome + 3 * NODE_PICKER_ITEM_HEIGHT + 2 * NODE_PICKER_ITEM_GAP)
  })

  it('项数越多越高，单调不回头', () => {
    for (let n = 1; n < 20; n++) {
      expect(nodePickerContentHeight(n + 1)).toBeGreaterThan(nodePickerContentHeight(n))
    }
  })

  it('0 项时只剩标题、内边距、边框和余量，不返回负数', () => {
    const empty = NODE_PICKER_TITLE_HEIGHT + NODE_PICKER_PADDING + NODE_PICKER_BORDER + NODE_PICKER_SLACK
    expect(nodePickerContentHeight(0)).toBe(empty)
    expect(nodePickerContentHeight(-5)).toBe(empty)
    expect(nodePickerContentHeight(NaN)).toBe(empty)
  })

  it('矮视口下退化成滚动，而不是撑出屏幕', () => {
    const short = 420
    const height = nodePickerMaxHeight(MENU_ITEMS.length, short)
    expect(height).toBeLessThanOrEqual(short - 24)
    expect(nodePickerFitsWithoutScroll(MENU_ITEMS.length, short)).toBe(false)
  })

  it('视口再矮也不缩到没法用', () => {
    expect(nodePickerMaxHeight(MENU_ITEMS.length, 100)).toBeGreaterThanOrEqual(NODE_PICKER_MIN_HEIGHT)
    expect(nodePickerMaxHeight(MENU_ITEMS.length, 0)).toBeGreaterThanOrEqual(NODE_PICKER_MIN_HEIGHT)
  })

  it('视口高度是脏值时按不限制处理，不返回 NaN', () => {
    for (const bad of [NaN, undefined, 'x']) {
      const height = nodePickerMaxHeight(MENU_ITEMS.length, bad as unknown as number)
      expect(Number.isFinite(height), String(bad)).toBe(true)
      expect(height).toBe(nodePickerContentHeight(MENU_ITEMS.length))
    }
  })
})

describe('贴底边时往上长', () => {
  it('装得下就往下长', () => {
    expect(shouldFlyoutOpenUpward(100, 600, 900)).toBe(false)
  })

  it('会超出视口底边就往上长', () => {
    expect(shouldFlyoutOpenUpward(700, 600, 900)).toBe(true)
  })

  it('阈值跟着实际高度走 —— 同一个位置，矮的往下、高的往上', () => {
    expect(shouldFlyoutOpenUpward(500, 300, 900)).toBe(false)
    expect(shouldFlyoutOpenUpward(500, 700, 900)).toBe(true)
  })

  it('脏值不抛、不误翻', () => {
    expect(shouldFlyoutOpenUpward(NaN, 600, 900)).toBe(false)
    expect(shouldFlyoutOpenUpward(100, NaN, 900)).toBe(false)
  })
})

/*
 * 接线断言：算式对了但没接上，界面照样是坏的。
 * 这三条各自都能单独失效，所以分开断言。
 */
describe('真的接到菜单上了', () => {
  it('高度按 CANVAS_NODE_ITEMS.length 算，不是写死的数字', () => {
    expect(CANVAS_SOURCE).toContain('nodePickerMaxHeight(CANVAS_NODE_ITEMS.length, window.innerHeight)')
  })

  it('两个入口都下发了高度（子菜单走 fixed 定位，整页选择器走 maxHeight）', () => {
    expect(CANVAS_SOURCE).toContain('nodePickerFlyoutFixedStyle(')
    const flyout = CANVAS_SOURCE.slice(CANVAS_SOURCE.indexOf('className="canvas-context-flyout"'))
    expect(flyout.slice(0, 80), '子菜单没下发 flyoutStyle').toContain('style={flyoutStyle}')

    const picker = CANVAS_SOURCE.slice(CANVAS_SOURCE.indexOf('canvas-right-menu canvas-node-picker'))
    expect(picker.slice(0, 200), '整页选择器没下发 maxHeight').toContain('maxHeight: pickerHeight')
  })

  it('往上长的判断用的是算出来的高度，不是写死的 420', () => {
    expect(CANVAS_SOURCE, '写死的 420 阈值还在').not.toContain('pos.top + 420 > window.innerHeight')
    const style = nodePickerFlyoutFixedStyle(100, 700, MENU_ITEMS.length, 1440, 900)
    expect(style.top + style.maxHeight).toBeLessThanOrEqual(900)
  })

  it('整页选择器定位也用算出来的高度（否则贴底边会被挤出屏幕）', () => {
    expect(CANVAS_SOURCE).toContain('getMenuPosition(menu.screenX, menu.screenY, 310, pickerHeight)')
  })

  it('父菜单自身不许带 backdrop-filter（会裁掉侧栏，只露出大约 5 项）', () => {
    const ownBlocks = [...CSS_SOURCE.matchAll(/(?:^|\n)\.canvas-right-menu \{([^}]+)\}/g)]
    expect(ownBlocks.length, '找不到 .canvas-right-menu 自身规则').toBeGreaterThan(0)
    for (const match of ownBlocks) {
      expect(match[1], match[1]).not.toMatch(/backdrop-filter/)
    }
    expect(CSS_SOURCE).toMatch(/\.canvas-right-menu::before\s*\{[^}]*backdrop-filter/)
  })

  it('侧栏用 position:fixed，不被父菜单裁成大约 5 项', () => {
    const start = CSS_SOURCE.indexOf('\n.canvas-context-flyout {')
    expect(start, '找不到 .canvas-context-flyout').toBeGreaterThan(-1)
    const block = CSS_SOURCE.slice(start, CSS_SOURCE.indexOf('}', start))
    expect(block).toContain('position: fixed')
    expect(block, '还在用 absolute，会被父菜单裁掉').not.toContain('position: absolute')
  })

  it('CSS 里只留视口兜底，不许再有写死的像素上限（会过期、且会盖掉内联值）', () => {
    for (const selector of ['.canvas-context-flyout', '.canvas-node-picker']) {
      const heights = [...CSS_SOURCE.matchAll(new RegExp(`${selector.replace('.', '\\.')}[^{]*\\{([^}]+)\\}`, 'g'))]
        .flatMap((match) => [...match[1].matchAll(/max-height:\s*([^;]+);/g)].map((m) => m[1].trim().replace(/\s*!important$/, '')))
      expect(heights.length, `${selector} 一条 max-height 都没找到`).toBeGreaterThan(0)
      for (const maxHeight of heights) {
        expect(maxHeight, `${selector} 的 max-height 不该是「${maxHeight}」`)
          .toBe(`calc(100vh - ${NODE_PICKER_VIEWPORT_MARGIN}px)`)
      }
    }
  })

  it('CSS 里的行高 / 标题高还是常量里写的那几个数（对账，改 CSS 要跟着改）', () => {
    const blockAfter = (needle: string) => {
      const start = CSS_SOURCE.lastIndexOf(needle)
      return CSS_SOURCE.slice(start, CSS_SOURCE.indexOf('}', start))
    }
    expect(blockAfter('.canvas-node-picker-item {')).toContain(`min-height: ${NODE_PICKER_ITEM_HEIGHT}px`)
    expect(blockAfter('.canvas-node-picker-title {')).toContain(`height: ${NODE_PICKER_TITLE_HEIGHT}px`)
  })

  /*
   * gap 在 CSS 里声明了三次：桌面 4px、另一处覆盖 5px、触屏 media query 用 !important 抬到 8px。
   * 常量必须取**最大**的那个，否则触屏上算出来的高度比实际内容矮，最后一项又被切掉 ——
   * 而这在高视口的桌面上是看不出来的（两种算法都装得下），所以只能靠对账测。
   */
  it('间隙常量取的是 CSS 里声明过的最大值（触屏那条 !important 最大）', () => {
    const listGaps = [...CSS_SOURCE.matchAll(/\.canvas-node-picker-list\s*\{([^}]*)\}/g)]
      .flatMap((match) => [...match[1].matchAll(/gap:\s*(\d+)px/g)].map((m) => Number(m[1])))
    expect(listGaps.length, '一条 .canvas-node-picker-list 的 gap 都没找到，正则失效了').toBeGreaterThanOrEqual(2)
    expect(
      NODE_PICKER_ITEM_GAP,
      `CSS 里声明的 gap 有 ${listGaps.join(' / ')}px，常量必须取最大的那个`,
    ).toBe(Math.max(...listGaps))
  })
})
