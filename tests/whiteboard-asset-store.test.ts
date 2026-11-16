/**
 * 白板标注的图片存成画布资产文件，白板状态只记地址（2026-11-16）。
 *
 * 以前 tldraw 默认把粘贴的图片原样转 base64 塞进画布数据：画布 587「设定资产图」11 张图 61MB，
 * 每 5 秒一次的心跳都要把它整块读出来解析，拖慢整台服务器。这里锁三件事：
 *   ① 粘贴 / 拖入的图片走 assetsApi.upload（会先压缩），白板里只留返回的地址；
 *   ② 底图本来就是画布资产时直接引用原地址，不重复上传；
 *   ③ 旧白板里已经内嵌的 base64 图片，保存时转成文件、换成地址。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const upload = vi.fn()
vi.mock('@/lib/api', () => ({ assetsApi: { upload: (...args: unknown[]) => upload(...args) } }))
vi.mock('tldraw', () => ({ Tldraw: () => null, createShapeId: () => 'shape:x', notifyIfFileNotAllowed: () => true, useEditor: () => null, useToasts: () => null, useTranslation: () => null }))
vi.mock('tldraw/tldraw.css', () => ({}))
vi.mock('@tldraw/editor', () => ({ DefaultColorStyle: {}, DefaultSizeStyle: {} }))

const { createWhiteboardAssetStore, externalizeInlineAssets } = await import('@/components/WhiteboardModal')
const { WHITEBOARD_SOURCE_URL } = await import('@/lib/whiteboard')

beforeEach(() => {
  upload.mockReset()
  upload.mockResolvedValue({ url: '/assets/587/abc123.webp' })
})

describe('白板图片存储', () => {
  it('粘贴的图片上传成画布资产，白板只记地址', async () => {
    const store = createWhiteboardAssetStore('587')
    const file = new File([new Uint8Array(10)], 'paste.png', { type: 'image/png' })
    const result = await store.upload({} as never, file)
    expect(upload).toHaveBeenCalledWith('587', file)
    expect(result).toEqual({ src: '/assets/587/abc123.webp' })
    expect(result.src.startsWith('data:')).toBe(false)
  })

  it('底图本来就是画布资产时直接引用，不重复上传', async () => {
    const store = createWhiteboardAssetStore('587')
    const file = new File([new Uint8Array(10)], 'base.png', { type: 'image/png' })
    Object.defineProperty(file, WHITEBOARD_SOURCE_URL, { value: '/assets/587/base.png', enumerable: false })
    const result = await store.upload({} as never, file)
    expect(upload).not.toHaveBeenCalled()
    expect(result).toEqual({ src: '/assets/587/base.png' })
  })

  it('旧白板内嵌的 base64 图片保存时转成文件、换成地址；已是地址的不动', async () => {
    const assets = [
      { id: 'asset:1', type: 'image', props: { src: 'data:image/png;base64,iVBORw0KGgo=', name: 'old.png', w: 10, h: 10 } },
      { id: 'asset:2', type: 'image', props: { src: '/assets/587/keep.png', name: 'keep.png', w: 10, h: 10 } },
    ]
    const updated: unknown[] = []
    const editor = {
      getAssets: () => assets,
      updateAssets: (list: unknown[]) => { updated.push(...list) },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob([new Uint8Array(4)], { type: 'image/png' })))
    await externalizeInlineAssets(editor as never, '587')
    fetchSpy.mockRestore()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(updated).toEqual([
      expect.objectContaining({ id: 'asset:1', props: expect.objectContaining({ src: '/assets/587/abc123.webp', w: 10 }) }),
    ])
  })
})
