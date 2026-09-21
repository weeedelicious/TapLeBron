/**
 * 细化纹理弹窗必须**秒开**（2026-08-21 用户反馈"点细化纹理，弹窗里要等很长时间"）。
 *
 * 原来的行为：一打开就同步调 /texture-clarity/assets，那一步要跑 4090 上的语义分区和
 * MoGe-2 深度/法线，几十秒；这期间四个素材格全是「准备中」、「生成修复」是灰的，人只能等。
 *
 * 现在的约定，这个测试逐条锁住：
 *   1. 打开时**一次网络请求都不发** —— 谁哪天又把 assets() 挪回 mount 的 effect 里，这条会红；
 *   2. 「生成修复」第一帧就可点，不等任何素材；
 *   3. 点它是把 assets=null 交出去（让节点自己准备）并关窗，不在弹窗里等；
 *   4. 主动点「加载控制素材预览」才会发那个请求，而且发完之后再生成会**复用**这份结果
 *      （服务端语义分区没有缓存，重复调用就是白等几十秒 + 白烧一次 GPU）。
 *
 * 用真 DOM 挂载而不是只测纯函数：这个组件是 portal 到 body 的，8-18 的黑屏就是这类组件的
 * hook 顺序出的事，挂一次能同时兜住那一类问题。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const assetsMock = vi.fn()
const statusMock = vi.fn()

vi.mock('@/lib/api', () => ({
  textureClarityApi: {
    assets: (input: unknown) => assetsMock(input),
    serviceStatus: () => statusMock(),
    repair: vi.fn(),
  },
}))

const STATUS_UP = {
  semantic: { configured: true, ok: true, reason: '' },
  geometry: { configured: true, ok: true, reason: '' },
  canRepair: true,
  checkedAtMs: 1,
}
const STATUS_SEMANTIC_DOWN = {
  semantic: { configured: true, ok: false, reason: 'connect ETIMEDOUT 172.26.166.238:8092' },
  geometry: { configured: true, ok: true, reason: '' },
  canRepair: false,
  checkedAtMs: 1,
}
const STATUS_SEMANTIC_FALLBACK = {
  semantic: {
    configured: true,
    ok: false,
    fallbackAvailable: true,
    reason: 'Request failed with status code 500',
  },
  geometry: { configured: true, ok: true, reason: '' },
  canRepair: true,
  checkedAtMs: 1,
}

const { TextureClarityEditor } = await import('@/features/texture-clarity/TextureClarityEditor')

const READY_ASSETS = {
  source: { url: '/assets/p1/source.png', width: 1024, height: 1536, status: 'generated' },
  semantic: {
    classMapUrl: '/assets/p1/classmap.png',
    previewUrl: '/assets/p1/semantic.png',
    status: 'generated',
    modelId: 'seg/x',
    labelSet: 'v1',
    classes: [],
  },
  geometry: { depthUrl: '/assets/p1/depth.png', normalUrl: '/assets/p1/normal.png', status: 'generated' },
  sourceHash: 'hash-1',
  assetVersion: 3,
  fusionPolicy: 'edge-v2',
}

let container: HTMLDivElement
let root: Root
let errors: unknown[]
let restoreConsole: (() => void) | null = null
let generated: { assets: unknown; model: string }[]
let closed: number

beforeEach(() => {
  errors = []
  generated = []
  closed = 0
  const original = console.error
  console.error = (...args: unknown[]) => { errors.push(args[0]) }
  restoreConsole = () => { console.error = original }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  assetsMock.mockReset()
  statusMock.mockReset()
  // 默认让探活永远挂着不回来 —— 这才是"刚打开那一瞬间"的真实状态
  statusMock.mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restoreConsole?.()
})

function render() {
  act(() => {
    root.render(
      <TextureClarityEditor
        projectUuid="p1"
        nodeKey="node-1"
        sourceUrl="/assets/p1/raw.png"
        onClose={() => { closed += 1 }}
        onGenerate={(assets, model) => { generated.push({ assets, model }) }}
      />,
    )
  })
}

/** 弹窗 portal 到 body，所以要在整个 document 里找 */
function buttonByText(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tc-overlay button'))
    .find((b) => (b.textContent || '').includes(text))
}

describe('细化纹理弹窗打开时不等待', () => {
  it('打开时一次请求都不发，且没有 React 报错', () => {
    render()
    expect(assetsMock).not.toHaveBeenCalled()
    expect(document.querySelector('.tc-overlay')).not.toBeNull()
    const hookError = errors.find((e) => String(e).includes('Rendered more hooks') || String(e).includes('Rendered fewer hooks'))
    expect(hookError, `React hook 数量报错：${String(hookError)}`).toBeUndefined()
  })

  it('源图第一帧就显示出来，不用等素材准备', () => {
    render()
    const img = document.querySelector<HTMLImageElement>('.tc-overlay .tc-stage-img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('/assets/p1/raw.png')
  })

  it('「生成修复」第一帧就能点', () => {
    render()
    const generate = buttonByText('生成修复')
    expect(generate, '找不到生成按钮').toBeTruthy()
    expect(generate?.disabled).toBe(false)
  })

  it('点生成是交出 assets=null 并关窗 —— 让节点自己去准备，弹窗不等', () => {
    render()
    act(() => { buttonByText('生成修复')?.click() })
    expect(generated).toHaveLength(1)
    expect(generated[0].assets).toBeNull()
    expect(generated[0].model).toBe('gemini-3-pro-image')
    expect(closed).toBe(1)
  })

  it('预览是按需的：点了才发请求，之后生成复用这份结果，不让服务端重跑一遍', async () => {
    assetsMock.mockResolvedValue(READY_ASSETS)
    render()

    const preview = buttonByText('加载控制素材预览')
    expect(preview, '找不到预览按钮').toBeTruthy()
    await act(async () => { preview?.click() })

    expect(assetsMock).toHaveBeenCalledTimes(1)
    expect(assetsMock.mock.calls[0][0]).toMatchObject({
      projectUuid: 'p1',
      nodeKey: 'node-1',
      sourceUrl: '/assets/p1/raw.png',
    })

    act(() => { buttonByText('生成修复')?.click() })
    expect(generated).toHaveLength(1)
    // 带过去的必须是那份已备好的素材，任务才能跳过准备阶段
    expect((generated[0].assets as typeof READY_ASSETS)?.semantic.classMapUrl)
      .toBe('/assets/p1/classmap.png')
  })

  it('探活还没回来时生成按钮照常可点（探活绝不能把弹窗变回"要等"）', () => {
    // statusMock 默认永挂，模拟探活在飞
    render()
    expect(buttonByText('生成修复')?.disabled).toBe(false)
  })

  it('探活自己失败也不禁用生成 —— 探不到不等于服务坏了', async () => {
    statusMock.mockRejectedValue(new Error('boom'))
    render()
    await act(async () => { await Promise.resolve() })
    expect(buttonByText('生成修复')?.disabled).toBe(false)
  })

  it('探活明确说语义分区没起来时，灰掉生成并讲清原因', async () => {
    statusMock.mockResolvedValue(STATUS_SEMANTIC_DOWN)
    render()
    await act(async () => { await Promise.resolve() })

    expect(buttonByText('生成修复')?.disabled).toBe(true)
    const hint = document.querySelector('.tc-overlay .tc-hint')
    expect(hint?.textContent).toContain('语义分区')
    expect(hint?.textContent).toContain('联系管理员')
    // 原始报错留在 title 里给排查用，但不糊在正文上
    expect(hint?.getAttribute('title')).toContain('ETIMEDOUT')
    expect(hint?.textContent).not.toContain('ETIMEDOUT')
  })

  it('GPU 部位分区故障但本地轮廓可用时继续允许生成，并明确提示降级', async () => {
    statusMock.mockResolvedValue(STATUS_SEMANTIC_FALLBACK)
    render()
    await act(async () => { await Promise.resolve() })

    expect(buttonByText('生成修复')?.disabled).toBe(false)
    const hint = document.querySelector('.tc-overlay .tc-hint')
    expect(hint?.textContent).toContain('本地人物轮廓')
    expect(hint?.textContent).toContain('部位精度会降低')
  })

  it('服务都正常时不显示任何告警，也不影响生成', async () => {
    statusMock.mockResolvedValue(STATUS_UP)
    render()
    await act(async () => { await Promise.resolve() })
    expect(buttonByText('生成修复')?.disabled).toBe(false)
    expect(document.querySelector('.tc-overlay .tc-hint')).toBeNull()
  })

  it('只有几何服务挂了时仍然允许生成（软依赖，只是少一层约束）', async () => {
    statusMock.mockResolvedValue({
      semantic: { configured: true, ok: true, reason: '' },
      geometry: { configured: true, ok: false, reason: 'connect ECONNREFUSED 172.26.166.238:8091' },
      canRepair: true,
      checkedAtMs: 1,
    })
    render()
    await act(async () => { await Promise.resolve() })
    expect(buttonByText('生成修复')?.disabled).toBe(false)
    expect(document.querySelector('.tc-overlay .tc-hint')?.textContent).toContain('少一层几何约束')
  })

  it('预览失败也不挡着生成 —— 素材可以在节点上重新准备', async () => {
    assetsMock.mockRejectedValue(new Error('几何服务连不上'))
    render()

    await act(async () => { buttonByText('加载控制素材预览')?.click() })

    expect(document.querySelector('.tc-overlay .tc-error')?.textContent).toContain('几何服务连不上')
    const generate = buttonByText('生成修复')
    expect(generate?.disabled).toBe(false)
    act(() => { generate?.click() })
    expect(generated[0].assets).toBeNull()
  })
})
