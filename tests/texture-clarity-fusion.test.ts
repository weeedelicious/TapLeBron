import { describe, expect, it } from 'vitest'
import {
  buildSupportMask,
  boxBlur,
  countOutsideChanges,
  dilateMask,
  downscale,
  estimateTranslation,
  fuseTextureClarity,
  luminance,
  seamColorDelta,
  shiftRgb,
} from '../server/services/TextureClarityFusion.js'
import { buildAtrLookupTable, TEXTURE_CLARITY_CLASSES } from '../src/canvas/lib/textureClarity'

const W = 64
const H = 48

/** 内部类别 id -> 是否计入支持区，口径来自共享字典。 */
function supportFlags(): Uint8Array {
  const flags = new Uint8Array(256)
  TEXTURE_CLARITY_CLASSES.forEach((item) => {
    flags[item.id] = item.repairSupport ? 1 : 0
  })
  return flags
}

/** 平坦底色 + 中间一块加了高频噪声的方块，用来模拟"候选图在人物区域多了纹理"。 */
function makeSource(width = W, height = H, base = 120): Uint8Array {
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = base
    rgb[i * 3 + 1] = base
    rgb[i * 3 + 2] = base
  }
  return rgb
}

/** ATR 类别图：中间矩形是 Face(11)，其余是 Background(0)。 */
function makeClassMap(width = W, height = H, x0 = 16, y0 = 12, x1 = 48, y1 = 36): Uint8Array {
  const map = new Uint8Array(width * height)
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) map[y * width + x] = 11
  }
  return map
}

function addDetail(rgb: Uint8Array, width: number, height: number, amplitude = 30): Uint8Array {
  const out = Uint8Array.from(rgb)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3
      // 棋盘格高频，模拟毛孔/发丝这种细节
      const delta = ((x + y) % 2 === 0 ? amplitude : -amplitude)
      out[i] = Math.max(0, Math.min(255, out[i] + delta))
      out[i + 1] = Math.max(0, Math.min(255, out[i + 1] + delta))
      out[i + 2] = Math.max(0, Math.min(255, out[i + 2] + delta))
    }
  }
  return out
}

describe('基础算子', () => {
  it('亮度用 Rec.709 权重', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255])
    const lum = luminance(rgb, 3, 1)
    expect(Math.round(lum[0])).toBe(54)
    expect(Math.round(lum[1])).toBe(182)
    expect(Math.round(lum[2])).toBe(18)
  })

  it('降采样取块平均，factor=1 原样返回', () => {
    const data = new Float32Array([0, 10, 20, 30])
    const same = downscale(data, 2, 2, 1)
    expect(same.data).toBe(data)
    const half = downscale(data, 2, 2, 2)
    expect(half.width).toBe(1)
    expect(half.height).toBe(1)
    expect(half.data[0]).toBe(15)
  })

  it('盒式模糊保持常量场不变（不会把平坦区搞出渐变）', () => {
    const flat = new Float32Array(W * H).fill(77)
    const blurred = boxBlur(flat, W, H, 5, 3)
    for (let i = 0; i < blurred.length; i += 1) expect(blurred[i]).toBeCloseTo(77, 4)
  })

  it('盒式模糊把单点摊开且总量守恒方向正确', () => {
    const spike = new Float32Array(9 * 9)
    spike[4 * 9 + 4] = 255
    const blurred = boxBlur(spike, 9, 9, 1, 1)
    expect(blurred[4 * 9 + 4]).toBeLessThan(255)
    expect(blurred[4 * 9 + 3]).toBeGreaterThan(0)
  })

  it('膨胀按半径外扩，radius=0 原样', () => {
    const mask = new Uint8Array(9 * 9)
    mask[4 * 9 + 4] = 255
    expect(Array.from(dilateMask(mask, 9, 9, 0))).toEqual(Array.from(mask))
    const grown = dilateMask(mask, 9, 9, 1)
    let count = 0
    grown.forEach((v) => { if (v) count += 1 })
    expect(count).toBe(9) // 3x3 方形结构元
  })

  it('支持区按类别 id 判定：背景不进，人物类进', () => {
    const classMap = new Uint8Array([0, 11, 2, 4, 16, 99])
    const mask = buildSupportMask(classMap, buildAtrLookupTable(), supportFlags())
    expect(Array.from(mask)).toEqual([0, 255, 255, 255, 255, 0])
    //                                背景  脸   头发  上装  包   越界->背景
  })
})

describe('配准', () => {
  it('没有位移时估计为 0', () => {
    const source = addDetail(makeSource(), W, H)
    const lum = luminance(source, W, H)
    const result = estimateTranslation(lum, lum, W, H, { downscale: 2, maxShift: 6 })
    expect(result.dx).toBe(0)
    expect(result.dy).toBe(0)
    expect(result.error).toBeLessThan(0.001)
  })

  it('能找回人为制造的整体位移', () => {
    // 一块有结构的图：竖条纹，横向位移可辨认
    const source = makeSource()
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 3
        const v = x % 16 < 8 ? 60 : 200
        source[i] = v; source[i + 1] = v; source[i + 2] = v
      }
    }
    const shifted = shiftRgb(source, source, W, H, -4, 0)
    const result = estimateTranslation(
      luminance(source, W, H),
      luminance(shifted, W, H),
      W, H,
      { downscale: 1, maxShift: 8 },
    )
    expect(result.dx).toBe(4)
    expect(result.dy).toBe(0)
  })

  it('平移把候选图搬回原坐标系，画外用原图填', () => {
    const source = makeSource(4, 1, 10)
    const candidate = new Uint8Array([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4])
    const shifted = shiftRgb(candidate, source, 4, 1, 1, 0)
    // dx=1 表示取候选图 x+1 的像素；最后一列越界，用原图 10 填
    expect(Array.from(shifted)).toEqual([2, 2, 2, 3, 3, 3, 4, 4, 4, 10, 10, 10])
  })
})

describe('融合链整体', () => {
  const lookup = buildAtrLookupTable()
  const flags = supportFlags()

  it('候选图与原图完全相同时，输出逐字节等于原图', () => {
    const source = addDetail(makeSource(), W, H)
    const result = fuseTextureClarity({
      source,
      candidate: Uint8Array.from(source),
      classMap: makeClassMap(),
      width: W,
      height: H,
      lookup,
      supportFlags: flags,
    })
    expect(result.diagnostics.outsideChangedPixels).toBe(0)
    expect(Array.from(result.output)).toEqual(Array.from(source))
    expect(result.passed).toBe(true)
  })

  it('蒙版外像素严格等于原图，蒙版内确实吃到了候选图的细节', () => {
    const source = makeSource()
    const candidate = addDetail(source, W, H, 40)
    const result = fuseTextureClarity({
      source,
      candidate,
      classMap: makeClassMap(),
      width: W,
      height: H,
      lookup,
      supportFlags: flags,
      options: { dilateRadius: 0, featherRadius: 1 },
    })

    expect(result.diagnostics.outsideChangedPixels).toBe(0)

    // 支持区中心必须被改动（拿到高频细节）
    const center = ((H / 2) * W + W / 2) * 3
    expect(result.output[center]).not.toBe(source[center])

    // 远离支持区的角落必须一模一样
    for (const corner of [0, (W - 1) * 3, (H - 1) * W * 3]) {
      expect(result.output[corner]).toBe(source[corner])
      expect(result.output[corner + 1]).toBe(source[corner + 1])
      expect(result.output[corner + 2]).toBe(source[corner + 2])
    }
  })

  it('候选图整体偏色不会带进输出（低频色漂被减掉）', () => {
    const source = makeSource(W, H, 120)
    // 候选图：同样的细节，但整体加了 40 的偏色（模型顺手把画面调亮/调暖）
    const candidate = addDetail(source, W, H, 20)
    for (let i = 0; i < candidate.length; i += 3) {
      candidate[i] = Math.min(255, candidate[i] + 40)
    }
    const result = fuseTextureClarity({
      source,
      candidate,
      classMap: makeClassMap(),
      width: W,
      height: H,
      lookup,
      supportFlags: flags,
      options: { dilateRadius: 0, featherRadius: 1, lowFrequencyRadius: 6 },
    })

    // 支持区内红通道的平均值不应被那 40 的偏色抬起来 —— 允许几个灰阶的数值误差
    let sum = 0
    let count = 0
    for (let y = 16; y < 32; y += 1) {
      for (let x = 20; x < 44; x += 1) {
        sum += result.output[(y * W + x) * 3]
        count += 1
      }
    }
    expect(Math.abs(sum / count - 120)).toBeLessThan(6)
  })

  it('支持区为空时门禁报 MASK_TOO_SMALL', () => {
    const source = makeSource()
    const result = fuseTextureClarity({
      source,
      candidate: addDetail(source, W, H),
      classMap: new Uint8Array(W * H), // 全背景
      width: W,
      height: H,
      lookup,
      supportFlags: flags,
    })
    expect(result.passed).toBe(false)
    expect(result.failures.map((f: { code: string }) => f.code)).toContain('MASK_TOO_SMALL')
    // 全背景意味着输出必须等于原图
    expect(Array.from(result.output)).toEqual(Array.from(source))
  })

  it('候选图整体位移过大时门禁报 REGISTRATION_SHIFT，不去掰几何', () => {
    const source = makeSource()
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 3
        const v = x % 8 < 4 ? 40 : 210
        source[i] = v; source[i + 1] = v; source[i + 2] = v
      }
    }
    const moved = shiftRgb(source, source, W, H, -30, 0)
    const result = fuseTextureClarity({
      source,
      candidate: moved,
      classMap: makeClassMap(),
      width: W,
      height: H,
      lookup,
      supportFlags: flags,
      options: {
        registrationDownscale: 1,
        registrationMaxShift: 40,
        gates: { maxRegistrationShift: 24 },
      },
    })
    expect(result.passed).toBe(false)
    expect(result.failures.map((f: { code: string }) => f.code)).toContain('REGISTRATION_SHIFT')
    expect(Math.abs(result.diagnostics.registrationDx)).toBeGreaterThan(24)
  })

  it('尺寸不符直接抛错，不静悄悄算错', () => {
    const source = makeSource()
    expect(() => fuseTextureClarity({
      source,
      candidate: new Uint8Array(source.length - 3),
      classMap: makeClassMap(),
      width: W,
      height: H,
      lookup,
      supportFlags: flags,
    })).toThrow(/候选图缓冲尺寸不符/)

    expect(() => fuseTextureClarity({
      source,
      candidate: Uint8Array.from(source),
      classMap: new Uint8Array(W * H - 1),
      width: W,
      height: H,
      lookup,
      supportFlags: flags,
    })).toThrow(/语义类别图尺寸不符/)
  })

  it('诊断字段齐全，融合策略号对得上共享配置', () => {
    const source = makeSource()
    const result = fuseTextureClarity({
      source,
      candidate: addDetail(source, W, H),
      classMap: makeClassMap(),
      width: W,
      height: H,
      lookup,
      supportFlags: flags,
    })
    const d = result.diagnostics
    for (const key of [
      'width', 'height', 'registrationDx', 'registrationDy', 'registrationError',
      'dilateRadius', 'featherRadius', 'lowFrequencyRadius', 'maskCoverage',
      'rawMaskCoverage', 'outsideChangedPixels', 'seamColorDelta', 'fusionPolicy',
    ]) {
      expect(d[key], `诊断缺字段 ${key}`).toBeDefined()
    }
    expect(d.fusionPolicy).toBe('smart-blend-multiscale-v1')
    expect(d.rawMaskCoverage).toBeGreaterThan(0)
  })
})

describe('诊断算子', () => {
  it('countOutsideChanges 只看权重为 0 的地方', () => {
    const source = new Uint8Array([10, 10, 10, 20, 20, 20])
    const output = new Uint8Array([10, 10, 10, 99, 99, 99])
    // 第二个像素权重为 1（在支持区内），改了不算违规
    expect(countOutsideChanges(output, source, new Float32Array([0, 1]))).toBe(0)
    // 权重为 0 时改了就算
    expect(countOutsideChanges(output, source, new Float32Array([0, 0]))).toBe(1)
  })

  it('seamColorDelta 只统计羽化带', () => {
    const source = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0])
    const output = new Uint8Array([30, 30, 30, 60, 60, 60, 90, 90, 90])
    // 只有中间那个像素在 0<w<1
    expect(seamColorDelta(output, source, new Float32Array([0, 0.5, 1]))).toBeCloseTo(60, 5)
    // 没有羽化带时给 0，不是 NaN
    expect(seamColorDelta(output, source, new Float32Array([0, 0, 0]))).toBe(0)
  })
})
