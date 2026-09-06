/**
 * 图片 / 视频节点的分辨率：不选中不显示，选中时贴在名字上方、50% 透明度
 * （2026-08-25 用户要求）。
 *
 * 三件事各自都会静默做错，所以分开锁：
 *   ① **不选中时必须一个字都不渲染**，不是"渲染了但看不见"。这是用户要的重点：
 *      画布上几十个节点各顶一串数字太吵。用 opacity/visibility 藏起来会留下占位、
 *      还会被 Ctrl+F 和读屏软件读到，等于没做。
 *   ② **紧贴**是可以算的：那行的底边必须正好落在标题行的上沿 —— 不留缝、不重叠。
 *      写死两个偏移量最容易跑偏,所以这里断言的是"底边 == 标题行顶边"这个关系本身。
 *   ③ 它压在节点上方的空白区，**必须 pointer-events:none**，否则会挡住框选和从上方拉连线。
 *
 * 另外锁住上传节点那条老路（headerMeta）没被顺带改掉 —— 用户只说了图片和视频节点。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { NodeShell } = await import('@/components/nodes/NodeShell')

const RESOLUTION = '1568 x 672'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type ShellProps = {
  selected?: boolean
  selectedMeta?: React.ReactNode
  headerMeta?: React.ReactNode
}

function render(props: ShellProps) {
  act(() => {
    root.render(
      <ReactFlowProvider>
        <NodeShell
          nodeKey="n1"
          data={{ nodeKey: 'n1', name: '测试节点', type: 'image' } as never}
          {...props}
        >
          <div>body</div>
        </NodeShell>
      </ReactFlowProvider>,
    )
  })
}

const metaLine = () => container.querySelector<HTMLElement>('.shotflow-node-selected-meta')
const headerRow = () => container.querySelector<HTMLElement>('.shotflow-node-header')
const headerMetaSlot = () => container.querySelector<HTMLElement>('.shotflow-node-header-meta')
const px = (value: string) => Number.parseFloat(value)

describe('① 不选中时一个字都不渲染', () => {
  it('没选中 → DOM 里既没有那行容器，也搜不到分辨率文字', () => {
    render({ selected: false, selectedMeta: <span>{RESOLUTION}</span> })
    expect(metaLine()).toBeNull()
    expect(container.textContent).not.toContain(RESOLUTION)
  })

  it('选中 → 出现，并且文字就是分辨率', () => {
    render({ selected: true, selectedMeta: <span>{RESOLUTION}</span> })
    expect(metaLine()).not.toBeNull()
    expect(metaLine()?.textContent).toBe(RESOLUTION)
  })

  it('选中但没给 selectedMeta（比如读不出尺寸）→ 不渲染空容器', () => {
    render({ selected: true })
    expect(metaLine()).toBeNull()
  })

  it('节点名字始终显示，不受选中影响', () => {
    render({ selected: false, selectedMeta: <span>{RESOLUTION}</span> })
    expect(container.textContent).toContain('测试节点')
    render({ selected: true, selectedMeta: <span>{RESOLUTION}</span> })
    expect(container.textContent).toContain('测试节点')
  })
})

describe('② 位置：在名字上方、紧贴', () => {
  it('是标题行的兄弟，不在标题行里面（不能挤占标题那一行）', () => {
    render({ selected: true, selectedMeta: <span>{RESOLUTION}</span> })
    const meta = metaLine()!
    const header = headerRow()!
    expect(header.contains(meta)).toBe(false)
    expect(meta.parentElement).toBe(header.parentElement)
  })

  it('底边正好落在标题行上沿：不留缝、不重叠', () => {
    render({ selected: true, selectedMeta: <span>{RESOLUTION}</span> })
    const meta = metaLine()!
    const header = headerRow()!
    const metaTop = px(meta.style.top)
    const metaHeight = px(meta.style.height)
    const headerTop = px(header.style.top)
    expect(Number.isFinite(metaTop) && Number.isFinite(headerTop)).toBe(true)
    // 两者都在节点上沿之上（负偏移），且分辨率那行更高
    expect(metaTop).toBeLessThan(headerTop)
    expect(headerTop).toBeLessThan(0)
    // 关键：底边 == 标题行顶边（测试环境 zoom=1，两者同一坐标系）
    expect(metaTop + metaHeight).toBeCloseTo(headerTop, 5)
  })

  it('文字在行内贴着底边，不是浮在行顶（否则视觉上又离开标题行了）', () => {
    render({ selected: true, selectedMeta: <span>{RESOLUTION}</span> })
    expect(metaLine()!.style.alignItems).toBe('flex-end')
  })

  it('跟标题行用同一个缩放变换，缩放画布时不会脱开', () => {
    render({ selected: true, selectedMeta: <span>{RESOLUTION}</span> })
    expect(metaLine()!.style.transform).toBe(headerRow()!.style.transform)
    expect(metaLine()!.style.transformOrigin).toBe(headerRow()!.style.transformOrigin)
  })

  it('左边缘对齐到**名字**而不是图标（图标 14 + gap 6）', () => {
    render({ selected: true, selectedMeta: <span>{RESOLUTION}</span> })
    expect(px(metaLine()!.style.paddingLeft)).toBe(20)
  })
})

describe('③ 外观与不挡操作', () => {
  it('50% 透明度', () => {
    render({ selected: true, selectedMeta: <span>{RESOLUTION}</span> })
    expect(Number(metaLine()!.style.opacity)).toBe(0.5)
  })

  it('pointer-events:none —— 不能挡住框选和从节点上方拉连线', () => {
    render({ selected: true, selectedMeta: <span>{RESOLUTION}</span> })
    expect(metaLine()!.style.pointerEvents).toBe('none')
  })

  it('不换行（长分辨率也不该把那行撑成两行）', () => {
    render({ selected: true, selectedMeta: <span>3840 x 2160</span> })
    expect(metaLine()!.style.whiteSpace).toBe('nowrap')
  })
})

/*
 * 上面测的是外壳的行为。但「图片/视频节点到底有没有把分辨率交给这个新口子」是另一回事 ——
 * 谁把 selectedMeta= 改回 headerMeta=，上面 13 条一条都不会红，分辨率就又常显在右上角了。
 * 这正是 2026-08-24 粉色标记失效的形状（CSS/外壳都在，只是没人接上去）。
 * 完整渲染 ImageNode 需要的上下文太多，所以这里退一步做接线断言。
 */
describe('图片 / 视频节点确实接到了新口子', () => {
  const read = (rel: string) =>
    readFileSync(join(__dirname, '..', rel), 'utf8')

  for (const [label, rel] of [
    ['图片节点', 'src/canvas/components/nodes/ImageNode.tsx'],
    ['视频节点', 'src/canvas/components/nodes/VideoNode.tsx'],
  ] as const) {
    it(`${label}把分辨率传给 selectedMeta，而不是常显的 headerMeta`, () => {
      const source = read(rel)
      expect(source, `${label}没有把分辨率交给 selectedMeta`).toContain('selectedMeta={resolutionMeta}')
      expect(source, `${label}又把分辨率挂回常显的 headerMeta 了`).not.toContain('headerMeta={resolutionMeta}')
    })
  }
})

describe('上传节点那条老路没被顺带改掉', () => {
  it('headerMeta 仍然渲染在标题行内部，而且**不选中也显示**', () => {
    render({ selected: false, headerMeta: <span>{RESOLUTION}</span> })
    const slot = headerMetaSlot()
    expect(slot).not.toBeNull()
    expect(slot?.textContent).toBe(RESOLUTION)
    expect(headerRow()!.contains(slot!)).toBe(true)
    // 走的是另一个口子，不该冒出选中态那行
    expect(metaLine()).toBeNull()
  })

  it('两个口子可以同时用，互不干扰', () => {
    render({ selected: true, headerMeta: <span>H</span>, selectedMeta: <span>S</span> })
    expect(headerMetaSlot()?.textContent).toBe('H')
    expect(metaLine()?.textContent).toBe('S')
  })
})
