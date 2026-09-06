/**
 * 三维空间节点的镜头数学（2026-08-26 用户要求：视角可以自由变换，还能变焦距）。
 *
 * 为什么这些断言值得写死：焦距是给人看的（「35mm 广一点、85mm 拍脸」），
 * three 吃的是垂直视场角。中间这道换算错了不会报错、不会崩，只会让「50mm」拍出
 * 一张广角变形的图 —— 而这个节点的全部意义就是出一张构图靠得住的参考图。
 * 所以拿真实的镜头对照表来钉。
 */
import { describe, expect, it } from 'vitest'

const {
  SENSOR_HEIGHT_MM,
  MIN_FOCAL_MM,
  MAX_FOCAL_MM,
  FOCAL_PRESETS_MM,
  MAX_PITCH_DEG,
  clampFocalMm,
  clampPitchDeg,
  clampOrbitDistance,
  normalizeYawDeg,
  focalToFovDeg,
  fovDegToFocalMm,
  horizontalFovDeg,
  orbitToPosition,
  positionToOrbit,
  captureSize,
} = await import('@/features/director-stage/cameraMath')

describe('焦距 ↔ 视场角', () => {
  // 35mm 全画幅的标准对照表（垂直 FOV，感光面高 24mm）。查得到的公开数据。
  it.each([
    [14, 81.2],
    [24, 53.1],
    [35, 37.8],
    [50, 27.0],
    [85, 16.1],
    [135, 10.2],
    [200, 6.9],
  ])('%imm 的垂直视场角约 %f°', (focal, expected) => {
    expect(focalToFovDeg(focal)).toBeCloseTo(expected, 0)
  })

  it('和反解互逆', () => {
    for (const focal of FOCAL_PRESETS_MM) {
      expect(fovDegToFocalMm(focalToFovDeg(focal))).toBeCloseTo(focal, 6)
    }
  })

  it('焦距越长视场角越小（不然滑杆方向就是反的）', () => {
    expect(focalToFovDeg(24)).toBeGreaterThan(focalToFovDeg(50))
    expect(focalToFovDeg(50)).toBeGreaterThan(focalToFovDeg(135))
  })

  it('用的是感光面**高**度 —— 换成宽度算出来会偏广一档', () => {
    // 2*atan(12/50) = 27.0°；若误用 18mm（36/2）会算成 39.6°
    expect(focalToFovDeg(50)).toBeCloseTo(2 * Math.atan(SENSOR_HEIGHT_MM / 2 / 50) * 180 / Math.PI, 9)
    expect(focalToFovDeg(50)).toBeLessThan(30)
  })

  it('水平视场角随画面比例变宽，竖幅时比垂直的窄', () => {
    expect(horizontalFovDeg(50, 16 / 9)).toBeGreaterThan(focalToFovDeg(50))
    expect(horizontalFovDeg(50, 9 / 16)).toBeLessThan(focalToFovDeg(50))
    // 3:2 就是全画幅本身的比例，此时水平 FOV 正好是 36mm 那一边
    expect(horizontalFovDeg(50, 3 / 2)).toBeCloseTo(2 * Math.atan(18 / 50) * 180 / Math.PI, 6)
  })

  it('脏输入不会算出 NaN', () => {
    expect(focalToFovDeg(undefined)).toBeGreaterThan(0)
    expect(focalToFovDeg('abc')).toBeGreaterThan(0)
    expect(Number.isFinite(fovDegToFocalMm(NaN))).toBe(true)
    expect(Number.isFinite(fovDegToFocalMm(0))).toBe(true)
  })
})

describe('各种钳制', () => {
  it('焦距钳在 14–200mm', () => {
    expect(clampFocalMm(5)).toBe(MIN_FOCAL_MM)
    expect(clampFocalMm(999)).toBe(MAX_FOCAL_MM)
    expect(clampFocalMm(85)).toBe(85)
  })

  it('俯仰不到 ±90 —— 正好 90 度时相机的 up 向量会翻，画面会跳', () => {
    expect(clampPitchDeg(120)).toBe(MAX_PITCH_DEG)
    expect(clampPitchDeg(-120)).toBe(-MAX_PITCH_DEG)
    expect(Math.abs(clampPitchDeg(90))).toBeLessThan(90)
  })

  it('距离有下限，不许贴到目标点里面（会看到模型内部）', () => {
    expect(clampOrbitDistance(0)).toBeGreaterThan(0)
    expect(clampOrbitDistance(-3)).toBeGreaterThan(0)
    expect(clampOrbitDistance(1e6)).toBeLessThanOrEqual(40)
  })

  it('yaw 归一化到 [0,360)，转多圈数字不累积', () => {
    expect(normalizeYawDeg(370)).toBeCloseTo(10, 9)
    expect(normalizeYawDeg(-10)).toBeCloseTo(350, 9)
    expect(normalizeYawDeg(720)).toBeCloseTo(0, 9)
  })
})

describe('轨道角度 ↔ 相机坐标', () => {
  const target: [number, number, number] = [0, 0.95, 0]

  it('yaw=0 / pitch=0 是正面平视：相机在目标的 +Z 上、同高', () => {
    const [x, y, z] = orbitToPosition({ yaw: 0, pitch: 0, distance: 4, target })
    expect(x).toBeCloseTo(0, 9)
    expect(y).toBeCloseTo(target[1], 9)
    expect(z).toBeCloseTo(target[2] + 4, 9)
  })

  it('yaw=90 把相机转到 +X 一侧', () => {
    const [x, , z] = orbitToPosition({ yaw: 90, pitch: 0, distance: 4, target })
    expect(x).toBeCloseTo(4, 6)
    expect(z).toBeCloseTo(0, 6)
  })

  it('pitch 为正 = 相机在上方往下看', () => {
    const [, y] = orbitToPosition({ yaw: 0, pitch: 30, distance: 4, target })
    expect(y).toBeGreaterThan(target[1])
  })

  it('和反解互逆 —— OrbitControls 拖完要把结果读回来存库', () => {
    for (const angles of [
      { yaw: 18, pitch: 6, distance: 4.2, target },
      { yaw: 200, pitch: -35, distance: 1.5, target },
      { yaw: 350, pitch: 70, distance: 12, target },
    ]) {
      const back = positionToOrbit(orbitToPosition(angles), target)
      expect(back.yaw).toBeCloseTo(angles.yaw, 5)
      expect(back.pitch).toBeCloseTo(angles.pitch, 5)
      expect(back.distance).toBeCloseTo(angles.distance, 5)
    }
  })

  it('相机和目标重合时不产生 NaN', () => {
    const back = positionToOrbit([0, 0.95, 0], target)
    expect(Number.isFinite(back.yaw)).toBe(true)
    expect(Number.isFinite(back.pitch)).toBe(true)
    expect(Number.isFinite(back.distance)).toBe(true)
  })
})

describe('出图尺寸', () => {
  it('横幅按短边给高，竖幅按短边给宽', () => {
    expect(captureSize('16:9', 1024)).toMatchObject({ width: 1820, height: 1024 })
    expect(captureSize('9:16', 1024)).toMatchObject({ width: 1024, height: 1820 })
    expect(captureSize('1:1', 1024)).toMatchObject({ width: 1024, height: 1024 })
  })

  it('比例写坏了退回 1:1，不返回 0 或 NaN（0 尺寸的 canvas 截图直接失败）', () => {
    for (const ratio of ['', 'abc', '0:0', '16', '16:0']) {
      const size = captureSize(ratio, 1024)
      expect(size.width).toBeGreaterThan(0)
      expect(size.height).toBeGreaterThan(0)
    }
  })

  it('短边有下限', () => {
    expect(captureSize('16:9', 0).height).toBeGreaterThanOrEqual(64)
    expect(captureSize('16:9', -5).height).toBeGreaterThanOrEqual(64)
  })
})
