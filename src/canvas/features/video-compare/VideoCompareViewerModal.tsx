import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Columns2,
  Grid2X2,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  X,
} from "lucide-react";
import {
  VIDEO_COMPARE_MODE_LABELS,
  VIDEO_COMPARE_SLOTS,
  videoCompareDurationLabel,
  videoCompareResolutionLabel,
  type VideoCompareInput,
  type VideoCompareMode,
  type VideoCompareRefKey,
} from "./video-compare";
import "./video-compare.css";

interface ViewerSlot {
  refKey: VideoCompareRefKey;
  input: VideoCompareInput | null;
  clips: Array<{ url: string; order: number; isCover: boolean }>;
}

interface Props {
  inputs: VideoCompareInput[];
  slots?: ViewerSlot[];
  initialMode: VideoCompareMode;
  exporting?: boolean;
  onExport?: (mode: VideoCompareMode) => void;
  onPickUrl?: (refKey: VideoCompareRefKey, url: string) => void;
  onClose: () => void;
}

function formatClock(value: number) {
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function VideoCompareViewerModal({
  inputs,
  slots,
  initialMode,
  exporting = false,
  onExport,
  onPickUrl,
  onClose,
}: Props) {
  const [mode, setMode] = useState<VideoCompareMode>(
    inputs.length >= 3 || initialMode === "quad" ? "quad" : "side-by-side",
  );
  const [playing, setPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const videosRef = useRef<Array<HTMLVideoElement | null>>([]);

  useEffect(() => {
    if (inputs.length >= 3) setMode("quad");
  }, [inputs.length]);

  const visibleSlots = (slots && slots.length
    ? slots
    : inputs.map((input, index) => ({
        refKey: VIDEO_COMPARE_SLOTS[index]?.refKey ?? "compareRefA",
        input,
        clips: [],
      }))
  ).filter((slot) => slot.input);
  const visibleInputs = (mode === "quad" ? visibleSlots.slice(0, 4) : visibleSlots.slice(0, 2))
    .map((slot) => slot.input)
    .filter((item): item is VideoCompareInput => Boolean(item));
  const emptySlots = mode === "quad" ? Math.max(0, 4 - visibleInputs.length) : 0;

  const syncAll = useCallback((mutate: (video: HTMLVideoElement) => void) => {
    videosRef.current.forEach((video) => {
      if (video) mutate(video);
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        setPlaying((value) => !value);
      }
      if (event.key === "1") setMode("side-by-side");
      if (event.key === "2" && inputs.length >= 3) setMode("quad");
      if (event.key === "f" || event.key === "F") setMaximized((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [inputs.length, onClose]);

  useEffect(() => {
    syncAll((video) => {
      if (playing) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
  }, [playing, syncAll, mode, visibleInputs.length]);

  const seekTo = (time: number) => {
    syncAll((video) => {
      if (Number.isFinite(video.duration)) {
        video.currentTime = Math.min(video.duration, Math.max(0, time));
      }
    });
    setCurrentTime(time);
  };

  return createPortal(
    <div
      className={`video-compare-viewer nodrag nopan${maximized ? " is-maximized" : ""}`}
      data-block-canvas-pan="1"
      onPointerDownCapture={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="video-compare-viewer-shell" role="dialog" aria-modal="true" aria-label="视频对比">
        <div className="video-compare-viewer-toolbar">
          <div className="video-compare-viewer-identity">
            <span>视频对比</span>
            {visibleInputs.map((input) => (
              <strong key={input.nodeId} title={input.title}>{input.title}</strong>
            ))}
          </div>
          <div className="video-compare-viewer-modes">
            <button
              type="button"
              className={mode === "side-by-side" ? "is-active" : ""}
              onClick={() => setMode("side-by-side")}
            >
              <Columns2 size={13} />
              {VIDEO_COMPARE_MODE_LABELS["side-by-side"]}
            </button>
            <button
              type="button"
              className={mode === "quad" ? "is-active" : ""}
              disabled={inputs.length < 3}
              title={inputs.length < 3 ? "四宫格至少需要 3 条视频" : "四宫格对比"}
              onClick={() => setMode("quad")}
            >
              <Grid2X2 size={13} />
              {VIDEO_COMPARE_MODE_LABELS.quad}
            </button>
          </div>
          <div className="video-compare-viewer-actions">
            {onExport ? (
              <button
                type="button"
                className="is-text"
                disabled={exporting}
                title="按原尺寸导出 MP4 对比视频到画布"
                onClick={() => onExport(mode)}
              >
                {exporting ? <Loader2 size={14} className="video-compare-spin" /> : null}
                {exporting ? "导出中…" : "输出视频"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setPlaying((value) => !value)}
              title={playing ? "暂停" : "播放"}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button type="button" onClick={() => setMaximized((value) => !value)}>
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button type="button" onClick={onClose} title="退出 (Esc)">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="video-compare-viewer-stage">
          <div className={`video-compare-grid ${mode === "quad" ? "is-quad" : "is-side"}`}>
            {(mode === "quad" ? visibleSlots.slice(0, 4) : visibleSlots.slice(0, 2)).map((slot, index) => {
              const input = slot.input;
              if (!input) return null;
              return (
              <div key={`${slot.refKey}-${input.nodeId}`} className="video-compare-cell">
                <video
                  ref={(node) => {
                    videosRef.current[index] = node;
                  }}
                  src={input.fullUrl}
                  muted
                  playsInline
                  loop
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    setDuration((current) => Math.max(current, video.duration || 0));
                    if (playing) video.play().catch(() => {});
                  }}
                  onTimeUpdate={(event) => {
                    if (index === 0) setCurrentTime(event.currentTarget.currentTime);
                  }}
                />
                <small>
                  {input.title}
                  {videoCompareResolutionLabel(input) ? ` · ${videoCompareResolutionLabel(input)}` : ""}
                  {videoCompareDurationLabel(input) ? ` · ${videoCompareDurationLabel(input)}` : ""}
                </small>
                {slot.clips.length > 1 && onPickUrl ? (
                  <select
                    className="nodrag video-compare-cell-pick"
                    value={input.fullUrl}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onPickUrl(slot.refKey, event.target.value)}
                  >
                    {slot.clips.map((clip) => (
                      <option key={clip.url} value={clip.url}>
                        {clip.isCover ? `第${clip.order}条 · 封面` : `第${clip.order}条`}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              );
            })}
            {Array.from({ length: emptySlots }, (_, index) => (
              <div key={`empty-${index}`} className="video-compare-cell is-empty">空位</div>
            ))}
          </div>
        </div>

        <div className="video-compare-viewer-transport">
          <button type="button" onClick={() => setPlaying((value) => !value)}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0.1, duration)}
            step={0.05}
            value={Math.min(currentTime, duration || 0)}
            onChange={(event) => seekTo(Number(event.target.value))}
          />
          <b>{formatClock(currentTime)} / {formatClock(duration)}</b>
        </div>
      </div>
    </div>,
    document.body,
  );
}
