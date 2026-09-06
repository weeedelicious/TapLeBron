/**
 * 模式选择器只显示这个账号真能用的模式（2026-08-24 放开聊天之后的配套）。
 *
 * 服务端已经挡了一层（越权的 mode 静默降级），所以这里不是安全边界，而是**别骗人**：
 * 选项摆在那儿却点了没用，比不摆更糟。
 *
 * 两个容易写错的点各有用例：
 *   ① 只剩默认模式时整个选择器不显示 —— 一个点不动的下拉框是纯噪音。
 *   ② /status 没带 modes 字段（后端还是放开聊天之前的老版本）时按**全部模式**兜底。
 *      那时候"能聊天"就等于"三个模式都能用"，要是按最小权限兜底，
 *      前后端部署有时间差的那几分钟里，本来有高级模式的人会突然少东西。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { CindyModeSelector } = await import('@/components/CindyModeSelector')
const { cindyModesFromStatus, CINDY_MODE_ORDER } = await import('@/lib/cindyAssistant')
const { useCanvasStore } = await import('@/store/canvasStore')

type Mode = 'default' | 'film' | 'master'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useCanvasStore.setState({ cindyEnabled: false, cindyModes: ['default'], cindyMode: 'default' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(enabled: boolean, modes: Mode[], mode: Mode = 'default') {
  useCanvasStore.setState({ cindyEnabled: enabled, cindyModes: modes, cindyMode: mode })
  act(() => {
    root.render(<CindyModeSelector />)
  })
}

const trigger = () => container.querySelector<HTMLButtonElement>('.cindy-mode-trigger')
const optionLabels = () =>
  Array.from(container.querySelectorAll('.cindy-mode-option-head > span')).map((el) => el.textContent)

describe('① 只有默认模式时不显示选择器', () => {
  it('普通账号（只有 default）→ 什么都不渲染', () => {
    render(true, ['default'])
    expect(container.innerHTML).toBe('')
  })

  it('Cindy 本身没开 → 也不渲染', () => {
    render(false, ['default', 'film', 'master'])
    expect(container.innerHTML).toBe('')
  })

  it('modes 是空数组（没登录）→ 不渲染，不炸', () => {
    render(true, [])
    expect(container.innerHTML).toBe('')
  })
})

describe('有高级模式时正常显示', () => {
  it('三个模式都有 → 显示触发按钮和当前模式', () => {
    render(true, ['default', 'film', 'master'])
    expect(trigger()).not.toBeNull()
    expect(container.querySelector('.cindy-mode-selector-current')?.textContent).toBe('默认模式')
  })

  it('只放开了 film → 菜单里不该出现「电影大师模式」', () => {
    render(true, ['default', 'film'])
    act(() => {
      trigger()?.click()
    })
    expect(optionLabels()).toEqual(['默认模式', '一键出片模式'])
  })

  it('三个都放开 → 菜单里三个都在，顺序不变', () => {
    render(true, ['default', 'film', 'master'])
    act(() => {
      trigger()?.click()
    })
    expect(optionLabels()).toEqual(['默认模式', '一键出片模式', '电影大师模式'])
  })

  it('当前停在 film 时，按钮上显示的是 film', () => {
    render(true, ['default', 'film'], 'film')
    expect(container.querySelector('.cindy-mode-selector-current')?.textContent).toBe('一键出片模式')
  })
})

describe('② /status 的 modes 字段兜底', () => {
  it('字段整个缺失（老后端）→ 按全部模式兜底，不让人少东西', () => {
    expect(cindyModesFromStatus(undefined, true)).toEqual(CINDY_MODE_ORDER)
    expect(cindyModesFromStatus(null, true)).toEqual(CINDY_MODE_ORDER)
  })

  it('enabled 是 false → 空数组（没权限就没模式）', () => {
    expect(cindyModesFromStatus(['default', 'film'], false)).toEqual([])
    expect(cindyModesFromStatus(undefined, false)).toEqual([])
  })

  it('新后端给的列表按原样收（顺序归一化成显示顺序）', () => {
    expect(cindyModesFromStatus(['default'], true)).toEqual(['default'])
    expect(cindyModesFromStatus(['master', 'default', 'film'], true)).toEqual(CINDY_MODE_ORDER)
  })

  it('脏数据 → 只留默认模式，不抛异常', () => {
    expect(cindyModesFromStatus('film', true)).toEqual(['default'])
    expect(cindyModesFromStatus(42, true)).toEqual(['default'])
    expect(cindyModesFromStatus({}, true)).toEqual(['default'])
    // 列表里全是不认识的值 → 也不能空掉
    expect(cindyModesFromStatus(['studio', 'x'], true)).toEqual(['default'])
  })
})

describe('名单收窄时把当前模式拽回默认', () => {
  // store 的写入包在 act 里：全量并行跑时同一个 worker 里别的文件会把
  // IS_REACT_ACT_ENVIRONMENT 打开，那时在 act 外面改 store 会被 React 警告刷屏。
  it('原本停在 master，可用模式变成只有 default → cindyMode 回到 default', () => {
    act(() => {
      useCanvasStore.setState({ cindyModes: [...CINDY_MODE_ORDER], cindyMode: 'master' })
      useCanvasStore.getState().setCindyModes(['default'])
    })
    expect(useCanvasStore.getState().cindyMode).toBe('default')
  })

  it('当前模式仍在名单里 → 不动它', () => {
    act(() => {
      useCanvasStore.setState({ cindyModes: [...CINDY_MODE_ORDER], cindyMode: 'film' })
      useCanvasStore.getState().setCindyModes(['default', 'film'])
    })
    expect(useCanvasStore.getState().cindyMode).toBe('film')
  })
})
