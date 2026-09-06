/**
 * 三维空间节点的三件改动（2026-08-26）：
 *   ① 出图走输出口连到一个**新建的图片节点**，每次出图都新建一个；
 *   ② 弹窗占满全屏；
 *   ③ 能连一张参考图进来（只用于分析姿势，不进 3D 场景、不进出图画面）。
 *
 * 视觉那一步（MediaPipe）在 jsdom 里跑不了，所以那部分做**源码接线断言** ——
 * 按 `tests/node-selected-resolution.test.tsx` 的先例：算式对了但没接上，界面照样是坏的。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const {
  DIRECTOR_STAGE_GENERATOR,
  STAGE_RENDER_GAP_X,
  STAGE_RENDER_PREVIEW_MAX_HEIGHT,
  STAGE_RENDER_PREVIEW_MAX_WIDTH,
  STAGE_RENDER_STAGGER_Y,
  appendStageRender,
  stageRenderNodeData,
  stageRenderNodePosition,
  stageRenderPreviewFrame,
  stageRenderSourceWidth,
} = await import('@/features/director-stage/renderMerge')
const { clearedStageRef, readStageRef, resolveStageReference } =
  await import('@/features/director-stage/stageReference')
const { DEFAULT_DIRECTOR_STAGE_STATE } = await import('@/features/director-stage/types')

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const path = require('node:path') as typeof import('node:path')
/**
 * 读源码做接线断言。**行尾统一成 \n**：仓库里 CRLF / LF 混着，
 * 而 push.py 上传时还会把 CRLF 转成 LF —— 断言里带换行的匹配不归一化就会随机红。
 */
const read = (rel: string) =>
  (fs.readFileSync(path.join(__dirname, '..', rel), 'utf8') as string).replace(/\r\n/g, '\n')

const NODE_SOURCE = read('src/canvas/components/nodes/DirectorStageNode.tsx')
const MODAL_SOURCE = read('src/canvas/features/director-stage/DirectorStageModal.tsx')
const CANVAS_SOURCE = read('src/canvas/components/Canvas.tsx')
const CSS_SOURCE = read('src/canvas/features/director-stage/director-stage.css')
const ESTIMATOR_SOURCE = read('src/canvas/features/director-stage/poseEstimator.ts')

const baseState = { ...DEFAULT_DIRECTOR_STAGE_STATE, ratio: '3:2', resolution: '2K' }
const renderInput = {
  stageNodeId: 'stage-1',
  stageName: '三维空间 1',
  url: '/assets/9/abc.png',
  width: 1536,
  height: 1024,
  createdAtMs: 1_700_000_000_000,
  state: baseState,
  baseImageParams: { model: 'x', settings: { quality: 'high', ratio: '1:1', resolution: '1K' }, imageList: [] },
}

describe('① 出图新建图片节点', () => {
  it('位置在上游右边，且按已有出边数往下错开', () => {
    const first = stageRenderNodePosition({ stageX: 100, stageY: 200, stageWidth: 420, outgoingCount: 0 })
    const third = stageRenderNodePosition({ stageX: 100, stageY: 200, stageWidth: 420, outgoingCount: 2 })
    expect(first.x).toBe(100 + 420 + STAGE_RENDER_GAP_X)
    expect(first.y).toBe(200)
    // ★ 不错开的话第三张会压在第一张身上，看起来像只出了一张
    expect(third.y).toBe(200 + 2 * STAGE_RENDER_STAGGER_Y)
    expect(third.x).toBe(first.x)
  })

  it('宽度 / 坐标是脏值也给得出位置', () => {
    for (const bad of [NaN, undefined, 'x']) {
      const at = stageRenderNodePosition({
        stageX: bad as never, stageY: bad as never, stageWidth: bad as never, outgoingCount: bad as never,
      })
      expect(Number.isFinite(at.x) && Number.isFinite(at.y), String(bad)).toBe(true)
    }
  })

  it('新节点是一张带产物的图片节点，主图就是这张', () => {
    const data = stageRenderNodeData(renderInput) as Record<string, unknown>
    expect(data.url).toEqual(['/assets/9/abc.png'])
    expect(data._primaryAssetUrl).toBe('/assets/9/abc.png')
    expect(data.action).toBe('image_resource')
    expect(data.sourceKind).toBe('derived')
    expect(data.generatorType).toBe(DIRECTOR_STAGE_GENERATOR)
  })

  it('新节点认得上游（imageList 指回三维空间节点），所以能继续往下垫图重绘', () => {
    const params = (stageRenderNodeData(renderInput) as { params: Record<string, unknown> }).params
    expect(params.modeType).toBe('image2image')
    expect(params.imageList).toEqual([{ nodeId: 'stage-1', url: '/assets/9/abc.png', mediaType: 'image' }])
    expect(params.imageListOrder).toEqual(['stage-1'])
  })

  it('出图比例 / 清晰度跟着三维空间的设置，不是图片节点的默认值', () => {
    const params = (stageRenderNodeData(renderInput) as { params: Record<string, unknown> }).params
    const settings = params.settings as Record<string, unknown>
    expect(settings.ratio).toBe('3:2')
    expect(settings.resolution).toBe('2K')
    // 其余默认项要保留下来
    expect(settings.quality).toBe('high')
  })

  it('★ 记下这一张是怎么出来的（机位 / 姿势 / 尺寸），过两周能追溯', () => {
    const params = (stageRenderNodeData({
      ...renderInput,
      state: { ...baseState, pose: { elbowL: [90, 0, 0] } },
    }) as { params: Record<string, Record<string, Record<string, unknown>>> }).params
    const meta = params.advancedSettings.directorStageRender
    expect(meta.stageNodeId).toBe('stage-1')
    expect(meta.camera).toEqual(baseState.camera)
    expect(meta.pose).toEqual({ elbowL: [90, 0, 0] })
    expect(meta.width).toBe(1536)
    expect(meta.height).toBe(1024)
    expect(meta.createdAtMs).toBe(1_700_000_000_000)
  })

  it('★ 三维空间节点自己仍然是「追加」而不是替换（8-25 冲掉 44 条视频的教训）', () => {
    const patch = appendStageRender(
      { url: ['/assets/9/old-1.png', '/assets/9/old-2.png'], _primaryAssetUrl: '/assets/9/old-1.png' },
      { url: '/assets/9/new.png', width: 800, height: 600, createdAtMs: 1 },
    )
    expect(patch.url).toEqual(['/assets/9/old-1.png', '/assets/9/old-2.png', '/assets/9/new.png'])
    // 已有主图是用户挑过的，不替他改
    expect(patch._primaryAssetUrl).toBeUndefined()
  })

  it('节点里调的是 addNodeAt(\'image\')，连线交给 addNodeAt 从 imageList 推（不要再用旧 edges 盖掉）', () => {
    expect(NODE_SOURCE).toContain("addNodeAt(\n        'image',")
    expect(NODE_SOURCE).toContain('stageRenderNodeData({')
    expect(NODE_SOURCE).toContain('stageRenderNodePosition({')
    expect(NODE_SOURCE).toContain('stageRenderSourceWidth(stageNode)')
    expect(NODE_SOURCE, '手写 setEdges 会拿闭包里的旧边把刚推好的线盖掉，刷新才对')
      .not.toContain('setEdges(addEdge({')
    expect(NODE_SOURCE).not.toContain('-stage-render')
  })

  it('新节点当场带上预览框尺寸，不要等刷新才按图片比例收', () => {
    const data = stageRenderNodeData(renderInput) as Record<string, unknown>
    const frame = stageRenderPreviewFrame(1536, 1024)
    expect(data.contentWidth).toBe(frame.width)
    expect(data.contentHeight).toBe(frame.height)
    expect(frame.width).toBeLessThanOrEqual(STAGE_RENDER_PREVIEW_MAX_WIDTH)
    expect(frame.height).toBeLessThanOrEqual(STAGE_RENDER_PREVIEW_MAX_HEIGHT)
  })

  it('排位置用画面上的宽度，不用过期的 contentWidth', () => {
    expect(stageRenderSourceWidth({
      width: 720,
      measured: { width: 700 },
      data: { contentWidth: 420 },
    })).toBe(720)
    expect(stageRenderSourceWidth({
      measured: { width: 700 },
      data: { contentWidth: 420 },
    })).toBe(700)
    expect(stageRenderSourceWidth({ data: { contentWidth: 420 } })).toBe(420)
    expect(stageRenderSourceWidth(null)).toBe(420)
    expect(stageRenderSourceWidth({ width: Number.NaN, data: { contentWidth: 0 } })).toBe(420)
  })

  it('位置用的是实际出边数，不是写死的 0', () => {
    expect(NODE_SOURCE).toContain('edges.filter((edge) => edge.source === id).length')
    expect(NODE_SOURCE).toContain('outgoingCount,')
  })

  it('仍然同时写回自己的 url[] 和 params.stage（节点缩略图和「下次接着调」都靠它）', () => {
    expect(NODE_SOURCE).toContain('appendStageRender(data, {')
    expect(NODE_SOURCE).toContain('writeDirectorStageState(data.params, state)')
  })
})

describe('② 弹窗全屏', () => {
  const block = (selector: string) => {
    const start = CSS_SOURCE.indexOf(`\n${selector} {`)
    expect(start, `找不到 ${selector}`).toBeGreaterThan(-1)
    return CSS_SOURCE.slice(start, CSS_SOURCE.indexOf('}', start))
  }

  it('shell 占满，而且没有写死的最大宽高（写死的尺寸会过期）', () => {
    const shell = block('.director-stage-shell')
    expect(shell).toContain('width: 100%')
    expect(shell).toContain('height: 100%')
    expect(shell, '还留着 min(1520px, …) 这种上限').not.toMatch(/max-height|min\(\s*\d+px/)
  })

  it('backdrop 不留边（留了边就不是全屏）', () => {
    expect(block('.director-stage-backdrop')).toContain('padding: 0')
  })

  it('全屏后没有「点外面关闭」了，所以 Esc 和关闭按钮必须都在', () => {
    expect(MODAL_SOURCE).toContain("event.key === 'Escape'")
    expect(MODAL_SOURCE).toContain('onClick={onCancel}')
  })
})

describe('③ 参考图输入', () => {
  it('读得出 stageRef，脏数据一律当没连', () => {
    expect(readStageRef({ stageRef: { nodeId: 'n1', url: '/a.png', name: '图' } }))
      .toEqual({ nodeId: 'n1', url: '/a.png', name: '图' })
    for (const bad of [undefined, null, {}, { stageRef: null }, { stageRef: 'x' }, { stageRef: {} }, { stageRef: { nodeId: '  ' } }]) {
      expect(readStageRef(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('★ 实时取上游当前的主图，不是连线那一刻的快照（上游「设为主图」换了要跟着变）', () => {
    const nodes = [{
      id: 'n1',
      data: { name: '角色参考', url: ['/a.png', '/b.png'], _primaryAssetUrl: '/b.png' },
    }] as never
    const ref = resolveStageReference({ stageRef: { nodeId: 'n1', url: '/a.png' } }, nodes)
    expect(ref.url).toBe('/b.png')
    expect(ref.name).toBe('角色参考')
    expect(ref.missing).toBe(false)
  })

  it('上游节点不在了 → 退回快照并标记 missing（界面要说人话）', () => {
    const ref = resolveStageReference({ stageRef: { nodeId: 'gone', url: '/a.png', name: '旧图' } }, [] as never)
    expect(ref.url).toBe('/a.png')
    expect(ref.missing).toBe(true)
  })

  it('没连 → 空引用', () => {
    expect(resolveStageReference({}, [] as never)).toEqual({ url: '', name: '', nodeId: '', missing: false })
  })

  it('★ 上游被删就清空引用（不清的话节点一直显示「参考图已连」而实际取不到图）', () => {
    expect(clearedStageRef({ stageRef: { nodeId: 'n1' } }, new Set(['n1']))).toEqual({ stageRef: null })
    expect(clearedStageRef({ stageRef: { nodeId: 'n1' } }, new Set(['other']))).toBeNull()
    expect(clearedStageRef({}, new Set(['n1']))).toBeNull()
  })

  it('★ 参考图存 params.stageRef，不进 params.stage（后者是要落库的场景状态，有体积守卫）', async () => {
    const { readDirectorStageState, writeDirectorStageState } = await import('@/features/director-stage/types')
    const params = { stageRef: { nodeId: 'n1', url: '/a.png' } }
    // 写回场景状态时不许把 stageRef 弄丢，也不许把它塞进 stage
    const next = writeDirectorStageState(params, DEFAULT_DIRECTOR_STAGE_STATE) as Record<string, unknown>
    expect(next.stageRef).toEqual({ nodeId: 'n1', url: '/a.png' })
    expect(JSON.stringify(readDirectorStageState(next))).not.toContain('stageRef')
  })

  it('Canvas 有专门的路由，而且挂进了两条连线路径', () => {
    expect(CANVAS_SOURCE).toContain('const routeDirectorStageConnection')
    expect(CANVAS_SOURCE).toContain('if (routeDirectorStageConnection(source, target)) return')
    expect(CANVAS_SOURCE).toContain('!routeDirectorStageConnection(connMenu.sourceId, newNode.id)')
  })

  it('★ 只收一张参考图：新连一张会把旧入边替换掉', () => {
    const route = CANVAS_SOURCE.slice(
      CANVAS_SOURCE.indexOf('const routeDirectorStageConnection'),
      CANVAS_SOURCE.indexOf('图片对比节点的 A/B 输入'),
    )
    expect(route).toContain('es.filter(edge => edge.target !== targetNode.id)')
    expect(route).toContain('stageRef')
  })

  it('视频 / 音频 / 文本不占参考图位（它们没有可分析的人物姿势）', () => {
    const route = CANVAS_SOURCE.slice(
      CANVAS_SOURCE.indexOf('const routeDirectorStageConnection'),
      CANVAS_SOURCE.indexOf('图片对比节点的 A/B 输入'),
    )
    expect(route).toContain("sourceData.type === 'video'")
    expect(route).toContain("sourceData.type === 'audio'")
    expect(route).toContain("sourceData.type === 'text'")
  })

  it('删除清理块里补了 stageRef', () => {
    expect(CANVAS_SOURCE).toContain('clearedStageRef(params, removeSourceIds)')
  })
})

/*
 * 节点得能拖（2026-08-26 用户反馈「拖动区域太小」）。
 *
 * 三维空间节点的主体是一块占大半面积的预览区 / 空状态占位。它一旦挂上 nodrag，
 * 可拖的地方就只剩下面那条细窄的信息行 —— 节点几乎挪不动，而这件事在截图上完全看不出来，
 * 只有真去拖才知道。所以把「主体不许 nodrag、打开改成双击」钉在这里。
 */
describe('★ 节点主体单击拖动、双击才打开', () => {
  const body = NODE_SOURCE.slice(
    NODE_SOURCE.indexOf('{mainUrl ? ('),
    NODE_SOURCE.indexOf("fontSize: 11, color: '#8d83ab'"),
  )

  it('主体区域没有 nodrag（有的话就只剩信息行能拖）', () => {
    expect(body.length).toBeGreaterThan(400)
    expect(body, '预览区 / 占位区挂了 nodrag，节点就拖不动了').not.toContain('nodrag')
  })

  it('两种状态都是双击打开，不是单击', () => {
    // 有图：双击看大图（和 ImageNode 主图区一致）
    expect(body).toContain('setPreviewOpen(true)')
    // 没图：双击打开三维空间
    expect(body).toContain('setOpen(true)')
    expect((body.match(/onDoubleClick/g) ?? []).length).toBe(2)
    expect(body, '主体上不该再有单击打开').not.toMatch(/onClick=\{\(\) =>/)
  })

  it('双击要 stopPropagation（画布的 zoomOnDoubleClick 默认是开的）', () => {
    expect((body.match(/event\.stopPropagation\(\)/g) ?? []).length).toBe(2)
  })

  it('底部那个真按钮仍然是 nodrag（不然点它会把节点拖走）', () => {
    const action = NODE_SOURCE.slice(NODE_SOURCE.indexOf("fontSize: 11, color: '#8d83ab'"))
    expect(action).toContain('className="nodrag"')
    expect(action).toContain('onClick={() => setOpen(true)}')
  })

  it('工具栏里仍有「查看大图」—— 双击之外要留一条可发现的路', () => {
    expect(NODE_SOURCE).toContain("label: '查看大图'")
    expect(NODE_SOURCE).toContain("label: '打开三维空间'")
  })
})

describe('MediaPipe 那一步的接线（jsdom 跑不了 WASM，只能断言接线）', () => {
  it('★ 是动态 import，不能进主包（主包已经 3.9MB，是已知的加载瓶颈）', () => {
    expect(ESTIMATOR_SOURCE).toContain("await import('@mediapipe/tasks-vision')")
    expect(ESTIMATOR_SOURCE, '写成静态 import 就会被打进主包')
      .not.toMatch(/^import .*@mediapipe\/tasks-vision/m)
    expect(MODAL_SOURCE).toContain("await import('./poseEstimator')")
    expect(MODAL_SOURCE, '弹窗静态引用 poseEstimator 会把它拽回主包')
      .not.toMatch(/^import .*poseEstimator/m)
  })

  it('★ 模型和 WASM 都在我们自己域下（内网不能假设浏览器能出外网）', () => {
    expect(ESTIMATOR_SOURCE).toContain("POSE_MODEL_BASE = '/models'")
    expect(ESTIMATOR_SOURCE, '用了外部 CDN').not.toMatch(/storage\.googleapis\.com|cdn\.jsdelivr\.net|unpkg\.com/)
  })

  /*
   * 解姿势必须用 worldLandmarks（以髋中心为原点的三维米制坐标）。
   * 归一化图像坐标只有**一个**正当用途：算「手在画面哪儿」好裁出手来检测手指。
   * 所以这里不再一刀切禁用 result.landmarks，而是钉住两条去向不能互换 ——
   * 换反了姿势会被画面宽高比带偏，而且症状是「姿势有点怪」，很难查。
   */
  it('★ 姿势走 worldLandmarks，图像坐标只许拿去裁手', () => {
    expect(ESTIMATOR_SOURCE).toContain('result.worldLandmarks')
    const detect = ESTIMATOR_SOURCE.slice(
      ESTIMATOR_SOURCE.indexOf('export async function estimatePoseFromImage'),
      ESTIMATOR_SOURCE.indexOf('export async function estimateHandFromCrop'),
    )
    expect(detect.length).toBeGreaterThan(200)
    expect(detect, '姿势那一路必须来自 worldLandmarks').toMatch(/const world = .*worldLandmarks/)
    expect(detect, 'landmarks 字段（喂给 poseFromLandmarks 的）必须是世界坐标那一份')
      .toMatch(/\blandmarks: normalizeLandmarks\(first\)/)
    expect(detect, 'imageLandmarks 才是归一化图像坐标那一份')
      .toMatch(/imageLandmarks: normalizeLandmarks\(screen\[0\]\)/)
  })

  it('★ 手指也走 worldLandmarks（手指角度要三维方向）', () => {
    const hand = ESTIMATOR_SOURCE.slice(ESTIMATOR_SOURCE.indexOf('export async function estimateHandFromCrop'))
    expect(hand.length).toBeGreaterThan(200)
    expect(hand).toMatch(/const world = .*worldLandmarks/)
    expect(hand, '手部检测要喂裁剪后的 canvas，不是整张图').toContain('landmarker.detect(canvas)')
    expect(ESTIMATOR_SOURCE).toContain('export async function estimateHandsFromImage')
    expect(ESTIMATOR_SOURCE).toContain('export function assignHandsByWrist')
    expect(ESTIMATOR_SOURCE).toContain('numHands: 2')
  })

  it('★ 手指在身体之后解 —— 目标方向是用手腕当前朝向换算的', () => {
    const analyze = MODAL_SOURCE.slice(
      MODAL_SOURCE.indexOf('const analyzeReference = useCallback'),
      MODAL_SOURCE.indexOf('const undoAnalyze'),
    )
    expect(analyze.length).toBeGreaterThan(200)
    expect(analyze.indexOf('poseFromLandmarks(detection.landmarks)'), '身体那一步不见了')
      .toBeGreaterThan(-1)
    expect(analyze.indexOf('handFromLandmarks(nextPose'), '手指那一步不见了').toBeGreaterThan(-1)
    expect(analyze).toContain('estimateHandsFromImage')
    expect(
      analyze.indexOf('poseFromLandmarks(detection.landmarks)'),
      '手指解在身体之前 —— 手腕还没摆好，整只手会转过去',
    ).toBeLessThan(analyze.indexOf('handFromLandmarks(nextPose'))
  })

  it('默认连手指一起推，失败要写明左右手', () => {
    expect(MODAL_SOURCE).toContain('const [analyzeHands, setAnalyzeHands] = useState(true)')
    expect(MODAL_SOURCE).toContain('手没看清')
    expect(MODAL_SOURCE).toContain('手摆好')
    expect(MODAL_SOURCE).toContain("const label = side === 'L' ? '左' : '右'")
  })

  it('手部模型也是动态引入、也在自己域下', () => {
    expect(ESTIMATOR_SOURCE).toContain("HAND_MODEL_PATH = `${POSE_MODEL_BASE}/hand_landmarker.task`")
    expect(MODAL_SOURCE).toContain("await import('./handFromLandmarks')")
    expect(MODAL_SOURCE, '弹窗静态引用 handFromLandmarks 会把它拽回主包')
      .not.toMatch(/^import .*handFromLandmarks/m)
  })

  it('单张静态图模式（断言要限定在选项里，文件头的说明里也有这几个字）', () => {
    const options = ESTIMATOR_SOURCE.slice(
      ESTIMATOR_SOURCE.indexOf('PoseLandmarker.createFromOptions'),
      ESTIMATOR_SOURCE.indexOf('outputSegmentationMasks'),
    )
    expect(options.length, '找不到 createFromOptions 的选项块').toBeGreaterThan(20)
    expect(options).toContain("runningMode: 'IMAGE'")
    expect(options).toContain('numPoses: 1')
  })

  it('★ 加载失败要清缓存，否则一次网络抽风会让功能整个会话失效', () => {
    /*
     * 必须限定在 catch 里断言：`landmarkerPromise = null` 在
     * `resetPoseLandmarkerForTests` 里也有一句，全文件 grep 的话
     * 把 catch 里那句删掉照样能过（这条断言第一版就是这么漏的）。
     */
    const catchBlock = ESTIMATOR_SOURCE.slice(
      ESTIMATOR_SOURCE.indexOf('})().catch('),
      ESTIMATOR_SOURCE.indexOf('return landmarkerPromise'),
    )
    expect(catchBlock.length, '找不到 catch 块，正则失效了').toBeGreaterThan(20)
    expect(catchBlock, 'catch 里没有把缓存清掉').toContain('landmarkerPromise = null')
  })

  it('三种失败各有说法，不把英文异常甩给用户', () => {
    for (const kind of ['load-failed', 'no-person', 'image-failed']) {
      expect(ESTIMATOR_SOURCE, kind).toContain(`'${kind}'`)
    }
  })

  it('界面有分析按钮、等待态、以及一步「撤销分析」', () => {
    expect(MODAL_SOURCE).toContain('分析参考图姿势')
    expect(MODAL_SOURCE).toContain('正在分析…')
    expect(MODAL_SOURCE, '首次要下 21MB，不能只把按钮置灰').toContain('POSE_FIRST_LOAD_MB')
    expect(MODAL_SOURCE).toContain('撤销分析')
    expect(MODAL_SOURCE).toContain('setPoseBeforeAnalyze(state.pose)')
  })

  it('★ 分析只改姿势，不动机位（你明确要的）', () => {
    const handler = MODAL_SOURCE.slice(
      MODAL_SOURCE.indexOf('const analyzeReference'),
      MODAL_SOURCE.indexOf('const undoAnalyze'),
    )
    // 第二个参数 null = 这次分析在撤销历史里独占一条（不和别的操作合并）
    expect(handler).toContain('setPose(nextPose, null)')
    expect(handler, '分析不该碰机位').not.toMatch(/patchCamera|setState\(\s*\(prev\)\s*=>\s*\(\{\s*\.\.\.prev,\s*camera/)
  })

  it('首次下载体积两处写的是同一个数（弹窗那份是为了不把 estimator 拽进主包）', () => {
    const inModal = /POSE_FIRST_LOAD_MB = (\d+)/.exec(MODAL_SOURCE)?.[1]
    const inEstimator = /POSE_FIRST_LOAD_MB = (\d+)/.exec(ESTIMATOR_SOURCE)?.[1]
    expect(inModal).toBeTruthy()
    expect(inModal).toBe(inEstimator)
  })
})

describe('视图右上角可以藏关节控制', () => {
  it('焦距信息下面有隐藏 / 显示关节按钮，并接到三维视图', () => {
    expect(MODAL_SOURCE).toContain('隐藏关节')
    expect(MODAL_SOURCE).toContain('显示关节')
    expect(MODAL_SOURCE).toContain('setShowJointHandles')
    expect(MODAL_SOURCE).toContain('showJointHandles={showJointHandles}')
    expect(CSS_SOURCE).toContain('.director-stage-handle-toggle')
  })

  it('隐藏按钮下面有关节大小滑条，并接到三维视图', () => {
    expect(MODAL_SOURCE).toContain('关节大小')
    expect(MODAL_SOURCE).toContain('setJointHandleScale')
    expect(MODAL_SOURCE).toContain('jointHandleScale={jointHandleScale}')
    expect(CSS_SOURCE).toContain('.director-stage-handle-scale')
  })
})
