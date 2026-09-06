/**
 * 补收任务结果时必须**追加**，不能替换（2026-08-25 事故）。
 *
 * 事故经过：canvas 262 的视频节点 P2-2 上积累了 17 条生成好的视频，
 * 一次任务补收（revision_reason=recover_generation_result）把它打成了 **1 条**。
 * 那一行是 `nodeData.url = urls` —— 把节点上已有的产物整个换成这一个任务的输出。
 *
 * 为什么这个错法特别毒：
 *   · **没有任何报错**。节点看起来"正常"，只是少了 16 条视频，每条都是付过费的；
 *   · 触发它的不是用户操作，而是**网络抖动**：轮询失败 → 任务被留在未收状态 →
 *     前端下次进画布时来补收 → 打掉。用户只是刷新了一下页面；
 *   · 它**只在特定时机可见**。当时浏览器内存里还留着完整的 17 条，autosave 又覆盖回去了，
 *     所以现场"自己好了"。但只要在被打掉的那一刻刷新页面，内存那份就没了，丢失变成永久。
 *
 * 客户端那条补收路径本来是有护栏的（tasksStore：节点已经有内容就整个跳过），
 * 而它自己会去调服务端这个接口，服务端却没有同样的护栏 —— 两边不对称就是根因。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

for (const [key, value] of Object.entries({
  DB_USER: 'test',
  DB_PASSWORD: 'test',
  DB_NAME: 'test',
  SESSION_SECRET: 'test-secret',
  INITIAL_ADMIN_PASSWORD: 'test-only',
})) {
  if (!process.env[key]) process.env[key] = value
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mergeRecoveredUrls } = require('../server/canvasRoutes.js')

/** 真实事故的形状：节点上 17 条，补收进来 1 条。 */
const SEVENTEEN = Array.from({ length: 17 }, (_, i) => `/assets/262/v${i + 1}.mp4`)

describe('事故本身：17 条 + 补收 1 条 = 18 条，不是 1 条', () => {
  it('已有的一条都不能少', () => {
        const merged = mergeRecoveredUrls(SEVENTEEN, ['/assets/262/recovered.mp4'])
    expect(merged).toHaveLength(18)
    for (const url of SEVENTEEN) expect(merged).toContain(url)
    expect(merged).toContain('/assets/262/recovered.mp4')
  })

  it('已有的在前、补收的追加在后（顺序就是画廊里的顺序）', () => {
    const merged = mergeRecoveredUrls(['/a.mp4', '/b.mp4'], ['/c.mp4'])
    expect(merged).toEqual(['/a.mp4', '/b.mp4', '/c.mp4'])
  })
})

describe('重复补收不能长出重复项', () => {
  it('补收的就是节点上已有的那条 → 原样不变（这是最常见的情形：任务其实早就应用过了）', () => {
    const merged = mergeRecoveredUrls(SEVENTEEN, [SEVENTEEN[5]])
    expect(merged).toEqual(SEVENTEEN)
  })

  it('连着补收同一个任务多次也不会重复', () => {
    let urls = ['/a.mp4']
    for (let i = 0; i < 5; i++) urls = mergeRecoveredUrls(urls, ['/b.mp4', '/c.mp4'])
    expect(urls).toEqual(['/a.mp4', '/b.mp4', '/c.mp4'])
  })

  it('补收进来的那一批自己有重复也只留一份', () => {
    expect(mergeRecoveredUrls([], ['/a.mp4', '/a.mp4', '/b.mp4'])).toEqual(['/a.mp4', '/b.mp4'])
  })
})

describe('空节点上补收（这条路径本来就该写进去）', () => {
  it('节点还没有产物 → 就是补收进来的那些', () => {
    expect(mergeRecoveredUrls([], ['/a.mp4', '/b.mp4'])).toEqual(['/a.mp4', '/b.mp4'])
  })

  it('老节点的 url 是 undefined / null / 不是数组 → 当空处理，不炸', () => {
    for (const bad of [undefined, null, 'nope', 42, {}]) {
      expect(mergeRecoveredUrls(bad, ['/a.mp4'])).toEqual(['/a.mp4'])
    }
  })

  it('补收进来的是脏数据 → 已有的一条都不能因此丢掉', () => {
    for (const bad of [undefined, null, 'nope', 42, {}, []]) {
      expect(mergeRecoveredUrls(SEVENTEEN, bad)).toEqual(SEVENTEEN)
    }
  })
})

describe('脏数据清理', () => {
  it('空串 / 纯空格 / 非字符串都被丢掉，不会在画廊里留下裂图占位', () => {
    expect(mergeRecoveredUrls(['/a.mp4', '', '   ', null, 7], ['/b.mp4', undefined])).toEqual([
      '/a.mp4',
      '/b.mp4',
    ])
  })

  it('两侧首尾空格归一化后再去重（同一条别因为多个空格变两条）', () => {
    expect(mergeRecoveredUrls([' /a.mp4 '], ['/a.mp4'])).toEqual(['/a.mp4'])
  })
})

describe('故意不做 30 条上限截断', () => {
  /*
   * 前端 mergeResultUrls 有 .slice(-30)，那是给正常生成做的 UI/内存保护。
   * 这条路径的全部意义是"别丢结果"，在这儿静默淘汰最老的一条正好是反着来的。
   */
  it('已有 30 条再补收 1 条 → 31 条，不淘汰最老的', () => {
    const thirty = Array.from({ length: 30 }, (_, i) => `/v${i}.mp4`)
    const merged = mergeRecoveredUrls(thirty, ['/new.mp4'])
    expect(merged).toHaveLength(31)
    expect(merged[0]).toBe('/v0.mp4')
    expect(merged.at(-1)).toBe('/new.mp4')
  })
})

describe('不修改传进来的数组（调用方还要用 nodeData.url 判断主位）', () => {
  it('原数组不被就地改动', () => {
    const existing = ['/a.mp4']
    const frozen = [...existing]
    mergeRecoveredUrls(existing, ['/b.mp4'])
    expect(existing).toEqual(frozen)
  })
})

/*
 * 上面测的是合并函数。但「补收路由到底有没有用它」是另一回事 ——
 * 谁把那一行改回 `nodeData.url = urls`，上面 12 条一条都不会红，事故原样复发。
 * 路由跑在 express 里没法直接单测，所以这里退一步做接线断言。
 */
describe('补收路由确实用了合并函数', () => {
  const source: string = readFileSync(join(__dirname, '..', 'server/canvasRoutes.js'), 'utf8')
  /** 只截 /tasks/:jobId/recover 这个 handler，别被文件里别处的同名写法干扰 */
  const handler = (() => {
    const start = source.indexOf("apiRouter.post('/projects/:projectUuid/tasks/:jobId/recover'")
    expect(start, '找不到补收路由，测试锚点要更新').toBeGreaterThan(0)
    return source.slice(start, start + 4000)
  })()

  it('写回 url 时走 mergeRecoveredUrls', () => {
    expect(handler).toContain('nodeData.url = mergeRecoveredUrls(nodeData.url, urls)')
  })

  it('不存在"整个替换"的写法', () => {
    expect(handler, '补收路由又变成替换了，17 条会被打成 1 条').not.toMatch(
      /nodeData\.url\s*=\s*urls\s*;/,
    )
  })

  it('主位不被无条件顶掉', () => {
    expect(handler, '_primaryAssetUrl 又被无条件设成补收的第一条了').not.toMatch(
      /nodeData\._primaryAssetUrl\s*=\s*urls\[0\]\s*;/,
    )
    expect(handler).toContain('keepPrimary')
  })
})
