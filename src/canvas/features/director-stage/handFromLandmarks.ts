/**
 * 把 MediaPipe 的 21 个手部关键点重定向到我们那 15 个指骨上。纯函数，不碰网络也不碰 three。
 *
 * ── 为什么要换基，不能直接拿观测方向当目标 ──────────────────────────────────
 *
 * `HandLandmarker` 的 `worldLandmarks` 是**手自己的局部坐标系**（原点在手附近、
 * 轴向跟着相机），和身体那套 `PoseLandmarker` 的世界坐标不是一个系。直接把它当世界
 * 方向喂给 FK，手指会朝着一个和手掌毫无关系的方向翻过去。
 *
 * 所以走「换基」：
 *   ① 从观测点里搭一组正交基（手掌朝向 / 横穿手掌 / 掌面法向）；
 *   ② 把每节骨头的观测方向表示成这组基下的三个系数；
 *   ③ 拿同样的三个系数，在**我们骨架静止手掌**的同名基上重新组合出局部方向；
 *   ④ 用手腕当前的世界旋转把它转到世界空间，再交给 `aimJoint`。
 * 换基是刚性变换（正交基之间），角度不会被拉伸，所以「弯了 60°」过去还是 60°。
 *
 * 手腕本身不在这里解 —— 它由身体那 33 个点解出来（见 poseFromLandmarks 的四肢链），
 * 这里只在它给定的朝向上摆手指。
 *
 * ── 左右手怎么定 ────────────────────────────────────────────────────────────
 *
 * **不看模型给的 handedness。** MediaPipe 的左右判定是按「自拍镜像画面」的假定给的，
 * 普通照片得反过来，而这个约定在不同版本的文档里说法还不一样。
 * 我们的做法是：按身体关键点算出的**左手腕**位置裁一块图去检测 —— 检出来的当然就是左手。
 * 这样左右由裁剪决定，跟模型的约定无关（见 poseEstimator 的 estimateHandFromCrop）。
 */
import {
  FINGER_JOINT_IDS,
  FINGER_NAMES,
  JOINT_BY_ID,
  type FingerName,
  type JointId,
  type Pose,
  type Side,
} from './skeleton'
import {
  aimGapRad,
  aimJoint,
  forwardKinematics,
  mat3Apply,
  vecCross,
  vecDot,
  vecLength,
  vecNormalize,
  vecSub,
  type Mat3,
  type Vec3,
} from './ik'
import { clampJointAngles, poseAngles } from './skeleton'
import { readPoint, type Landmark } from './poseFromLandmarks'

export const HAND_LANDMARK_COUNT = 21

/** MediaPipe 手部关键点的下标。 */
export const HL = {
  wrist: 0,
  thumbCmc: 1, thumbMcp: 2, thumbIp: 3, thumbTip: 4,
  indexMcp: 5, indexPip: 6, indexDip: 7, indexTip: 8,
  middleMcp: 9, middlePip: 10, middleDip: 11, middleTip: 12,
  ringMcp: 13, ringPip: 14, ringDip: 15, ringTip: 16,
  littleMcp: 17, littlePip: 18, littleDip: 19, littleTip: 20,
} as const

/**
 * 每根手指三节骨头各由哪两个关键点定方向。
 *
 * 拇指错开一位：MakeHuman 的 `finger1-1` 是**掌骨**，所以拇指的第一节对应
 * cmc→mcp，而其它四指的第一节对应 mcp→pip。对错了的话拇指会整根偏一节。
 */
const FINGER_BONE_LANDMARKS: Record<FingerName, ReadonlyArray<readonly [number, number]>> = {
  thumb: [[HL.thumbCmc, HL.thumbMcp], [HL.thumbMcp, HL.thumbIp], [HL.thumbIp, HL.thumbTip]],
  index: [[HL.indexMcp, HL.indexPip], [HL.indexPip, HL.indexDip], [HL.indexDip, HL.indexTip]],
  middle: [[HL.middleMcp, HL.middlePip], [HL.middlePip, HL.middleDip], [HL.middleDip, HL.middleTip]],
  ring: [[HL.ringMcp, HL.ringPip], [HL.ringPip, HL.ringDip], [HL.ringDip, HL.ringTip]],
  little: [[HL.littleMcp, HL.littlePip], [HL.littlePip, HL.littleDip], [HL.littleDip, HL.littleTip]],
}

export interface HandFromLandmarksResult {
  pose: Pose
  applied: JointId[]
  skipped: JointId[]
}

/** 一组正交基：横穿手掌 / 手掌朝向 / 掌面法向。 */
interface HandBasis {
  across: Vec3
  along: Vec3
  normal: Vec3
}

/**
 * 从三条参考向量搭正交基。`along` 为主轴，`across` 去掉沿 `along` 的分量后正交化。
 * 两者近乎平行（手被压成一条线）时返回 null —— 这时候什么都别解，比解错好。
 */
function buildBasis(along: Vec3 | null, acrossRaw: Vec3 | null): HandBasis | null {
  if (!along || !acrossRaw) return null
  if (vecLength(along) < 1e-6 || vecLength(acrossRaw) < 1e-6) return null
  const a = vecNormalize(along)
  const projected = vecSub(acrossRaw, [a[0] * vecDot(acrossRaw, a), a[1] * vecDot(acrossRaw, a), a[2] * vecDot(acrossRaw, a)])
  if (vecLength(projected) < 1e-4) return null
  const across = vecNormalize(projected)
  return { across, along: a, normal: vecNormalize(vecCross(across, a)) }
}

/** 观测到的手掌基。取手腕→中指根当主轴、小指根→食指根当横向。 */
function observedBasis(landmarks: readonly Landmark[]): HandBasis | null {
  const wrist = readPoint(landmarks, HL.wrist)
  const middle = readPoint(landmarks, HL.middleMcp)
  const index = readPoint(landmarks, HL.indexMcp)
  const little = readPoint(landmarks, HL.littleMcp)
  if (!wrist || !middle || !index || !little) return null
  return buildBasis(vecSub(middle, wrist), vecSub(index, little))
}

/**
 * 我们骨架静止手掌的基，**在手腕的局部坐标里**。
 *
 * 指根关节的 offset 就是「相对手腕」的向量，所以中指根的 offset 是主轴、
 * 食指根减小指根是横向 —— 和上面观测基的定义严格对应。
 */
function restBasis(side: Side): HandBasis | null {
  const middle = JOINT_BY_ID[FINGER_JOINT_IDS[side].middle[0]]?.offset as Vec3 | undefined
  const index = JOINT_BY_ID[FINGER_JOINT_IDS[side].index[0]]?.offset as Vec3 | undefined
  const little = JOINT_BY_ID[FINGER_JOINT_IDS[side].little[0]]?.offset as Vec3 | undefined
  if (!middle || !index || !little) return null
  return buildBasis(middle, vecSub(index, little))
}

/** 把一个方向从一组基换到另一组基（系数照抄，基底替换）。 */
function rebase(direction: Vec3, from: HandBasis, to: HandBasis): Vec3 {
  const cAcross = vecDot(direction, from.across)
  const cAlong = vecDot(direction, from.along)
  const cNormal = vecDot(direction, from.normal)
  return [
    to.across[0] * cAcross + to.along[0] * cAlong + to.normal[0] * cNormal,
    to.across[1] * cAcross + to.along[1] * cAlong + to.normal[1] * cNormal,
    to.across[2] * cAcross + to.along[2] * cAlong + to.normal[2] * cNormal,
  ]
}

function boneDirection(landmarks: readonly Landmark[], from: number, to: number): Vec3 | null {
  const a = readPoint(landmarks, from)
  const b = readPoint(landmarks, to)
  if (!a || !b) return null
  const delta = vecSub(b, a)
  return vecLength(delta) < 1e-6 ? null : vecNormalize(delta)
}

/**
 * 拇指近节「对掌旋转」的候选值。
 *
 * 为什么只有拇指要扫：一个方向只能定住 2 个自由度，而拇指近节有 3 个轴。
 * 多出来那个（绕自身轴的旋转）不影响它自己指向哪，却决定了**后面两节的弯曲平面**——
 * 平面歪了，只有一个轴的中节和远节就永远够不到该去的方向（实测差 15.4°）。
 *
 * 所以把它扫一遍，每个候选各解一次，按「三节骨向误差之和」挑最好的。
 * 和四肢那边 `redundancySweep` 是同一个思路（见 poseFromLandmarks 的说明）。
 * 一次点击才跑一遍，多解九次完全无所谓。
 */
const THUMB_TWIST_STEP = 10
/**
 * 粗扫完再在胜出值附近细扫一遍的步长。
 *
 * 只粗扫的话，真实扭转恰好落在两个候选中间时残差最大（实测 4.7°，仍然看得出来）。
 * 细扫一轮把它压到 1° 以内。总共十九次解算，一次点击跑一遍，代价可以忽略。
 */
const THUMB_TWIST_REFINE = 2

/** 逐节瞄。近节可以冻住某几个轴（扫冗余自由度时用，否则逐轴下降会把种子覆盖掉）。 */
function aimSegments(
  pose: Pose,
  ids: readonly JointId[],
  targets: ReadonlyArray<Vec3 | null>,
  firstAxes?: number[],
): Pose {
  let next = pose
  ids.forEach((jointId, index) => {
    const target = targets[index]
    if (!target) return
    next = aimJoint({
      pose: next,
      jointId,
      direction: target,
      ...(index === 0 && firstAxes ? { axisIndices: firstAxes } : {}),
    })
  })
  return next
}

/** 这一串关节离目标还差多少（弧度之和）。挑冗余自由度的候选就靠它打分。 */
function chainGap(pose: Pose, ids: readonly JointId[], targets: ReadonlyArray<Vec3 | null>): number {
  let total = 0
  ids.forEach((jointId, index) => {
    const target = targets[index]
    if (target) total += aimGapRad(pose, jointId, target)
  })
  return total
}

/**
 * 解一只手的 15 个指骨。手腕的世界朝向取自传进来的姿势，所以**先解身体再解手**。
 *
 * 永远不抛：任何一步拿不到数据就把对应关节记进 `skipped`，姿势原样留着。
 * 手在照片里只有几十个像素时检测本来就常失败，那种情况下「这只手不动」远好过乱摆。
 */
export function handFromLandmarks(
  pose: Pose,
  side: Side,
  landmarks: readonly Landmark[] | undefined,
): HandFromLandmarksResult {
  const allIds = FINGER_NAMES.flatMap((name) => FINGER_JOINT_IDS[side][name])
  const list = Array.isArray(landmarks) ? landmarks : []
  const observed = list.length >= HAND_LANDMARK_COUNT ? observedBasis(list) : null
  const rest = restBasis(side)
  if (!observed || !rest) {
    return { pose, applied: [], skipped: allIds }
  }

  const wristId = `wrist${side}` as JointId
  const wristRotation: Mat3 | undefined = forwardKinematics(pose)[wristId]?.rotation
  if (!wristRotation) return { pose, applied: [], skipped: allIds }

  let next = pose
  const applied: JointId[] = []
  const skipped: JointId[] = []
  for (const name of FINGER_NAMES) {
    const ids = FINGER_JOINT_IDS[side][name]
    const bones = FINGER_BONE_LANDMARKS[name]

    // 先把三节的目标方向都换算好：观测基 → 静止手掌基 → 世界（手腕当前朝向）
    const targets: Array<Vec3 | null> = ids.map((jointId, segment) => {
      const pair = bones[segment]
      const observedDir = pair ? boneDirection(list, pair[0], pair[1]) : null
      if (!observedDir) return null
      const local = rebase(observedDir, observed, rest)
      if (vecLength(local) < 1e-6) return null
      const target = mat3Apply(wristRotation, vecNormalize(local))
      return vecLength(target) < 1e-6 ? null : vecNormalize(target)
    })

    if (name === 'thumb') {
      // 扫对掌旋转（见 THUMB_TWIST_STEP 的说明）。冻住 turn，让 bend/tilt 去凑方向。
      const twist = JOINT_BY_ID[ids[0]]?.axes?.turn
      const incoming = poseAngles(next, ids[0])
      const sweepTwist = (candidates: readonly number[]) => {
        let best: { pose: Pose; gap: number; value: number } | null = null
        for (const value of candidates) {
          const seeded: Pose = {
            ...next,
            [ids[0]]: clampJointAngles(ids[0], [incoming[0], value, incoming[2]]),
          }
          const solved = aimSegments(seeded, ids, targets, [0, 2])
          const gap = chainGap(solved, ids, targets)
          if (!best || gap < best.gap - 1e-12) best = { pose: solved, gap, value }
        }
        return best
      }

      const coarse: number[] = [0]
      if (twist) {
        for (let value = twist.min; value <= twist.max; value += THUMB_TWIST_STEP) coarse.push(value)
        if (!coarse.includes(twist.max)) coarse.push(twist.max)
      }
      let best = sweepTwist(coarse)
      if (best && twist) {
        // 在胜出值附近细扫一轮 —— 真实扭转落在两个粗候选中间时全靠这一步
        const fine: number[] = []
        for (let delta = -THUMB_TWIST_STEP; delta <= THUMB_TWIST_STEP; delta += THUMB_TWIST_REFINE) {
          const value = best.value + delta
          if (value >= twist.min && value <= twist.max) fine.push(value)
        }
        const refined = sweepTwist(fine)
        if (refined && refined.gap < best.gap - 1e-12) best = refined
      }
      next = best ? best.pose : next
    } else {
      // 其它四指的近节只有「张开 + 弯曲」两个轴，瞄一个方向解唯一，不用扫
      next = aimSegments(next, ids, targets)
    }

    ids.forEach((jointId, segment) => {
      if (targets[segment]) applied.push(jointId)
      else skipped.push(jointId)
    })
  }
  return { pose: next, applied, skipped }
}
