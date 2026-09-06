import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  Grid2X2,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RotateCcw,
  Rows2,
  Scissors,
  X,
} from "lucide-react";
import {
  IMAGE_COMPARE_MODE_LABELS,
  imageCompareResolutionLabel,
  imageCompareSizeMismatch,
  isImageCompareSplitMode,
  type ImageCompareInput,
  type ImageCompareMode,
} from "./image-compare";
import {
  STITCH_DIRECTION_LABELS,
  stitchDirectionFromView,
  type StitchDirection,
} from "./image-compare-stitch";
import "./image-compare.css";

const MIN_SCALE = 0.35;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

const MODES: Array<{ id: ImageCompareMode; key: string }> = [
  { id: "side-by-side", key: "1" },
  { id: "top-bottom", key: "2" },
  { id: "wipe", key: "3" },
  { id: "opacity", key: "4" },
  { id: "difference", key: "5" },
];

interface Props {
  inputA: ImageCompareInput;
  inputB: ImageCompareInput;
  initialMode: ImageCompareMode;
  exporting?: boolean;
  onExportStitched?: (direction: StitchDirection) => void;
  onClose: () => void;
}

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

export function ImageCompareViewerModal({
  inputA,
  inputB,
  initialMode,
  exporting = false,
  onExportStitched,
  onClose,
}: Props) {
  const [mode, setMode] = useState<ImageCompareMode>(initialMode);
  const [swapped, setSwapped] = useState(false);
  const [wipe, setWipe] = useState(50);
  const [wipeVertical, setWipeVertical] = useState(false);
  const [opacity, setOpacity] = useState(50);
  const [gain, setGain] = useState(1);
  const [checker, setChecker] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /** 图片按 object-fit: contain 铺开后相对原始像素的比例，用来算真正的 1:1 */
  const [fitRatio, setFitRatio] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);

  // 交换只影响显示顺序，不动画布数据
  const first = swapped ? inputB : inputA;
  const second = swapped ? inputA : inputB;
  const sizeMismatch = imageCompareSizeMismatch(inputA, inputB);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setScale((current) => clampScale(current * factor));
  }, []);

  /** 真正的 1:1：contain 之后一个图片像素只占 fitRatio 个屏幕像素，倒过来就是所需缩放 */
  const zoomActualPixels = useCallback(() => {
    if (!fitRatio) return;
    setScale(clampScale(1 / fitRatio));
    setOffset({ x: 0, y: 0 });
  }, [fitRatio]);

  const measureFit = useCallback(
    (event: { currentTarget: HTMLImageElement }) => {
      const img = event.currentTarget;
      const stage = stageRef.current;
      if (!stage || !img.naturalWidth || !img.naturalHeight) return;
      const box = img.getBoundingClientRect();
      // getBoundingClientRect 拿到的是元素框（含 transform），要还原成 scale=1 的尺寸
      const boxWidth = box.width / scale;
      const boxHeight = box.height / scale;
      if (!boxWidth || !boxHeight) return;
      setFitRatio(
        Math.min(boxWidth / img.naturalWidth, boxHeight / img.naturalHeight),
      );
    },
    [scale],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "");
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (typing) return; // range 滑块保留原生键盘操作
      const modeHit = MODES.find((item) => item.key === event.key);
      if (modeHit) {
        event.stopPropagation();
        setMode(modeHit.id);
        return;
      }
      if (event.key === "0") {
        event.stopPropagation();
        resetView();
        return;
      }
      if (event.key === "s" || event.key === "S") {
        event.stopPropagation();
        setSwapped((current) => !current);
        return;
      }
      if (event.key === "f" || event.key === "F") {
        event.stopPropagation();
        setMaximized((current) => !current);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.stopPropagation();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.stopPropagation();
        zoomBy(1 / ZOOM_STEP);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, resetView, zoomBy]);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    // 不让滚轮漏到画布上去缩放画布
    event.preventDefault();
    event.stopPropagation();
    zoomBy(event.deltaY > 0 ? 1 / 1.1 : 1.1);
  };

  const handlePanStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (
      (event.target as Element).closest(
        "button, input, label, .image-compare-viewer-wipe-handle",
      )
    )
      return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePanMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    setOffset({ x: drag.offsetX + dx, y: drag.offsetY + dy });
  };

  const handlePanEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const imageTransform = `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`;
  const stacked = !isImageCompareSplitMode(mode);
  const splitVertical = mode === "top-bottom";
  // 导出方向不再让人选：直接跟着当前摆放（含 A/B 是否交换过）
  const exportDirection = stitchDirectionFromView({
    mode,
    swapped,
    wipeVertical,
  });
  const wipeClip = wipeVertical
    ? `inset(${wipe}% 0 0 0)`
    : `inset(0 0 0 ${wipe}%)`;
  const stackFilter: CSSProperties =
    mode === "difference" && gain > 1 ? { filter: `brightness(${gain})` } : {};

  const renderImage = (
    input: ImageCompareInput,
    extra: { className?: string; style?: CSSProperties } = {},
  ) => (
    <img
      className={`image-compare-viewer-image ${extra.className ?? ""}`.trim()}
      src={input.fullUrl}
      alt={input.title}
      style={{ transform: imageTransform, ...extra.style }}
      onLoad={measureFit}
      draggable={false}
    />
  );

  return createPortal(
    <div
      className={`image-compare-viewer nodrag nopan${maximized ? " is-maximized" : ""}`}
      onPointerDownCapture={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        // 点遮罩关闭；从内容里拖出来的不算
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="image-compare-viewer-shell"
        role="dialog"
        aria-modal="true"
        aria-label="图片对比查看"
      >
        <div className="image-compare-viewer-toolbar">
          <div className="image-compare-viewer-identity">
            <span>图片对比</span>
            <strong title={first.title}>{first.title}</strong>
            <em>与</em>
            <strong title={second.title}>{second.title}</strong>
            {sizeMismatch ? (
              <i
                className="image-compare-viewer-warn"
                title={`两张图尺寸不同：${imageCompareResolutionLabel(inputA)} / ${imageCompareResolutionLabel(inputB)}，叠加对比会有偏差`}
              >
                尺寸不同
              </i>
            ) : null}
          </div>

          <div className="image-compare-viewer-modes" aria-label="对比模式">
            {MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={mode === item.id ? "is-active" : ""}
                onClick={() => setMode(item.id)}
                title={`${IMAGE_COMPARE_MODE_LABELS[item.id]}对比 (${item.key})`}
              >
                <kbd>{item.key}</kbd>
                {IMAGE_COMPARE_MODE_LABELS[item.id]}
              </button>
            ))}
          </div>

          <div className="image-compare-viewer-actions">
            <div className="image-compare-viewer-zoom">
              <button
                type="button"
                aria-label="缩小"
                title="缩小 (-)"
                onClick={() => zoomBy(1 / ZOOM_STEP)}
              >
                <Minus size={13} />
              </button>
              <b>{Math.round(scale * 100)}%</b>
              <button
                type="button"
                aria-label="放大"
                title="放大 (+)"
                onClick={() => zoomBy(ZOOM_STEP)}
              >
                <Plus size={13} />
              </button>
            </div>
            <button
              type="button"
              className="is-text"
              disabled={!fitRatio}
              title="按原始像素 1:1 显示"
              onClick={zoomActualPixels}
            >
              1:1
            </button>
            <button
              type="button"
              aria-label="适应窗口"
              title="适应窗口 (0)"
              onClick={resetView}
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              className={swapped ? "is-active" : ""}
              aria-label="交换 A/B"
              title="交换 A / B (S)"
              onClick={() => setSwapped((current) => !current)}
            >
              <ArrowLeftRight size={14} />
            </button>
            <button
              type="button"
              className={checker ? "is-active" : ""}
              aria-label="棋盘格背景"
              title="棋盘格背景（看透明区域）"
              onClick={() => setChecker((current) => !current)}
            >
              <Grid2X2 size={14} />
            </button>
            {onExportStitched ? (
              <button
                type="button"
                disabled={exporting}
                aria-label="导出拼接图"
                title={`导出拼接图（按当前摆放：${STITCH_DIRECTION_LABELS[exportDirection]}），在画布上生成一个图片节点`}
                onClick={() => onExportStitched(exportDirection)}
              >
                {exporting ? (
                  <Loader2 size={14} className="image-compare-spin" />
                ) : (
                  <Scissors size={14} />
                )}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={maximized ? "还原窗口" : "最大化"}
              title={maximized ? "还原窗口 (F)" : "最大化 (F)"}
              onClick={() => setMaximized((current) => !current)}
            >
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              type="button"
              aria-label="退出对比"
              title="退出 (Esc)"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 每种模式自己那一行参数，放在工具栏下面，不挤主工具栏 */}
        {mode === "wipe" || mode === "opacity" || mode === "difference" ? (
          <div className="image-compare-viewer-subbar">
            {mode === "wipe" ? (
              <>
                <button
                  type="button"
                  className={wipeVertical ? "is-active" : ""}
                  title={wipeVertical ? "改为左右滑动" : "改为上下滑动"}
                  onClick={() => setWipeVertical((current) => !current)}
                >
                  <Rows2 size={13} />
                  {wipeVertical ? "上下" : "左右"}
                </button>
                <label>
                  <span>分割位置</span>
                  <input
                    aria-label="对比滑杆位置"
                    type="range"
                    min="0"
                    max="100"
                    value={wipe}
                    onChange={(event) =>
                      setWipe(Number(event.currentTarget.value))
                    }
                  />
                  <b>{wipe}%</b>
                </label>
              </>
            ) : null}
            {mode === "opacity" ? (
              <label>
                <span>B 透明度</span>
                <input
                  aria-label="图片 B 透明度"
                  type="range"
                  min="0"
                  max="100"
                  value={opacity}
                  onChange={(event) =>
                    setOpacity(Number(event.currentTarget.value))
                  }
                />
                <b>{opacity}%</b>
              </label>
            ) : null}
            {mode === "difference" ? (
              <>
                <span className="image-compare-viewer-note">
                  黑色 = 完全一致，越亮差异越大
                </span>
                <label>
                  <span>增强</span>
                  <input
                    aria-label="差异增强倍数"
                    type="range"
                    min="1"
                    max="8"
                    step="0.5"
                    value={gain}
                    onChange={(event) =>
                      setGain(Number(event.currentTarget.value))
                    }
                  />
                  <b>{gain}×</b>
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        <div
          ref={stageRef}
          className={`image-compare-viewer-stage is-${mode}${checker ? " is-checker" : ""}`}
          onWheel={handleWheel}
          onPointerDown={handlePanStart}
          onPointerMove={handlePanMove}
          onPointerUp={handlePanEnd}
          onPointerCancel={handlePanEnd}
        >
          {stacked ? (
            <div className="image-compare-viewer-stack" style={stackFilter}>
              {renderImage(first, {
                className: "image-compare-viewer-image-base",
              })}
              {mode === "wipe" ? (
                <div
                  className="image-compare-viewer-wipe-layer"
                  style={{ clipPath: wipeClip }}
                >
                  {renderImage(second)}
                </div>
              ) : (
                renderImage(second, {
                  className: `image-compare-viewer-image-overlay${mode === "difference" ? " is-difference" : ""}`,
                  style:
                    mode === "opacity" ? { opacity: opacity / 100 } : undefined,
                })
              )}
              {mode === "wipe" ? (
                <>
                  {/*
                    滑杆只占分割线附近一条 72px 的带，绝不用全屏 inset: 0 ——
                    交接文档 §7 记的已知回归就是透明 range 铺满后把工具栏按钮全挡死。
                  */}
                  <input
                    className={`image-compare-viewer-wipe-range${wipeVertical ? " is-vertical" : ""}`}
                    aria-label="对比滑杆位置"
                    type="range"
                    min="0"
                    max="100"
                    value={wipe}
                    onChange={(event) =>
                      setWipe(Number(event.currentTarget.value))
                    }
                  />
                  <div
                    className={`image-compare-viewer-wipe-axis${wipeVertical ? " is-vertical" : ""}`}
                    style={wipeVertical ? { top: `${wipe}%` } : { left: `${wipe}%` }}
                  >
                    <span
                      className="image-compare-viewer-wipe-handle"
                      aria-hidden="true"
                    >
                      {wipeVertical ? "↕" : "↔"}
                    </span>
                  </div>
                </>
              ) : null}
              <div className="image-compare-viewer-stack-tags">
                <b>{swapped ? "B" : "A"}</b>
                <b>{swapped ? "A" : "B"}</b>
              </div>
            </div>
          ) : (
            <div
              className={`image-compare-viewer-side-grid${splitVertical ? " is-vertical" : ""}`}
            >
              <div className="image-compare-viewer-side">
                {renderImage(first)}
                <span>{swapped ? "B" : "A"}</span>
                <small>{imageCompareResolutionLabel(first)}</small>
              </div>
              <div className="image-compare-viewer-side">
                {renderImage(second)}
                <span>{swapped ? "A" : "B"}</span>
                <small>{imageCompareResolutionLabel(second)}</small>
              </div>
            </div>
          )}
        </div>

        <div className="image-compare-viewer-hint">
          滚轮或 +/- 缩放 · 拖拽平移 · 1~5 模式 · S 交换 · F 最大化 · 0 适应 · Esc
          退出
        </div>
      </div>
    </div>,
    document.body,
  );
}
