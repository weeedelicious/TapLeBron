/**
 * 「拖手脚，手臂自动跟着算」——受关节自由度约束的 CCD 反向运动学。**纯函数，不 import three。**
 *
 * 为什么不用 three 自带的：`three/examples/jsm/animation/CCDIKSolver.js` 的源码注释写得很清楚，
 * 它 *"is designed to work with instances of SkinnedMesh"* —— 要一个蒙皮网格 + Skeleton + Bone。
 * 我们的白模是按图元搭的 Object3D 层级，不是蒙皮网格，硬套要先造一套假骨骼。
 * CCD 本身就几十行，自己写反而能做到两件更重要的事：
 *
 *   ① **每一步都过 clampJointAngles**，所以 IK 永远算不出「肘关节侧倾 30 度」这种
 *      解剖上不存在的姿势 —— 那是这类工具最常见的崩坏方式；
 *   ② 整个解算是纯函数（姿势 + 目标点 → 新姿势），jsdom 里能直接断言收敛性，
 *      不用起 WebGL。
 *
 * 正向运动学也在这里自己算了一遍。看着像重复（three 那边渲染时也会算一次），
 * 但让 IK 不依赖场景图是它能被测试的前提，而且 FK 本身也需要被测 ——
 * 「全 0 姿势下脚踝正好落在地面附近」这种断言只有拿到坐标才做得了。
 */
import {
  DIRECTOR_JOINTS,
  JOINT_BY_ID,
  JOINT_IDS,
  axisEulerSign,
  clampJointAngles,
  eulerForJoint,
  jointAxes,
  poseAngles,
  type JointId,
  type Pose,
} from './skeleton'

export type Vec3 = [number, number, number]
/** 3×3 旋转矩阵，行主序：[m00,m01,m02, m10,m11,m12, m20,m21,m22] */
export type Mat3 = number[]

const EPSILON = 1e-9

export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function vecLength(v: Vec3) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

export function vecNormalize(v: Vec3): Vec3 {
  const len = vecLength(v)
  if (len < EPSILON) return [0, 0, 0]
  return [v[0] / len, v[1] / len, v[2] / len]
}

export function vecDot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function vecCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

export function mat3Identity(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1]
}

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = new Array(9).fill(0)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] +
        a[row * 3 + 1] * b[3 + col] +
        a[row * 3 + 2] * b[6 + col]
    }
  }
  return out
}

export function mat3Apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

/**
 * Euler（弧度）→ 旋转矩阵，顺序 **YXZ**，和 skeleton.ts 的 JOINT_EULER_ORDER 一致：
 * R = Ry · Rx · Rz。顺序不一致的话 IK 算出来的姿势和渲染出来的姿势会是两回事。
 */
export function mat3FromEulerYXZ(x: number, y: number, z: number): Mat3 {
  const cx = Math.cos(x), sx = Math.sin(x)
  const cy = Math.cos(y), sy = Math.sin(y)
  const cz = Math.cos(z), sz = Math.sin(z)
  const rx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx]
  const ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  const rz: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1]
  return mat3Mul(mat3Mul(ry, rx), rz)
}

export interface JointWorld {
  position: Vec3
  rotation: Mat3
  /** 父关节的世界旋转 —— 本关节的局部轴就是它的列向量，IK 要用 */
  parentRotation: Mat3
}

/**
 * 正向运动学：算出每个关节原点的世界坐标和世界旋转。
 *
 * 依赖 DIRECTOR_JOINTS 是「父在子之前」的顺序（有测试锁着这一点），
 * 所以一遍循环就够，不用递归。
 */
export function forwardKinematics(pose: Pose | undefined): Record<JointId, JointWorld> {
  const world = {} as Record<JointId, JointWorld>
  for (const joint of DIRECTOR_JOINTS) {
    const parent = joint.parent ? world[joint.parent] : undefined
    const parentPosition: Vec3 = parent ? parent.position : [0, 0, 0]
    const parentRotation: Mat3 = parent ? parent.rotation : mat3Identity()
    const [ex, ey, ez] = eulerForJoint(joint.id, poseAngles(pose, joint.id))
    const local = mat3FromEulerYXZ(ex, ey, ez)
    world[joint.id] = {
      position: vecAdd(parentPosition, mat3Apply(parentRotation, joint.offset)),
      rotation: mat3Mul(parentRotation, local),
      parentRotation,
    }
  }
  return world
}

/** 关节 j 的第 index 个局部轴在世界空间的方向（父旋转的列向量）。 */
function worldAxis(parentRotation: Mat3, index: number): Vec3 {
  return vecNormalize([parentRotation[index], parentRotation[3 + index], parentRotation[6 + index]])
}

/**
 * 绕 axis 把 from 转到 to 需要多少弧度（带符号，右手定则）。
 * 两个向量先投影到垂直于 axis 的平面上 —— 只有这个平面内的转角是这个轴能提供的。
 */
function signedAngleAround(axis: Vec3, from: Vec3, to: Vec3) {
  const project = (v: Vec3): Vec3 => {
    const along = vecDot(v, axis)
    return [v[0] - axis[0] * along, v[1] - axis[1] * along, v[2] - axis[2] * along]
  }
  const a = project(from)
  const b = project(to)
  if (vecLength(a) < 1e-6 || vecLength(b) < 1e-6) return 0
  const na = vecNormalize(a)
  const nb = vecNormalize(b)
  const cos = Math.min(1, Math.max(-1, vecDot(na, nb)))
  const sin = vecDot(axis, vecCross(na, nb))
  return Math.atan2(sin, cos)
}

export interface SolveIkOptions {
  pose: Pose
  /** 被拖动的那个关节（手腕 / 脚踝） */
  effector: JointId
  /** 参与解算的关节，**从靠近末端到靠近根**（如 ['elbowL','upperArmL']） */
  links: JointId[]
  target: Vec3
  iterations?: number
  /** 末端离目标多近就算收敛（世界单位，白模身高约 1.7） */
  tolerance?: number
}

export interface SolveIkResult {
  pose: Pose
  /** 收敛后末端到目标的距离 */
  distance: number
  /** 实际迭代了几轮 */
  iterations: number
}

/**
 * 受约束的 CCD：一轮里从最靠近末端的关节开始，逐个把末端往目标方向拧。
 *
 * 每个关节只在**它自己允许的轴**上拧：把「末端→目标」需要的转角投影到该轴，
 * 加到当前语义角度上，再过一遍 clampJointAngles。所以：
 *   · 肘 / 膝只会在 bend 上动（另外两轴根本不在 jointAxes 里）；
 *   · 拧到上下限就停在限位上，不会越界；
 *   · 目标够不到时手臂会朝目标伸直，而不是抽风乱转。
 *
 * 投影到父关节的轴是个近似（Euler YXZ 三个轴本身不正交独立），但 CCD 是迭代的，
 * 多转几轮就收敛了 —— 这也是 CCD 相比解析解的好处。
 */
/**
 * 这个关节的「骨头朝哪」在它自己的局部坐标里是哪个方向。
 *
 * 有子关节就用子关节的偏移（骨头连向孩子）；没有子关节（脚、头、指尖）就退回自己形状的
 * 偏移 —— 脚的形状往前、头的形状往上、指节的形状顺着自己伸，正好都是那节的朝向。
 *
 * 手腕必须走 `boneChild`：它有五个子关节，表里第一个是拇指，而拇指不是手的朝向。
 * 少了这一句，IK 和参考图反推都会把手当成「指向拇指」。
 */
export function jointTipLocal(jointId: JointId): Vec3 | null {
  const self = JOINT_BY_ID[jointId]
  const child = self?.boneChild
    ? JOINT_BY_ID[self.boneChild]
    : DIRECTOR_JOINTS.find((joint) => joint.parent === jointId)
  const source = child?.offset ?? self?.shape?.offset
  if (!source) return null
  const dir = vecNormalize(source as Vec3)
  return vecLength(dir) < 1e-6 ? null : dir
}

/** 这个关节当前那节骨头在世界空间指向哪。 */
export function jointBoneDirection(
  world: Record<JointId, JointWorld>,
  jointId: JointId,
  tipLocal?: Vec3 | null,
): Vec3 {
  const tip = tipLocal ?? jointTipLocal(jointId)
  const entry = world[jointId]
  if (!tip || !entry) return [0, 0, 0]
  return vecNormalize(mat3Apply(entry.rotation, tip))
}

export interface AimJointOptions {
  pose: Pose
  jointId: JointId
  /** 想让这节骨头指向的世界方向（不必归一化） */
  direction: Vec3
  iterations?: number
  /** 差这么多弧度以内就算到位 */
  tolerance?: number
  /**
   * 只允许动这几个轴（下标按 bend / turn / tilt）。不给就是三个轴都能动。
   *
   * 用途：一个方向只有 2 个自由度，三轴关节对它是**过参数化**的 —— 同一个朝向对应
   * 一整族角度组合，而选哪一个决定了子关节（肘 / 膝）的弯曲平面朝哪。
   * 想把这一族枚举出来，就得**冻住其中一个轴**、用另外两个去凑方向。
   * （只给初值是没用的：坐标下降会把初值直接覆盖掉，实测所有初值收敛到同一个点。）
   */
  axisIndices?: readonly number[]
}

/** 这一节骨头当前朝向和目标方向差多少弧度。`aimJoint` 用它判断一步到底有没有变好。 */
export function aimGapRad(pose: Pose, jointId: JointId, target: Vec3, tipLocal?: Vec3 | null): number {
  const dir = jointBoneDirection(forwardKinematics(pose), jointId, tipLocal)
  if (vecLength(dir) < 1e-6) return Math.PI
  const gap = Math.acos(Math.min(1, Math.max(-1, vecDot(dir, target))))
  return Number.isFinite(gap) ? gap : Math.PI
}

/** 一步走不动就试半步、四分之一步。经典阻尼线搜索，专治过冲。 */
const AIM_STEP_SCALES = [1, 0.5, 0.25, 0.1] as const

/**
 * 骨头和某个旋转轴的夹角余弦超过这个值，就不在这个轴上解。
 *
 * 病态情形：骨头几乎躺在旋转轴上时，绕它转基本改不动朝向（只是在一个很窄的锥面上打旋），
 * 但 `signedAngleAround` 会把两个极小的投影向量归一化后求角 —— 于是它能返回一个**巨大**
 * 的转角，换来的朝向改善微乎其微。实测表现：手臂垂下（几乎和 Y 轴重合）时
 * 解出 `turn = -43°`，朝向明明是对的，但用户一点开滑杆就看到一串莫名其妙的数字。
 *
 * 0.995 ≈ 5.7°。跳过它不会漏解，因为这种情况下另外两个轴本来就能把朝向调到位。
 */
const AIM_AXIS_PARALLEL_LIMIT = 0.995

/**
 * 把某一节骨头**尽量**转到指向给定的世界方向，返回新姿势。
 *
 * 给「从参考图分析姿势」用的：那边拿到一堆关键点，能算出每节骨头**应该**指哪，
 * 剩下的活和 IK 拖手脚一样。好处很实在 —— 不用再手推一遍 Euler 分解和
 * `sign` / `mirror` 的符号规则（那套我已经写错过两次），而且约束是免费带上的：
 * 肘和膝只有 bend 轴，这里永远算不出反关节。
 *
 * ── 为什么是「逐轴 + 只接受变好的步」而不是像 solveIk 那样三个轴一起改 ──────────
 *
 * 第一版就是照 `solveIk` 的内核写的：从同一个 FK 快照出发，三个轴各自算出「闭合整个
 * 角度差需要转多少」，然后一起加上去。问题是**每个轴都想独自把整个差闭合掉**，
 * 三个加在一起严重过冲，下一轮再往回过冲，来回震荡直到撞上关节限位。
 *
 * 更糟的是它**对浮点噪声敏感到不可用**：同一个方向向量差最后一两位
 * （`0.49999999999999994` vs `0.4999999999999998`），一个收敛到 2.5° 内、
 * 另一个直接飞到 `[170, -90, 165]`（三轴全顶死），差 80°。这是往返测试抓出来的。
 *
 * 现在改成标准的坐标下降：一次只动一个轴、动完立刻重算 FK、**只有确实把角度差
 * 缩小了才接受这一步**，走不动就试半步。于是收敛过程单调、结果确定，
 * 也不会被浮点噪声推进死角。
 *
 * 「尽量」是字面意思：肘只有一个轴，指不到就停在这个轴能达到的最近处；
 * 超过上下限就停在限位上。这是想要的行为，不是缺陷。
 */
/**
 * 单起点坐标下降卡住时才启用的种子网格（每个可动轴取下限 / 中点 / 上限）。
 *
 * 为什么需要：坐标下降是局部搜索。实测方向 (0.59, 0.36, -0.72)（手举高并向后）
 * 从静止姿势出发会停在 66° 的坏解上，而 20° 步长的穷举能到 3.3° —— 差了 60 多度。
 * 这对四肢影响不大（`poseFromLandmarks` 那边本来就在扫冗余自由度），
 * 但 spine / neck / head / wrist / ankle 是**直接**调这个函数的，没人兜着。
 *
 * 「按需」很重要：绝大多数方向一次下降就到位，先跑一次、只在明显没解好时才扫网格，
 * 这样常见情形的开销不变（四肢那边一次分析要调几十次 aimJoint）。
 */
const AIM_ESCALATE_THRESHOLD_RAD = (3 * Math.PI) / 180

/** 从某个起点开始做一轮完整的坐标下降。 */
function descendAim(
  start: Pose,
  jointId: JointId,
  target: Vec3,
  tip: Vec3,
  axes: ReturnType<typeof jointAxes>,
  iterations: number,
  tolerance: number,
): { pose: Pose; gap: number } {
  let best: Pose = start
  let bestGap = aimGapRad(best, jointId, target, tip)

  for (let round = 0; round < iterations && bestGap > tolerance; round++) {
    let improved = false
    for (const { index } of axes) {
      const world = forwardKinematics(best)
      const current = jointBoneDirection(world, jointId, tip)
      if (vecLength(current) < 1e-6) break
      const axis = worldAxis(world[jointId].parentRotation, index)
      if (vecLength(axis) < 1e-6) continue
      // 骨头几乎躺在这个轴上 → 绕它转是病态的，跳过（见 AIM_AXIS_PARALLEL_LIMIT）
      if (Math.abs(vecDot(current, axis)) > AIM_AXIS_PARALLEL_LIMIT) continue
      const deltaRad = signedAngleAround(axis, current, target)
      if (!Number.isFinite(deltaRad) || Math.abs(deltaRad) < 1e-9) continue
      // 世界转角 → 语义角度：符号规则只有 skeleton.axisEulerSign 一份
      const fullStep = (deltaRad * 180) / Math.PI * axisEulerSign(jointId, index)

      for (const scale of AIM_STEP_SCALES) {
        const angles = clampJointAngles(jointId, best[jointId])
        angles[index] += fullStep * scale
        const candidate: Pose = { ...best, [jointId]: clampJointAngles(jointId, angles) }
        const gap = aimGapRad(candidate, jointId, target, tip)
        if (gap < bestGap - 1e-12) {
          best = candidate
          bestGap = gap
          improved = true
          break
        }
      }
    }
    if (!improved) break
  }

  return { pose: best, gap: bestGap }
}

export function aimJoint({
  pose,
  jointId,
  direction,
  iterations = 12,
  tolerance = 1e-4,
  axisIndices,
}: AimJointOptions): Pose {
  const joint = JOINT_BY_ID[jointId]
  const tip = jointTipLocal(jointId)
  const target = vecNormalize(direction)
  const allAxes = joint ? jointAxes(jointId) : []
  const axes = axisIndices
    ? allAxes.filter((entry) => axisIndices.includes(entry.index))
    : allAxes
  if (!joint || !tip || axes.length === 0 || vecLength(target) < 1e-6) return { ...pose }

  let best = descendAim({ ...pose }, jointId, target, tip, axes, iterations, tolerance)
  if (best.gap <= AIM_ESCALATE_THRESHOLD_RAD) return best.pose

  // 卡住了：从种子网格再各下降一次。**只动可动轴** —— 被冻住的轴（axisIndices 之外）
  // 必须保持调用方给的值，`poseFromLandmarks` 扫冗余自由度就靠这一点。
  const incoming = clampJointAngles(jointId, pose[jointId])
  const seedValues = axes.map(({ def }) => [def.min, (def.min + def.max) / 2, def.max])
  const combos: number[][] = [[]]
  for (const values of seedValues) {
    const next: number[][] = []
    for (const combo of combos) for (const value of values) next.push([...combo, value])
    combos.length = 0
    combos.push(...next)
  }

  for (const combo of combos) {
    const angles: [number, number, number] = [...incoming]
    axes.forEach(({ index }, position) => { angles[index] = combo[position] })
    const seeded: Pose = { ...pose, [jointId]: clampJointAngles(jointId, angles) }
    const attempt = descendAim(seeded, jointId, target, tip, axes, iterations, tolerance)
    if (attempt.gap < best.gap - 1e-12) best = attempt
    if (best.gap <= tolerance) break
  }

  return best.pose
}

/** 关节表是不是「父在子之前」—— `forwardKinematics` 一遍循环的前提。 */
export function jointsAreTopologicallyOrdered() {
  const seen = new Set<JointId>()
  for (const joint of DIRECTOR_JOINTS) {
    if (joint.parent && !seen.has(joint.parent)) return false
    seen.add(joint.id)
  }
  return seen.size === JOINT_IDS.length
}

export function solveIk({
  pose,
  effector,
  links,
  target,
  iterations = 12,
  tolerance = 0.005,
}: SolveIkOptions): SolveIkResult {
  const next: Pose = { ...pose }
  if (!JOINT_BY_ID[effector]) {
    return { pose: next, distance: Number.POSITIVE_INFINITY, iterations: 0 }
  }
  const usableLinks = links.filter((id) => JOINT_BY_ID[id] && jointAxes(id).length > 0)
  let world = forwardKinematics(next)
  let distance = vecLength(vecSub(target, world[effector].position))
  let round = 0

  for (; round < iterations && distance > tolerance; round++) {
    for (const linkId of usableLinks) {
      const link = world[linkId]
      const effectorPos = world[effector].position
      const toEffector = vecNormalize(vecSub(effectorPos, link.position))
      const toTarget = vecNormalize(vecSub(target, link.position))
      if (vecLength(toEffector) < 1e-6 || vecLength(toTarget) < 1e-6) continue

      const current = clampJointAngles(linkId, next[linkId])
      let changed = false
      for (const { index } of jointAxes(linkId)) {
        const axis = worldAxis(link.parentRotation, index)
        if (vecLength(axis) < 1e-6) continue
        const deltaRad = signedAngleAround(axis, toEffector, toTarget)
        if (!Number.isFinite(deltaRad) || Math.abs(deltaRad) < 1e-6) continue
        // 世界转角 → 语义角度：符号规则只有 skeleton.axisEulerSign 一份
        const deltaDeg = (deltaRad * 180) / Math.PI * axisEulerSign(linkId, index)
        current[index] += deltaDeg
        changed = true
      }
      if (!changed) continue
      next[linkId] = clampJointAngles(linkId, current)
      world = forwardKinematics(next)
    }
    distance = vecLength(vecSub(target, world[effector].position))
  }

  return { pose: next, distance, iterations: round }
}
