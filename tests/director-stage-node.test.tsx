/**
 * 三维空间节点：出图怎么写回，以及右键「添加节点」里到底有没有这一项
 * （2026-08-26 用户要求的第 3、4 条）。
 *
 * 最重要的一条是**出图只追加、永不整体替换**。8-25 补收路由那句 `nodeData.url = urls`
 * 把某个节点上已有的 44 条视频冲光了，这里专门盯着同一个形状的错误。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { appendStageRender, DIRECTOR_STAGE_MODEL_LABEL } = await import('@/features/director-stage/renderMerge')
const { nodeTypes } = await import('@/components/NodeRegistry')
const { NODE_TYPE_INT, NODE_INT_TYPE, NODE_LABELS, makeNodeData } = await import('@/lib/nodeData')
const { DirectorStageNode } = await import('@/components/nodes/DirectorStageNode')

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
const CANVAS = 'src/canvas/components/Canvas.tsx'
const THREE_RUNTIME = 'src/canvas/features/director-stage/DirectorStageThree.tsx'

const RENDER = { url: '/assets/1/stage-2.png', width: 1820, height: 1024, createdAtMs: 1_700_000_000_000 }

describe('出图写回：只追加，永不整体替换', () => {
  it('节点已有产物时，新图追加在后面 —— 老的一张都不能少', () => {
    const patch = appendStageRender({ url: ['/a.png', '/b.png'] }, RENDER)
    expect(patch.url).toEqual(['/a.png', '/b.png', RENDER.url])
  })

  it('同一个地址不会被加两次（重试 / 补收可能给出同一个地址）', () => {
    const patch = appendStageRender({ url: ['/a.png', RENDER.url] }, RENDER)
    expect(patch.url).toEqual(['/a.png', RENDER.url])
  })

  it('节点原本是空的 → 新图成为主图', () => {
    expect(appendStageRender({ url: [] }, RENDER)._primaryAssetUrl).toBe(RENDER.url)
    expect(appendStageRender({}, RENDER)._primaryAssetUrl).toBe(RENDER.url)
  })

  it('已经有主图 → **不动它**（用户挑过了，不替他改）', () => {
    const patch = appendStageRender({ url: ['/a.png', '/b.png'], _primaryAssetUrl: '/b.png' }, RENDER)
    expect(patch).not.toHaveProperty('_primaryAssetUrl')
  })

  it('主图指向一个已经不在 url[] 里的地址（悬空）→ 新图顶上', () => {
    const patch = appendStageRender({ url: ['/a.png'], _primaryAssetUrl: '/gone.png' }, RENDER)
    expect(patch._primaryAssetUrl).toBe(RENDER.url)
  })

  it('每张图打上来源标记，写清楚是自己渲的、不是花钱生成的', () => {
    const patch = appendStageRender({ url: ['/a.png'] }, RENDER)
    const meta = (patch._assetGenerationMeta as Record<string, { model: string; resolution: string; outputIndex: number }>)[RENDER.url]
    expect(meta.model).toBe(DIRECTOR_STAGE_MODEL_LABEL)
    expect(meta.resolution).toBe('1820×1024')
    expect(meta.createdAtMs).toBe(RENDER.createdAtMs)
    expect(meta.outputIndex).toBe(1)
  })

  it('已有产物的来源标记原样保留', () => {
    const patch = appendStageRender({
      url: ['/a.png'],
      _assetGenerationMeta: { '/a.png': { model: 'Nano Banana' } },
    }, RENDER)
    const meta = patch._assetGenerationMeta as Record<string, { model: string }>
    expect(meta['/a.png'].model).toBe('Nano Banana')
  })

  it('时间戳是 merge 进去的，老的不丢', () => {
    const patch = appendStageRender({ url: ['/a.png'], _assetCreatedAtMs: { '/a.png': 111 } }, RENDER)
    expect(patch._assetCreatedAtMs).toMatchObject({ '/a.png': 111, [RENDER.url]: RENDER.createdAtMs })
  })

  it('resourceMeta 追加并按地址去重，不整个换掉', () => {
    const existing = { kind: 'image', originalUrl: '/a.png', width: 100, height: 100 } as never
    const incoming = { kind: 'image', originalUrl: RENDER.url, width: 1820, height: 1024 } as never
    const patch = appendStageRender({ url: ['/a.png'], _resourceMeta: { items: [existing] } }, {
      ...RENDER, resourceMeta: incoming,
    })
    expect(patch._resourceMeta?.items).toEqual([existing, incoming])
  })

  it('两边都没有 displayUrl 时也不会误判成同一个资产（undefined === undefined 的坑）', () => {
    const existing = { kind: 'image', originalUrl: '/a.png' } as never
    const incoming = { kind: 'image', originalUrl: RENDER.url } as never
    const patch = appendStageRender({ url: ['/a.png'], _resourceMeta: { items: [existing] } }, {
      ...RENDER, resourceMeta: incoming,
    })
    expect(patch._resourceMeta?.items).toHaveLength(2)
  })

  it('同一个资产重新出图时替换那一条，不留两份', () => {
    const existing = { kind: 'image', originalUrl: RENDER.url, width: 10 } as never
    const incoming = { kind: 'image', originalUrl: RENDER.url, width: 1820 } as never
    const patch = appendStageRender({ url: [RENDER.url], _resourceMeta: { items: [existing] } }, {
      ...RENDER, resourceMeta: incoming,
    })
    expect(patch._resourceMeta?.items).toEqual([incoming])
  })

  it('没有 resourceMeta 时不会把已有的 _resourceMeta 抹掉', () => {
    const existing = { kind: 'image', originalUrl: '/a.png' } as never
    const patch = appendStageRender({ url: ['/a.png'], _resourceMeta: { items: [existing] } }, RENDER)
    expect(patch._resourceMeta?.items).toEqual([existing])
  })

  it('地址是空的 / 不是字符串 → 什么都不改（宁可这次出图白费，也不能动已有数据）', () => {
    expect(appendStageRender({ url: ['/a.png'] }, { ...RENDER, url: '' })).toEqual({})
    expect(appendStageRender({ url: ['/a.png'] }, { ...RENDER, url: '   ' })).toEqual({})
    expect(appendStageRender({ url: ['/a.png'] }, { ...RENDER, url: null as never })).toEqual({})
  })

  it('脏的 url[]（含 null / 空串）被过滤掉，但不影响追加', () => {
    const patch = appendStageRender({ url: ['/a.png', '', null, '  '] as never }, RENDER)
    expect(patch.url).toEqual(['/a.png', RENDER.url])
  })

  it('节点类型被改成图片资源，好让下游把它当参考图', () => {
    expect(appendStageRender({}, RENDER).action).toBe('image_resource')
  })

  it('不改传进来的节点数据本身', () => {
    const data = { url: ['/a.png'], _assetGenerationMeta: { '/a.png': { model: 'x' } } }
    const snapshot = JSON.stringify(data)
    appendStageRender(data, RENDER)
    expect(JSON.stringify(data)).toBe(snapshot)
  })
})

describe('节点类型接线', () => {
  it('类型 id 仍是 director_stage、整数仍是 5 —— 线上库里存的就是这个数', () => {
    expect(NODE_TYPE_INT.director_stage).toBe(5)
    expect(NODE_INT_TYPE[5]).toBe('director_stage')
  })

  it('NodeRegistry 指向新的三维空间组件', () => {
    expect(nodeTypes.director_stage).toBe(DirectorStageNode)
  })

  it('叫「三维空间」', () => {
    expect(NODE_LABELS.director_stage).toBe('三维空间')
  })

  it('新建出来是空的、带默认尺寸，params 不预先塞状态（省 payload）', () => {
    const data = makeNodeData('director_stage', '三维空间 1')
    expect(data.type).toBe('director_stage')
    expect(data.action).toBe('director_stage')
    expect(data.url).toEqual([])
    expect(data.contentWidth).toBeGreaterThan(300)
    expect(data.contentHeight).toBeGreaterThan(200)
    expect(data.params).toBeUndefined()
  })
})

/*
 * 右键「添加节点」那张列表和 three 运行时都在超大组件里，整棵挂起来需要 WebGL 和一堆上下文。
 * 按 node-selected-resolution.test.tsx 的先例退一步做源码断言 —— 2026-08-24 粉色标记
 * 失效就是「实现都在、只是没人接上去」，这类断言正是为了挡住那个形状的回归。
 */
describe('右键「添加节点」里有这一项（用户要求第 4 条）', () => {
  it('CANVAS_NODE_ITEMS 里有 director_stage', () => {
    const source = read(CANVAS)
    const list = source.slice(source.indexOf('const CANVAS_NODE_ITEMS'), source.indexOf('type CanvasMenuMode'))
    expect(list, '右键添加节点里没有三维空间').toContain("type: 'director_stage'")
    expect(list).toContain('三维空间')
  })

  it('拉连线的菜单里也同步改名了（同一个节点两个名字最让人迷惑）', () => {
    const source = read(CANVAS)
    const list = source.slice(source.indexOf('const CONN_ITEMS'), source.indexOf('interface ConnMenuProps'))
    expect(list).toContain("type: 'director_stage'")
    expect(list).toContain('三维空间')
    expect(list).not.toContain('导演台')
  })
})

describe('three 运行时接线', () => {
  it('用的是 three 官方 MIT 模块：OrbitControls 自由视角 + TransformControls 旋转手柄', () => {
    const source = read(THREE_RUNTIME)
    expect(source).toContain("three/examples/jsm/controls/OrbitControls.js")
    expect(source).toContain("three/examples/jsm/controls/TransformControls.js")
  })

  it('renderer 开了 preserveDrawingBuffer 和 alpha', () => {
    // 断言要落在 WebGLRenderer 那个参数对象里：整文件 toContain 会被文件头注释里
    // 提到的同一串字骗过去（第一版就是这么漏的，变异验证抓到）。
    const source = read(THREE_RUNTIME)
    const start = source.indexOf('new THREE.WebGLRenderer(')
    expect(start).toBeGreaterThan(-1)
    const options = source.slice(start, source.indexOf('}', start) + 1)
    expect(options, '不开 preserveDrawingBuffer，toBlob 出来是空白').toContain('preserveDrawingBuffer: true')
    expect(options, '不开 alpha，关掉背景板也出不了透明底 PNG').toContain('alpha: true')
  })

  it('出图按全景截图那一套：pixelRatio 压到 1、渲染后 finish() 再 toBlob', () => {
    const source = read(THREE_RUNTIME)
    expect(source).toContain('setPixelRatio(1)')
    expect(source).toContain('getContext().finish()')
    expect(source).toContain('toBlob')
  })

  it('出图前把把手和 gizmo 藏起来 —— 那是编辑辅助物，不该出现在成图里', () => {
    const source = read(THREE_RUNTIME)
    const capture = source.slice(source.indexOf('capture: async'), source.indexOf('// ── 建场景'))
    expect(capture).toContain('handle.visible = false')
    expect(capture).toContain('getHelper().visible = false')
    // 而且必须在 finally 里按当前开关恢复，否则出一次图之后再也点不到关节；
    // 用户藏了关节时也不该被出图强行打开。
    expect(capture).toContain('finally')
    expect(capture).toContain('handle.visible = stateRef.current.models.length === 0 && showJointHandlesRef.current')
  })

  it('焦距是真的接到相机 fov 上的（不然滑杆只是个装饰）', () => {
    const source = read(THREE_RUNTIME)
    expect(source).toContain('camera.fov = focalToFovDeg')
  })

  it('关节大小滑条超范围被夹住，脏值回默认', async () => {
    const { clampJointHandleScale, DEFAULT_JOINT_HANDLE_SCALE, MIN_JOINT_HANDLE_SCALE, MAX_JOINT_HANDLE_SCALE } =
      await import('@/features/director-stage/DirectorStageThree')
    expect(clampJointHandleScale(1)).toBe(1)
    expect(clampJointHandleScale(0)).toBe(MIN_JOINT_HANDLE_SCALE)
    expect(clampJointHandleScale(9)).toBe(MAX_JOINT_HANDLE_SCALE)
    expect(clampJointHandleScale('nope')).toBe(DEFAULT_JOINT_HANDLE_SCALE)
  })

  it('IK 拖拽走的是共用解算器，不是就地又写一遍', () => {
    const source = read(THREE_RUNTIME)
    expect(source).toContain("from './ik'")
    expect(source).toContain('solveIk({')
  })
})
