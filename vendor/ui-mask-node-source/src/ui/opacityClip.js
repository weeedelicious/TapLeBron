/** Keep a mask interval editable from the opacity-row clip without overlaps. */
export function trimOpacityRange(ranges, index, edge, frame, frameCount) {
  const next = Array.isArray(ranges) ? ranges.map(range => [...range]) : [];
  const range = next[index];
  if (!range || !Number.isInteger(frame) || !Number.isInteger(frameCount) || frameCount < 1) return next;
  const sorted = next.map((item, itemIndex) => ({ item, itemIndex })).sort((a, b) => a.item[0] - b.item[0] || a.itemIndex - b.itemIndex);
  const sortedIndex = sorted.findIndex(item => item.itemIndex === index);
  const previous = sorted[sortedIndex - 1]?.item;
  const following = sorted[sortedIndex + 1]?.item;
  if (edge === 'start') {
    const min = previous ? previous[1] : 0;
    const max = Math.max(min, range[1] - 1);
    range[0] = Math.max(min, Math.min(max, frame));
  } else {
    const min = Math.min(frameCount, range[0] + 1);
    const max = following ? following[0] : frameCount;
    range[1] = Math.max(min, Math.min(Math.max(min, max), frame));
  }
  return next;
}

/** Frames that need a copied key after an edge is released. Existing keys stay put. */
export function edgeHoldFrames(oldRange, newRange) {
  if (!oldRange || !newRange) return [];
  const holds = [];
  if (newRange[0] < oldRange[0]) holds.push({ source: oldRange[0], dest: newRange[0] });
  if (newRange[1] > oldRange[1]) holds.push({ source: oldRange[1] - 1, dest: newRange[1] - 1 });
  return holds.filter(item => item.dest !== item.source && item.source >= 0 && item.dest >= 0);
}

/** Shift-drag moves one frame per several pixels, starting from the original edge. */
export function fineEdgeFrame(base, pixels, pixelsPerFrame = 8) {
  if (!Number.isInteger(base) || !Number.isFinite(pixels) || pixelsPerFrame < 1) return base;
  return base + Math.trunc(pixels / pixelsPerFrame);
}

/** Slide a whole interval. Its length stays the same and it cannot cross another interval. */
export function moveOpacityRange(ranges, index, delta, frameCount) {
  const next = Array.isArray(ranges) ? ranges.map(range => [...range]) : [];
  const range = next[index];
  if (!range || !Number.isInteger(delta) || !Number.isInteger(frameCount) || frameCount < 1) return next;
  const length = range[1] - range[0];
  if (length < 1) return next;
  const sorted = next.map((item, itemIndex) => ({ item, itemIndex })).sort((a, b) => a.item[0] - b.item[0] || a.itemIndex - b.itemIndex);
  const sortedIndex = sorted.findIndex(item => item.itemIndex === index);
  const previous = sorted[sortedIndex - 1]?.item;
  const following = sorted[sortedIndex + 1]?.item;
  const min = previous ? previous[1] : 0;
  const maxStart = (following ? following[0] : frameCount) - length;
  if (maxStart < min) return next;
  const start = Math.max(min, Math.min(maxStart, range[0] + delta));
  range[0] = start;
  range[1] = start + length;
  return next;
}

/** Drop one opacity interval and leave every other interval untouched. */
export function removeOpacityRange(ranges, index) {
  if (!Array.isArray(ranges) || !Number.isInteger(index) || !ranges[index]) return Array.isArray(ranges) ? ranges.map(range => [...range]) : [];
  return ranges.filter((_, itemIndex) => itemIndex !== index).map(range => [...range]);
}

/** Paste a copied interval at a frame. Overlap is shortened to the free gap, never below 1 frame. */
export function pasteOpacityRange(ranges, frame, length, frameCount) {
  const current = Array.isArray(ranges) ? ranges.map(range => [...range]).sort((a, b) => a[0] - b[0]) : [];
  if (!Number.isInteger(frame) || !Number.isInteger(length) || length < 1 || !Number.isInteger(frameCount) || frameCount < 1) {
    return { ranges: current, index: null };
  }
  const start = Math.max(0, Math.min(frame, frameCount - 1));
  let gapStart = 0;
  let gapEnd = frameCount;
  for (const range of current) {
    if (start >= range[0] && start < range[1]) return { ranges: current, index: null };
    if (range[1] <= start) gapStart = range[1];
    else if (range[0] > start) { gapEnd = range[0]; break; }
  }
  if (start < gapStart || gapEnd - start < 1) return { ranges: current, index: null };
  const pasted = [start, Math.min(gapEnd, start + length)];
  const next = [...current, pasted].sort((a, b) => a[0] - b[0]);
  return { ranges: next, index: next.findIndex(range => range[0] === pasted[0] && range[1] === pasted[1]) };
}

/** A whole-clip move can carry its keys only when every one lands on a free frame. */
export function clipKeysCanShift(framesByProperty, range, delta, frameCount) {
  if (!delta) return true;
  if (!range || !Number.isInteger(delta) || !Number.isInteger(frameCount)) return false;
  const [start, end] = range;
  for (const frames of Object.values(framesByProperty || {})) {
    const all = new Set(frames);
    const moving = new Set(frames.filter(frame => frame >= start && frame < end));
    for (const frame of moving) {
      const to = frame + delta;
      if (!Number.isInteger(to) || to < 0 || to >= frameCount) return false;
      if (all.has(to) && !moving.has(to)) return false;
    }
  }
  return true;
}

/** Move keyframes from one clip onto another, leaving any key already at the destination. */
export function shiftedClipKeys(keys, sourceStart, destRange, takenIds = []) {
  const [destStart, destEnd] = destRange;
  const delta = destStart - sourceStart;
  const taken = new Set(takenIds);
  const copies = [];
  let skipped = 0;
  for (const item of keys) {
    const frame = item.frame + delta;
    if (!Number.isInteger(frame) || frame < destStart || frame >= destEnd) continue;
    const id = `${item.p}:${frame}`;
    if (taken.has(id)) { skipped += 1; continue; }
    taken.add(id);
    copies.push({ p: item.p, frame, key: item.key });
  }
  return { copies, skipped };
}

/** A key counts as inside the box when its center is within a few pixels of the rectangle. */
export function marqueeRefs(points, box, pad = 6) {
  const x = Math.min(box.x1, box.x2) - pad;
  const y = Math.min(box.y1, box.y2) - pad;
  const right = Math.max(box.x1, box.x2) + pad;
  const bottom = Math.max(box.y1, box.y2) + pad;
  return points.filter(point => point.x >= x && point.x <= right && point.y >= y && point.y <= bottom).flatMap(point => point.refs);
}

/** Right edge sits on the last included frame, except a one-frame clip keeps a visible width. */
export function opacityClipPixels(range, xOf, minWidth = 12) {
  const start = xOf(range[0]);
  const end = range[1] - range[0] <= 1 ? start + minWidth : xOf(range[1] - 1);
  return { start, end };
}

/** Prefer a wide edge target so the visible handle is not the only clickable pixels. */
export function opacityClipHit(ranges, xOf, x, slop = 20) {
  const inward = 12;
  let edge = null;
  let distance = slop + 1;
  ranges.forEach((range, index) => {
    const { start, end } = opacityClipPixels(range, xOf);
    const fromStart = Math.abs(x - start);
    const fromEnd = Math.abs(x - end);
    if (x >= start - slop && x <= start + inward && fromStart < distance) {
      edge = { index, edge: 'start' };
      distance = fromStart;
    }
    if (x >= end - inward && x <= end + slop && fromEnd < distance) {
      edge = { index, edge: 'end' };
      distance = fromEnd;
    }
  });
  if (edge) return edge;
  for (let index = 0; index < ranges.length; index += 1) {
    const { start, end } = opacityClipPixels(ranges[index], xOf);
    if (x > start + 12 && x < end - 12) return { index, edge: 'body' };
  }
  return null;
}
