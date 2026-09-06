/**
 * 参考图 → 白模姿势（2026-08-26 你要的「分析直接变成角色的 pose」）。
 *
 * 这个文件是整个功能里最需要测的地方：坐标系映射错一个符号，姿势就左右颠倒或者前后翻，
 * 而且**在界面上看起来只是「解得不太准」，不像 bug**，很容易蒙过去。
 *
 * 两套互补的断言，缺一不可：
 *
 *   ① **往返测试**（已知姿势 → 正向运动学 → 摆成 MediaPipe 的 33 点 → 解回来）
 *      验证解算器本身收敛、约束生效。但它同时用了映射和映射的逆，
 *      所以**符号错了它也能自圆其说** —— 靠它一个人不够。
 *
 *   ② **第一性原理手搭的关键点**（「正面站着的人把左手平举向自己的左边」，
 *      按 MediaPipe 的约定亲手写出坐标），验证坐标系映射和语义轴方向。
 *      这一套才是钉死 `[x, -y, -z]` 那三个符号的东西。
 *
 * 往返比的是骨头**朝向**而不是角度数值 —— 一个方向定不了骨头绕自身轴的扭转，
 * 同一个朝向有多组 (bend, turn, tilt) 解。朝向才是「白模看起来像不像照片」这件事本身。
 */
import { describe, expect, it } from 'vitest'

const {
  LM,
  LANDMARK_COUNT,
  MIN_VISIBILITY,
  poseFromLandmarks,
  readPoint,
  wrapDeg,
  yawFromLineDeg,
} = await import('@/features/director-stage/poseFromLandmarks')
const { forwardKinematics, jointBoneDirection, vecDot, vecLength, vecNormalize, vecSub } =
  await import('@/features/director-stage/ik')
const { clampJointAngles, jointAxes } = await import('@/features/director-stage/skeleton')

type Vec3 = [number, number, number]
type Landmark = { x: number; y: number; z: number; visibility?: number }

/** 我们的坐标 → MediaPipe 的约定（映射的逆）。往返测试用。 */
const toMediaPipe = (v: Vec3): Landmark => ({ x: v[0], y: -v[1], z: -v[2], visibility: 1 })

const blankLandmarks = () =>
  Array.from({ length: LANDMARK_COUNT }, (): Landmark => ({ x: 0, y: 0, z: 0, visibility: 0 }))

/** 两个方向之间的夹角（度）。 */
function angleBetweenDeg(a: Vec3, b: Vec3) {
  const na = vecNormalize(a)
  const nb = vecNormalize(b)
  if (vecLength(na) < 1e-6 || vecLength(nb) < 1e-6) return 0
  return (Math.acos(Math.min(1, Math.max(-1, vecDot(na, nb)))) * 180) / Math.PI
}

/*
 * ────────────────────────────────────────────────────────────────────────────
 * ① 第一性原理：正面站着的人，按 MediaPipe 的约定手写坐标
 *
 * MediaPipe 世界坐标：原点在两髋中点，**x 向图像右、y 向下、z 朝相机为负**。
 * 正面拍一个人 → 他的左半身在图像右侧 → 角色的左 = +x。「上方」= 负 y。「身前」= 负 z。
 * ────────────────────────────────────────────────────────────────────────────
 */
function standingLandmarks(): Landmark[] {
  const lm = blankLandmarks()
  const put = (index: number, x: number, y: number, z: number) => {
    lm[index] = { x, y, z, visibility: 1 }
  }
  // 髋（原点附近）、膝、踝、脚尖（脚尖朝身前 = -z）
  put(LM.leftHip, 0.1, 0, 0); put(LM.rightHip, -0.1, 0, 0)
  put(LM.leftKnee, 0.1, 0.45, 0); put(LM.rightKnee, -0.1, 0.45, 0)
  put(LM.leftAnkle, 0.1, 0.9, 0); put(LM.rightAnkle, -0.1, 0.9, 0)
  put(LM.leftFootIndex, 0.1, 0.95, -0.15); put(LM.rightFootIndex, -0.1, 0.95, -0.15)
  // 肩在髋上方 → 负 y
  put(LM.leftShoulder, 0.18, -0.5, 0); put(LM.rightShoulder, -0.18, -0.5, 0)
  // 手臂自然垂下
  put(LM.leftElbow, 0.2, -0.25, 0); put(LM.rightElbow, -0.2, -0.25, 0)
  put(LM.leftWrist, 0.21, 0, 0); put(LM.rightWrist, -0.21, 0, 0)
  put(LM.leftIndex, 0.21, 0.1, 0); put(LM.rightIndex, -0.21, 0.1, 0)
  // 头：耳朵在头两侧、眼睛在嘴上方且前后位置接近（真实头部就是这个比例 ——
  // 嘴比耳朵明显靠前，所以头的「朝上」要用眼-嘴而不是耳-嘴，见 poseFromLandmarks 的说明）
  put(LM.leftEar, 0.08, -0.62, 0); put(LM.rightEar, -0.08, -0.62, 0)
  put(LM.leftEye, 0.035, -0.64, -0.1); put(LM.rightEye, -0.035, -0.64, -0.1)
  put(LM.mouthLeft, 0.03, -0.56, -0.09); put(LM.mouthRight, -0.03, -0.56, -0.09)
  put(LM.nose, 0, -0.6, -0.12)
  return lm
}

/** 改几个点，返回新数组（不改原数组）。 */
function withPoints(base: Landmark[], edits: Record<number, [number, number, number]>) {
  const next = base.map((point) => ({ ...point }))
  for (const [index, [x, y, z]] of Object.entries(edits)) {
    next[Number(index)] = { x, y, z, visibility: 1 }
  }
  return next
}

describe('坐标系映射：左右 / 上下 / 前后都不许错', () => {
  it('MediaPipe 的 x 向右、y 向下、z 朝相机 → 我们的 x 向角色左、y 向上、z 向前', () => {
    expect(readPoint([{ x: 2, y: 3, z: 4 }], 0)).toEqual([2, -3, -4])
  })

  it('★ 左手平举向角色自己的左边 → 左上臂「外张」大幅为正，且右臂没动', () => {
    // 角色的左 = +x；手臂水平 = 和肩同高
    const { pose } = poseFromLandmarks(withPoints(standingLandmarks(), {
      [LM.leftElbow]: [0.45, -0.5, 0],
      [LM.leftWrist]: [0.7, -0.5, 0],
      [LM.leftIndex]: [0.78, -0.5, 0],
    }))
    const left = clampJointAngles('upperArmL', pose.upperArmL)
    const right = clampJointAngles('upperArmR', pose.upperArmR)
    expect(left[2], `外张应该接近 +90，实际 ${left[2]}`).toBeGreaterThan(70)
    // 左右不许串：动左手不该把右臂也抬起来
    expect(Math.abs(right[2]), `右上臂被带动了：${right[2]}`).toBeLessThan(10)
  })

  it('★ 右手平举向角色自己的右边 → 右上臂「外张」也是正数（左右共用同一套数字）', () => {
    const { pose } = poseFromLandmarks(withPoints(standingLandmarks(), {
      [LM.rightElbow]: [-0.45, -0.5, 0],
      [LM.rightWrist]: [-0.7, -0.5, 0],
      [LM.rightIndex]: [-0.78, -0.5, 0],
    }))
    const right = clampJointAngles('upperArmR', pose.upperArmR)
    const left = clampJointAngles('upperArmL', pose.upperArmL)
    expect(right[2]).toBeGreaterThan(70)
    expect(Math.abs(left[2])).toBeLessThan(10)
  })

  it('★ 左手向身前平举 → 左上臂「前后抬」为正（不是负、也不是记在外张上）', () => {
    // 身前 = -z
    const { pose } = poseFromLandmarks(withPoints(standingLandmarks(), {
      [LM.leftElbow]: [0.18, -0.5, -0.25],
      [LM.leftWrist]: [0.18, -0.5, -0.5],
      [LM.leftIndex]: [0.18, -0.5, -0.58],
    }))
    const left = clampJointAngles('upperArmL', pose.upperArmL)
    expect(left[0], `前后抬应该接近 +90，实际 ${left[0]}`).toBeGreaterThan(70)
  })

  it('★ 手臂垂下（自然站立）→ 上臂三个轴都接近 0', () => {
    const { pose } = poseFromLandmarks(standingLandmarks())
    for (const joint of ['upperArmL', 'upperArmR'] as const) {
      const angles = clampJointAngles(joint, pose[joint])
      for (const [index, value] of angles.entries()) {
        expect(Math.abs(value), `${joint} 轴${index} = ${value}`).toBeLessThan(12)
      }
    }
  })
})

describe('铰链关节：肘和膝永远不会被掰成反关节', () => {
  it('★ 前臂朝身前 → 肘「弯曲」为正，而且 turn / tilt 恰好是 0', () => {
    const { pose } = poseFromLandmarks(withPoints(standingLandmarks(), {
      [LM.leftWrist]: [0.2, -0.25, -0.25],
      [LM.leftIndex]: [0.2, -0.25, -0.33],
    }))
    const elbow = clampJointAngles('elbowL', pose.elbowL)
    expect(elbow[0]).toBeGreaterThan(45)
    // 肘只有 bend 一个轴，另外两轴必须严格为 0 —— 这是 clampJointAngles 在起作用
    expect(elbow[1]).toBe(0)
    expect(elbow[2]).toBe(0)
  })

  it('★ 小腿朝身后 → 膝「弯曲」为正（膝盖本来就往后弯，所以它不带 sign 取反）', () => {
    const { pose } = poseFromLandmarks(withPoints(standingLandmarks(), {
      [LM.leftAnkle]: [0.1, 0.7, 0.25],
      [LM.leftFootIndex]: [0.1, 0.75, 0.1],
    }))
    const knee = clampJointAngles('kneeL', pose.kneeL)
    expect(knee[0], `膝弯曲应该为正，实际 ${knee[0]}`).toBeGreaterThan(20)
    expect(knee[1]).toBe(0)
    expect(knee[2]).toBe(0)
  })

  it('小腿被摆到身前（解剖上不可能）→ 膝盖停在 0，不会解出负角度', () => {
    const { pose } = poseFromLandmarks(withPoints(standingLandmarks(), {
      [LM.leftAnkle]: [0.1, 0.7, -0.3],
      [LM.leftFootIndex]: [0.1, 0.75, -0.45],
    }))
    expect(clampJointAngles('kneeL', pose.kneeL)[0]).toBeGreaterThanOrEqual(0)
  })

  it('解出来的每个关节都只在自己允许的轴上有值', () => {
    const { pose } = poseFromLandmarks(withPoints(standingLandmarks(), {
      [LM.leftElbow]: [0.45, -0.6, -0.1],
      [LM.leftWrist]: [0.6, -0.3, -0.3],
      [LM.leftIndex]: [0.65, -0.2, -0.35],
      [LM.rightKnee]: [-0.15, 0.4, -0.2],
      [LM.rightAnkle]: [-0.2, 0.75, 0.1],
    }))
    for (const [jointId, angles] of Object.entries(pose)) {
      const allowed = new Set(jointAxes(jointId as never).map((entry) => entry.index))
      angles.forEach((value: number, index: number) => {
        if (!allowed.has(index)) {
          expect(value, `${jointId} 在不该动的轴${index}上有值 ${value}`).toBe(0)
        }
      })
    }
  })
})

describe('整体转身与头部朝向', () => {
  it('★ 人转身 90°（侧对镜头）→ hips 的「左右转」约 ±90', () => {
    // 面朝角色自己的左边：髋线从 +x 转到指向镜头方向
    const turned = withPoints(standingLandmarks(), {
      [LM.leftHip]: [0, 0, -0.1],
      [LM.rightHip]: [0, 0, 0.1],
    })
    const { pose } = poseFromLandmarks(turned)
    expect(Math.abs(clampJointAngles('hips', pose.hips)[1])).toBeGreaterThan(70)
  })

  it('正面站着 → hips 不转', () => {
    const { pose } = poseFromLandmarks(standingLandmarks())
    expect(Math.abs(clampJointAngles('hips', pose.hips)[1])).toBeLessThan(5)
  })

  it('yawFromLineDeg：+X 是 0、-Z 是 +90（绕 +Y 的右手定则）', () => {
    expect(yawFromLineDeg([1, 0, 0])).toBeCloseTo(0, 6)
    expect(yawFromLineDeg([0, 0, -1])).toBeCloseTo(90, 6)
    expect(yawFromLineDeg([0, 0, 1])).toBeCloseTo(-90, 6)
    // 正后方是 ±180 —— 同一个方向，atan2 给哪个取决于零的符号，别过度断言
    expect(Math.abs(yawFromLineDeg([-1, 0, 0]) as number)).toBeCloseTo(180, 6)
    // 纯竖直的线定不出偏航
    expect(yawFromLineDeg([0, 1, 0])).toBeNull()
    expect(yawFromLineDeg(null)).toBeNull()
  })

  it('wrapDeg 归一化到 (-180, 180]，转身 190° 变 -170° 而不是被钳成 180°', () => {
    expect(wrapDeg(190)).toBeCloseTo(-170, 6)
    expect(wrapDeg(-190)).toBeCloseTo(170, 6)
    expect(wrapDeg(180)).toBeCloseTo(180, 6)
    expect(wrapDeg(45)).toBeCloseTo(45, 6)
  })

  it('头转向一边 → head 的「左右转」跟着动（耳线相对肩线）', () => {
    const { pose } = poseFromLandmarks(withPoints(standingLandmarks(), {
      [LM.leftEar]: [0.02, -0.62, -0.08],
      [LM.rightEar]: [-0.06, -0.62, 0.06],
    }))
    expect(Math.abs(clampJointAngles('head', pose.head)[1])).toBeGreaterThan(15)
  })
})

/*
 * ────────────────────────────────────────────────────────────────────────────
 * ② 往返：已知姿势 → 正向运动学 → MediaPipe 33 点 → 解回来 → 比骨头朝向
 * ────────────────────────────────────────────────────────────────────────────
 */

/** 把一个姿势渲染成 MediaPipe 会给出的 33 点。 */
function landmarksFromPose(pose: Record<string, [number, number, number]>) {
  const world = forwardKinematics(pose as never)
  const lm = blankLandmarks()
  const at = (jointId: string): Vec3 => world[jointId as never].position as Vec3
  /** 没有子关节的那几节（手 / 脚）用它自己的朝向外推一个尖端点。 */
  const tip = (jointId: string, length: number): Vec3 => {
    const origin = at(jointId)
    const dir = jointBoneDirection(world, jointId as never) as Vec3
    return [origin[0] + dir[0] * length, origin[1] + dir[1] * length, origin[2] + dir[2] * length]
  }
  const put = (index: number, v: Vec3) => { lm[index] = toMediaPipe(v) }

  put(LM.leftShoulder, at('upperArmL')); put(LM.rightShoulder, at('upperArmR'))
  put(LM.leftElbow, at('elbowL')); put(LM.rightElbow, at('elbowR'))
  put(LM.leftWrist, at('wristL')); put(LM.rightWrist, at('wristR'))
  put(LM.leftIndex, tip('wristL', 0.1)); put(LM.rightIndex, tip('wristR', 0.1))
  put(LM.leftHip, at('thighL')); put(LM.rightHip, at('thighR'))
  put(LM.leftKnee, at('kneeL')); put(LM.rightKnee, at('kneeR'))
  put(LM.leftAnkle, at('ankleL')); put(LM.rightAnkle, at('ankleR'))
  put(LM.leftFootIndex, tip('ankleL', 0.15)); put(LM.rightFootIndex, tip('ankleR', 0.15))
  return lm
}

/** 这些关节的朝向应该被还原出来。躯干那几节不在内 —— 见下面单独的说明。 */
const ROUND_TRIP_JOINTS = [
  'upperArmL', 'elbowL', 'wristL',
  'upperArmR', 'elbowR', 'wristR',
  'thighL', 'kneeL', 'ankleL',
  'thighR', 'kneeR', 'ankleR',
] as const

describe('往返：解出来的骨头朝向要对得上原姿势', () => {
  /*
   * 比朝向而不是比角度数值：一个方向定不了骨头绕自身轴的扭转，同一个朝向可以有
   * 多组 (bend, turn, tilt)。朝向才是「白模看起来像不像照片」这件事本身 ——
   * 这也正是我跟你说过的那个固有限制：**胳膊绕自身轴的旋转推不准**。
   */
  const CASES: Array<[string, Record<string, [number, number, number]>]> = [
    ['单手前举', { upperArmL: [80, 0, 0] }],
    ['单手侧举', { upperArmL: [0, 0, 95] }],
    ['双手上举 + 屈肘', { upperArmL: [0, 0, 150], upperArmR: [0, 0, 150], elbowL: [60, 0, 0], elbowR: [60, 0, 0] }],
    ['抬腿屈膝', { thighL: [70, 0, 0], kneeL: [80, 0, 0] }],
    ['叉腿 + 单手斜举', { thighL: [0, 0, 40], thighR: [0, 0, 40], upperArmR: [45, 0, 60] }],
    ['勾脚绷脚', { ankleL: [40, 0, 0], ankleR: [-30, 0, 0] }],
    ['手脚全动', {
      upperArmL: [100, 0, 30], elbowL: [90, 0, 0], wristL: [40, 0, 0],
      upperArmR: [-30, 0, 20], elbowR: [30, 0, 0],
      thighL: [60, 0, 10], kneeL: [110, 0, 0], ankleL: [20, 0, 0],
    }],
  ]

  it.each(CASES)('%s', (_label, original) => {
    const landmarks = landmarksFromPose(original)
    const { pose: recovered } = poseFromLandmarks(landmarks)

    const before = forwardKinematics(original as never)
    const after = forwardKinematics(recovered as never)

    for (const jointId of ROUND_TRIP_JOINTS) {
      const expectedDir = jointBoneDirection(before, jointId) as Vec3
      const actualDir = jointBoneDirection(after, jointId) as Vec3
      const gap = angleBetweenDeg(expectedDir, actualDir)
      /*
       * 4° 是实测最大值（2.8°）留了点余量后的门槛，不是随手写的宽容值：
       * 这条断言历史上抓到过 80.7°（三个轴同时改导致的数值发散）、
       * 14.8°（肘的弯曲平面没枚举出来）—— 都远在门槛之外。
       * 剩下的 2.8° 是「宁可自然一点」那个正则项刻意付出的代价。
       */
      expect(gap, `${jointId} 朝向差了 ${gap.toFixed(1)}°`).toBeLessThan(4)
    }
  })

  it('末端位置也跟得上（朝向对了、逐节累积也不该跑偏）', () => {
    const original = { upperArmL: [100, 0, 40] as [number, number, number], elbowL: [80, 0, 0] as [number, number, number] }
    const { pose: recovered } = poseFromLandmarks(landmarksFromPose(original))
    const before = forwardKinematics(original as never)
    const after = forwardKinematics(recovered as never)
    const drift = vecLength(vecSub(after.wristL.position, before.wristL.position))
    expect(drift, `左手腕跑偏了 ${drift.toFixed(3)}（白模身高约 1.7）`).toBeLessThan(0.09)
  })

  it('自然站立解回来还是自然站立（不会凭空长出一个姿势）', () => {
    const { pose } = poseFromLandmarks(landmarksFromPose({}))
    for (const jointId of ROUND_TRIP_JOINTS) {
      for (const value of clampJointAngles(jointId, pose[jointId])) {
        expect(Math.abs(value), `${jointId} 凭空转了 ${value}`).toBeLessThan(8)
      }
    }
  })
})

describe('★ 解出来的角度必须在关节声明的范围内', () => {
  /*
   * 这一条守的是「反关节」这个最难看的崩坏方式：MediaPipe 给的是自由三轴，
   * 只要有一处漏了 `clampJointAngles`，就会解出解剖上不存在的角度。
   */
  const CASES = [
    ['自然站立', standingLandmarks()],
    ['夸张动作', withPoints(standingLandmarks(), {
      [LM.leftElbow]: [0.6, -1.1, -0.4],
      [LM.leftWrist]: [0.9, -1.5, -0.8],
      [LM.leftIndex]: [1.0, -1.6, -0.9],
      [LM.rightKnee]: [-0.4, 0.2, -0.6],
      [LM.rightAnkle]: [-0.6, -0.3, 0.4],
      [LM.leftEar]: [0.3, -0.62, -0.3],
      [LM.rightEar]: [-0.3, -0.62, 0.3],
    })],
    ['坐标数量级很大', withPoints(standingLandmarks(), {
      [LM.leftElbow]: [50, -200, 80],
      [LM.leftWrist]: [90, -400, 150],
    })],
    /*
     * 耳线相对肩线转过 120°（人转不了这么多，但检测器给出这种结果是完全可能的）。
     * 头部「左右转」范围只有 ±60，所以这一条专门守那处钳制。
     */
    ['头被检测成扭了 120°', withPoints(standingLandmarks(), {
      [LM.leftEar]: [-0.04, -0.62, -0.07],
      [LM.rightEar]: [0.04, -0.62, 0.07],
    })],
  ] as const

  it.each(CASES)('%s', (_label, landmarks) => {
    const { pose } = poseFromLandmarks(landmarks as never)
    for (const [jointId, angles] of Object.entries(pose)) {
      for (const { axis, index, def } of jointAxes(jointId as never)) {
        const value = (angles as number[])[index]
        expect(value, `${jointId}.${axis} = ${value}，超出 [${def.min}, ${def.max}]`)
          .toBeGreaterThanOrEqual(def.min)
        expect(value, `${jointId}.${axis} = ${value}，超出 [${def.min}, ${def.max}]`)
          .toBeLessThanOrEqual(def.max)
      }
    }
  })
})

describe('★ 对浮点噪声必须稳定', () => {
  /*
   * 这是我真踩到的 bug，不是假想：第一版 aimJoint 三个轴从同一个快照一起改，
   * 输入方向差最后一两位（0.49999999999999994 vs 0.4999999999999998），
   * 结果一个收敛到 2.5° 内、另一个飞到三轴顶死、差 80°。
   *
   * 关键点是浮点算出来的，上游模型版本、浏览器、CPU 都可能让末位不同 ——
   * 一个会被末位左右的解算器等于每次分析都在抽奖。
   */
  const jitter = (landmarks: Landmark[], scale: number) =>
    landmarks.map((point, index) => ({
      ...point,
      // 用下标做确定性扰动，别引入随机（测试必须可复现）
      x: point.x * (1 + scale * ((index % 3) - 1)),
      y: point.y * (1 + scale * (((index + 1) % 3) - 1)),
      z: point.z * (1 + scale * (((index + 2) % 3) - 1)),
    }))

  const POSES = [
    ['自然站立', standingLandmarks()],
    ['单手侧举', withPoints(standingLandmarks(), {
      [LM.leftElbow]: [0.45, -0.5, 0], [LM.leftWrist]: [0.7, -0.5, 0], [LM.leftIndex]: [0.78, -0.5, 0],
    })],
    ['屈肘抬腿', withPoints(standingLandmarks(), {
      [LM.leftWrist]: [0.2, -0.25, -0.25], [LM.leftIndex]: [0.2, -0.25, -0.33],
      [LM.leftKnee]: [0.1, 0.3, -0.3], [LM.leftAnkle]: [0.1, 0.65, -0.1],
    })],
  ] as const

  it.each(POSES)('%s：末位级扰动不该改变结果', (_label, landmarks) => {
    const base = poseFromLandmarks(landmarks as never).pose
    const shaken = poseFromLandmarks(jitter(landmarks as never, 1e-15)).pose
    expect(Object.keys(shaken).sort()).toEqual(Object.keys(base).sort())
    for (const jointId of Object.keys(base)) {
      const a = clampJointAngles(jointId as never, base[jointId as never])
      const b = clampJointAngles(jointId as never, shaken[jointId as never])
      for (const [index, value] of a.entries()) {
        expect(Math.abs(value - b[index]), `${jointId} 轴${index}：${value} → ${b[index]}`).toBeLessThan(0.5)
      }
    }
  })

  /*
   * 千分之一的扰动这一档断言的是**骨头朝向**而不是角度数值 —— 刻意的。
   *
   * (bend, turn, tilt) 对「一个方向」是过参数化的，而且某些姿势下会退化：
   * 手臂水平侧举时 bend 轴几乎和骨头平行，于是 bend 能取一个很大的值而朝向几乎不变
   * （实测 0 → 15.6°）。这不是不稳定，是那个自由度在该姿势下没有意义。
   * 白模看起来像不像，取决于朝向。
   */
  it.each(POSES)('%s：千分之一的扰动只会让朝向也变千分之一级', (_label, landmarks) => {
    const base = forwardKinematics(poseFromLandmarks(landmarks as never).pose)
    const shaken = forwardKinematics(poseFromLandmarks(jitter(landmarks as never, 1e-3)).pose)
    for (const jointId of ['upperArmL', 'elbowL', 'upperArmR', 'elbowR', 'thighL', 'kneeL', 'spine', 'neck', 'head'] as const) {
      const gap = angleBetweenDeg(
        jointBoneDirection(base, jointId) as Vec3,
        jointBoneDirection(shaken, jointId) as Vec3,
      )
      expect(gap, `${jointId} 朝向变了 ${gap.toFixed(2)}°`).toBeLessThan(3)
    }
  })

  it('同样的输入调两次结果完全一致（不许有随机成分）', () => {
    const once = poseFromLandmarks(standingLandmarks())
    const twice = poseFromLandmarks(standingLandmarks())
    expect(twice.pose).toEqual(once.pose)
    expect(twice.applied).toEqual(once.applied)
  })
})

describe('★ 自然站立解出来就该是自然站立', () => {
  /*
   * 守的是「朝向对了但角度数字荒谬」这一类问题：垂着的手臂朝向和「旋转」轴无关，
   * 解算器可以在那个轴上填任意值而朝向不变 —— 实测填出过 -43° 和 -75°。
   * 用户一点开滑杆就看到一串莫名其妙的数字，而且和「重置姿势」的手感完全对不上。
   */
  it('所有被摆到的关节都接近 0', () => {
    const { pose } = poseFromLandmarks(standingLandmarks())
    for (const [jointId, angles] of Object.entries(pose)) {
      for (const [index, value] of (angles as number[]).entries()) {
        expect(Math.abs(value), `${jointId} 轴${index} = ${value}`).toBeLessThan(12)
      }
    }
  })

  it('落库后的姿势数据很小（画布 payload 曾经把 Node 打到 OOM）', async () => {
    const { normalizePose } = await import('@/features/director-stage/types')
    const { pose } = poseFromLandmarks(standingLandmarks())
    expect(JSON.stringify(normalizePose(pose)).length).toBeLessThan(400)
  })
})

describe('脏输入一律不抛，能摆多少摆多少', () => {
  it('没有关键点 / undefined / 空数组', () => {
    for (const input of [undefined, [], null]) {
      const result = poseFromLandmarks(input as never)
      expect(result.pose).toEqual({})
      expect(result.applied).toEqual([])
      expect(result.skipped.length).toBeGreaterThan(0)
    }
  })

  it('全是 NaN / 非数字', () => {
    const bad = Array.from({ length: LANDMARK_COUNT }, () => ({ x: NaN, y: 'x' as never, z: undefined as never }))
    expect(() => poseFromLandmarks(bad)).not.toThrow()
    expect(poseFromLandmarks(bad).applied).toEqual([])
  })

  it('所有点都重合在原点 → 方向退化，跳过而不是解出 0 向量的角度', () => {
    const collapsed = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }))
    const result = poseFromLandmarks(collapsed)
    expect(result.applied).toEqual([])
    expect(result.pose).toEqual({})
  })

  it('可见度低的点不采信（挡住的半身不该被瞎解）', () => {
    const half = standingLandmarks().map((point, index) => (
      index === LM.leftElbow || index === LM.leftWrist
        ? { ...point, visibility: MIN_VISIBILITY - 0.01 }
        : point
    ))
    const result = poseFromLandmarks(half)
    expect(result.skipped).toContain('upperArmL')
    expect(result.skipped).toContain('elbowL')
    // 右半身照样解得出来
    expect(result.applied).toContain('upperArmR')
  })

  it('点数不够 33 个也不抛', () => {
    expect(() => poseFromLandmarks(standingLandmarks().slice(0, 13))).not.toThrow()
  })

  it('解出来的姿势永远能被 normalizePose 接受（要落库的）', async () => {
    const { normalizePose } = await import('@/features/director-stage/types')
    const { pose } = poseFromLandmarks(withPoints(standingLandmarks(), {
      [LM.leftElbow]: [0.45, -0.9, -0.2],
      [LM.leftWrist]: [0.6, -1.2, -0.4],
    }))
    expect(() => normalizePose(pose)).not.toThrow()
    // normalizePose 会丢掉全 0 的关节，所以只要求它不引入新东西
    for (const jointId of Object.keys(normalizePose(pose))) {
      expect(Object.keys(pose)).toContain(jointId)
    }
  })
})
