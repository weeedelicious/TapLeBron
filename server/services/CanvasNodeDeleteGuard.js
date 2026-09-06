/**
 * 整表保存（/nodes/batch）的删除护栏。
 *
 * 单独成文件是因为这条规则已经两次造成生产事故，方向相反：
 *   2026-08-12 / 08-13  没有护栏 → 网页手里的节点表比服务端少，整表保存上来被照抄，
 *                        canvas 220（3 → 0）、canvas 238（3 → 2 → 1 → 0）节点消失；
 *   2026-08-14          护栏太紧 → "缺失一律保留"把每一次正常删除都撤销了，用户删完
 *                        刷新节点又回来，谁都删不掉东西。
 *
 * 第二次的根因是一个写在注释里、但从没验证过的前提："真实删除从来都走显式接口"。
 * 线上网页根本不调 delete / delete-v2（查 nginx 两个日志周期，删除接口调用数 0），
 * 它删节点就是在整表保存里少带一个节点。
 *
 * 于是 08-14 14:24 换成了"这个节点客户端见过没有"：基准版本里有、客户端去掉了就放行。
 * 理由是"syncProject 丢的是本地没有的远端节点，必然落在基准之外"。**这个理由是错的**，
 * 50 分钟后 canvas 115（刘嘉宝「自己的制作」，252 节点）就按这条规则被吃干：
 *
 *   15:15:19  252 节点 → 15:15:30  80（一次放行 172 个）→ 12 → 11 → 10 → 7 → 4 → 3
 *   → 15:16:32  0，全程 70 秒。
 *
 * 被丢掉的节点确实在基准里，所以"基准里有就是真实删除"这个判据单独用完全不成立。
 *
 * 现在的规则是两条同时成立才放行，任何一条不成立就保留：
 *
 *   1. 节点在客户端这次保存的基准版本里（它见过，才可能删）；
 *   2. 这一次保存里被去掉的节点数不超过 MAX_UNDECLARED_DELETES_PER_SAVE。
 *
 * 第 2 条是断路器：一次保存去掉一大片从来不是一个人的手势，而恰恰是丢失 bug 的形态。
 * 挡住第一级（252 → 80）整条崩塌就起不来——后面那些 12 → 11 → 10 的小跌，是客户端
 * 状态已经被毁之后的余波。
 *
 * 上限一开始写死成 1，结果把"使用者删自己的节点"这个基本功能也挡掉了（框选删多个、
 * 500ms 内连着删两个都不生效，刷新就还原）。删除是使用者必须有的能力，不该拿阈值挡，
 * 所以改成按画布规模算：占比 20%，下限 5、上限 30。
 *   252 节点 → 30（canvas 115 崩塌的 172 和 68 仍然被挡住，占 68% 和 27%）
 *    76 节点 → 15
 *    20 节点 → 5
 * 手工删除几乎不可能一次超过 30 个，而丢失 bug 的形态恰恰是一次掉几十上百个。
 *
 * 残余风险如实记在这里：小画布（≤25 节点）等于不设防，一次可以清空。取舍是清楚的——
 * 那种情况丢的是个位数节点，而且每次保存前的状态都在 canvas_revisions 里、删除本身也
 * 写了带完整快照的 delete 事件到 canvas_node_events，捞得回来；反过来把使用者的删除
 * 功能锁死，是每个人每天都要撞的硬伤。
 *
 * 客户端一旦升级到显式删除协议（请求带 deletedNodeKeys 字段，删除走 delete-v2），
 * 就切回最严格的老规则：整表保存里缺失一律不算删除，删除全部走带意图的接口，
 * 删几个就是几个、不再有任何阈值。那才是正解，这里的占比只是主包发不出去期间的权宜。
 */

const INFERRED_DELETE_RATIO = 0.2;
const INFERRED_DELETE_MIN = 5;
const INFERRED_DELETE_MAX = 30;

/** 一次整表保存最多允许推断出几个删除，按画布当前规模算。 */
function inferredDeleteLimit(currentNodeCount) {
  const byRatio = Math.floor(Math.max(0, Number(currentNodeCount) || 0) * INFERRED_DELETE_RATIO);
  return Math.max(INFERRED_DELETE_MIN, Math.min(INFERRED_DELETE_MAX, byRatio));
}

/**
 * @param {object} input
 * @param {string} input.canvasUuid
 * @param {Array}  input.currentNodes    服务端当前节点表
 * @param {Array}  input.incomingNodes   客户端这次提交的节点表（可能已过三方合并）
 * @param {Array}  [input.declaredDeletedKeys] 客户端显式声明要删的 nodeKey
 * @param {Set|null} [input.baseNodeKeys] 客户端基准版本里的 nodeKey 集合；拿不到传 null
 * @param {boolean} [input.declaresDeletions] 客户端是否使用显式删除协议
 * @returns {{ nodes: Array, rescuedKeys: string[], allowedKeys: string[], strict: boolean }}
 */
function rescueUndeclaredNodeRemovals({
  canvasUuid,
  currentNodes,
  incomingNodes,
  declaredDeletedKeys,
  baseNodeKeys = null,
  declaresDeletions = false,
  clientId,
  userId,
  logger = console,
}) {
  const declared = new Set((Array.isArray(declaredDeletedKeys) ? declaredDeletedKeys : []).map(String));
  const incomingKeys = new Set((Array.isArray(incomingNodes) ? incomingNodes : []).map((node) => String(node.nodeKey)));
  // 基准拿不到时退回最保守的老行为：宁可多留，不可悄悄少。
  const strict = Boolean(declaresDeletions) || !baseNodeKeys;
  const missing = (Array.isArray(currentNodes) ? currentNodes : []).filter((node) => {
    const key = String(node.nodeKey);
    return !incomingKeys.has(key) && !declared.has(key);
  });
  // 客户端见过的（基准里有）才有资格被当成删除；没见过的一律保留。
  const seenByClient = strict
    ? []
    : missing.filter((node) => baseNodeKeys.has(String(node.nodeKey)));
  // 断路器：一次保存去掉一大片不是人的手势，是丢失 bug 的形态。超限就全部保留。
  const limit = inferredDeleteLimit((Array.isArray(currentNodes) ? currentNodes : []).length);
  const burst = seenByClient.length > limit;
  const rescued = strict || burst
    ? missing
    : missing.filter((node) => !baseNodeKeys.has(String(node.nodeKey)));
  if (burst) {
    logger.warn?.(
      `[canvas ${canvasUuid}] nodes/batch 一次要去掉 ${seenByClient.length} 个节点，超过上限`
      + ` ${limit}（画布 ${(Array.isArray(currentNodes) ? currentNodes : []).length} 节点），`
      + `全部保留（疑似节点丢失，不是删除）`
      + ` client=${clientId || '-'} user=${userId}`
    );
  }
  const rescuedSet = new Set(rescued.map((node) => String(node.nodeKey)));
  const allowedKeys = missing
    .map((node) => String(node.nodeKey))
    .filter((key) => !rescuedSet.has(key));

  if (allowedKeys.length) {
    logger.warn?.(
      `[canvas ${canvasUuid}] nodes/batch 放行了 ${allowedKeys.length} 个删除（基准版本里有，客户端主动去掉）`
      + ` client=${clientId || '-'} user=${userId} keys=${allowedKeys.join(',')}`
    );
  }
  if (!rescued.length) {
    return { nodes: incomingNodes, rescuedKeys: [], allowedKeys, strict, burst };
  }
  const rescuedKeys = rescued.map((node) => String(node.nodeKey));
  logger.warn?.(
    `[canvas ${canvasUuid}] nodes/batch 保留了 ${rescuedKeys.length} 个不该消失的节点`
    + ` strict=${strict} burst=${burst} client=${clientId || '-'} user=${userId} keys=${rescuedKeys.join(',')}`
  );
  return { nodes: [...incomingNodes, ...rescued], rescuedKeys, allowedKeys, strict, burst };
}

/**
 * 保存冲突（409）时，哪些删除仍然可以执行。
 *
 * 为什么需要：/nodes/batch 一旦判定冲突就 return 409，整个保存被丢掉，用户删掉的节点
 * 跟着作废——删完刷新又回来。而这些画布常常长时间卡在自锁的冲突环里（基准过期 → 冲突
 * → 409 → 前端 isDirty 一直为真 → 拒绝 syncProject → 基准永不更新），期间所有删除全废，
 * 表现就是"一半情况删不掉"。冲突的是别的节点，用户删的那个跟它们无关，没有理由陪葬。
 *
 * 三个条件同时成立才执行：
 *   1. 节点在客户端基准版本里（它见过，才可能是它删的）；
 *   2. 节点本身不在冲突名单里（冲突节点服务端有更新的版本，不能按客户端意思删）；
 *   3. 这次去掉的数量不超上限（一次去掉一大片是节点丢失，不是删除）。
 *
 * @returns {{ droppedKeys: string[], appliedKeys: string[], overLimit: boolean }}
 */
function conflictSafeDeletions({
  baseNodes,
  incomingNodes,
  currentNodes,
  conflictNodeKeys,
  limit,
}) {
  const keyOf = (node) => String(node && node.nodeKey);
  const incoming = new Set((Array.isArray(incomingNodes) ? incomingNodes : []).filter((n) => n && n.nodeKey).map(keyOf));
  const conflicts = new Set((Array.isArray(conflictNodeKeys) ? conflictNodeKeys : []).map(String));
  const currentList = Array.isArray(currentNodes) ? currentNodes : [];
  const current = new Set(currentList.map(keyOf));
  const effectiveLimit = Number.isFinite(limit) ? Number(limit) : inferredDeleteLimit(currentList.length);
  const droppedKeys = (Array.isArray(baseNodes) ? baseNodes : [])
    .map(keyOf)
    .filter((key) => !incoming.has(key) && !conflicts.has(key) && current.has(key));
  const overLimit = droppedKeys.length > effectiveLimit;
  return {
    droppedKeys,
    appliedKeys: droppedKeys.length && !overLimit ? droppedKeys : [],
    overLimit,
    limit: effectiveLimit,
  };
}

module.exports = {
  rescueUndeclaredNodeRemovals,
  conflictSafeDeletions,
  inferredDeleteLimit,
};
