/**
 * 视频对比节点的纯逻辑。不碰 React、不碰 store，全部可单测。
 *
 * 和图片对比一样：Shotflow 的连线从不持久化，边是从节点 params 里的引用实时推导的。
 * 所以槽位身份必须存进 params.compareRefA..D。
 *
 * 交互参考：
 * - 左右 / 四宫格播放：https://github.com/LiangrunDa/video-compare
 * - 四宫格排版：https://github.com/aericocode/infiniVids
 * - 导出对比片：浏览器 canvas 合成（不重启后端、不走 ffmpeg）
 */
import { mediaPreviewUrl } from "@/lib/mediaPreview";
import { primaryOutputUrl } from "@/lib/primaryOutput";
import type { CanvasNodeData, ResourceMeta } from "@/lib/types";

export const VIDEO_COMPARE_HANDLES = [
  "compare-a",
  "compare-b",
  "compare-c",
  "compare-d",
] as const;

export type VideoCompareHandle = (typeof VIDEO_COMPARE_HANDLES)[number];

export type VideoCompareRefKey =
  | "compareRefA"
  | "compareRefB"
  | "compareRefC"
  | "compareRefD";

export const VIDEO_COMPARE_REF_KEY: Record<VideoCompareHandle, VideoCompareRefKey> = {
  "compare-a": "compareRefA",
  "compare-b": "compareRefB",
  "compare-c": "compareRefC",
  "compare-d": "compareRefD",
};

export const VIDEO_COMPARE_SLOTS: Array<{
  handle: VideoCompareHandle;
  refKey: VideoCompareRefKey;
  letter: "A" | "B" | "C" | "D";
}> = [
  { handle: "compare-a", refKey: "compareRefA", letter: "A" },
  { handle: "compare-b", refKey: "compareRefB", letter: "B" },
  { handle: "compare-c", refKey: "compareRefC", letter: "C" },
  { handle: "compare-d", refKey: "compareRefD", letter: "D" },
];

export type VideoCompareMode = "side-by-side" | "quad";

export const VIDEO_COMPARE_MODE_LABELS: Record<VideoCompareMode, string> = {
  "side-by-side": "左右",
  quad: "四宫格",
};

export interface VideoCompareRef {
  nodeId: string;
  url: string;
  name: string;
}

export interface VideoCompareInput {
  nodeId: string;
  title: string;
  previewUrl: string;
  fullUrl: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

type NodeLike = { id: string; data: CanvasNodeData & { nodeKey?: string } };

const VIDEO_URL_PATTERN = /\.(mp4|mov|m4v|webm|avi|mkv)(\?|#|$)/i;
const IMAGE_URL_PATTERN = /\.(png|jpe?g|webp|gif|bmp|svg)(\?|#|$)/i;

const COMPARE_SOURCE_TYPES = new Set(["video", "upload", "video_merge"]);
const KNOWN_MODES = new Set<string>(["side-by-side", "quad"]);

export function normalizeVideoCompareMode(value: unknown): VideoCompareMode {
  return KNOWN_MODES.has(String(value))
    ? (String(value) as VideoCompareMode)
    : "side-by-side";
}

export function isVideoCompareHandle(value: unknown): value is VideoCompareHandle {
  return VIDEO_COMPARE_HANDLES.includes(value as VideoCompareHandle);
}

/** 删边时优先用 targetHandle；旧线 / 重建丢了 handle 时从 id 尾巴认槽。 */
export function videoCompareHandleFromEdge(edge: {
  id?: unknown;
  targetHandle?: unknown;
}): VideoCompareHandle | null {
  if (isVideoCompareHandle(edge.targetHandle)) return edge.targetHandle;
  const id = String(edge.id ?? "");
  const matched = VIDEO_COMPARE_HANDLES.find(
    (handle) => id === handle || id.endsWith(`-${handle}`),
  );
  return matched ?? null;
}

export function isVideoCompareNodeData(
  data: { type?: unknown } | null | undefined,
): boolean {
  return String(data?.type ?? "") === "video_compare";
}

function firstUrl(data: CanvasNodeData | null | undefined): string {
  return primaryOutputUrl(data);
}

function usableUrls(data: CanvasNodeData | null | undefined): string[] {
  if (!Array.isArray(data?.url)) return [];
  return (data.url as unknown[]).filter(
    (url): url is string => typeof url === "string" && url.trim().length > 0,
  );
}

/** 多视频节点里可选的每一条，展开对比节点后用来换非封面。 */
export function listVideoCompareSourceClips(data: CanvasNodeData | null | undefined) {
  const urls = usableUrls(data);
  const primary = firstUrl(data);
  return urls.map((url, index) => ({
    url,
    order: index + 1,
    isCover: url === primary,
  }));
}

export function pickVideoCompareUrl(
  data: CanvasNodeData | null | undefined,
  preferredUrl?: string,
) {
  const urls = usableUrls(data);
  if (preferredUrl && urls.includes(preferredUrl)) return preferredUrl;
  return firstUrl(data);
}

export function canBeVideoCompareSource(
  data: CanvasNodeData | null | undefined,
): boolean {
  if (!data) return false;
  const type = String(data.type ?? "");
  if (!COMPARE_SOURCE_TYPES.has(type)) return false;
  const url = firstUrl(data);
  if (!url) return type === "video" || type === "video_merge";
  if (IMAGE_URL_PATTERN.test(url) && !VIDEO_URL_PATTERN.test(url)) return false;
  return true;
}

export function resolveVideoCompareHandle(
  requested: unknown,
  occupied: Partial<Record<VideoCompareRefKey, unknown>>,
): VideoCompareHandle {
  if (isVideoCompareHandle(requested)) return requested;
  for (const slot of VIDEO_COMPARE_SLOTS) {
    const taken = Boolean(
      (occupied[slot.refKey] as VideoCompareRef | null | undefined)?.nodeId,
    );
    if (!taken) return slot.handle;
  }
  return "compare-d";
}

export function compareVideoRefFromNode(
  nodeId: string,
  data: CanvasNodeData,
  preferredUrl?: string,
): VideoCompareRef {
  return {
    nodeId,
    url: pickVideoCompareUrl(data, preferredUrl),
    name: String(data.name || "视频"),
  };
}

export function nextUnusedVideoCompareUrl(
  data: CanvasNodeData | null | undefined,
  occupiedUrls: string[],
) {
  const clips = listVideoCompareSourceClips(data);
  const taken = new Set(occupiedUrls.filter(Boolean));
  const unused = clips.find((clip) => !taken.has(clip.url));
  return unused?.url || firstUrl(data);
}

export function readVideoCompareRefs(data: CanvasNodeData | null | undefined) {
  const params = (data?.params ?? {}) as Record<string, unknown>;
  const read = (key: VideoCompareRefKey): VideoCompareRef | null => {
    const value = params[key] as VideoCompareRef | null | undefined;
    return value?.nodeId ? value : null;
  };
  return {
    compareRefA: read("compareRefA"),
    compareRefB: read("compareRefB"),
    compareRefC: read("compareRefC"),
    compareRefD: read("compareRefD"),
  };
}

export type VideoCompareAssignment =
  | { ok: true; handle: VideoCompareHandle; refKey: VideoCompareRefKey }
  | { ok: false; reason: "self" | "not-video" };

export function planVideoCompareAssignment(args: {
  sourceNodeId: string;
  sourceData: CanvasNodeData | null | undefined;
  targetNodeId: string;
  targetData: CanvasNodeData;
  requestedHandle?: unknown;
}): VideoCompareAssignment {
  const { sourceNodeId, sourceData, targetNodeId, targetData } = args;
  if (!sourceNodeId || sourceNodeId === targetNodeId) {
    return { ok: false, reason: "self" };
  }
  if (!canBeVideoCompareSource(sourceData)) {
    return { ok: false, reason: "not-video" };
  }
  const refs = readVideoCompareRefs(targetData);
  const handle = resolveVideoCompareHandle(args.requestedHandle, refs);
  const refKey = VIDEO_COMPARE_REF_KEY[handle];
  return { ok: true, handle, refKey };
}

function metaForUrl(data: CanvasNodeData, url: string): ResourceMeta | undefined {
  const items = (data._resourceMeta?.items ?? []) as ResourceMeta[];
  return (
    items.find((item) => item?.originalUrl === url || item?.displayUrl === url) ??
    items[0]
  );
}

function resolveOne(
  ref: VideoCompareRef | null,
  nodes: NodeLike[],
): VideoCompareInput | null {
  if (!ref?.nodeId) return null;
  const upstream = nodes.find(
    (node) => node.id === ref.nodeId || node.data.nodeKey === ref.nodeId,
  );
  const data = upstream?.data;
  const fullUrl = (data ? pickVideoCompareUrl(data, ref.url) : "") || ref.url || "";
  if (!fullUrl) return null;
  if (data && !canBeVideoCompareSource(data)) return null;
  const meta = data ? metaForUrl(data, fullUrl) : undefined;
  const clips = data ? listVideoCompareSourceClips(data) : [];
  const clip = clips.find((item) => item.url === fullUrl);
  const baseTitle = String(data?.name || ref.name || "视频");
  const title = clip && clips.length > 1
    ? `${baseTitle} · ${clip.order}`
    : baseTitle;
  return {
    nodeId: ref.nodeId,
    title,
    previewUrl: data ? mediaPreviewUrl(data, fullUrl) || fullUrl : fullUrl,
    fullUrl,
    width: Number(meta?.width || meta?.displayWidth) || null,
    height: Number(meta?.height || meta?.displayHeight) || null,
    durationSec: Number(meta?.durationSec || meta?.displayDurationSec) || null,
  };
}

export function resolveVideoCompareInputs(
  data: CanvasNodeData | null | undefined,
  nodes: NodeLike[],
) {
  const refs = readVideoCompareRefs(data);
  const inputA = resolveOne(refs.compareRefA, nodes);
  const inputB = resolveOne(refs.compareRefB, nodes);
  const inputC = resolveOne(refs.compareRefC, nodes);
  const inputD = resolveOne(refs.compareRefD, nodes);
  const inputs = [inputA, inputB, inputC, inputD];
  const connected = inputs.filter((item): item is VideoCompareInput => Boolean(item));
  const storedMode = (data?.params as Record<string, unknown> | undefined)?.compareMode;
  const mode = connected.length >= 3
    ? "quad"
    : normalizeVideoCompareMode(storedMode);
  const ready = mode === "quad" ? connected.length >= 3 : Boolean(inputA && inputB);
  return {
    inputA,
    inputB,
    inputC,
    inputD,
    inputs,
    connected,
    connectedCount: connected.length,
    ready,
    mode,
  };
}

export function clearedVideoCompareRefs(
  params: Record<string, unknown>,
  removedNodeIds: Set<string>,
  removedHandles?: Iterable<unknown>,
  removedEdgeCount?: number,
): Partial<Record<VideoCompareRefKey, null>> | null {
  const patch: Partial<Record<VideoCompareRefKey, null>> = {};
  const handleKeys = new Set<VideoCompareRefKey>();
  const edgeScoped = removedHandles !== undefined;
  for (const handle of removedHandles ?? []) {
    if (isVideoCompareHandle(handle)) handleKeys.add(VIDEO_COMPARE_REF_KEY[handle]);
  }
  const matchingSlots = VIDEO_COMPARE_SLOTS.filter((slot) => {
    const ref = params[slot.refKey] as VideoCompareRef | null | undefined;
    return Boolean(ref?.nodeId && removedNodeIds.has(String(ref.nodeId)));
  });
  if (matchingSlots.length === 0) return null;

  // 删边：只清这条线对应的槽。handle 认不出时按删了几条清几格，绝不把没删的槽连坐掉。
  // 上游节点被删（不传 handles）：才按节点 id 清全部匹配槽。
  const unnamedCount = Math.max(1, Math.floor(Number(removedEdgeCount) || 0));
  const slotsToClear = !edgeScoped
    ? matchingSlots
    : handleKeys.size > 0
      ? matchingSlots.filter((slot) => handleKeys.has(slot.refKey))
      : matchingSlots.slice(0, unnamedCount);

  for (const slot of slotsToClear) patch[slot.refKey] = null;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function videoCompareResolutionLabel(input: VideoCompareInput | null): string {
  if (!input) return "";
  if (input.width && input.height) return `${input.width}×${input.height}`;
  return "尺寸未知";
}

export function videoCompareDurationLabel(input: VideoCompareInput | null): string {
  if (!input?.durationSec || input.durationSec <= 0) return "";
  return `${input.durationSec.toFixed(input.durationSec >= 10 ? 0 : 1)}s`;
}
