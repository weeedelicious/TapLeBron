/**
 * 参考图 → 手指姿势的重定向（2026-08-26 用户要求：手指跟参考图一起推）。
 *
 * ── 为什么必须做往返测试 ────────────────────────────────────────────────────
 *
 * MediaPipe 的手部 `worldLandmarks` 在**手自己的局部坐标系**里，和身体那套世界坐标
 * 不是一个系。所以 handFromLandmarks 走「换基」：从观测点搭一组正交基、把每节骨头的
 * 方向表示成这组基下的系数、再拿同样的系数在我们静止手掌的同名基上重新组合。
 *
 * 这类代码的错法是「看起来动了、但方向系统性地偏一点」，靠眼睛几乎发现不了。
 * 所以这里反着来：拿一个**已知的**手指姿势 → 用 FK 算出 21 个关键点该在哪 →
 * 喂回去 → 断言解回原来的姿势。
 *
 * 关键设计：合成关键点时**额外乘一个任意旋转**。
 * 不乘的话观测基恰好等于静止基，换基退化成恒等变换 —— 那这条测试就测不到换基了，
 * 而换基正是最容易写错的一步。
 */
import { describe, expect, it } from 'vitest'

const { FINGER_JOINT_IDS, FINGER_NAMES, clampJointAngles } = await import('@/features/director-stage/skeleton')
const { forwardKinematics, jointBoneDirection, mat3Apply, mat3FromEulerYXZ, vecDot } =
  await import('@/features/director-stage/ik')
const { HL, handFromLandmarks } = await import('@/features/director-stage/handFromLandmarks')
// poseEstimator 只在函数体里动态 import MediaPipe，所以模块本身在 jsdom 里能直接加载
const { HAND_CROP_MARGIN, assignHandsByWrist, handCropRect } = await import('@/features/director-stage/poseEstimator')
const { LM } = await import('@/features/director-stage/poseFromLandmarks')

type Vec3 = [number, number, number]
type Pose = Record<string, [number, number, number]>
type Landmark = { x: number; y: number; z: number }

/** 每根手指的四个关键点下标：三个关节 + 指尖。 */
const HL_SLOTS: Record<string, [number, number, number, number]> = {
  thumb: [HL.thumbCmc, HL.thumbMcp, HL.thumbIp, HL.thumbTip],
  index: [HL.indexMcp, HL.indexPip, HL.indexDip, HL.indexTip],
  middle: [HL.middleMcp, HL.middlePip, HL.middleDip, HL.middleTip],
  ring: [HL.ringMcp, HL.ringPip, HL.ringDip, HL.ringTip],
  little: [HL.littleMcp, HL.littlePip, HL.littleDip, HL.littleTip],
}

const DEG = Math.PI / 180
/** 随便挑的一个三轴都不为零的旋转 —— 模拟 MediaPipe 那个和我们无关的手部坐标系。 */
const ARBITRARY = mat3FromEulerYXZ(23 * DEG, -41 * DEG, 17 * DEG)
const IDENTITY = mat3FromEulerYXZ(0, 0, 0)

/**
 * 按一个已知姿势合成 21 个手部关键点。
 *
 * `readPoint` 会做 `[x, -y, -z]` 的换轴，所以这里要**反过来**写进去，
 * 不然测试自己就把左右上下弄反了。
 */
function synthHand(pose: Pose, side: 'L' | 'R', rotation: number[] = ARBITRARY): Landmark[] {
  const world = forwardKinematics(pose as never)
  const out: Landmark[] = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }))
  const put = (index: number, point: Vec3) => {
    const r = mat3Apply(rotation, point)
    out[index] = { x: r[0], y: -r[1], z: -r[2] }
  }
  put(HL.wrist, world[`wrist${side}` as never].position)
  for (const name of FINGER_NAMES) {
    const ids = FINGER_JOINT_IDS[side][name]
    const slots = HL_SLOTS[name]
    ids.forEach((id, index) => put(slots[index], world[id].position))
    // 指尖：顺着远节的骨向再伸 2cm（只有方向有意义，长度随便）
    const distal = ids[2]
    const dir = jointBoneDirection(world, distal)
    const base = world[distal].position
    put(slots[3], [base[0] + dir[0] * 0.02, base[1] + dir[1] * 0.02, base[2] + dir[2] * 0.02])
  }
  return out
}

function angleBetweenDeg(a: Vec3, b: Vec3) {
  return Math.acos(Math.min(1, Math.max(-1, vecDot(a, b)))) / DEG
}

/** 一个有点扭的手：五根手指各不相同，拇指还带对掌旋转。 */
const KNOWN: Pose = {
  thumb1L: [22, 15, 30], thumb2L: [0, 0, 38], thumb3L: [0, 0, 44],
  index1L: [12, 0, 35], index2L: [0, 0, 62], index3L: [0, 0, 28],
  middle1L: [-4, 0, 48], middle2L: [0, 0, 80], middle3L: [0, 0, 35],
  ring1L: [8, 0, 26], ring2L: [0, 0, 40], ring3L: [0, 0, 18],
  little1L: [16, 0, 12], little2L: [0, 0, 25], little3L: [0, 0, -6],
}

const ALL_L = FINGER_NAMES.flatMap((name) => FINGER_JOINT_IDS.L[name])

describe('★ 往返：已知手势 → 关键点 → 解回来', () => {
  it('15 个指骨全部解出来了', () => {
    const result = handFromLandmarks({}, 'L', synthHand(KNOWN, 'L'))
    expect(result.applied.sort()).toEqual([...ALL_L].sort())
    expect(result.skipped).toEqual([])
  })

  it('★ 每一节的骨头方向都解回了原方向（换基写错这条必红）', () => {
    const solved = handFromLandmarks({}, 'L', synthHand(KNOWN, 'L')).pose
    const want = forwardKinematics(KNOWN as never)
    const got = forwardKinematics(solved as never)
    for (const id of ALL_L) {
      const gap = angleBetweenDeg(jointBoneDirection(got, id), jointBoneDirection(want, id))
      expect(gap, `${id} 的骨向差了 ${gap.toFixed(2)}°`).toBeLessThan(2)
    }
  })

  it('角度也解回来了（拇指近节除外 —— 三个轴瞄一个方向，解不唯一）', () => {
    const solved = handFromLandmarks({}, 'L', synthHand(KNOWN, 'L')).pose
    for (const id of ALL_L) {
      if (id === 'thumb1L') continue
      const want = KNOWN[id]
      const got = solved[id]!
      for (let axis = 0; axis < 3; axis += 1) {
        expect(Math.abs(got[axis] - want[axis]), `${id} 轴${axis}: ${got[axis]} vs ${want[axis]}`)
          .toBeLessThan(3)
      }
    }
  })

  it('不乘那个任意旋转也一样对（换基退化成恒等变换的情形）', () => {
    const solved = handFromLandmarks({}, 'L', synthHand(KNOWN, 'L', IDENTITY)).pose
    const want = forwardKinematics(KNOWN as never)
    const got = forwardKinematics(solved as never)
    for (const id of ALL_L) {
      expect(angleBetweenDeg(jointBoneDirection(got, id), jointBoneDirection(want, id)), id)
        .toBeLessThan(2)
    }
  })

  it('★ 手腕已经被身体那一步摆过时，手指仍然解对（目标方向用手腕当前朝向换算）', () => {
    // 手腕转过 + 手臂抬起：手的世界朝向和静止完全不同
    const base: Pose = { upperArmL: [40, 0, 25], elbowL: [55, 0, 0], wristL: [20, 35, -10] }
    const posed: Pose = { ...base, ...KNOWN }
    const solved = handFromLandmarks(base, 'L', synthHand(posed, 'L')).pose
    const want = forwardKinematics(posed as never)
    const got = forwardKinematics(solved as never)
    for (const id of ALL_L) {
      const gap = angleBetweenDeg(jointBoneDirection(got, id), jointBoneDirection(want, id))
      expect(gap, `${id} 的骨向差了 ${gap.toFixed(2)}°`).toBeLessThan(2)
    }
    // 身体那几个关节不许被手指这一步改掉
    for (const id of Object.keys(base)) expect(solved[id], id).toEqual(base[id])
  })

  it('右手同样解得对，而且不串到左手', () => {
    const known: Pose = {}
    for (const [id, angles] of Object.entries(KNOWN)) known[`${id.slice(0, -1)}R`] = angles
    const result = handFromLandmarks({}, 'R', synthHand(known, 'R'))
    const want = forwardKinematics(known as never)
    const got = forwardKinematics(result.pose as never)
    for (const name of FINGER_NAMES) {
      for (const id of FINGER_JOINT_IDS.R[name]) {
        expect(angleBetweenDeg(jointBoneDirection(got, id), jointBoneDirection(want, id)), id)
          .toBeLessThan(2)
      }
    }
    for (const id of ALL_L) expect(result.pose[id], `${id} 被右手那一步碰了`).toBeUndefined()
  })

  it('确定性：同样的输入两次结果完全一样', () => {
    const list = synthHand(KNOWN, 'L')
    expect(JSON.stringify(handFromLandmarks({}, 'L', list).pose))
      .toBe(JSON.stringify(handFromLandmarks({}, 'L', list).pose))
  })
})

/*
 * 裁剪框：全身照里手往往只有几十个像素，不裁直接检测基本检不出来。
 * 这一步错了的症状是「手指从来推不出来」，而那看起来和「模型不行」没法区分 ——
 * 所以宁可把框的算法钉死在测试里。
 */
describe('★ 手部裁剪框', () => {
  /** 一张 1000×2000 的全身照，左手腕在画面中下部。 */
  const bodyLandmarks = () => {
    const list = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0 }))
    list[LM.leftElbow] = { x: 0.60, y: 0.50, z: 0 }
    list[LM.leftWrist] = { x: 0.62, y: 0.60, z: 0 }
    list[LM.leftPinky] = { x: 0.635, y: 0.625, z: 0 }
    list[LM.leftIndex] = { x: 0.625, y: 0.628, z: 0 }
    list[LM.leftThumb] = { x: 0.618, y: 0.618, z: 0 }
    return list
  }

  it('框住手腕附近，且是正方形', () => {
    const rect = handCropRect(bodyLandmarks(), 'L', 1000, 2000)!
    expect(rect).toBeTruthy()
    // 手腕在 (620, 1200) 附近，框应该盖住它
    expect(rect.x).toBeLessThan(620)
    expect(rect.x + rect.size).toBeGreaterThan(620)
    expect(rect.y).toBeLessThan(1200)
    expect(rect.y + rect.size).toBeGreaterThan(1200)
  })

  it('★ 框比手部关键点的外接框大（余量放小了手指会被切掉）', () => {
    expect(HAND_CROP_MARGIN).toBeGreaterThan(1.2)
    const rect = handCropRect(bodyLandmarks(), 'L', 1000, 2000)!
    // 那四个点自己的外接框只有约 30×56 像素，框必须明显更大
    expect(rect.size).toBeGreaterThan(80)
  })

  it('★ 手指攥成一团时靠前臂长兜住（不然框会小到看不见手）', () => {
    const list = bodyLandmarks()
    // 四个点全挤到手腕上
    for (const index of [LM.leftPinky, LM.leftIndex, LM.leftThumb]) list[index] = { ...list[LM.leftWrist] }
    const rect = handCropRect(list, 'L', 1000, 2000)!
    const forearm = Math.hypot((0.62 - 0.60) * 1000, (0.60 - 0.50) * 2000)
    expect(rect.size).toBeGreaterThan(forearm * 0.8)
  })

  it('框不越出画面边界', () => {
    const list = bodyLandmarks()
    // 手贴在画面右下角
    for (const index of [LM.leftWrist, LM.leftPinky, LM.leftIndex, LM.leftThumb]) {
      list[index] = { x: 0.999, y: 0.999, z: 0 }
    }
    const rect = handCropRect(list, 'L', 1000, 2000)!
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.size).toBeLessThanOrEqual(1000)
    expect(rect.y + rect.size).toBeLessThanOrEqual(2000)
  })

  it('左右手取的是各自那一侧的点', () => {
    const list = bodyLandmarks()
    list[LM.rightWrist] = { x: 0.2, y: 0.6, z: 0 }
    list[LM.rightElbow] = { x: 0.18, y: 0.5, z: 0 }
    const left = handCropRect(list, 'L', 1000, 2000)!
    const right = handCropRect(list, 'R', 1000, 2000)!
    expect(left.x).toBeGreaterThan(right.x + 200)
  })

  it('没有手腕点 / 尺寸非法 → 返回 null（不裁一个空框去浪费一次检测）', () => {
    expect(handCropRect(undefined, 'L', 1000, 2000)).toBeNull()
    expect(handCropRect([], 'L', 1000, 2000)).toBeNull()
    expect(handCropRect(bodyLandmarks(), 'L', 0, 2000)).toBeNull()
    const nan = bodyLandmarks()
    nan[LM.leftWrist] = { x: Number.NaN, y: 0.6, z: 0 }
    expect(handCropRect(nan, 'L', 1000, 2000)).toBeNull()
  })
})

describe('整图双手按手腕配对', () => {
  const handAt = (x: number, y: number) => {
    const world = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }))
    const image = new Array(21).fill(null).map(() => ({ x, y, z: 0 }))
    return { world, image }
  }

  it('两只手按离左右手腕谁更近配对，对调输入也配得对', () => {
    const list = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0 }))
    list[LM.leftWrist] = { x: 0.7, y: 0.6, z: 0 }
    list[LM.rightWrist] = { x: 0.2, y: 0.6, z: 0 }
    const left = handAt(0.72, 0.61)
    const right = handAt(0.18, 0.59)
    const assigned = assignHandsByWrist(list, [right, left])
    expect(assigned.L).toBe(left.world)
    expect(assigned.R).toBe(right.world)
  })

  it('只检到一只手时，分给更近的那一侧', () => {
    const list = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0 }))
    list[LM.leftWrist] = { x: 0.7, y: 0.6, z: 0 }
    list[LM.rightWrist] = { x: 0.2, y: 0.6, z: 0 }
    const only = handAt(0.19, 0.6)
    const assigned = assignHandsByWrist(list, [only])
    expect(assigned.L).toBeNull()
    expect(assigned.R).toBe(only.world)
  })
})

describe('退化输入不抛，且不乱摆', () => {
  it('没有关键点 / 不是数组 / 点数不够 → 整只手留原位', () => {
    for (const bad of [undefined, null, [], 'nope', synthHand(KNOWN, 'L').slice(0, 12)]) {
      const result = handFromLandmarks({ elbowL: [30, 0, 0] }, 'L', bad as never)
      expect(result.applied).toEqual([])
      expect(result.skipped.sort()).toEqual([...ALL_L].sort())
      expect(result.pose.elbowL).toEqual([30, 0, 0])
    }
  })

  it('手掌被压成一条线（掌基退化）→ 整只手留原位，不是解出个乱姿势', () => {
    const list = synthHand(KNOWN, 'L')
    // 让食指根、小指根、中指根、手腕全落在一条线上
    for (const index of [HL.wrist, HL.indexMcp, HL.middleMcp, HL.littleMcp]) {
      list[index] = { x: 0, y: -index * 0.01, z: 0 }
    }
    const result = handFromLandmarks({}, 'L', list)
    expect(result.applied).toEqual([])
    expect(result.pose).toEqual({})
  })

  it('★ 个别点是 NaN → 只跳过受影响的那几节，别的照样解', () => {
    const list = synthHand(KNOWN, 'L')
    list[HL.ringPip] = { x: Number.NaN, y: 0, z: 0 }
    const result = handFromLandmarks({}, 'L', list)
    // ring 的近节（13→14）和中节（14→15）都用到了 14，远节不受影响
    expect(result.skipped).toContain('ring1L')
    expect(result.skipped).toContain('ring2L')
    expect(result.applied).toContain('ring3L')
    expect(result.applied).toContain('index1L')
    expect(result.applied.length + result.skipped.length).toBe(15)
  })

  it('两个点完全重合 → 那一节跳过', () => {
    const list = synthHand(KNOWN, 'L')
    list[HL.littleDip] = { ...list[HL.littlePip] }
    const result = handFromLandmarks({}, 'L', list)
    expect(result.skipped).toContain('little2L')
  })

  it('全 0 的关键点不抛', () => {
    const zeros = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }))
    expect(() => handFromLandmarks({}, 'L', zeros)).not.toThrow()
    expect(handFromLandmarks({}, 'L', zeros).applied).toEqual([])
  })

  it('解出来的角度一定在钳制范围内（拿一个夸张的手势喂进去）', () => {
    const extreme: Pose = {}
    for (const name of FINGER_NAMES) {
      const [proximal, middle, distal] = FINGER_JOINT_IDS.L[name]
      extreme[proximal] = [0, 0, 90]
      extreme[middle] = [0, 0, 110]
      extreme[distal] = [0, 0, 80]
    }
    const solved = handFromLandmarks({}, 'L', synthHand(extreme, 'L')).pose
    for (const id of ALL_L) {
      expect(clampJointAngles(id, solved[id]), `${id} 越界了`).toEqual(solved[id])
    }
  })
})
