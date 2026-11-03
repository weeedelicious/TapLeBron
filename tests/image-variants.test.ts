/**
 * 新图片的两次压缩（2026-11-03）：
 *   · 画布节点显示短边 360 的 WebP（`<原图名>_360.webp`）
 *   · 全屏查看显示短边 1080 的 WebP（`<原图名>_1080.webp`），原图短边不超过 1080 时不生成、直接看原图
 *   · 下载永远是原图
 * 旧节点、旧图片不动：没有派生图记录时一切照旧。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

import { imageVariantsForUrl, mediaPixelSize, mediaPreviewUrl, mediaViewerUrl } from '@/lib/mediaPreview'
import {
  mergeImageVariantsFromOutputs,
  registerImageVariants,
  withRegisteredImageVariants,
} from '@/lib/imageVariants'
import type { CanvasNodeData } from '@/lib/types'

for (const [key, value] of Object.entries({
  DB_USER: 'test',
  DB_PASSWORD: 'test',
  DB_NAME: 'test',
  SESSION_SECRET: 'test-secret',
  INITIAL_ADMIN_PASSWORD: 'test-only',
})) {
  if (!process.env[key]) process.env[key] = value
}

const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const path = require('node:path') as typeof import('node:path')
const sharp = require('sharp')
// Windows 上 sharp 的文件缓存会占着句柄，临时目录删不掉
sharp.cache(false)
const config = require('../server/config')
const { createImageVariants, isImageVariantName, withImageVariantOutputs } = require('../server/canvasRoutes.js')
const { mergeImageVariantsFromOutputs: serverMerge } = require('../server/services/imageVariants')

const node = (data: Partial<CanvasNodeData>) => ({ type: 'image', name: '图', action: 'image_generate', url: [], ...data }) as CanvasNodeData

describe('节点显示和全屏查看取图', () => {
  const original = '/assets/1/a.png'
  const withVariants = node({
    url: [original],
    _assetImageVariants: {
      [original]: { previewUrl: '/assets/1/a_360.webp', viewerUrl: '/assets/1/a_1080.webp', width: 4096, height: 2304 },
    },
  })

  it('节点用 360 图，全屏用 1080 图，尺寸报原图的', () => {
    expect(mediaPreviewUrl(withVariants, original)).toBe('/assets/1/a_360.webp')
    expect(mediaViewerUrl(withVariants, original)).toBe('/assets/1/a_1080.webp')
    expect(mediaPixelSize(withVariants, original, 640, 360)).toEqual({ w: 4096, h: 2304 })
  })

  it('原图短边不超过 1080 时没有查看图，全屏直接看原图', () => {
    const small = node({
      url: [original],
      _assetImageVariants: { [original]: { previewUrl: '/assets/1/a_360.webp', width: 1024, height: 1024 } },
    })
    expect(mediaPreviewUrl(small, original)).toBe('/assets/1/a_360.webp')
    expect(mediaViewerUrl(small, original)).toBe(original)
  })

  it('上传的图把派生图记在资源信息里也认', () => {
    const uploaded = node({
      url: [original],
      _resourceMeta: { items: [{ kind: 'image', originalUrl: original, previewUrl: '/assets/1/a_360.webp', viewerUrl: '/assets/1/a_1080.webp', width: 3000, height: 2000 }] },
    })
    expect(mediaPreviewUrl(uploaded, original)).toBe('/assets/1/a_360.webp')
    expect(mediaViewerUrl(uploaded, original)).toBe('/assets/1/a_1080.webp')
    expect(imageVariantsForUrl(uploaded, original)).toMatchObject({ width: 3000, height: 2000 })
  })

  it('旧图片照旧：缩略图 / 原图，全屏看原图，尺寸用实际加载的', () => {
    const legacy = node({ url: [original], params: { thumbUrls: ['/assets/1/sha_thumb.webp'] } as never })
    expect(mediaPreviewUrl(legacy, original)).toBe('/assets/1/sha_thumb.webp')
    expect(mediaViewerUrl(legacy, original)).toBe(original)
    expect(mediaPixelSize(legacy, original, 1200, 800)).toEqual({ w: 1200, h: 800 })
    expect(mediaPreviewUrl(node({ url: [original] }), original)).toBe(original)
  })

  it('多图节点里对不上的图不再借用第一条资源信息的预览图', () => {
    const multi = node({
      url: ['/assets/1/a.mp4', '/assets/1/b.mp4'],
      _resourceMeta: { items: [{ kind: 'video', originalUrl: '/assets/1/a.mp4', displayUrl: '/assets/1/a_display.mp4' }] },
    })
    expect(mediaPreviewUrl(multi, '/assets/1/a.mp4')).toBe('/assets/1/a_display.mp4')
    expect(mediaPreviewUrl(multi, '/assets/1/b.mp4')).toBe('/assets/1/b.mp4')
  })
})

describe('派生图写进节点', () => {
  it('上传登记过的图，建节点 / 改节点时自动带上记录，不覆盖已有的', () => {
    registerImageVariants('/assets/9/up.png', {
      url: '/assets/9/up.png',
      previewUrl: '/assets/9/up_360.webp',
      viewerUrl: '/assets/9/up_1080.webp',
      meta: { width: 2000, height: 3000 },
    })
    const patched = withRegisteredImageVariants(undefined, { url: ['/assets/9/up.png'], name: 'x' })
    expect(patched._assetImageVariants?.['/assets/9/up.png']).toEqual({
      previewUrl: '/assets/9/up_360.webp',
      viewerUrl: '/assets/9/up_1080.webp',
      width: 2000,
      height: 3000,
    })
    const kept = { previewUrl: '/assets/9/other.webp' }
    const untouched = withRegisteredImageVariants({ _assetImageVariants: { '/assets/9/up.png': kept } }, { url: ['/assets/9/up.png'] })
    expect(untouched._assetImageVariants).toBeUndefined()
    const noUrl = { name: 'only name' }
    expect(withRegisteredImageVariants(undefined, noUrl)).toBe(noUrl)
  })

  it('生成结果按 outputs 合并，前后端规则一致；没有派生图时不加字段', () => {
    const outputs = [
      { index: 0, url: '/assets/9/g1.png', previewUrl: '/assets/9/g1_360.webp', viewerUrl: '/assets/9/g1_1080.webp', width: 2048, height: 2048 },
      { index: 1, url: '/assets/9/g2.mp4', width: 1280, height: 720 },
    ]
    const urls = ['/assets/9/g1.png', '/assets/9/g2.mp4']
    const front = mergeImageVariantsFromOutputs(undefined, urls, outputs)
    expect(front).toEqual(serverMerge(undefined, urls, outputs))
    expect(Object.keys(front ?? {})).toEqual(['/assets/9/g1.png'])
    expect(mergeImageVariantsFromOutputs(undefined, ['/assets/9/g2.mp4'], [outputs[1]])).toBeUndefined()
  })
})

describe('服务端生成派生图', () => {
  const projectUuid = `vitest-image-variants-${process.pid}-${Date.now()}`
  const dir = path.join(config.projectsDir, projectUuid, 'assets')
  afterAll(() => {
    try {
      fs.rmSync(path.join(config.projectsDir, projectUuid), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      console.warn('image variants test cleanup failed', error)
    }
  })

  async function writeImage(name: string, width: number, height: number) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } }).png().toFile(file)
    return file
  }

  it('大图：短边压到 360 和 1080，保持比例，返回原图尺寸', async () => {
    const file = await writeImage('big.png', 4000, 2250)
    const variants = await createImageVariants(projectUuid, 'big.png', file)
    expect(variants).toEqual({
      width: 4000,
      height: 2250,
      previewUrl: `/assets/${projectUuid}/big_360.webp`,
      viewerUrl: `/assets/${projectUuid}/big_1080.webp`,
    })
    const preview = await sharp(path.join(dir, 'big_360.webp')).metadata()
    const viewer = await sharp(path.join(dir, 'big_1080.webp')).metadata()
    expect([preview.format, preview.height, preview.width]).toEqual(['webp', 360, 640])
    expect([viewer.format, viewer.height, viewer.width]).toEqual(['webp', 1080, 1920])
  })

  it('竖图按宽（短边）压', async () => {
    const file = await writeImage('tall.png', 1500, 3000)
    const variants = await createImageVariants(projectUuid, 'tall.png', file)
    const preview = await sharp(path.join(dir, 'tall_360.webp')).metadata()
    const viewer = await sharp(path.join(dir, 'tall_1080.webp')).metadata()
    expect([preview.width, preview.height]).toEqual([360, 720])
    expect([viewer.width, viewer.height]).toEqual([1080, 2160])
    expect(variants?.viewerUrl).toBeTruthy()
  })

  it('短边不超过 1080 只出 360 图，全屏看原图', async () => {
    const file = await writeImage('mid.png', 1920, 1080)
    const variants = await createImageVariants(projectUuid, 'mid.png', file)
    expect(variants?.previewUrl).toBe(`/assets/${projectUuid}/mid_360.webp`)
    expect(variants?.viewerUrl).toBeUndefined()
    expect(fs.existsSync(path.join(dir, 'mid_1080.webp'))).toBe(false)
  })

  it('比 360 还小的图不放大', async () => {
    const file = await writeImage('tiny.png', 200, 120)
    await createImageVariants(projectUuid, 'tiny.png', file)
    const preview = await sharp(path.join(dir, 'tiny_360.webp')).metadata()
    expect([preview.width, preview.height]).toEqual([200, 120])
  })

  it('GIF、派生图本身不处理；生成结果按地址补上 outputs', async () => {
    expect(await createImageVariants(projectUuid, 'anim.gif', path.join(dir, 'big.png'))).toBeNull()
    expect(await createImageVariants(projectUuid, 'big_360.webp', path.join(dir, 'big_360.webp'))).toBeNull()
    expect(isImageVariantName('abc_1080.webp')).toBe(true)
    expect(isImageVariantName('abc_thumb.webp')).toBe(false)

    const url = `/assets/${projectUuid}/big.png`
    const [output] = await withImageVariantOutputs(projectUuid, [url], [{ index: 0, url, metadata: { codecName: 'png' } }])
    expect(output).toMatchObject({
      index: 0,
      url,
      previewUrl: `/assets/${projectUuid}/big_360.webp`,
      viewerUrl: `/assets/${projectUuid}/big_1080.webp`,
      width: 4000,
      height: 2250,
      metadata: { codecName: 'png' },
    })
    const [foreign] = await withImageVariantOutputs(projectUuid, ['/assets/other/big.png'])
    expect(foreign.previewUrl).toBeUndefined()
  })
})
