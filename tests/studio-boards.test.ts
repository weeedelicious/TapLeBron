/**
 * 分镜绘制（第三阶段）的判据。
 *
 * 这个阶段是**付费**的，所以最要紧的两条是"别多花钱"和"别丢掉已经花过的钱"：
 *
 *   1. `mergeBoardImages` —— 重列清单时按「镜号 + kind」保住已画好的图。
 *      模型每次给的都是新对象、没有 id，所以只能按这个键配对。配错就等于
 *      用户点一下「重列清单」把之前画的全丢了、得重新花一遍。
 *   2. `boardGenerationCost` —— 按钮上写的次数必须等于真的会调几次生图。
 *      写少了用户会以为便宜，写多了会不敢点。
 *
 * 第三条是这个阶段的立身之本：`conceptReferencesForShot` 要能把这一镜的角色 / 场景 / 道具
 * 对上概念图。对不上就不喂参考图，11 镜里的人会长成 11 个样子。
 * 匹配刻意做宽松（互相包含）：概念图名字常写「主角 · 陆沉渊」而分镜表只写「陆沉渊」。
 */
import { describe, expect, it } from 'vitest'
import {
  boardGenerationCost,
  boardKindLabel,
  boardKindsForMethod,
  normalizeBoardSettings,
  normalizeBoards,
  STUDIO_BOARD_METHODS,
} from '@/lib/studio'

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
const server = require('../server/services/StudioService.js')

let seq = 0
const makeId = () => `id-${(seq += 1)}`

const item = (over: Record<string, unknown> = {}) => ({
  id: 'b1', shot: '1', kind: 'main', prompt: '一段提示词',
  referenceUrls: [], imageUrl: '', nodeKey: '', status: 'pending', error: '',
  ...over,
})

describe('normalizeBoardSettings（前后端一致）', () => {
  it('画风只收白名单里的，全不合法就退回默认「描线」', () => {
    for (const raw of [{ styles: ['乱写', 'x'] }, { styles: [] }, {}, null]) {
      expect(normalizeBoardSettings(raw).styles).toEqual(['描线'])
      expect(server.normalizeBoards({ settings: raw }).settings.styles).toEqual(['描线'])
    }
  })

  it('合法画风保留顺序（第一个是主调）并去重', () => {
    const raw = { styles: ['彩色', '日漫', '彩色'] }
    expect(normalizeBoardSettings(raw).styles).toEqual(['彩色', '日漫'])
    expect(server.normalizeBoards({ settings: raw }).settings.styles).toEqual(['彩色', '日漫'])
  })

  it('绘制方法只有 main / endpoints，非法值退回 main', () => {
    expect(normalizeBoardSettings({ method: 'endpoints' }).method).toBe('endpoints')
    expect(normalizeBoardSettings({ method: '乱写' }).method).toBe('main')
    expect(server.normalizeBoards({ settings: { method: 'endpoints' } }).settings.method).toBe('endpoints')
    expect(server.normalizeBoards({ settings: { method: '乱写' } }).settings.method).toBe('main')
  })
})

describe('normalizeBoards', () => {
  it('老项目那一列是 NULL 时给出默认 settings 和空 items，不是 undefined', () => {
    const front = normalizeBoards(null, makeId)
    expect(front.items).toEqual([])
    expect(front.settings.styles).toEqual(['描线'])
    const back = server.normalizeBoards(null)
    expect(back.items).toEqual([])
    expect(back.settings.method).toBe('main')
  })

  it('kind 非法时退回 main，模型用中文键名也认', () => {
    const front = normalizeBoards({ items: [{ 镜号: '3', 类型: 'end', 提示词: '尾帧' }] }, makeId)
    expect(front.items[0].shot).toBe('3')
    expect(front.items[0].kind).toBe('end')
    expect(normalizeBoards({ items: [{ shot: '1', kind: '乱写', prompt: 'x' }] }, makeId).items[0].kind).toBe('main')
  })

  it('status 由"有没有图"推导，不信任传进来的值', () => {
    const withImage = normalizeBoards({ items: [{ shot: '1', prompt: 'x', imageUrl: '/a.png', status: 'failed' }] }, makeId)
    expect(withImage.items[0].status).toBe('ready')
    expect(withImage.items[0].error).toBe('')
    const noImage = normalizeBoards({ items: [{ shot: '1', prompt: 'x', status: 'ready' }] }, makeId)
    expect(noImage.items[0].status).toBe('pending')
  })

  it('既没镜号又没提示词的空条目丢掉（模型会尾随空对象）', () => {
    expect(normalizeBoards({ items: [{}, { shot: '1', prompt: 'x' }, {}] }, makeId).items).toHaveLength(1)
  })
})

describe('boardGenerationCost（按钮上那个数字）', () => {
  const items = [
    item({ id: 'a', imageUrl: '' }),
    item({ id: 'b', imageUrl: '/b.png' }),
    item({ id: 'c', imageUrl: '' }),
  ] as never[]

  it('默认只算勾中且还没有图的', () => {
    expect(boardGenerationCost(items, new Set(['a', 'b', 'c']), false)).toBe(2)
  })

  it('勾了重画就把已有图的也算进去', () => {
    expect(boardGenerationCost(items, new Set(['a', 'b', 'c']), true)).toBe(3)
  })

  it('没勾任何一条就是 0（按钮该是灰的）', () => {
    expect(boardGenerationCost(items, new Set(), true)).toBe(0)
  })

  it('只勾了已有图的、又没开重画 → 0，不能让人以为点了会画', () => {
    expect(boardGenerationCost(items, new Set(['b']), false)).toBe(0)
  })
})

describe('boardKindsForMethod / boardKindLabel', () => {
  it('主要画面一镜一张，首尾帧一镜两张', () => {
    expect(boardKindsForMethod('main')).toEqual(['main'])
    expect(boardKindsForMethod('endpoints')).toEqual(['start', 'end'])
  })

  it('METHODS 里的 perShot 必须跟 boardKindsForMethod 对得上（界面靠它算成本）', () => {
    for (const method of STUDIO_BOARD_METHODS) {
      expect(boardKindsForMethod(method.key)).toHaveLength(method.perShot)
    }
  })

  it('标签是人话', () => {
    expect(boardKindLabel('start')).toBe('首帧')
    expect(boardKindLabel('end')).toBe('尾帧')
    expect(boardKindLabel('main')).toBe('主画面')
  })
})

describe('mergeBoardImages（重列清单不许丢已花钱的图）', () => {
  it('按「镜号 + kind」把已画好的图搬到新清单上', () => {
    const previous = [
      item({ id: 'old-1', shot: '1', kind: 'main', imageUrl: '/1.png', nodeKey: 'n1', status: 'ready' }),
      item({ id: 'old-2', shot: '2', kind: 'main', imageUrl: '', status: 'pending' }),
    ]
    const incoming = [
      item({ id: 'new-1', shot: '1', kind: 'main', prompt: '重写的提示词' }),
      item({ id: 'new-2', shot: '2', kind: 'main', prompt: '重写的提示词2' }),
    ]
    const merged = server.mergeBoardImages(previous, incoming)
    // 镜 1 有图 → 图、nodeKey、id 都保住，但提示词用新的
    expect(merged[0].imageUrl).toBe('/1.png')
    expect(merged[0].nodeKey).toBe('n1')
    expect(merged[0].id).toBe('old-1')
    expect(merged[0].prompt).toBe('重写的提示词')
    // 镜 2 没图 → 原样用新条目
    expect(merged[1].imageUrl).toBe('')
  })

  it('kind 变了就不算同一张（主画面的图不能顶到首帧上）', () => {
    const previous = [item({ shot: '1', kind: 'main', imageUrl: '/main.png' })]
    const incoming = [item({ shot: '1', kind: 'start', prompt: '首帧' })]
    expect(server.mergeBoardImages(previous, incoming)[0].imageUrl).toBe('')
  })

  it('镜号变了也不算同一张', () => {
    const previous = [item({ shot: '1', kind: 'main', imageUrl: '/1.png' })]
    const incoming = [item({ shot: '2', kind: 'main', prompt: 'x' })]
    expect(server.mergeBoardImages(previous, incoming)[0].imageUrl).toBe('')
  })

  it('没有图的旧条目不参与配对（免得把 pending 状态搬过去）', () => {
    const previous = [item({ shot: '1', kind: 'main', imageUrl: '', status: 'failed', error: '旧错误' })]
    const incoming = [item({ shot: '1', kind: 'main', prompt: 'x' })]
    const merged = server.mergeBoardImages(previous, incoming)
    expect(merged[0].status).toBe('pending')
    expect(merged[0].error).toBe('')
  })
})

describe('conceptReferencesForShot（这一镜喂哪些概念图）', () => {
  const concepts = [
    { name: '主角 · 陆沉渊', imageUrl: '/lu.png' },
    { name: '配角 · 张桂兰', imageUrl: '/zhang.png' },
    { name: '场景 · 主卧', imageUrl: '/room.png' },
    { name: '道具 · 水杯', imageUrl: '/cup.png' },
    { name: '道具 · 还没画的伞', imageUrl: '' },
  ]

  it('角色 / 场景 / 道具三类都能对上，名字互相包含即算命中', () => {
    const urls = server.conceptReferencesForShot(
      { roles: ['陆沉渊'], scenes: ['主卧'], props: ['水杯'] },
      concepts,
    )
    expect(urls).toEqual(['/lu.png', '/room.png', '/cup.png'])
  })

  it('没画的概念图不喂（没有 imageUrl 就没东西可喂）', () => {
    expect(server.conceptReferencesForShot({ props: ['伞'] }, concepts)).toEqual([])
  })

  it('一览列是空的就返回空数组，不要把全部概念图都塞进去', () => {
    expect(server.conceptReferencesForShot({ roles: [], scenes: [], props: [] }, concepts)).toEqual([])
    expect(server.conceptReferencesForShot({}, concepts)).toEqual([])
  })

  it('去重：同一张概念图被角色和道具同时命中也只喂一次', () => {
    const urls = server.conceptReferencesForShot(
      { roles: ['陆沉渊'], props: ['陆沉渊'] },
      concepts,
    )
    expect(urls).toEqual(['/lu.png'])
  })

  it('对不上的名字不乱喂', () => {
    expect(server.conceptReferencesForShot({ roles: ['完全没关系的人'] }, concepts)).toEqual([])
  })
})
