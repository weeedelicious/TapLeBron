/**
 * 动态分镜（第四阶段）与成片（第五阶段）的判据。
 *
 * 这两个阶段一条视频要几分钟、每条都花钱，所以最要紧的是**别重复付费**：
 *
 *   1. status 必须由**事实**推导，不信任传进来的值：
 *      有视频 = ready；有 providerTaskId 但没视频 = running；都没有 = pending。
 *      这条是整个异步设计的地基 —— 只要 taskId 落了库，页面关了、服务重启了，
 *      之后 poll 一次照样能把结果收回来，不会因为"看起来没生成"而再交一次钱。
 *   2. 正在跑的条目（running）**不许**再次提交。漏了这条，用户多点一下按钮就是双倍花钱。
 *
 * 顺带锁住两个阶段的默认档不同（动态分镜 480P 是草样，成片 720P 是交付）
 * 以及老项目那两列是 NULL 时的形状。
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
const studio = require('../server/services/StudioService.js')

const stageOf = (raw: unknown, stage = 'motion') => studio.normalizeVideoStage(raw, {}, stage)
const firstItem = (raw: unknown, stage = 'motion') => stageOf({ items: [raw] }, stage).items[0]

describe('status 由事实推导（决定会不会重复付费）', () => {
  it('有视频 → ready，并且清掉错误', () => {
    const item = firstItem({ shot: '1', videoUrl: '/assets/1/a.mp4', status: 'failed', error: '旧错误' })
    expect(item.status).toBe('ready')
    expect(item.error).toBe('')
  })

  it('有 providerTaskId 但没视频 → running（这就是"提交过、还没收"）', () => {
    const item = firstItem({ shot: '1', providerTaskId: 'cgt-abc', status: 'pending' })
    expect(item.status).toBe('running')
    expect(item.providerTaskId).toBe('cgt-abc')
  })

  it('providerTaskId 必须原样留着 —— 丢了它就再也收不回结果，只能重新花钱', () => {
    const item = firstItem({ shot: '1', providerTaskId: 'cgt-keep-me' })
    expect(item.providerTaskId).toBe('cgt-keep-me')
  })

  it('都没有 → pending', () => {
    expect(firstItem({ shot: '1', prompt: 'x' }).status).toBe('pending')
  })

  it('显式 failed 且没视频时保留 failed 和原因', () => {
    const item = firstItem({ shot: '1', status: 'failed', error: '提交被拒' })
    expect(item.status).toBe('failed')
    expect(item.error).toBe('提交被拒')
  })

  it('传进来的 status 是 ready 但其实没视频 → 不认，算 pending', () => {
    expect(firstItem({ shot: '1', status: 'ready' }).status).toBe('pending')
  })
})

describe('两个阶段的默认档不同', () => {
  it('动态分镜默认 480P（草样，看节奏用，省钱）', () => {
    expect(stageOf({}, 'motion').settings.resolution).toBe('480P')
  })

  it('成片默认 720P（最终交付）', () => {
    expect(stageOf({}, 'film').settings.resolution).toBe('720P')
  })

  it('用户选过就按用户的，不被默认覆盖', () => {
    expect(stageOf({ settings: { resolution: '1080P' } }, 'motion').settings.resolution).toBe('1080P')
  })

  it('非法分辨率退回该阶段的默认，不许进库', () => {
    expect(stageOf({ settings: { resolution: '4K' } }, 'motion').settings.resolution).toBe('480P')
    expect(stageOf({ settings: { resolution: '乱写' } }, 'film').settings.resolution).toBe('720P')
  })
})

describe('时长与数量的范围', () => {
  it('只收 provider 支持的档位，非法退回 5 秒', () => {
    expect(stageOf({ settings: { durationSec: 10 } }).settings.durationSec).toBe(10)
    expect(stageOf({ settings: { durationSec: 7 } }).settings.durationSec).toBe(5)
    expect(stageOf({ settings: { durationSec: 999 } }).settings.durationSec).toBe(5)
  })

  it('数量夹在 1..4', () => {
    expect(stageOf({ settings: { count: 3 } }).settings.count).toBe(3)
    expect(stageOf({ settings: { count: 0 } }).settings.count).toBe(1)
    expect(stageOf({ settings: { count: 99 } }).settings.count).toBe(1)
  })
})

describe('老项目兼容与脏数据', () => {
  it('那两列是 NULL 时给出默认 settings 和空 items，不是 undefined', () => {
    for (const raw of [null, undefined, {}, 'nope']) {
      const s = stageOf(raw)
      expect(s.items).toEqual([])
      expect(s.settings.resolution).toBe('480P')
      expect(s.reelUrl).toBe('')
    }
  })

  it('既没镜号又没提示词的空条目丢掉', () => {
    expect(stageOf({ items: [{}, { shot: '1', prompt: 'x' }, {}] }).items).toHaveLength(1)
  })

  it('首帧和尾帧地址都读得出来（首尾帧模式要用）', () => {
    const item = firstItem({
      shot: '1', sourceImageUrl: '/assets/1/start.png', endImageUrl: '/assets/1/end.png',
    })
    expect(item.sourceImageUrl).toBe('/assets/1/start.png')
    expect(item.endImageUrl).toBe('/assets/1/end.png')
  })

  it('串片结果存在阶段上、不在条目里（它是整条片子的产物）', () => {
    const s = stageOf({ reelUrl: '/assets/1/reel.mp4', reelNodeKey: 'n9' })
    expect(s.reelUrl).toBe('/assets/1/reel.mp4')
    expect(s.reelNodeKey).toBe('n9')
  })
})

describe('文档要求的「修改」轴', () => {
  it('面部 / pose / 局部画面 / 特效四个都在', () => {
    expect(studio.VIDEO_TWEAKS).toEqual(['改面部', '改pose', '改局部画面', '改特效'])
  })
})
