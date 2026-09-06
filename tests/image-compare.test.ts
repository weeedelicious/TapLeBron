/**
 * 图片对比节点的规则测试。
 *
 * 交接包（D:\SH\Infinite-Canvas-Image-Compare-Handoff-2026-08-14）要求把风险边界用测试
 * 钉死：类型判定、允许的源、A/B 槽位身份、同源去重、输入解析、持久化往返。
 *
 * Shotflow 特有的风险点是最后一条：这个工程的连线**从不持久化**，边是从节点 params 里的
 * 引用实时推导的。所以 A/B 的身份必须能扛过"保存 → 重新加载 → 重新推导边"这一圈，
 * 否则刷新之后对比节点的两条连线就没了。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNodeData, Project } from "@/lib/types";
import {
  IMAGE_COMPARE_HANDLE_A,
  IMAGE_COMPARE_HANDLE_B,
  IMAGE_COMPARE_MODE_LABELS,
  canBeImageCompareSource,
  imageCompareSizeMismatch,
  clearedImageCompareRefs,
  compareRefFromNode,
  isImageCompareNodeData,
  normalizeImageCompareMode,
  planImageCompareAssignment,
  readImageCompareRefs,
  resolveImageCompareHandle,
  resolveImageCompareInputs,
} from "@/features/image-compare/image-compare";
import {
  STITCH_DEFAULT_DIVIDER_WIDTH,
  isReversedStitch,
  isVerticalStitch,
  normalizeStitchDirection,
  stitchDirectionFromView,
  stitchFileName,
  stitchLayout,
} from "@/features/image-compare/image-compare-stitch";

vi.mock("@/lib/api", () => ({
  nodesApi: {
    upsert: vi.fn(async () => ({ ok: true, nodeVersion: 1, contentVersion: "cv" })),
    deleteNode: vi.fn(),
    delete: vi.fn(),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  CANVAS_CLIENT_ID: "test-client",
}));

const { useCanvasStore } = await import("@/store/canvasStore");

const UUID = "900";

function imageData(name: string, url = "/assets/900/a.png"): CanvasNodeData {
  return {
    type: "image",
    name,
    url: [url],
    action: "image_resource",
    _resourceMeta: { items: [{ kind: "image", originalUrl: url, width: 1024, height: 768 }] },
  } as unknown as CanvasNodeData;
}

function compareData(
  params: Record<string, unknown> = { compareRefA: null, compareRefB: null },
): CanvasNodeData {
  return {
    type: "image_compare",
    name: "图片对比",
    url: [],
    action: "image_compare",
    params,
  } as unknown as CanvasNodeData;
}

describe("类型与模式", () => {
  it("认得出对比节点", () => {
    expect(isImageCompareNodeData(compareData())).toBe(true);
    expect(isImageCompareNodeData(imageData("图"))).toBe(false);
    expect(isImageCompareNodeData(null)).toBe(false);
  });

  it("模式归一化，脏值退回左右对比", () => {
    expect(normalizeImageCompareMode("wipe")).toBe("wipe");
    expect(normalizeImageCompareMode("opacity")).toBe("opacity");
    expect(normalizeImageCompareMode("difference")).toBe("difference");
    expect(normalizeImageCompareMode("side-by-side")).toBe("side-by-side");
    expect(normalizeImageCompareMode(undefined)).toBe("side-by-side");
    expect(normalizeImageCompareMode("垃圾值")).toBe("side-by-side");
  });

  it("上下模式也认", () => {
    expect(normalizeImageCompareMode("top-bottom")).toBe("top-bottom");
  });

  it("五种模式都有中文标签", () => {
    for (const mode of [
      "side-by-side",
      "top-bottom",
      "wipe",
      "opacity",
      "difference",
    ] as const) {
      expect(IMAGE_COMPARE_MODE_LABELS[mode]).toBeTruthy();
    }
  });
});

describe("拼接排版", () => {
  it("同高的两张图：宽度相加，中间留分隔线", () => {
    const layout = stitchLayout(
      { width: 800, height: 600 },
      { width: 400, height: 600 },
    );
    expect(layout).toMatchObject({
      canvasHeight: 600,
      canvasWidth: 800 + STITCH_DEFAULT_DIVIDER_WIDTH + 400,
      a: { x: 0, y: 0, width: 800, height: 600 },
      b: { x: 800 + STITCH_DEFAULT_DIVIDER_WIDTH, y: 0, width: 400, height: 600 },
    });
  });

  it("默认不插分隔线：输出尺寸就是两张图之和，一个像素都不多", () => {
    expect(STITCH_DEFAULT_DIVIDER_WIDTH).toBe(0);
    const layout = stitchLayout(
      { width: 248, height: 399 },
      { width: 248, height: 399 },
    );
    // 之前默认给 2px 分隔线，这里会算出 498 —— 用户对不上账的就是这 2 像素
    expect(layout?.canvasWidth).toBe(496);
    expect(layout?.canvasHeight).toBe(399);
    expect(layout?.a).toMatchObject({ x: 0, width: 248 });
    expect(layout?.b).toMatchObject({ x: 248, width: 248 });
    expect(layout?.divider.width).toBe(0);
  });

  it("上下方向同理：高度就是两张之和", () => {
    const layout = stitchLayout(
      { width: 400, height: 300 },
      { width: 400, height: 500 },
      { direction: "tb" },
    );
    expect(layout?.canvasWidth).toBe(400);
    expect(layout?.canvasHeight).toBe(800);
    expect(layout?.b).toMatchObject({ y: 300 });
  });

  it("显式要分隔线时才会占尺寸", () => {
    const layout = stitchLayout(
      { width: 248, height: 399 },
      { width: 248, height: 399 },
      { dividerWidth: 2 },
    );
    expect(layout?.canvasWidth).toBe(498);
    expect(layout?.divider).toMatchObject({ x: 248, width: 2 });
  });

  it("不同高：按较大的高度对齐，各自保持比例", () => {
    const layout = stitchLayout(
      { width: 1000, height: 500 }, // 2:1
      { width: 500, height: 1000 }, // 1:2
    );
    expect(layout?.canvasHeight).toBe(1000);
    expect(layout?.a).toMatchObject({ width: 2000, height: 1000 }); // 放大到同高
    expect(layout?.b).toMatchObject({ width: 500, height: 1000 });
    expect(layout?.canvasWidth).toBe(2000 + STITCH_DEFAULT_DIVIDER_WIDTH + 500);
  });

  it("超高的图会被限制在上限内，比例不变", () => {
    const layout = stitchLayout(
      { width: 10000, height: 10000 },
      { width: 5000, height: 10000 },
      { maxHeight: 4096 },
    );
    expect(layout?.canvasHeight).toBe(4096);
    expect(layout?.a).toMatchObject({ width: 4096 });
    expect(layout?.b).toMatchObject({ width: 2048 });
  });

  it("尺寸缺失时返回 null，而不是算出 NaN 画布", () => {
    expect(stitchLayout({ width: 0, height: 100 }, { width: 10, height: 10 })).toBeNull();
    expect(
      stitchLayout(
        { width: 10, height: 10 },
        { width: Number.NaN, height: 10 },
      ),
    ).toBeNull();
  });

  it("文件名去掉非法字符并截断，带上方向", () => {
    expect(stitchFileName("角色/定妆:v2", "三视图")).toBe(
      "对比拼接左右_角色定妆v2_三视图.png",
    );
    expect(stitchFileName("", "")).toBe("对比拼接左右_图片_图片.png");
    expect(
      stitchFileName("这个名字非常非常非常非常非常非常长会被截断掉一部分", "b"),
    ).toMatch(/^对比拼接左右_.{1,24}_b\.png$/);
  });

  it("反向时文件名里的顺序也跟着换", () => {
    expect(stitchFileName("甲", "乙", "rl")).toBe("对比拼接右左_乙_甲.png");
    expect(stitchFileName("甲", "乙", "bt")).toBe("对比拼接下上_乙_甲.png");
    expect(stitchFileName("甲", "乙", "tb")).toBe("对比拼接上下_甲_乙.png");
  });
});

describe("拼接方向", () => {
  it("方向归一化，脏值退回左右", () => {
    for (const d of ["lr", "rl", "tb", "bt"] as const) {
      expect(normalizeStitchDirection(d)).toBe(d);
    }
    expect(normalizeStitchDirection("垃圾")).toBe("lr");
    expect(normalizeStitchDirection(undefined)).toBe("lr");
  });

  it("哪些是纵向、哪些是反序", () => {
    expect(isVerticalStitch("tb")).toBe(true);
    expect(isVerticalStitch("bt")).toBe(true);
    expect(isVerticalStitch("lr")).toBe(false);
    expect(isReversedStitch("rl")).toBe(true);
    expect(isReversedStitch("bt")).toBe(true);
    expect(isReversedStitch("lr")).toBe(false);
    expect(isReversedStitch("tb")).toBe(false);
  });

  it("右左：B 排在左边，A 排在右边", () => {
    const layout = stitchLayout(
      { width: 800, height: 600 },
      { width: 400, height: 600 },
      { direction: "rl" },
    );
    expect(layout?.b).toMatchObject({ x: 0, width: 400 });
    expect(layout?.a).toMatchObject({ x: 400 + STITCH_DEFAULT_DIVIDER_WIDTH, width: 800 });
    expect(layout?.canvasWidth).toBe(400 + STITCH_DEFAULT_DIVIDER_WIDTH + 800);
    expect(layout?.canvasHeight).toBe(600);
  });

  it("上下：按同一宽度对齐，竖着排，分隔线是横的", () => {
    const layout = stitchLayout(
      { width: 800, height: 600 },
      { width: 400, height: 400 },
      { direction: "tb" },
    );
    expect(layout?.canvasWidth).toBe(800);
    expect(layout?.a).toMatchObject({ x: 0, y: 0, width: 800, height: 600 });
    expect(layout?.b).toMatchObject({
      x: 0,
      y: 600 + STITCH_DEFAULT_DIVIDER_WIDTH,
      width: 800,
      height: 800,
    });
    expect(layout?.divider).toMatchObject({
      x: 0,
      y: 600,
      width: 800,
      height: STITCH_DEFAULT_DIVIDER_WIDTH,
    });
    expect(layout?.canvasHeight).toBe(600 + STITCH_DEFAULT_DIVIDER_WIDTH + 800);
  });

  it("下上：B 排在上面", () => {
    const layout = stitchLayout(
      { width: 800, height: 600 },
      { width: 800, height: 300 },
      { direction: "bt" },
    );
    expect(layout?.b).toMatchObject({ y: 0, height: 300 });
    expect(layout?.a).toMatchObject({ y: 300 + STITCH_DEFAULT_DIVIDER_WIDTH, height: 600 });
  });

  it("纵向时上限管的是宽度", () => {
    const layout = stitchLayout(
      { width: 10000, height: 5000 },
      { width: 10000, height: 5000 },
      { direction: "tb", maxHeight: 4096 },
    );
    expect(layout?.canvasWidth).toBe(4096);
    expect(layout?.a).toMatchObject({ height: 2048 });
  });
});

/**
 * 导出不再让人选方向：弹窗什么摆放就导出什么摆放。
 */
describe("导出方向跟着弹窗当前摆放", () => {
  it("左右并排 → 左右；交换过 → 右左", () => {
    expect(stitchDirectionFromView({ mode: "side-by-side" })).toBe("lr");
    expect(stitchDirectionFromView({ mode: "side-by-side", swapped: true })).toBe("rl");
  });

  it("上下并排 → 上下；交换过 → 下上", () => {
    expect(stitchDirectionFromView({ mode: "top-bottom" })).toBe("tb");
    expect(stitchDirectionFromView({ mode: "top-bottom", swapped: true })).toBe("bt");
  });

  it("滑杆模式跟着它自己的横竖开关", () => {
    expect(stitchDirectionFromView({ mode: "wipe" })).toBe("lr");
    expect(stitchDirectionFromView({ mode: "wipe", wipeVertical: true })).toBe("tb");
    expect(
      stitchDirectionFromView({ mode: "wipe", wipeVertical: true, swapped: true }),
    ).toBe("bt");
  });

  it("透明度 / 差异是两图重叠、没有方位，按横向出", () => {
    expect(stitchDirectionFromView({ mode: "opacity" })).toBe("lr");
    expect(stitchDirectionFromView({ mode: "difference" })).toBe("lr");
    expect(stitchDirectionFromView({ mode: "difference", swapped: true })).toBe("rl");
  });
});

describe("尺寸不一致提示", () => {
  const withSize = (w: number, h: number) => ({
    nodeId: "n",
    title: "图",
    previewUrl: "/p.png",
    fullUrl: "/p.png",
    width: w,
    height: h,
  });

  it("尺寸不同要报", () => {
    expect(imageCompareSizeMismatch(withSize(1024, 768), withSize(800, 600))).toBe(true);
    expect(imageCompareSizeMismatch(withSize(1024, 768), withSize(1024, 600))).toBe(true);
  });

  it("尺寸相同不报", () => {
    expect(imageCompareSizeMismatch(withSize(1024, 768), withSize(1024, 768))).toBe(false);
  });

  it("尺寸未知时不乱报（宁可不提示也别误报）", () => {
    expect(imageCompareSizeMismatch(withSize(1024, 768), null)).toBe(false);
    expect(
      imageCompareSizeMismatch(withSize(1024, 768), { ...withSize(0, 0), width: null, height: null }),
    ).toBe(false);
  });
});

describe("哪些节点能当对比输入", () => {
  it("图片 / 上传 / 导演台可以", () => {
    expect(canBeImageCompareSource(imageData("图"))).toBe(true);
    expect(
      canBeImageCompareSource({ ...imageData("上传"), type: "upload" } as CanvasNodeData),
    ).toBe(true);
    expect(
      canBeImageCompareSource({ ...imageData("导演台"), type: "director_stage" } as CanvasNodeData),
    ).toBe(true);
  });

  it("视频、文本、音频、脚本、分组、全景查看器一律不行", () => {
    for (const type of ["video", "video_merge", "text", "audio", "script", "group", "panorama_viewer"]) {
      expect(
        canBeImageCompareSource({ ...imageData("x"), type } as CanvasNodeData),
      ).toBe(false);
    }
  });

  it("对比节点自己不能当源（它不产出图片）", () => {
    expect(canBeImageCompareSource(compareData())).toBe(false);
  });

  it("上传节点里装的是视频文件也不行", () => {
    expect(
      canBeImageCompareSource({
        ...imageData("视频上传", "/assets/900/clip.mp4"),
        type: "upload",
      } as CanvasNodeData),
    ).toBe(false);
  });
});

describe("A/B 槽位", () => {
  it("连线指定了槽就用指定的", () => {
    expect(resolveImageCompareHandle(IMAGE_COMPARE_HANDLE_B, {})).toBe(
      IMAGE_COMPARE_HANDLE_B,
    );
  });

  it("落在节点体上（没指定槽）：先占 A，A 满了占 B", () => {
    expect(resolveImageCompareHandle(null, {})).toBe(IMAGE_COMPARE_HANDLE_A);
    expect(
      resolveImageCompareHandle(null, { compareRefA: { nodeId: "n1" } }),
    ).toBe(IMAGE_COMPARE_HANDLE_B);
  });

  it("同一张图不许同时占 A 和 B", () => {
    const plan = planImageCompareAssignment({
      sourceNodeId: "n1",
      sourceData: imageData("图"),
      targetNodeId: "c1",
      targetData: compareData({ compareRefA: { nodeId: "n1", url: "/a.png", name: "图" } }),
      requestedHandle: IMAGE_COMPARE_HANDLE_B,
    });
    expect(plan).toEqual({ ok: false, reason: "duplicate-source" });
  });

  it("同一个槽再连一次 = 换图（允许）", () => {
    const plan = planImageCompareAssignment({
      sourceNodeId: "n2",
      sourceData: imageData("新图"),
      targetNodeId: "c1",
      targetData: compareData({ compareRefA: { nodeId: "n1", url: "/a.png", name: "旧图" } }),
      requestedHandle: IMAGE_COMPARE_HANDLE_A,
    });
    expect(plan).toEqual({
      ok: true,
      handle: IMAGE_COMPARE_HANDLE_A,
      refKey: "compareRefA",
    });
  });

  it("拒绝视频源和自连", () => {
    expect(
      planImageCompareAssignment({
        sourceNodeId: "v1",
        sourceData: { ...imageData("视频"), type: "video" } as CanvasNodeData,
        targetNodeId: "c1",
        targetData: compareData(),
      }),
    ).toEqual({ ok: false, reason: "not-image" });

    expect(
      planImageCompareAssignment({
        sourceNodeId: "c1",
        sourceData: compareData(),
        targetNodeId: "c1",
        targetData: compareData(),
      }),
    ).toEqual({ ok: false, reason: "self" });
  });
});

describe("解析两路输入", () => {
  const nodes = [
    { id: "n1", data: { ...imageData("角色定妆"), nodeKey: "n1" } },
    { id: "n2", data: { ...imageData("三视图", "/assets/900/b.png"), nodeKey: "n2" } },
  ];

  it("两路都连上就是就绪，带标题和尺寸", () => {
    const data = compareData({
      compareRefA: compareRefFromNode("n1", imageData("角色定妆")),
      compareRefB: compareRefFromNode("n2", imageData("三视图", "/assets/900/b.png")),
    });
    const result = resolveImageCompareInputs(data, nodes);
    expect(result.ready).toBe(true);
    expect(result.connectedCount).toBe(2);
    expect(result.inputA?.title).toBe("角色定妆");
    expect(result.inputB?.title).toBe("三视图");
    expect(result.inputA?.width).toBe(1024);
    expect(result.inputA?.height).toBe(768);
  });

  it("只连一路：不就绪，计数 1", () => {
    const data = compareData({
      compareRefA: compareRefFromNode("n1", imageData("角色定妆")),
      compareRefB: null,
    });
    const result = resolveImageCompareInputs(data, nodes);
    expect(result.ready).toBe(false);
    expect(result.connectedCount).toBe(1);
    expect(result.inputB).toBeNull();
  });

  it("上游节点不在了也不炸：引用里记着 url 就还能看", () => {
    const data = compareData({
      compareRefA: { nodeId: "已删除的节点", url: "/assets/900/gone.png", name: "旧图" },
      compareRefB: compareRefFromNode("n2", imageData("三视图")),
    });
    const result = resolveImageCompareInputs(data, nodes);
    expect(result.inputA?.fullUrl).toBe("/assets/900/gone.png");
    expect(result.inputA?.title).toBe("旧图");
    expect(result.ready).toBe(true);
  });

  it("上游没了、引用里也没 url → 不就绪，而不是崩", () => {
    const data = compareData({
      compareRefA: { nodeId: "没了", url: "", name: "" },
      compareRefB: null,
    });
    expect(() => resolveImageCompareInputs(data, nodes)).not.toThrow();
    expect(resolveImageCompareInputs(data, nodes).connectedCount).toBe(0);
  });

  it("上游被换成了视频节点 → 这一路不算有效输入", () => {
    const videoNodes = [
      { id: "n1", data: { ...imageData("变成视频了"), type: "video", nodeKey: "n1" } },
    ];
    const data = compareData({
      compareRefA: { nodeId: "n1", url: "/assets/900/a.png", name: "x" },
    });
    expect(resolveImageCompareInputs(data, videoNodes as never).inputA).toBeNull();
  });
});

describe("上游被删除时清空槽位", () => {
  it("只清被删的那一路", () => {
    const params = {
      compareRefA: { nodeId: "n1", url: "/a.png", name: "A" },
      compareRefB: { nodeId: "n2", url: "/b.png", name: "B" },
    };
    expect(clearedImageCompareRefs(params, new Set(["n1"]))).toEqual({
      compareRefA: null,
    });
  });

  it("没命中就返回 null（不产生无意义的改动）", () => {
    const params = { compareRefA: { nodeId: "n1", url: "/a.png", name: "A" } };
    expect(clearedImageCompareRefs(params, new Set(["n9"]))).toBeNull();
  });
});

/**
 * 这一段是 Shotflow 特有的风险：连线不持久化，全靠 edgesFromNodeReferences 从
 * params 重新推导。A/B 的身份必须扛过保存-加载一圈。
 */
describe("持久化往返：刷新后 A/B 两条连线还在", () => {
  function project(): Project {
    const node = (nodeKey: string, data: CanvasNodeData) => ({
      nodeKey,
      projectUuid: UUID,
      type: 2,
      name: data.name,
      status: 1,
      position: { positionX: 0, positionY: 0 },
      measured: { width: 520, height: 350 },
      data: JSON.stringify({ ...data, nodeKey, _collabVersion: 1 }),
    });
    return {
      projectMeta: {
        uuid: UUID,
        name: "对比测试",
        ownerId: 1,
        isOwner: true,
        canManage: true,
        canWrite: true,
        contentVersion: "cv-1",
      },
      projectDraft: {
        projectUuid: UUID,
        viewportX: 0,
        viewportY: 0,
        viewportZoom: 1,
        canvasTextScale: 1,
        lastPluginEditAtMs: 0,
      },
      nodeList: [
        node("n1", imageData("角色定妆")),
        node("n2", imageData("三视图", "/assets/900/b.png")),
        node(
          "c1",
          compareData({
            compareRefA: { nodeId: "n1", url: "/assets/900/a.png", name: "角色定妆" },
            compareRefB: { nodeId: "n2", url: "/assets/900/b.png", name: "三视图" },
            compareMode: "wipe",
          }),
        ),
      ],
    } as unknown as Project;
  }

  beforeEach(() => {
    useCanvasStore.getState().clearProject();
  });

  it("加载后能推导出两条带具名槽的边", () => {
    useCanvasStore.getState().loadProject(project());
    const edges = useCanvasStore
      .getState()
      .edges.filter((edge) => edge.target === "c1");
    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => edge.targetHandle).sort()).toEqual([
      "compare-a",
      "compare-b",
    ]);
    expect(edges.find((e) => e.targetHandle === "compare-a")?.source).toBe("n1");
    expect(edges.find((e) => e.targetHandle === "compare-b")?.source).toBe("n2");
  });

  it("加载后 A/B 身份没有互换，模式也保留", () => {
    useCanvasStore.getState().loadProject(project());
    const compareNode = useCanvasStore
      .getState()
      .nodes.find((node) => node.data.nodeKey === "c1");
    const refs = readImageCompareRefs(compareNode?.data as CanvasNodeData);
    expect(refs.compareRefA?.nodeId).toBe("n1");
    expect(refs.compareRefB?.nodeId).toBe("n2");
    const params = (compareNode?.data.params ?? {}) as Record<string, unknown>;
    expect(normalizeImageCompareMode(params.compareMode)).toBe("wipe");
  });

  it("加载后立刻保存，不产生任何写请求（说明没有被判成脏数据）", async () => {
    useCanvasStore.getState().loadProject(project());
    const { nodesApi } = await import("@/lib/api");
    (nodesApi.upsert as unknown as { mockClear: () => void }).mockClear();
    await useCanvasStore.getState().persistNodesAndWait();
    expect(nodesApi.upsert).not.toHaveBeenCalled();
  });
});
