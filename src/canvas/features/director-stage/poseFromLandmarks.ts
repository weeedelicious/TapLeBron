/**
 * 参考图 → 白模姿势。**纯函数，不 import three、不碰网络。**
 *
 * 输入是 MediaPipe Pose Landmarker 的 33 个**世界坐标**关键点（GHUM 模型给的 3D 点），
 * 输出是我们自己那 19 个关节的语义角度。视觉那一步在 `poseEstimator.ts`，这里只做重定向。
 *
 * ── 为什么这么实现 ──────────────────────────────────────────────────────────
 *
 * GitHub 上做这件事的现成库是 `yeemachine/kalidokit`（MIT），它的输出关节集和我们的骨架
 * 几乎一一对应，证明这条路子是通的。但它顶着官方废弃声明、基于已经死掉的
 * `@mediapipe/holistic` API、而且自己 README 写着「腿部解算还是 WIP」，所以只借思路。
 *
 * 关键选择：**不手推 Euler 分解**，而是复用 `ik.ts` 里已经测过的 `aimJoint` ——
 * 每根骨头算出「应该指向哪」，剩下的活（把转角投影到该关节允许的轴、换成语义角度、
 * 过钳制、迭代收敛）和 IK 拖手脚完全一样。这么做换来三件事：
 *
 *   ① 约束是免费的。每一步都过 `clampJointAngles`，所以**永远算不出反关节** ——
 *      肘和膝只有 bend 轴，MediaPipe 给的自由三轴根本没有地方可去；
 *   ② 不用第二次去跟 `sign` / `mirror` 那套符号规则搏斗（我在建这个骨架时已经写错过两次）；
 *   ③ 整件事是纯函数，能用正向运动学做往返测试。
 *
 * ── 坐标系 ────────────────────────────────────────────────────────────────
 *
 * MediaPipe 世界坐标：原点在两髋中点，**x 向图像右、y 向下、z 朝摄像机为负**。
 * 我们：**y 向上**，角色**面朝 +Z**，而且左侧关节偏移是**正 X**（`shoulderL` 是 +0.075）。
 *
 * 正面拍一个人时，他的左半身出现在图像右侧 → MediaPipe +x ≈ 角色的左 ≈ 我们 +X。
 * 于是映射就是 `[x, -y, -z]`。这三个符号里错任何一个，姿势都会左右颠倒或者前后翻，
 * 所以测试里有专门用第一性原理手搭的关键点来钉死它，不能只靠往返测试
 * （往返测试会同时用上映射和它的逆，符号错了也能自圆其说）。
 *
 * 只用**方向**不用长度，所以 MediaPipe 的米制尺度和白模的尺度不用对齐，省掉一层缩放。
 */
import {
  aimGapRad,
  aimJoint,
  forwardKinematics,
  solveIk,
  vecAdd,
  vecLength,
  vecNormalize,
  vecSub,
  type Vec3,
} from './ik'
import { JOINT_BY_ID, clampJointAngles, type JointId, type Pose } from './skeleton'

/** MediaPipe Pose Landmarker 的 33 点下标。写全是为了让映射能被人读懂和核对。 */
export const LM = {
  nose: 0,
  leftEyeInner: 1, leftEye: 2, leftEyeOuter: 3,
  rightEyeInner: 4, rightEye: 5, rightEyeOuter: 6,
  leftEar: 7, rightEar: 8,
  mouthLeft: 9, mouthRight: 10,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftPinky: 17, rightPinky: 18,
  leftIndex: 19, rightIndex: 20,
  leftThumb: 21, rightThumb: 22,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
} as const

export const LANDMARK_COUNT = 33

export interface Landmark {
  x: number
  y: number
  z: number
  /** MediaPipe 给的可见度（0–1）。太低的点方向不可信，对应关节就跳过。 */
  visibility?: number
}

/** 可见度低于这个值就不信这个点。0.5 是 MediaPipe 文档里的常用门槛。 */
export const MIN_VISIBILITY = 0.5

export interface PoseFromLandmarksResult {
  pose: Pose
  /** 真正被摆到的关节（按施加顺序） */
  applied: JointId[]
  /** 因为关键点缺失 / 不可见而跳过的关节 */
  skipped: JointId[]
}

function finite(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? num : NaN
}

/**
 * 取一个点并换到我们的坐标系。点不存在、坐标不是有限数、或者可见度太低都返回 null ——
 * 返回 null 让上层跳过对应关节，而不是拿一个 0 向量去算出一个荒谬的角度。
 */
export function readPoint(landmarks: readonly Landmark[] | undefined, index: number): Vec3 | null {
  const point = landmarks?.[index]
  if (!point || typeof point !== 'object') return null
  const x = finite(point.x)
  const y = finite(point.y)
  const z = finite(point.z)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  const visibility = point.visibility
  if (typeof visibility === 'number' && Number.isFinite(visibility) && visibility < MIN_VISIBILITY) return null
  // MediaPipe：x 向右、y 向下、z 朝相机为负 → 我们：x 向左(角色)、y 向上、z 向前
  return [x, -y, -z]
}

function midpoint(a: Vec3 | null, b: Vec3 | null): Vec3 | null {
  if (!a || !b) return null
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
}

/** 两点之间的方向；退化（两点重合）时返回 null。 */
function direction(from: Vec3 | null, to: Vec3 | null): Vec3 | null {
  if (!from || !to) return null
  const delta = vecSub(to, from)
  if (vecLength(delta) < 1e-6) return null
  return vecNormalize(delta)
}

/**
 * 每个关节的骨头该指向哪 —— 由哪两个关键点决定。
 *
 * `shoulderL/R` 和 `chest` 不在表里，**故意的**：肩（锁骨）活动范围只有 ±15~25°，
 * MediaPipe 根本分辨不出锁骨的动作，硬解只会抖；胸和腰共用同一条躯干方向，
 * 分配比例是任意的，所以躯干的前倾后仰全记在 `spine` 上、`chest` 留 0，行为可预测。
 */
const BONE_TARGETS: Array<{ joint: JointId; from: number; to: number }> = [
  // 躯干：髋中点 → 肩中点（这一路骨头朝上）
  { joint: 'spine', from: -1, to: -2 },
]

/**
 * 四肢：上下两节 + 末端那一小节。
 *
 * **为什么四肢不能像躯干那样逐节独立瞄准**（这是我第一版写错的地方，往返测试抓出来的）：
 *
 * Euler 顺序是 YXZ，也就是 R = Ry(turn)·Rx(bend)·Rz(tilt) —— `turn` 是**最外层**、
 * 绕父级 Y 轴的旋转，不是绕骨头自身的扭转。于是「上臂指向哪」这一个约束（2 个自由度）
 * 定不住上臂的第 3 个自由度，而恰恰是那个自由度决定了**肘的弯曲平面**朝哪。
 * 肘只有 bend 一个轴，平面歪了它就永远够不到前臂该去的方向 —— 实测差 80°。
 *
 * 所以上下两节必须**联合求解**。而这活已经有现成的、测过的东西：`ik.ts` 的
 * 约束 CCD（就是画布上「拖手脚」用的那个）。它要一个末端**位置**，
 * 而这个位置能用**我们自己的骨长**加上从关键点算出的两个方向直接拼出来：
 *
 *     目标腕位 = 肩位 + 上臂方向 × 上臂长 + 前臂方向 × 前臂长
 *
 * 骨长取自我们的骨架、方向取自参考图，所以**完全不需要把 MediaPipe 的米制尺度
 * 和白模的尺度对齐** —— 省掉一整层缩放，也省掉「照片里是小孩还是成年人」这类麻烦。
 */
const LIMB_CHAINS: Array<{
  upper: JointId
  hinge: JointId
  /** 末端那一小节（手 / 脚），单独瞄准 */
  tip: JointId
  upperFrom: number
  upperTo: number
  hingeTo: number
  tipTo: number
}> = [
  { upper: 'upperArmL', hinge: 'elbowL', tip: 'wristL', upperFrom: LM.leftShoulder, upperTo: LM.leftElbow, hingeTo: LM.leftWrist, tipTo: LM.leftIndex },
  { upper: 'upperArmR', hinge: 'elbowR', tip: 'wristR', upperFrom: LM.rightShoulder, upperTo: LM.rightElbow, hingeTo: LM.rightWrist, tipTo: LM.rightIndex },
  { upper: 'thighL', hinge: 'kneeL', tip: 'ankleL', upperFrom: LM.leftHip, upperTo: LM.leftKnee, hingeTo: LM.leftAnkle, tipTo: LM.leftFootIndex },
  { upper: 'thighR', hinge: 'kneeR', tip: 'ankleR', upperFrom: LM.rightHip, upperTo: LM.rightKnee, hingeTo: LM.rightAnkle, tipTo: LM.rightFootIndex },
]

/** 某一节骨头在我们骨架上的长度（子关节偏移的模）。 */
function boneLength(childJoint: JointId) {
  const offset = JOINT_BY_ID[childJoint]?.offset
  return offset ? vecLength(offset as Vec3) : 0
}

/**
 * 上臂 / 大腿「旋转」轴的多个起点。
 *
 * 为什么需要多起点：一个方向只有 2 个自由度，定不住上臂的第 3 个自由度 ——
 * 而恰恰是它决定**肘的弯曲平面**朝哪。平面歪了，只有一个轴的肘就永远够不到
 * 前臂该去的方向（实测差 15°）。逐轴下降是局部搜索，会停在起点附近的那个解上。
 *
 * 所以把这个自由度扫一遍，每个起点各解一次，最后按「两节骨头朝向误差之和」挑最好的。
 * 这是一次点击才跑一遍的计算，多解几次完全无所谓。
 */
/** 扫冗余自由度的步长（度）。15° 够密，且四条链加起来也就几十次解算。 */
const REDUNDANCY_SWEEP_STEP = 15

/**
 * 上臂 / 大腿被冻结的那个轴的候选值。
 *
 * 冻 `tilt`（外张），用 `bend` + `turn` 去凑方向 —— 方向是 2 个自由度，正好两个轴够用。
 * 每个 tilt 值给出这一族解里的一个，子关节的弯曲平面各不相同，最后按总分挑。
 */
function redundancySweep(jointId: JointId): number[] {
  const range = JOINT_BY_ID[jointId]?.axes?.tilt
  if (!range) return [0]
  const values: number[] = []
  for (let value = range.min; value <= range.max; value += REDUNDANCY_SWEEP_STEP) values.push(value)
  if (!values.includes(range.max)) values.push(range.max)
  // 0 一定要在里面：自然姿势就是它，扫的时候不能漏
  if (!values.includes(0) && range.min <= 0 && range.max >= 0) values.push(0)
  return values
}

/**
 * 「宁可自然一点」的权重：每 1° 的额外关节转动，折算成多少弧度的朝向误差惩罚。
 *
 * 为什么必需：参考图里的人体比例和白模不会完全一致，所以骨架**本来就还原不到 0 误差**。
 * 而 (bend, turn, tilt) 对「一个方向」是过参数化的，于是解算器总能找到某个大幅扭转，
 * 换来一点点朝向精度。实测：自然站立的手臂，扭 **75°** 只换来 **1.7°** 的改善 ——
 * 朝向看着是对的，但用户一点开滑杆就看到一串莫名其妙的数字，
 * 而且和「重置姿势」之后的手感完全对不上。
 *
 * 1e-3 的标定含义是：**多转 1° 至少要换来 0.057° 的朝向改善才划得来**。
 * 于是上面那笔坏交易被否掉（75° 要 4.3° 才够），而真正需要扭转才能对上的姿势
 * （比如屈肘时肘的弯曲平面必须转过去，动辄十几度的收益）照样会被接受。
 */
const NATURALNESS_WEIGHT = 1e-3

/**
 * 拟合一条四肢链（上臂+肘 / 大腿+膝）。
 *
 * 每个起点走三步：先各自瞄一遍 → 再用约束 CCD 联合收敛到末端位置 →
 * 只在 CCD 确实把两节骨头朝向都改好时才采纳它（CCD 是位置驱动的，
 * 同一个末端位置有一整圈解，它可能为了把腕位再压近 1mm 就把上臂拧歪）。
 */
function fitLimbChain(
  basePose: Pose,
  chain: { upper: JointId; hinge: JointId; tip: JointId },
  upperDir: Vec3,
  hingeDir: Vec3,
): Pose {
  /** 朝向误差（弧度）。CCD 那一步用它判断该不该采纳。 */
  const boneError = (candidate: Pose) =>
    aimGapRad(candidate, chain.upper, upperDir) + aimGapRad(candidate, chain.hinge, hingeDir)

  /** 挑最优起点用的目标：朝向误差为主，近似打平时偏好角度小的自然解。 */
  const score = (candidate: Pose) => {
    const magnitude = [chain.upper, chain.hinge].reduce((sum, jointId) => (
      sum + clampJointAngles(jointId, candidate[jointId]).reduce((acc, value) => acc + Math.abs(value), 0)
    ), 0)
    return boneError(candidate) + NATURALNESS_WEIGHT * magnitude
  }

  const upperLength = boneLength(chain.hinge)
  const hingeLength = boneLength(chain.tip)
  // 上臂根部（肩 / 髋）的位置不受这条链自己的角度影响，算一次就够
  const rootWorld = forwardKinematics(basePose)[chain.upper].position as Vec3
  const target = vecAdd(
    vecAdd(rootWorld, [upperDir[0] * upperLength, upperDir[1] * upperLength, upperDir[2] * upperLength]),
    [hingeDir[0] * hingeLength, hingeDir[1] * hingeLength, hingeDir[2] * hingeLength],
  )

  let best = basePose
  let bestError = Number.POSITIVE_INFINITY

  /** 试一个候选解：瞄上节 → 瞄下节 → CCD 微调（只在真变好时采纳）→ 计分。 */
  const consider = (seeded: Pose, upperAxes?: readonly number[]) => {
    let candidate = aimJoint({
      pose: seeded,
      jointId: chain.upper,
      direction: upperDir,
      ...(upperAxes ? { axisIndices: upperAxes } : {}),
    })
    candidate = aimJoint({ pose: candidate, jointId: chain.hinge, direction: hingeDir })

    const refined = solveIk({
      pose: candidate,
      effector: chain.tip,
      links: [chain.hinge, chain.upper],
      target,
      iterations: 24,
      tolerance: 0.002,
    }).pose
    if (boneError(refined) < boneError(candidate)) candidate = refined

    const error = score(candidate)
    if (error < bestError) {
      best = candidate
      bestError = error
    }
  }

  const cleared: Pose = {
    ...basePose,
    [chain.upper]: clampJointAngles(chain.upper, [0, 0, 0]),
    [chain.hinge]: clampJointAngles(chain.hinge, [0, 0, 0]),
  }

  // ① 三个轴都放开解一次 —— 冗余自由度落在哪算哪，作为兜底候选
  consider(cleared)

  // ② 冻住 tilt 扫一遍，把那一族解枚举出来，找子关节弯曲平面对得上的那个
  for (const tilt of redundancySweep(chain.upper)) {
    consider(
      { ...cleared, [chain.upper]: clampJointAngles(chain.upper, [0, 0, tilt]) },
      [0, 1],
    )
  }

  return best
}

/** 哨兵下标：-1 髋中点、-2 肩中点、-3 耳中点、-4 嘴中点、-5 眼中点。 */
function resolveSentinel(landmarks: readonly Landmark[], index: number): Vec3 | null {
  if (index >= 0) return readPoint(landmarks, index)
  if (index === -1) return midpoint(readPoint(landmarks, LM.leftHip), readPoint(landmarks, LM.rightHip))
  if (index === -2) return midpoint(readPoint(landmarks, LM.leftShoulder), readPoint(landmarks, LM.rightShoulder))
  if (index === -3) return midpoint(readPoint(landmarks, LM.leftEar), readPoint(landmarks, LM.rightEar))
  if (index === -4) return midpoint(readPoint(landmarks, LM.mouthLeft), readPoint(landmarks, LM.mouthRight))
  if (index === -5) return midpoint(readPoint(landmarks, LM.leftEye), readPoint(landmarks, LM.rightEye))
  return null
}

/**
 * 绕 +Y 的偏航角（度）：从 +X 转到 `dir` 在 XZ 平面上的投影。
 *
 * 静止姿势下「右髋 → 左髋」正好是 +X（`thighL` 在 +X、`thighR` 在 -X），
 * 所以髋线相对 +X 转了多少，就是整个人转身转了多少。
 */
export function yawFromLineDeg(dir: Vec3 | null): number | null {
  if (!dir) return null
  const x = dir[0]
  const z = dir[2]
  if (Math.hypot(x, z) < 1e-6) return null
  // 绕 +Y 右手定则：+X 向 -Z 是正方向，所以用 atan2(-z, x)
  return (Math.atan2(-z, x) * 180) / Math.PI
}

/** 归一化到 (-180, 180]，免得转身 190° 被钳成 180° 而不是 -170°。 */
export function wrapDeg(value: number) {
  let out = value % 360
  if (out > 180) out -= 360
  if (out <= -180) out += 360
  return out
}

/**
 * 从关键点解出姿势。
 *
 * **永不抛**：关键点少了、坏了、全是 NaN、根本没有人 —— 一律返回能摆的那部分，
 * 剩下的留在 0（自然站立）。让用户看到「只摆到了几处」比弹一个异常有用。
 *
 * 顺序是从根到叶（`BONE_TARGETS` 就是这个顺序）：每一节的瞄准都依赖父节点已经定好，
 * 反过来做的话上臂一转，前臂之前算好的角度就全错了。
 */
export function poseFromLandmarks(landmarks: readonly Landmark[] | undefined): PoseFromLandmarksResult {
  const applied: JointId[] = []
  const skipped: JointId[] = []
  let pose: Pose = {}

  const list = Array.isArray(landmarks) ? landmarks : []
  if (list.length === 0) {
    return { pose, applied, skipped: BONE_TARGETS.map((entry) => entry.joint) }
  }

  // ── 整体转身：髋线绕 Y 的偏航 ──────────────────────────────────────────────
  // hips 的子关节偏移是竖直向上的，绕 Y 转它没有任何投影，所以 aimJoint 摸不到
  // 「转身」这个自由度，必须单独算。
  const hipYaw = yawFromLineDeg(
    direction(readPoint(list, LM.rightHip), readPoint(list, LM.leftHip)),
  )
  if (hipYaw !== null) {
    pose = { ...pose, hips: clampJointAngles('hips', [0, wrapDeg(hipYaw), 0]) }
    applied.push('hips')
  } else {
    skipped.push('hips')
  }

  // ── 躯干：算方向 → 交给 aimJoint ──────────────────────────────────────────
  for (const entry of BONE_TARGETS) {
    const dir = direction(resolveSentinel(list, entry.from), resolveSentinel(list, entry.to))
    if (!dir) {
      skipped.push(entry.joint)
      continue
    }
    pose = aimJoint({ pose, jointId: entry.joint, direction: dir })
    applied.push(entry.joint)
  }

  // ── 四肢：上下两节联合求解（见 LIMB_CHAINS 的说明）────────────────────────
  for (const chain of LIMB_CHAINS) {
    const rootPoint = readPoint(list, chain.upperFrom)
    const midPoint = readPoint(list, chain.upperTo)
    const endPoint = readPoint(list, chain.hingeTo)
    const upperDir = direction(rootPoint, midPoint)
    const hingeDir = direction(midPoint, endPoint)
    if (!upperDir || !hingeDir) {
      skipped.push(chain.upper, chain.hinge)
    } else {
      pose = fitLimbChain(pose, chain, upperDir, hingeDir)
      applied.push(chain.upper, chain.hinge)
    }

    // ③ 末端那一小节（手 / 脚）单独瞄，它只影响自己
    const tipDir = direction(readPoint(list, chain.hingeTo), readPoint(list, chain.tipTo))
    if (tipDir) {
      pose = aimJoint({ pose, jointId: chain.tip, direction: tipDir })
      applied.push(chain.tip)
    } else {
      skipped.push(chain.tip)
    }
  }

  // ── 头颈 ─────────────────────────────────────────────────────────────────
  // 颈那一节朝上，瞄「肩中点 → 耳中点」。
  //
  // 头的朝上方向用「嘴中点 → **眼**中点」：眼睛在嘴上方、而且前后位置和嘴接近，
  // 所以这个向量对直立的头基本是竖直的。第一版用的是「嘴中点 → 耳中点」——
  // 但嘴本来就明显靠前，那个向量对直立的头都偏了约 45°，
  // 于是自然站立会解出「头往后仰到下限」（测试当场抓到）。
  const neckDir = direction(resolveSentinel(list, -2), resolveSentinel(list, -3))
  if (neckDir) {
    pose = aimJoint({ pose, jointId: 'neck', direction: neckDir })
    applied.push('neck')
  } else {
    skipped.push('neck')
  }

  const headUp = direction(resolveSentinel(list, -4), resolveSentinel(list, -5))
  if (headUp) {
    pose = aimJoint({ pose, jointId: 'head', direction: headUp })
    applied.push('head')
  } else {
    skipped.push('head')
  }

  // 头的左右转：耳线相对肩线的偏航差。和 hips 同理，绕 Y 的自由度 aimJoint 摸不到。
  const earYaw = yawFromLineDeg(
    direction(readPoint(list, LM.rightEar), readPoint(list, LM.leftEar)),
  )
  const shoulderYaw = yawFromLineDeg(
    direction(readPoint(list, LM.rightShoulder), readPoint(list, LM.leftShoulder)),
  )
  if (earYaw !== null && shoulderYaw !== null) {
    const current = clampJointAngles('head', pose.head)
    pose = {
      ...pose,
      head: clampJointAngles('head', [current[0], wrapDeg(earYaw - shoulderYaw), current[2]]),
    }
  }

  return { pose, applied, skipped }
}
