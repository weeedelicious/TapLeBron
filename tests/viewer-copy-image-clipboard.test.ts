/**
 * 大图「复制图片」必须把**图片**写进剪贴板，而不是地址。
 *
 * 2026-08-25 线上按钮会落到「已复制地址」，根因有两处：
 *   1. 先 await fetch 再 clipboard.write，Chrome 丢掉点击授权；
 *   2. 生产是 HTTP（172.25.135.159），clipboard.write 根本不可用。
 *
 * 修法：点击当下立刻 write(Promise<Blob>)；HTTP 下同步 execCommand 复制已显示的图。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writeImageToClipboard } = await import('@/lib/clipboard')

function fakeImage(src = '/assets/1/a.png', width = 8, height = 8) {
  const image = document.createElement('img')
  Object.defineProperty(image, 'naturalWidth', { value: width })
  Object.defineProperty(image, 'naturalHeight', { value: height })
  Object.defineProperty(image, 'currentSrc', { value: src })
  image.src = src
  return image as HTMLImageElement
}

function stubCanvas() {
  const toDataURL = vi.fn(() => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=')
  const toBlob = vi.fn((callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(toDataURL)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(toBlob as never)
  return { toDataURL, toBlob }
}

beforeEach(() => {
  stubCanvas()
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value: () => false,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('writeImageToClipboard', () => {
  it('HTTP 下没有 clipboard.write 时，同步 execCommand 复制已显示的图，而不是地址', async () => {
    const exec = vi.fn(() => true)
    vi.spyOn(document, 'execCommand').mockImplementation(exec)
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    vi.stubGlobal('navigator', { clipboard: undefined })
    const writeText = vi.fn()
    // even if writeText exists on some polyfill, we should not need it
    const result = await writeImageToClipboard('/assets/1/a.webp', fakeImage())
    expect(result).toBe('image')
    expect(exec).toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('点击当下就发起 clipboard.write，不能先 await fetch', async () => {
    let fetched = false
    const write = vi.fn(async (items: ClipboardItem[]) => {
      expect(fetched, 'write 之前不该已经 fetch 完').toBe(false)
      expect(items).toHaveLength(1)
    })
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    vi.stubGlobal('navigator', { clipboard: { write, writeText: vi.fn() } })
    vi.stubGlobal('ClipboardItem', class {
      constructor(public items: Record<string, unknown>) {}
    })
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetched = true
      return {
        ok: true,
        blob: async () => new Blob(['webp-bytes'], { type: 'image/webp' }),
      }
    }))
    vi.spyOn(document, 'execCommand').mockReturnValue(false)

    const result = await writeImageToClipboard('/assets/1/a.webp', fakeImage())
    expect(write).toHaveBeenCalledTimes(1)
    expect(result).toBe('image')
  })

  it('图片复制和 execCommand 都失败时才退回复制地址', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    vi.stubGlobal('navigator', {
      clipboard: {
        write: vi.fn(async () => { throw new Error('NotAllowedError') }),
        writeText,
      },
    })
    vi.stubGlobal('ClipboardItem', class {
      constructor(public items: Record<string, unknown>) {}
    })
    vi.spyOn(document, 'execCommand').mockReturnValue(false)

    const result = await writeImageToClipboard('/assets/1/a.png', fakeImage())
    expect(result).toBe('url')
    expect(writeText).toHaveBeenCalledWith('/assets/1/a.png')
  })
})