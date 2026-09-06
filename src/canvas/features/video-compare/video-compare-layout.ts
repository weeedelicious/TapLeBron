/**
 * 视频对比导出的排版。
 *
 * 左右两路：hstack（参考 ffmpeg hstack / infiniVids 2-up）
 * 四宫格：2×2 xstack，3 路时第四格留空（参考 ffmpeg xstack / infiniVids 2×2）
 */

/** 浏览器 canvas 上限附近，只防极端 8K×4 把内存打爆；正常 1080/2K/4K 原尺寸不缩。 */
export const VIDEO_COMPARE_MAX_CANVAS = 8192;

export type VideoCompareExportLayoutKind = "side-by-side" | "quad";

export interface VideoCompareCellSize {
  width: number;
  height: number;
}

export interface VideoCompareCellBox {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  letter: "A" | "B" | "C" | "D";
}

export interface VideoCompareExportLayout {
  kind: VideoCompareExportLayoutKind;
  canvasWidth: number;
  canvasHeight: number;
  cellWidth: number;
  cellHeight: number;
  cells: VideoCompareCellBox[];
}

const LETTERS: Array<"A" | "B" | "C" | "D"> = ["A", "B", "C", "D"];

function positive(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function fitContain(
  source: VideoCompareCellSize,
  cellWidth: number,
  cellHeight: number,
) {
  const sw = Math.max(1, source.width);
  const sh = Math.max(1, source.height);
  const scale = Math.min(cellWidth / sw, cellHeight / sh);
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  return {
    width,
    height,
    x: Math.round((cellWidth - width) / 2),
    y: Math.round((cellHeight - height) / 2),
  };
}

export function videoCompareCellCount(kind: VideoCompareExportLayoutKind, connected: number) {
  if (kind === "quad") return Math.min(4, Math.max(3, connected));
  return 2;
}

export function videoCompareExportLayout(
  sizes: VideoCompareCellSize[],
  kind: VideoCompareExportLayoutKind,
): VideoCompareExportLayout | null {
  const usable = sizes
    .map((size) => ({
      width: positive(size?.width) || 1280,
      height: positive(size?.height) || 720,
    }))
    .slice(0, kind === "quad" ? 4 : 2);
  if (kind === "side-by-side" && usable.length < 2) return null;
  if (kind === "quad" && usable.length < 3) return null;

  const cellCount = videoCompareCellCount(kind, usable.length);
  const nativeWidth = Math.max(...usable.map((size) => size.width));
  const nativeHeight = Math.max(...usable.map((size) => size.height));
  let cellWidth = nativeWidth;
  let cellHeight = nativeHeight;
  if (kind === "quad") {
    const canvasLong = Math.max(cellWidth * 2, cellHeight * 2);
    if (canvasLong > VIDEO_COMPARE_MAX_CANVAS) {
      const scale = VIDEO_COMPARE_MAX_CANVAS / canvasLong;
      cellWidth = Math.max(1, Math.round(cellWidth * scale));
      cellHeight = Math.max(1, Math.round(cellHeight * scale));
    }
    const cells: VideoCompareCellBox[] = [];
    for (let index = 0; index < cellCount; index += 1) {
      const col = index % 2;
      const row = Math.floor(index / 2);
      cells.push({
        index,
        x: col * cellWidth,
        y: row * cellHeight,
        width: cellWidth,
        height: cellHeight,
        letter: LETTERS[index],
      });
    }
    return {
      kind,
      canvasWidth: cellWidth * 2,
      canvasHeight: cellHeight * 2,
      cellWidth,
      cellHeight,
      cells,
    };
  }

  if (cellWidth * 2 > VIDEO_COMPARE_MAX_CANVAS) {
    const scale = VIDEO_COMPARE_MAX_CANVAS / (cellWidth * 2);
    cellWidth = Math.max(1, Math.round(cellWidth * scale));
    cellHeight = Math.max(1, Math.round(cellHeight * scale));
  }
  return {
    kind,
    canvasWidth: cellWidth * 2,
    canvasHeight: cellHeight,
    cellWidth,
    cellHeight,
    cells: [
      {
        index: 0,
        x: 0,
        y: 0,
        width: cellWidth,
        height: cellHeight,
        letter: "A",
      },
      {
        index: 1,
        x: cellWidth,
        y: 0,
        width: cellWidth,
        height: cellHeight,
        letter: "B",
      },
    ],
  };
}

export function videoCompareDrawBox(
  source: VideoCompareCellSize,
  cell: VideoCompareCellBox,
) {
  const fitted = fitContain(source, cell.width, cell.height);
  return {
    x: cell.x + fitted.x,
    y: cell.y + fitted.y,
    width: fitted.width,
    height: fitted.height,
  };
}

export function videoCompareFileName(
  kind: VideoCompareExportLayoutKind,
  titles: string[],
) {
  const clean = (value: string) =>
    String(value || "视频")
      .replace(/[\\/:*?"<>|]/g, "")
      .trim()
      .slice(0, 16) || "视频";
  const label = kind === "quad" ? "四宫格" : "左右";
  const names = titles.map(clean).filter(Boolean).slice(0, 4).join("_");
  return `视频对比${label}_${names || "对比"}.webm`;
}
