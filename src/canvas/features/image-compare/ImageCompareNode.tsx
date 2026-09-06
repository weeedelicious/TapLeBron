import { useCallback, useMemo, useState } from "react";
import { addEdge, Handle, Position } from "@xyflow/react";
import { Columns2, Expand } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { assetsApi } from "@/lib/api";
import { defaultImageParams } from "@/lib/nodeData";
import { resourceMetaFromUploadPayload } from "@/lib/whiteboard";
import type { CanvasNodeData } from "@/lib/types";
import {
  IMAGE_COMPARE_HANDLE_A,
  IMAGE_COMPARE_HANDLE_B,
  IMAGE_COMPARE_MODE_LABELS,
  imageCompareResolutionLabel,
  imageCompareSizeMismatch,
  normalizeImageCompareMode,
  resolveImageCompareInputs,
  type ImageCompareInput,
} from "./image-compare";
import {
  STITCH_DIRECTION_LABELS,
  renderStitchedFile,
  type StitchDirection,
} from "./image-compare-stitch";
import { ImageCompareViewerModal } from "./ImageCompareViewerModal";
import "./image-compare.css";

const NODE_WIDTH = 330;
/** 拼接图节点放在对比节点右边多远 */
const OUTPUT_OFFSET_X = NODE_WIDTH + 140;

interface Props {
  id: string;
  data: CanvasNodeData & { nodeKey: string; projectUuid: string };
  selected?: boolean;
}

function CompareSlot({
  label,
  input,
}: {
  label: "A" | "B";
  input: ImageCompareInput | null;
}) {
  return (
    <div className={`image-compare-slot${input ? " has-image" : ""}`}>
      <span className="image-compare-slot-letter">{label}</span>
      {input ? (
        <img src={input.previewUrl} alt={input.title} draggable={false} />
      ) : (
        <span className="image-compare-slot-empty">连接图片</span>
      )}
      <div className="image-compare-slot-meta">
        <strong title={input?.title}>{input?.title || `图片 ${label}`}</strong>
        <small>{input ? imageCompareResolutionLabel(input) : "未连接"}</small>
      </div>
    </div>
  );
}

export function ImageCompareNode({ id, data, selected }: Props) {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const addNodeAt = useCanvasStore((state) => state.addNodeAt);
  const setEdges = useCanvasStore((state) => state.setEdges);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const params = (data.params ?? {}) as Record<string, unknown>;
  const mode = normalizeImageCompareMode(params.compareMode);
  const { inputA, inputB, connectedCount, ready } = useMemo(
    () => resolveImageCompareInputs(data, nodes),
    [data, nodes],
  );

  const openViewer = () => {
    if (ready) setViewerOpen(true);
  };

  /**
   * 导出左右拼接图：渲染 canvas → 上传成资产 → 新建一个图片节点 → 连一条 capture 边。
   * 完全照 PanoramaViewerNode.captureViewpoint 的形状来，那条路在生产上跑了很久。
   */
  const exportStitched = useCallback(async (direction: StitchDirection) => {
    if (!inputA || !inputB || exporting) return;
    setExporting(true);
    setExportError("");
    try {
      const stitched = await renderStitchedFile({
        urlA: inputA.fullUrl,
        urlB: inputB.fullUrl,
        titleA: inputA.title,
        titleB: inputB.title,
        direction,
      });
      const directionLabel = STITCH_DIRECTION_LABELS[stitched.direction];
      const uploaded = await assetsApi.upload(data.projectUuid, stitched.file);
      const resourceMeta = resourceMetaFromUploadPayload(
        uploaded.meta as Record<string, unknown> | undefined,
        "image",
      );
      const selfNode = nodes.find(
        (node) => node.id === id || node.data.nodeKey === id,
      );
      const outgoingCount = edges.filter((edge) => edge.source === id).length;
      const createdAtMs = Date.now();
      const baseImageParams = defaultImageParams();
      const compareOutputRef = {
        nodeId: id,
        url: uploaded.url,
        mediaType: "image" as const,
      };
      const outputNode = addNodeAt(
        "image",
        (selfNode?.position.x ?? 0) + OUTPUT_OFFSET_X,
        (selfNode?.position.y ?? 0) + outgoingCount * 44,
        {
          name: `对比拼接${directionLabel}｜${inputA.title} + ${inputB.title}`.slice(
            0,
            60,
          ),
          url: [uploaded.url],
          action: "image_resource",
          sourceKind: "derived",
          generatorType: "image-compare-side-by-side",
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          _primaryAssetUrl: uploaded.url,
          _assetCreatedAtMs: { [uploaded.url]: createdAtMs },
          _updatedAtMs: createdAtMs,
          params: {
            ...baseImageParams,
            prompt: "",
            modeType: "image2image",
            imageList: [compareOutputRef],
            imageListOrder: [id],
            mixedList: [compareOutputRef],
            mixedListOrder: [id],
            settings: {
              ...baseImageParams.settings,
              ratio: `${stitched.width}:${stitched.height}`,
            },
            advancedSettings: {
              imageCompareStitch: {
                version: 1,
                direction: stitched.direction,
                compareNodeId: id,
                sourceANodeId: inputA.nodeId,
                sourceBNodeId: inputB.nodeId,
                width: stitched.width,
                height: stitched.height,
                createdAtMs,
              },
            },
          } as unknown as Record<string, unknown>,
        },
      );
      // 对比节点自己也记一份产出，跟全景查看器一致（右上角能看出已经导出过）
      const existing = Array.isArray(data.url) ? data.url : [];
      updateNodeData(id, {
        url: [uploaded.url, ...existing.filter((url) => url !== uploaded.url)],
        _primaryAssetUrl: uploaded.url,
        _updatedAtMs: createdAtMs,
      });
      const edgeId = `e-${id}-${outputNode.id}-compare-stitch-${stitched.direction}`;
      if (!edges.some((edge) => edge.id === edgeId)) {
        setEdges(
          addEdge(
            {
              id: edgeId,
              source: id,
              sourceHandle: "capture",
              target: outputNode.id,
              type: "glow",
              selectable: true,
              interactionWidth: 34,
            },
            edges,
          ),
        );
      }
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "拼接失败，请重试",
      );
    } finally {
      setExporting(false);
    }
  }, [
    addNodeAt,
    data.projectUuid,
    data.url,
    edges,
    exporting,
    id,
    inputA,
    inputB,
    nodes,
    setEdges,
    updateNodeData,
  ]);

  return (
    <div
      className={`image-compare-node${selected ? " is-selected" : ""}`}
      style={{ width: NODE_WIDTH }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        openViewer();
      }}
    >
      <Handle
        id={IMAGE_COMPARE_HANDLE_A}
        type="target"
        position={Position.Left}
        className="image-compare-node-handle image-compare-node-handle-a"
      />
      <Handle
        id={IMAGE_COMPARE_HANDLE_B}
        type="target"
        position={Position.Left}
        className="image-compare-node-handle image-compare-node-handle-b"
      />
      <Handle
        id="capture"
        type="source"
        position={Position.Right}
        className="image-compare-node-handle image-compare-node-output-handle"
      />

      <header className="image-compare-node-header">
        <div>
          <Columns2 size={15} strokeWidth={1.9} />
          <strong>图片对比</strong>
          <span>{ready ? "就绪" : `${connectedCount}/2`}</span>
        </div>
        <div className="image-compare-node-actions nodrag">
          <button
            type="button"
            disabled={!ready}
            title={ready ? "打开对比" : "请先连接两张图片"}
            aria-label="打开对比"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openViewer();
            }}
          >
            <Expand size={14} />
          </button>
        </div>
      </header>

      <div className="image-compare-node-slots">
        <CompareSlot label="A" input={inputA} />
        <CompareSlot label="B" input={inputB} />
      </div>

      <footer className="image-compare-node-footer">
        <span>
          {exportError
            ? exportError
            : exporting
              ? "正在拼接并上传…"
              : ready
                ? "双击打开对比 · 在弹窗里导出拼接图"
                : connectedCount === 1
                  ? "还差一张图片"
                  : "连接两个图片节点的输出"}
        </span>
        {ready && imageCompareSizeMismatch(inputA, inputB) ? (
          <i title="两张图尺寸不同，叠加/差异对比会有偏差；拼接时会按同一高度缩放">
            尺寸不同
          </i>
        ) : null}
        <b>{IMAGE_COMPARE_MODE_LABELS[mode]}</b>
      </footer>

      {viewerOpen && inputA && inputB ? (
        <ImageCompareViewerModal
          inputA={inputA}
          inputB={inputB}
          initialMode={mode}
          exporting={exporting}
          onExportStitched={(direction) => void exportStitched(direction)}
          onClose={() => setViewerOpen(false)}
        />
      ) : null}
    </div>
  );
}
