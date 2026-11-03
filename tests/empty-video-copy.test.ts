import { describe, expect, it } from "vitest";
import { emptyVideoCopyData } from "@/lib/emptyVideoCopy";
import type { CanvasNodeData } from "@/lib/types";

describe("emptyVideoCopyData", () => {
  it("keeps prompt, settings and references but drops the video", () => {
    const data = {
      type: "video",
      name: "视频节点 22",
      url: ["/media/out.mp4"],
      poster: "/media/out.jpg",
      action: "video_generate",
      _primaryAssetUrl: "/media/out.mp4",
      taskInfo: { loading: true },
      params: {
        prompt: "雨中奔跑",
        promptHtml: "<p>雨中奔跑</p>",
        model: "Seedance_2_0",
        settings: { ratio: "16:9", duration: 5 },
        imageList: [{ nodeId: "img-1", url: "/media/ref.png", mediaType: "image" }],
        videoList: [{ nodeId: "vid-1", url: "/media/ref.mp4", mediaType: "video" }],
        history: [{ id: "h1", url: "/media/old.mp4", prompt: "旧视频" }],
      },
    } as unknown as CanvasNodeData;

    const next = emptyVideoCopyData(data);

    expect(next.url).toEqual([]);
    expect(next.poster).toBeUndefined();
    expect(next._primaryAssetUrl).toBeUndefined();
    expect(next.taskInfo).toBeUndefined();
    expect(next.params).toMatchObject({
      prompt: "雨中奔跑",
      promptHtml: "<p>雨中奔跑</p>",
      model: "Seedance_2_0",
      settings: { ratio: "16:9", duration: 5 },
      imageList: [{ nodeId: "img-1", url: "/media/ref.png", mediaType: "image" }],
      videoList: [{ nodeId: "vid-1", url: "/media/ref.mp4", mediaType: "video" }],
    });
    expect((next.params as { history?: unknown }).history).toBeUndefined();
    expect(data.url).toEqual(["/media/out.mp4"]);
  });

  it("drops a generated image but keeps prompt and references", () => {
    const data = {
      type: "image",
      name: "image node",
      url: ["/media/out.png"],
      action: "image_generate",
      _primaryAssetUrl: "/media/out.png",
      params: {
        prompt: "night",
        model: "nano-banana",
        imageList: [{ nodeId: "img-1", url: "/media/ref.png", mediaType: "image" }],
        history: [{ id: "h1", url: "/media/old.png" }],
      },
    } as unknown as CanvasNodeData;
    const next = emptyVideoCopyData(data);
    expect(next.url).toEqual([]);
    expect(next._primaryAssetUrl).toBeUndefined();
    expect(next.params).toMatchObject({
      prompt: "night",
      model: "nano-banana",
      imageList: [{ nodeId: "img-1", url: "/media/ref.png", mediaType: "image" }],
    });
    expect((next.params as { history?: unknown }).history).toBeUndefined();
  });

  it("leaves other nodes unchanged", () => {
    const data = { type: "text", name: "note", url: [], action: "text_node" } as CanvasNodeData;
    expect(emptyVideoCopyData(data)).toBe(data);
  });
})
