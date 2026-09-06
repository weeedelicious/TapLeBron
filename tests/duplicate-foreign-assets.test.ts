/**
 * 复制画布时，指向**别的画布**的资产也要拉进副本（2026-08-26 线上问题）。
 *
 * ── 现场 ────────────────────────────────────────────────────────────────────
 * 邓星豪从画布 273 跨画布粘贴了 37 个节点到共享画布 297，粘贴不搬资产，
 * 于是 297 里有 43 个地址指向 `/assets/273/...`。273 是**未共享**画布，
 * 而 `/assets/:canvasId/:filename` 是按那个画布鉴权的、读不到就 404。
 *
 * 于是：
 *   · 吴逸翔是 **admin** → 273 也能读 → 复制到本地看着一切正常；
 *   · 徐子婷、孟蓉是普通用户 → 那 43 张一律 404 → 「丢失了很多图片」。
 *
 * 复制本身也救不了：原来的改写只处理 `/assets/<源画布>/`，指向第三个画布的引用
 * 原样保留。全站扫过：170 个画布里 45 个带跨画布引用，28 个指向未共享画布。
 *
 * ── 这个文件守什么 ──────────────────────────────────────────────────────────
 * 文件复制那部分要碰磁盘和对象存储，jsdom 里跑不了；但**认出哪些要搬**和
 * **改写哪些地址**是纯函数，而且正是最容易写错的两处：
 *   ① 漏掉某种地址形状（比如藏在 node.data 那层 JSON 字符串里的）→ 副本继续缺图；
 *   ② 复制失败了还照样改写 → 把「一部分人 404」变成「所有人 404」，比原来更糟。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

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
const { collectForeignAssetRefs, rewriteForeignAssetRefs } = require('../server/canvasRoutes.js')
const fs = require('node:fs') as typeof import('node:fs')
const path = require('node:path') as typeof import('node:path')

const key = (canvasId: string | number, storedName: string) => `${canvasId}/${storedName}`

/** 线上那份数据的形状：node.data 是一段 JSON 字符串，地址藏在里面。 */
const canvasLike = (targetId: number) => ({
  nodeList: [
    {
      id: 'n1',
      projectUuid: String(targetId),
      // ★ 关键：这一层是**字符串**，不是对象
      data: JSON.stringify({
        type: 'image',
        url: ['/assets/273/aaa.png', `/assets/${targetId}/own.png`],
        _primaryAssetUrl: '/assets/273/aaa.png',
        params: {
          imageList: [{ nodeId: 'x', url: '/assets/273/bbb.jpg', mediaType: 'image' }],
          promptChips: '<span data-url="/assets/273/ccc.webp">图片1</span>',
        },
        _resourceMeta: { items: [{ originalUrl: '/assets/273/aaa.png', displayUrl: '/assets/273/aaa_thumb.webp' }] },
      }),
    },
    {
      id: 'n2',
      projectUuid: String(targetId),
      // 视频的实际文件名是 provider 给的 `cgt-<时间戳>-<随机>.mp4`，带连字符 ——
      // 地址正则漏掉连字符的话，所有视频都认不出来
      data: JSON.stringify({ type: 'video', url: ['/assets/208/cgt-20260826113645-vcwzt.mp4'] }),
    },
  ],
  coverUrl: '/assets/273/aaa.png',
  projectDraft: { projectUuid: String(targetId) },
})

describe('① 认出所有指向别的画布的引用', () => {
  it('★ 连 node.data 那层 JSON 字符串里的也认得出来（漏了就继续缺图）', () => {
    const refs = collectForeignAssetRefs(canvasLike(305), 305)
    const found = new Set(refs.map((r: { canvasId: string; storedName: string }) => key(r.canvasId, r.storedName)))
    for (const expected of ['273/aaa.png', '273/bbb.jpg', '273/ccc.webp', '208/cgt-20260826113645-vcwzt.mp4']) {
      expect(found, `没认出 ${expected}`).toContain(expected)
    }
  })

  it('★ 指向自己的不算（否则会把自己的资产又复制一遍）', () => {
    const refs = collectForeignAssetRefs(canvasLike(305), 305)
    expect(refs.some((r: { canvasId: string }) => r.canvasId === '305')).toBe(false)
  })

  it('缩略图不单独算一条（它是派生物，跟正片一起走）', () => {
    const refs = collectForeignAssetRefs(canvasLike(305), 305)
    expect(refs.some((r: { storedName: string }) => r.storedName.endsWith('_thumb.webp'))).toBe(false)
  })

  it('同一个文件被多处引用只返回一条', () => {
    const refs = collectForeignAssetRefs(canvasLike(305), 305)
    const aaa = refs.filter((r: { storedName: string }) => r.storedName === 'aaa.png')
    expect(aaa.length).toBe(1)
  })

  it('目标 id 是字符串还是数字都一样', () => {
    expect(collectForeignAssetRefs(canvasLike(305), '305').length)
      .toBe(collectForeignAssetRefs(canvasLike(305), 305).length)
  })

  it('没有跨画布引用时返回空数组', () => {
    const clean = { nodeList: [{ data: JSON.stringify({ url: ['/assets/305/a.png'] }) }] }
    expect(collectForeignAssetRefs(clean, 305)).toEqual([])
  })

  it('脏输入不抛（含循环引用、undefined、纯字符串）', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(() => collectForeignAssetRefs(circular, 1)).not.toThrow()
    expect(collectForeignAssetRefs(undefined, 1)).toEqual([])
    expect(collectForeignAssetRefs('/assets/9/x.png', 1)).toEqual([{ canvasId: '9', storedName: 'x.png' }])
  })
})

describe('② 只改写复制成功的那些', () => {
  it('★ 复制成功的改写到目标画布名下', () => {
    const localized = new Set([key(273, 'aaa.png'), key(273, 'bbb.jpg')])
    const next = rewriteForeignAssetRefs(canvasLike(305), 305, localized)
    const first = JSON.parse(next.nodeList[0].data)
    expect(first.url).toContain('/assets/305/aaa.png')
    expect(first.params.imageList[0].url).toBe('/assets/305/bbb.jpg')
    expect(next.coverUrl).toBe('/assets/305/aaa.png')
  })

  it('★★ 没复制成功的**绝不**改写 —— 否则「一部分人 404」变成「所有人 404」', () => {
    const localized = new Set([key(273, 'aaa.png')])
    const next = rewriteForeignAssetRefs(canvasLike(305), 305, localized)
    const first = JSON.parse(next.nodeList[0].data)
    // ccc.webp 没在 localized 里 → 必须保持指向 273
    expect(first.params.promptChips).toContain('/assets/273/ccc.webp')
    const second = JSON.parse(next.nodeList[1].data)
    expect(second.url[0]).toBe('/assets/208/cgt-20260826113645-vcwzt.mp4')
  })

  it('提示词药丸里的 data-url 也跟着改（服务端会把药丸地址并进请求）', () => {
    const next = rewriteForeignAssetRefs(canvasLike(305), 305, new Set([key(273, 'ccc.webp')]))
    expect(JSON.parse(next.nodeList[0].data).params.promptChips).toContain('/assets/305/ccc.webp')
  })

  it('缩略图地址跟着正片一起改（同一个文件名前缀）', () => {
    const next = rewriteForeignAssetRefs(canvasLike(305), 305, new Set([key(273, 'aaa_thumb.webp')]))
    expect(JSON.parse(next.nodeList[0].data)._resourceMeta.items[0].displayUrl).toBe('/assets/305/aaa_thumb.webp')
  })

  it('localized 为空时原样返回（不做无谓的深拷贝改写）', () => {
    const input = canvasLike(305)
    expect(rewriteForeignAssetRefs(input, 305, new Set())).toBe(input)
    expect(rewriteForeignAssetRefs(input, 305, undefined)).toBe(input)
  })

  it('不改动指向自己的地址', () => {
    const next = rewriteForeignAssetRefs(canvasLike(305), 305, new Set([key(273, 'aaa.png')]))
    expect(JSON.parse(next.nodeList[0].data).url).toContain('/assets/305/own.png')
  })

  it('不改动输入对象（调用方还拿着原始数据）', () => {
    const input = canvasLike(305)
    const snapshot = JSON.stringify(input)
    rewriteForeignAssetRefs(input, 305, new Set([key(273, 'aaa.png')]))
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('改写完之后再扫一遍：成功的那些不该再出现', () => {
    const all = collectForeignAssetRefs(canvasLike(305), 305)
    const localized = new Set(all.map((r: { canvasId: string; storedName: string }) => key(r.canvasId, r.storedName)))
    const next = rewriteForeignAssetRefs(canvasLike(305), 305, localized)
    expect(collectForeignAssetRefs(next, 305)).toEqual([])
  })
})

/*
 * 文件复制那部分要碰磁盘 + 对象存储 + MySQL，jsdom 里跑不了。
 * 按 `tests/node-selected-resolution.test.tsx` 的先例做源码接线断言 ——
 * 纯函数写对了但没接上，线上照样缺图。
 */
describe('真的接到复制 / 建模板两条路上了', () => {
  const SOURCE = (fs.readFileSync(
    path.join(__dirname, '..', 'server/canvasRoutes.js'),
    'utf8',
  ) as string).replace(/\r\n/g, '\n')

  it('两条路都调了 localizeForeignAssets', () => {
    const duplicate = SOURCE.slice(
      SOURCE.indexOf("apiRouter.post('/projects/:uuid/duplicate'"),
      SOURCE.indexOf("apiRouter.post('/projects/:uuid/template'"),
    )
    const template = SOURCE.slice(
      SOURCE.indexOf("apiRouter.post('/projects/:uuid/template'"),
      SOURCE.indexOf("apiRouter.post('/projects/:uuid/access-session/enter'"),
    )
    expect(duplicate.length).toBeGreaterThan(200)
    expect(template.length).toBeGreaterThan(200)
    expect(duplicate, '复制路径没接上').toContain('localizeForeignAssets(duplicatedData')
    expect(template, '建模板路径没接上').toContain('localizeForeignAssets(duplicatedData')
  })

  it('★ 保存的是改写后的数据（保存原始 duplicatedData 等于白干）', () => {
    for (const reason of ['duplicate', 'template_create']) {
      const at = SOURCE.indexOf(`reason: '${reason}'`)
      expect(at, reason).toBeGreaterThan(-1)
      const call = SOURCE.slice(SOURCE.lastIndexOf('saveCanvasData(', at), at)
      expect(call, `${reason} 存的还是没改写的数据`).toContain('localizeResult.data')
    }
  })

  it('复制成功才计入 localized（跳过的不进集合）', () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf('async function localizeForeignAssets'),
      SOURCE.indexOf('async function duplicateProjectAssets'),
    )
    expect(fn).toContain('skipped++')
    expect(fn).toContain('localized.add(')
    // 跳过的那条分支后面必须 continue，不能往下走到 localized.add
    const skipBranch = fn.slice(fn.indexOf('if (!fs.existsSync(srcPath))'))
    expect(skipBranch.slice(0, 120)).toContain('continue')
  })

  it('对象存储镜像失败不能让整次复制挂掉（图还在本地，能用）', () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf('async function localizeForeignAssets'),
      SOURCE.indexOf('async function duplicateProjectAssets'),
    )
    expect(fn).toContain('mirrorStoredAsset(targetCanvasRow.id, storedName, destPath, mimeType).catch(')
  })
})
