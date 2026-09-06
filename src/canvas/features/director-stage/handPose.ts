/**
 * 手指姿势：一根滑杆管一根手指，加一套手势预设。
 *
 * 为什么不是每个指节一根滑杆：一只手 15 个指节、两只手 30 个，全摊开面板会有 30 行。
 * 而实际摆姿势时，手指几乎总是「整根一起卷」—— 逐节调是极少数情况，
 * 需要的时候可以先用参考图反推（那条路会写三节各自的真实角度），
 * 或者开「手指」工具在 3D 里拖指尖。
 *
 * ── 三条要留意的约定 ────────────────────────────────────────────────────────
 *
 * ① **真源是三节角度，不是滑杆值。** 滑杆只是个写入器：拖它就按下面的曲线一次写三节。
 *    显示值反过来从**中节**反算（中节的曲线系数正好是 1，反算最准）。
 *    所以参考图反推写完三节之后，滑杆会跟着动到一个近似值，两者不会打架。
 *
 * ② **弯曲角度落在 tilt 轴上**，不是 bend —— 理由见 skeleton.ts 文件头第 ⑤ 条。
 *    这里一律走 `clampJointAngles`，所以就算曲线算出越界值也不会摆出反关节。
 *
 * ③ **手势预设存的是 15 个关节的完整角度**，不是「整根卷曲 + 张开」两个数。
 *    两个数写不出拇指对掌（turn），握拳就会变成四指弯着、拇指支在旁边的爪子
 *    （用户 2026-08-27 截图）。预设必须把 bend / turn / tilt 都写上。
 */
import {
  FINGER_JOINT_IDS,
  FINGER_NAMES,
  JOINT_BY_ID,
  clampJointAngles,
  poseAngles,
  type FingerName,
  type JointId,
  type Pose,
  type Side,
} from './skeleton'

/** 滑杆范围。负数是反翘（手张开时指根会微微向后）。 */
export const FINGER_CURL_MIN = -25
export const FINGER_CURL_MAX = 100

/**
 * 三节的卷曲快慢。中节最快（系数 1）—— 握拳时中节确实弯得最狠，
 * 近节稍慢、远节居中，这样卷起来是自然的螺旋而不是三节一样弯的钩子。
 *
 * 每节的实际角度 = 滑杆比例 × 该节自己的上限 × 这个系数，
 * 所以拇指（上限和其它四指不同）不需要另写一套曲线。
 */
export const FINGER_CURL_PROFILE: readonly [number, number, number] = [0.85, 1, 0.9]

/** 这一节的弯曲角度（度）。滑杆 0 → 0，100 → 接近上限，负数按下限走。 */
export function segmentCurlAngle(jointId: JointId, curl: number, segment: 0 | 1 | 2): number {
  const range = JOINT_BY_ID[jointId]?.axes?.tilt
  if (!range) return 0
  const t = Math.min(FINGER_CURL_MAX, Math.max(FINGER_CURL_MIN, Number.isFinite(curl) ? curl : 0))
  if (t >= 0) return (t / FINGER_CURL_MAX) * range.max * FINGER_CURL_PROFILE[segment]
  // 反翘：按各节自己的下限走。中节下限是 0（解剖上不能反弯），所以它自然不动。
  return (-t / -FINGER_CURL_MIN) * range.min
}

/** 把一根手指整根卷到某个程度。一次写三节。 */
export function setFingerCurl(pose: Pose, side: Side, name: FingerName, curl: number): Pose {
  const ids = FINGER_JOINT_IDS[side][name]
  const next: Pose = { ...pose }
  ids.forEach((id, index) => {
    const angles = [...poseAngles(pose, id)] as [number, number, number]
    angles[2] = segmentCurlAngle(id, curl, index as 0 | 1 | 2)
    next[id] = clampJointAngles(id, angles)
  })
  return next
}

/**
 * 反过来读滑杆该显示多少。用中节算 —— 它的曲线系数是 1，反算不会被系数放大误差。
 * 中节被钳在 0 以上，所以负的反翘读近节。
 */
export function readFingerCurl(pose: Pose, side: Side, name: FingerName): number {
  const [proximal, middle] = FINGER_JOINT_IDS[side][name]
  const midRange = JOINT_BY_ID[middle]?.axes?.tilt
  const midAngle = poseAngles(pose, middle)[2]
  if (midRange && midRange.max > 0 && midAngle > 0.01) {
    return Math.round((midAngle / midRange.max) * FINGER_CURL_MAX)
  }
  const proxRange = JOINT_BY_ID[proximal]?.axes?.tilt
  const proxAngle = poseAngles(pose, proximal)[2]
  if (proxRange && proxAngle < -0.01 && proxRange.min < 0) {
    return Math.round((proxAngle / proxRange.min) * FINGER_CURL_MIN)
  }
  if (proxRange && proxRange.max > 0 && proxAngle > 0.01) {
    return Math.round((proxAngle / (proxRange.max * FINGER_CURL_PROFILE[0])) * FINGER_CURL_MAX)
  }
  return 0
}

/** 张开 / 合拢：只动近节的 bend 轴。 */
export function setFingerSpread(pose: Pose, side: Side, name: FingerName, spread: number): Pose {
  const id = FINGER_JOINT_IDS[side][name][0]
  const angles = [...poseAngles(pose, id)] as [number, number, number]
  angles[0] = spread
  return { ...pose, [id]: clampJointAngles(id, angles) }
}

export function readFingerSpread(pose: Pose, side: Side, name: FingerName): number {
  return Math.round(poseAngles(pose, FINGER_JOINT_IDS[side][name][0])[0])
}

/** 这只手的张开范围（近节 bend 的上下限）。界面照它出滑杆。 */
export function fingerSpreadRange(side: Side, name: FingerName): { min: number; max: number } {
  const range = JOINT_BY_ID[FINGER_JOINT_IDS[side][name][0]]?.axes?.bend
  return { min: range?.min ?? 0, max: range?.max ?? 0 }
}

/** 一节的 [bend, turn, tilt]（度）。预设按这个写，不再压成两个数。 */
export type HandPresetJoint = readonly [number, number, number]
export type HandPresetFingers = Record<FingerName, readonly [HandPresetJoint, HandPresetJoint, HandPresetJoint]>

export const HAND_PRESETS: ReadonlyArray<{ key: string; label: string; fingers: HandPresetFingers }> = [
  {
    key: 'relaxed', label: '自然',
    fingers: {
      thumb:  [[12, 10, 12], [0, 0, 16], [0, 0, 14]],
      index:  [[4, 0, 16], [0, 0, 22], [0, 0, 14]],
      middle: [[0, 0, 20], [0, 0, 28], [0, 0, 16]],
      ring:   [[4, 0, 24], [0, 0, 32], [0, 0, 18]],
      little: [[8, 0, 28], [0, 0, 36], [0, 0, 20]],
    },
  },
  {
    key: 'open', label: '张开',
    fingers: {
      thumb:  [[55, -6, 0], [0, 0, 0], [0, 0, 0]],
      index:  [[25, 0, 0], [0, 0, 0], [0, 0, 0]],
      middle: [[12, 0, 0], [0, 0, 0], [0, 0, 0]],
      ring:   [[20, 0, 0], [0, 0, 0], [0, 0, 0]],
      little: [[30, 0, 0], [0, 0, 0], [0, 0, 0]],
    },
  },
  {
    key: 'fist', label: '握拳',
    // 四指近节屈满、中节顶满、远节跟上。拇指 turn 负数才是对掌收到掌心
    // （正数是往外支，用户 2026-08-28 截图就是这个）。近节微合拢、少弯曲，
    // 让指腹盖在食指中节上，而不是再卷成爪子。
    fingers: {
      thumb:  [[-10, -40, -5], [0, 0, 8], [0, 0, 20]],
      index:  [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
      middle: [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
      ring:   [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
      little: [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
    },
  },
  {
    key: 'point', label: '指向',
    fingers: {
      thumb:  [[-8, -28, -4], [0, 0, 12], [0, 0, 16]],
      index:  [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      middle: [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
      ring:   [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
      little: [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
    },
  },
  {
    key: 'ok', label: 'OK',
    fingers: {
      thumb:  [[8, 30, 22], [0, 0, 44], [0, 0, 40]],
      index:  [[0, 0, 58], [0, 0, 88], [0, 0, 52]],
      middle: [[8, 0, 10], [0, 0, 12], [0, 0, 8]],
      ring:   [[12, 0, 8], [0, 0, 10], [0, 0, 6]],
      little: [[20, 0, 6], [0, 0, 8], [0, 0, 4]],
    },
  },
  {
    key: 'scissors', label: '剪刀',
    fingers: {
      thumb:  [[-6, -22, 0], [0, 0, 10], [0, 0, 12]],
      index:  [[22, 0, 0], [0, 0, 0], [0, 0, 0]],
      middle: [[-8, 0, 0], [0, 0, 0], [0, 0, 0]],
      ring:   [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
      little: [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
    },
  },
  {
    key: 'heart', label: '比心',
    fingers: {
      thumb:  [[10, 36, 20], [0, 0, 40], [0, 0, 42]],
      index:  [[0, 0, 44], [0, 0, 52], [0, 0, 40]],
      middle: [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
      ring:   [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
      little: [[-8, 0, 90], [0, 0, 110], [0, 0, 80]],
    },
  },
]

function writeFinger(
  pose: Pose,
  side: Side,
  name: FingerName,
  joints: readonly [HandPresetJoint, HandPresetJoint, HandPresetJoint],
): Pose {
  const ids = FINGER_JOINT_IDS[side][name]
  const next: Pose = { ...pose }
  ids.forEach((id, index) => {
    next[id] = clampJointAngles(id, joints[index])
  })
  return next
}

export function applyHandPreset(pose: Pose, side: Side, presetKey: string): Pose {
  const preset = HAND_PRESETS.find((item) => item.key === presetKey)
  if (!preset) return pose
  let next = pose
  for (const name of FINGER_NAMES) next = writeFinger(next, side, name, preset.fingers[name])
  return next
}

/** 把当前这只手 15 节拍成一份预设数据，给「存当前手」用。 */
export function snapshotHand(pose: Pose, side: Side): HandPresetFingers {
  const fingers = {} as Record<FingerName, [HandPresetJoint, HandPresetJoint, HandPresetJoint]>
  for (const name of FINGER_NAMES) {
    const ids = FINGER_JOINT_IDS[side][name]
    fingers[name] = [
      poseAngles(pose, ids[0]),
      poseAngles(pose, ids[1]),
      poseAngles(pose, ids[2]),
    ]
  }
  return fingers as HandPresetFingers
}

export function applyHandSnapshot(pose: Pose, side: Side, fingers: HandPresetFingers): Pose {
  let next = pose
  for (const name of FINGER_NAMES) next = writeFinger(next, side, name, fingers[name])
  return next
}

/** 清掉这只手的 15 个关节（回到静止的自然微屈）。 */
export function clearHand(pose: Pose, side: Side): Pose {
  const next: Pose = { ...pose }
  for (const name of FINGER_NAMES) {
    for (const id of FINGER_JOINT_IDS[side][name]) delete next[id]
  }
  return next
}

/** 这只手有几个指节被调过 —— 面板上显示「已调 N 处」。 */
export function handPoseCount(pose: Pose, side: Side): number {
  let count = 0
  for (const name of FINGER_NAMES) {
    for (const id of FINGER_JOINT_IDS[side][name]) if (pose[id]) count += 1
  }
  return count
}

export const FINGER_DISPLAY_NAMES: Record<FingerName, string> = {
  thumb: '拇指', index: '食指', middle: '中指', ring: '无名指', little: '小指',
}
