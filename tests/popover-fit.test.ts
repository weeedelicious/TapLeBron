/**
 * 弹层定位（2026-08-19：视频节点「分辨率那一行没了」→「我要看全，不要滚轮」）。
 *
 * 第一版我做成限高 + 内部滚动，用户明确否掉了。所以规则是 **先换位置，不够才压高度**：
 * 上方装得下往上 → 装不下就翻到下方 → 两边都不够才限高滚动（兜底）。
 * 这里把这个优先级锁死，并锁住"绝不返回 0 或负数高度"（那样弹层塌成一条缝，等于又藏起来）。
 */
import { describe, expect, it } from 'vitest'
import { popoverPlacement, POPOVER_MIN_HEIGHT, POPOVER_GAP } from '@/lib/popoverFit'

const VH = 900

describe('popoverPlacement', () => {
  it('上方装得下就往上展开，不限高、不滚动', () => {
    // 锚点上沿 500，内容 300 → 上方可用 500-6-8=486，够
    const p = popoverPlacement({ anchorTop: 500, anchorBottom: 540, contentHeight: 300, viewportHeight: VH })
    expect(p.top).toBeUndefined()
    expect(p.bottom).toBe(VH - 500 + POPOVER_GAP)
    expect(p.maxHeight).toBeUndefined()
  })

  it('上方装不下、下方装得下就翻到下方，仍然完整显示', () => {
    // 锚点上沿 200 → 上方只有 186；下方 900-240-14=646，够
    const p = popoverPlacement({ anchorTop: 200, anchorBottom: 240, contentHeight: 330, viewportHeight: VH })
    expect(p.top).toBe(240 + POPOVER_GAP)
    expect(p.bottom).toBeUndefined()
    expect(p.maxHeight).toBeUndefined()
  })

  it('这就是用户遇到的那种情形：节点靠上、内容较高 → 必须翻到下方而不是压扁', () => {
    // 截图里的量级：底栏上沿约 420，面板顶约 188，内容约 330
    const p = popoverPlacement({ anchorTop: 420, anchorBottom: 452, contentHeight: 330, viewportHeight: VH })
    // 上方 420-14=406 够放 330，所以往上；关键是**没有 maxHeight**
    expect(p.maxHeight).toBeUndefined()
  })

  it('两边都装不下才限高滚动，且取空间大的那一侧', () => {
    // 视口很矮：上方 100-14=86，下方 300-160-14=126 → 选下方
    const p = popoverPlacement({ anchorTop: 100, anchorBottom: 160, contentHeight: 500, viewportHeight: 300 })
    expect(p.top).toBe(160 + POPOVER_GAP)
    expect(p.maxHeight).toBe(Math.max(POPOVER_MIN_HEIGHT, 126))
  })

  it('上方空间更大时兜底选上方', () => {
    const p = popoverPlacement({ anchorTop: 260, anchorBottom: 280, contentHeight: 500, viewportHeight: 300 })
    expect(p.bottom).toBe(300 - 260 + POPOVER_GAP)
    expect(p.maxHeight).toBe(Math.max(POPOVER_MIN_HEIGHT, 246))
  })

  it('兜底高度绝不为 0 或负数', () => {
    const p = popoverPlacement({ anchorTop: 10, anchorBottom: 12, contentHeight: 500, viewportHeight: 20 })
    expect(p.maxHeight).toBe(POPOVER_MIN_HEIGHT)
  })

  it('首帧还没量到内容高度时先按往上摆，不带限高', () => {
    const p = popoverPlacement({ anchorTop: 300, anchorBottom: 340, contentHeight: 0, viewportHeight: VH })
    expect(p.bottom).toBe(VH - 300 + POPOVER_GAP)
    expect(p.maxHeight).toBeUndefined()
  })

  it('内容高度是 NaN 时不把 NaN 写进样式', () => {
    const p = popoverPlacement({ anchorTop: 300, anchorBottom: 340, contentHeight: Number.NaN, viewportHeight: VH })
    expect(Number.isFinite(p.bottom)).toBe(true)
    expect(p.maxHeight).toBeUndefined()
  })
})
