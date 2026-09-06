/**
 * 把底层网络错误翻译成用户看得懂、并且**能照着做点什么**的话。
 *
 * 起因（2026-08-21）：4090 上的抠图 worker 挂了，节点上显示的是
 * `connect ETIMEDOUT 172.26.166.238:8092`。对我们够用，但对用这个工具的人来说，
 * 这句话既看不出是谁坏了，也看不出该找谁——很容易以为是自己参数填错了。
 *
 * 原始文本不丢：human 在前、raw 在后。前面那句给人看，后面那截给排查用。
 */

/** 端口 → 那是什么服务。加新 worker 时在这里补一行。 */
const SERVICE_BY_PORT: Record<string, string> = {
  '8091': '深度/法线服务（4090 上的 MoGe-2 几何服务，端口 8091）',
  '8092': '语义分区 / 抠图服务（4090 上的抠图服务，端口 8092）',
  '8093': '抠图服务备用端口（4090，端口 8093）',
}

/** 连接层面的错误码 —— 这些一律意味着"服务没在跑或网络不通"，不是用户操作问题。 */
const CONNECTION_PATTERNS = [
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'socket hang up',
  'Network Error',
]

export interface ServiceErrorDescription {
  /** 给人看的一句话 */
  text: string
  /** 原始报错，留着排查；确定不是连接类问题时等于原文 */
  detail: string
  /** 是不是"服务没起来"这一类。UI 可以据此换个提示语气 */
  isServiceDown: boolean
}

function portFrom(raw: string): string {
  // 形如 connect ETIMEDOUT 172.26.166.238:8092
  const match = raw.match(/:(\d{2,5})\b/)
  return match ? match[1] : ''
}

/**
 * 传什么都行（Error / 字符串 / 未知）。认得出是连接类错误就翻译，认不出就原样返回 ——
 * 宁可显示原文，也不要编一句听起来很确定但其实猜错了的话。
 */
export function describeServiceError(input: unknown): ServiceErrorDescription {
  const raw = String(
    input instanceof Error ? input.message : typeof input === 'string' ? input : input ?? '',
  ).trim()

  if (!raw) {
    return { text: '未知错误', detail: '', isServiceDown: false }
  }

  const isConnection = CONNECTION_PATTERNS.some((token) => raw.includes(token))
  // axios 的超时长这样：timeout of 180000ms exceeded
  const isTimeout = /timeout of \d+ms exceeded/i.test(raw)
  if (!isConnection && !isTimeout) {
    return { text: raw, detail: raw, isServiceDown: false }
  }

  const port = portFrom(raw)
  const service = SERVICE_BY_PORT[port]
  const who = service || '依赖的 GPU 服务'
  return {
    text: `${who}现在连不上，通常是它没在运行。请联系管理员启动后重试。`,
    detail: raw,
    isServiceDown: true,
  }
}

/** 人话 + 原始报错拼成一行，给只能显示纯文本的地方（比如节点上的错误条）用。 */
export function serviceErrorLine(input: unknown): string {
  const { text, detail, isServiceDown } = describeServiceError(input)
  if (!isServiceDown || !detail || detail === text) return text
  return `${text} · ${detail}`
}
