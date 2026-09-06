/**
 * 手指关节表（2026-08-26 用户要求：换个精细点的角色，手指也能动）。
 *
 * 这里锁三类容易静默出错的东西：
 *
 * ① **弯曲在 tilt 轴上，不是 bend。** 这条反直觉，早晚有人来「修」。
 *    理由是几何决定的：弯曲绕「横穿手掌」那根轴转，而自然站立时手掌朝内，
 *    横穿手掌的方向就是 Z。量过的数字：MakeHuman 手臂垂下后手掌自然朝内、只差 2.7°，
 *    要改成掌朝后好让弯曲落在 bend 上得强行扭 92.7°。所以有测试盯着，别改。
 *
 * ② **偏移必须来自生成文件。** 蒙皮白模的骨和这张表要是同一套数字，
 *    否则画面上的手和 IK 以为的手不在一处 —— 而且不报错，只是「拖手柄时手不跟手」。
 *
 * ③ 中远节是纯铰链。多给一个轴，IK 就能把手指掰成解剖上不存在的样子。
 */
import { describe, expect, it } from 'vitest'

const {
  DIRECTOR_JOINTS,
  FINGER_JOINT_IDS,
  FINGER_NAMES,
  JOINT_BY_ID,
  JOINT_IDS,
  axisEulerSign,
  clampJointAngles,
  FINGER_IK_CHAINS,
  fingerIkChainFor,
  isFingerJoint,
  jointAxes,
  jointChainToRoot,
} = await import('@/features/director-stage/skeleton')
const { MANNEQUIN_REST_OFFSETS } = await import('@/features/director-stage/mannequinRest.generated')
const { normalizePose } = await import('@/features/director-stage/types')
const { jointTipLocal } = await import('@/features/director-stage/ik')

type AnyId = 'wristL'

const FINGER_IDS = FINGER_NAMES.flatMap((name) =>
  (['L', 'R'] as const).flatMap((side) => FINGER_JOINT_IDS[side][name]),
)

describe('30 根指骨都在，且挂对了地方', () => {
  it('五指 × 三节 × 左右 = 30，一个不多一个不少', () => {
    expect(FINGER_IDS).toHaveLength(30)
    expect(new Set(FINGER_IDS).size).toBe(30)
    expect(JOINT_IDS.filter((id) => isFingerJoint(id))).toHaveLength(30)
    expect(JOINT_IDS).toHaveLength(49)
  })

  it('近节挂手腕，中远节顺次往下挂', () => {
    for (const side of ['L', 'R'] as const) {
      for (const name of FINGER_NAMES) {
        const [proximal, middle, distal] = FINGER_JOINT_IDS[side][name]
        expect(JOINT_BY_ID[proximal].parent, `${proximal}`).toBe(`wrist${side}`)
        expect(JOINT_BY_ID[middle].parent, `${middle}`).toBe(proximal)
        expect(JOINT_BY_ID[distal].parent, `${distal}`).toBe(middle)
      }
    }
  })

  it('每根指骨都能走回胯，且左右不串', () => {
    for (const side of ['L', 'R'] as const) {
      for (const name of FINGER_NAMES) {
        const chain = jointChainToRoot(FINGER_JOINT_IDS[side][name][2])
        expect(chain[chain.length - 1]).toBe('hips')
        expect(chain).toContain(`wrist${side}`)
        expect(chain).not.toContain(`wrist${side === 'L' ? 'R' : 'L'}`)
      }
    }
  })

  it('手指默认不出身体那套点选球（手上挤 30 个球点不准）', () => {
    for (const id of FINGER_IDS) expect(JOINT_BY_ID[id].pickable, id).toBe(false)
    // 身体关节反过来不许被顺手关掉
    for (const id of ['wristL', 'elbowL', 'hips', 'head'] as const) {
      expect(JOINT_BY_ID[id].pickable, id).not.toBe(false)
    }
  })

  it('每根手指都有指尖 IK 链（远节当末端，近/中节当链，不动手腕）', () => {
    expect(Object.keys(FINGER_IK_CHAINS)).toHaveLength(10)
    for (const side of ['L', 'R'] as const) {
      for (const name of FINGER_NAMES) {
        const [proximal, middle, distal] = FINGER_JOINT_IDS[side][name]
        const chain = fingerIkChainFor(distal)
        expect(chain, distal).toEqual({ effector: distal, links: [middle, proximal] })
        expect(fingerIkChainFor(proximal), proximal).toEqual(chain)
        expect(chain!.links).not.toContain(`wrist${side}`)
      }
    }
  })
})

describe('★ 弯曲在 tilt 轴上（别改成 bend —— 见文件头 ①）', () => {
  it('中节和远节只有 tilt 一个轴', () => {
    for (const side of ['L', 'R'] as const) {
      for (const name of FINGER_NAMES) {
        for (const id of FINGER_JOINT_IDS[side][name].slice(1)) {
          const axes = jointAxes(id)
          expect(axes.map((entry) => entry.axis), `${id} 的可调轴`).toEqual(['tilt'])
          expect(axes[0].def.label).toBe('弯曲')
        }
      }
    }
  })

  it('中远节给三个轴也只留 tilt', () => {
    expect(clampJointAngles('index2L', [40, 30, 20])).toEqual([0, 0, 20])
    expect(clampJointAngles('little3R', [40, 30, 20])).toEqual([0, 0, 20])
  })

  it('近节是「张开(bend) + 弯曲(tilt)」，拇指近节多一个对掌旋转', () => {
    for (const side of ['L', 'R'] as const) {
      for (const name of FINGER_NAMES) {
        const axes = jointAxes(FINGER_JOINT_IDS[side][name][0]).map((entry) => entry.axis)
        expect(axes, `${name}1${side}`).toEqual(name === 'thumb' ? ['bend', 'turn', 'tilt'] : ['bend', 'tilt'])
      }
    }
  })

  it('弯曲取反（正数=卷向掌心），左右靠 mirror 各卷向自己那侧', () => {
    for (const name of FINGER_NAMES) {
      // tilt 是第 3 个轴（下标 2）
      expect(axisEulerSign(`${name}2L`, 2), `${name}2L`).toBe(-1)
      expect(axisEulerSign(`${name}2R`, 2), `${name}2R`).toBe(1)
    }
  })

  it('张开不受 mirror 影响 —— 食指侧在 +Z，两只手都一样', () => {
    for (const name of FINGER_NAMES) {
      expect(axisEulerSign(`${name}1L`, 0)).toBe(axisEulerSign(`${name}1R`, 0))
    }
  })

  it('中节不能反弯（下限是 0），近远节可以微微反翘', () => {
    expect(JOINT_BY_ID.index2L.axes.tilt!.min).toBe(0)
    expect(JOINT_BY_ID.index1L.axes.tilt!.min).toBeLessThan(0)
    expect(JOINT_BY_ID.index3L.axes.tilt!.min).toBeLessThan(0)
  })
})

describe('★ 偏移来自生成文件（脱钩了蒙皮和 IK 就各说各话）', () => {
  it('49 个关节在生成文件里都有偏移', () => {
    for (const id of JOINT_IDS) {
      expect(MANNEQUIN_REST_OFFSETS[id], `${id} 没有生成的静止偏移`).toBeDefined()
    }
    expect(Object.keys(MANNEQUIN_REST_OFFSETS)).toHaveLength(49)
  })

  it('表里的偏移和生成文件逐位相等（不许手改成别的数）', () => {
    for (const joint of DIRECTOR_JOINTS) {
      expect(joint.offset, `${joint.id} 的偏移和生成文件不一致`)
        .toEqual(MANNEQUIN_REST_OFFSETS[joint.id])
    }
  })

  it('骨长是合理的人体尺寸（生成脚本跑歪了会露出来）', () => {
    const len = (id: AnyId | string) => {
      const offset = MANNEQUIN_REST_OFFSETS[id]
      return Math.hypot(offset[0], offset[1], offset[2])
    }
    // 上臂 22.8cm / 前臂 22.6cm / 大腿 42.1cm / 小腿 38.2cm（实测 MakeHuman 网格）
    expect(len('elbowL')).toBeCloseTo(0.228, 2)
    expect(len('wristL')).toBeCloseTo(0.226, 2)
    expect(len('kneeL')).toBeCloseTo(0.421, 2)
    expect(len('ankleL')).toBeCloseTo(0.382, 2)
    // 指节都在 1~5cm 之间；掌骨（近节的偏移）是 4~10cm
    for (const side of ['L', 'R'] as const) {
      for (const name of FINGER_NAMES) {
        const [proximal, middle, distal] = FINGER_JOINT_IDS[side][name]
        expect(len(proximal), proximal).toBeGreaterThan(0.03)
        expect(len(proximal), proximal).toBeLessThan(0.12)
        for (const id of [middle, distal]) {
          expect(len(id), id).toBeGreaterThan(0.008)
          expect(len(id), id).toBeLessThan(0.05)
        }
      }
    }
  })

  it('左右偏移严格镜像（x 取反、y/z 相同）', () => {
    for (const id of JOINT_IDS) {
      if (!id.endsWith('L')) continue
      const left = MANNEQUIN_REST_OFFSETS[id]
      const right = MANNEQUIN_REST_OFFSETS[`${id.slice(0, -1)}R`]
      expect(right[0], `${id} 的 x 没镜像`).toBeCloseTo(-left[0], 6)
      expect(right[1], `${id} 的 y`).toBeCloseTo(left[1], 6)
      expect(right[2], `${id} 的 z`).toBeCloseTo(left[2], 6)
    }
  })

  it('静止姿势的手臂是垂直的（A-pose 没烘掉的话这条会红）', () => {
    for (const id of ['elbowL', 'wristL', 'elbowR', 'wristR'] as const) {
      const [x, y, z] = MANNEQUIN_REST_OFFSETS[id]
      expect(Math.hypot(x, z), `${id} 的偏移不是纯 −Y`).toBeLessThan(1e-6)
      expect(y).toBeLessThan(0)
    }
  })
})

describe('★ 手腕的骨向指中指，不是指拇指', () => {
  /*
   * 手腕有五个子关节，关节表里第一个是拇指。`jointTipLocal` 默认取第一个子关节，
   * 所以手腕必须显式声明 boneChild。漏了它，IK 和参考图反推都会把手当成「指向拇指」——
   * 表现是拖手腕手柄时手往拇指那边歪，很难联想到是关节表顺序的问题。
   */
  it('wristL / wristR 声明了 boneChild 指向中指近节', () => {
    expect(JOINT_BY_ID.wristL.boneChild).toBe('middle1L')
    expect(JOINT_BY_ID.wristR.boneChild).toBe('middle1R')
  })

  it('手腕的骨向就是中指近节的方向（而不是拇指的）', () => {
    for (const side of ['L', 'R'] as const) {
      const tip = jointTipLocal(`wrist${side}`)!
      const middle = MANNEQUIN_REST_OFFSETS[`middle1${side}`]
      const thumb = MANNEQUIN_REST_OFFSETS[`thumb1${side}`]
      const norm = (v: number[]) => {
        const l = Math.hypot(v[0], v[1], v[2])
        return [v[0] / l, v[1] / l, v[2] / l]
      }
      const m = norm(middle)
      const t = norm(thumb)
      const dotMiddle = tip[0] * m[0] + tip[1] * m[1] + tip[2] * m[2]
      const dotThumb = tip[0] * t[0] + tip[1] * t[1] + tip[2] * t[2]
      expect(dotMiddle, `wrist${side} 的骨向不是中指方向`).toBeCloseTo(1, 6)
      expect(dotThumb).toBeLessThan(dotMiddle)
    }
  })
})

describe('存库那一层认得新关节', () => {
  it('normalizePose 不会把指骨丢掉', () => {
    const pose = normalizePose({ index2L: [0, 0, 55], thumb1R: [10, 5, 20], nope: [1, 2, 3] })
    expect(pose.index2L).toEqual([0, 0, 55])
    expect(pose.thumb1R).toEqual([10, 5, 20])
    expect((pose as Record<string, unknown>).nope).toBeUndefined()
  })

  it('越界的指骨角度被钳回范围（库里存着脏数据也不会摆出反关节）', () => {
    const pose = normalizePose({ index2L: [0, 0, 999], index3L: [0, 0, -999] })
    expect(pose.index2L![2]).toBe(JOINT_BY_ID.index2L.axes.tilt!.max)
    expect(pose.index3L![2]).toBe(JOINT_BY_ID.index3L.axes.tilt!.min)
  })

  it('30 个指骨全非零时，姿势序列化后也就多一两 KB', () => {
    const pose: Record<string, [number, number, number]> = {}
    for (const id of FINGER_IDS) pose[id] = [5, 5, 60]
    const bytes = new TextEncoder().encode(JSON.stringify(normalizePose(pose))).length
    expect(bytes).toBeLessThan(2048)
  })
})
