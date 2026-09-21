/**
 * 细化纹理改成「点生成就建节点、不在弹窗里等」之后的行为锁定（2026-08-19 用户要求）。
 *
 * 要保证三件事：
 *   1. 点一次生成，节点**当场**就在，并且是「生成中」的样子 —— 等待发生在画布上，不是弹窗里；
 *   2. 结果回来才填进那个节点，不需要人再点「派生」；
 *   3. 再点一次生成就**再多一个**节点，绝不顶掉上一次的结果（这是用户明确要的）。
 * 顺带锁住失败时节点要留着并带上原因 —— 悄悄删掉等于让人以为没花钱。
 *
 * 2026-08-21 补：连**准备控制素材**也搬到了这个任务里（用户反馈"弹窗里要等很长时间"）。
 * 所以还要锁住：没预加载素材时任务自己去准备；预加载过就复用、绝不重复跑一遍语义分区推理
 * （服务端那一步没有缓存，白跑就是白等几十秒）；以及语义分区不可用时必须在**调用付费生图
 * 之前**停下 —— 拿不到类别图就算生成了也没法安全融合。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const repair = vi.fn()
const prepareAssets = vi.fn()

vi.mock('@/lib/api', () => ({
  nodesApi: {
    upsert: vi.fn(async () => ({ ok: true, nodeVersion: 1, contentVersion: 'cv' })),
    deleteNode: vi.fn(async () => ({ ok: true, deleted: true })),
    delete: vi.fn(async () => ({ data: { contentVersion: 'cv' } })),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  textureClarityApi: {
    repair: (input: unknown) => repair(input),
    assets: (input: unknown) => prepareAssets(input),
  },
  CANVAS_CLIENT_ID: 'test-client',
}))

const { useCanvasStore } = await import('@/store/canvasStore')
const { startTextureClarityRepair } = await import('@/features/texture-clarity/textureClarityJob')

const assets = {
  source: { url: '/assets/1/source.png', width: 1024, height: 1536, status: 'generated' },
  semantic: { classMapUrl: '/assets/1/classmap.png', previewUrl: '/assets/1/semantic.png', status: 'generated', mode: 'parts', modelId: 'seg/x', labelSet: 'v1' },
  geometry: { depthUrl: '/assets/1/depth.png', normalUrl: '/assets/1/normal.png', status: 'generated' },
  sourceHash: 'hash-1',
  assetVersion: 3,
  fusionPolicy: 'edge-v2',
} as unknown as NonNullable<Parameters<typeof startTextureClarityRepair>[0]['assets']>

/** 弹窗里点过预览的路径：素材带过来，任务应该跳过准备 */
function run(sourceId: string) {
  return startTextureClarityRepair({
    projectUuid: 'p1',
    sourceNodeId: sourceId,
    sourceNodePos: { x: 0, y: 0 },
    sourceUrl: '/assets/1/raw.png',
    assets,
    model: 'gemini-3-pro-image',
  })
}

/** 默认路径：弹窗里什么都没等，任务自己准备 */
function runWithoutPreview(sourceId: string) {
  return startTextureClarityRepair({
    projectUuid: 'p1',
    sourceNodeId: sourceId,
    sourceNodePos: { x: 0, y: 0 },
    sourceUrl: '/assets/1/raw.png',
    model: 'gemini-3-pro-image',
  })
}

function nodeById(id: string) {
  return useCanvasStore.getState().nodes.find((n) => n.id === id)
}

const okRepair = {
  fusedUrl: '/assets/1/fused.png',
  requestModel: 'm', resolvedModel: 'm', generationCalls: 1,
  generationMs: 1, fusionMs: 1, passed: true, failures: [], diagnostics: {},
}

beforeEach(() => {
  repair.mockReset()
  prepareAssets.mockReset()
  prepareAssets.mockResolvedValue(assets)
  useCanvasStore.setState({ nodes: [], edges: [], projectUuid: '' })
})

describe('细化纹理生成', () => {
  it('点生成后节点当场就在，且处于生成中（不用等结果）', () => {
    const source = useCanvasStore.getState().addNodeAt('image', 0, 0)
    let resolveRepair: (value: unknown) => void = () => {}
    repair.mockImplementation(() => new Promise((resolve) => { resolveRepair = resolve }))

    const derivedId = run(source.id)

    const derived = nodeById(derivedId)
    expect(derived).toBeTruthy()
    expect(derived?.data.taskInfo?.loading).toBe(true)
    expect(derived?.data.url).toEqual([])
    // 连线也必须当场就在
    const { edges } = useCanvasStore.getState()
    expect(edges.some((e) => e.source === source.id && e.target === derivedId)).toBe(true)
    void resolveRepair
  })

  it('结果回来自动填进节点，不需要再点派生', async () => {
    const source = useCanvasStore.getState().addNodeAt('image', 0, 0)
    repair.mockResolvedValue({
      fusedUrl: '/assets/1/fused.png',
      candidateUrl: '/assets/1/candidate.png',
      requestModel: 'gemini-3-pro-image',
      resolvedModel: 'gemini-3-pro-image-002',
      generationCalls: 1,
      generationMs: 4200,
      fusionMs: 800,
      passed: true,
      failures: [],
      diagnostics: { outsideChangedPixels: 0 },
    })

    const derivedId = run(source.id)
    await vi.waitFor(() => {
      expect(nodeById(derivedId)?.data.url).toEqual(['/assets/1/fused.png'])
    })
    expect(nodeById(derivedId)?.data.taskInfo).toBeUndefined()
    const meta = (nodeById(derivedId)?.data.params as Record<string, any>)?.textureClarity
    expect(meta.resolvedModel).toBe('gemini-3-pro-image-002')
    expect(meta.sourceNodeKey).toBe(source.id)
  })

  it('再点一次生成是多一个节点，不顶掉上一次的结果', async () => {
    const source = useCanvasStore.getState().addNodeAt('image', 0, 0)
    repair.mockResolvedValue({
      fusedUrl: '/assets/1/first.png',
      requestModel: 'm', resolvedModel: 'm', generationCalls: 1,
      generationMs: 1, fusionMs: 1, passed: true, failures: [], diagnostics: {},
    })
    const firstId = run(source.id)
    await vi.waitFor(() => expect(nodeById(firstId)?.data.url).toEqual(['/assets/1/first.png']))

    repair.mockResolvedValue({
      fusedUrl: '/assets/1/second.png',
      requestModel: 'm', resolvedModel: 'm', generationCalls: 1,
      generationMs: 1, fusionMs: 1, passed: true, failures: [], diagnostics: {},
    })
    const secondId = run(source.id)
    await vi.waitFor(() => expect(nodeById(secondId)?.data.url).toEqual(['/assets/1/second.png']))

    expect(secondId).not.toBe(firstId)
    // 第一次的结果必须原样留着
    expect(nodeById(firstId)?.data.url).toEqual(['/assets/1/first.png'])
    // 两个节点都连着源节点
    const { edges } = useCanvasStore.getState()
    expect(edges.filter((e) => e.source === source.id).map((e) => e.target).sort())
      .toEqual([firstId, secondId].sort())
  })

  it('失败时节点留着并带上原因', async () => {
    const source = useCanvasStore.getState().addNodeAt('image', 0, 0)
    repair.mockRejectedValue(new Error('语义分区不可用'))

    const derivedId = run(source.id)
    await vi.waitFor(() => {
      expect(nodeById(derivedId)?.data.taskInfo?.status).toBe(3)
    })
    expect(nodeById(derivedId)).toBeTruthy()
    expect(String(nodeById(derivedId)?.data.taskInfo?.error)).toContain('语义分区不可用')
  })
})

describe('细化纹理的准备阶段搬到节点上', () => {
  it('没预加载素材时任务自己先准备，弹窗一步都不用等', async () => {
    const source = useCanvasStore.getState().addNodeAt('image', 0, 0)
    repair.mockResolvedValue(okRepair)

    const derivedId = runWithoutPreview(source.id)

    // 节点当场就在，且第一阶段就写明在准备素材
    const derived = nodeById(derivedId)
    expect(derived?.data.taskInfo?.loading).toBe(true)
    expect(derived?.data.taskInfo?.phaseLabel).toBe('准备控制素材 1/2')

    await vi.waitFor(() => {
      expect(nodeById(derivedId)?.data.url).toEqual(['/assets/1/fused.png'])
    })
    // 准备用的是节点上的原图；修复用的是准备后规范化的源图
    expect(prepareAssets).toHaveBeenCalledTimes(1)
    expect(prepareAssets.mock.calls[0][0]).toMatchObject({ sourceUrl: '/assets/1/raw.png' })
    expect(repair.mock.calls[0][0]).toMatchObject({
      sourceUrl: '/assets/1/source.png',
      classMapUrl: '/assets/1/classmap.png',
      semanticMode: 'parts',
    })
  })

  it('进入生成阶段时进度条换成第二步，不再显示"准备"', async () => {
    const source = useCanvasStore.getState().addNodeAt('image', 0, 0)
    let resolveRepair: (value: unknown) => void = () => {}
    repair.mockImplementation(() => new Promise((resolve) => { resolveRepair = resolve }))

    const derivedId = runWithoutPreview(source.id)
    await vi.waitFor(() => {
      expect(nodeById(derivedId)?.data.taskInfo?.phaseLabel).toBe('生成修复 2/2')
    })
    expect(nodeById(derivedId)?.data.taskInfo?.loading).toBe(true)
    void resolveRepair
  })

  it('弹窗里预览过就复用那份素材，绝不重复跑一遍语义分区', async () => {
    const source = useCanvasStore.getState().addNodeAt('image', 0, 0)
    repair.mockResolvedValue(okRepair)

    const derivedId = run(source.id)
    // 只有一步，步号不该写成 2/2
    expect(nodeById(derivedId)?.data.taskInfo?.phaseLabel).toBe('生成修复')

    await vi.waitFor(() => {
      expect(nodeById(derivedId)?.data.url).toEqual(['/assets/1/fused.png'])
    })
    expect(prepareAssets).not.toHaveBeenCalled()
  })

  it('准备阶段失败时节点留着、写明是准备这一步炸的，且不去调付费的生图', async () => {
    const source = useCanvasStore.getState().addNodeAt('image', 0, 0)
    prepareAssets.mockRejectedValue(new Error('几何服务连不上'))

    const derivedId = runWithoutPreview(source.id)
    await vi.waitFor(() => {
      expect(nodeById(derivedId)?.data.taskInfo?.status).toBe(3)
    })
    expect(nodeById(derivedId)).toBeTruthy()
    expect(String(nodeById(derivedId)?.data.taskInfo?.error)).toContain('几何服务连不上')
    expect(nodeById(derivedId)?.data.taskInfo?.phaseLabel).toBe('准备控制素材 1/2')
    expect(repair).not.toHaveBeenCalled()
  })

  it('语义分区不可用时在扣费之前停下 —— 拿不到类别图就没法安全融合', async () => {
    const source = useCanvasStore.getState().addNodeAt('image', 0, 0)
    prepareAssets.mockResolvedValue({
      ...assets,
      semantic: { status: 'failed', reason: '分区服务超时' },
    })

    const derivedId = runWithoutPreview(source.id)
    await vi.waitFor(() => {
      expect(nodeById(derivedId)?.data.taskInfo?.status).toBe(3)
    })
    const message = String(nodeById(derivedId)?.data.taskInfo?.error)
    expect(message).toContain('语义分区不可用')
    expect(message).toContain('分区服务超时')
    // 这是这条断言的全部意义：一次生图都不许发出去
    expect(repair).not.toHaveBeenCalled()
  })
})
