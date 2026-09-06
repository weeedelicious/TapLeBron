/**
 * 「画布一开就黑屏」的回归测试（2026-08-18 18:05 事故）。
 *
 * 根因：CindyAssistantPanel 里 `if (enabled !== true) return null` 是早退，而附图那几个
 * hook（useState / useRef / useCallback）被写在了早退**之后**。于是：
 *   第一帧 —— status 还没回来，enabled = null，早退，只跑前面的 hook；
 *   第二帧 —— status 回来 enabled = true，多跑 6 个 hook；
 * React 抛 "Rendered more hooks than during the previous render" 并卸载整棵树 ——
 * 用户看到的就是「闪了下就黑屏」。只有名单内能用 Cindy 的人会中，因为别人 enabled 永远 false。
 *
 * 这个测试就照事故顺序来：先渲染成没启用，再让 status 变成启用，然后要求没有崩。
 * 把那几个 hook 挪回早退之后，它必须失败 —— 否则这测试没有意义。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const statusMock = vi.fn()

// 只替掉网络那层，模块里其余导出（cindyModesFromStatus 等纯函数）用真实实现 ——
// 整个模块换成手写对象的话，以后往里加一个导出，这里就会静默变成 undefined。
vi.mock('@/lib/cindyAssistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cindyAssistant')>()),
  cindyAssistantApi: {
    status: () => statusMock(),
    listMessages: vi.fn(async () => ({ messages: [] })),
    sendMessage: vi.fn(async () => ({ userMessage: null, assistantMessage: null })),
    setProposalStatus: vi.fn(),
    skills: vi.fn(async () => ({ skills: {} })),
  },
}))

vi.mock('@/lib/api', () => ({
  assetsApi: { upload: vi.fn(async () => ({ url: '/assets/1/x.png' })) },
}))

vi.mock('@/lib/uploadPrep', () => ({
  prepareAssetForUpload: vi.fn(async (file: File) => file),
}))

vi.mock('@/store/canvasStore', () => ({
  useCanvasStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      nodes: [],
      edges: [],
      projectUuid: 'p1',
      cindyMode: 'default',
      cindyModes: ['default'],
      setCindyEnabled: () => {},
      setCindyModes: () => {},
    }
    return typeof selector === 'function' ? selector(state) : state
  },
}))

const { CindyAssistantPanel } = await import('@/components/CindyAssistantPanel')

const canvasContext = { canvasName: '测试画布', nodes: [], edges: [], selectedNodeIds: [] }

let container: HTMLDivElement
let root: Root
let errors: unknown[]
let restoreConsole: (() => void) | null = null

beforeEach(() => {
  errors = []
  // React 把渲染期异常打到 console.error 之后再抛；两条路都拦住，避免"崩了但测试还绿"
  const original = console.error
  console.error = (...args: unknown[]) => { errors.push(args[0]) }
  restoreConsole = () => { console.error = original }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restoreConsole?.()
  statusMock.mockReset()
})

function render() {
  act(() => {
    root.render(
      <CindyAssistantPanel
        projectUuid="p1"
        canvasContext={canvasContext}
        onApplyProposal={async () => ({ nodesCreated: 0, connectionsCreated: 0 })}
      />,
    )
  })
}

describe('CindyAssistantPanel 的 hook 顺序', () => {
  it('status 从未启用变成启用时不许崩（hook 数量必须两帧一致）', async () => {
    let resolveStatus: (value: unknown) => void = () => {}
    statusMock.mockImplementation(() => new Promise(resolve => { resolveStatus = resolve }))

    render() // 第一帧：enabled 还是 null，走早退
    expect(container.innerHTML).toBe('')

    await act(async () => {
      resolveStatus({ enabled: true, model: 'test', capabilities: [], safety: null })
    })

    const hookError = errors.find(e => String(e).includes('Rendered more hooks') || String(e).includes('Rendered fewer hooks'))
    expect(hookError, `React hook 数量报错：${String(hookError)}`).toBeUndefined()
    // 启用后按钮必须真的挂出来（否则等于什么都没渲染，测试会变成永绿）
    expect(container.querySelector('button')).not.toBeNull()
  })

  it('没启用时安静地什么都不渲染', async () => {
    statusMock.mockResolvedValue({ enabled: false, model: null, capabilities: [], safety: null })
    render()
    await act(async () => { await Promise.resolve() })
    expect(container.innerHTML).toBe('')
  })
})
