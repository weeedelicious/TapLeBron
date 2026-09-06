// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Debounced<T extends (...args: any[]) => void> = T & {
  cancel: () => void
  /** 还有一次调用在等着触发。实时同步靠它判断"本页的保存是不是还没落地"。 */
  pending: () => boolean
}

// canvasStore 有 6 处依赖 .cancel()（loadProject / clearProject / syncProject /
// persistNodesImmediately / persistNodesAndWait / 保存冲突分支），少了它 loadProject
// 会直接抛 TypeError，任何画布都打不开。
// 2026-08-14 发现生产服务器上的源码副本是没有 .cancel 的残缺版——线上当时跑的是手工
// 打补丁的老产物、从没编译过它，所以一直没暴露；改成从源码构建之后立刻炸了。
// 这里恢复带 .cancel 的实现，tests/canvas-node-safety.test.ts 会持续验证它。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      fn(...args)
    }, ms)
  }) as Debounced<T>
  debounced.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  debounced.pending = () => timer !== undefined
  return debounced
}
