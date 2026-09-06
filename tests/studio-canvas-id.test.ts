/**
 * AI 出片建画布时取画布 id 的判据。
 *
 * 这是一个把整个功能报废掉的真实 bug（2026-08-23 查出来，从上线起一直存在）：
 *   createCanvasForPlugin 返回 { canvas: { id }, revision, nodes, ... }，
 *   而代码写的是 Number(canvas.id) —— 取的是外层，undefined。
 *   Number(undefined) 是 NaN；mysql2 把 NaN 原样序列化成裸 NaN 塞进 SQL，
 *   于是 `WHERE id = NaN` 报 "Unknown column 'NaN' in 'where clause'"。
 *   画布 INSERT 其实成功了，但随后两条 UPDATE 全炸 —— canvas_id 永远是 NULL。
 *   后果：3/3 出片项目没画布，上传设定图 409、同步到画布 502。
 *
 * 这条测试真正要守的是**最后那几个用例**：读不出 id 的时候必须抛，
 * 绝不能把 NaN 交出去。让它在这里炸掉、带着看得懂的消息，
 * 比让它变成一句 MySQL 的列名错误好一万倍。
 */
import { describe, expect, it } from 'vitest'

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
const { canvasIdFromSummary } = require('../server/services/StudioService.js')

describe('canvasIdFromSummary', () => {
  it('认嵌套结构（createCanvasForPlugin / getCanvasSummary 的真实形状）', () => {
    expect(canvasIdFromSummary({ canvas: { id: '267' }, revision: 'r1', nodes: [] })).toBe(267)
  })

  it('数字型 id 也认', () => {
    expect(canvasIdFromSummary({ canvas: { id: 280 } })).toBe(280)
  })

  it('顺带容忍扁平结构，万一哪天上游改了形状', () => {
    expect(canvasIdFromSummary({ id: '123' })).toBe(123)
  })

  it('嵌套优先于扁平', () => {
    expect(canvasIdFromSummary({ id: '999', canvas: { id: '267' } })).toBe(267)
  })

  // ── 下面这些就是这条测试存在的理由 ──
  it('取不到 id 时必须抛，绝不能返回 NaN（这正是当初的 bug）', () => {
    expect(() => canvasIdFromSummary({ revision: 'r1', nodes: [] })).toThrow()
    expect(() => canvasIdFromSummary({ canvas: {} })).toThrow()
    expect(() => canvasIdFromSummary({})).toThrow()
    expect(() => canvasIdFromSummary(null)).toThrow()
    expect(() => canvasIdFromSummary(undefined)).toThrow()
  })

  it('非数字 id 也要抛，不能悄悄变成 NaN', () => {
    expect(() => canvasIdFromSummary({ canvas: { id: 'abc' } })).toThrow()
    expect(() => canvasIdFromSummary({ canvas: { id: '' } })).toThrow()
    expect(() => canvasIdFromSummary({ canvas: { id: {} } })).toThrow()
  })

  it('0 和负数不是合法画布 id', () => {
    expect(() => canvasIdFromSummary({ canvas: { id: 0 } })).toThrow()
    expect(() => canvasIdFromSummary({ canvas: { id: -5 } })).toThrow()
  })

  it('抛出来的错要说清是"画布 id 读不出来"，带上拿到的原值', () => {
    let caught: any = null
    try { canvasIdFromSummary({ canvas: {} }) } catch (error) { caught = error }
    expect(caught).toBeTruthy()
    expect(String(caught.message)).toContain('画布 id 读不出来')
    expect(caught.code).toBe('STUDIO_CANVAS_ID_UNREADABLE')
  })

  it('返回的一定是 number，不是字符串（要直接当 SQL 参数用）', () => {
    expect(typeof canvasIdFromSummary({ canvas: { id: '267' } })).toBe('number')
  })
})
