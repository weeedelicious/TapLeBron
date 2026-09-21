import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OfficialTemplateLibrary, openLinkedCanvas } from '@/components/OfficialTemplateLibrary'
import { useCanvasStore } from '@/store/canvasStore'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  source: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  officialTemplatesApi: {
    list: apiMocks.list,
    source: apiMocks.source,
    create: apiMocks.create,
    update: apiMocks.update,
  },
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ITEMS = [
  { id: 'text-to-image', category: 'image', title: '文生图', subtitle: '生成图片', thumbnailUrl: '', method: '文本生成图片', canvasId: '101', tone: '#ba8752', nodes: [{ type: 'text', label: '提示词' }] },
  { id: 'image-to-image', category: 'image', title: '图生图', subtitle: '参考图生成', thumbnailUrl: '', method: '参考图', canvasId: '102', tone: '#5b9195', nodes: [{ type: 'upload', label: '参考图' }] },
  { id: 'text-to-video', category: 'video', title: '文生视频', subtitle: '生成视频', thumbnailUrl: '', method: '文本生成视频', canvasId: '103', tone: '#b68557', nodes: [{ type: 'video', label: '视频' }] },
  { id: 'multi-view', category: '3d', title: '3D 多视图', subtitle: '多视图', thumbnailUrl: '', method: '3D', canvasId: '104', tone: '#8b7660', nodes: [{ type: 'director_stage', label: '3D' }] },
]

let container: HTMLDivElement
let root: Root

async function renderLibrary(element = <OfficialTemplateLibrary onClose={() => undefined} />) {
  await act(async () => {
    root.render(element)
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiMocks.list.mockResolvedValue({ items: ITEMS, canEdit: true })
  apiMocks.create.mockImplementation(async (value) => ({ ...value, id: 'new-template', canvasId: '201' }))
  apiMocks.update.mockImplementation(async (id, value) => ({ ...ITEMS.find((item) => item.id === id), ...value, id }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('linked canvas navigation', () => {
  it('opens in the current page without creating a competing tab', () => {
    const navigate = vi.fn()

    openLinkedCanvas('101', navigate)

    expect(navigate).toHaveBeenCalledTimes(1)
    const destination = new URL(navigate.mock.calls[0][0])
    expect(destination.searchParams.get('project')).toBe('101')
    expect(destination.searchParams.get('claimCanvasSession')).toBe('1')
  })
})

describe('官方模板库交互层', () => {
  it('挂到 body 顶层，固定尺寸，右侧滚动且分类切换不改弹窗大小', async () => {
    const onClose = vi.fn()
    const onParentClick = vi.fn()
    await renderLibrary(<div onClick={onParentClick}><OfficialTemplateLibrary onClose={onClose} /></div>)

    const overlay = document.body.querySelector<HTMLElement>('.shotflow-template-library-overlay')
    const dialog = document.body.querySelector<HTMLElement>('.shotflow-template-library-dialog')
    const scroller = document.body.querySelector<HTMLElement>('.shotflow-template-scroll')
    expect(overlay).not.toBeNull()
    expect(container.contains(overlay)).toBe(false)
    expect(overlay?.style.zIndex).toBe('2147483647')
    expect(dialog?.style.height).toBe('780px')
    expect(dialog?.style.maxHeight).toBe('92vh')
    expect(scroller?.style.overflowY).toBe('scroll')
    expect(document.body.querySelectorAll('[data-template-id]')).toHaveLength(4)

    const originalHeight = dialog?.style.height
    act(() => document.body.querySelector<HTMLButtonElement>('[data-template-category="video"]')?.click())
    expect(document.body.querySelectorAll('[data-template-id]')).toHaveLength(1)
    expect(document.body.querySelector('[data-template-id="text-to-video"]')).not.toBeNull()
    expect(dialog?.style.height).toBe(originalHeight)
    expect(onParentClick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('管理员可编辑模板资料，但专属画布只读且不能换绑', async () => {
    await renderLibrary()
    act(() => document.body.querySelector<HTMLButtonElement>('[data-template-edit="text-to-image"]')?.click())
    expect(document.body.querySelector('[data-template-editor]')).not.toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(document.body.querySelector('select[data-template-canvas]')).toBeNull()
    expect(document.body.querySelector('[data-template-canvas]')?.textContent).toContain('画布 101')

    const titleInput = Array.from(document.body.querySelectorAll<HTMLInputElement>('[data-template-editor] input')).find((input) => input.value === '文生图')
    act(() => {
      if (!titleInput) return
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(titleInput, '电影级文生图')
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-template-save]')?.click(); await Promise.resolve() })

    const updatePayload = apiMocks.update.mock.calls[0]?.[1]
    expect(apiMocks.update).toHaveBeenCalledWith('text-to-image', expect.objectContaining({ title: '电影级文生图', category: 'image', categories: ['image'] }))
    expect(updatePayload).not.toHaveProperty('canvasId')
    expect(document.body.querySelector('[data-template-editor]')).toBeNull()
  })

  it('分类支持多选，同一模板会同时出现在所选分类中', async () => {
    await renderLibrary()
    act(() => document.body.querySelector<HTMLButtonElement>('[data-template-edit="text-to-image"]')?.click())

    const imageOption = document.body.querySelector<HTMLButtonElement>('[data-template-category-option="image"]')
    const videoOption = document.body.querySelector<HTMLButtonElement>('[data-template-category-option="video"]')
    expect(imageOption?.getAttribute('aria-pressed')).toBe('true')
    expect(videoOption?.getAttribute('aria-pressed')).toBe('false')

    act(() => videoOption?.click())
    expect(videoOption?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-template-save]')?.click(); await Promise.resolve() })

    expect(apiMocks.update).toHaveBeenCalledWith('text-to-image', expect.objectContaining({
      category: 'image',
      categories: ['image', 'video'],
    }))

    act(() => document.body.querySelector<HTMLButtonElement>('[data-template-category="video"]')?.click())
    expect(document.body.querySelector('[data-template-id="text-to-image"]')).not.toBeNull()
    act(() => document.body.querySelector<HTMLButtonElement>('[data-template-category="image"]')?.click())
    expect(document.body.querySelector('[data-template-id="text-to-image"]')).not.toBeNull()
  })

  it('分类至少保留一项，否则不提交保存', async () => {
    await renderLibrary()
    act(() => document.body.querySelector<HTMLButtonElement>('[data-template-edit="text-to-image"]')?.click())
    act(() => document.body.querySelector<HTMLButtonElement>('[data-template-category-option="image"]')?.click())
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-template-save]')?.click(); await Promise.resolve() })

    expect(apiMocks.update).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('请至少选择一个分类')
  })

  it('新增模板不选画布，保存后由服务端返回自动创建的专属画布', async () => {
    await renderLibrary()
    act(() => document.body.querySelector<HTMLButtonElement>('[data-template-add]')?.click())
    expect(document.body.querySelector('[data-template-canvas]')?.textContent).toContain('保存后自动创建')

    const titleInput = Array.from(document.body.querySelectorAll<HTMLInputElement>('[data-template-editor] input'))
      .find((input) => input.placeholder === '例如：角色三视图')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(titleInput, '新模板')
      titleInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-template-save]')?.click(); await Promise.resolve() })

    expect(apiMocks.create).toHaveBeenCalledWith(expect.not.objectContaining({ canvasId: expect.anything() }))
    expect(document.body.querySelector('[data-template-editor]')).toBeNull()
  })

  it('画布高频更新时不跟着整棵重渲染', async () => {
    let renderCount = 0
    await renderLibrary(<Profiler id="template-library" onRender={() => { renderCount += 1 }}><OfficialTemplateLibrary onClose={() => undefined} /></Profiler>)
    const initialRenderCount = renderCount
    const initialViewport = useCanvasStore.getState().viewport

    act(() => {
      for (let index = 0; index < 200; index += 1) useCanvasStore.setState({ viewport: { x: index, y: -index, zoom: 1 } })
    })

    expect(renderCount).toBe(initialRenderCount)
    useCanvasStore.setState({ viewport: initialViewport })
  })
})
