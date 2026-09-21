/**
 * 视频节点每条产物的生成信息（2026-08-19 用户要求：点开多视频节点要能看到对应视频的
 * 关键词和模型 / 比例 / 分辨率）。
 *
 * 原来只有**图片**分支往 _assetGenerationMeta 里写，视频分支只写 params.history，
 * 于是视频查看器里「模型 / 生成分辨率 / 生成时间」永远是「—」。查看器本身早就会读
 * _assetGenerationMeta 了（还会拿 resolution 当缩略图角标），缺的只是没人写。
 *
 * 这里直接验 tasksStore 完成任务后写进节点的东西 —— 不是验某个内部小函数。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const poll = vi.fn()
const apply = vi.fn(async () => ({}))

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
    apply: (...args: unknown[]) => apply(...(args as [])),
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
  apply.mockReset()
  useCanvasStore.setState({ nodes: [], edges: [], projectUuid: '' })
  useTasksStore.setState({ tasks: {} })
})

function videoNodeWithSettings() {
  const node = useCanvasStore.getState().addNodeAt('video', 0, 0, {
    params: {
      model: 'Seedance_2_5',
      modeType: 'omni',
      prompt: '超级炫酷起飞',
      settings: { ratio: '16:9', resolution: '1080P', duration: 4, enableSound: 'on' },
    } as unknown as Record<string, unknown>,
  })
  return node
}

function nodeById(id: string) {
  return useCanvasStore.getState().nodes.find((n) => n.id === id)
}

describe('视频产物的生成信息', () => {
  it('任务完成后把模型 / 分辨率 / 比例 / 时长 / 模式 / 提示词按产物地址写进节点', async () => {
    const node = videoNodeWithSettings()
    // persistNodesAndWait 要返回 true，否则 tasksStore 走的是 recover 分支
    useCanvasStore.setState({ persistNodesAndWait: (async () => true) as never })

    useTasksStore.getState().addTask('job-1', node.id, 1)
    poll.mockResolvedValue({
      status: 2,
      progressPercent: 100,
      urls: ['/assets/1/out.mp4'],
      meta: {
        generationVersion: 1,
        applyStatus: 'pending',
        model: 'Seedance_2_5',
        outputs: [{ index: 0, url: '/assets/1/out.mp4', metadata: { fps: 24 } }],
      },
    })
    useTasksStore.getState().startPolling('job-1', 'p1')

    await vi.waitFor(() => {
      expect(nodeById(node.id)?.data.url).toContain('/assets/1/out.mp4')
    }, { timeout: 20000 })

    const meta = nodeById(node.id)?.data._assetGenerationMeta?.['/assets/1/out.mp4']
    expect(meta).toBeTruthy()
    expect(meta?.model).toBe('Seedance_2_5')
    expect(meta?.resolution).toBe('1080P')
    expect(meta?.ratio).toBe('16:9')
    expect(meta?.durationSec).toBe(4)
    expect(meta?.fps).toBe(24)
    expect(meta?.modeType).toBe('omni')
    expect(meta?.prompt).toBe('超级炫酷起飞')
    expect(meta?.taskId).toBe('job-1')
  }, 30000)
})
