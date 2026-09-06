/**
 * 「视频生成完了，进度条还挂在下面不消失」（2026-08-19 线上实证）。
 *
 * 根因：_pendingTasks 只在"跑完"和"失败"两条路上被摘掉。取消、被作废、轮询超时这几条
 * 只调了 removeTask 就走了，节点上留下一条 loading:true 的僵尸条目 —— 进度条永远挂着、
 * 计时一直涨。图片分支同样漏摘，留下 loading:false 的条目，白占画布 JSON
 * （线上画布 278 当时已堆了 16 条，另有 3 条 cancelled 的留着 loading=true）。
 *
 * 修法是把摘除放进 removeTask 这个唯一收口 —— 任务不管怎么退场都会走它。
 * 这里就按各种退场方式验一遍。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const poll = vi.fn()

vi.mock('@/lib/api', () => ({
  nodesApi: {
    upsert: vi.fn(async () => ({ ok: true, nodeVersion: 1, contentVersion: 'cv' })),
    deleteNode: vi.fn(async () => ({ ok: true, deleted: true })),
    delete: vi.fn(async () => ({ data: { contentVersion: 'cv' } })),
    batchSave: vi.fn(),
    events: vi.fn(async () => []),
  },
  projectsApi: { get: vi.fn(), saveDraft: vi.fn(async () => ({})) },
  generateApi: {
    poll: (jobId: string) => poll(jobId),
    apply: vi.fn(async () => ({})),
    orphan: vi.fn(async () => ({})),
    recover: vi.fn(async () => ({})),
    cancel: vi.fn(async () => ({})),
    activeTasks: vi.fn(async () => ({ tasks: [] })),
  },
  CANVAS_CLIENT_ID: 'test-client',
}))

const { useCanvasStore } = await import('@/store/canvasStore')
const { useTasksStore } = await import('@/store/tasksStore')

beforeEach(() => {
  poll.mockReset()
  useCanvasStore.setState({ nodes: [], edges: [], projectUuid: '' })
  useTasksStore.setState({ tasks: {} })
  useCanvasStore.setState({ persistNodesAndWait: (async () => true) as never })
})

function nodeOf(type: 'video' | 'image', id?: string) {
  return useCanvasStore.getState().addNodeAt(type, 0, 0, {
    params: {
      model: type === 'video' ? 'Seedance_2_5' : 'gpt-image-2',
      modeType: 'omni',
      prompt: 'x',
      settings: { ratio: '16:9', resolution: '720P', duration: 5, enableSound: 'on' },
    } as unknown as Record<string, unknown>,
    ...(id ? { name: id } : {}),
  })
}

function pendingOf(id: string) {
  return useCanvasStore.getState().nodes.find((n) => n.id === id)?.data._pendingTasks ?? {}
}

describe('在跑列表的清理', () => {
  it('点取消之后，那条不能留在在跑列表里（否则进度条永挂）', () => {
    const node = nodeOf('video')
    useTasksStore.getState().addTask('job-cancel', node.id, 1)
    expect(Object.keys(pendingOf(node.id))).toEqual(['job-cancel'])

    useTasksStore.getState().cancelTask('job-cancel', node.id)
    expect(Object.keys(pendingOf(node.id))).toEqual([])
  })

  it('取消其中一条，另一条不受影响', () => {
    const node = nodeOf('video')
    useTasksStore.getState().addTask('job-a', node.id, 1)
    useTasksStore.getState().addTask('job-b', node.id, 2)

    useTasksStore.getState().cancelTask('job-a', node.id)
    expect(Object.keys(pendingOf(node.id))).toEqual(['job-b'])
  })

  it('被服务端判为已作废（shouldApply=false）时也要摘掉', async () => {
    const node = nodeOf('video')
    useTasksStore.getState().addTask('job-superseded', node.id, 1)
    poll.mockResolvedValue({
      status: 1,
      progressPercent: 30,
      urls: [],
      meta: { shouldApply: false, applyStatus: 'superseded' },
    })
    useTasksStore.getState().startPolling('job-superseded', 'p1')

    await vi.waitFor(() => {
      expect(Object.keys(pendingOf(node.id))).toEqual([])
    }, { timeout: 20000 })
  }, 30000)

  it('图片任务跑完也要摘掉，不能往画布里堆条目', async () => {
    const node = nodeOf('image')
    useTasksStore.getState().addTask('job-image', node.id, 1)
    poll.mockResolvedValue({
      status: 2,
      progressPercent: 100,
      urls: ['/assets/1/img.png'],
      meta: { generationVersion: 1, applyStatus: 'pending' },
    })
    useTasksStore.getState().startPolling('job-image', 'p1')

    await vi.waitFor(() => {
      expect(useCanvasStore.getState().nodes.find((n) => n.id === node.id)?.data.url)
        .toContain('/assets/1/img.png')
    }, { timeout: 20000 })
    expect(Object.keys(pendingOf(node.id))).toEqual([])
  }, 30000)

  it('removeTask 是唯一收口：直接调它也会摘掉', () => {
    const node = nodeOf('video')
    useTasksStore.getState().addTask('job-direct', node.id, 1)
    useTasksStore.getState().removeTask('job-direct')
    expect(Object.keys(pendingOf(node.id))).toEqual([])
  })
})
