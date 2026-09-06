/**
 * 图片对比节点的纯逻辑。这里不碰 React、不碰 store，全部可单测。
 *
 * 和参考实现（Dexis）最大的差别：Shotflow 的连线**从不持久化**——边是
 * edgesFromNodeReferences() 从节点 params 里的引用实时推导出来的。所以 A/B 的身份不能
 * 存在 edge.targetHandle 上，必须存进节点自己的 params.compareRefA / compareRefB，
 * 跟 atmosphere_transfer 的 sourceRef / referenceRef 一个路子。
 */
import { mediaPreviewUrl } from "@/lib/mediaPreview";
import { primaryOutputUrl } from "@/lib/primaryOutput";
import type { CanvasNodeData, ResourceMeta } from "@/lib/types";

export const IMAGE_COMPARE_HANDLE_A = "compare-a";
export const IMAGE_COMPARE_HANDLE_B = "compare-b";

export type ImageCompareHandle =
  | typeof IMAGE_COMPARE_HANDLE_A
  | typeof IMAGE_COMPARE_HANDLE_B;

export type ImageCompareRefKey = "compareRefA" | "compareRefB";

export const IMAGE_COMPARE_REF_KEY: Record<
  ImageCompareHandle,
  ImageCompareRefKey
> = {
  [IMAGE_COMPARE_HANDLE_A]: "compareRefA",
  [IMAGE_COMPARE_HANDLE_B]: "compareRefB",
};

export const IMAGE_COMPARE_HANDLES: ImageCompareHandle[] = [
  IMAGE_COMPARE_HANDLE_A,
  IMAGE_COMPARE_HANDLE_B,
];

export type ImageCompareMode =
  | "side-by-side"
  | "top-bottom"
  | "wipe"
  | "opacity"
  | "difference";

export const IMAGE_COMPARE_MODE_LABELS: Record<ImageCompareMode, string> = {
  "side-by-side": "左右",
  "top-bottom": "上下",
  wipe: "滑杆",
  opacity: "透明度",
  difference: "差异",
};

/** 左右 / 上下这两种是并排看，其余三种是两图重叠 */
export function isImageCompareSplitMode(mode: ImageCompareMode) {
  return mode === "side-by-side" || mode === "top-bottom";
}

/** 存进画布的引用。只有 id / url / 名字，绝不存图片字节或 base64。 */
export interface ImageCompareRef {
  nodeId: string;
  url: string;
  name: string;
}

/** 渲染时从上游节点解析出来的一路输入。不进画布数据。 */
export interface ImageCompareInput {
  nodeId: string;
  title: string;
  /** 节点上的小图用这个（走 Shotflow 现成的缩略图解析） */
  previewUrl: string;
  /** 全屏用这个（原图） */
  fullUrl: string;
  width: number | null;
  height: number | null;
}

type NodeLike = { id: string; data: CanvasNodeData & { nodeKey?: string } };

const VIDEO_URL_PATTERN = /\.(mp4|mov|m4v|webm|avi|mkv)(\?|#|$)/i;

/** 能当对比输入的节点类型。刻意不含 video / video_merge / text / audio / script / group。 */
const COMPARE_SOURCE_TYPES = new Set(["image", "upload", "director_stage"]);

const KNOWN_MODES = new Set<string>([
  "side-by-side",
  "top-bottom",
  "wipe",
  "opacity",
  "difference",
]);

export function normalizeImageCompareMode(value: unknown): ImageCompareMode {
  return KNOWN_MODES.has(String(value))
    ? (String(value) as ImageCompareMode)
    : "side-by-side";
}

/** 两张图尺寸不一致时，叠加/差异对比会误导人，节点和查看器都要提示。 */
export function imageCompareSizeMismatch(
  inputA: ImageCompareInput | null,
  inputB: ImageCompareInput | null,
): boolean {
  if (!inputA?.width || !inputA.height || !inputB?.width || !inputB.height) {
    return false;
  }
  return inputA.width !== inputB.width || inputA.height !== inputB.height;
}

export function isImageCompareHandle(
  value: unknown,
): value is ImageCompareHandle {
  return value === IMAGE_COMPARE_HANDLE_A || value === IMAGE_COMPARE_HANDLE_B;
}

export function isImageCompareNodeData(
  data: { type?: unknown } | null | undefined,
): boolean {
  return String(data?.type ?? "") === "image_compare";
}

/**
 * 上游对外的那一张（主图优先）。逻辑挪到 primaryOutput 里跟别的节点共用了 ——
 * 唯一的行为差别是：主图指向一个已经被删掉的产物时退回第一张，
 * 而不是继续用那个悬空地址。
 */
function firstUrl(data: CanvasNodeData | null | undefined): string {
  return primaryOutputUrl(data);
}

/**
 * 这个节点能不能当对比的输入。
 *
 * 只收图片：功能契约明确要求拒收视频、文本、音频、分组和对比节点自身。upload 节点既可能
 * 是图也可能是视频，按 url 后缀判。对比节点自己不产出图片，所以不能当源（也就不存在
 * 对比节点串联）。
 */
export function canBeImageCompareSource(
  data: CanvasNodeData | null | undefined,
): boolean {
  if (!data) return false;
  const type = String(data.type ?? "");
  if (!COMPARE_SOURCE_TYPES.has(type)) return false;
  const url = firstUrl(data);
  if (url && VIDEO_URL_PATTERN.test(url)) return false;
  return true;
}

/** 连线落在节点体上（没指定槽）时：A 空占 A，A 满占 B。 */
export function resolveImageCompareHandle(
  requested: unknown,
  occupied: { compareRefA?: unknown; compareRefB?: unknown },
): ImageCompareHandle {
  if (isImageCompareHandle(requested)) return requested;
  const aTaken = Boolean(
    (occupied.compareRefA as ImageCompareRef | null | undefined)?.nodeId,
  );
  return aTaken ? IMAGE_COMPARE_HANDLE_B : IMAGE_COMPARE_HANDLE_A;
}

export function compareRefFromNode(
  nodeId: string,
  data: CanvasNodeData,
): ImageCompareRef {
  return {
    nodeId,
    url: firstUrl(data),
    name: String(data.name || "图片"),
  };
}

export function readImageCompareRefs(data: CanvasNodeData | null | undefined) {
  const params = (data?.params ?? {}) as Record<string, unknown>;
  const read = (key: ImageCompareRefKey): ImageCompareRef | null => {
    const value = params[key] as ImageCompareRef | null | undefined;
    return value?.nodeId ? value : null;
  };
  return { compareRefA: read("compareRefA"), compareRefB: read("compareRefB") };
}

export type ImageCompareAssignment =
  | { ok: true; handle: ImageCompareHandle; refKey: ImageCompareRefKey }
  | { ok: false; reason: "self" | "not-image" | "duplicate-source" };

/**
 * 一次连线该怎么落到 A/B 上。全部规则都在这里，router 只负责执行。
 *
 * 注意 ok:false 也不代表"这条连线不归对比节点管"——目标是对比节点时，调用方必须
 * 无论如何都算自己处理过，否则会掉进通用的 applyConnection，把源节点塞进
 * params.imageList，给对比节点挂上一条它根本不认的引用。
 */
export function planImageCompareAssignment(args: {
  sourceNodeId: string;
  sourceData: CanvasNodeData | null | undefined;
  targetNodeId: string;
  targetData: CanvasNodeData;
  requestedHandle?: unknown;
}): ImageCompareAssignment {
  const { sourceNodeId, sourceData, targetNodeId, targetData } = args;
  if (!sourceNodeId || sourceNodeId === targetNodeId) {
    return { ok: false, reason: "self" };
  }
  if (!canBeImageCompareSource(sourceData)) {
    return { ok: false, reason: "not-image" };
  }
  const refs = readImageCompareRefs(targetData);
  const handle = resolveImageCompareHandle(args.requestedHandle, refs);
  const refKey = IMAGE_COMPARE_REF_KEY[handle];
  const otherKey: ImageCompareRefKey =
    refKey === "compareRefA" ? "compareRefB" : "compareRefA";
  // 同一张图不许同时占 A 和 B
  if (refs[otherKey]?.nodeId === sourceNodeId) {
    return { ok: false, reason: "duplicate-source" };
  }
  return { ok: true, handle, refKey };
}

function metaForUrl(
  data: CanvasNodeData,
  url: string,
): ResourceMeta | undefined {
  const items = (data._resourceMeta?.items ?? []) as ResourceMeta[];
  return (
    items.find((item) => item?.originalUrl === url || item?.displayUrl === url) ??
    items[0]
  );
}

function resolveOne(
  ref: ImageCompareRef | null,
  nodes: NodeLike[],
): ImageCompareInput | null {
  if (!ref?.nodeId) return null;
  const upstream = nodes.find(
    (node) => node.id === ref.nodeId || node.data.nodeKey === ref.nodeId,
  );
  // 上游被删掉了：退回引用里记的 url，仍然能看；连 url 都没有才算没准备好。
  const data = upstream?.data;
  const fullUrl = (data ? firstUrl(data) : "") || ref.url || "";
  if (!fullUrl) return null;
  if (data && !canBeImageCompareSource(data)) return null;
  const meta = data ? metaForUrl(data, fullUrl) : undefined;
  return {
    nodeId: ref.nodeId,
    title: String(data?.name || ref.name || "图片"),
    previewUrl: data ? mediaPreviewUrl(data, fullUrl) || fullUrl : fullUrl,
    fullUrl,
    width: Number(meta?.width) || null,
    height: Number(meta?.height) || null,
  };
}

export function resolveImageCompareInputs(
  data: CanvasNodeData | null | undefined,
  nodes: NodeLike[],
) {
  const refs = readImageCompareRefs(data);
  const inputA = resolveOne(refs.compareRefA, nodes);
  const inputB = resolveOne(refs.compareRefB, nodes);
  return {
    inputA,
    inputB,
    connectedCount: (inputA ? 1 : 0) + (inputB ? 1 : 0),
    ready: Boolean(inputA && inputB),
  };
}

/**
 * 上游节点被删除时清掉对应的槽。返回 null 表示没有变化。
 * （Canvas.tsx 的 removeEdgeReferencesFromNodes 对 panoramaRef 也是这么做的。）
 */
export function clearedImageCompareRefs(
  params: Record<string, unknown>,
  removedNodeIds: Set<string>,
): Partial<Record<ImageCompareRefKey, null>> | null {
  const patch: Partial<Record<ImageCompareRefKey, null>> = {};
  for (const key of ["compareRefA", "compareRefB"] as ImageCompareRefKey[]) {
    const ref = params[key] as ImageCompareRef | null | undefined;
    if (ref?.nodeId && removedNodeIds.has(String(ref.nodeId))) patch[key] = null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export function imageCompareResolutionLabel(
  input: ImageCompareInput | null,
): string {
  if (!input) return "";
  if (input.width && input.height) return `${input.width}×${input.height}`;
  return "尺寸未知";
}
