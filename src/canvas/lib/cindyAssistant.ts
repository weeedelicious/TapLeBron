export type CindyProposalNodeType = 'text' | 'image' | 'video' | 'audio' | 'video_merge'

// Optional generation settings a proposal node may carry (image/video only).
// Values are advisory: the client re-normalizes them against the node's actual
// model when the node is created, so out-of-range values are snapped to a
// valid value rather than rejected. All fields optional / backward-compatible
// with proposals stored before this field existed.
export interface CindyProposalNodeSettings {
  ratio?: string
  resolution?: string
  duration?: number
  count?: number
}

export interface CindyProposalNode {
  id: string
  type: CindyProposalNodeType
  name: string
  prompt: string
  content: string
  column: number
  row: number
  settings?: CindyProposalNodeSettings
}

export interface CindyProposalConnection {
  source: string
  target: string
}

export interface CindyProposal {
  title: string
  summary: string
  nodes: CindyProposalNode[]
  connections: CindyProposalConnection[]
}

export type CindyProposalStatus = 'pending' | 'applied' | 'dismissed' | null

export interface CindyAssistantMessage {
  id: string
  canvasId: string
  role: 'user' | 'assistant'
  content: string
  /** 用户这一轮附的图（本画布资产地址）。只有 user 消息会有。 */
  images?: string[]
  proposal: CindyProposal | null
  proposalStatus: CindyProposalStatus
  createdAt: string | null
  updatedAt: string | null
}

export interface CindyCanvasContext {
  canvasName: string
  nodes: Array<{
    id: string
    type: string
    name: string
    prompt: string
    hasOutput: boolean
    x: number
    y: number
    settings?: CindyProposalNodeSettings
  }>
  edges: Array<{ source: string; target: string }>
  selectedNodeIds: string[]
}

export interface CindyApplyResult {
  nodesCreated: number
  connectionsCreated: number
  autoGenerateCount?: number
}

interface CindyStatusResponse {
  enabled: boolean
  model: string | null
  capabilities: string[]
  /**
   * 这个账号能用哪些 Skill 模式。聊天和「默认模式」人人都有，film / master 按名单开。
   * 旧后端没有这个字段 —— 那时候「能聊天」就等于「三个模式都能用」，所以缺字段时
   * 按全部模式兜底（见 cindyModesFromStatus）。
   */
  modes?: CindyMode[]
  safety: {
    requiresApply: boolean
    generation: boolean
    deletion: boolean
  } | null
}

export interface CindySkillDoc {
  name: string
  content: string
}

export interface CindySkillDocs {
  image: CindySkillDoc
  video: CindySkillDoc
  strategy: CindySkillDoc
  film: CindySkillDoc
  master: CindySkillDoc
  /** AI 出片 · 文字分镜。出片页面专用，不注入画布 Cindy 的系统提示词，这里只为可见可查。 */
  aiStudio: CindySkillDoc
  /** AI 出片 · 概念图。同上。 */
  aiStudioConcept: CindySkillDoc
}

export type CindyMode = 'default' | 'film' | 'master'

/** 显示顺序，'default' 必须排第一（它是兜底模式）。与后端 CINDY_MODE_ORDER 一致。 */
export const CINDY_MODE_ORDER: CindyMode[] = ['default', 'film', 'master']

/**
 * 从 /status 读出可用模式，脏数据一律按「只有默认模式」处理，唯一例外是
 * **字段整个缺失**：那说明后端还是放开聊天之前的老版本，那时候能聊天就等于三个模式全能用，
 * 按全部模式兜底才不会让本来有高级模式的人在部署间隙里突然少了选项。
 */
export function cindyModesFromStatus(modes: unknown, enabled: boolean): CindyMode[] {
  if (!enabled) return []
  if (modes === undefined || modes === null) return [...CINDY_MODE_ORDER]
  if (!Array.isArray(modes)) return ['default']
  const allowed = CINDY_MODE_ORDER.filter((mode) => modes.includes(mode))
  // 后端总会带上 'default'；真要是没带（脏数据），也别让选择器空掉
  return allowed.length > 0 ? allowed : ['default']
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/cindy-assistant${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error || `Cindy 请求失败 (${response.status})`)
  return payload as T
}

export const cindyAssistantApi = {
  status: () => requestJson<CindyStatusResponse>('/status'),
  skills: () => requestJson<{ skills: CindySkillDocs }>('/skills'),
  listMessages: (canvasId: string) =>
    requestJson<{ messages: CindyAssistantMessage[] }>(`/canvases/${encodeURIComponent(canvasId)}/messages`),
  /**
   * images 传本画布的资产地址（/assets/<canvasId>/<file>）。服务端会按「必须属于本画布」
   * 过滤，再现场读盘缩到 1024 转 base64 交给模型 —— 不能直接把内网地址给模型，它到不了。
   */
  sendMessage: (
    canvasId: string,
    content: string,
    canvasContext: CindyCanvasContext,
    mode: CindyMode = 'default',
    images: string[] = [],
  ) =>
    requestJson<{ userMessage: CindyAssistantMessage; assistantMessage: CindyAssistantMessage }>(
      `/canvases/${encodeURIComponent(canvasId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content, canvasContext, mode, images }),
      },
    ),
  setProposalStatus: (messageId: string, status: Exclude<CindyProposalStatus, 'pending' | null>) =>
    requestJson<{ message: CindyAssistantMessage }>(
      `/messages/${encodeURIComponent(messageId)}/proposal-status`,
      {
        method: 'POST',
        body: JSON.stringify({ status }),
      },
    ),
}
