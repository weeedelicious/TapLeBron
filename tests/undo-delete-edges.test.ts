/**
 * 删除节点后按 Z 撤销，进出这个节点的连线要立刻回来（2026-11-05 用户反馈「刷新才出现」）。
 *
 * React Flow 按删除键时先触发 onEdgesChange（删线、清下游引用），再触发 onNodesChange（删节点），
 * 两边都会 pushHistory。第二张快照里线和下游引用都已经没了，撤销回到它就只回来节点。
 * 修法：同一轮事件里只记第一张快照；撤销时按节点数据重算连线。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  nodesApi: {
    upsert: vi.fn(async () => ({ ok: true })),
    deleteNode: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    batchSave: vi.fn(async () => ({ ok: true })),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  assetsApi: { copyToProject: vi.fn(), videoVariants: vi.fn() },
  CANVAS_CLIENT_ID: "test-client",
}));

const { useCanvasStore, edgesFromNodeReferences } = await import("@/store/canvasStore");

function node(id: string, type: string, params: Record<string, unknown> = {}) {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { type, name: id, nodeKey: id, projectUuid: "", url: [], action: "image_resource", params },
  } as any;
}

describe("删除节点后撤销", () => {
  it("进出被删节点的连线立刻回来", () => {
    const nodes = [
      node("src", "video"),
      node("mask", "ui_mask", { videoList: [{ nodeId: "src", url: "/a.mp4", mediaType: "video" }] }),
      node("out", "video", { uiMaskSourceRef: { nodeId: "mask" } }),
    ];
    // 和 loadProject 一样：历史里先放一张打开画布时的快照
    const initial = { nodes: JSON.parse(JSON.stringify(nodes)), edges: edgesFromNodeReferences(nodes) };
    useCanvasStore.setState({ nodes, edges: edgesFromNodeReferences(nodes), history: [initial], historyIndex: 0, projectUuid: null } as any);
    const pairs = () => useCanvasStore.getState().edges.map((e) => `${e.source}->${e.target}`).sort();
    expect(pairs()).toEqual(["mask->out", "src->mask"]);

    // 和 React Flow 删除键同一顺序、同一轮事件：先删线（清下游引用），再删节点
    const store = useCanvasStore.getState();
    store.pushHistory();
    const stripped = useCanvasStore.getState().nodes.map((n) =>
      n.id === "out" ? { ...n, data: { ...n.data, params: { uiMaskSourceRef: null } } } : n,
    );
    useCanvasStore.setState({ nodes: stripped, edges: [] } as any);
    useCanvasStore.getState().pushHistory();
    useCanvasStore.setState({ nodes: useCanvasStore.getState().nodes.filter((n) => n.id !== "mask") } as any);

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.map((n) => n.id).sort()).toEqual(["mask", "out", "src"]);
    expect(pairs()).toEqual(["mask->out", "src->mask"]);
  });

  it("快照里少了线，撤销时按节点数据补回来", async () => {
    await Promise.resolve();
    const nodes = [
      node("a", "video"),
      node("b", "image", { videoList: [{ nodeId: "a", url: "/a.mp4", mediaType: "video" }] }),
    ];
    useCanvasStore.setState({ nodes, edges: [], history: [{ nodes, edges: [] }, { nodes, edges: [] }], historyIndex: 1, projectUuid: null } as any);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().edges.map((e) => `${e.source}->${e.target}`)).toEqual(["a->b"]);
  });
});
