/**
 * 报错翻译（2026-08-21 那次 4090 抠图 worker 挂掉之后加的）。
 *
 * 当时节点上显示的是 `connect ETIMEDOUT 172.26.166.238:8092`。这句话对用工具的人
 * 毫无用处：看不出谁坏了、也看不出该找谁，很容易以为是自己参数填错。
 *
 * 这里锁两件事：
 *   1. 连接类错误要翻译成"哪个服务没起来 + 该找谁"，并且**保留原始报错**给排查用；
 *   2. **认不出来的错误一律原样返回** —— 这条比第一条重要。宁可显示看不懂的原文，
 *      也不能编一句听起来很确定但方向是错的话，那会把人带到完全错误的排查路径上。
 */
import { describe, expect, it } from 'vitest'
import { describeServiceError, serviceErrorLine } from '@/lib/serviceErrors'

describe('describeServiceError', () => {
  it('8092 连不上时指名是抠图/语义分区服务', () => {
    const r = describeServiceError('connect ETIMEDOUT 172.26.166.238:8092')
    expect(r.isServiceDown).toBe(true)
    expect(r.text).toContain('语义分区')
    expect(r.text).toContain('8092')
    expect(r.text).toContain('联系管理员')
    // 原始报错必须留着
    expect(r.detail).toBe('connect ETIMEDOUT 172.26.166.238:8092')
  })

  it('8091 连不上时指名是几何服务，不能跟抠图搞混', () => {
    const r = describeServiceError('connect ECONNREFUSED 172.26.166.238:8091')
    expect(r.text).toContain('MoGe-2')
    expect(r.text).not.toContain('抠图服务，端口 8092')
  })

  it('认识 Error 对象，不只是字符串', () => {
    expect(describeServiceError(new Error('connect ETIMEDOUT 172.26.166.238:8092')).isServiceDown)
      .toBe(true)
  })

  it('axios 超时也算服务不可用', () => {
    const r = describeServiceError('timeout of 180000ms exceeded')
    expect(r.isServiceDown).toBe(true)
  })

  it('认不出端口时说"依赖的 GPU 服务"，不瞎猜是哪个', () => {
    const r = describeServiceError('ECONNRESET')
    expect(r.isServiceDown).toBe(true)
    expect(r.text).toContain('依赖的 GPU 服务')
    expect(r.text).not.toContain('8092')
  })

  it('业务错误原样返回，绝不套上"服务没起来"的模板', () => {
    const raw = '语义图 512x768 与规范化源图 1024x1536 不一致'
    const r = describeServiceError(raw)
    expect(r.isServiceDown).toBe(false)
    expect(r.text).toBe(raw)
  })

  it('标签表不一致这种也不能被误判成服务不可用', () => {
    const raw = '语义分区标签表是 ATR-20，本地映射按 ATR-18 写的'
    expect(describeServiceError(raw).isServiceDown).toBe(false)
    expect(describeServiceError(raw).text).toBe(raw)
  })

  it('空输入不炸', () => {
    expect(describeServiceError(undefined).text).toBe('未知错误')
    expect(describeServiceError('').text).toBe('未知错误')
  })
})

describe('serviceErrorLine', () => {
  it('服务不可用时：人话在前、原始报错在后', () => {
    const line = serviceErrorLine('connect ETIMEDOUT 172.26.166.238:8092')
    expect(line).toContain('语义分区')
    expect(line).toContain('connect ETIMEDOUT 172.26.166.238:8092')
    // 人话必须在前面，否则一眼扫过去还是先看到天书
    expect(line.indexOf('语义分区')).toBeLessThan(line.indexOf('ETIMEDOUT'))
  })

  it('业务错误不重复拼一遍自己', () => {
    const raw = '源图无法本地化'
    expect(serviceErrorLine(raw)).toBe(raw)
  })
})
