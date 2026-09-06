/**
 * MakeHuman 白模那个 glb（2026-08-26：把粗糙的程序化白模换成精细蒙皮白模）。
 *
 * ── 这个文件盯的是「两份真源悄悄错开」 ──────────────────────────────────────
 *
 * 蒙皮白模的骨位在 glb 里（逆绑定矩阵），IK / 旋转手柄 / 参考图反推读的是
 * `DIRECTOR_JOINTS`。两边都由 `tools/build_mannequin.py` 产出，但「同一个脚本算的」
 * 不等于「仓库里这两个文件此刻一致」—— 有人手改了关节表、或者忘了重跑脚本，
 * 就会错开。而错开**不报错**：画面上的手在一处、IK 以为的手在另一处，
 * 表现是「拖手柄时手不跟手」，很难联想到是资产和表脱钩。
 *
 * 所以这里直接解 glb 的二进制，逐骨对账。运行时也有同样的对账（会 console.warn），
 * 但那要等人打开节点才发现，测试能在提交前就拦住。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const path = require('node:path') as typeof import('node:path')

const { JOINT_IDS, JOINT_BY_ID } = await import('@/features/director-stage/skeleton')
const { forwardKinematics } = await import('@/features/director-stage/ik')

const GLB_PATH = path.join(__dirname, '..', 'public/models/mannequin.glb')

/** 解 GLB 容器：12 字节头 + 若干 chunk（JSON 在前、BIN 在后）。 */
function readGlb() {
  const raw = fs.readFileSync(GLB_PATH)
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const magic = String.fromCharCode(...raw.subarray(0, 4))
  const version = view.getUint32(4, true)
  const total = view.getUint32(8, true)
  let offset = 12
  let json: Record<string, never> | null = null
  let bin: Buffer | null = null
  while (offset < raw.byteLength) {
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const body = raw.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'))
    if (type === 0x004e4942) bin = Buffer.from(body)
    offset += 8 + length
  }
  return { raw, magic, version, total, json: json as never as GltfDoc, bin: bin! }
}

interface GltfDoc {
  nodes: Array<{ name?: string; mesh?: number; skin?: number; translation?: number[]; children?: number[] }>
  skins: Array<{ joints: number[]; skeleton?: number; inverseBindMatrices: number }>
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number }> }>
  accessors: Array<{ bufferView: number; componentType: number; count: number; type: string; min?: number[]; max?: number[] }>
  bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }>
  buffers: Array<{ byteLength: number }>
  asset: { version: string; generator?: string }
}

const glb = readGlb()
const doc = glb.json
const skin = doc.skins[0]
const boneNames = skin.joints.map((index) => doc.nodes[index].name as string)

function accessorFloats(index: number): Float32Array {
  const accessor = doc.accessors[index]
  const view = doc.bufferViews[accessor.bufferView]
  const perElement = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type] ?? 1
  return new Float32Array(
    glb.bin.buffer.slice(
      glb.bin.byteOffset + view.byteOffset,
      glb.bin.byteOffset + view.byteOffset + accessor.count * perElement * 4,
    ),
  )
}

describe('glb 是个结构完好的蒙皮网格', () => {
  it('容器合法、长度自洽', () => {
    expect(glb.magic).toBe('glTF')
    expect(glb.version).toBe(2)
    expect(glb.total).toBe(glb.raw.byteLength)
    expect(doc.asset.version).toBe('2.0')
    expect(doc.asset.generator, '生成者要写清出处，将来才知道怎么重跑')
      .toContain('build_mannequin.py')
  })

  it('有 POSITION / NORMAL / JOINTS_0 / WEIGHTS_0 和索引', () => {
    const primitive = doc.meshes[0].primitives[0]
    for (const key of ['POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0']) {
      expect(primitive.attributes[key], `缺 ${key}`).toBeDefined()
    }
    expect(primitive.indices).toBeDefined()
    expect(doc.accessors[primitive.indices!].count % 3, '索引数不是 3 的倍数').toBe(0)
  })

  it('所有 bufferView 都在 BIN 界内且 4 字节对齐', () => {
    for (const view of doc.bufferViews) {
      expect(view.byteOffset % 4, JSON.stringify(view)).toBe(0)
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(glb.bin.byteLength)
    }
    expect(doc.buffers[0].byteLength).toBe(glb.bin.byteLength)
  })

  it('体积在预期量级（1.5MB 以内，运行时资产不该失控）', () => {
    expect(glb.raw.byteLength).toBeGreaterThan(200 * 1024)
    expect(glb.raw.byteLength).toBeLessThan(1536 * 1024)
  })
})

describe('★ 骨和关节表逐个对账', () => {
  it('49 根骨，名字和 JOINT_IDS 完全对应', () => {
    expect(boneNames).toHaveLength(49)
    expect([...boneNames].sort()).toEqual([...JOINT_IDS].sort())
  })

  it('骨架根是胯', () => {
    expect(doc.nodes[skin.skeleton!].name).toBe('hips')
  })

  it('★ 逆绑定矩阵的静止骨位 == 关节表算出来的静止姿势（差 1mm 就算脱钩）', () => {
    const rest = forwardKinematics({})
    const matrices = accessorFloats(skin.inverseBindMatrices)
    const drift: string[] = []
    boneNames.forEach((name, index) => {
      // glTF 是列主序：平移在第 13/14/15 个 float。逆绑定矩阵是 translate(−静止位置)。
      const base = index * 16
      const got = [-matrices[base + 12], -matrices[base + 13], -matrices[base + 14]]
      const want = rest[name as 'hips'].position
      const off = Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])
      if (off > 1e-3) drift.push(`${name} 差 ${(off * 1000).toFixed(2)}mm`)
    })
    expect(drift, `重跑 tools/build_mannequin.py：${drift.join('；')}`).toEqual([])
  })

  it('节点的层级和关节表的父子关系一致', () => {
    const nodeIndexByName = new Map(boneNames.map((name, index) => [name, skin.joints[index]]))
    const parentOf = new Map<number, number>()
    doc.nodes.forEach((node, index) => {
      for (const child of node.children ?? []) parentOf.set(child, index)
    })
    for (const name of boneNames) {
      const declared = JOINT_BY_ID[name as 'hips'].parent
      const parentIndex = parentOf.get(nodeIndexByName.get(name)!)
      const actual = parentIndex === undefined ? null : (doc.nodes[parentIndex].name ?? null)
      expect(actual, `${name} 在 glb 里的父是 ${actual}，表里是 ${declared}`).toBe(declared)
    }
  })

  it('JOINTS_0 的下标不越界（越界会让顶点绑到不存在的骨上）', () => {
    const primitive = doc.meshes[0].primitives[0]
    const accessor = doc.accessors[primitive.attributes.JOINTS_0]
    expect(accessor.componentType, 'JOINTS_0 应该是 UNSIGNED_BYTE').toBe(5121)
    const view = doc.bufferViews[accessor.bufferView]
    const bytes = glb.bin.subarray(view.byteOffset, view.byteOffset + accessor.count * 4)
    let max = 0
    for (const value of bytes) max = Math.max(max, value)
    expect(max).toBeLessThan(boneNames.length)
  })

  it('每个顶点的权重和为 1（不为 1 的地方网格会缩掉或炸开）', () => {
    const primitive = doc.meshes[0].primitives[0]
    const weights = accessorFloats(primitive.attributes.WEIGHTS_0)
    let worst = 0
    for (let i = 0; i < weights.length; i += 4) {
      const sum = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3]
      worst = Math.max(worst, Math.abs(sum - 1))
    }
    expect(worst).toBeLessThan(1e-5)
  })
})

describe('★ 静止姿势真的是「手臂垂下」，不是 A-pose', () => {
  it('网格脚底贴地、身高在 1.6~1.75m', () => {
    const accessor = doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION]
    expect(accessor.min![1]).toBeCloseTo(0, 3)
    expect(accessor.max![1]).toBeGreaterThan(1.6)
    expect(accessor.max![1]).toBeLessThan(1.75)
  })

  it('★ 横向宽度是「手臂垂下」的量级 —— A-pose 会宽到 ±0.49m', () => {
    const accessor = doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION]
    expect(Math.abs(accessor.min![0])).toBeLessThan(0.35)
    expect(accessor.max![0]).toBeLessThan(0.35)
  })

  it('手腕在髋部高度附近（手臂垂着），不在肩膀那么高', () => {
    const rest = forwardKinematics({})
    expect(rest.wristL.position[1]).toBeGreaterThan(0.7)
    expect(rest.wristL.position[1]).toBeLessThan(1.0)
    expect(rest.wristL.position[1]).toBeLessThan(rest.hips.position[1] + 0.05)
  })
})

describe('运行时接线（jsdom 起不了 WebGL，只能断言接线）', () => {
  const SOURCE = (fs.readFileSync(
    path.join(__dirname, '..', 'src/canvas/features/director-stage/DirectorStageThree.tsx'),
    'utf8',
  ) as string).replace(/\r\n/g, '\n')

  it('从同域 /models/ 载，不走外部 CDN', () => {
    expect(SOURCE).toContain("MANNEQUIN_URL = '/models/mannequin.glb'")
    expect(SOURCE).not.toMatch(/https?:\/\/[^\s'"]*\.glb/)
  })

  it('★ GLTFLoader 是动态 import（静态引入会给主包白加 100KB）', () => {
    expect(SOURCE).toContain("await import('three/examples/jsm/loaders/GLTFLoader.js')")
    expect(SOURCE, '写成静态 import 就进主包了 —— 实测涨 100KB')
      .not.toMatch(/^import .*GLTFLoader/m)
  })

  it('★ 蒙皮重绑到我们自己的骨上，不用 glb 自带的骨', () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf('async function attachMannequinSkin'),
      SOURCE.indexOf('function propGeometry'),
    )
    expect(fn.length).toBeGreaterThan(500)
    expect(fn, '没有按名字映射到 runtime.joints').toContain('runtime.joints[name as JointId]')
    expect(fn, '没有新建 Skeleton 绑我们的骨').toMatch(/new THREE\.Skeleton\(/)
    expect(fn, 'bindMatrix 必须显式给单位矩阵').toContain('new THREE.Matrix4()')
  })

  it('★ 载不进来要回落到程序化白模，不能让整个节点不可用', () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf('async function attachMannequinSkin'),
      SOURCE.indexOf('function propGeometry'),
    )
    // 三条失败路径都得 return false（而不是抛出去）
    expect((fn.match(/return false/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(fn).toContain('退回程序化白模')
    // 只有成功才隐藏程序化图元
    const hideAt = fn.indexOf('item.visible = false')
    expect(hideAt).toBeGreaterThan(-1)
    expect(fn.slice(hideAt), '隐藏图元之后必须 return true').toContain('return true')
  })

  it('★ 有骨位对账，脱钩了会喊出来', () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf('async function attachMannequinSkin'),
      SOURCE.indexOf('function propGeometry'),
    )
    expect(fn).toContain('forwardKinematics({})')
    expect(fn).toContain('boneInverses')
    expect(fn).toContain('build_mannequin.py')
  })

  it('摆姿势后不许被视锥剔除（包围球是按静止算的，会失真）', () => {
    expect(SOURCE).toContain('skin.frustumCulled = false')
  })

  it('手指默认不进身体那套点选球，手指工具另建小号手柄', () => {
    expect(SOURCE).toContain('if (joint.pickable === false)')
    expect(SOURCE).toContain('fingerHandles')
    expect(SOURCE).toContain("tool === 'finger'")
    expect(SOURCE).toContain('fingerIkChainFor')
    expect(SOURCE, 'buildFigure 里调了 isFingerJoint，漏 import 会一打开就黑屏').toContain('isFingerJoint')
    const fromSkeleton = SOURCE.slice(
      SOURCE.indexOf('import {'),
      SOURCE.indexOf("} from './skeleton'"),
    )
    expect(fromSkeleton).toContain('isFingerJoint')
  })

  it('可以藏掉身上的关节小球（预览 / 出图构图时挡视线）', () => {
    expect(SOURCE).toContain('showJointHandles')
    expect(SOURCE).toContain('handle.visible = showJointHandles')
    expect(SOURCE).toContain('handle.visible = showJointHandles && tool === \'finger\'')
    expect(SOURCE).toContain('if (!showJointHandlesRef.current) return null')
  })

  it('关节小球大小走倍率，选中时仍略放大', () => {
    expect(SOURCE).toContain('clampJointHandleScale(jointHandleScale)')
    expect(SOURCE).toContain('active ? 1.25 : 1')
    expect(SOURCE).toContain('active ? 1.35 : 1')
  })

  it('形状按 alignTo 对齐骨向（用方向向量而不是 Euler，没有顺序歧义）', () => {
    expect(SOURCE).toContain('setFromUnitVectors(CAPSULE_AXIS')
  })

  it('★ 关节旋转用局部空间，外圈自由转（彩色环单轴，E / XYZE 多轴）', () => {
    expect(SOURCE).toContain("transform.setSpace('local')")
    const rotateAt = SOURCE.indexOf("if (showJointHandles && tool === 'rotate' && selectedJoint")
    expect(rotateAt).toBeGreaterThan(-1)
    const rotateBlock = SOURCE.slice(rotateAt, SOURCE.indexOf('runtime.transform.detach()', rotateAt))
    expect(rotateBlock.length).toBeGreaterThan(80)
    expect(rotateBlock).toContain("setMode('rotate')")
    expect(rotateBlock).toContain("setSpace('local')")
    expect(rotateBlock).toContain('showE = true')
    expect(rotateBlock).toContain('showXYZE = true')
  })

  it('★ 拖旋转手柄时不把欧拉角写回物体（YXZ round-trip 会闪）', () => {
    expect(SOURCE).toContain('transformingRef.current')
    const emit = SOURCE.slice(
      SOURCE.indexOf('const emitTransform = () => {'),
      SOURCE.indexOf('transform.addEventListener(\'objectChange\''),
    )
    expect(emit).toContain('applyEulerDelta')
    expect(emit, '拖的过程中写回欧拉角会在万向节附近跳').not.toContain('object.rotation.set(ex, ey, ez)')
    expect(SOURCE).toContain('if (!runtime || transformingRef.current) return')
  })

  it('★ IK 模式必须拆掉 gizmo（默认 translate 会在绿色关节上画出 XYZ 平移轴）', () => {
    const effect = SOURCE.slice(
      SOURCE.indexOf('// ── 选中项 → 手柄高亮 + gizmo 挂到谁身上'),
      SOURCE.indexOf('const onContextMenu'),
    )
    expect(effect).toContain("if (tool !== 'ik' && tool !== 'finger' && selectedPropId)")
    expect(effect).toContain('runtime.transform.detach()')
    // 道具分支必须排在关节旋转之前，而且 IK 时连道具也不挂 —— 否则按 W 还是平移轴
    const propAt = effect.indexOf("if (tool !== 'ik' && tool !== 'finger' && selectedPropId)")
    const rotateAt = effect.indexOf("if (showJointHandles && tool === 'rotate' && selectedJoint")
    const detachAt = effect.lastIndexOf('runtime.transform.detach()')
    expect(propAt).toBeGreaterThan(-1)
    expect(rotateAt).toBeGreaterThan(propAt)
    expect(detachAt).toBeGreaterThan(rotateAt)
  })
})
