// null = follows the node's whole processing range; [] = disabled.
// Explicit ranges use source seconds and [start, end); null end means clip end.
export const maskRangesFor = (masks, ranges) => masks.map((_, index) => ranges?.[index] ?? null);
// Match the worker's microsecond tolerance for browser frame timestamps.
export const maskActiveAt = (ranges, time) => ranges == null || ranges.some(range =>
  time + 1e-6 >= range.start && (range.end == null || time + 1e-6 < range.end));

export function validateMaskRanges(masks, ranges) {
  if (ranges == null) return;
  if (!Array.isArray(ranges) || ranges.length !== masks.length) throw new Error('遮罩时间数据与遮罩数量不一致');
  for (const intervals of ranges) {
    if (intervals === null) continue;
    if (!Array.isArray(intervals) || intervals.length > 32) throw new Error('每个遮罩最多设置 32 个时间段');
    for (const range of intervals) {
      if (!range || !Number.isFinite(range.start) || range.start < 0
        || (range.end !== null && (!Number.isFinite(range.end) || range.end <= range.start))) {
        throw new Error('消失时间必须晚于出现时间；留空表示片尾');
      }
    }
  }
}
