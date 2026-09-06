import semantics from '../../shared/texture-clarity-semantics.json'

/**
 * 细化纹理的共用口径（设计文档里这个功能叫「精准修复 · 人物真实化」）。
 *
 * 语义字典、ATR 映射、修复目标、输出策略都在 src/shared/texture-clarity-semantics.json，
 * 后端 require 同一个文件，worker 只吐原始 ATR 类别 ID 图。三边共用一份，避免"前端图例
 * 和后端支持区对不上"这种最难查的错。
 *
 * 硬规矩：一律按 classId 判断，绝不反解 RGB。颜色只是给人看的可视化编码。
 */

export interface TextureClarityClass {
  id: number
  key: string
  label: string
  color: string
  /** 是否计入本地融合的支持区。背景不计入 —— 蒙版外像素必须严格等于原图。 */
  repairSupport: boolean
}

export const TEXTURE_CLARITY_CLASSES: TextureClarityClass[] =
  semantics.classes as TextureClarityClass[]

/** 计入融合支持区的内部类别 id。 */
export const TEXTURE_CLARITY_SUPPORT_CLASS_IDS: number[] = TEXTURE_CLARITY_CLASSES
  .filter((item) => item.repairSupport)
  .map((item) => item.id)

/** 固定修复目标。只读标签，不拆成复选项 —— 设计文档明确要求这几项必须同时受检查。 */
export const TEXTURE_CLARITY_REPAIR_TARGETS: string[] = semantics.repairTargets

export const TEXTURE_CLARITY_OUTPUT_POLICY = semantics.outputPolicy
export const TEXTURE_CLARITY_FUSION_POLICY = String(semantics.fusionPolicy)
export const TEXTURE_CLARITY_SEMANTICS_VERSION = Number(semantics.version)

/** 默认语义分区权重，以及可以直接替换它的那几个（标签表完全相同）。 */
export const TEXTURE_CLARITY_SOURCE_MODELS = semantics.sourceModels

const CLASS_BY_ID = new Map<number, TextureClarityClass>(
  TEXTURE_CLARITY_CLASSES.map((item) => [item.id, item]),
)

const ATR_TO_INTERNAL: Record<string, number> = semantics.atrToInternal

export function textureClarityClassById(id: number): TextureClarityClass | undefined {
  return CLASS_BY_ID.get(id)
}

/**
 * ATR 原始类别 id → 内部语义 id。
 * 认不出来的一律归背景：宁可少修一块，也不能把没解析出来的区域放进支持区，
 * 那等于允许模型改动一片我们并不理解的像素。
 */
export function internalClassFromAtr(atrId: number): number {
  const mapped = ATR_TO_INTERNAL[String(atrId)]
  return Number.isInteger(mapped) ? mapped : 0
}

/** 256 长的查表，直接喂给逐像素循环，省掉每个像素一次对象取值。 */
export function buildAtrLookupTable(): Uint8Array {
  const table = new Uint8Array(256)
  for (let atrId = 0; atrId < 256; atrId += 1) {
    table[atrId] = internalClassFromAtr(atrId)
  }
  return table
}

/** #RRGGBB → [r,g,b]。只用于生成给人看的可视化图。 */
export function textureClarityColorRgb(id: number): [number, number, number] {
  const hex = (CLASS_BY_ID.get(id)?.color || '#000000').replace('#', '')
  return [
    Number.parseInt(hex.slice(0, 2), 16) || 0,
    Number.parseInt(hex.slice(2, 4), 16) || 0,
    Number.parseInt(hex.slice(4, 6), 16) || 0,
  ]
}

/**
 * 把原图尺寸按输出策略规范化：最长边不超过 maxEdge，保持比例。
 * 返回的宽高都对齐到偶数 —— 后面多尺度融合要反复对半降采样，奇数尺寸每一层都会掉半个像素。
 */
export function normalizeTextureClaritySize(
  width: number,
  height: number,
  maxEdge = TEXTURE_CLARITY_OUTPUT_POLICY.maxEdge,
): { width: number; height: number; scale: number } {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const longest = Math.max(safeWidth, safeHeight)
  const scale = longest > maxEdge ? maxEdge / longest : 1
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2)
  return { width: even(safeWidth), height: even(safeHeight), scale }
}
