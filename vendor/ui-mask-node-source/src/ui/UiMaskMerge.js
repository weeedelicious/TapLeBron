import { activeAt, trackPolygon } from '../skills/UiMaskDocument.js';
import { vertex, setAppearanceValue } from '../skills/UiMaskAppearance.js';

// 遮罩合并（Shotflow 2026-11-09）：框选到的几块遮罩合成一块。
//  - 静态遮罩：新遮罩的形状是所有遮罩轮廓的凸包（可继续拖锚点 / 拖边编辑）；
//  - 动态遮罩：每个关键帧取覆盖全部遮罩的矩形（凸包点数逐帧不同，没法做平滑关键帧），
//    出现时段取所有遮罩时段的并集。

const EPS = 1e-9;

function convexHull(points) {
  const pts = [...new Map(points.map((p) => [`${p[0].toFixed(6)},${p[1].toFixed(6)}`, p])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= EPS) lower.pop(); lower.push(p); }
  for (const p of [...pts].reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= EPS) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function boundsOf(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [clamp01(Math.min(...xs)), clamp01(Math.min(...ys)), clamp01(Math.max(...xs)), clamp01(Math.max(...ys))];
}

function unionRanges(tracks) {
  const all = tracks.flatMap((t) => t.ranges.map((r) => [...r])).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of all) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

// 某一帧上，所有在场遮罩（含旋转、路径）的轮廓点
function outlineAt(tracks, frame, source) {
  return tracks.filter((t) => activeAt(t, frame)).flatMap((t) => trackPolygon(t, frame, source) || []);
}

function keyFramesOf(track) {
  // 时段起止都要有键：某块遮罩消失的下一帧（b）也设键，合并框立刻收回，不会拖到下一个键慢慢缩
  const frames = new Set(track.ranges.flatMap(([a, b]) => [a, b - 1, b]));
  for (const k of track.keys || []) frames.add(k.frame);
  for (const c of Object.values(track.animation?.channels || {})) for (const k of c.keys || []) frames.add(k.frame);
  for (const k of track.appearance?.shape?.keys || []) frames.add(k.frame);
  return frames;
}

/**
 * 把 ids 里的遮罩合成一块，返回新遮罩（不改 tracks，由调用方替换）。
 * newTrack(kind, box, frame) 用工作台自己的建遮罩方法，保证新遮罩的字段跟手画的一样。
 */
export function mergeMaskTracks(tracks, frame, source, newTrack) {
  if (tracks.length < 2) throw new Error('至少框选两个遮罩才能合并');
  const kind = tracks[0].kind;
  if (tracks.some((t) => t.kind !== kind)) throw new Error('静态和动态遮罩不能合并在一起');
  if (kind === 'static') {
    const hull = convexHull(outlineAt(tracks, frame, source));
    if (hull.length < 3) throw new Error('框选的遮罩太小，合并不出有效形状');
    const box = boundsOf(hull);
    const w = Math.max(box[2] - box[0], EPS), h = Math.max(box[3] - box[1], EPS);
    const merged = newTrack('static', box, frame);
    setAppearanceValue(merged, 'shape', frame, hull.map(([x, y]) => vertex(clamp01((x - box[0]) / w), clamp01((y - box[1]) / h))));
    merged.label = '合并遮罩';
    return merged;
  }
  const ranges = unionRanges(tracks);
  const inRange = (f) => ranges.some(([a, b]) => f >= a && f < b);
  const frames = [...new Set(tracks.flatMap((t) => [...keyFramesOf(t)]))]
    .filter((f) => inRange(f) && outlineAt(tracks, f, source).length)
    .sort((a, b) => a - b);
  if (!frames.length) throw new Error('框选的动态遮罩没有可合并的帧');
  const keys = frames.map((f) => ({ frame: f, box: boundsOf(outlineAt(tracks, f, source)), angle: 0 }))
    .filter((k) => k.box[2] - k.box[0] > EPS && k.box[3] - k.box[1] > EPS);
  if (!keys.length) throw new Error('框选的遮罩太小，合并不出有效形状');
  const merged = newTrack('dynamic', keys[0].box, keys[0].frame);
  // newTrack 建出来的动态遮罩已转成属性通道；这里按合并后的关键帧重建
  delete merged.animation;
  merged.ranges = ranges;
  merged.samples = keys.map((k) => ({ frame: k.frame, box: [...k.box] }));
  merged.keys = keys;
  merged.overrides = [];
  merged.motionMode = 'absolute';
  merged.interpolation = 'linear';
  merged.label = '合并遮罩';
  return merged;
}
