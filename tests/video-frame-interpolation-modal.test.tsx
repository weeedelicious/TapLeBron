import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VideoFrameInterpolationModal } from '@/components/VideoFrameInterpolationModal'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

function button(text: string) {
  return [...document.body.querySelectorAll('button')]
    .find((item) => item.textContent?.includes(text)) as HTMLButtonElement | undefined
}

describe('视频补帧方法弹窗', () => {
  it('显示三种方法，并把选择的 Video2X 方法交给执行函数', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <VideoFrameInterpolationModal
          url="/source.mp4"
          name="24fps 测试视频"
          sourceFpsHint={24}
          sourceWidthHint={1920}
          sourceHeightHint={1080}
          durationHintSec={2}
          onCancel={() => undefined}
          onConfirm={onConfirm}
        />,
      )
    })

    expect(document.body.textContent).toContain('OpenFlowFrames')
    expect(document.body.textContent).toContain('Video2X 6.4')
    expect(document.body.textContent).toContain('FFmpeg 光流')
    await act(async () => button('Video2X 6.4')?.click())
    await act(async () => button('执行补帧')?.click())
    expect(onConfirm).toHaveBeenCalledWith(30, 'video2x')
  })
})
