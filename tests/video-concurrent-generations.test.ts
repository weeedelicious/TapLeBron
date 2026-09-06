/**
 * 视频节点并发生成（2026-08-19 用户要求：上一条没生成完再点生成，不要覆盖，两条都继续跑、
 * 都能看到；失败的那条在多视频里留一个空位加红色报错）。
 *
 * 改造前的语义是「一个节点同时只有一次有效生成」，前后端各一半：
 *   服务端 JobService.createPersistentTask 把同节点其它 pending 任务标成 superseded；
 *   前端 tasksStore 的 isCurrentTask 要求 jobId 等于节点当前 taskInfo.taskId，否则丢弃。
 * 于是点第二次生成，第一次的结果永远不会被采用。
 *
 * 现在：任务登记在 _pendingTasks 里，谁完成谁追加；失败的进 _failedGenerations。
 * 这里锁四件事 —— 两条并存、先完成的不被后来的顶掉、结果是追加不是替换、失败留痕。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const pollResponses = new Map<string, unknown>()
const poll = vi.fn(async (jobId: string) => {
  const res = pollResponses.get(jobId)
  if (!res) return { status: 1, progressPercent: 10, urls: [], meta: {} }
  return res
})

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
  poll.mockClear()
  pollResponses.clear()
  useCanvasStore.setState({ nodes: [], edges: [], projectUuid: '' })
  useTasksStore.setState({ tasks: {} })
  useCanvasStore.setState({ persistNodesAndWait: (async () => true) as never })
})

function videoNode() {
  return useCanvasStore.getState().addNodeAt('video', 0, 0, {
    params: {
      model: 'Seedance_2_5',
      modeType: 'omni',
      prompt: '起飞',
      settings: { ratio: '16:9', resolution: '720P', duration: 5, enableSound: 'on' },
    } as unknown as Record<string, unknown>,
  })
}

function nodeData(id: string) {
  return useCanvasStore.getState().nodes.find((n) => n.id === id)?.data
}

function done(urls: string[]) {
  return { status: 2, progressPercent: 100, urls, meta: { generationVersion: 1, applyStatus: 'pending' } }
}

describe('视频节点并发生成', () => {
  it('连点两次生成，两条任务同时登记在案（不再互相取代）', () => {
    const node = videoNode()
    useTasksStore.getState().addTask('job-a', node.id, 1)
    useTasksStore.getState().addTask('job-b', node.id, 2)

    const pending = nodeData(node.id)?._pendingTasks ?? {}
    expect(Object.keys(pending).sort()).toEqual(['job-a', 'job-b'])
    // taskInfo 仍指最新那条，老代码读它不会变味
    expect(nodeData(node.id)?.taskInfo?.taskId).toBe('job-b')
  })

  it('后发的先完成，也不会让先发的那条失效', async () => {
    const node = videoNode()
    useTasksStore.getState().addTask('job-a', node.id, 1)
    useTasksStore.getState().addTask('job-b', node.id, 2)

    pollResponses.set('job-b', done(['/assets/1/b.mp4']))
    useTasksStore.getState().startPolling('job-b', 'p1')
    await vi.waitFor(() => {
      expect(nodeData(node.id)?.url).toContain('/assets/1/b.mp4')
    }, { timeout: 20000 })

    // 先发的那条必须还在 pending 里 —— 以前它会被判死、轮询直接停掉
    expect(Object.keys(nodeData(node.id)?._pendingTasks ?? {})).toContain('job-a')

    pollResponses.set('job-a', done(['/assets/1/a.mp4']))
    useTasksStore.getState().startPolling('job-a', 'p1')
    await vi.waitFor(() => {
      expect(nodeData(node.id)?.url).toContain('/assets/1/a.mp4')
    }, { timeout: 20000 })

    // 两条结果都在，且是追加不是替换
    expect(nodeData(node.id)?.url).toEqual(expect.arrayContaining(['/assets/1/b.mp4', '/assets/1/a.mp4']))
    expect(Object.keys(nodeData(node.id)?._pendingTasks ?? {})).toHaveLength(0)
    // 主视频认第一条落地的，不被后完成的抢走
    expect(nodeData(node.id)?._primaryAssetUrl).toBe('/assets/1/b.mp4')
  }, 45000)

  it('其中一条失败：留下红色报错记录，另一条照常完成', async () => {
    const node = videoNode()
    useTasksStore.getState().addTask('job-ok', node.id, 1)
    useTasksStore.getState().addTask('job-bad', node.id, 2)

    pollResponses.set('job-bad', { status: 3, progressPercent: 0, urls: [], error: '参考图不合规', meta: {} })
    useTasksStore.getState().startPolling('job-bad', 'p1')
    await vi.waitFor(() => {
      expect(nodeData(node.id)?._failedGenerations?.length).toBe(1)
    }, { timeout: 20000 })

    const failed = nodeData(node.id)?._failedGenerations?.[0]
    expect(failed?.taskId).toBe('job-bad')
    expect(failed?.error).toContain('参考图不合规')
    expect(failed?.resolution).toBe('720P')
    expect(failed?.ratio).toBe('16:9')
    // 失败的那条从"在跑的"里摘掉，好的那条不受影响
    expect(Object.keys(nodeData(node.id)?._pendingTasks ?? {})).toEqual(['job-ok'])

    pollResponses.set('job-ok', done(['/assets/1/ok.mp4']))
    useTasksStore.getState().startPolling('job-ok', 'p1')
    await vi.waitFor(() => {
      expect(nodeData(node.id)?.url).toContain('/assets/1/ok.mp4')
    }, { timeout: 20000 })
    // 失败记录不因为另一条成功而消失
    expect(nodeData(node.id)?._failedGenerations?.length).toBe(1)
  }, 45000)

  it('老画布（没有 _pendingTasks）仍按 taskInfo 判定，不把任务判死', async () => {
    const node = videoNode()
    // 手写成改造之前的形状：只有 taskInfo，没有 _pendingTasks
    useTasksStore.getState().addTask('job-legacy', node.id, 1)
    useCanvasStore.getState().updateNodeData(node.id, { _pendingTasks: undefined })
    expect(nodeData(node.id)?._pendingTasks).toBeUndefined()

    pollResponses.set('job-legacy', done(['/assets/1/legacy.mp4']))
    useTasksStore.getState().startPolling('job-legacy', 'p1')
    await vi.waitFor(() => {
      expect(nodeData(node.id)?.url).toContain('/assets/1/legacy.mp4')
    }, { timeout: 20000 })
  }, 45000)
})
