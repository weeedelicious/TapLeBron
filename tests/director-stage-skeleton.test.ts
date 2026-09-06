/**
 * 白模骨架的关节自由度（2026-08-26 用户要求：角色可以调整基本 pose）。
 *
 * 这里锁的是「姿势不能是解剖上不存在的姿势」。三条输入路径（滑杆 / 旋转手柄 / IK）
 * 都要过 clampJointAngles，只要它漏一个轴，肘关节就能被掰出侧倾 —— 白模看起来像断了，
 * 而且这种崩坏在截图上很难一眼看出是哪个关节的问题。
 *
 * 另外锁两条容易静默出错的约定：
 *   · DIRECTOR_JOINTS 必须「父在子之前」—— 正向运动学是一遍循环算的，顺序错了坐标全错；
 *   · 左右两边共用同一套角度数字，靠 mirror 在转 Euler 时取反。写反了右臂就往反方向抬。
 */
import { describe, expect, it } from 'vitest'

const {
  DIRECTOR_JOINTS,
  JOINT_BY_ID,
  JOINT_IDS,
  JOINT_EULER_ORDER,
  IK_CHAINS,
  applyEulerDelta,
  axisEulerSign,
  axisIsPeriodic,
  clampJointAngles,
  defaultPose,
  eulerForJoint,
  wrapAxisAngle,
  ikChainFor,
  isJointId,
  jointAxes,
  jointChainToRoot,
  poseAngles,
} = await import('@/features/director-stage/skeleton')

const HINGES = ['elbowL', 'elbowR', 'kneeL', 'kneeR'] as const
const MIRRORED = ['shoulderR', 'upperArmR', 'elbowR', 'wristR', 'thighR', 'kneeR', 'ankleR'] as const

describe('骨架结构', () => {
  it('父关节一定排在子关节之前（FK 是一遍循环，顺序错了坐标全错）', () => {
    const seen = new Set<string>()
    for (const joint of DIRECTOR_JOINTS) {
      if (joint.parent) {
        expect(seen.has(joint.parent), `${joint.id} 的父 ${joint.parent} 排在它后面`).toBe(true)
      }
      seen.add(joint.id)
    }
  })

  it('只有一个根，且每个关节都能走回根（没有环、没有孤儿）', () => {
    const roots = DIRECTOR_JOINTS.filter((joint) => joint.parent === null)
    expect(roots).toHaveLength(1)
    expect(roots[0].id).toBe('hips')
    for (const id of JOINT_IDS) {
      const chain = jointChainToRoot(id)
      expect(chain[chain.length - 1]).toBe('hips')
      expect(new Set(chain).size).toBe(chain.length)
    }
  })

  it('关节 id 不重复，JOINT_BY_ID 对得上', () => {
    expect(new Set(JOINT_IDS).size).toBe(JOINT_IDS.length)
    for (const id of JOINT_IDS) expect(JOINT_BY_ID[id].id).toBe(id)
  })

  it('每个关节至少有一个可调的轴（不然界面上点了没反应）', () => {
    for (const id of JOINT_IDS) expect(jointAxes(id).length).toBeGreaterThan(0)
  })

  it('左右成对，且右侧标了 mirror', () => {
    for (const id of JOINT_IDS) {
      if (!id.endsWith('L')) continue
      const right = `${id.slice(0, -1)}R`
      expect(isJointId(right), `${id} 没有对应的 ${right}`).toBe(true)
      expect(JOINT_BY_ID[right as typeof MIRRORED[number]].mirror).toBe(true)
      expect(JOINT_BY_ID[id as 'upperArmL'].mirror).toBeFalsy()
    }
  })

  it('左右对应关节的角度上下限完全一样（共用一套数字的前提）', () => {
    for (const id of JOINT_IDS) {
      if (!id.endsWith('L')) continue
      const left = jointAxes(id)
      const right = jointAxes(`${id.slice(0, -1)}R` as 'upperArmR')
      expect(right.map((entry) => [entry.axis, entry.def.min, entry.def.max]))
        .toEqual(left.map((entry) => [entry.axis, entry.def.min, entry.def.max]))
    }
  })

  it('Euler 顺序是固定的 —— 不固定的话同一串角度换个地方渲染就是另一个姿势', () => {
    expect(JOINT_EULER_ORDER).toBe('YXZ')
  })
})

describe('铰链关节只有一个自由度', () => {
  it.each(HINGES)('%s 只允许 bend', (id) => {
    const axes = jointAxes(id)
    expect(axes).toHaveLength(1)
    expect(axes[0].axis).toBe('bend')
  })

  it.each(HINGES)('%s 给三个轴也只留 bend，另外两个归零', (id) => {
    expect(clampJointAngles(id, [40, 30, 20])).toEqual([40, 0, 0])
  })

  /*
   * 肘和膝的「弯曲 90」都是正数，但转成 Euler 是**相反**的符号 —— 这不是笔误：
   * 两根骨头静止都朝下，绕 +X 正转都是往后甩；膝盖本来就往后弯（所以不取反），
   * 肘却是往前弯（所以取反）。方向对不对由 ik 那边的 FK 断言兜着，这里锁的是符号关系。
   */
  it('肘和膝的弯曲方向相反（同一个正数，Euler 符号相反）', () => {
    expect(axisEulerSign('elbowL', 0)).toBe(-1)
    expect(axisEulerSign('kneeL', 0)).toBe(1)
    expect(Math.sign(eulerForJoint('elbowL', [90, 0, 0])[0]))
      .toBe(-Math.sign(eulerForJoint('kneeL', [90, 0, 0])[0]))
  })

  it('上臂 / 大腿的「前后抬」也取反（骨头朝下，正数要表示往前）', () => {
    for (const id of ['upperArmL', 'upperArmR', 'thighL', 'thighR'] as const) {
      expect(axisEulerSign(id, 0), `${id} 的前后抬方向反了`).toBe(-1)
    }
    // 躯干那一路骨头朝上，绕 +X 正转就是前弯，不取反
    for (const id of ['hips', 'spine', 'chest', 'neck', 'head'] as const) {
      expect(axisEulerSign(id, 0), `${id} 不该取反`).toBe(1)
    }
  })

  it('膝盖不能反向弯（min 是 0）', () => {
    expect(clampJointAngles('kneeL', [-60, 0, 0])[0]).toBe(0)
  })
})

describe('角度钳制', () => {
  it('超上限钳到上限、超下限钳到下限', () => {
    const raise = JOINT_BY_ID.upperArmL.axes.bend!
    expect(clampJointAngles('upperArmL', [999, 0, 0])[0]).toBe(raise.max)
    expect(clampJointAngles('upperArmL', [-999, 0, 0])[0]).toBe(raise.min)
  })

  it('脏输入（undefined / null / 字符串 / NaN / 不是数组）一律当 0，不抛', () => {
    expect(clampJointAngles('wristL', undefined)).toEqual([0, 0, 0])
    expect(clampJointAngles('wristL', null)).toEqual([0, 0, 0])
    expect(clampJointAngles('wristL', 'abc')).toEqual([0, 0, 0])
    expect(clampJointAngles('wristL', [NaN, 'x', {}])).toEqual([0, 0, 0])
    expect(clampJointAngles('wristL', [10])).toEqual([10, 0, 0])
  })

  it('不认识的关节 id 返回全 0，不抛', () => {
    expect(clampJointAngles('nope' as 'wristL', [10, 10, 10])).toEqual([0, 0, 0])
    expect(eulerForJoint('nope' as 'wristL', [10, 10, 10])).toEqual([0, 0, 0])
  })

  it('每个关节的默认 0 都在上下限之内（否则静止姿势一打开就被钳变形）', () => {
    for (const id of JOINT_IDS) {
      expect(clampJointAngles(id, [0, 0, 0]), `${id} 的 0 位不在限内`).toEqual([0, 0, 0])
    }
  })

  it('胯的左右转是整圈周期轴，180 和 -180 是同一朝向，跨过去不夹死', () => {
    expect(axisIsPeriodic(JOINT_BY_ID.hips.axes.turn)).toBe(true)
    expect(axisIsPeriodic(JOINT_BY_ID.upperArmL.axes.turn)).toBe(false)
    expect(clampJointAngles('hips', [0, 181, 0])[1]).toBe(-179)
    expect(clampJointAngles('hips', [0, -181, 0])[1]).toBe(179)
    expect(wrapAxisAngle(181, -180, 180)).toBe(-179)
    expect(wrapAxisAngle(180, -180, 180)).toBe(180)
  })

  it('拖旋转过 180° 时按最短弧累加，不会从 179 跳回 -180', () => {
    const deg = Math.PI / 180
    const from = { x: 0, y: 179 * deg, z: 0 }
    const to = { x: 0, y: -179 * deg, z: 0 }
    expect(applyEulerDelta('hips', [0, 179, 0], from, to)[1]).toBe(-179)
    expect(applyEulerDelta('hips', [0, -179, 0], to, from)[1]).toBe(179)
  })
})

describe('左右镜像', () => {
  // 断言的是「mirror 只翻 turn / tilt，不翻 bend」这条关系本身，所以拿左右对比。
  // 不能直接写死 bend 的符号 —— 膝盖自己带 sign:-1（往后弯），那是另一回事。
  it.each(MIRRORED)('%s：turn / tilt 与左侧相反，bend 与左侧相同', (id) => {
    const left = `${id.slice(0, -1)}L` as 'upperArmL'
    expect(axisEulerSign(id, 0)).toBe(axisEulerSign(left, 0))
    expect(axisEulerSign(id, 1)).toBe(-axisEulerSign(left, 1))
    expect(axisEulerSign(id, 2)).toBe(-axisEulerSign(left, 2))
  })

  it('两侧「外张 90」转出来的 Euler 互为负数 —— 数字相同、方向对称', () => {
    const left = eulerForJoint('upperArmL', [0, 0, 90])
    const right = eulerForJoint('upperArmR', [0, 0, 90])
    expect(right[2]).toBeCloseTo(-left[2], 9)
  })

  it('两侧「前后抬 60」转出来的 Euler 相同 —— 前后是同向的', () => {
    expect(eulerForJoint('upperArmR', [60, 0, 0])[0]).toBeCloseTo(eulerForJoint('upperArmL', [60, 0, 0])[0], 9)
  })
})

describe('姿势读取', () => {
  it('静止姿势是空的：全 0 就是自然站立，不需要存 21 个 [0,0,0]', () => {
    expect(defaultPose()).toEqual({})
    for (const id of JOINT_IDS) expect(poseAngles(defaultPose(), id)).toEqual([0, 0, 0])
  })

  it('姿势里缺的关节按 0 处理', () => {
    expect(poseAngles({ elbowL: [30, 0, 0] }, 'elbowR')).toEqual([0, 0, 0])
    expect(poseAngles(undefined, 'elbowR')).toEqual([0, 0, 0])
  })

  it('读出来的角度也过钳制（库里存着越界值时不会渲染成怪姿势）', () => {
    expect(poseAngles({ elbowL: [999, 88, 77] }, 'elbowL')).toEqual([150, 0, 0])
  })
})

describe('IK 链', () => {
  it('四条链：两只手腕 + 两只脚踝', () => {
    expect(Object.keys(IK_CHAINS).sort()).toEqual(['ankleL', 'ankleR', 'wristL', 'wristR'])
  })

  it('链上的关节都是末端的祖先，且不含躯干（拖手不该扭腰）', () => {
    for (const [key, chain] of Object.entries(IK_CHAINS)) {
      const ancestors = jointChainToRoot(chain.effector)
      expect(chain.effector).toBe(key)
      for (const link of chain.links) {
        expect(ancestors, `${link} 不是 ${key} 的祖先`).toContain(link)
        expect(['hips', 'spine', 'chest', 'neck']).not.toContain(link)
      }
    }
  })

  it('链是从靠近末端往根排的（CCD 要求这个顺序）', () => {
    for (const chain of Object.values(IK_CHAINS)) {
      const depth = (id: string) => jointChainToRoot(id as 'wristL').length
      for (let i = 1; i < chain.links.length; i++) {
        expect(depth(chain.links[i])).toBeLessThan(depth(chain.links[i - 1]))
      }
    }
  })

  it('不能拖的关节拿不到链', () => {
    expect(ikChainFor('chest')).toBeUndefined()
    expect(ikChainFor('elbowL')).toBeUndefined()
  })
})
