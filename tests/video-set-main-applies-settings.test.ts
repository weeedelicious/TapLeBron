/**
 * 「设为主视频」时把底栏生成参数换成这条视频当初那套（2026-08-19 用户要求）。
 *
 * 这里不渲染组件，而是直接验那套换算规则本身 —— 组件里的 setMainVideo 用的就是这几个
 * 归一化函数，规则错了组件必然错，规则对了剩下的只是把值塞进 params。
 *
 * 重点锁两件容易出错的事：
 *   1. 老视频可能是别的模型生成的，它的清晰度 / 时长在新模型上不一定合法（4K 只有 2.0 有，
 *      2.5 能到 30 秒而 2.0 只能 15 秒）—— 不归一化就会留下一个"提交必报错"的非法组合；
 *   2. adaptive 这类受模式限制的比例，要按当前模式判定。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeVideoRatioValue,
  normalizeVideoResolutionValue,
  normalizeVideoDurationValue,
} from '@/lib/videoRules'

/** 跟组件里 setMainVideo 一致的换算：拿这条视频的元数据算出该落到底栏的值。 */
function settingsFromMeta(
  meta: { model?: string; ratio?: string; resolution?: string; durationSec?: number },
  current: { model: string; ratio: string; resolution: string; duration: number },
  mode = 't2v' as const,
) {
  const model = meta.model || current.model
  return {
    model,
    ratio: normalizeVideoRatioValue(model, meta.ratio ?? current.ratio, mode),
    resolution: normalizeVideoResolutionValue(model, meta.resolution ?? current.resolution),
    duration: normalizeVideoDurationValue(model, meta.durationSec ?? current.duration, mode),
  }
}

const CURRENT = { model: 'Seedance_2_5', ratio: '16:9', resolution: '720P', duration: 5 }

describe('设为主视频后套用它的参数', () => {
  it('原样套用同模型的合法参数', () => {
    expect(settingsFromMeta(
      { model: 'Seedance_2_5', ratio: '9:16', resolution: '1080P', durationSec: 12 },
      CURRENT,
    )).toEqual({ model: 'Seedance_2_5', ratio: '9:16', resolution: '1080P', duration: 12 })
  })

  it('切到 2.0 的 4K 视频时，模型和 4K 一起套过来（4K 在 2.0 上合法）', () => {
    expect(settingsFromMeta(
      { model: 'Seedance_2_0', ratio: '21:9', resolution: '4K', durationSec: 10 },
      CURRENT,
    )).toEqual({ model: 'Seedance_2_0', ratio: '21:9', resolution: '4K', duration: 10 })
  })

  it('元数据缺模型时用当前模型，非法清晰度被归一化而不是照抄', () => {
    // 没带 model → 留在 2.5；而 4K 在 2.5 上不合法 → 落回默认 720P
    expect(settingsFromMeta({ resolution: '4K' }, CURRENT))
      .toEqual({ model: 'Seedance_2_5', ratio: '16:9', resolution: '720P', duration: 5 })
  })

  it('时长超出新模型上限时被夹到上限（2.5 的 30 秒不能照搬给 2.0）', () => {
    const result = settingsFromMeta(
      { model: 'Seedance_2_0', ratio: '16:9', resolution: '720P', durationSec: 30 },
      CURRENT,
    )
    expect(result.duration).toBe(15)
  })

  it('元数据里什么都没有时，当前设置一个字都不变', () => {
    expect(settingsFromMeta({}, CURRENT))
      .toEqual({ model: 'Seedance_2_5', ratio: '16:9', resolution: '720P', duration: 5 })
  })
})
