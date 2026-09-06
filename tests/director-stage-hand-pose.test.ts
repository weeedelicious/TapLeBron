/**
 * 手指的滑杆与手势预设（2026-08-26 用户选的粒度：每指一根滑杆 + 预设）。
 *
 * 这里守的是「一根滑杆管三个指节」这套映射里最容易出错的几处：
 *
 * ① **写进去再读出来必须还是同一个数。** 滑杆值不存库（存的是三节角度），
 *    显示值靠反算。反算写错的话，拖到 60 松手会跳成别的数 —— 手感上很明显但很难查。
 *
 * ② **反翘时中节不能动。** 中节在解剖上不能反弯，范围下限是 0；
 *    曲线要是按统一比例硬乘，中节会被钳在 0 而其它两节反翘，手指看着像断了一节。
 *
 * ③ **预设必须落在钳制范围内。** 越界不会报错，只会被静默钳住 ——
 *    于是「握拳」和「指向」可能长得一样，而没人知道是预设写飞了。
 */
import { describe, expect, it } from 'vitest'

const {
  FINGER_JOINT_IDS,
  FINGER_NAMES,
  JOINT_BY_ID,
  clampJointAngles,
  poseAngles,
} = await import('@/features/director-stage/skeleton')
const {
  FINGER_CURL_MAX,
  FINGER_CURL_MIN,
  FINGER_CURL_PROFILE,
  HAND_PRESETS,
  applyHandPreset,
  applyHandSnapshot,
  clearHand,
  fingerSpreadRange,
  handPoseCount,
  readFingerCurl,
  readFingerSpread,
  segmentCurlAngle,
  setFingerCurl,
  setFingerSpread,
  snapshotHand,
} = await import('@/features/director-stage/handPose')

const curlOf = (pose: Record<string, unknown>, id: string) => poseAngles(pose as never, id as never)[2]

describe('一根滑杆卷三个指节', () => {
  it('写三个关节，不是只写近节', () => {
    const pose = setFingerCurl({}, 'L', 'index', 60)
    for (const id of FINGER_JOINT_IDS.L.index) expect(pose[id], id).toBeDefined()
    expect(Object.keys(pose)).toHaveLength(3)
  })

  it('★ 中节弯得最狠（曲线系数是 1），卷起来是螺旋不是钩子', () => {
    const pose = setFingerCurl({}, 'L', 'index', FINGER_CURL_MAX)
    const [proximal, middle, distal] = FINGER_JOINT_IDS.L.index
    expect(curlOf(pose, middle)).toBe(JOINT_BY_ID[middle].axes.tilt!.max)
    expect(curlOf(pose, proximal)).toBeLessThan(JOINT_BY_ID[proximal].axes.tilt!.max)
    expect(curlOf(pose, distal)).toBeLessThan(JOINT_BY_ID[distal].axes.tilt!.max)
    expect(FINGER_CURL_PROFILE[1]).toBe(1)
  })

  it('每一节都在自己范围内 —— 拇指范围不同也不会越界', () => {
    for (const side of ['L', 'R'] as const) {
      for (const name of FINGER_NAMES) {
        for (const curl of [FINGER_CURL_MIN, -10, 0, 33, 70, FINGER_CURL_MAX]) {
          const pose = setFingerCurl({}, side, name, curl)
          for (const id of FINGER_JOINT_IDS[side][name]) {
            expect(pose[id], `${id} @ ${curl}`).toEqual(clampJointAngles(id, pose[id]))
          }
        }
      }
    }
  })

  it('★ 写进去读出来还是同一个数', () => {
    for (const name of FINGER_NAMES) {
      for (const curl of [0, 12, 40, 65, 88, FINGER_CURL_MAX]) {
        const pose = setFingerCurl({}, 'L', name, curl)
        expect(readFingerCurl(pose, 'L', name), `${name} @ ${curl}`).toBe(curl)
      }
    }
  })

  it('★ 反翘时中节不动（解剖上不能反弯）', () => {
    const pose = setFingerCurl({}, 'L', 'index', FINGER_CURL_MIN)
    const [proximal, middle] = FINGER_JOINT_IDS.L.index
    expect(curlOf(pose, middle)).toBe(0)
    expect(curlOf(pose, proximal)).toBe(JOINT_BY_ID[proximal].axes.tilt!.min)
    expect(readFingerCurl(pose, 'L', 'index')).toBe(FINGER_CURL_MIN)
  })

  it('滑杆超范围被夹住，脏输入按 0', () => {
    const high = setFingerCurl({}, 'L', 'index', 999)
    expect(readFingerCurl(high, 'L', 'index')).toBe(FINGER_CURL_MAX)
    const low = setFingerCurl({}, 'L', 'index', -999)
    expect(readFingerCurl(low, 'L', 'index')).toBe(FINGER_CURL_MIN)
    // 非有限值当成「没有数据」→ 0（静止），不是夹到上限。
    // 夹到上限的话，一个 NaN 会静默变成一个握拳，而且看不出是数据坏了。
    expect(segmentCurlAngle('index2L', Number.NaN, 1)).toBe(0)
    expect(segmentCurlAngle('index2L', Number.POSITIVE_INFINITY, 1)).toBe(0)
  })

  it('不认识的关节不抛', () => {
    expect(segmentCurlAngle('nope' as never, 50, 0)).toBe(0)
  })

  it('只动这根手指，别的手指和身体关节都不碰', () => {
    const before = { elbowL: [30, 0, 0] as [number, number, number], middle2L: [0, 0, 44] as [number, number, number] }
    const after = setFingerCurl(before, 'L', 'index', 70)
    expect(after.elbowL).toEqual(before.elbowL)
    expect(after.middle2L).toEqual(before.middle2L)
    expect(before.middle2L).toEqual([0, 0, 44]) // 输入没被改
  })
})

describe('张开', () => {
  it('只动近节的 bend 轴', () => {
    const pose = setFingerSpread({}, 'L', 'index', 20)
    expect(Object.keys(pose)).toEqual([FINGER_JOINT_IDS.L.index[0]])
    expect(poseAngles(pose, FINGER_JOINT_IDS.L.index[0])[0]).toBe(20)
    expect(readFingerSpread(pose, 'L', 'index')).toBe(20)
  })

  it('张开和弯曲互不干扰（一起用时两个轴各管各的）', () => {
    const pose = setFingerSpread(setFingerCurl({}, 'L', 'index', 50), 'L', 'index', 18)
    expect(readFingerCurl(pose, 'L', 'index')).toBe(50)
    expect(readFingerSpread(pose, 'L', 'index')).toBe(18)
  })

  it('范围来自关节表，左右一致', () => {
    for (const name of FINGER_NAMES) {
      expect(fingerSpreadRange('L', name)).toEqual(fingerSpreadRange('R', name))
      expect(fingerSpreadRange('L', name).max).toBeGreaterThan(0)
    }
    // 拇指张得最开、中指最不能张
    expect(fingerSpreadRange('L', 'thumb').max).toBeGreaterThan(fingerSpreadRange('L', 'middle').max)
  })

  it('超范围被夹住', () => {
    const pose = setFingerSpread({}, 'L', 'middle', 999)
    expect(readFingerSpread(pose, 'L', 'middle')).toBe(JOINT_BY_ID.middle1L.axes.bend!.max)
  })
})

describe('★ 手势预设', () => {
  it('每个预设写满三节角度，且都落在钳制范围内（越界会被静默夹住）', () => {
    for (const preset of HAND_PRESETS) {
      for (const name of FINGER_NAMES) {
        const joints = preset.fingers[name]
        expect(joints, `${preset.key}/${name}`).toHaveLength(3)
        FINGER_JOINT_IDS.L[name].forEach((id, index) => {
          expect(clampJointAngles(id, joints[index]), `${preset.key}/${id}`).toEqual([...joints[index]])
        })
      }
    }
  })

  it('应用后读回来就是预设写的数（没被夹）', () => {
    for (const preset of HAND_PRESETS) {
      const pose = applyHandPreset({}, 'L', preset.key)
      for (const name of FINGER_NAMES) {
        FINGER_JOINT_IDS.L[name].forEach((id, index) => {
          expect(pose[id], `${preset.key}/${id}`).toEqual(clampJointAngles(id, preset.fingers[name][index]))
        })
      }
    }
  })

  it('每个预设都写满 15 个关节', () => {
    for (const preset of HAND_PRESETS) {
      expect(handPoseCount(applyHandPreset({}, 'L', preset.key), 'L'), preset.key).toBe(15)
    }
  })

  it('几个预设彼此不一样（不然点了没反应）', () => {
    const shapes = HAND_PRESETS.map((preset) => JSON.stringify(applyHandPreset({}, 'L', preset.key)))
    expect(new Set(shapes).size).toBe(HAND_PRESETS.length)
  })

  it('「握拳」四指卷满、拇指对掌收到掌心（不是支在旁边）', () => {
    const pose = applyHandPreset({}, 'L', 'fist')
    for (const name of ['index', 'middle', 'ring', 'little'] as const) {
      expect(readFingerCurl(pose, 'L', name), name).toBeGreaterThanOrEqual(90)
    }
    expect(poseAngles(pose, 'thumb1L')[1], '拇指对掌 turn 必须是负数（正数是往外支）').toBeLessThanOrEqual(-20)
    expect(poseAngles(pose, 'index1L')[0], '食指应合拢而不是外张').toBeLessThanOrEqual(0)
    expect(poseAngles(pose, 'index2L')[2], '食指中节应顶满').toBe(110)
  })

  it('存当前手再套回去，15 节完全一样', () => {
    const pose = applyHandPreset({}, 'L', 'fist')
    const snap = snapshotHand(pose, 'L')
    const restored = applyHandSnapshot({}, 'L', snap)
    for (const name of FINGER_NAMES) {
      for (const id of FINGER_JOINT_IDS.L[name]) expect(restored[id], id).toEqual(pose[id])
    }
  })

  it('「指向」的食指是伸直的、其它四指是卷的', () => {
    const pose = applyHandPreset({}, 'L', 'point')
    expect(readFingerCurl(pose, 'L', 'index')).toBe(0)
    for (const name of ['middle', 'ring', 'little'] as const) {
      expect(readFingerCurl(pose, 'L', name), name).toBeGreaterThan(80)
    }
  })

  it('「剪刀」是食指中指伸直、无名指小指卷起', () => {
    const pose = applyHandPreset({}, 'L', 'scissors')
    expect(readFingerCurl(pose, 'L', 'index')).toBe(0)
    expect(readFingerCurl(pose, 'L', 'middle')).toBe(0)
    expect(readFingerCurl(pose, 'L', 'ring')).toBeGreaterThan(80)
    expect(readFingerCurl(pose, 'L', 'little')).toBeGreaterThan(80)
  })

  it('★ 左右手同一个预设，角度数字完全一样（方向靠 mirror，不靠不同的数）', () => {
    const left = applyHandPreset({}, 'L', 'fist')
    const right = applyHandPreset({}, 'R', 'fist')
    for (const name of FINGER_NAMES) {
      FINGER_JOINT_IDS.L[name].forEach((leftId, index) => {
        expect(right[FINGER_JOINT_IDS.R[name][index]], `${leftId} vs 右手`).toEqual(left[leftId])
      })
    }
  })

  it('只动一只手', () => {
    const pose = applyHandPreset({ index2R: [0, 0, 33] }, 'L', 'fist')
    expect(pose.index2R).toEqual([0, 0, 33])
    expect(handPoseCount(pose, 'R')).toBe(1)
  })

  it('不认识的预设名原样返回', () => {
    const before = { index2L: [0, 0, 10] as [number, number, number] }
    expect(applyHandPreset(before, 'L', 'nope')).toBe(before)
  })
})

describe('重置这只手', () => {
  it('清掉 15 个关节，另一只手和身体不动', () => {
    const pose = applyHandPreset(applyHandPreset({ elbowL: [40, 0, 0] }, 'L', 'fist'), 'R', 'open')
    expect(handPoseCount(pose, 'L')).toBe(15)
    const cleared = clearHand(pose, 'L')
    expect(handPoseCount(cleared, 'L')).toBe(0)
    expect(handPoseCount(cleared, 'R')).toBe(15)
    expect(cleared.elbowL).toEqual([40, 0, 0])
  })

  it('清完再读滑杆是 0', () => {
    const cleared = clearHand(applyHandPreset({}, 'L', 'fist'), 'L')
    for (const name of FINGER_NAMES) {
      expect(readFingerCurl(cleared, 'L', name), name).toBe(0)
      expect(readFingerSpread(cleared, 'L', name), name).toBe(0)
    }
  })

  it('不改动输入对象', () => {
    const pose = applyHandPreset({}, 'L', 'fist')
    const snapshot = JSON.stringify(pose)
    clearHand(pose, 'L')
    expect(JSON.stringify(pose)).toBe(snapshot)
  })
})
