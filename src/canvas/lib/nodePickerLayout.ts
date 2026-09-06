/**
 * 右键「添加节点」那个列表的高度。
 *
 * 为什么单独抽出来：菜单项数量一直在长（三维空间是第 9 个），而高度原来写死在三个地方——
 * CSS 里 `.canvas-context-flyout` 的 `max-height: 420px`、`.canvas-node-picker` 的 `390px`，
 * 以及 Canvas.tsx 里判断「贴屏幕底边就往上长」的那个 `420`。加节点时没人会想到去同步这三个数，
 * 于是 2026-08-26 上线三维空间后它被折进滚动区，用户右键翻了一遍说「没有啊」——
 * 功能其实在包里，只是看不见。
 *
 * 所以这里让高度从**菜单项数量**算出来，CSS 不再留任何写死的项数相关像素值。
 * 加第 10 个节点时不用改任何数字，`tests/node-picker-fits-all-items.test.ts` 会替你盯着。
 *
 * 下面几个常量是 styles.css 里那几条规则的实测值，改 CSS 要跟着改这里（测试有对账）。
 */

/** `.canvas-node-picker-title` 的 height。 */
export const NODE_PICKER_TITLE_HEIGHT = 36

/** `.canvas-node-picker-item` 的 min-height。 */
export const NODE_PICKER_ITEM_HEIGHT = 58

/**
 * `.canvas-node-picker-list` 的 gap。桌面是 5px，触屏那条 media query 用 `!important`
 * 抬到 8px —— 取大的那个，宁可留白也不要在触屏上又被截断。
 */
export const NODE_PICKER_ITEM_GAP = 8

/** 容器 padding 上下各 10px。 */
export const NODE_PICKER_PADDING = 20

/**
 * `.canvas-context-flyout` / `.canvas-node-picker` 都是 `box-sizing: border-box`，
 * 1px 上下边框会从 max-height 里吃掉内容区。不算进去就会冒出 2px 滚动条，
 * 最后一项的说明被圆角裁掉。
 */
export const NODE_PICKER_BORDER = 2

/**
 * 字号/行高/透明边框的亚像素误差。宁可多留一点空白，
 * 也不要再让 9 项菜单自己长出滚动条。
 */
export const NODE_PICKER_SLACK = 24

/** 视口再矮也别缩到没法用；矮到这个程度就老老实实滚动。 */
export const NODE_PICKER_MIN_HEIGHT = 200

/** 上下各留 12px，别贴着视口边缘。 */
export const NODE_PICKER_VIEWPORT_MARGIN = 24

/** 装下 `itemCount` 项、不出滚动条所需的完整高度（border-box）。 */
export function nodePickerContentHeight(itemCount: number): number {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0))
  const chrome = NODE_PICKER_TITLE_HEIGHT + NODE_PICKER_PADDING + NODE_PICKER_BORDER + NODE_PICKER_SLACK
  if (count === 0) return chrome
  return chrome + count * NODE_PICKER_ITEM_HEIGHT + (count - 1) * NODE_PICKER_ITEM_GAP
}

/**
 * 实际给容器的 max-height：够装下所有项，但不越过视口。
 * 视口够高时返回的就是 `nodePickerContentHeight`，也就是**不会出现滚动条**。
 */
export function nodePickerMaxHeight(itemCount: number, viewportHeight: number): number {
  const viewport = Number(viewportHeight)
  const room = Number.isFinite(viewport)
    ? Math.max(NODE_PICKER_MIN_HEIGHT, viewport - NODE_PICKER_VIEWPORT_MARGIN)
    : Number.POSITIVE_INFINITY
  return Math.min(nodePickerContentHeight(itemCount), room)
}

/** 视口装得下全部菜单项吗（装不下就会出滚动条，是可接受的降级而不是 bug）。 */
export function nodePickerFitsWithoutScroll(itemCount: number, viewportHeight: number): boolean {
  return nodePickerMaxHeight(itemCount, viewportHeight) >= nodePickerContentHeight(itemCount)
}

/**
 * 子菜单该不该往上长。阈值必须用**实际**高度——原来写死 420，子菜单一变高就会掉到视口外面。
 */
export function shouldFlyoutOpenUpward(
  menuTop: number,
  flyoutHeight: number,
  viewportHeight: number,
): boolean {
  const top = Number(menuTop)
  const height = Number(flyoutHeight)
  const viewport = Number(viewportHeight)
  if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(viewport)) return false
  // 子菜单顶边对齐在父项上方 8px（CSS 里 top: -8px）
  return top - 8 + height > viewport
}

const FLYOUT_GAP = 6
const FLYOUT_WIDTH = 302
const PARENT_MENU_WIDTH = 220

/**
 * 侧栏改成 position:fixed，避开父菜单上的 backdrop-filter / overflow 裁剪。
 * 返回值直接铺到 flyout 的 style 上。
 */
export function nodePickerFlyoutFixedStyle(
  parentLeft: number,
  parentTop: number,
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number; maxHeight: number } {
  const height = nodePickerMaxHeight(itemCount, viewportHeight)
  const openLeft = Number(parentLeft) + PARENT_MENU_WIDTH + FLYOUT_GAP > Number(viewportWidth)
  const left = openLeft
    ? Number(parentLeft) - FLYOUT_WIDTH - FLYOUT_GAP
    : Number(parentLeft) + PARENT_MENU_WIDTH + FLYOUT_GAP
  const rawTop = shouldFlyoutOpenUpward(parentTop, height, viewportHeight)
    ? Number(parentTop) + 8 - height
    : Number(parentTop) - 8
  const maxTop = Math.max(12, Number(viewportHeight) - height - 12)
  const top = Math.max(12, Math.min(rawTop, maxTop))
  const clampedLeft = Math.max(12, Math.min(left, Number(viewportWidth) - FLYOUT_WIDTH - 12))
  return { left: clampedLeft, top, maxHeight: height }
}
