/**
 * 白模角色的骨架 —— 纯数据 + 纯函数，**不 import three**。
 *
 * 为什么自己写一份关节表：GitHub 上功能最全的 mannequin.js 是 GPL-3.0，前端包会随
 * 浏览器分发给用户，套它的代码会把整个 bundle 拖进 GPL。而它真正有价值的东西是
 * 「哪个关节允许转哪几个轴」—— 那是人体解剖事实和通用绑定惯例，不是可版权的代码。
 *
 * 三条设计约定，都是为了让姿势**可复现、可存库、可单测**：
 *
 * ① 姿势永远是 `[bend, turn, tilt]` 三个角度（度），存进节点 params 就是一串数字。
 *    每个关节自己声明哪几个轴可用 —— 肘和膝只有 bend，掰另外两个轴在解剖上不存在，
 *    界面上根本不出那两个滑杆，IK 也不许算出来。
 *
 * ② **语义符号统一**：正数一律是「向前 / 向左 / 向外」，左右两边用同一套数字和同一套
 *    上下限。右侧关节靠 `mirror` 在转 Euler 时把 turn/tilt 取反，膝盖这种反向弯的
 *    靠轴上的 `sign` 取反。这样「左臂抬 90」和「右臂抬 90」是对称的同一个数字。
 *
 * ③ **Euler 顺序固定为 YXZ**（先转、再弯、后侧倾）。Euler 角不同顺序算出来是不同姿势，
 *    不固定的话同一串数字换个地方渲染就变形了。
 *
 * 静止姿势（全 0）是自然站立：手臂垂下、腿直立。不是 T-pose —— 所以骨骼的静止朝向
 * 就是朝下的，`bend` 正数把手臂往前抬，`tilt` 正数把手臂往外张开。
 *
 * ④ **偏移不写死在这里，来自 mannequinRest.generated.ts**（由 tools/build_mannequin.py
 *    从 MakeHuman 的 CC0 网格算出）。蒙皮白模的骨和这张表用的是同一套数字 ——
 *    不然两者切换时姿势会跳，而且 IK 算出的手腕位置会和画面上的手对不上。
 *
 * ⑤ **手指的「弯曲」在 tilt 轴上，不是 bend** —— 这条反直觉，别去「修」它。
 *    弯曲是绕「横穿手掌」那根轴转的，而自然站立时手掌朝内（拇指朝前），
 *    横穿手掌的方向就是 Z，所以弯曲绕 Z = tilt、张开绕 X = bend。
 *    量过：MakeHuman 的手臂垂下后手掌自然就朝内，只差 2.7°；
 *    要改成「掌朝后」好让弯曲落在 bend 上，得强行扭 92.7°，前臂皮肤会被剪切坏。
 */

import { MANNEQUIN_REST_OFFSETS } from './mannequinRest.generated'

export type JointAxis = 'bend' | 'turn' | 'tilt'

/** 五根手指的名字。每根三节：1 近节（掌指）、2 中节、3 远节。 */
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'little'] as const
export type FingerName = (typeof FINGER_NAMES)[number]

export type Side = 'L' | 'R'
export type FingerJointId = `${FingerName}${1 | 2 | 3}${Side}`

export type JointId =
  | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'shoulderL' | 'upperArmL' | 'elbowL' | 'wristL'
  | 'shoulderR' | 'upperArmR' | 'elbowR' | 'wristR'
  | 'thighL' | 'kneeL' | 'ankleL'
  | 'thighR' | 'kneeR' | 'ankleR'
  | FingerJointId

export interface JointAxisDef {
  /** 面板上这个轴叫什么。躯干说「前后弯」，手臂说「抬起」，同一个 bend 两种说法。 */
  label: string
  min: number
  max: number
  /**
   * 语义方向和 Euler 方向不一致时取 -1。
   *
   * 会用到它的都是**静止朝下**的骨头（上臂 / 前臂 / 手 / 大腿）：绕 +X 正转会把朝下的
   * 骨头往**后**甩（右手定则：-Y → -Z），而这些关节的「前后抬 / 弯曲」正数在人话里
   * 都是往**前**。躯干那一路的骨头朝上，绕 +X 正转正好就是前弯，所以不用取反。
   *
   * 膝盖是个例外中的例外：小腿也朝下，但膝盖本来就只能往**后**弯，
   * 所以它反而不用取反。
   */
  sign?: 1 | -1
}

export interface JointShape {
  kind: 'capsule' | 'box' | 'sphere'
  /** capsule: [半径, 长度, _]；box: [x, y, z]；sphere: [半径, _, _] */
  size: [number, number, number]
  /** 相对本关节原点的位置（一般是往子关节方向挪半根） */
  offset: [number, number, number]
  /** 形状自身的旋转（弧度），用来把胶囊从默认竖直改成横着 */
  rotation?: [number, number, number]
  /**
   * 把默认竖直（+Y）的胶囊转到这个方向去。给的是**方向向量**而不是 Euler ——
   * Euler 还得约定顺序、容易和 three 的默认顺序打架，而方向向量没有歧义。
   */
  alignTo?: [number, number, number]
}

export interface JointDef {
  id: JointId
  parent: JointId | null
  /** 相对父关节原点的偏移 */
  offset: [number, number, number]
  /** 面板上关节自己的名字 */
  label: string
  axes: Partial<Record<JointAxis, JointAxisDef>>
  /** 右侧关节：转 Euler 时 turn / tilt 取反，好让两边共用同一套数字 */
  mirror?: boolean
  shape?: JointShape
  /** 点选用的小球半径 */
  handleRadius?: number
  /**
   * 「这节骨头指向哪个子关节」。默认取表里的第一个子关节 ——
   * 手腕有 5 个子关节（五根手指），第一个是拇指，可拇指不是手的朝向，
   * 所以手腕必须显式指到中指。漏了它 IK 和参考图反推都会按拇指方向算。
   */
  boneChild?: JointId
  /**
   * false = 默认不给点选小球。手上挤 30 个球既点不准也糊成一团。
   * 「手指」工具会另外建小号手柄，不改这个标记。
   */
  pickable?: boolean
}

/** 静止偏移。数字在生成文件里，这里只做取值 —— 缺 key 由 skeleton 的测试盯着。 */
const O = MANNEQUIN_REST_OFFSETS as Record<string, [number, number, number]>

/**
 * 沿骨头方向的胶囊：长度按骨长算、位置摆在半程、朝向对齐骨头。
 * 手臂腿和 30 根指骨都用它 —— 手调 49 个形状既费劲又会和偏移悄悄脱钩。
 */
function boneCapsule(childOffset: [number, number, number], radius: number): JointShape {
  const len = Math.hypot(childOffset[0], childOffset[1], childOffset[2])
  return {
    kind: 'capsule',
    size: [radius, Math.max(0.004, len - radius * 2), 0],
    offset: [childOffset[0] / 2, childOffset[1] / 2, childOffset[2] / 2],
    alignTo: childOffset,
  }
}

const AXIS_ORDER: JointAxis[] = ['bend', 'turn', 'tilt']

/**
 * 这一轴是不是整圈都能转。胯的左右转是 [-180, 180]，跨度正好 360。
 * 这种轴不该在 180 被夹死 —— Three 的欧拉角把 Y 解在 ±180，再夹一次就会
 * 绕过去又弹回来（用户 2026-08-28：「超过 180° 欧拉角」）。
 */
export function axisIsPeriodic(def: JointAxisDef | undefined): boolean {
  if (!def) return false
  return def.max - def.min >= 359.5
}

/**
 * 把角度绕进 [min, max]。180 和 -180 是同一朝向，优先留在更靠近输入的那一端，
 * 避免滑杆从 180 跳成 -180。
 */
export function wrapAxisAngle(value: number, min: number, max: number): number {
  const span = max - min
  if (!(span > 0) || !Number.isFinite(value)) return Number.isFinite(min) ? min : 0
  let t = (value - min) % span
  if (t < 0) t += span
  let wrapped = min + t
  if (Math.abs(wrapped - min) < 1e-9 && Math.abs(value - min) > span / 2) wrapped = max
  if (Math.abs(wrapped - max) < 1e-9 && Math.abs(value - max) > span / 2) wrapped = min
  return wrapped
}

/** 躯干那一路的轴名 */
const torsoAxes = (bend: [number, number], turn: [number, number], tilt: [number, number]) => ({
  bend: { label: '前后弯', min: bend[0], max: bend[1] },
  turn: { label: '左右转', min: turn[0], max: turn[1] },
  tilt: { label: '侧倾', min: tilt[0], max: tilt[1] },
})

/**
 * 手臂 / 腿根那一路的轴名。
 * bend 一律 sign:-1 —— 这几根骨头静止朝下，正数要表示「往前抬」就得反过来（见 JointAxisDef.sign）。
 */
const limbAxes = (raise: [number, number], twist: [number, number], straddle: [number, number]) => ({
  bend: { label: '前后抬', min: raise[0], max: raise[1], sign: -1 as const },
  turn: { label: '旋转', min: twist[0], max: twist[1] },
  tilt: { label: '外张', min: straddle[0], max: straddle[1] },
})

export const DIRECTOR_JOINTS: JointDef[] = [
  {
    id: 'hips', parent: null, offset: O.hips, label: '胯（整体）',
    axes: torsoAxes([-45, 45], [-180, 180], [-30, 30]),
    shape: { kind: 'box', size: [0.26, 0.17, 0.17], offset: [0, 0.045, 0] },
    handleRadius: 0.075,
  },
  {
    id: 'spine', parent: 'hips', offset: O.spine, label: '腰',
    axes: torsoAxes([-20, 45], [-35, 35], [-25, 25]),
    shape: { kind: 'box', size: [0.24, 0.25, 0.16], offset: [0, 0.123, 0] },
  },
  {
    id: 'chest', parent: 'spine', offset: O.chest, label: '胸',
    axes: torsoAxes([-15, 30], [-30, 30], [-20, 20]),
    shape: { kind: 'box', size: [0.32, 0.17, 0.19], offset: [0, 0.078, 0] },
    handleRadius: 0.07,
  },
  {
    id: 'neck', parent: 'chest', offset: O.neck, label: '颈',
    axes: torsoAxes([-20, 25], [-35, 35], [-25, 25]),
    shape: boneCapsule(O.head, 0.045),
    handleRadius: 0.045,
  },
  {
    id: 'head', parent: 'neck', offset: O.head, label: '头',
    axes: {
      bend: { label: '点头', min: -35, max: 40 },
      turn: { label: '左右转', min: -60, max: 60 },
      tilt: { label: '侧倾', min: -35, max: 35 },
    },
    // 头顶正好落在 1.666m（网格最高点）：0.062 + 0.09
    shape: { kind: 'sphere', size: [0.09, 0, 0], offset: [0, 0.062, 0.012] },
    handleRadius: 0.06,
  },

  // ── 左臂：静止朝下，bend 正数往前抬，tilt 正数往外张 ──────────────────────
  {
    id: 'shoulderL', parent: 'chest', offset: O.shoulderL, label: '左肩',
    axes: {
      bend: { label: '前后', min: -15, max: 25 },
      turn: { label: '旋转', min: -10, max: 10 },
      tilt: { label: '上提', min: -10, max: 25 },
    },
    shape: boneCapsule(O.upperArmL, 0.042),
    handleRadius: 0.048,
  },
  {
    id: 'upperArmL', parent: 'shoulderL', offset: O.upperArmL, label: '左上臂',
    axes: limbAxes([-45, 170], [-90, 90], [-25, 165]),
    shape: boneCapsule(O.elbowL, 0.041),
    handleRadius: 0.05,
  },
  {
    id: 'elbowL', parent: 'upperArmL', offset: O.elbowL, label: '左肘',
    axes: { bend: { label: '弯曲', min: 0, max: 150, sign: -1 } },
    shape: boneCapsule(O.wristL, 0.035),
    handleRadius: 0.044,
  },
  {
    id: 'wristL', parent: 'elbowL', offset: O.wristL, label: '左手',
    axes: {
      bend: { label: '前后弯', min: -70, max: 70, sign: -1 },
      turn: { label: '旋转', min: -90, max: 90 },
      tilt: { label: '侧偏', min: -25, max: 25 },
    },
    // 掌心朝内（拇指朝前），所以手掌是「X 薄、Z 宽」——别按老样子写成 X 宽
    shape: { kind: 'box', size: [0.028, 0.096, 0.075], offset: [0, -0.048, 0.004] },
    handleRadius: 0.04,
    boneChild: 'middle1L',
  },

  // ── 右臂：偏移镜像，角度数字和左边完全一样（mirror 负责取反）────────────────
  {
    id: 'shoulderR', parent: 'chest', offset: O.shoulderR, label: '右肩', mirror: true,
    axes: {
      bend: { label: '前后', min: -15, max: 25 },
      turn: { label: '旋转', min: -10, max: 10 },
      tilt: { label: '上提', min: -10, max: 25 },
    },
    shape: boneCapsule(O.upperArmR, 0.042),
    handleRadius: 0.048,
  },
  {
    id: 'upperArmR', parent: 'shoulderR', offset: O.upperArmR, label: '右上臂', mirror: true,
    axes: limbAxes([-45, 170], [-90, 90], [-25, 165]),
    shape: boneCapsule(O.elbowR, 0.041),
    handleRadius: 0.05,
  },
  {
    id: 'elbowR', parent: 'upperArmR', offset: O.elbowR, label: '右肘', mirror: true,
    axes: { bend: { label: '弯曲', min: 0, max: 150, sign: -1 } },
    shape: boneCapsule(O.wristR, 0.035),
    handleRadius: 0.044,
  },
  {
    id: 'wristR', parent: 'elbowR', offset: O.wristR, label: '右手', mirror: true,
    axes: {
      bend: { label: '前后弯', min: -70, max: 70, sign: -1 },
      turn: { label: '旋转', min: -90, max: 90 },
      tilt: { label: '侧偏', min: -25, max: 25 },
    },
    shape: { kind: 'box', size: [0.028, 0.096, 0.075], offset: [0, -0.048, 0.004] },
    handleRadius: 0.04,
    boneChild: 'middle1R',
  },

  // ── 左腿 ────────────────────────────────────────────────────────────────
  {
    id: 'thighL', parent: 'hips', offset: O.thighL, label: '左大腿',
    axes: limbAxes([-30, 120], [-45, 45], [-15, 55]),
    shape: boneCapsule(O.kneeL, 0.056),
    handleRadius: 0.058,
  },
  {
    id: 'kneeL', parent: 'thighL', offset: O.kneeL, label: '左膝',
    // 小腿朝下，绕 +X 正转正好是往后甩 —— 膝盖只能往后弯，所以这里**不**取反
    axes: { bend: { label: '弯曲', min: 0, max: 150 } },
    shape: boneCapsule(O.ankleL, 0.046),
    handleRadius: 0.05,
  },
  {
    id: 'ankleL', parent: 'kneeL', offset: O.ankleL, label: '左脚',
    axes: {
      bend: { label: '绷/勾', min: -35, max: 45 },
      turn: { label: '内外转', min: -20, max: 20 },
      tilt: { label: '侧翻', min: -20, max: 20 },
    },
    // 实测网格的脚：长 24.3cm、宽 9.6cm、高 9.9cm，盒子正好贴地。
    // 这个 offset 同时也是脚的**骨向**（脚是叶关节，jointTipLocal 退回形状偏移）——
    // 水平以下 16.7°，和真实脚背一致。写陡了参考图反推会把脚踝解出十几度的假角度。
    shape: { kind: 'box', size: [0.096, 0.099, 0.243], offset: [0, -0.022, 0.071] },
    handleRadius: 0.045,
  },

  // ── 右腿 ────────────────────────────────────────────────────────────────
  {
    id: 'thighR', parent: 'hips', offset: O.thighR, label: '右大腿', mirror: true,
    axes: limbAxes([-30, 120], [-45, 45], [-15, 55]),
    shape: boneCapsule(O.kneeR, 0.056),
    handleRadius: 0.058,
  },
  {
    id: 'kneeR', parent: 'thighR', offset: O.kneeR, label: '右膝', mirror: true,
    axes: { bend: { label: '弯曲', min: 0, max: 150 } },
    shape: boneCapsule(O.ankleR, 0.046),
    handleRadius: 0.05,
  },
  {
    id: 'ankleR', parent: 'kneeR', offset: O.ankleR, label: '右脚', mirror: true,
    axes: {
      bend: { label: '绷/勾', min: -35, max: 45 },
      turn: { label: '内外转', min: -20, max: 20 },
      tilt: { label: '侧翻', min: -20, max: 20 },
    },
    shape: { kind: 'box', size: [0.096, 0.099, 0.243], offset: [0, -0.022, 0.071] },
    handleRadius: 0.045,
  },
]

// ── 手指：五根 × 三节 × 左右 = 30 个关节 ─────────────────────────────────────
//
// 弯曲在 **tilt** 轴上，不是 bend —— 理由见文件头第 ⑤ 条，别去「修」它。
// 近节额外给一个「张开」（bend 轴），拇指的近节再加一个旋转（对掌）。
// 偏移和形状全从生成的静止偏移里算：30 根指骨手调不现实，也不该和网格脱钩。
//
// 用循环生成而不是写 30 个字面量，是为了让「左右完全对称」由构造保证 ——
// 骨架测试里那条「左右对应关节的上下限完全一样」不可能再被手误破掉。

const FINGER_LABELS: Record<FingerName, string> = {
  thumb: '拇指', index: '食指', middle: '中指', ring: '无名指', little: '小指',
}
const SEGMENT_LABELS = ['近节', '中节', '远节'] as const

/** [向内合拢, 向外张开, 张开方向的符号]。食指侧在 +Z、小指侧在 −Z —— 两只手都一样，
 *  所以张开落在 bend 轴上正好不用 mirror（mirror 只翻 turn / tilt）。 */
const FINGER_SPREAD: Record<FingerName, [number, number, 1 | -1]> = {
  thumb: [-10, 55, -1],
  index: [-8, 25, -1],
  middle: [-8, 12, -1],
  ring: [-8, 20, 1],
  little: [-8, 30, 1],
}

/** 三节的胶囊半径，从近到远收细。 */
const FINGER_RADIUS: Record<FingerName, [number, number, number]> = {
  thumb: [0.011, 0.010, 0.009],
  index: [0.009, 0.008, 0.0075],
  middle: [0.009, 0.008, 0.0075],
  ring: [0.0085, 0.0075, 0.007],
  little: [0.008, 0.007, 0.0065],
}

/** 弯曲范围：近节能微微反翘，中节纯屈（反翘在解剖上不存在），远节小幅反翘。 */
const CURL_RANGE: Record<1 | 2 | 3, [number, number]> = { 1: [-25, 90], 2: [0, 110], 3: [-10, 80] }
/** 拇指三节是掌骨 / 近节 / 远节，活动范围和其它四指不同。 */
const THUMB_CURL: Record<1 | 2 | 3, [number, number]> = { 1: [-15, 45], 2: [0, 60], 3: [-10, 80] }

for (const side of ['L', 'R'] as const) {
  for (const name of FINGER_NAMES) {
    for (const seg of [1, 2, 3] as const) {
      const id = `${name}${seg}${side}` as JointId
      const parent = (seg === 1 ? `wrist${side}` : `${name}${seg - 1}${side}`) as JointId
      const [curlMin, curlMax] = (name === 'thumb' ? THUMB_CURL : CURL_RANGE)[seg]
      const axes: Partial<Record<JointAxis, JointAxisDef>> = {}
      if (seg === 1) {
        const [inward, outward, spreadSign] = FINGER_SPREAD[name]
        axes.bend = { label: '张开', min: inward, max: outward, sign: spreadSign }
        if (name === 'thumb') axes.turn = { label: '对掌旋转', min: -40, max: 40 }
      }
      axes.tilt = { label: '弯曲', min: curlMin, max: curlMax, sign: -1 }
      // 远节没有子关节，形状就顺着自己这一节再伸出去 8 成
      const own = O[id]
      const tip = seg === 3
        ? ([own[0] * 0.8, own[1] * 0.8, own[2] * 0.8] as [number, number, number])
        : O[`${name}${seg + 1}${side}`]
      DIRECTOR_JOINTS.push({
        id,
        parent,
        offset: own,
        label: `${side === 'L' ? '左' : '右'}${FINGER_LABELS[name]}${SEGMENT_LABELS[seg - 1]}`,
        axes,
        ...(side === 'R' ? { mirror: true } : {}),
        shape: boneCapsule(tip, FINGER_RADIUS[name][seg - 1]),
        pickable: false,
      })
    }
  }
}

/** 每只手的 15 个关节，按「近→中→远」排。手指界面和手势预设都用它。 */
export const FINGER_JOINT_IDS: Record<Side, Record<FingerName, [JointId, JointId, JointId]>> = {
  L: {} as Record<FingerName, [JointId, JointId, JointId]>,
  R: {} as Record<FingerName, [JointId, JointId, JointId]>,
}
for (const side of ['L', 'R'] as const) {
  for (const name of FINGER_NAMES) {
    FINGER_JOINT_IDS[side][name] = [
      `${name}1${side}` as JointId, `${name}2${side}` as JointId, `${name}3${side}` as JointId,
    ]
  }
}

/** 这个关节是不是指骨。手指不进通用关节树、不出点选球，几处地方都要判。 */
export function isFingerJoint(id: JointId): boolean {
  return FINGER_NAMES.some((name) => id.startsWith(name))
}

export const JOINT_BY_ID: Record<JointId, JointDef> = Object.fromEntries(
  DIRECTOR_JOINTS.map((joint) => [joint.id, joint]),
) as Record<JointId, JointDef>

export const JOINT_IDS: JointId[] = DIRECTOR_JOINTS.map((joint) => joint.id)

/** 姿势：关节 → [bend, turn, tilt]（度）。缺的关节按 0 处理。 */
export type Pose = Partial<Record<JointId, [number, number, number]>>

export function isJointId(value: unknown): value is JointId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(JOINT_BY_ID, value)
}

function finite(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

/**
 * 把一组角度收拾干净：**关节没有的轴一律归零**，有的轴钳到上下限。
 *
 * 这是整个姿势系统的守门人 —— 滑杆、旋转手柄、IK 三条输入路径都必须过它，
 * 否则 IK 能把肘关节算出一个解剖上不存在的侧倾，姿势看起来就断了。
 */
export function clampJointAngles(jointId: JointId, angles: unknown): [number, number, number] {
  const joint = JOINT_BY_ID[jointId]
  const input = Array.isArray(angles) ? angles : []
  const out: [number, number, number] = [0, 0, 0]
  if (!joint) return out
  AXIS_ORDER.forEach((axis, index) => {
    const def = joint.axes[axis]
    if (!def) return
    const value = finite(input[index])
    out[index] = axisIsPeriodic(def)
      ? wrapAxisAngle(value, def.min, def.max)
      : Math.min(def.max, Math.max(def.min, value))
  })
  return out
}

/** 这个关节允许调哪几个轴（按 bend / turn / tilt 顺序），界面照这个出滑杆。 */
export function jointAxes(jointId: JointId): Array<{ axis: JointAxis; index: number; def: JointAxisDef }> {
  const joint = JOINT_BY_ID[jointId]
  if (!joint) return []
  return AXIS_ORDER
    .map((axis, index) => ({ axis, index, def: joint.axes[axis] }))
    .filter((entry): entry is { axis: JointAxis; index: number; def: JointAxisDef } => Boolean(entry.def))
}

/** 静止姿势：全 0 就是自然站立（手臂垂下、腿直立），所以这里返回空对象即可。 */
export function defaultPose(): Pose {
  return {}
}

export function poseAngles(pose: Pose | undefined, jointId: JointId): [number, number, number] {
  return clampJointAngles(jointId, pose?.[jointId])
}

/**
 * 某个轴上「语义角度」和「Euler 角度」之间的符号关系（±1）。
 *
 * 只有两处会取反，都收在这个函数里：
 *   · 轴上的 `sign`：膝盖「弯曲」是往后弯，Euler 上是负的；
 *   · 关节上的 `mirror`：右侧的 turn / tilt 取反，好让左右用同一套数字。
 *
 * 单独抽出来是因为 IK 要走反方向 —— 它算出的是世界空间的转角，得除回语义空间。
 * 两边各写一遍符号规则的话，IK 会把右臂往反方向掰。
 */
export function axisEulerSign(jointId: JointId, axisIndex: number): 1 | -1 {
  const joint = JOINT_BY_ID[jointId]
  const axis = AXIS_ORDER[axisIndex]
  if (!joint || !axis) return 1
  const sign = joint.axes[axis]?.sign ?? 1
  // mirror 只影响 turn / tilt：bend 是前后，左右两边同向。
  const mirror = joint.mirror && axis !== 'bend' ? -1 : 1
  return (sign * mirror) as 1 | -1
}

/**
 * 把一次拖动的欧拉差加到拖之前的语义角上。
 *
 * `from` / `to` 是 three 的 YXZ 欧拉（弧度）。周期轴（胯的左右转）走最短弧，
 * 这样 179° → -179° 是 +2°，而不是被拆成 -358° 再钳死。
 */
export function applyEulerDelta(
  jointId: JointId,
  start: [number, number, number],
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): [number, number, number] {
  const next: [number, number, number] = [...start]
  const current = [to.x, to.y, to.z]
  const previous = [from.x, from.y, from.z]
  const deg = 180 / Math.PI
  for (const { index, def } of jointAxes(jointId)) {
    let delta = (current[index] - previous[index]) * deg * axisEulerSign(jointId, index)
    if (axisIsPeriodic(def) || Math.abs(delta) > 180) {
      delta = ((delta + 180) % 360 + 360) % 360 - 180
    }
    next[index] += delta
  }
  return clampJointAngles(jointId, next)
}

/** 语义角度 → three 的 Euler（弧度，顺序 YXZ）。 */
export function eulerForJoint(jointId: JointId, angles: unknown): [number, number, number] {
  const clamped = clampJointAngles(jointId, angles)
  const deg = Math.PI / 180
  return [
    clamped[0] * axisEulerSign(jointId, 0) * deg,
    clamped[1] * axisEulerSign(jointId, 1) * deg,
    clamped[2] * axisEulerSign(jointId, 2) * deg,
  ]
}

/** 固定的 Euler 顺序。不固定的话同一串角度换个渲染顺序就是另一个姿势。 */
export const JOINT_EULER_ORDER = 'YXZ' as const

/** 从关节往上走到根，返回 [自己, 父, …, hips]。IK 链和界面上的关节树都用它。 */
export function jointChainToRoot(jointId: JointId): JointId[] {
  const chain: JointId[] = []
  let current: JointId | null = jointId
  while (current && JOINT_BY_ID[current]) {
    chain.push(current)
    current = JOINT_BY_ID[current].parent
  }
  return chain
}

/** 拖手脚时参与解算的那几节。手腕带上肘和上臂，脚踝带上膝和大腿 —— 不动躯干。 */
export const IK_CHAINS: Record<string, { effector: JointId; links: JointId[] }> = {
  wristL: { effector: 'wristL', links: ['elbowL', 'upperArmL'] },
  wristR: { effector: 'wristR', links: ['elbowR', 'upperArmR'] },
  ankleL: { effector: 'ankleL', links: ['kneeL', 'thighL'] },
  ankleR: { effector: 'ankleR', links: ['kneeR', 'thighR'] },
}

/**
 * 拖指尖时参与解算的那几节。每根手指三节：远节当末端，近/中节当链。
 * 不动手腕 —— 手腕归「拖手脚」，手指工具只拧这根手指。
 */
export const FINGER_IK_CHAINS: Record<string, { effector: JointId; links: JointId[] }> = (() => {
  const out: Record<string, { effector: JointId; links: JointId[] }> = {}
  for (const side of ['L', 'R'] as const) {
    for (const name of FINGER_NAMES) {
      const [proximal, middle, distal] = FINGER_JOINT_IDS[side][name]
      out[distal] = { effector: distal, links: [middle, proximal] }
    }
  }
  return out
})()

export function ikChainFor(jointId: JointId) {
  return IK_CHAINS[jointId]
}

export function fingerIkChainFor(jointId: JointId) {
  if (FINGER_IK_CHAINS[jointId]) return FINGER_IK_CHAINS[jointId]
  if (!isFingerJoint(jointId)) return undefined
  const name = FINGER_NAMES.find((item) => jointId.startsWith(item))
  const side: Side | undefined = jointId.endsWith('L') ? 'L' : jointId.endsWith('R') ? 'R' : undefined
  if (!name || !side) return undefined
  return FINGER_IK_CHAINS[FINGER_JOINT_IDS[side][name][2]]
}
