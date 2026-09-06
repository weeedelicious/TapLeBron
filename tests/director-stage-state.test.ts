/**
 * 三维空间节点的状态读写。
 *
 * 两件事在这里守着，都是踩过的坑：
 *
 * ① **容错读取。** 状态是存进 `params.stage` 落库的，老画布、插件写入、手改过的 JSON
 *    都可能给出缺字段 / 脏类型 / 超范围的值。读的时候必须一律回落到默认、绝不抛 ——
 *    节点打不开比姿势丢了严重得多。
 *
 * ② **体积。** 画布 payload 曾经把 Node 打到 OOM（资产库一次返回 500 条完整 payload）。
 *    姿势只存被改过的关节、坐标砍到 4 位小数，序列化后必须一直是「一条日志」的量级。
 */
import { describe, expect, it } from 'vitest'

const {
  DEFAULT_DIRECTOR_STAGE_STATE,
  DIRECTOR_RATIO_OPTIONS,
  DIRECTOR_RESOLUTION_OPTIONS,
  MAX_STAGE_PROPS,
  RESOLUTION_SHORT_EDGE,
  makeStageProp,
  makeStagePropId,
  normalizeCamera,
  normalizeDirectorStageState,
  normalizeHexColor,
  normalizePose,
  normalizeProps,
  normalizeRatio,
  normalizeResolution,
  normalizeScene,
  readDirectorStageState,
  roundCoord,
  writeDirectorStageState,
} = await import('@/features/director-stage/types')
const { MAX_FOCAL_MM, MIN_FOCAL_MM } = await import('@/features/director-stage/cameraMath')
const { JOINT_IDS } = await import('@/features/director-stage/skeleton')

describe('默认状态', () => {
  it('打开就是一个能用的机位：人在画面里、不是贴脸也不是天边', () => {
    const { camera } = DEFAULT_DIRECTOR_STAGE_STATE
    expect(camera.distance).toBeGreaterThan(2)
    expect(camera.distance).toBeLessThan(8)
    expect(camera.target[1]).toBeGreaterThan(0.5)
    expect(camera.focalMm).toBeGreaterThanOrEqual(MIN_FOCAL_MM)
    expect(camera.focalMm).toBeLessThanOrEqual(MAX_FOCAL_MM)
  })

  it('默认姿势是空的（自然站立），默认没有道具', () => {
    expect(DEFAULT_DIRECTOR_STAGE_STATE.pose).toEqual({})
    expect(DEFAULT_DIRECTOR_STAGE_STATE.props).toEqual([])
  })

  it('默认比例和分辨率都在选项表里', () => {
    expect(DIRECTOR_RATIO_OPTIONS).toContain(DEFAULT_DIRECTOR_STAGE_STATE.ratio)
    expect(DIRECTOR_RESOLUTION_OPTIONS).toContain(DEFAULT_DIRECTOR_STAGE_STATE.resolution)
  })

  it('每个分辨率档位都有对应的短边像素', () => {
    for (const option of DIRECTOR_RESOLUTION_OPTIONS) {
      expect(RESOLUTION_SHORT_EDGE[option]).toBeGreaterThan(0)
    }
  })

  it('归一化默认状态等于它自己（默认值本身必须是合法值）', () => {
    expect(normalizeDirectorStageState(DEFAULT_DIRECTOR_STAGE_STATE)).toEqual(DEFAULT_DIRECTOR_STAGE_STATE)
  })
})

describe('容错读取：什么都不许抛', () => {
  const GARBAGE = [undefined, null, 0, '', 'abc', [], true, NaN, { stage: null }, { stage: 'x' }, { stage: [] }]

  it.each(GARBAGE.map((value) => [JSON.stringify(value) ?? String(value), value]))(
    'readDirectorStageState(%s) 回落到默认，不抛',
    (_label, value) => {
      expect(() => readDirectorStageState(value)).not.toThrow()
      expect(readDirectorStageState(value)).toEqual(DEFAULT_DIRECTOR_STAGE_STATE)
    },
  )

  it('部分字段坏掉时只回落那一部分，好的留着', () => {
    const state = readDirectorStageState({
      stage: {
        camera: { yaw: 'abc', pitch: 6, distance: 3, target: [0, 1, 0], focalMm: 85 },
        pose: { elbowL: [40, 0, 0], 不是关节: [1, 2, 3] },
        props: 'nope',
        scene: { groundVisible: 'yes', backdropColor: 'red' },
        ratio: '99:1',
        resolution: '8K',
      },
    })
    expect(state.camera.focalMm).toBe(85)
    expect(state.camera.yaw).toBe(DEFAULT_DIRECTOR_STAGE_STATE.camera.yaw)
    expect(state.pose).toEqual({ elbowL: [40, 0, 0] })
    expect(state.props).toEqual([])
    expect(state.scene.groundVisible).toBe(DEFAULT_DIRECTOR_STAGE_STATE.scene.groundVisible)
    expect(state.scene.backdropColor).toBe(DEFAULT_DIRECTOR_STAGE_STATE.scene.backdropColor)
    expect(state.ratio).toBe(DEFAULT_DIRECTOR_STAGE_STATE.ratio)
    expect(state.resolution).toBe(DEFAULT_DIRECTOR_STAGE_STATE.resolution)
  })

  it('超范围的相机参数被钳住，不是被丢掉', () => {
    const camera = normalizeCamera({ yaw: 730, pitch: 200, distance: 1e6, focalMm: 900, target: [1, 2, 3] })
    expect(camera.yaw).toBeCloseTo(10, 6)
    expect(Math.abs(camera.pitch)).toBeLessThan(90)
    expect(camera.distance).toBeLessThanOrEqual(40)
    expect(camera.focalMm).toBe(MAX_FOCAL_MM)
    expect(camera.target).toEqual([1, 2, 3])
  })

  it('颜色必须是 #rrggbb，别的都回落', () => {
    expect(normalizeHexColor('#AABBCC', '#000000')).toBe('#aabbcc')
    for (const bad of ['red', '#abc', '#12345', 'rgb(0,0,0)', '', null, 42]) {
      expect(normalizeHexColor(bad, '#123456')).toBe('#123456')
    }
  })

  it('比例 / 分辨率只认选项表里的值', () => {
    expect(normalizeRatio('9:16')).toBe('9:16')
    expect(normalizeRatio('7:3')).toBe(DEFAULT_DIRECTOR_STAGE_STATE.ratio)
    expect(normalizeResolution('4k')).toBe('4K')
    expect(normalizeResolution('8K')).toBe(DEFAULT_DIRECTOR_STAGE_STATE.resolution)
  })

  it('场景开关只认真正的布尔值（"false" 字符串不该被当成 false）', () => {
    expect(normalizeScene({ gridVisible: false }).gridVisible).toBe(false)
    expect(normalizeScene({ gridVisible: 'false' }).gridVisible).toBe(true)
    expect(normalizeScene({}).gridVisible).toBe(DEFAULT_DIRECTOR_STAGE_STATE.scene.gridVisible)
  })
})

describe('姿势归一化', () => {
  it('全 0 的关节被丢掉 —— 自然站立就是空对象', () => {
    expect(normalizePose({ elbowL: [0, 0, 0], chest: [0, 0, 0] })).toEqual({})
  })

  it('认不出来的关节 id 直接扔掉', () => {
    expect(normalizePose({ nose: [10, 0, 0], elbowL: [10, 0, 0] })).toEqual({ elbowL: [10, 0, 0] })
  })

  it('角度过关节自己的钳制（库里存着越界值也渲染不出怪姿势）', () => {
    expect(normalizePose({ elbowL: [999, 44, 55] })).toEqual({ elbowL: [150, 0, 0] })
  })

  it('角度砍到 4 位小数，不留一串浮点尾巴', () => {
    expect(normalizePose({ chest: [12.3456789, 0, 0] })).toEqual({ chest: [12.3457, 0, 0] })
  })
})

describe('道具', () => {
  it('缩放不许为 0 或负数（three 会算出退化矩阵，物体直接消失且不报错）', () => {
    const [prop] = normalizeProps([{ kind: 'box', scale: [0, -2, 1] }])
    expect(prop.scale[0]).toBeGreaterThan(0)
    expect(prop.scale[1]).toBeGreaterThan(0)
  })

  it('id 撞了会顺一个新的（界面按 id 选中和删除，重复 id 会一删两个）', () => {
    const props = normalizeProps([{ id: 'box-1', kind: 'box' }, { id: 'box-1', kind: 'box' }])
    expect(props).toHaveLength(2)
    expect(new Set(props.map((prop) => prop.id)).size).toBe(2)
  })

  it('没给 kind 的当长方体，cylinder 之外的值也当长方体', () => {
    expect(normalizeProps([{}, { kind: 'sphere' }, { kind: 'cylinder' }]).map((prop) => prop.kind))
      .toEqual(['box', 'box', 'cylinder'])
  })

  it('数量有上限，超出的截掉', () => {
    const many = Array.from({ length: MAX_STAGE_PROPS + 10 }, (_, index) => ({ id: `p${index}`, kind: 'box' }))
    expect(normalizeProps(many)).toHaveLength(MAX_STAGE_PROPS)
  })

  it('新建的道具落在人物旁边、贴地以上，且 id 不撞', () => {
    let props: ReturnType<typeof makeStageProp>[] = []
    for (let i = 0; i < 5; i++) props = [...props, makeStageProp(props, i % 2 ? 'cylinder' : 'box')]
    expect(new Set(props.map((prop) => prop.id)).size).toBe(5)
    for (const prop of props) {
      expect(prop.position[1]).toBeGreaterThan(0)
      expect(prop.scale.every((value) => value > 0)).toBe(true)
    }
  })

  it('makeStagePropId 会跳过已占用的 id', () => {
    const existing = [{ id: 'box-1', kind: 'box' as const, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }]
    expect(makeStagePropId(existing, 'box')).not.toBe('box-1')
  })
})

describe('写回 params', () => {
  it('只动 stage 这一个键，别的原样保留', () => {
    const params = { prompt: '别动我', imageList: [{ nodeId: 'n1', url: '/a.png' }], stage: { camera: { focalMm: 24 } } }
    const next = writeDirectorStageState(params, { ...DEFAULT_DIRECTOR_STAGE_STATE, ratio: '1:1' })
    expect(next.prompt).toBe('别动我')
    expect(next.imageList).toBe(params.imageList)
    expect((next.stage as { ratio: string }).ratio).toBe('1:1')
  })

  it('写回时也过一遍归一化（脏值进不了库）', () => {
    const next = writeDirectorStageState({}, {
      ...DEFAULT_DIRECTOR_STAGE_STATE,
      ratio: '99:1',
      pose: { elbowL: [999, 0, 0] },
    } as never)
    expect((next.stage as { ratio: string }).ratio).toBe(DEFAULT_DIRECTOR_STAGE_STATE.ratio)
    expect((next.stage as { pose: Record<string, number[]> }).pose.elbowL).toEqual([150, 0, 0])
  })

  it('params 为 undefined 时也能写', () => {
    expect(() => writeDirectorStageState(undefined, DEFAULT_DIRECTOR_STAGE_STATE)).not.toThrow()
  })

  it('读写一来一回不漂移（幂等）', () => {
    const once = writeDirectorStageState({}, normalizeDirectorStageState({
      camera: { yaw: 33.33333, pitch: -12.5, distance: 5.25, target: [0, 0.9, 0], focalMm: 85 },
      pose: { chest: [10, -5, 3], elbowL: [90, 0, 0] },
      props: [{ id: 'box-1', kind: 'box', position: [1, 0.25, 0], rotation: [0, 30, 0], scale: [1, 1, 1] }],
      scene: { gridVisible: false, backdropColor: '#101014' },
      ratio: '9:16',
      resolution: '4K',
    }))
    const twice = writeDirectorStageState({}, readDirectorStageState(once))
    expect(twice).toEqual(once)
  })
})

describe('体积守卫：画布 payload 曾经把 Node 打到 OOM', () => {
  const size = (value: unknown) => JSON.stringify(value).length

  it('默认状态不到 400 字节', () => {
    expect(size(DEFAULT_DIRECTOR_STAGE_STATE)).toBeLessThan(400)
  })

  it('所有关节都调过 + 满道具的极端状态也不到 4KB', () => {
    const pose = Object.fromEntries(JOINT_IDS.map((id) => [id, [12.3456, -7.6543, 3.2109]]))
    const props = Array.from({ length: MAX_STAGE_PROPS }, (_, index) => ({
      id: `box-${index}`, kind: 'box', position: [1.23456, 0.25, -3.14159], rotation: [0, 30.5, 0], scale: [1, 2, 1],
    }))
    const state = normalizeDirectorStageState({ ...DEFAULT_DIRECTOR_STAGE_STATE, pose, props })
    expect(size(state)).toBeLessThan(4096)
  })

  it('坐标不会写进一串 17 位浮点', () => {
    expect(String(roundCoord(1 / 3)).length).toBeLessThanOrEqual(7)
    const state = normalizeDirectorStageState({ camera: { target: [1 / 3, 2 / 3, 1 / 7] } })
    expect(JSON.stringify(state.camera.target)).toBe('[0.3333,0.6667,0.1429]')
  })
})
