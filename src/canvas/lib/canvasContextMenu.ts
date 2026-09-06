/**
 * 右键到底算不算「在画布上右键」。
 *
 * 2026-08-25 用户要求：点开图片节点看大图时，在大图上右键要能出浏览器自己的菜单
 * （在新标签页中打开图片 / 图片另存为 / 复制图片 / 复制图片地址）。
 *
 * 之前出不来，原因是个 React portal 的坑：
 *   · 大图查看器、抠像、白板、灯光、局部重绘、全景…这些浮层都是 createPortal 到
 *     document.body 的，DOM 上早就不在画布里了；
 *   · 但 **React 合成事件走的是组件树**，portal 的内容仍然算那个节点的后代 ——
 *     浮层里的右键会一路冒到 `.react-flow__node` 的 onContextMenu 上；
 *   · 那个回调（openNodeMenu）第一句就是 event.preventDefault()，浏览器菜单于是被吃掉，
 *     取而代之弹出的是「复制节点 / 删除」那个节点菜单 —— 盖在全屏浮层之上，谁也不想要。
 *
 * 判据只能看 DOM、不能看 React 树：真正落在画布里的右键，target 一定在 `.react-flow` 子树内；
 * portal 出去的浮层不在。
 */

/** ReactFlow 根元素的类名。画布里的一切（节点、连线、pane）都在它下面。 */
const CANVAS_ROOT_SELECTOR = '.react-flow'

export function isCanvasContextMenuTarget(target: EventTarget | null | undefined): boolean {
  // 不是元素（文本节点 / window / null）时一律不当画布右键：宁可让浏览器接管，
  // 也不要凭空在浮层上弹一个节点菜单。
  if (!target || typeof (target as Element).closest !== 'function') return false
  return Boolean((target as Element).closest(CANVAS_ROOT_SELECTOR))
}
