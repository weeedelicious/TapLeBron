import { describe, expect, it } from "vitest";
import {
  collectLocalAssetUrls,
  parseLocalAssetUrl,
  rewriteLocalAssetUrls,
} from "@/lib/localAssetUrls";

describe("共享素材 URL", () => {
  it("能拆出画布 id 和文件名", () => {
    expect(
      parseLocalAssetUrl("/assets/272/dd9680558583e8456173d3a55c7a3996b23ffa29.mp4"),
    ).toEqual({
      projectUuid: "272",
      storedName: "dd9680558583e8456173d3a55c7a3996b23ffa29.mp4",
    });
  });

  it("从节点数据里收集全部本地资产", () => {
    const urls = collectLocalAssetUrls({
      url: ["/assets/272/a.mp4"],
      _primaryAssetUrl: "/assets/272/a.mp4",
      _resourceMeta: { items: [{ originalUrl: "/assets/272/a.mp4", displayUrl: "/assets/272/a_display.mp4" }] },
      params: { videoList: [{ nodeId: "n1", url: "/assets/272/a.mp4" }] },
    });
    expect(urls.sort()).toEqual([
      "/assets/272/a.mp4",
      "/assets/272/a_display.mp4",
    ]);
  });

  it("改写到当前画布后不再指向源画布", () => {
    const next = rewriteLocalAssetUrls(
      {
        url: ["/assets/272/a.mp4"],
        params: { videoList: [{ url: "/assets/272/a.mp4" }] },
      },
      { "/assets/272/a.mp4": "/assets/264/a.mp4" },
    );
    expect(next.url).toEqual(["/assets/264/a.mp4"]);
    expect(next.params.videoList[0].url).toBe("/assets/264/a.mp4");
  });
});
