/**
 * 拖手脚自动带动手臂（2026-08-26 用户选的第三种姿势操作方式）。
 *
 * 这里同时测正向运动学，因为 IK 的收敛断言必须靠 FK 才能验证 ——
 * 「末端离目标够近」只有拿到世界坐标才说得出来。
 *
 * 最重要的一条是「IK 也得守关节自由度」：CCD 每一步都要过 clampJointAngles，
 * 否则它会为了够到目标点把肘关节掰出侧倾、把膝盖反向折。这类工具最常见的崩坏就是这个，
 * 而且在截图上很难一眼看出是哪个关节坏了。
 */
import { describe, expect, it } from 'vitest'

const {
  aimGapRad,
  aimJoint,
  forwardKinematics,
  jointBoneDirection,
  jointTipLocal,
  solveIk,
  mat3FromEulerYXZ,
  mat3Identity,
  mat3Mul,
  mat3Apply,
  vecLength,
  vecSub,
  vecNormalize,
} = await import('@/features/director-stage/ik')
const { FINGER_IK_CHAINS, IK_CHAINS, clampJointAngles, jointAxes } = await import('@/features/director-stage/skeleton')

const dist = (a: [number, number, number], b: [number, number, number]) => vecLength(vecSub(a, b))

describe('矩阵与向量', () => {
  it('单位矩阵不改变向量', () => {
    expect(mat3Apply(mat3Identity(), [1, 2, 3])).toEqual([1, 2, 3])
  })

  it('绕 X 转 90° 把 +Y 转到 +Z', () => {
    const m = mat3FromEulerYXZ(Math.PI / 2, 0, 0)
    const v = mat3Apply(m, [0, 1, 0])
    expect(v[0]).toBeCloseTo(0, 9)
    expect(v[1]).toBeCloseTo(0, 9)
    expect(v[2]).toBeCloseTo(1, 9)
  })

  it('绕 Y 转 90° 把 +Z 转到 +X', () => {
    const v = mat3Apply(mat3FromEulerYXZ(0, Math.PI / 2, 0), [0, 0, 1])
    expect(v[0]).toBeCloseTo(1, 9)
    expect(v[2]).toBeCloseTo(0, 9)
  })

  it('顺序是 YXZ（R = Ry·Rx·Rz），不是别的顺序', () => {
    const composed = mat3FromEulerYXZ(0.3, 0.7, -0.4)
    const manual = mat3Mul(
      mat3Mul(mat3FromEulerYXZ(0, 0.7, 0), mat3FromEulerYXZ(0.3, 0, 0)),
      mat3FromEulerYXZ(0, 0, -0.4),
    )
    composed.forEach((value, index) => expect(value).toBeCloseTo(manual[index], 12))
  })

  it('零向量归一化不产生 NaN', () => {
    expect(vecNormalize([0, 0, 0])).toEqual([0, 0, 0])
  })
})

describe('正向运动学', () => {
  it('静止姿势：白模站在地面上，脚踝贴近 y=0，头在 1.4m 以上', () => {
    const world = forwardKinematics({})
    expect(world.ankleL.position[1]).toBeGreaterThanOrEqual(0)
    expect(world.ankleL.position[1]).toBeLessThan(0.12)
    expect(world.head.position[1]).toBeGreaterThan(1.4)
  })

  it('静止姿势左右对称：同名关节的 x 互为负数，y/z 相同', () => {
    const world = forwardKinematics({})
    for (const id of ['shoulder', 'upperArm', 'elbow', 'wrist', 'thigh', 'knee', 'ankle'] as const) {
      const left = world[`${id}L`].position
      const right = world[`${id}R`].position
      expect(right[0]).toBeCloseTo(-left[0], 9)
      expect(right[1]).toBeCloseTo(left[1], 9)
      expect(right[2]).toBeCloseTo(left[2], 9)
    }
  })

  it('静止姿势手臂是垂下的（不是 T-pose）：手腕明显低于肩', () => {
    const world = forwardKinematics({})
    expect(world.wristL.position[1]).toBeLessThan(world.shoulderL.position[1] - 0.4)
    /*
     * 「没有横着张开」要跟 upperArmL 比，不能跟 shoulderL 比 ——
     * shoulderL 是**锁骨根**，贴着胸骨（x≈0.027），真正的肩关节是 upperArmL（x≈0.168）。
     * 拿锁骨根当探针的话，一条完全垂直的手臂也会显示出 14cm 的「横向偏移」。
     */
    expect(Math.abs(world.wristL.position[0] - world.upperArmL.position[0])).toBeLessThan(0.02)
  })

  it('「外张 90」把手腕甩到身体外侧', () => {
    const rest = forwardKinematics({})
    const spread = forwardKinematics({ upperArmL: [0, 0, 90] })
    expect(spread.wristL.position[0]).toBeGreaterThan(rest.wristL.position[0] + 0.3)
  })

  it('两侧同样的「外张 90」各自朝自己那一侧（镜像没写反）', () => {
    const world = forwardKinematics({ upperArmL: [0, 0, 90], upperArmR: [0, 0, 90] })
    expect(world.wristL.position[0]).toBeGreaterThan(0.3)
    expect(world.wristR.position[0]).toBeLessThan(-0.3)
  })

  it('「前后抬 90」把手腕甩到身体前方（+Z）', () => {
    const world = forwardKinematics({ upperArmL: [90, 0, 0] })
    expect(world.wristL.position[2]).toBeGreaterThan(0.3)
  })

  it('膝盖弯曲把脚踝往后带（-Z），不是往前', () => {
    const rest = forwardKinematics({})
    const bent = forwardKinematics({ kneeL: [90, 0, 0] })
    expect(bent.ankleL.position[2]).toBeLessThan(rest.ankleL.position[2] - 0.2)
    expect(bent.ankleL.position[1]).toBeGreaterThan(rest.ankleL.position[1])
  })

  it('转胯会带着整个人转（子关节全部跟着走）', () => {
    const rest = forwardKinematics({})
    const world = forwardKinematics({ hips: [0, 90, 0] })
    // 「左转 90」= 面朝从 +Z 转到 +X，原本在 +X 的左肩因此落到 -Z。
    // 探针用 upperArmL（真正的肩关节，离身体中轴 17cm）而不是 shoulderL（锁骨根，贴中轴），
    // 后者离轴才 2.7cm，转 90° 也只挪 2.7cm，测不出「带着整个人转」这件事。
    expect(world.upperArmL.position[2]).toBeLessThan(-0.1)
    expect(Math.abs(world.upperArmL.position[0])).toBeLessThan(0.02)
    // 高度不变 —— 转的是 Y 轴
    expect(world.upperArmL.position[1]).toBeCloseTo(rest.upperArmL.position[1], 9)
  })

  it('姿势为 undefined 时等于静止姿势，不抛', () => {
    expect(forwardKinematics(undefined).head.position).toEqual(forwardKinematics({}).head.position)
  })
})

describe('CCD 收敛', () => {
  it('目标在手臂可达范围内 → 手腕收敛到目标附近', () => {
    const chain = IK_CHAINS.wristL
    const target: [number, number, number] = [0.45, 1.15, 0.35]
    const result = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target, iterations: 24 })
    expect(result.distance).toBeLessThan(0.05)
    expect(dist(forwardKinematics(result.pose).wristL.position, target)).toBeCloseTo(result.distance, 6)
  })

  it('比不解算明显更近（证明它真的在干活，不是原地返回）', () => {
    const chain = IK_CHAINS.wristL
    const target: [number, number, number] = [0.45, 1.15, 0.35]
    const before = dist(forwardKinematics({}).wristL.position, target)
    const after = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target, iterations: 24 }).distance
    expect(after).toBeLessThan(before * 0.35)
  })

  it('目标够不到（远在天边）→ 朝目标伸直，不抽风', () => {
    const chain = IK_CHAINS.wristL
    const target: [number, number, number] = [40, 1.2, 0]
    const result = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target, iterations: 24 })
    const world = forwardKinematics(result.pose)
    // 手臂应当基本成一条直线（肘几乎不弯）
    expect(clampJointAngles('elbowL', result.pose.elbowL)[0]).toBeLessThan(20)
    // 而且是朝着目标那一侧伸的
    expect(world.wristL.position[0]).toBeGreaterThan(world.shoulderL.position[0] + 0.3)
    expect(Number.isFinite(result.distance)).toBe(true)
  })

  it('脚踝那条链一样能收敛', () => {
    const chain = IK_CHAINS.ankleR
    const target: [number, number, number] = [-0.3, 0.35, 0.35]
    const result = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target, iterations: 24 })
    expect(result.distance).toBeLessThan(0.08)
  })

  it('已经在目标上时一轮都不迭代', () => {
    const chain = IK_CHAINS.wristL
    const target = forwardKinematics({}).wristL.position
    const result = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target })
    expect(result.iterations).toBe(0)
  })

  it('食指指尖那条链能把远节拖近目标，且不拧手腕', () => {
    const chain = FINGER_IK_CHAINS.index3L
    const rest = forwardKinematics({})
    const target: [number, number, number] = [
      rest.index3L.position[0] + 0.02,
      rest.index3L.position[1] + 0.01,
      rest.index3L.position[2] + 0.03,
    ]
    const before = dist(rest.index3L.position, target)
    const result = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target, iterations: 24 })
    expect(result.distance).toBeLessThan(before * 0.6)
    expect(result.pose.wristL).toBeUndefined()
  })
})

describe('IK 必须守关节自由度', () => {
  const HARD_TARGETS: Array<[number, number, number]> = [
    [0.6, 1.5, 0.5], [-0.9, 0.2, -0.6], [0.1, 1.9, -0.4], [0.8, 0.4, 0.9], [0, 0.1, 0.8],
  ]

  it('不管目标在哪，肘 / 膝永远只有 bend 非零', () => {
    for (const key of ['wristL', 'wristR', 'ankleL', 'ankleR'] as const) {
      const chain = IK_CHAINS[key]
      for (const target of HARD_TARGETS) {
        const { pose } = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target, iterations: 24 })
        for (const [jointId, angles] of Object.entries(pose)) {
          if (!/^(elbow|knee)[LR]$/.test(jointId)) continue
          expect(angles[1], `${jointId} 被 IK 掰出了 turn`).toBe(0)
          expect(angles[2], `${jointId} 被 IK 掰出了 tilt`).toBe(0)
        }
      }
    }
  })

  it('不管目标在哪，所有关节都在自己的上下限之内', () => {
    for (const key of ['wristL', 'wristR', 'ankleL', 'ankleR'] as const) {
      const chain = IK_CHAINS[key]
      for (const target of HARD_TARGETS) {
        const { pose } = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target, iterations: 24 })
        for (const [jointId, angles] of Object.entries(pose)) {
          const id = jointId as 'elbowL'
          for (const { index, def } of jointAxes(id)) {
            expect(angles[index], `${jointId} 的第 ${index} 轴越界`).toBeGreaterThanOrEqual(def.min)
            expect(angles[index], `${jointId} 的第 ${index} 轴越界`).toBeLessThanOrEqual(def.max)
          }
        }
      }
    }
  })

  it('膝盖不会被 IK 反向折（min 是 0）', () => {
    const chain = IK_CHAINS.ankleL
    for (const target of HARD_TARGETS) {
      const { pose } = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target, iterations: 24 })
      expect(clampJointAngles('kneeL', pose.kneeL)[0]).toBeGreaterThanOrEqual(0)
    }
  })

  it('只动链上的关节，躯干和另一侧一个字都不改', () => {
    const chain = IK_CHAINS.wristL
    const { pose } = solveIk({ pose: {}, effector: chain.effector, links: chain.links, target: [0.5, 1.4, 0.3], iterations: 24 })
    const touched = Object.keys(pose)
    for (const id of touched) expect(chain.links).toContain(id)
  })

  it('传进来的原始姿势对象不被改（调用方还拿着它做撤销/对比）', () => {
    const original = { chest: [10, 0, 0] as [number, number, number] }
    const snapshot = JSON.stringify(original)
    solveIk({ pose: original, effector: 'wristL', links: IK_CHAINS.wristL.links, target: [0.5, 1.4, 0.3] })
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('末端不认识 / 链是空的时候不抛', () => {
    expect(() => solveIk({ pose: {}, effector: 'nope' as 'wristL', links: [], target: [0, 0, 0] })).not.toThrow()
    expect(() => solveIk({ pose: {}, effector: 'wristL', links: [], target: [0, 0, 0] })).not.toThrow()
  })
})

/*
 * ────────────────────────────────────────────────────────────────────────────
 * aimJoint：「把这节骨头转到指向某个方向」
 *
 * 「从参考图分析姿势」靠它。它被**直接**用在 spine / neck / head / wrist / ankle 上
 * （这些没有多起点搜索兜着），所以它自己必须稳。
 *
 * 这一组断言是补上真实事故的：第一版三个轴从同一个快照一起改，输入方向差最后一两位
 * （0.49999999999999994 vs 0.4999999999999998），一个收敛到 2.5° 内、另一个飞到
 * 三轴顶死、差 80°。关键点是浮点算出来的，上游模型版本 / 浏览器 / CPU 都可能让末位不同 ——
 * 一个会被末位左右的解算器等于每次分析都在抽奖。
 * ────────────────────────────────────────────────────────────────────────────
 */
describe('aimJoint 把骨头转到指定朝向', () => {
  const gapDeg = (pose: Record<string, unknown>, jointId: string, target: [number, number, number]) =>
    (aimGapRad(pose as never, jointId as never, vecNormalize(target)) * 180) / Math.PI

  it('够得到的方向就转到位', () => {
    // 上臂静止朝下（-Y），让它指向角色左侧（+X）—— 靠「外张」就能到
    const pose = aimJoint({ pose: {}, jointId: 'upperArmL', direction: [1, 0, 0] })
    expect(gapDeg(pose, 'upperArmL', [1, 0, 0])).toBeLessThan(1)
  })

  it('★ 单调收敛：迭代多少轮都不会比少轮更差', () => {
    const target: [number, number, number] = [0.5, 0.15, 0.85]
    let previous = Number.POSITIVE_INFINITY
    for (const iterations of [1, 2, 4, 8, 12, 20]) {
      const pose = aimJoint({ pose: {}, jointId: 'upperArmL', direction: target, iterations })
      const gap = gapDeg(pose, 'upperArmL', target)
      expect(gap, `迭代 ${iterations} 轮反而变差了：${previous.toFixed(3)} → ${gap.toFixed(3)}`)
        .toBeLessThanOrEqual(previous + 1e-6)
      previous = gap
    }
    expect(previous).toBeLessThan(3)
  })

  it('★ 对末位级的输入扰动稳定（这是当初 80° 那个 bug 的直接成因）', () => {
    const base: [number, number, number] = [0.5, 0.15038373318043527, 0.8528685319524433]
    const nudged: [number, number, number] = [0.4999999999999998, 0.1503837331804353, 0.8528685319524433]
    const a = clampJointAngles('upperArmL', aimJoint({ pose: {}, jointId: 'upperArmL', direction: base }).upperArmL)
    const b = clampJointAngles('upperArmL', aimJoint({ pose: {}, jointId: 'upperArmL', direction: nudged }).upperArmL)
    for (const [index, value] of a.entries()) {
      expect(Math.abs(value - b[index]), `轴${index}：${value} → ${b[index]}`).toBeLessThan(1)
    }
  })

  /*
   * ★ 最强的一条：解出来的结果不能比**粗暴网格搜索**的最优解差多少。
   *
   * 为什么这么测：直接断言「不许顶死在限位上」是错的问题 —— 有些方向本来就在关节的
   * 可达锥之外，那时顶住限位正是最优解。而「不比穷举差」不需要判断可达性，
   * 又能直接抓住发散（发散时会比穷举差几十度）。
   */
  it('★ 不比 20° 步长的穷举搜索差多少（发散会立刻现形）', () => {
    const axes = jointAxes('upperArmL')
    const grid = axes.map(({ def }) => {
      const values: number[] = []
      for (let value = def.min; value <= def.max; value += 20) values.push(value)
      if (!values.includes(def.max)) values.push(def.max)
      return values
    })

    const directions: Array<[number, number, number]> = [1, 2, 3, 4, 5, 6].map((i) => (
      vecNormalize([Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9)]) as [number, number, number]
    ))

    for (const dir of directions) {
      let bestBrute = Number.POSITIVE_INFINITY
      for (const bend of grid[0]) {
        for (const turn of grid[1]) {
          for (const tilt of grid[2]) {
            const gap = aimGapRad({ upperArmL: [bend, turn, tilt] }, 'upperArmL', dir)
            if (gap < bestBrute) bestBrute = gap
          }
        }
      }
      const solved = aimGapRad(
        aimJoint({ pose: {}, jointId: 'upperArmL', direction: dir }),
        'upperArmL',
        dir,
      )
      const solvedDeg = (solved * 180) / Math.PI
      const bruteDeg = (bestBrute * 180) / Math.PI
      // 网格是 20° 步长，所以穷举本身有约 10° 的粒度误差；给它 12° 的余量
      expect(solvedDeg, `方向 ${dir.map((n) => n.toFixed(2)).join(',')}：解算 ${solvedDeg.toFixed(1)}° vs 穷举 ${bruteDeg.toFixed(1)}°`)
        .toBeLessThan(bruteDeg + 12)
    }
  })

  it('★ 骨头几乎躺在某个旋转轴上时，不在那个轴上乱转', () => {
    // 目标几乎就是静止朝向（-Y），只偏一点点。绕 Y 转对朝向几乎没影响，
    // 所以「旋转」轴不该被用来换取那点微小改善。
    const pose = aimJoint({ pose: {}, jointId: 'upperArmL', direction: [0.08, -0.9968, 0] })
    const angles = clampJointAngles('upperArmL', pose.upperArmL)
    expect(Math.abs(angles[1]), `旋转轴被乱转了 ${angles[1]}°`).toBeLessThan(5)
    expect(gapDeg(pose, 'upperArmL', [0.08, -0.9968, 0])).toBeLessThan(1)
  })

  it('铰链关节只在自己那一个轴上动，够不到就停在最近处', () => {
    const pose = aimJoint({ pose: {}, jointId: 'elbowL', direction: [1, 0, 0] })
    const angles = clampJointAngles('elbowL', pose.elbowL)
    expect(angles[1]).toBe(0)
    expect(angles[2]).toBe(0)
    expect(angles[0]).toBeGreaterThanOrEqual(0)
    expect(angles[0]).toBeLessThanOrEqual(150)
  })

  it('限制可动轴时，被冻住的轴一个字都不改', () => {
    const seeded = { upperArmL: [0, 0, 40] as [number, number, number] }
    const pose = aimJoint({ pose: seeded, jointId: 'upperArmL', direction: [0.3, 0.2, 0.9], axisIndices: [0, 1] })
    expect(clampJointAngles('upperArmL', pose.upperArmL)[2]).toBe(40)
  })

  it('不改传进来的姿势对象（调用方还拿着它做撤销）', () => {
    const original = { upperArmL: [10, 0, 0] as [number, number, number] }
    const snapshot = JSON.stringify(original)
    aimJoint({ pose: original, jointId: 'upperArmL', direction: [1, 0, 0] })
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('零向量 / 不认识的关节 / 没有可动轴都不抛', () => {
    expect(() => aimJoint({ pose: {}, jointId: 'upperArmL', direction: [0, 0, 0] })).not.toThrow()
    expect(() => aimJoint({ pose: {}, jointId: 'nope' as 'wristL', direction: [1, 0, 0] })).not.toThrow()
    expect(() => aimJoint({ pose: {}, jointId: 'upperArmL', direction: [NaN, 0, 0] })).not.toThrow()
  })

  it('jointTipLocal：有子关节用子关节偏移，没有的用自己形状的偏移', () => {
    // 上臂的子关节是肘，骨头朝下
    expect(jointTipLocal('upperArmL')?.[1]).toBeLessThan(0)
    // 手没有子关节，用形状偏移（也是朝下）
    expect(jointTipLocal('wristL')?.[1]).toBeLessThan(0)
    // 脚没有子关节，形状朝前（+Z 占主导）
    const ankle = jointTipLocal('ankleL')!
    expect(Math.abs(ankle[2])).toBeGreaterThan(Math.abs(ankle[1]))
  })

  it('jointBoneDirection 和 FK 算出来的子关节位置一致', () => {
    const pose = { upperArmL: [60, 0, 30] as [number, number, number] }
    const world = forwardKinematics(pose)
    const dir = jointBoneDirection(world, 'upperArmL')
    const byPosition = vecNormalize(vecSub(world.elbowL.position, world.upperArmL.position))
    for (const [index, value] of dir.entries()) {
      expect(value).toBeCloseTo(byPosition[index], 6)
    }
  })
})
