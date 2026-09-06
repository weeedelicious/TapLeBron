/**
 * 「派生出来的节点没连线」的回归测试。
 *
 * 现象（2026-08-18 用户反馈）：细化纹理生成好、派生出新图片节点，但那条线不出现，
 * 刷新一下才有。根因：addNodeAt 只 set nodes、没重算 edges，而画布的边是
 * edgesFromNodeReferences 从 params 里的 nodeId 引用推导出来的 —— loadProject 会推，
 * addNodeAt 不推，于是「数据对、视图缺」。
 *
 * 这里锁死两条：
 *   1. addNodeAt 带着引用建节点时，那条边必须当场就在；
 *   2. 已有的边不许被这次重算弄丢。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  nodesApi: {
    upsert: vi.fn(async () => ({ ok: true, nodeVersion: 1, contentVersion: "cv" })),
    deleteNode: vi.fn(async () => ({ ok: true, deleted: true })),
    delete: vi.fn(async () => ({ data: { contentVersion: "cv" } })),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  CANVAS_CLIENT_ID: "test-client",
}));

const { useCanvasStore } = await import("@/store/canvasStore");

function reset() {
  // projectUuid 留空：不去触发落库，只看内存里的 nodes / edges
  useCanvasStore.setState({ nodes: [], edges: [], projectUuid: "" });
}

describe("addNodeAt 的引用连线", () => {
  it("带 imageList 引用建节点时，边当场就在（不用刷新）", () => {
    reset();
    const source = useCanvasStore.getState().addNodeAt("image", 0, 0);
    expect(useCanvasStore.getState().edges).toHaveLength(0);

    const derived = useCanvasStore.getState().addNodeAt("image", 700, 0, {
      name: "细化纹理_0001",
      url: ["/assets/1/fused.png"],
      params: {
        imageList: [{ nodeId: source.id, url: "/assets/1/source.png" }],
      } as unknown as Record<string, unknown>,
    });

    const { edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(source.id);
    expect(edges[0].target).toBe(derived.id);
  });

  it("不会弄丢已经存在的边", () => {
    reset();
    const a = useCanvasStore.getState().addNodeAt("image", 0, 0);
    const b = useCanvasStore.getState().addNodeAt("image", 700, 0, {
      params: { imageList: [{ nodeId: a.id, url: "/x.png" }] } as unknown as Record<string, unknown>,
    });
    expect(useCanvasStore.getState().edges).toHaveLength(1);

    // 再加一个毫无引用的节点：原来那条边必须还在
    useCanvasStore.getState().addNodeAt("text", 0, 400);
    const { edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(a.id);
    expect(edges[0].target).toBe(b.id);
  });

  it("同一多视频节点占视频对比多个槽时，只建具名槽边、不从 videoList 再造一根", () => {
    reset();
    const source = useCanvasStore.getState().addNodeAt("video", 0, 0, {
      url: ["/a.mp4", "/b.mp4", "/c.mp4"],
    });
    const compare = useCanvasStore.getState().addNodeAt("video_compare", 700, 0, {
      params: {
        compareRefA: { nodeId: source.id, url: "/a.mp4", name: "视频节点 1" },
        compareRefB: { nodeId: source.id, url: "/b.mp4", name: "视频节点 1" },
        compareRefC: { nodeId: source.id, url: "/c.mp4", name: "视频节点 1" },
        compareRefD: null,
        compareMode: "quad",
        videoList: [{ nodeId: source.id, url: "/a.mp4" }],
      } as unknown as Record<string, unknown>,
    });
    const between = useCanvasStore.getState().edges.filter(
      (edge) => edge.source === source.id && edge.target === compare.id,
    );
    expect(between).toHaveLength(3);
    expect(between.map((edge) => edge.targetHandle).sort()).toEqual([
      "compare-a",
      "compare-b",
      "compare-c",
    ]);
  });

  it("视频对比上没 handle 的旧线会被丢掉，只留还连着的具名槽", () => {
    reset();
    const source = useCanvasStore.getState().addNodeAt("video", 0, 0, {
      url: ["/a.mp4", "/b.mp4"],
    });
    const compare = useCanvasStore.getState().addNodeAt("video_compare", 700, 0, {
      params: {
        compareRefA: { nodeId: source.id, url: "/a.mp4", name: "视频节点 1" },
        compareRefB: { nodeId: source.id, url: "/b.mp4", name: "视频节点 1" },
        compareRefC: null,
        compareRefD: null,
      } as unknown as Record<string, unknown>,
    });
    useCanvasStore.getState().setEdges([
      {
        id: `e-${source.id}-${compare.id}`,
        source: source.id,
        target: compare.id,
        type: "glow",
      },
      {
        id: `e-${source.id}-${compare.id}-compare-a`,
        source: source.id,
        target: compare.id,
        targetHandle: "compare-a",
        type: "glow",
      },
      {
        id: `e-${source.id}-${compare.id}-compare-b`,
        source: source.id,
        target: compare.id,
        targetHandle: "compare-b",
        type: "glow",
      },
    ]);
    useCanvasStore.getState().addNodeAt("text", 0, 400);
    const between = useCanvasStore.getState().edges.filter(
      (edge) => edge.source === source.id && edge.target === compare.id,
    );
    expect(between).toHaveLength(2);
    expect(between.every((edge) => Boolean(edge.targetHandle))).toBe(true);
  });

  it("引用的节点不存在时不造边（别凭空连到空气上）", () => {
    reset();
    useCanvasStore.getState().addNodeAt("image", 0, 0, {
      params: { imageList: [{ nodeId: "不存在的节点", url: "/x.png" }] } as unknown as Record<string, unknown>,
    });
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it("带 contentWidth / contentHeight 建节点时，测量尺寸当场就是它（不要先撑成 620×350）", () => {
    reset();
    const node = useCanvasStore.getState().addNodeAt("image", 0, 0, {
      contentWidth: 520,
      contentHeight: 293,
    });
    expect(node.measured).toEqual({ width: 520, height: 293 });
    expect(node.data.contentWidth).toBe(520);
    expect(node.data.contentHeight).toBe(293);
  });

  it("不带尺寸的普通图片节点仍是 620×350（别把默认也改了）", () => {
    reset();
    const node = useCanvasStore.getState().addNodeAt("image", 0, 0);
    expect(node.measured).toEqual({ width: 620, height: 350 });
  });
});
