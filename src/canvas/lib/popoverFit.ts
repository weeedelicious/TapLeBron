/**
 * 弹层怎么摆才能**完整显示**。
 *
 * 起因：视频节点底栏的设置弹层原来是 `position:absolute; bottom:100%` 长在面板里，
 * 内容一高就被面板上边裁掉，而被裁掉的偏偏是最上面的「比例」「清晰度」两行 ——
 * 用户看到的现象是"分辨率那一行没了 / 改不了分辨率"（2026-08-19）。
 *
 * 第一版我改成限高 + 内部滚动，用户明确否掉了：要能一眼看全，不要滚轮。
 * 所以现在的规则是 **先换位置，不够才压高度**：
 *   1. 上方装得下 → 往上展开（原来的习惯位置）
 *   2. 上方装不下、下方装得下 → 翻到下方
 *   3. 两边都装不下 → 取空间大的一侧，限高 + 滚动（兜底，不是常态）
 *
 * CSS 做不到这件事：会不会被裁取决于**节点在屏幕上的位置**，不是弹层自身高度。
 */

/** 空间再小也留这么高，免得弹层塌成一条缝把内容全藏起来。 */
export const POPOVER_MIN_HEIGHT = 140
/** 弹层与锚点之间、以及与视口边缘之间的留白。 */
export const POPOVER_GAP = 6
const VIEWPORT_MARGIN = 8

export interface PopoverPlacement {
  /** 距视口底部的距离（往上展开时用） */
  bottom?: number
  /** 距视口顶部的距离（往下展开时用） */
  top?: number
  /** 只有两边都装不下时才有：限高并内部滚动 */
  maxHeight?: number
}

export function popoverPlacement(input: {
  anchorTop: number
  anchorBottom: number
  contentHeight: number
  viewportHeight: number
}): PopoverPlacement {
  const { anchorTop, anchorBottom, contentHeight, viewportHeight } = input
  const above = Math.floor(anchorTop - POPOVER_GAP - VIEWPORT_MARGIN)
  const below = Math.floor(viewportHeight - anchorBottom - POPOVER_GAP - VIEWPORT_MARGIN)
  const needed = Number.isFinite(contentHeight) ? Math.ceil(contentHeight) : 0

  // 还没量到内容高度（首帧）时先按往上摆，量到之后这个函数会被再调一次
  if (needed <= 0 || needed <= above) {
    return { bottom: Math.round(viewportHeight - anchorTop + POPOVER_GAP) }
  }
  if (needed <= below) {
    return { top: Math.round(anchorBottom + POPOVER_GAP) }
  }
  if (above >= below) {
    return {
      bottom: Math.round(viewportHeight - anchorTop + POPOVER_GAP),
      maxHeight: Math.max(POPOVER_MIN_HEIGHT, above),
    }
  }
  return {
    top: Math.round(anchorBottom + POPOVER_GAP),
    maxHeight: Math.max(POPOVER_MIN_HEIGHT, below),
  }
}
