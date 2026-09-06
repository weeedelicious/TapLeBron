/**
 * 视频节点参考视频悬停预览（2026-09-03）。
 *
 * 参考图早就有小弹窗，参考视频缩略图只有静帧+播放图标。
 * 用户要求鼠标放上去也能弹出预览视频。弹窗和图片共用 HoverImagePreview，
 * 用 kind="video" 切成静音循环播放，不能把 <img> 指到 mp4 上（会裂图）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { HoverImagePreview } = await import('@/components/HoverImagePreview')

let container: HTMLDivElement
let root: Root

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
})

function mount(entry: { url: string; name?: string; kind?: 'image' | 'video' } | null) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const rect = {
    left: 100,
    top: 200,
    width: 44,
    height: 42,
    right: 144,
    bottom: 242,
    x: 100,
    y: 200,
    toJSON() { return this },
  } as DOMRect
  act(() => {
    root.render(<HoverImagePreview entry={entry ? { ...entry, rect } : null} />)
  })
}

describe('HoverImagePreview', () => {
  it('参考图仍用 img', () => {
    mount({ url: '/assets/264/a.png', name: '图片1' })
    const img = document.body.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/assets/264/a.png')
    expect(document.body.querySelector('video')).toBeNull()
  })

  it('参考视频用 video，静音循环，并带上首帧锚点', () => {
    mount({ url: '/assets/264/ref.mp4', name: '视频1', kind: 'video' })
    const video = document.body.querySelector('video')
    expect(video).toBeTruthy()
    expect(video?.getAttribute('src')).toBe('/assets/264/ref.mp4#t=0.001')
    expect(video?.muted).toBe(true)
    expect(video?.loop).toBe(true)
    expect(video?.autoplay).toBe(true)
    expect(document.body.querySelector('img')).toBeNull()
    expect(document.body.textContent).toContain('视频1')
  })

  it('没有 entry 时不往 body 塞弹窗', () => {
    mount(null)
    expect(document.body.querySelector('video')).toBeNull()
    expect(document.body.querySelector('img')).toBeNull()
  })
})

describe('视频节点参考条真的会唤起视频预览', () => {
  it('connectedVideos 的缩略图把 kind=video 传给悬停预览', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src/canvas/components/nodes/VideoNode.tsx'),
      'utf8',
    )
    expect(source).toContain('connectedVideos.map')
    expect(source).toContain("scheduleHoverPreview(")
    expect(source).toMatch(/scheduleHoverPreview\([\s\S]{0,280}'video'/)
  })

  it('参考视频缩略图用封面首帧，并保留视频图标', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src/canvas/components/nodes/VideoNode.tsx'),
      'utf8',
    )
    expect(source).toContain('function ReferenceVideoCover')
    expect(source).toContain('preload="metadata"')
    expect(source).toContain('<NodeTypeIcon type="video" size={iconSize} />')
    expect(source).toContain('<ReferenceVideoCover src={ref.coverSrc || videoPreviewSrc(ref.url)} poster={ref.poster} iconSize={13} />')
    expect(source).not.toMatch(/connectedVideos\.map[\s\S]{0,1200}preload="none"/)
  })
})
