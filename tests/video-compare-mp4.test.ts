/**
 * 视频对比导出：浏览器录制文件可以是 WebM，但落到画布上的正式资产必须是真实 H.264 MP4。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VIDEO_COMPARE_UPLOAD_OPTIONS,
} from "@/features/video-compare/video-compare-export";
import { videoCompareFileName } from "@/features/video-compare/video-compare-layout";
import { videoDownloadFileName } from "@/lib/videoFileName";

for (const [key, value] of Object.entries({
  DB_USER: "test",
  DB_PASSWORD: "test",
  DB_NAME: "test",
  SESSION_SECRET: "test-secret",
  INITIAL_ADMIN_PASSWORD: "test-only",
})) {
  if (!process.env[key]) process.env[key] = value;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const routes = require("../server/canvasRoutes.js");

describe("视频对比 MP4 输出契约", () => {
  it("浏览器中间文件保持真实 WebM 类型，上传阶段明确要求服务端转 MP4", () => {
    expect(videoCompareFileName("side-by-side", ["甲", "乙"])).toMatch(/\.webm$/);
    expect(VIDEO_COMPARE_UPLOAD_OPTIONS).toEqual({
      sourceType: "video-compare",
      normalizeVideoToMp4: true,
    });
  });

  it("正式资产名统一改成 mp4", () => {
    expect(routes.mp4UploadFileName("视频对比左右.webm")).toBe("视频对比左右.mp4");
    expect(routes.mp4UploadFileName("clip.mov")).toBe("clip.mp4");
    expect(routes.mp4UploadFileName("clip")).toBe("clip.mp4");
  });

  it("转码保留原尺寸，只补齐偶数边，并使用高质量参数", () => {
    expect(routes.videoCompareMp4TranscodeOptions()).toEqual({
      filter: "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      crf: 18,
      audioBitrateKbps: 128,
      timeout: 20 * 60_000,
    });
  });

  it("只有 MP4 容器里的 H.264 视频通过服务端落库校验", () => {
    expect(routes.isH264Mp4Probe({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      streams: [{ codec_type: "video", codec_name: "h264" }],
    })).toBe(true);
    expect(routes.isH264Mp4Probe({
      format: { format_name: "matroska,webm" },
      streams: [{ codec_type: "video", codec_name: "vp9" }],
    })).toBe(false);
    expect(routes.isH264Mp4Probe({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      streams: [{ codec_type: "video", codec_name: "hevc" }],
    })).toBe(false);
  });

  it("上传表单会把 MP4 标准化开关传给服务端", () => {
    const source = readFileSync(join(__dirname, "..", "src/canvas/lib/api.ts"), "utf8");
    expect(source).toContain('fd.append("normalizeVideoToMp4", "1")');
    expect(source).toContain('fd.append("sourceType", options.sourceType)');
  });

  it("节点名没有扩展名时，下载名仍明确是 mp4", () => {
    expect(videoDownloadFileName("视频对比左右｜甲 + 乙", "/assets/9/hash.mp4"))
      .toBe("视频对比左右｜甲 + 乙.mp4");
    expect(videoDownloadFileName("旧名字.webm", "/assets/9/hash.mp4"))
      .toBe("旧名字.mp4");
  });
});
