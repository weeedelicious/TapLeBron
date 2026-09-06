/**
 * 视频节点正式输出：MP4 只是容器，RV 2022 还要求其中的视频编码可解。
 * Seedance 的 4K / 部分 1080P 返回 10-bit HEVC；服务端需保留原片，并把节点 URL 指向
 * 原尺寸、原帧率的 H.264/yuv420p MP4 兼容版。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function aacPacketHash(filePath: string) {
  const bytes = execFileSync("ffmpeg", [
    "-nostdin", "-v", "error", "-i", filePath,
    "-map", "0:a:0", "-c:a", "copy", "-f", "adts", "pipe:1",
  ], { timeout: 30_000 });
  return createHash("sha1").update(bytes).digest("hex");
}

describe("生成视频 RV 兼容输出", () => {
  it("只接受 MP4 容器中的 8-bit H.264 4:2:0", () => {
    const base = {
      kind: "video",
      extension: "mp4",
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      width: 3840,
      height: 2160,
      fps: 24,
    };
    expect(routes.isRvCompatibleGeneratedVideo({
      ...base,
      codecName: "h264",
      pixelFormat: "yuv420p",
    })).toBe(true);
    expect(routes.isRvCompatibleGeneratedVideo({
      ...base,
      codecName: "h264",
      pixelFormat: "yuv420p",
      audioCodecName: "opus",
    })).toBe(false);
    expect(routes.isRvCompatibleGeneratedVideo({
      ...base,
      codecName: "hevc",
      codecProfile: "Main 10",
      pixelFormat: "yuv420p10le",
    })).toBe(false);
    expect(routes.isRvCompatibleGeneratedVideo({
      ...base,
      codecName: "h264",
      pixelFormat: "yuv420p10le",
    })).toBe(false);
    expect(routes.isRvCompatibleGeneratedVideo({
      ...base,
      extension: "mov",
      codecName: "h264",
      pixelFormat: "yuv420p",
    })).toBe(false);
    expect(routes.isRvCompatibleGeneratedVideo({
      ...base,
      formatName: "matroska,webm",
      codecName: "h264",
      pixelFormat: "yuv420p",
    })).toBe(false);
  });

  it("兼容转码不缩放、不降帧，并使用视觉近无损参数", () => {
    expect(routes.generatedVideoRvTranscodeOptions()).toEqual({
      filter: "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      crf: 12,
      preset: "medium",
      videoProfile: "high",
      videoTag: "avc1",
      audioBitrateKbps: 192,
      timeout: 15 * 60_000,
    });

    expect(routes.generatedVideoRvValidationError(
      { width: 3839, height: 2159, fps: 24, durationSec: 4 },
      {
        extension: "mp4",
        formatName: "mov,mp4,m4a,3gp,3g2,mj2",
        codecName: "h264",
        pixelFormat: "yuv420p",
        width: 3840,
        height: 2160,
        fps: 24,
        durationSec: 4.02,
      },
    )).toBe("");
    expect(routes.generatedVideoRvValidationError(
      { width: 3840, height: 2160, fps: 24 },
      {
        extension: "mp4",
        formatName: "mov,mp4,m4a,3gp,3g2,mj2",
        codecName: "h264",
        pixelFormat: "yuv420p",
        width: 1920,
        height: 1080,
        fps: 24,
      },
    )).toContain("宽度");
  });

  it("H.264 直通、HEVC 双份保存，任务描述只引用最终兼容 URL", () => {
    const h264 = {
      kind: "video",
      extension: "mp4",
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      codecName: "h264",
      pixelFormat: "yuv420p",
    };
    const hevc = { ...h264, codecName: "hevc", pixelFormat: "yuv420p10le" };
    expect(routes.generatedVideoRvStoragePlan(h264, {
      ensureRvCompatibleVideos: true,
      sourceType: "generated",
    })).toEqual({ shouldCreateRvCopy: false, sourceRecordType: "generated" });
    expect(routes.generatedVideoRvStoragePlan(hevc, {
      ensureRvCompatibleVideos: true,
      sourceType: "generated",
    })).toEqual({ shouldCreateRvCopy: true, sourceRecordType: "generated-original" });
    expect(routes.stableAssetExtension(
      { formatName: "mov,mp4,m4a,3gp,3g2,mj2" },
      "provider-result.bin",
    )).toBe(".mp4");

    const output = routes.taskOutputForStoredAsset(
      "/assets/343/h264.mp4",
      h264,
      "video/mp4",
      { providerOriginalUrl: "/assets/343/hevc_original.mp4" },
    );
    expect(output.url).toBe("/assets/343/h264.mp4");
    expect(output.mimeType).toBe("video/mp4");
    expect(output.metadata).toMatchObject({
      codecName: "h264",
      rvCompatible: true,
      providerOriginalUrl: "/assets/343/hevc_original.mp4",
    });
  });

  it("单条、多条、重启补收和 AI 出片都打开 RV 兼容开关", () => {
    const source = readFileSync(join(__dirname, "..", "server/canvasRoutes.js"), "utf8");
    const studioSource = readFileSync(join(__dirname, "..", "server/services/StudioService.js"), "utf8");
    expect(source.match(/ensureRvCompatibleVideos: true/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain("ensureRvCompatibleVideos: Boolean(options.ensureRvCompatibleVideos)");
    expect(source).toContain("generated-source-${randomId()}");
    expect(source).toContain("await sha1FileAsync(filePath)");
    expect(source).toContain("compatibilityTranscode: 'h264-yuv420p-crf12'");
    expect(source).not.toContain("h264-yuv420p-crf16");
    expect(studioSource).toContain("ensureRvCompatibleVideos: true");
  });
});

describe("真实 HEVC 到 RV MP4 转码", () => {
  let workDir = "";
  let sourcePath = "";
  let mysteryPath = "";
  let outputPath = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "shotflow-rv-test-"));
    sourcePath = join(workDir, "source-hevc.mp4");
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=96x54:rate=24000/1001",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", "0.5",
      "-c:v", "libx265",
      "-pix_fmt", "yuv420p10le",
      "-c:a", "aac",
      sourcePath,
    ], { timeout: 30_000 });
    mysteryPath = join(workDir, "provider-result.bin");
    copyFileSync(sourcePath, mysteryPath);
  });

  afterAll(() => {
    if (outputPath && existsSync(outputPath)) rmSync(outputPath, { force: true });
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it("产物为 H.264 High/yuv420p MP4，尺寸和 23.976fps 均保持", async () => {
    const result = await routes.transcodeGeneratedVideoForRv(sourcePath);
    outputPath = result.filePath;
    expect(statSync(outputPath).size).toBeGreaterThan(0);
    expect(result.sourceMeta.codecName).toBe("hevc");
    expect(result.sourceMeta.pixelFormat).toBe("yuv420p10le");
    expect(result.sourceMeta.audioCodecName).toBe("aac");
    expect(result.outputMeta.codecName).toBe("h264");
    expect(result.outputMeta.codecProfile).toBe("High");
    expect(result.outputMeta.pixelFormat).toBe("yuv420p");
    expect(result.outputMeta.audioCodecName).toBe("aac");
    expect(result.outputMeta.formatName.split(",")).toContain("mp4");
    expect(result.outputMeta.width).toBe(96);
    expect(result.outputMeta.height).toBe(54);
    expect(result.outputMeta.fps).toBeCloseTo(23.976, 2);
    expect(result.outputMeta.durationSec).toBeCloseTo(result.sourceMeta.durationSec, 1);
    // 输入本来就是 AAC 时只复制音频包，不再做一次有损 AAC → AAC。
    expect(aacPacketHash(outputPath)).toBe(aacPacketHash(sourcePath));
  }, 60_000);

  it("provider 未给正确扩展名和 MIME 时仍能探测出 HEVC 视频", async () => {
    const meta = await routes.probeMediaMetadata(
      mysteryPath,
      "application/octet-stream",
      "provider-result.bin",
      { probeAv: true },
    );
    expect(meta.kind).toBe("video");
    expect(meta.mimeType).toBe("video/mp4");
    expect(meta.codecName).toBe("hevc");
    expect(meta.pixelFormat).toBe("yuv420p10le");
  });
});
