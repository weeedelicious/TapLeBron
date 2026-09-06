/**
 * 管理页复制画布时的进度估算。
 *
 * 复制接口是一次阻塞 POST：服务端先落库，再把源画布素材（含跨画布引用）
 * 逐个 copyFile / 对象存储拷贝。大模版会卡十几秒到一两分钟，卡片上如果
 * 只剩一句「复制中...」，鼠标一离开就看不见了，看起来像死掉。
 *
 * 后端此刻没有进度通道（工作时间也不重启），所以前端用节点数估一个时长，
 * 按经过时间把条从 6% 缓到 92%；请求回来再收到 100%。宁可慢一点到头，
 * 也不要提前冲到 100% 再干等。
 */

const SECOND = 1000

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function estimateDuplicateMs(nodeCount?: number) {
  const nodes = Number.isFinite(Number(nodeCount)) ? Math.max(0, Number(nodeCount)) : 0
  // 空画布也要写 JSON、建目录；节点多时主要耗在素材拷贝，按节点线性加。
  const estimated = 4 * SECOND + nodes * 900
  return clamp(estimated, 5 * SECOND, 3 * 60 * SECOND)
}

export function displayDuplicateProgress(opts: {
  startedAtMs: number
  estimatedMs: number
  nowMs?: number
  done?: boolean
}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now()
  const startedRaw = Number(opts.startedAtMs)
  const startedAtMs = Number.isFinite(startedRaw) ? startedRaw : nowMs
  const estimatedMs = clamp(Number(opts.estimatedMs) || 12 * SECOND, 4 * SECOND, 5 * 60 * SECOND)
  const elapsedMs = Math.max(0, nowMs - startedAtMs)

  if (opts.done) {
    return { percent: 100, elapsedMs, estimatedMs }
  }

  const ratio = elapsedMs / estimatedMs
  const timeProgress = ratio <= 1
    ? 6 + ratio * 86
    : 92 + Math.min(4, (ratio - 1) * 2.5)
  return {
    percent: Math.round(clamp(timeProgress, 6, 96)),
    elapsedMs,
    estimatedMs,
  }
}
