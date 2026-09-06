/**
 * 细化纹理结果节点的「前后对比」界面（2026-08-21 用户要求：
 * 「细化纹理生成的图片节点是特殊的，可以点开看到细化纹理的弹窗，弹窗中间可以看对比」）。
 *
 * 它同时兑现了弹窗底部那句「质量门禁结果在新节点上查看」—— 这句话写在界面上很久，
 * 但查看的地方一直没做。
 *
 * 锁四件事：
 *   1. 中栏真的是「原图 vs 结果」两张图叠着滑杆，不是又跑去比语义分区；
 *   2. 对比模式**不发任何网络请求** —— 它只看已经生成好的东西，探活和素材准备都不该出现；
 *   3. 不出现生成按钮：这是个查看界面，不能在这儿悄悄再花一次钱；
 *   4. 质量门禁 `passed === null`（老节点没记录）必须显示成"没记录"，
 *      **不能显示成"未通过"** —— 那是对一次可能成功的生成的误告。
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

const { TextureClarityEditor } = await import('@/features/texture-clarity/TextureClarityEditor')

const RESULT = {
  sourceNodeKey: 'src-1',
  sourceUrl: '/assets/p1/source.png',
  fusedUrl: '/assets/p1/fused.png',
  candidateUrl: '/assets/p1/candidate.png',
  requestModel: 'gemini-3-pro-image',
  resolvedModel: 'gemini-3-pro-image-002',
  outputWidth: 1024,
  outputHeight: 1536,
  fusionPolicy: 'edge-v2',
  semanticModelId: 'sayeed99/segformer_b3_clothes',
  sourceHash: 'hash-1',
  generationCalls: 1,
  passed: true,
  failures: [],
  diagnostics: { outsideChangedPixels: 0 },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  assetsMock.mockReset()
  statusMock.mockReset()
  statusMock.mockImplementation(() => new Promise(() => {}))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(result: unknown = RESULT) {
  act(() => {
    root.render(
      <TextureClarityEditor
        projectUuid="p1"
        nodeKey="node-1"
        sourceUrl={(result as typeof RESULT).sourceUrl}
        result={result as typeof RESULT}
        onClose={() => {}}
      />,
    )
  })
}

function stageImages() {
  return Array.from(document.querySelectorAll<HTMLImageElement>('.tc-overlay .tc-stage-img'))
    .map((img) => img.getAttribute('src'))
}

function buttonByText(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.tc-overlay button'))
    .find((b) => (b.textContent || '').includes(text))
}

describe('细化纹理 · 前后对比', () => {
  it('中栏是原图 vs 细化结果，带滑杆', () => {
    render()
    expect(stageImages()).toEqual(['/assets/p1/source.png', '/assets/p1/fused.png'])
    expect(document.querySelector('.tc-overlay .tc-split')).not.toBeNull()
    expect(document.querySelector('.tc-overlay .tc-stage-tag.is-right')?.textContent).toContain('细化结果')
  })

  it('不发任何网络请求 —— 看已有结果不该触发探活或素材准备', () => {
    render()
    expect(statusMock).not.toHaveBeenCalled()
    expect(assetsMock).not.toHaveBeenCalled()
  })

  it('没有生成按钮：这是查看界面，不能在这儿再花一次钱', () => {
    render()
    expect(buttonByText('生成修复')).toBeUndefined()
  })

  it('能切到「模型候选」看融合之前长什么样', () => {
    render()
    act(() => { buttonByText('模型候选')?.click() })
    expect(stageImages()).toEqual(['/assets/p1/source.png', '/assets/p1/candidate.png'])
    expect(document.querySelector('.tc-overlay .tc-stage-tag.is-right')?.textContent).toContain('融合前')
  })

  it('老节点没有候选图时不显示切换按钮（切不动的按钮只会让人困惑）', () => {
    render({ ...RESULT, candidateUrl: null })
    expect(buttonByText('模型候选')).toBeUndefined()
    expect(stageImages()).toEqual(['/assets/p1/source.png', '/assets/p1/fused.png'])
  })

  it('门禁通过时显示通过', () => {
    render()
    expect(document.querySelector('.tc-overlay .tc-verdict')?.textContent).toContain('通过')
    expect(document.querySelector('.tc-overlay .tc-verdict.is-ok')).not.toBeNull()
  })

  it('门禁未通过时把具体原因列出来，而不是只说一句没过', () => {
    render({
      ...RESULT,
      passed: false,
      failures: [{ code: 'outside-changed', message: '蒙版外有 812 个像素被改动' }],
    })
    const verdict = document.querySelector('.tc-overlay .tc-verdict')
    expect(verdict?.className).toContain('is-bad')
    expect(verdict?.textContent).toContain('812')
  })

  it('passed 为 null 时说"没记录"，绝不显示成未通过', () => {
    render({ ...RESULT, passed: null, failures: [] })
    const text = document.querySelector('.tc-overlay .tc-col-params')?.textContent || ''
    expect(text).toContain('没有门禁结论')
    expect(text).not.toContain('未通过')
    expect(document.querySelector('.tc-overlay .tc-verdict')).toBeNull()
  })

  it('记录里的模型和输出尺寸显示出来', () => {
    render()
    const text = document.querySelector('.tc-overlay .tc-col-params')?.textContent || ''
    expect(text).toContain('gemini-3-pro-image')
    expect(text).toContain('1024×1536')
  })
})
