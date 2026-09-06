/**
 * 出图之后怎么写回节点。**纯函数**，因为这是整个功能里唯一能弄丢用户东西的地方。
 *
 * 2026-08-25 补收路由那次事故的教训：一句 `nodeData.url = urls` 把某个节点上已有的
 * 44 条视频全冲掉了。所以这里的规则写死成一条 —— **只追加，永不整体替换**，
 * 并且有测试专门盯着这一点。
 *
 * 顺手把每张图的来源标记上（`_assetGenerationMeta.model = '三维空间'`）：
 * 节点画廊和大图信息栏会显示它，别的产物写的是真实模型名，这张写清楚是自己渲的，
 * 不然过两周没人分得清这张图是不是花钱生成的。
 */
import { mergeAssetCreatedAtMap } from '@/lib/assetTimestamps'
import type { AssetGenerationMeta, CanvasNodeData, ResourceMeta } from '@/lib/types'
import type { DirectorStageState } from './types'

/** 出图在 `_assetGenerationMeta.model` 里的标记。用户在信息栏里看到的就是这几个字。 */
export const DIRECTOR_STAGE_MODEL_LABEL = '三维空间'

export interface StageRenderRecord {
  url: string
  width: number
  height: number
  createdAtMs: number
  resourceMeta?: ResourceMeta
}

/**
 * 只声明这个函数真正会读的字段，而且**全部可选**。
 *
 * 不用 `Pick<CanvasNodeData, ...>`：`_primaryAssetUrl` 这些下划线字段在 CanvasNodeData 上
 * 是靠 `extends Record<string, unknown>` 的索引签名兜住的、并没有单独声明，
 * Pick 出来会变成「必填的 unknown」，节点数据反而传不进来。
 */
export interface StageRenderTarget {
  url?: unknown
  _primaryAssetUrl?: unknown
  _assetCreatedAtMs?: Record<string, number>
  _assetGenerationMeta?: Record<string, AssetGenerationMeta>
  _resourceMeta?: { items: ResourceMeta[] }
}

function assetKeys(meta?: ResourceMeta) {
  return [meta?.originalUrl, meta?.displayUrl]
    .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
}

/**
 * 两条 resourceMeta 指的是不是同一个资产。
 *
 * 只比**两边都有值**的地址。第一版写成 `a.originalUrl !== b.originalUrl && a.displayUrl !== b.displayUrl`，
 * 而多数 meta 根本没有 displayUrl —— `undefined !== undefined` 是 false，整个 && 就塌了，
 * 结果是每次出图都把已有的 resourceMeta 全删掉。测试当场抓到。
 */
function sameAsset(a?: ResourceMeta, b?: ResourceMeta) {
  const left = assetKeys(a)
  const right = assetKeys(b)
  return left.some((url) => right.includes(url))
}

/**
 * 把一次出图并进节点数据，返回给 `updateNodeData` 的补丁。
 *
 * 几条刻意的选择：
 *   · `url` 是**追加**的，重复地址不再加一次（补收 / 重试可能给出同一个地址）；
 *   · 节点原本没有产物时才把新图设为主图 —— 已经有主图说明用户选过了，别替他改；
 *   · `_resourceMeta.items` 同样追加并按地址去重，不整个换掉。
 */
export function appendStageRender(
  data: StageRenderTarget,
  record: StageRenderRecord,
): Partial<CanvasNodeData> {
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  if (!url) return {}

  const existing = (Array.isArray(data.url) ? data.url : [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  const nextUrls = existing.includes(url) ? [...existing] : [...existing, url]

  const generationMeta: AssetGenerationMeta = {
    model: DIRECTOR_STAGE_MODEL_LABEL,
    resolution: `${Math.round(record.width)}×${Math.round(record.height)}`,
    createdAtMs: record.createdAtMs,
    outputIndex: nextUrls.indexOf(url),
  }

  const existingItems = (data._resourceMeta?.items ?? []).filter(Boolean)
  const items = record.resourceMeta
    ? [...existingItems.filter((item) => !sameAsset(item, record.resourceMeta)), record.resourceMeta]
    : existingItems

  // 已经有主图 = 用户挑过了，不替他改；原本空的才让这张顶上去
  const hadPrimary = typeof data._primaryAssetUrl === 'string' && existing.includes(data._primaryAssetUrl)

  return {
    url: nextUrls,
    action: 'image_resource',
    ...(hadPrimary ? {} : { _primaryAssetUrl: url }),
    _assetCreatedAtMs: mergeAssetCreatedAtMap(
      data._assetCreatedAtMs,
      [url, record.resourceMeta?.displayUrl, record.resourceMeta?.originalUrl],
      record.createdAtMs,
    ),
    _assetGenerationMeta: { ...(data._assetGenerationMeta ?? {}), [url]: generationMeta },
    ...(items.length > 0 ? { _resourceMeta: { items } } : {}),
    _updatedAtMs: record.createdAtMs,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 出图 → 外接一个图片节点
 *
 * 2026-08-26 你要求的：出的图走 output 连到一个图片节点，而不是只留在三维空间节点里。
 * 形状照 `features/panorama/PanoramaViewerNode.tsx` 的截图流程 —— 那边已经是
 * 「addNodeAt('image', …) + addEdge」这一套，两个功能长一样比各写一套好。
 *
 * 位置和节点数据都做成纯函数，这样能单测：**每次出图都新建一个节点**，
 * 位置必须按已有出边数错开，否则出到第三张时全叠在同一个坐标上，看着像只出了一张。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 新图片节点在 `_assetGenerationMeta` / `generatorType` 里的来源标记。 */
export const DIRECTOR_STAGE_GENERATOR = 'director-stage-render'

/** 横向留白：贴着上游节点右边会压住 resize 手柄和输出口。和全景截图取同一个值。 */
export const STAGE_RENDER_GAP_X = 140

/** 每多一条出边就往下错开这么多，避免新节点叠在上一张身上。 */
export const STAGE_RENDER_STAGGER_Y = 44

/**
 * 出图节点预览框的上限，必须和 ImageNode 的 `fitFrameToAspect(..., 520, 400, 240)` 一致。
 * 当场写进 contentWidth / contentHeight，否则 addNodeAt 会先按 620×350 撑一帧，
 * 看起来像「出图效果不对，刷新才对」。
 */
export const STAGE_RENDER_PREVIEW_MAX_WIDTH = 520
export const STAGE_RENDER_PREVIEW_MAX_HEIGHT = 400
export const STAGE_RENDER_PREVIEW_MIN_WIDTH = 240

export function stageRenderPreviewFrame(width: number, height: number) {
  const safeW = Math.max(1, Number.isFinite(width) ? width : 1)
  const safeH = Math.max(1, Number.isFinite(height) ? height : 1)
  let nextWidth = STAGE_RENDER_PREVIEW_MAX_WIDTH
  let nextHeight = nextWidth * (safeH / safeW)
  if (nextHeight > STAGE_RENDER_PREVIEW_MAX_HEIGHT) {
    nextHeight = STAGE_RENDER_PREVIEW_MAX_HEIGHT
    nextWidth = nextHeight * (safeW / safeH)
  }
  nextWidth = Math.max(STAGE_RENDER_PREVIEW_MIN_WIDTH, nextWidth)
  return { width: Math.round(nextWidth), height: Math.round(nextHeight) }
}

/**
 * 三维空间节点现在有多宽 —— 用画面上的宽度，不用落库的 contentWidth。
 *
 * 用户把节点拉宽之后 contentWidth 经常还是创建时的 420（DirectorStageNode 没开 persistResize），
 * 用那个数排新节点会叠在三维空间身上，刷新才按测量值分开（用户 2026-08-27）。
 */
export function stageRenderSourceWidth(node: {
  width?: unknown
  measured?: { width?: unknown }
  data?: { contentWidth?: unknown }
} | null | undefined) {
  for (const value of [node?.width, node?.measured?.width, node?.data?.contentWidth]) {
    const width = Number(value)
    if (Number.isFinite(width) && width > 0) return width
  }
  return 420
}

export function stageRenderNodePosition(input: {
  stageX: number
  stageY: number
  stageWidth: number
  outgoingCount: number
}) {
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback)
  const count = Math.max(0, Math.floor(finite(input.outgoingCount, 0)))
  return {
    x: finite(input.stageX, 0) + Math.max(120, finite(input.stageWidth, 420)) + STAGE_RENDER_GAP_X,
    y: finite(input.stageY, 0) + count * STAGE_RENDER_STAGGER_Y,
  }
}

export interface StageRenderNodeInput extends StageRenderRecord {
  /** 三维空间节点的 id，新节点要指回它 */
  stageNodeId: string
  stageName?: string
  /** 出这张图时的机位 / 姿势，原样记下来好追溯 */
  state: DirectorStageState
  /** `defaultImageParams()` 的结果，由调用方传进来（这个文件不依赖 nodeData） */
  baseImageParams: Record<string, unknown>
}

/**
 * 新图片节点的完整数据。
 *
 * `advancedSettings.directorStageRender` 记下这一张是怎么出来的（机位、姿势、比例、
 * 清晰度、上游节点 id）—— 和全景的 `panoramaCapture` 一个意思：过两周回来看，
 * 这张构图参考是哪个机位哪个姿势出的，不用靠猜。
 */
export function stageRenderNodeData(input: StageRenderNodeInput): Record<string, unknown> {
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  const stageRef = { nodeId: input.stageNodeId, url, mediaType: 'image' as const }
  const baseSettings = (input.baseImageParams.settings ?? {}) as Record<string, unknown>
  const frame = stageRenderPreviewFrame(input.width, input.height)

  return {
    name: `${input.stageName || '三维空间'} 出图`,
    url: [url],
    action: 'image_resource',
    sourceKind: 'derived',
    generatorType: DIRECTOR_STAGE_GENERATOR,
    contentWidth: frame.width,
    contentHeight: frame.height,
    ...(input.resourceMeta ? { _resourceMeta: { items: [input.resourceMeta] } } : {}),
    _primaryAssetUrl: url,
    _assetCreatedAtMs: { [url]: input.createdAtMs },
    _assetGenerationMeta: {
      [url]: {
        model: DIRECTOR_STAGE_MODEL_LABEL,
        resolution: `${Math.round(input.width)}×${Math.round(input.height)}`,
        createdAtMs: input.createdAtMs,
        outputIndex: 0,
      } satisfies AssetGenerationMeta,
    },
    _updatedAtMs: input.createdAtMs,
    params: {
      ...input.baseImageParams,
      prompt: '',
      // 出的是构图参考，接着往下多半是拿它当垫图重绘
      modeType: 'image2image',
      imageList: [stageRef],
      imageListOrder: [input.stageNodeId],
      mixedList: [stageRef],
      mixedListOrder: [input.stageNodeId],
      settings: {
        ...baseSettings,
        ratio: input.state.ratio,
        resolution: input.state.resolution,
      },
      advancedSettings: {
        directorStageRender: {
          version: 1,
          stageNodeId: input.stageNodeId,
          camera: input.state.camera,
          pose: input.state.pose,
          ratio: input.state.ratio,
          resolution: input.state.resolution,
          width: Math.round(input.width),
          height: Math.round(input.height),
          createdAtMs: input.createdAtMs,
        },
      },
    },
  }
}
