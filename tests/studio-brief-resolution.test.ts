/**
 * 出片 brief 里新增的「分辨率」（2026-08-23 用户要求：480P / 720P）。
 *
 * 为什么值得单独锁：这个值最后要拿去调生视频接口。一个非法分辨率进了库，
 * 不会在保存时报错，而是要等到真的去生成视频时才炸 —— 那时候离出错的地方已经很远了。
 * 所以规范化必须在入库前就把它挡住。
 *
 * 顺带锁住老项目的兼容：今天之前的 brief 里没有 resolution 字段，读出来必须补成默认值，
 * 不能是 undefined（前端 select 拿到 undefined 会变成不受控组件）。
 */
import { describe, expect, it } from 'vitest'

/*
 * StudioService 要 require server/config.js，而它在加载时就强制要求这几个环境变量存在。
 * 这里只是让模块能加载 —— normalizeBrief 是纯函数，不碰数据库（getPool 是懒的，
 * 只在真正查询时才建连接池，本文件一次都不会走到）。填的都是假值，不连任何东西。
 */
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
const { normalizeBrief } = require('../server/services/StudioService.js')

/** 只关心 resolution 的话，其他字段给空对象就行 —— normalizeBrief 会自己兜底。 */
function res(raw: unknown, previous: Record<string, unknown> = {}) {
  return normalizeBrief(raw, previous).resolution
}

describe('brief.resolution', () => {
  it('480P 和 720P 都收', () => {
    expect(res({ resolution: '480P' })).toBe('480P')
    expect(res({ resolution: '720P' })).toBe('720P')
  })

  it('老项目没有这个字段时补成 720P，不能是 undefined', () => {
    const brief = normalizeBrief({ outline: '一句话' }, {})
    expect(brief.resolution).toBe('720P')
    expect(brief.resolution).not.toBeUndefined()
  })

  it('小写 720p 也认，统一存成大写', () => {
    expect(res({ resolution: '720p' })).toBe('720P')
    expect(res({ resolution: ' 480p ' })).toBe('480P')
  })

  it('非法值不许进库：退回上一次的值', () => {
    expect(res({ resolution: '1080P' }, { resolution: '480P' })).toBe('480P')
    expect(res({ resolution: '4K' }, { resolution: '720P' })).toBe('720P')
    expect(res({ resolution: 'drop table' }, { resolution: '480P' })).toBe('480P')
  })

  it('非法值且没有上一次的值时退回默认 720P', () => {
    expect(res({ resolution: '1080P' })).toBe('720P')
    expect(res({ resolution: null })).toBe('720P')
    expect(res({ resolution: 12345 })).toBe('720P')
  })

  it('这次没传 resolution 时保留上一次的，不要被默认值悄悄改掉', () => {
    // 只改大纲的一次保存不该把 480P 变回 720P
    expect(res({ outline: '改了大纲' }, { resolution: '480P' })).toBe('480P')
  })

  it('raw 整个不是对象也不炸', () => {
    expect(res(null)).toBe('720P')
    expect(res(undefined)).toBe('720P')
    expect(res('nope')).toBe('720P')
  })
})

describe('brief 其他字段没被这次改动带坏', () => {
  it('比例和时长照旧兜底', () => {
    const brief = normalizeBrief({ ratio: '9:16', seconds: 60 }, {})
    expect(brief.ratio).toBe('9:16')
    expect(brief.seconds).toBe(60)
    expect(brief.resolution).toBe('720P')
  })

  it('非法比例仍退回 16:9、非法时长仍退回 30', () => {
    const brief = normalizeBrief({ ratio: '3:2', seconds: 7 }, {})
    expect(brief.ratio).toBe('16:9')
    expect(brief.seconds).toBe(30)
  })
})
