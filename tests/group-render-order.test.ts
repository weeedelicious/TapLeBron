import { describe, expect, it } from "vitest";
import {
  hoistGroupNodesForRender,
  needsGroupHoist,
} from "../src/canvas/lib/groupRenderOrder";

type N = { id: string; type: string };

const n = (id: string, type = "image"): N => ({ id, type });
const g = (id: string): N => ({ id, type: "group" });

describe("分组节点渲染顺序", () => {
  it("组已经在最前面时原样返回同一个数组（不制造新引用）", () => {
    const nodes = [g("G"), n("a"), n("b")];
    expect(needsGroupHoist(nodes)).toBe(false);
    expect(hoistGroupNodesForRender(nodes)).toBe(nodes);
  });

  it("组被追加到末尾时提到前面 —— 这就是组盖住子节点的那种顺序", () => {
    const nodes = [n("a"), n("b"), g("G")];
    expect(needsGroupHoist(nodes)).toBe(true);
    expect(hoistGroupNodesForRender(nodes).map((node) => node.id)).toEqual([
      "G",
      "a",
      "b",
    ]);
  });

  it("组夹在中间也算需要提前", () => {
    const nodes = [n("a"), g("G"), n("b")];
    expect(needsGroupHoist(nodes)).toBe(true);
    expect(hoistGroupNodesForRender(nodes).map((node) => node.id)).toEqual([
      "G",
      "a",
      "b",
    ]);
  });

  it("多个组之间的相对顺序不变（嵌套组的内外层关系靠这个保持）", () => {
    const nodes = [g("outer"), n("a"), g("inner"), n("b"), g("third")];
    expect(hoistGroupNodesForRender(nodes).map((node) => node.id)).toEqual([
      "outer",
      "inner",
      "third",
      "a",
      "b",
    ]);
  });

  it("非组节点之间的相对顺序不变", () => {
    const nodes = [n("a"), n("b"), n("c"), g("G")];
    expect(hoistGroupNodesForRender(nodes).map((node) => node.id)).toEqual([
      "G",
      "a",
      "b",
      "c",
    ]);
  });

  it("节点数量不变、一个都不丢", () => {
    const nodes = [n("a"), g("G1"), n("b"), g("G2"), n("c")];
    const out = hoistGroupNodesForRender(nodes);
    expect(out).toHaveLength(nodes.length);
    expect(new Set(out.map((node) => node.id))).toEqual(
      new Set(nodes.map((node) => node.id)),
    );
  });

  it("空数组和全是组的数组都不炸", () => {
    expect(hoistGroupNodesForRender([])).toEqual([]);
    const onlyGroups = [g("G1"), g("G2")];
    expect(hoistGroupNodesForRender(onlyGroups)).toBe(onlyGroups);
  });
});
