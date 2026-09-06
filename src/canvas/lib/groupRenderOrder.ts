/**
 * 分组节点必须排在它的子节点前面才会画在下面。
 *
 * 分组框是一个 inset:0、pointerEvents:auto 的 div，铺满整个组区域；一旦分组节点排到
 * 子节点后面，它就整片盖在子节点上，组里的节点点不中、也框选不到 —— 表现出来就是
 * "组在节点的上面"。
 *
 * groupNodes 建组时把组放在数组第一个，但这个顺序之后没有任何地方守着：
 *   - Cindy 插件写节点、applyRemoteNodeEvent 收到没见过的 nodeKey，都是往数组末尾追加，
 *     追加的是分组节点就直接盖住自己的孩子；
 *   - 这个顺序会原样存进 nodeList，刷新后照旧，自己不会好。
 *
 * 所以在交给 React Flow 之前统一把组提到前面。稳定排序：组之间、非组之间的相对顺序
 * 都不动，嵌套组的内外层关系因此也保持原样。只影响渲染顺序，不写库。
 */

export function needsGroupHoist<T extends { type?: string }>(nodes: readonly T[]) {
  let sawNonGroup = false;
  for (const node of nodes) {
    if (node.type === "group") {
      if (sawNonGroup) return true;
    } else {
      sawNonGroup = true;
    }
  }
  return false;
}

export function hoistGroupNodesForRender<T extends { type?: string }>(nodes: T[]) {
  // 绝大多数情况下顺序本来就是对的，原样返回，避免每次渲染都造新数组。
  if (!needsGroupHoist(nodes)) return nodes;
  return [
    ...nodes.filter((node) => node.type === "group"),
    ...nodes.filter((node) => node.type !== "group"),
  ];
}
