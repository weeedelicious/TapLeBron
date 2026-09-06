/**
 * 分镜表的「角色 / 场景 / 道具」一览列（2026-08-23 用户要求）。
 *
 * 这个功能有两份规范化代码：前端 src/canvas/lib/studio.ts 和后端 StudioService.js。
 * **两边解析不一致是最危险的失效方式** —— 前端存进去的东西被后端改掉，
 * 用户会看到自己刚输入的内容莫名变形，而且没有任何报错。所以下面每条解析规则都
 * 同时对两边断言，用同一份期望值。
 *
 * 另一条底线：老分镜没有这三个字段，读出来必须是空数组（不是 undefined，
 * 否则前端 join 会炸），而且**不能因为缺这三项就把整行丢掉**。
 */
import { describe, expect, it } from 'vitest'
import {
  formatTagList,
  normalizeStoryboardRow,
  parseTagList,
  STUDIO_TAG_LIMIT,
  STUDIO_TAG_MAX_LENGTH,
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

/** 后端没导出单行规范化，走 normalizeStoryboard 拿第一行 */
function serverRow(raw: Record<string, unknown>) {
  return server.normalizeStoryboard({ rows: [{ content: '占位内容', ...raw }] }).rows?.[0]
    ?? server.normalizeStoryboard([{ content: '占位内容', ...raw }])[0]
}

function bothParse(input: unknown) {
  const front = parseTagList(input)
  const back = serverRow({ roles: input })?.roles
  return { front, back }
}

describe('parseTagList（前后端必须一致）', () => {
  it('中文顿号分隔', () => {
    const { front, back } = bothParse('白素贞、许仙、小青')
    expect(front).toEqual(['白素贞', '许仙', '小青'])
    expect(back).toEqual(front)
  })

  it('中英文逗号、分号、斜杠、换行都当分隔符', () => {
    const { front, back } = bothParse('甲，乙, 丙;丁；戊/己\n庚')
    expect(front).toEqual(['甲', '乙', '丙', '丁', '戊', '己', '庚'])
    expect(back).toEqual(front)
  })

  it('直接给数组也收（模型两种都会吐）', () => {
    const { front, back } = bothParse(['断桥', '雷峰塔'])
    expect(front).toEqual(['断桥', '雷峰塔'])
    expect(back).toEqual(front)
  })

  it('去重、去空白项', () => {
    const { front, back } = bothParse('甲、、甲,  乙  ,')
    expect(front).toEqual(['甲', '乙'])
    expect(back).toEqual(front)
  })

  it('空输入是空数组，不是 [""]', () => {
    for (const empty of ['', '   ', '、、、', null, undefined, []]) {
      expect(parseTagList(empty)).toEqual([])
    }
    expect(serverRow({ roles: '' })?.roles).toEqual([])
  })

  it(`最多 ${STUDIO_TAG_LIMIT} 项`, () => {
    const many = Array.from({ length: 30 }, (_, i) => `角色${i}`)
    const { front, back } = bothParse(many)
    expect(front).toHaveLength(STUDIO_TAG_LIMIT)
    expect(back).toEqual(front)
  })

  it(`每项最长 ${STUDIO_TAG_MAX_LENGTH} 字`, () => {
    const long = 'x'.repeat(80)
    const { front, back } = bothParse(long)
    expect(front[0]).toHaveLength(STUDIO_TAG_MAX_LENGTH)
    expect(back).toEqual(front)
  })
})

describe('formatTagList', () => {
  it('用「、」拼回输入框显示', () => {
    expect(formatTagList(['甲', '乙'])).toBe('甲、乙')
  })

  it('空数组和 undefined 都给空串（输入框不能拿到 undefined）', () => {
    expect(formatTagList([])).toBe('')
    expect(formatTagList(undefined)).toBe('')
  })

  it('转回去再解析出来还是同一份（往返不丢东西）', () => {
    const list = ['白素贞', '许仙', '油纸伞']
    expect(parseTagList(formatTagList(list))).toEqual(list)
  })
})

describe('老分镜兼容', () => {
  it('没有这三个字段时是空数组，不是 undefined', () => {
    const row = normalizeStoryboardRow(
      { shot: '1', content: '旧数据', shotSize: '中景', movement: '固定', seconds: 3 },
      0,
      makeId,
    )
    expect(row.roles).toEqual([])
    expect(row.scenes).toEqual([])
    expect(row.props).toEqual([])
  })

  it('缺这三项**不能**把整行丢掉', () => {
    const backend = server.normalizeStoryboard({
      rows: [{ shot: '1', content: '旧数据', shotSize: '中景', movement: '固定', seconds: 3 }],
    })
    expect(backend.rows ?? backend).toHaveLength(1)
  })

  it('模型用中文键名也认', () => {
    const row = normalizeStoryboardRow(
      { 内容: '断桥相遇', 角色: '白素贞、许仙', 场景: '断桥', 道具: '油纸伞' },
      0,
      makeId,
    )
    expect(row.roles).toEqual(['白素贞', '许仙'])
    expect(row.scenes).toEqual(['断桥'])
    expect(row.props).toEqual(['油纸伞'])
    expect(serverRow({ 角色: '白素贞、许仙' })?.roles).toEqual(['白素贞', '许仙'])
  })
})
