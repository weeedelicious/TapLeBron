/**
 * 从节点上读出「这是一次细化纹理的结果」以及它的全部记录。
 *
 * 为什么要一个专门的读取器：细化纹理生成的图片节点是**特殊的**——它比普通图片节点多带
 * 一份 params.textureClarity，里面有原图、模型候选、融合结果、质量门禁和诊断。有了这些
 * 才能点开看前后对比（2026-08-21 用户要求），也才能兑现弹窗上那句「质量门禁结果在新节点
 * 上查看」——那句话写在界面上很久，但查看的地方一直没做。
 *
 * 一切都按**容错**读：
 *   - 今天之前生成的节点没有 candidateUrl / failures，缺就是 null，不能因此不认这个节点；
 *   - 还在生成中的节点（url 为空）不算可看的结果，避免点开一个空对比；
 *   - 任何字段类型不对就当没有，绝不抛异常 —— 画布上的老 JSON 五花八门，抛一次就是白屏。
 */

import type { CanvasNodeData } from '@/lib/types'

export interface TextureClarityGateFailure {
  code: string
  message: string
}

export interface TextureClarityNodeResult {
  /** 源节点 id，用来在对比界面上说清"跟谁比" */
  sourceNodeKey: string | null
  /** 规范化后的原图（对比的左半边） */
  sourceUrl: string
  /** 融合后的最终结果（对比的右半边，也是节点当前显示的图） */
  fusedUrl: string
  /** 模型的原始候选图，融合之前。老节点没有 */
  candidateUrl: string | null
  requestModel: string | null
  resolvedModel: string | null
  outputWidth: number | null
  outputHeight: number | null
  fusionPolicy: string | null
  semanticModelId: string | null
  semanticMode: string | null
  semanticFallbackReason: string | null
  sourceHash: string | null
  generationCalls: number | null
  /** 质量门禁。null = 老节点没记录，不是"没通过" */
  passed: boolean | null
  failures: TextureClarityGateFailure[]
  diagnostics: Record<string, number | string> | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function asNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function asFailures(value: unknown): TextureClarityGateFailure[] {
  if (!Array.isArray(value)) return []
  const list: TextureClarityGateFailure[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    const message = asText(record.message)
    const code = asText(record.code)
    if (!message && !code) continue
    list.push({ code: code ?? '', message: message ?? code ?? '' })
  }
  return list
}

/** 诊断值只留标量：嵌套对象在这个界面上没法显示，留着只会碍事。 */
function asDiagnostics(value: unknown): Record<string, number | string> | null {
  const record = asRecord(value)
  if (!record) return null
  const out: Record<string, number | string> = {}
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
    else if (typeof raw === 'string' && raw.trim()) out[key] = raw.trim()
  }
  return Object.keys(out).length ? out : null
}

/** 源图地址：优先 params.imageList[0].url（那是规范化后的原图）。 */
function readSourceUrl(params: Record<string, unknown>): string | null {
  const list = params.imageList
  if (!Array.isArray(list) || !list.length) return null
  const first = asRecord(list[0])
  return first ? asText(first.url) : null
}

/**
 * 认得出就返回完整记录，认不出返回 null。
 * 判定条件刻意收紧：必须同时有 textureClarity 元数据、原图、以及**已经生成好的结果图**。
 */
export function readTextureClarityResult(data: CanvasNodeData | undefined): TextureClarityNodeResult | null {
  try {
    const params = asRecord(data?.params)
    if (!params) return null
    const meta = asRecord(params.textureClarity)
    if (!meta) return null

    const sourceUrl = readSourceUrl(params)
    if (!sourceUrl) return null

    // 结果图就是节点当前显示的第一张。还在生成中时 url 是空数组 —— 那时候没有可比的东西。
    const urls = Array.isArray(data?.url) ? data.url : []
    const fusedUrl = asText(urls[0])
    if (!fusedUrl) return null

    return {
      sourceNodeKey: asText(meta.sourceNodeKey),
      sourceUrl,
      fusedUrl,
      candidateUrl: asText(meta.candidateUrl),
      requestModel: asText(meta.requestModel),
      resolvedModel: asText(meta.resolvedModel),
      outputWidth: asNumber(meta.outputWidth),
      outputHeight: asNumber(meta.outputHeight),
      fusionPolicy: asText(meta.fusionPolicy),
      semanticModelId: asText(meta.semanticModelId),
      semanticMode: asText(meta.semanticMode),
      semanticFallbackReason: asText(meta.semanticFallbackReason),
      sourceHash: asText(meta.sourceHash),
      generationCalls: asNumber(meta.generationCalls),
      passed: typeof meta.passed === 'boolean' ? meta.passed : null,
      failures: asFailures(meta.failures),
      diagnostics: asDiagnostics(meta.diagnostics),
    }
  } catch {
    // 读取器绝不把画布带崩：认不出就当普通图片节点
    return null
  }
}
