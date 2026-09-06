/**
 * 把对比画面先录成 WebM 中间文件。
 *
 * 同源 /assets 视频可以画到 canvas，再用 canvas.captureStream + MediaRecorder 录制；
 * 上传时由服务端转成并校验 H.264 MP4，最终画布节点不会引用这个 WebM 中间件。
 */
import type { VideoCompareInput } from "./video-compare";
import {
  videoCompareDrawBox,
  videoCompareExportLayout,
  videoCompareFileName,
  type VideoCompareExportLayoutKind,
} from "./video-compare-layout";

export interface VideoCompareExportResult {
  file: File;
  width: number;
  height: number;
  durationSec: number;
  kind: VideoCompareExportLayoutKind;
}

export const VIDEO_COMPARE_UPLOAD_OPTIONS = {
  sourceType: "video-compare",
  normalizeVideoToMp4: true,
} as const;

function loadVideo(url: string) {
  return new Promise<HTMLVideoElement>((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    const fail = () => reject(new Error(`视频加载失败：${url}`));
    video.onerror = fail;
    video.onloadedmetadata = () => resolve(video);
  });
}

function pickRecorderMime() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return "video/webm";
}

function waitFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(() => resolve(), 16);
  });
}

export async function renderComparedVideoFile(args: {
  inputs: VideoCompareInput[];
  kind: VideoCompareExportLayoutKind;
  signal?: AbortSignal;
}): Promise<VideoCompareExportResult> {
  const usable = args.inputs.filter((item) => item?.fullUrl);
  const layout = videoCompareExportLayout(
    usable.map((item) => ({
      width: item.width || 1280,
      height: item.height || 720,
    })),
    args.kind,
  );
  if (!layout) {
    throw new Error(args.kind === "quad" ? "四宫格至少需要 3 条视频" : "左右对比需要 2 条视频");
  }

  const videos = await Promise.all(
    usable.slice(0, layout.cells.length).map((item) => loadVideo(item.fullUrl)),
  );
  const durationSec = Math.max(
    0.4,
    ...videos.map((video) => (Number.isFinite(video.duration) ? video.duration : 0)),
    ...usable.map((item) => item.durationSec || 0),
  );

  const canvas = document.createElement("canvas");
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");

  const mimeType = pickRecorderMime();
  const stream = canvas.captureStream(30);
  const bitsPerPixel = 8;
  const videoBitsPerSecond = Math.min(
    80_000_000,
    Math.max(12_000_000, Math.round(layout.canvasWidth * layout.canvasHeight * 30 * bitsPerPixel)),
  );
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const stopSignal = args.signal;
  if (stopSignal?.aborted) throw new Error("已取消导出");

  await Promise.all(
    videos.map(async (video) => {
      video.currentTime = 0;
      try {
        await video.play();
      } catch {
        /* 静音 play 失败时仍按逐帧画 */
      }
    }),
  );

  const started = performance.now();
  recorder.start(200);

  const paint = () => {
    ctx.fillStyle = "#05070b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    layout.cells.forEach((cell, index) => {
      ctx.fillStyle = "#10141c";
      ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
      const video = videos[index];
      if (!video) {
        ctx.fillStyle = "#1a2130";
        ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
        ctx.fillStyle = "#6f7d93";
        ctx.font = "24px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("空", cell.x + cell.width / 2, cell.y + cell.height / 2);
        return;
      }
      const box = videoCompareDrawBox(
        {
          width: video.videoWidth || usable[index]?.width || cell.width,
          height: video.videoHeight || usable[index]?.height || cell.height,
        },
        cell,
      );
      ctx.drawImage(video, box.x, box.y, box.width, box.height);
    });
  };

  while ((performance.now() - started) / 1000 < durationSec) {
    if (stopSignal?.aborted) {
      recorder.stop();
      videos.forEach((video) => video.pause());
      throw new Error("已取消导出");
    }
    paint();
    await waitFrame();
  }

  paint();
  await new Promise<void>((resolve, reject) => {
    recorder.onerror = () => reject(new Error("对比视频录制失败"));
    recorder.onstop = () => resolve();
    recorder.stop();
  });
  videos.forEach((video) => {
    video.pause();
    video.src = "";
  });

  const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
  if (blob.size <= 0) throw new Error("对比视频导出为空");
  const file = new File(
    [blob],
    videoCompareFileName(args.kind, usable.map((item) => item.title)),
    { type: blob.type, lastModified: Date.now() },
  );
  return {
    file,
    width: layout.canvasWidth,
    height: layout.canvasHeight,
    durationSec: Number(durationSec.toFixed(3)),
    kind: args.kind,
  };
}
