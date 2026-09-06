import { useCallback, useMemo, useState } from "react";
import { addEdge, Handle, Position } from "@xyflow/react";
import { Columns2, Expand } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { assetsApi } from "@/lib/api";
import { defaultVideoParams } from "@/lib/nodeData";
import { resourceMetaFromUploadPayload } from "@/lib/whiteboard";
import type { CanvasNodeData } from "@/lib/types";
import {
  VIDEO_COMPARE_MODE_LABELS,
  VIDEO_COMPARE_SLOTS,
  listVideoCompareSourceClips,
  readVideoCompareRefs,
  resolveVideoCompareInputs,
  videoCompareDurationLabel,
  videoCompareResolutionLabel,
  type VideoCompareInput,
  type VideoCompareMode,
  type VideoCompareRefKey,
} from "./video-compare";
import {
  renderComparedVideoFile,
  VIDEO_COMPARE_UPLOAD_OPTIONS,
} from "./video-compare-export";
import { VideoCompareViewerModal } from "./VideoCompareViewerModal";
import "./video-compare.css";

const NODE_WIDTH = 330;
const OUTPUT_OFFSET_X = NODE_WIDTH + 140;

interface Props {
  id: string;
  data: CanvasNodeData & { nodeKey: string; projectUuid: string };
  selected?: boolean;
}

function CompareSlot({
  letter,
  input,
  clips,
  onPickUrl,
}: {
  letter: "A" | "B" | "C" | "D";
  input: VideoCompareInput | null;
  clips: Array<{ url: string; order: number; isCover: boolean }>;
  onPickUrl?: (url: string) => void;
}) {
  return (
    <div className={`video-compare-slot${input ? " has-video" : ""}`}>
      {input ? (
        <video src={input.previewUrl} muted playsInline preload="metadata" />
      ) : (
        <span className="video-compare-slot-empty">连接视频</span>
      )}
      <div className="video-compare-slot-meta">
        <strong title={input?.title}>{input?.title || "未连接"}</strong>
        <small>
          {input
            ? [videoCompareResolutionLabel(input), videoCompareDurationLabel(input)].filter(Boolean).join(" · ") || "已连接"
            : "未连接"}
        </small>
        {clips.length > 1 && onPickUrl ? (
          <select
            className="nodrag video-compare-slot-pick"
            value={input?.fullUrl || clips[0].url}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onPickUrl(event.target.value)}
          >
            {clips.map((clip) => (
              <option key={clip.url} value={clip.url}>
                {clip.isCover ? `第${clip.order}条 · 封面` : `第${clip.order}条`}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}

export function VideoCompareNode({ id, data, selected }: Props) {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const addNodeAt = useCanvasStore((state) => state.addNodeAt);
  const setEdges = useCanvasStore((state) => state.setEdges);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const resolved = useMemo(
    () => resolveVideoCompareInputs(data, nodes),
    [data, nodes],
  );
  const { connected, connectedCount, ready, mode, inputs } = resolved;

  const setMode = (next: VideoCompareMode) => {
    updateNodeData(id, {
      params: {
        ...((data.params ?? {}) as Record<string, unknown>),
        compareMode: next,
      },
    });
  };

  const openViewer = () => {
    if (!ready) return;
    if (connectedCount >= 3 && mode !== "quad") setMode("quad");
    setViewerOpen(true);
  };

  const pickSlotUrl = useCallback((refKey: VideoCompareRefKey, url: string) => {
    const refs = readVideoCompareRefs(data);
    const current = refs[refKey];
    if (!current) return;
    updateNodeData(id, {
      params: {
        ...((data.params ?? {}) as Record<string, unknown>),
        [refKey]: { ...current, url },
      },
    });
  }, [data, id, updateNodeData]);

  const exportCompared = useCallback(async (exportMode: VideoCompareMode) => {
    if (!ready || exporting) return;
    const exportInputs = exportMode === "quad" ? connected.slice(0, 4) : connected.slice(0, 2);
    if (exportMode === "quad" && exportInputs.length < 3) {
      setExportError("四宫格至少需要 3 条视频");
      return;
    }
    setExporting(true);
    setExportError("");
    try {
      const compared = await renderComparedVideoFile({
        inputs: exportInputs,
        kind: exportMode,
      });
      const uploaded = await assetsApi.upload(
        data.projectUuid,
        compared.file,
        undefined,
        VIDEO_COMPARE_UPLOAD_OPTIONS,
      );
      const uploadedMimeType = String(uploaded.meta?.mimeType || "").toLowerCase();
      if (!/\.mp4(?:$|[?#])/i.test(uploaded.url) || uploadedMimeType !== "video/mp4") {
        throw new Error("服务端没有返回有效的 MP4 视频，请重试");
      }
      const resourceMeta = resourceMetaFromUploadPayload(
        uploaded.meta as Record<string, unknown> | undefined,
        "video",
      );
      const outputWidth = resourceMeta?.width || compared.width;
      const outputHeight = resourceMeta?.height || compared.height;
      const selfNode = nodes.find((node) => node.id === id || node.data.nodeKey === id);
      const outgoingCount = edges.filter((edge) => edge.source === id).length;
      const createdAtMs = Date.now();
      const baseVideoParams = defaultVideoParams();
      const compareOutputRef = {
        nodeId: id,
        url: uploaded.url,
        mediaType: "video" as const,
      };
      const title = exportInputs.map((item) => item.title).join(" + ");
      const outputNode = addNodeAt(
        "video",
        (selfNode?.position.x ?? 0) + OUTPUT_OFFSET_X,
        (selfNode?.position.y ?? 0) + outgoingCount * 44,
        {
          name: `视频对比${VIDEO_COMPARE_MODE_LABELS[exportMode]}｜${title}`.slice(0, 60),
          url: [uploaded.url],
          action: "video_generate",
          sourceKind: "derived",
          generatorType: "video-compare",
          ...(resourceMeta ? { _resourceMeta: { items: [resourceMeta] } } : {}),
          _primaryAssetUrl: uploaded.url,
          _assetCreatedAtMs: { [uploaded.url]: createdAtMs },
          _updatedAtMs: createdAtMs,
          params: {
            ...baseVideoParams,
            prompt: "",
            modeType: "video2video",
            videoList: [compareOutputRef],
            mixedList: [compareOutputRef],
            mixedListOrder: [id],
            settings: {
              ...baseVideoParams.settings,
              ratio: `${outputWidth}:${outputHeight}`,
            },
            advancedSettings: {
              videoCompareExport: {
                version: 1,
                kind: compared.kind,
                compareNodeId: id,
                sourceNodeIds: exportInputs.map((item) => item.nodeId),
                width: outputWidth,
                height: outputHeight,
                durationSec: resourceMeta?.durationSec || compared.durationSec,
                format: "mp4",
                mimeType: "video/mp4",
                createdAtMs,
              },
            },
          } as unknown as Record<string, unknown>,
        },
      );
      const existing = Array.isArray(data.url) ? data.url : [];
      updateNodeData(id, {
        url: [uploaded.url, ...existing.filter((url) => url !== uploaded.url)],
        _primaryAssetUrl: uploaded.url,
        _updatedAtMs: createdAtMs,
      });
      const edgeId = `e-${id}-${outputNode.id}-video-compare-${compared.kind}`;
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
      setExportError(error instanceof Error ? error.message : "导出失败，请重试");
    } finally {
      setExporting(false);
    }
  }, [
    addNodeAt,
    connected,
    data.projectUuid,
    data.url,
    edges,
    exporting,
    id,
    nodes,
    ready,
    setEdges,
    updateNodeData,
  ]);

  return (
    <div
      className={`video-compare-node${selected ? " is-selected" : ""}`}
      style={{ width: NODE_WIDTH }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        openViewer();
      }}
    >
      {VIDEO_COMPARE_SLOTS.map((slot) => (
        <Handle
          key={slot.handle}
          id={slot.handle}
          type="target"
          position={Position.Left}
          className={`video-compare-node-handle video-compare-node-handle-${slot.letter.toLowerCase()}`}
        />
      ))}
      <Handle
        id="capture"
        type="source"
        position={Position.Right}
        className="video-compare-node-handle video-compare-node-output-handle"
      />

      <header className="video-compare-node-header">
        <div>
          <Columns2 size={15} strokeWidth={1.9} />
          <strong>视频对比</strong>
          <span>{ready ? "就绪" : `${connectedCount}/${mode === "quad" ? "3+" : "2"}`}</span>
        </div>
        <div className="video-compare-node-actions nodrag">
          <button
            type="button"
            disabled={!ready}
            title={ready ? "打开对比" : mode === "quad" ? "至少连接 3 条视频" : "请先连接两条视频"}
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

      <div className="video-compare-node-slots">
        {VIDEO_COMPARE_SLOTS.map((slot, index) => {
          const input = inputs[index];
          const sourceNode = input
            ? nodes.find((node) => node.id === input.nodeId || node.data.nodeKey === input.nodeId)
            : null;
          const clips = sourceNode ? listVideoCompareSourceClips(sourceNode.data as CanvasNodeData) : [];
          return (
            <CompareSlot
              key={slot.handle}
              letter={slot.letter}
              input={input}
              clips={clips}
              onPickUrl={input ? (url) => pickSlotUrl(slot.refKey, url) : undefined}
            />
          );
        })}
      </div>

      <footer className="video-compare-node-footer">
        <span>
          {exportError
            ? exportError
            : exporting
              ? "正在生成 MP4 对比视频…"
              : ready
                ? "双击打开对比 · 弹窗里可导出"
                : mode === "quad"
                  ? "四宫格至少连 3 条视频"
                  : connectedCount === 1
                    ? "还差一条视频"
                    : "连接两个视频节点"}
        </span>
        <b
          className="nodrag"
          role="button"
          title="切换左右 / 四宫格"
          onClick={(event) => {
            event.stopPropagation();
            setMode(mode === "quad" ? "side-by-side" : "quad");
          }}
        >
          {VIDEO_COMPARE_MODE_LABELS[mode]}
        </b>
      </footer>

      {viewerOpen && ready ? (
        <VideoCompareViewerModal
          inputs={connected}
          slots={VIDEO_COMPARE_SLOTS.map((slot, index) => {
            const input = inputs[index];
            const sourceNode = input
              ? nodes.find((node) => node.id === input.nodeId || node.data.nodeKey === input.nodeId)
              : null;
            return {
              refKey: slot.refKey,
              input,
              clips: sourceNode ? listVideoCompareSourceClips(sourceNode.data as CanvasNodeData) : [],
            };
          })}
          initialMode={mode}
          exporting={exporting}
          onExport={(nextMode) => void exportCompared(nextMode)}
          onPickUrl={pickSlotUrl}
          onClose={() => setViewerOpen(false)}
        />
      ) : null}
    </div>
  );
}
