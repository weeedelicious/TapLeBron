import { describe, expect, it } from 'vitest'
import semantics from '../src/shared/texture-clarity-semantics.json'
import {
  buildAtrLookupTable,
  internalClassFromAtr,
  normalizeTextureClaritySize,
  textureClarityClassById,
  textureClarityColorRgb,
  TEXTURE_CLARITY_CLASSES,
  TEXTURE_CLARITY_OUTPUT_POLICY,
  TEXTURE_CLARITY_SUPPORT_CLASS_IDS,
} from '../src/canvas/lib/textureClarity'

describe('texture clarity 语义字典', () => {
  it('类别 id 连续、不重复，key 也不重复', () => {
    const ids = TEXTURE_CLARITY_CLASSES.map((item) => item.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe(0)
    expect(ids[ids.length - 1]).toBe(ids.length - 1)
    const keys = TEXTURE_CLARITY_CLASSES.map((item) => item.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('背景不计入融合支持区', () => {
    // 这条是原图保护的底线：支持区外像素必须严格等于原图，
    // 背景一旦进了支持区，模型改背景就再也挡不住了。
    expect(textureClarityClassById(0)?.key).toBe('background')
    expect(textureClarityClassById(0)?.repairSupport).toBe(false)
    expect(TEXTURE_CLARITY_SUPPORT_CLASS_IDS).not.toContain(0)
    expect(TEXTURE_CLARITY_SUPPORT_CLASS_IDS.length).toBe(TEXTURE_CLARITY_CLASSES.length - 1)
  })

  it('每个类别都有合法的 #RRGGBB 颜色，且颜色互不相同', () => {
    const colors = TEXTURE_CLARITY_CLASSES.map((item) => item.color)
    colors.forEach((color) => expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/))
    expect(new Set(colors.map((c) => c.toLowerCase())).size).toBe(colors.length)
  })

  it('ATR 18 类全部有映射，且都落在内部字典里', () => {
    const atrKeys = Object.keys(semantics.atrLabels)
    expect(atrKeys.length).toBe(18)
    const internalIds = new Set(TEXTURE_CLARITY_CLASSES.map((item) => item.id))
    atrKeys.forEach((key) => {
      const mapped = semantics.atrToInternal[key as keyof typeof semantics.atrToInternal]
      expect(mapped, `ATR ${key} 没有映射`).toBeTypeOf('number')
      expect(internalIds.has(mapped), `ATR ${key} 映射到了不存在的内部 id ${mapped}`).toBe(true)
    })
  })

  it('ATR 背景映射到内部背景，认不出来的也归背景', () => {
    expect(internalClassFromAtr(0)).toBe(0)
    // 越界 / 负数 / 非整数都不能悄悄变成某个可修复类别
    expect(internalClassFromAtr(18)).toBe(0)
    expect(internalClassFromAtr(255)).toBe(0)
    expect(internalClassFromAtr(-1)).toBe(0)
    expect(internalClassFromAtr(Number.NaN)).toBe(0)
  })

  it('几个关键 ATR 类映射符合设计意图', () => {
    expect(internalClassFromAtr(2)).toBe(textureClarityClassById(2)?.id) // Hair -> 发丝
    expect(textureClarityClassById(internalClassFromAtr(2))?.key).toBe('hair')
    expect(textureClarityClassById(internalClassFromAtr(11))?.key).toBe('face') // Face -> 面部
    expect(textureClarityClassById(internalClassFromAtr(3))?.key).toBe('face') // 眼镜归面部
    expect(textureClarityClassById(internalClassFromAtr(1))?.key).toBe('garment') // 帽子归服装
    expect(textureClarityClassById(internalClassFromAtr(14))?.key).toBe('limb') // 手臂
    expect(textureClarityClassById(internalClassFromAtr(15))?.key).toBe('limb')
    expect(textureClarityClassById(internalClassFromAtr(4))?.key).toBe('garment') // 上装
  })

  it('查表和逐个映射结果一致，长度 256', () => {
    const table = buildAtrLookupTable()
    expect(table.length).toBe(256)
    for (let atrId = 0; atrId < 256; atrId += 1) {
      expect(table[atrId]).toBe(internalClassFromAtr(atrId))
    }
  })

  it('颜色能解析成 rgb', () => {
    expect(textureClarityColorRgb(1)).toEqual([0xe8, 0x54, 0x4a])
    expect(textureClarityColorRgb(999)).toEqual([0, 0, 0])
  })
})

describe('输出尺寸规范化', () => {
  it('小图不放大，尺寸对齐偶数', () => {
    const result = normalizeTextureClaritySize(1200, 800)
    expect(result.scale).toBe(1)
    expect(result.width).toBe(1200)
    expect(result.height).toBe(800)
  })

  it('超过 2K 时按最长边缩，比例保持', () => {
    const result = normalizeTextureClaritySize(3584, 4800)
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(
      TEXTURE_CLARITY_OUTPUT_POLICY.maxEdge,
    )
    // 3584x4800 是设计稿截图里那张图的尺寸，缩完必须还是竖图且比例几乎不变
    const before = 3584 / 4800
    const after = result.width / result.height
    expect(Math.abs(after - before)).toBeLessThan(0.01)
  })

  it('宽高都对齐到偶数', () => {
    const result = normalizeTextureClaritySize(1999, 1001)
    expect(result.width % 2).toBe(0)
    expect(result.height % 2).toBe(0)
  })

  it('极端小尺寸不会算出 0', () => {
    const result = normalizeTextureClaritySize(1, 1)
    expect(result.width).toBeGreaterThanOrEqual(2)
    expect(result.height).toBeGreaterThanOrEqual(2)
  })
})
