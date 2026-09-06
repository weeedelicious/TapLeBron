/**
 * 三维空间节点和参考图之间那根线，刷新之后必须还在（2026-08-26 用户反馈「刷新就断掉」）。
 *
 * 根因：这个画布的边**从不单独存库**，`edgesFromNodeReferences(nodes)` 每次从节点数据
 * 重新推导。它认两类来源：
 *   ① 扁平引用列表（imageList / videoList / …）—— 通用循环处理；
 *   ② 绑在具名槽上的单个引用 —— 氛围迁移、全景查看器、图片对比各有一个特例块。
 *
 * 参考图存在 `params.stageRef`（属于第 ② 类），但我加它的时候漏了那个特例块。
 * 结果是「数据对、视图缺」：引用还在、分析照样能用，但刷新后画布上看不出连着谁。
 *
 * 所以这里测的是**推导**这一步，而不是「连线那一刻」——
 * 连线那一刻本来就是对的（那是 setEdges 直接塞进去的），坏的是重建。
 */
import { describe, expect, it, vi } from "vitest";

// canvasStore 顶层会 import api；这里只用它的纯推导函数，把网络那层挡掉
vi.mock("@/lib/api", () => ({
  nodesApi: {
    upsert: vi.fn(),
    deleteNode: vi.fn(),
    delete: vi.fn(),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  CANVAS_CLIENT_ID: "test-client",
}));

const { edgesFromNodeReferences } = await import("@/store/canvasStore");

type AnyNode = Record<string, unknown>;

const imageNode = (id: string): AnyNode => ({
  id,
  type: "image",
  position: { x: 0, y: 0 },
  data: {
    nodeKey: id,
    type: "image",
    name: "参考图",
    url: ["/assets/9/ref.png"],
    _primaryAssetUrl: "/assets/9/ref.png",
    params: {},
  },
});

const stageNode = (id: string, stageRef: unknown): AnyNode => ({
  id,
  type: "director_stage",
  position: { x: 600, y: 0 },
  data: {
    nodeKey: id,
    type: "director_stage",
    name: "三维空间 1",
    params: stageRef === undefined ? {} : { stageRef },
  },
});

/**
 * 模拟一次刷新：只有节点、**没有任何已存在的边**，让推导函数自己算。
 * 这正是 loadProject 走的那条路（边从不存库，每次从节点数据重建）。
 *
 * 注意不能用 `setNodes` 来模拟 —— 它只 set nodes、不重算边，
 * 所以从那个入口测什么都测不出来。
 */
function afterReload(nodes: AnyNode[]) {
  return edgesFromNodeReferences(nodes as never);
}

describe("刷新后参考图这根线要重建出来", () => {
  it("★ 按 nodeId 引用时，线在", () => {
    const edges = afterReload([
      imageNode("img-1"),
      stageNode("stage-1", { nodeId: "img-1", url: "/assets/9/ref.png", name: "参考图" }),
    ]);
    const edge = edges.find((e) => e.source === "img-1" && e.target === "stage-1");
    expect(edge, `推导出来的边：${JSON.stringify(edges)}`).toBeTruthy();
    expect(edge?.type).toBe("glow");
    expect(edge?.selectable).toBe(true);
  });

  it("★ 按 nodeKey 引用也行（服务端回来的引用常是 nodeKey）", () => {
    const image = imageNode("img-1") as { id: string; data: Record<string, unknown> };
    image.id = "flow-abc";
    image.data.nodeKey = "server-key-1";
    const edges = afterReload([
      image,
      stageNode("stage-1", { nodeId: "server-key-1" }),
    ]);
    expect(edges.some((e) => e.source === "flow-abc" && e.target === "stage-1")).toBe(true);
  });

  it("没连参考图时不凭空造边", () => {
    expect(afterReload([imageNode("img-1"), stageNode("stage-1", undefined)])).toEqual([]);
    expect(afterReload([imageNode("img-1"), stageNode("stage-1", null)])).toEqual([]);
    expect(afterReload([imageNode("img-1"), stageNode("stage-1", {})])).toEqual([]);
  });

  it("上游节点已经不在了 → 不造一根指向空气的边", () => {
    const edges = afterReload([stageNode("stage-1", { nodeId: "已删除的节点" })]);
    expect(edges).toEqual([]);
  });

  it("引用指向自己时不造自环", () => {
    expect(afterReload([stageNode("stage-1", { nodeId: "stage-1" })])).toEqual([]);
  });

  it("★ 不会重复画两根（重算多次也只有一根）", () => {
    const nodes = [
      imageNode("img-1"),
      stageNode("stage-1", { nodeId: "img-1" }),
    ] as never;
    // 把上一轮的结果当成 existingEdges 再算一遍（syncProject 就是这么调的）
    let edges = edgesFromNodeReferences(nodes);
    edges = edgesFromNodeReferences(nodes, edges);
    edges = edgesFromNodeReferences(nodes, edges);
    const between = edges.filter((e) => e.source === "img-1" && e.target === "stage-1");
    expect(between.length).toBe(1);
  });

  it("出图那一边（三维空间 → 图片节点）刷新后也还在", () => {
    // 出图新建的图片节点把上游记在 params.imageList 里，走通用循环重建
    const render = imageNode("render-1") as { data: Record<string, unknown> };
    render.data.params = { imageList: [{ nodeId: "stage-1", url: "/assets/9/out.png", mediaType: "image" }] };
    const edges = afterReload([stageNode("stage-1", { nodeId: "img-1" }), imageNode("img-1"), render as AnyNode]);
    expect(edges.some((e) => e.source === "stage-1" && e.target === "render-1")).toBe(true);
    // 两根线同时存在：参考图进、出图出
    expect(edges.some((e) => e.source === "img-1" && e.target === "stage-1")).toBe(true);
  });

  it("★ 同一对节点已经有一条别的 id 的边时，不再叠第二根", () => {
    /*
     * 真实场景：这两个节点之间可能已经存在一条**不同 id** 的边 —— 比如旧数据里
     * 走 imageList 连的（通用循环建的 id 没有 `-stage-reference` 后缀），
     * 或者刚连完线还没刷新时 applyConnection 塞进去的那根。
     * 判重只比 id 的话就会画出两根重叠的线，看着像坏了、还得删两次。
     */
    const edges = edgesFromNodeReferences(
      [imageNode("img-1"), stageNode("stage-1", { nodeId: "img-1" })] as never,
      [{ id: "e-img-1-stage-1", source: "img-1", target: "stage-1", type: "glow" } as never],
    );
    const between = edges.filter((e) => e.source === "img-1" && e.target === "stage-1");
    expect(between.length, `画了 ${between.length} 根：${JSON.stringify(between.map((e) => e.id))}`).toBe(1);
  });

  it("已有的边不会被这次重算弄丢", () => {
    const edges = edgesFromNodeReferences(
      [imageNode("img-1"), stageNode("stage-1", { nodeId: "img-1" })] as never,
      [{ id: "keep-me", source: "a", target: "b", type: "glow" } as never],
    );
    expect(edges.some((e) => e.id === "keep-me")).toBe(true);
    expect(edges.some((e) => e.source === "img-1" && e.target === "stage-1")).toBe(true);
  });
});

/*
 * 别的具名槽引用（氛围迁移 / 全景 / 图片对比）都各有一个重建块。
 * 这条断言盯住「又加了一种具名槽引用却忘了写重建块」这件事 ——
 * 三维空间就是这么漏的，同样的坑不该踩第二次。
 */
describe("每一种具名槽引用都有对应的重建块", () => {
  it("stageRef / panoramaRef / compareRefA / compareRefB / sourceRef / referenceRef 都在推导函数里出现", async () => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const source = (fs.readFileSync(
      path.join(__dirname, "..", "src/canvas/store/canvasStore.ts"),
      "utf8",
    ) as string).replace(/\r\n/g, "\n");
    const fn = source.slice(
      source.indexOf("function edgesFromNodeReferences"),
      source.indexOf("\n  return nextEdges;\n}"),
    );
    expect(fn.length, "找不到 edgesFromNodeReferences 函数体").toBeGreaterThan(500);
    for (const refKey of ["params.stageRef", "params.panoramaRef", "params.compareRefA", "params.compareRefB", "params.sourceRef", "params.referenceRef"]) {
      expect(fn, `${refKey} 没有重建块 —— 刷新后那根线会消失`).toContain(refKey);
    }
  });
});
