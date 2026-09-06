import { describe, expect, it } from "vitest";
import type { CanvasNodeData } from "@/lib/types";
import {
  VIDEO_COMPARE_HANDLES,
  canBeVideoCompareSource,
  clearedVideoCompareRefs,
  compareVideoRefFromNode,
  isVideoCompareNodeData,
  listVideoCompareSourceClips,
  nextUnusedVideoCompareUrl,
  normalizeVideoCompareMode,
  pickVideoCompareUrl,
  planVideoCompareAssignment,
  readVideoCompareRefs,
  resolveVideoCompareHandle,
  resolveVideoCompareInputs,
  videoCompareHandleFromEdge,
} from "@/features/video-compare/video-compare";
import {
  videoCompareDrawBox,
  videoCompareExportLayout,
  videoCompareFileName,
} from "@/features/video-compare/video-compare-layout";

function videoData(name: string, url = "/assets/900/a.mp4"): CanvasNodeData {
  return {
    type: "video",
    name,
    url: [url],
    action: "video_generate",
    _resourceMeta: {
      items: [{ kind: "video", originalUrl: url, width: 1280, height: 720, durationSec: 4 }],
    },
  } as unknown as CanvasNodeData;
}

function compareData(
  params: Record<string, unknown> = {
    compareRefA: null,
    compareRefB: null,
    compareRefC: null,
    compareRefD: null,
  },
): CanvasNodeData {
  return {
    type: "video_compare",
    name: "视频对比",
    url: [],
    action: "video_compare",
    params,
  } as unknown as CanvasNodeData;
}

describe("类型与模式", () => {
  it("认得出视频对比节点", () => {
    expect(isVideoCompareNodeData(compareData())).toBe(true);
    expect(isVideoCompareNodeData(videoData("片"))).toBe(false);
  });

  it("模式归一化，脏值退回左右", () => {
    expect(normalizeVideoCompareMode("quad")).toBe("quad");
    expect(normalizeVideoCompareMode("side-by-side")).toBe("side-by-side");
    expect(normalizeVideoCompareMode("垃圾")).toBe("side-by-side");
  });
});

describe("哪些节点能当视频对比输入", () => {
  it("视频 / 合成 / 上传视频可以", () => {
    expect(canBeVideoCompareSource(videoData("片"))).toBe(true);
    expect(
      canBeVideoCompareSource({ ...videoData("合成"), type: "video_merge" } as CanvasNodeData),
    ).toBe(true);
    expect(
      canBeVideoCompareSource({
        ...videoData("上传", "/assets/900/clip.mp4"),
        type: "upload",
      } as CanvasNodeData),
    ).toBe(true);
  });

  it("图片、文本、音频不行", () => {
    for (const type of ["image", "text", "audio", "script", "group", "image_compare"]) {
      expect(
        canBeVideoCompareSource({ ...videoData("x"), type } as CanvasNodeData),
      ).toBe(false);
    }
  });

  it("上传节点里装的是图片不行", () => {
    expect(
      canBeVideoCompareSource({
        ...videoData("图上传", "/assets/900/a.png"),
        type: "upload",
      } as CanvasNodeData),
    ).toBe(false);
  });
});

describe("A/B/C/D 槽位", () => {
  it("没指定槽时按空位依次占", () => {
    expect(resolveVideoCompareHandle(null, {})).toBe("compare-a");
    expect(
      resolveVideoCompareHandle(null, { compareRefA: { nodeId: "n1" } }),
    ).toBe("compare-b");
    expect(
      resolveVideoCompareHandle(null, {
        compareRefA: { nodeId: "n1" },
        compareRefB: { nodeId: "n2" },
        compareRefC: { nodeId: "n3" },
      }),
    ).toBe("compare-d");
  });

  it("同一多视频节点可以连到多个槽", () => {
    const plan = planVideoCompareAssignment({
      sourceNodeId: "n1",
      sourceData: videoData("片"),
      targetNodeId: "c1",
      targetData: compareData({
        compareRefA: { nodeId: "n1", url: "/a.mp4", name: "片" },
      }),
      requestedHandle: "compare-b",
    });
    expect(plan).toEqual({
      ok: true,
      handle: "compare-b",
      refKey: "compareRefB",
    });
  });

  it("指定槽可以替换", () => {
    const plan = planVideoCompareAssignment({
      sourceNodeId: "n2",
      sourceData: videoData("新片"),
      targetNodeId: "c1",
      targetData: compareData({
        compareRefA: { nodeId: "n1", url: "/a.mp4", name: "片" },
      }),
      requestedHandle: "compare-a",
    });
    expect(plan).toEqual({
      ok: true,
      handle: "compare-a",
      refKey: "compareRefA",
    });
  });
});

describe("输入解析与清理", () => {
  it("左右模式两条就就绪，四宫格至少三条", () => {
    const nodes = [
      { id: "n1", data: videoData("A") },
      { id: "n2", data: videoData("B", "/b.mp4") },
      { id: "n3", data: videoData("C", "/c.mp4") },
    ];
    const two = resolveVideoCompareInputs(
      compareData({
        compareMode: "side-by-side",
        compareRefA: compareVideoRefFromNode("n1", videoData("A")),
        compareRefB: compareVideoRefFromNode("n2", videoData("B", "/b.mp4")),
      }),
      nodes,
    );
    expect(two.ready).toBe(true);
    expect(two.connectedCount).toBe(2);

    const threeSide = resolveVideoCompareInputs(
      compareData({
        compareMode: "side-by-side",
        compareRefA: compareVideoRefFromNode("n1", videoData("A")),
        compareRefB: compareVideoRefFromNode("n2", videoData("B", "/b.mp4")),
        compareRefC: compareVideoRefFromNode("n3", videoData("C", "/c.mp4")),
      }),
      nodes,
    );
    expect(threeSide.ready).toBe(true);
    expect(threeSide.mode).toBe("quad");

    const twoQuad = resolveVideoCompareInputs(
      compareData({
        compareMode: "quad",
        compareRefA: compareVideoRefFromNode("n1", videoData("A")),
        compareRefB: compareVideoRefFromNode("n2", videoData("B", "/b.mp4")),
      }),
      nodes,
    );
    expect(twoQuad.ready).toBe(false);

    const threeQuad = resolveVideoCompareInputs(
      compareData({
        compareMode: "quad",
        compareRefA: compareVideoRefFromNode("n1", videoData("A")),
        compareRefB: compareVideoRefFromNode("n2", videoData("B", "/b.mp4")),
        compareRefC: compareVideoRefFromNode("n3", videoData("C", "/c.mp4")),
      }),
      nodes,
    );
    expect(threeQuad.ready).toBe(true);
    expect(threeQuad.connectedCount).toBe(3);
  });

  it("上游删掉后清对应槽", () => {
    const patch = clearedVideoCompareRefs(
      {
        compareRefA: { nodeId: "gone" },
        compareRefB: { nodeId: "keep" },
      },
      new Set(["gone"]),
    );
    expect(patch).toEqual({ compareRefA: null });
  });

  it("同一多视频节点占多个槽时，删一条线只清那个槽", () => {
    const params = {
      compareRefA: { nodeId: "n1", url: "/a.mp4" },
      compareRefB: { nodeId: "n1", url: "/b.mp4" },
      compareRefC: { nodeId: "n1", url: "/c.mp4" },
    };
    expect(
      clearedVideoCompareRefs(params, new Set(["n1"]), ["compare-b"]),
    ).toEqual({ compareRefB: null });
    expect(
      clearedVideoCompareRefs(params, new Set(["n1"]), [], 1),
    ).toEqual({ compareRefA: null });
    expect(
      clearedVideoCompareRefs(params, new Set(["n1"]), [], 2),
    ).toEqual({
      compareRefA: null,
      compareRefB: null,
    });
    expect(
      clearedVideoCompareRefs(params, new Set(["n1"])),
    ).toEqual({
      compareRefA: null,
      compareRefB: null,
      compareRefC: null,
    });
  });

  it("能从边 id 认出对比槽", () => {
    expect(videoCompareHandleFromEdge({ targetHandle: "compare-c" })).toBe("compare-c");
    expect(
      videoCompareHandleFromEdge({ id: "e-n1-c1-compare-b" }),
    ).toBe("compare-b");
    expect(videoCompareHandleFromEdge({ id: "e-n1-c1" })).toBeNull();
  });

  it("多视频节点可以列出非封面并按引用锁定那条", () => {
    const data = {
      ...videoData("多片"),
      url: ["/cover.mp4", "/second.mp4", "/third.mp4"],
      _primaryAssetUrl: "/cover.mp4",
    } as CanvasNodeData;
    expect(listVideoCompareSourceClips(data)).toEqual([
      { url: "/cover.mp4", order: 1, isCover: true },
      { url: "/second.mp4", order: 2, isCover: false },
      { url: "/third.mp4", order: 3, isCover: false },
    ]);
    expect(pickVideoCompareUrl(data, "/second.mp4")).toBe("/second.mp4");
    expect(pickVideoCompareUrl(data, "/gone.mp4")).toBe("/cover.mp4");
    expect(nextUnusedVideoCompareUrl(data, ["/cover.mp4"])).toBe("/second.mp4");
  });

  it("四个具名 handle 都在", () => {
    expect(VIDEO_COMPARE_HANDLES).toEqual([
      "compare-a",
      "compare-b",
      "compare-c",
      "compare-d",
    ]);
    expect(readVideoCompareRefs(compareData()).compareRefD).toBeNull();
  });
});

describe("导出排版", () => {
  it("左右两路是 hstack", () => {
    const layout = videoCompareExportLayout(
      [
        { width: 1280, height: 720 },
        { width: 1280, height: 720 },
      ],
      "side-by-side",
    );
    expect(layout?.kind).toBe("side-by-side");
    expect(layout?.cells).toHaveLength(2);
    expect(layout?.canvasWidth).toBe((layout?.cellWidth ?? 0) * 2);
    expect(layout?.canvasHeight).toBe(layout?.cellHeight);
    expect(layout?.cells[1].x).toBe(layout?.cellWidth);
  });

  it("四宫格 3 路也是 2×2，第四格空着", () => {
    const layout = videoCompareExportLayout(
      [
        { width: 1280, height: 720 },
        { width: 1280, height: 720 },
        { width: 1280, height: 720 },
      ],
      "quad",
    );
    expect(layout?.kind).toBe("quad");
    expect(layout?.cells).toHaveLength(3);
    expect(layout?.canvasWidth).toBe((layout?.cellWidth ?? 0) * 2);
    expect(layout?.canvasHeight).toBe((layout?.cellHeight ?? 0) * 2);
    expect(layout?.cells[2]).toMatchObject({ letter: "C", x: 0 });
  });

  it("左右导出按原高度，不压到 720", () => {
    const layout = videoCompareExportLayout(
      [
        { width: 1920, height: 1080 },
        { width: 1920, height: 1080 },
      ],
      "side-by-side",
    );
    expect(layout?.cellWidth).toBe(1920);
    expect(layout?.cellHeight).toBe(1080);
    expect(layout?.canvasWidth).toBe(3840);
    expect(layout?.canvasHeight).toBe(1080);
  });

  it("四宫格导出按原尺寸拼 2×2", () => {
    const layout = videoCompareExportLayout(
      [
        { width: 1280, height: 720 },
        { width: 1280, height: 720 },
        { width: 1280, height: 720 },
      ],
      "quad",
    );
    expect(layout?.cellWidth).toBe(1280);
    expect(layout?.cellHeight).toBe(720);
    expect(layout?.canvasWidth).toBe(2560);
    expect(layout?.canvasHeight).toBe(1440);
  });

  it("contain 居中，不拉伸", () => {
    const layout = videoCompareExportLayout(
      [
        { width: 1280, height: 720 },
        { width: 720, height: 1280 },
      ],
      "side-by-side",
    );
    expect(layout).toBeTruthy();
    const box = videoCompareDrawBox({ width: 720, height: 1280 }, layout!.cells[1]);
    expect(box.height).toBeLessThanOrEqual(layout!.cellHeight);
    expect(box.width).toBeLessThanOrEqual(layout!.cellWidth);
  });

  it("文件名带模式", () => {
    expect(videoCompareFileName("quad", ["甲", "乙", "丙"])).toContain("四宫格");
    expect(videoCompareFileName("side-by-side", ["甲", "乙"])).toContain("左右");
  });
});
