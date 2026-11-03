import type { CanvasNodeData } from "@/lib/types";

const OUTPUT_KEYS = [
  "poster",
  "taskInfo",
  "_pendingTasks",
  "_failedGenerations",
  "_resourceMeta",
  "_hiddenHistoryUrls",
  "_assetCreatedAtMs",
  "_assetGenerationMeta",
  "_assetPreviewUrls",
  "uploadInfo",
  "_primaryAssetUrl",
  "_autoGenerate",
] as const;

/** Copy an image or video node without its finished media. */
export function emptyVideoCopyData(data: CanvasNodeData): CanvasNodeData {
  if (data.type !== "video" && data.type !== "image") return data;
  const params = { ...((data.params ?? {}) as Record<string, unknown>) };
  delete params.history;
  const next: CanvasNodeData = {
    ...data,
    url: [],
    params,
  };
  for (const key of OUTPUT_KEYS) delete next[key];
  return next;
}
