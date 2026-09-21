import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ImagePreview } from '@/components/ImagePreview'
import type { ResourceMeta } from '@/lib/types'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  delete (HTMLElement.prototype as HTMLElement & { requestFullscreen?: unknown }).requestFullscreen
})

function mount(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

describe('视频大图查看器', () => {
  it('优先使用 Shotflow 查看器，不自动请求浏览器原生全屏', () => {
    const requestFullscreen = vi.fn(() => Promise.resolve())
    ;(HTMLElement.prototype as HTMLElement & { requestFullscreen?: unknown }).requestFullscreen = requestFullscreen

    mount(
      <ImagePreview
        kind="video"
        url="/assets/video.mp4"
        name="测试视频"
        onClose={() => undefined}
      />,
    )

    expect(document.querySelector('.shotflow-image-viewer')).toBeTruthy()
    const video = document.querySelector('video')
    expect(video).toBeTruthy()
    expect(video?.getAttribute('controlslist')?.split(/\s+/)).toContain('nofullscreen')

    const doubleClick = new MouseEvent('dblclick', { bubbles: true, cancelable: true })
    act(() => { video?.dispatchEvent(doubleClick) })
    expect(doubleClick.defaultPrevented).toBe(true)
    expect(requestFullscreen).not.toHaveBeenCalled()

    const viewerSource = readFileSync(
      join(__dirname, '..', 'src/canvas/components/ImagePreview.tsx'),
      'utf8',
    )
    const videoNodeSource = readFileSync(
      join(__dirname, '..', 'src/canvas/components/nodes/VideoNode.tsx'),
      'utf8',
    )
    expect(viewerSource).not.toContain('requestFullscreenOnOpen')
    expect(viewerSource).toContain('controlsList="nofullscreen"')
    expect(viewerSource).toContain("video.addEventListener('webkitbeginfullscreen'")
    expect(videoNodeSource).toContain('controlsList="nofullscreen"')
    expect(videoNodeSource).toContain("video.addEventListener('webkitbeginfullscreen'")
    expect(videoNodeSource).toMatch(/onDoubleClickCapture=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?event\.nativeEvent\.stopImmediatePropagation\(\)[\s\S]*?openVideoPreview\(videoUrl\)/)
  })

  it('视频信息栏用醒目卡片和普通信息行显示真实帧率', () => {
    mount(
      <ImagePreview
        kind="video"
        url="/assets/video.mp4"
        name="测试视频"
        resourceMeta={{ kind: 'video', fps: 24, durationSec: 2, width: 1920, height: 1080 }}
        generationMeta={{ fps: 30 }}
        onClose={() => undefined}
      />,
    )

    expect(document.querySelector('.shotflow-image-viewer-video-fps')?.textContent).toContain('24 fps')
    expect(document.querySelector('.shotflow-image-viewer-video-fps')?.textContent).toContain('源视频实际帧率')
    const rows = [...document.querySelectorAll('.shotflow-image-viewer-info-row')]
    const fpsRow = rows.find((row) => row.textContent?.includes('帧率'))
    expect(fpsRow?.textContent).toContain('24 fps')
  })

  it('旧视频缺少元数据时异步读取真实帧率', async () => {
    let resolveMeta!: (meta: ResourceMeta) => void
    const loadVideoResourceMeta = vi.fn(() => new Promise<ResourceMeta>((resolve) => {
      resolveMeta = resolve
    }))

    mount(
      <ImagePreview
        kind="video"
        url="/assets/267/legacy-video.mp4"
        name="旧视频"
        loadVideoResourceMeta={loadVideoResourceMeta}
        onClose={() => undefined}
      />,
    )

    await act(async () => { await Promise.resolve() })
    expect(loadVideoResourceMeta).toHaveBeenCalledWith('/assets/267/legacy-video.mp4')
    expect(document.querySelector('.shotflow-image-viewer-video-fps')?.textContent).toContain('读取中')

    await act(async () => {
      resolveMeta({ kind: 'video', fps: 24, width: 1920, height: 1080, durationSec: 3 })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.querySelector('.shotflow-image-viewer-video-fps')?.textContent).toContain('24 fps')
    expect(document.querySelector('.shotflow-image-viewer-video-fps')?.textContent).toContain('源视频实际帧率')
  })
})
