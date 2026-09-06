/**
 * 取消参考时把那根连线也断掉（2026-08-25 用户要求）。
 *
 * 视频节点一直是这么做的、图片节点漏了，两边各写一遍同样的过滤条件很容易只改一处，
 * 所以提到这里共用。
 *
 * 边**不单独存库**：loadProject / syncProject 都用 edgesFromNodeReferences(nodes) 从
 * 节点引用重建。所以真正让连线消失的是引用列表那次写入，这个函数只负责让当前视图立刻跟上。
 */
export interface EdgeLike {
  source: string
  target: string
}

/**
 * 去掉 a 与 b 之间的连线，**两个方向都去**。
 *
 * 为什么不只去 upstream→downstream 那一个方向：画布允许反着连（把图片节点拖到
 * 视频节点的输出侧），只删一个方向会留下一根看不出来源的线。
 * 其余连线原样保留 —— 这里只动这一对。
 */
export function edgesWithoutLink<T extends EdgeLike>(edges: T[], a: string, b: string): T[] {
  if (!a || !b) return edges
  return edges.filter(
    (edge) =>
      !(edge.source === a && edge.target === b) &&
      !(edge.source === b && edge.target === a),
  )
}
