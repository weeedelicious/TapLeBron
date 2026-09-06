/**
 * 把 A、B 两张图左右拼成一张，产出一个新的图片节点。
 *
 * 交接文档 §9 把"导出合成图"列为 non-goal（那份文档把这个节点定位成纯查看器）。这里是
 * 按产品要求加的，实现上不发明新机制：走 Shotflow 已有的「全景机位截图」那条路
 * （canvas 渲染 → assetsApi.upload → addNodeAt('image') → 连一条 capture 边），
 * 见 features/panorama/PanoramaViewerNode.tsx 的 captureViewpoint。
 *
 * 几何计算放在纯函数里，好单测；真正画到 canvas 的部分需要浏览器，单独一层。
 */

/** 对齐边的上限，避免两张 8K 图拼出一张离谱大的 PNG */
export const STITCH_MAX_HEIGHT = 4096;
/**
 * 中缝分隔线默认**不画**（0 像素）。
 *
 * 之前默认给 2 像素，结果 248×399 + 248×399 拼出来是 498×399 而不是 496×399 ——
 * 分隔线是"插"在两张图中间的，会把总尺寸顶大，两半也不再各占一半。拼接图的尺寸就该
 * 等于两张图之和，多出来的像素只会让人对不上账。
 * 需要一条可见中缝时传 dividerWidth，但要知道那会改变输出尺寸。
 */
export const STITCH_DEFAULT_DIVIDER_WIDTH = 0;
export const STITCH_DIVIDER_COLOR = "#5a5a5a";

/** lr = A 在左，rl = B 在左，tb = A 在上，bt = B 在上 */
export type StitchDirection = "lr" | "rl" | "tb" | "bt";

export const STITCH_DIRECTION_LABELS: Record<StitchDirection, string> = {
  lr: "左右",
  rl: "右左",
  tb: "上下",
  bt: "下上",
};

export function isStitchDirection(value: unknown): value is StitchDirection {
  return value === "lr" || value === "rl" || value === "tb" || value === "bt";
}

export function normalizeStitchDirection(value: unknown): StitchDirection {
  return isStitchDirection(value) ? value : "lr";
}

export function isVerticalStitch(direction: StitchDirection) {
  return direction === "tb" || direction === "bt";
}

/** 后半张图排在前面（右左 / 下上） */
export function isReversedStitch(direction: StitchDirection) {
  return direction === "rl" || direction === "bt";
}

/**
 * 拼接方向直接由查看器当前的摆放决定 —— 导出不再让人选一遍。
 *
 *   左右并排 → 横向；上下并排 → 纵向；
 *   滑杆模式跟着它自己的横/竖开关；
 *   透明度 / 差异是两图重叠、没有方位，按横向出；
 *   交换过 A/B 就反序。
 */
export function stitchDirectionFromView(view: {
  mode: string;
  swapped?: boolean;
  wipeVertical?: boolean;
}): StitchDirection {
  const vertical =
    view.mode === "top-bottom" ||
    (view.mode === "wipe" && Boolean(view.wipeVertical));
  if (vertical) return view.swapped ? "bt" : "tb";
  return view.swapped ? "rl" : "lr";
}

export interface StitchSourceSize {
  width: number;
  height: number;
}

export interface StitchBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StitchLayout {
  canvasWidth: number;
  canvasHeight: number;
  a: StitchBox;
  b: StitchBox;
  divider: StitchBox;
}

function positive(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * 拼接排版。
 *
 * 横向（左右 / 右左）：两张图按同一**高度**缩放，横排；
 * 纵向（上下 / 下上）：两张图按同一**宽度**缩放，竖排。
 * 各自保持比例，中间留一条分隔线。
 *
 * 对齐边取两张图里较大的那个（不超过上限）——这样尺寸大的那张保持原生分辨率、小的那张
 * 放大；反过来取小的会把大图降采样、丢掉细节。
 */
export function stitchLayout(
  a: StitchSourceSize,
  b: StitchSourceSize,
  options: {
    direction?: StitchDirection;
    maxHeight?: number;
    dividerWidth?: number;
  } = {},
): StitchLayout | null {
  const aw = positive(a?.width);
  const ah = positive(a?.height);
  const bw = positive(b?.width);
  const bh = positive(b?.height);
  if (!aw || !ah || !bw || !bh) return null;

  const direction = normalizeStitchDirection(options.direction);
  const limit = positive(options.maxHeight) || STITCH_MAX_HEIGHT;
  const dividerWidth = Math.max(
    0,
    Math.round(
      options.dividerWidth === undefined
        ? STITCH_DEFAULT_DIVIDER_WIDTH
        : options.dividerWidth,
    ),
  );
  const vertical = isVerticalStitch(direction);
  const reversed = isReversedStitch(direction);

  // 先按"第一张 / 第二张"算，最后再映射回 a / b
  const firstSize = reversed
    ? { w: bw, h: bh }
    : { w: aw, h: ah };
  const secondSize = reversed ? { w: aw, h: ah } : { w: bw, h: bh };

  let first: StitchBox;
  let second: StitchBox;
  let divider: StitchBox;
  let canvasWidth: number;
  let canvasHeight: number;

  if (vertical) {
    const targetWidth = Math.min(Math.max(firstSize.w, secondSize.w), limit);
    const firstHeight = Math.max(
      1,
      Math.round((firstSize.h * targetWidth) / firstSize.w),
    );
    const secondHeight = Math.max(
      1,
      Math.round((secondSize.h * targetWidth) / secondSize.w),
    );
    canvasWidth = targetWidth;
    canvasHeight = firstHeight + dividerWidth + secondHeight;
    first = { x: 0, y: 0, width: targetWidth, height: firstHeight };
    divider = {
      x: 0,
      y: firstHeight,
      width: targetWidth,
      height: dividerWidth,
    };
    second = {
      x: 0,
      y: firstHeight + dividerWidth,
      width: targetWidth,
      height: secondHeight,
    };
  } else {
    const targetHeight = Math.min(Math.max(firstSize.h, secondSize.h), limit);
    const firstWidth = Math.max(
      1,
      Math.round((firstSize.w * targetHeight) / firstSize.h),
    );
    const secondWidth = Math.max(
      1,
      Math.round((secondSize.w * targetHeight) / secondSize.h),
    );
    canvasWidth = firstWidth + dividerWidth + secondWidth;
    canvasHeight = targetHeight;
    first = { x: 0, y: 0, width: firstWidth, height: targetHeight };
    divider = {
      x: firstWidth,
      y: 0,
      width: dividerWidth,
      height: targetHeight,
    };
    second = {
      x: firstWidth + dividerWidth,
      y: 0,
      width: secondWidth,
      height: targetHeight,
    };
  }

  return {
    canvasWidth,
    canvasHeight,
    a: reversed ? second : first,
    b: reversed ? first : second,
    divider,
  };
}

/** 拼接图的文件名。不带路径、不带查询串。 */
export function stitchFileName(
  titleA: string,
  titleB: string,
  direction: StitchDirection = "lr",
) {
  const clean = (value: string) =>
    String(value || "图片")
      .replace(/[\\/:*?"<>|]/g, "")
      .trim()
      .slice(0, 24) || "图片";
  const reversed = isReversedStitch(direction);
  const firstTitle = clean(reversed ? titleB : titleA);
  const secondTitle = clean(reversed ? titleA : titleB);
  return `对比拼接${STITCH_DIRECTION_LABELS[direction]}_${firstTitle}_${secondTitle}.png`;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    // 资源都在同源 /assets/ 下，但显式声明一下，免得以后换成对象存储直链时画布被污染
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败：${url}`));
    img.src = url;
  });
}

export interface StitchResult {
  file: File;
  width: number;
  height: number;
  direction: StitchDirection;
}

/**
 * 真正把两张图画到 canvas 上并导出 PNG。需要浏览器环境。
 * 同源图片 toBlob 正常；万一 canvas 被污染会抛出可读的错误，由调用方提示用户。
 */
export async function renderStitchedFile(args: {
  urlA: string;
  urlB: string;
  titleA: string;
  titleB: string;
  direction?: StitchDirection;
}): Promise<StitchResult> {
  const direction = normalizeStitchDirection(args.direction);
  const [imgA, imgB] = await Promise.all([
    loadImage(args.urlA),
    loadImage(args.urlB),
  ]);
  const layout = stitchLayout(
    { width: imgA.naturalWidth, height: imgA.naturalHeight },
    { width: imgB.naturalWidth, height: imgB.naturalHeight },
    { direction },
  );
  if (!layout) throw new Error("读不到图片尺寸，无法拼接");

  const canvas = document.createElement("canvas");
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持 canvas 2d，无法拼接");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.drawImage(imgA, layout.a.x, layout.a.y, layout.a.width, layout.a.height);
  ctx.drawImage(imgB, layout.b.x, layout.b.y, layout.b.width, layout.b.height);
  if (layout.divider.width > 0) {
    ctx.fillStyle = STITCH_DIVIDER_COLOR;
    ctx.fillRect(
      layout.divider.x,
      layout.divider.y,
      layout.divider.width,
      layout.divider.height,
    );
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, "image/png");
    } catch {
      resolve(null);
    }
  });
  if (!blob) throw new Error("导出图片失败（画布可能被跨域资源污染）");

  return {
    file: new File(
      [blob],
      stitchFileName(args.titleA, args.titleB, direction),
      { type: "image/png" },
    ),
    width: layout.canvasWidth,
    height: layout.canvasHeight,
    direction,
  };
}
