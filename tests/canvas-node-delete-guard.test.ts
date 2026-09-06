/**
 * 整表保存删除护栏的回归测试。
 *
 * 这条规则今天出过三次事故，方向来回摆，所以每一档都要钉住：
 *   1. 没有护栏 → 网页手里的节点表比服务端少，整表保存被照抄：
 *      canvas 220（3 → 0）、canvas 238（3 → 2 → 1 → 0）节点消失；
 *   2. 护栏太紧（缺失一律保留）→ 每一次正常删除都被撤销，用户删完刷新节点又回来；
 *   3. 只看"基准里有没有"→ canvas 115（刘嘉宝，252 节点）15:15–15:16 被逐级吃干：
 *      252 → 80 → 12 → 11 → 10 → 7 → 4 → 3 → 0，一次放行 172 个。
 *
 * 所以现在两条同时成立才放行：节点在客户端基准版本里，且这次去掉的数量不超上限。
 */
import { describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require("../server/services/CanvasNodeDeleteGuard.js");
const {
  rescueUndeclaredNodeRemovals,
  conflictSafeDeletions,
  inferredDeleteLimit,
} = guard;

type Node = { nodeKey: string; data?: unknown };

const node = (nodeKey: string): Node => ({ nodeKey, data: JSON.stringify({ label: nodeKey }) });
const keys = (nodes: Node[]) => nodes.map((entry) => String(entry.nodeKey)).sort();
const silent = { warn: vi.fn() };

function run(input: Record<string, unknown>) {
  return rescueUndeclaredNodeRemovals({
    canvasUuid: "test-canvas",
    clientId: "client-a",
    userId: 1,
    logger: silent,
    ...input,
  });
}

describe("老客户端：删除靠整表保存里少带节点", () => {
  it("删一个节点 → 真的删掉（今天用户报的就是这个删不掉）", () => {
    const result = run({
      currentNodes: [node("a"), node("b"), node("c")],
      incomingNodes: [node("a"), node("b")],
      baseNodeKeys: new Set(["a", "b", "c"]),
      declaresDeletions: false,
    });

    expect(keys(result.nodes)).toEqual(["a", "b"]);
    expect(result.rescuedKeys).toEqual([]);
    expect(result.allowedKeys).toEqual(["c"]);
    expect(result.burst).toBe(false);
  });

  it("基准里没有的节点缺失 → 保留（客户端删不掉一个自己没有的东西）", () => {
    // canvas 232 的形态：网页基准停在 a/b，期间生成结果往画布里写了 gen-1。
    const result = run({
      currentNodes: [node("a"), node("b"), node("gen-1")],
      incomingNodes: [node("a"), node("b")],
      baseNodeKeys: new Set(["a", "b"]),
      declaresDeletions: false,
    });

    expect(keys(result.nodes)).toEqual(["a", "b", "gen-1"]);
    expect(result.rescuedKeys).toEqual(["gen-1"]);
    expect(result.allowedKeys).toEqual([]);
  });

  it("同一次保存里：用户删的那一个放行，没见过的保留", () => {
    const result = run({
      currentNodes: [node("a"), node("b"), node("gen-1")],
      incomingNodes: [node("a")],
      baseNodeKeys: new Set(["a", "b"]),
      declaresDeletions: false,
    });

    expect(keys(result.nodes)).toEqual(["a", "gen-1"]);
    expect(result.rescuedKeys).toEqual(["gen-1"]);
    expect(result.allowedKeys).toEqual(["b"]);
  });
});

describe("断路器：一次去掉一大片不是删除，是节点丢失", () => {
  it("canvas 115 的真实形态：252 → 80，一次少 172 个，必须全部保留", () => {
    const current = Array.from({ length: 252 }, (_, i) => node(`n${i}`));
    const incoming = current.slice(0, 80);
    const result = run({
      currentNodes: current,
      incomingNodes: incoming,
      baseNodeKeys: new Set(current.map((entry) => entry.nodeKey)),
      declaresDeletions: false,
    });

    expect(result.nodes).toHaveLength(252);
    expect(result.rescuedKeys).toHaveLength(172);
    expect(result.allowedKeys).toEqual([]);
    expect(result.burst).toBe(true);
  });

  it("canvas 115 的第二级：252 → 184，少 68 个（占 27%），同样拦住", () => {
    const current = Array.from({ length: 252 }, (_, i) => node(`n${i}`));
    const result = run({
      currentNodes: current,
      incomingNodes: current.slice(0, 184),
      baseNodeKeys: new Set(current.map((entry) => entry.nodeKey)),
      declaresDeletions: false,
    });

    expect(result.nodes).toHaveLength(252);
    expect(result.burst).toBe(true);
  });

  it("大画布上框选删 30 个是正常操作，放行", () => {
    const current = Array.from({ length: 252 }, (_, i) => node(`n${i}`));
    const result = run({
      currentNodes: current,
      incomingNodes: current.slice(0, 222),
      baseNodeKeys: new Set(current.map((entry) => entry.nodeKey)),
      declaresDeletions: false,
    });

    expect(result.nodes).toHaveLength(222);
    expect(result.allowedKeys).toHaveLength(30);
    expect(result.burst).toBe(false);
  });

  // 这条不是"期望的功能"，是如实记下取舍：下限 5 意味着 ≤25 节点的小画布挡不住，
  // 一次可以清空。丢的是个位数节点，且删除前的状态在 canvas_revisions、每个删除都
  // 写了带完整快照的 delete 事件，捞得回来；相比之下把使用者的删除功能锁死更糟。
  // 真正堵上这个口子要靠客户端显式声明删除（delete-v2），不是靠调这里的数字。
  it("小画布（≤25 节点）挡不住整体清空——已知取舍，不是修好了", () => {
    const result = run({
      currentNodes: [node("a"), node("b"), node("c")],
      incomingNodes: [],
      baseNodeKeys: new Set(["a", "b", "c"]),
      declaresDeletions: false,
    });

    expect(result.nodes).toEqual([]);
    expect(result.burst).toBe(false);
  });

  it("上限按画布规模算，不是拍死的一个数", () => {
    expect(inferredDeleteLimit(252)).toBe(30); // 20% = 50，收到上限 30
    expect(inferredDeleteLimit(76)).toBe(15);
    expect(inferredDeleteLimit(40)).toBe(8);
    expect(inferredDeleteLimit(20)).toBe(5); // 20% = 4，抬到下限 5
    expect(inferredDeleteLimit(0)).toBe(5);
  });
});

describe("拿不到基准版本时退回最保守行为", () => {
  it("baseNodeKeys 为 null → 缺失一律保留", () => {
    const result = run({
      currentNodes: [node("a"), node("b")],
      incomingNodes: [node("a")],
      baseNodeKeys: null,
      declaresDeletions: false,
    });

    expect(keys(result.nodes)).toEqual(["a", "b"]);
    expect(result.rescuedKeys).toEqual(["b"]);
    expect(result.strict).toBe(true);
  });
});

/**
 * 保存冲突（409）时的删除。这是"一半情况删不掉"的真正来源：
 * /nodes/batch 判定冲突就 return 409，整个保存被丢掉，删除跟着作废；而这些画布常常
 * 长时间卡在自锁的冲突环里（基准过期 → 冲突 → 409 → isDirty 恒真 → 前端拒绝 syncProject
 * → 基准永不更新），期间每一次删除都白删。
 */
describe("保存冲突时，跟冲突无关的删除仍要执行", () => {
  const nodes = (...names: string[]) => names.map(node);

  it("冲突在别的节点上，用户删的那个照样删掉", () => {
    const result = conflictSafeDeletions({
      baseNodes: nodes("a", "b", "c"),
      incomingNodes: nodes("a", "b"),        // 用户删了 c
      currentNodes: nodes("a", "b", "c"),
      conflictNodeKeys: ["a"],               // 冲突在 a
    });

    expect(result.appliedKeys).toEqual(["c"]);
    expect(result.overLimit).toBe(false);
  });

  it("冲突节点自己不许被删：服务端有更新的版本", () => {
    const result = conflictSafeDeletions({
      baseNodes: nodes("a", "b", "c"),
      incomingNodes: nodes("a", "b"),
      currentNodes: nodes("a", "b", "c"),
      conflictNodeKeys: ["c"],               // 用户想删的正是冲突节点
    });

    expect(result.droppedKeys).toEqual([]);
    expect(result.appliedKeys).toEqual([]);
  });

  it("基准里没有的节点不算用户删的，不动它", () => {
    const result = conflictSafeDeletions({
      baseNodes: nodes("a", "b"),
      incomingNodes: nodes("a", "b"),
      currentNodes: nodes("a", "b", "gen-1"), // gen-1 是保存期间服务端写进来的
      conflictNodeKeys: [],
    });

    expect(result.appliedKeys).toEqual([]);
  });

  it("服务端已经删掉的节点不重复删", () => {
    const result = conflictSafeDeletions({
      baseNodes: nodes("a", "b", "c"),
      incomingNodes: nodes("a", "b"),
      currentNodes: nodes("a", "b"),          // c 已经不在服务端了
      conflictNodeKeys: [],
    });

    expect(result.appliedKeys).toEqual([]);
  });

  it("一次去掉一大片，冲突路径上同样不执行", () => {
    const base = Array.from({ length: 60 }, (_, i) => node(`n${i}`));
    const result = conflictSafeDeletions({
      baseNodes: base,
      incomingNodes: base.slice(0, 10),
      currentNodes: base,
      conflictNodeKeys: [],
    });

    expect(result.droppedKeys).toHaveLength(50);
    expect(result.appliedKeys).toEqual([]);
    expect(result.overLimit).toBe(true);
  });
});

describe("新客户端：删除走 delete-v2，整表保存里缺失一律不算删除", () => {
  it("带了 deletedNodeKeys 字段就切严格档，未声明的缺失全部保留", () => {
    const result = run({
      currentNodes: [node("a"), node("b"), node("c")],
      incomingNodes: [node("a")],
      declaredDeletedKeys: [],
      baseNodeKeys: new Set(["a", "b", "c"]),
      declaresDeletions: true,
    });

    expect(keys(result.nodes)).toEqual(["a", "b", "c"]);
    expect(result.rescuedKeys.sort()).toEqual(["b", "c"]);
    expect(result.strict).toBe(true);
  });

  it("显式声明的可以一次删多个，不受断路器限制", () => {
    const result = run({
      currentNodes: [node("a"), node("b"), node("c"), node("d")],
      incomingNodes: [node("a")],
      declaredDeletedKeys: ["b", "c", "d"],
      baseNodeKeys: new Set(["a", "b", "c", "d"]),
      declaresDeletions: true,
    });

    expect(keys(result.nodes)).toEqual(["a"]);
    expect(result.rescuedKeys).toEqual([]);
  });
});
