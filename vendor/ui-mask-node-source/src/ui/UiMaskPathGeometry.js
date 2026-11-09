import { flattenPath, validPath } from '../skills/UiMaskAppearance.js';

// Video coordinates are independent of the viewport. Only rectangle tools
// explicitly request frame clipping; paths retain off-frame points and handles.
export function videoPoint(event, rect, clip = false) {
  const p = [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  return clip ? p.map(n => Math.max(0, Math.min(1, n))) : p;
}

export function pathCoordinates({ box, angle }, { width: w, height: h }) {
  const a = angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const cx = (box[0] + box[2]) * w / 2, cy = (box[1] + box[3]) * h / 2;
  return {
    to([x, y]) {
      const dx = (box[0] + x * (box[2] - box[0])) * w - cx;
      const dy = (box[1] + y * (box[3] - box[1])) * h - cy;
      return [(cx + dx * c - dy * s) / w, (cy + dx * s + dy * c) / h];
    },
    from([x, y]) {
      const dx = x * w - cx, dy = y * h - cy;
      return [((cx + dx * c + dy * s) / w - box[0]) / (box[2] - box[0]),
        ((cy - dx * s + dy * c) / h - box[1]) / (box[3] - box[1])];
    },
  };
}

// Keep the existing transform-box contract. The path itself may extend beyond
// that box and the video; rasterization clips pixels only at export time.
export function pathDraftGeometry(vertices, source) {
  if (!validPath(vertices)) throw new Error('闭合轮廓需要 3—4096 个有效点');
  const points = flattenPath(vertices);
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  if ((bounds[2] - bounds[0]) * source.width < 3 || (bounds[3] - bounds[1]) * source.height < 3)
    throw new Error('轮廓太小，请画出有宽度和高度的区域');
  let box = bounds.map(n => Math.max(0, Math.min(1, n)));
  if (box[2] - box[0] < 1 / source.width || box[3] - box[1] < 1 / source.height) box = [0, 0, 1, 1];
  const size = [box[2] - box[0], box[3] - box[1]];
  const path = vertices.map(v => ({
    point: v.point.map((n, i) => (n - box[i]) / size[i]),
    in: v.in.map((n, i) => n / size[i]),
    out: v.out.map((n, i) => n / size[i]),
  }));
  if (!validPath(path)) throw new Error('轮廓超出可编辑范围，请缩小绘制范围');
  return { box, path };
}

