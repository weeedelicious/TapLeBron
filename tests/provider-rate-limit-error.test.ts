/**
 * 上游限流 / 配额用尽时说人话（2026-08-26 用户反馈的第二个报错）。
 *
 * 用户在图片节点选 Nano Banana Pro，节点上原样显示的是：
 *   litellm.RateLimitError: litellm.RateLimitError: Vertex_aiException - { "error":
 *   { "code": 429, "message": "Resource has been exhausted (e.g. check quota).",
 *     "status": "RESOURCE_EXHAUSTED" } }
 *
 * 三件事都要修，各自都会单独失效：
 *   ① **认出来**：不能只看 HTTP status —— 网关有时把上游的 429 包在别的状态码的响应体里；
 *   ② **退避够久**：配额是按分钟结算的，原来 900ms×次数 重试三次纯属白等；
 *   ③ **说人话**：把英文栈换成「等一会儿 / 换个模型」这种能照着做的话。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

// canvasRoutes → config 要求这几个环境变量存在（跟 recover-generation-merge.test.ts 同一套占位值）
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
const {
  errorMessageFrom,
  isRateLimitedProviderError,
  isRetryableImageProviderError,
  imageRetryDelayMs,
  rateLimitedProviderMessage,
} = require('../server/canvasRoutes.js')

/** 用户截图里那一条，原样。 */
const LITELLM_429 = 'litellm.RateLimitError: litellm.RateLimitError: Vertex_aiException - ' +
  '{ "error": { "code": 429, "message": "Resource has been exhausted (e.g. check quota).", ' +
  '"status": "RESOURCE_EXHAUSTED" } }'

const axiosLike = (status: number, data: unknown) => ({ response: { status, data }, message: 'Request failed' })

describe('① 认出限流', () => {
  it('HTTP 429', () => {
    expect(isRateLimitedProviderError(axiosLike(429, {}))).toBe(true)
  })

  it('状态码不是 429，但正文是 litellm 的 RateLimitError —— 网关常这样包一层', () => {
    expect(isRateLimitedProviderError(axiosLike(500, { error: { message: LITELLM_429 } }))).toBe(true)
    expect(isRateLimitedProviderError(axiosLike(200, LITELLM_429))).toBe(true)
    expect(isRateLimitedProviderError({ message: LITELLM_429 })).toBe(true)
  })

  it('认 RESOURCE_EXHAUSTED / quota / too many requests 这些说法', () => {
    for (const text of [
      'RESOURCE_EXHAUSTED',
      'Resource has been exhausted (e.g. check quota).',
      'Too Many Requests',
      'rate limit reached for this model',
    ]) {
      expect(isRateLimitedProviderError({ message: text }), text).toBe(true)
    }
  })

  it('别的错不要误判成限流', () => {
    for (const error of [
      axiosLike(400, { error: { message: 'invalid image size' } }),
      axiosLike(401, { error: { code: 'invalid_api_key' } }),
      axiosLike(500, { error: { message: 'internal error' } }),
      { message: 'socket hang up' },
      new Error('image response did not include image data'),
    ]) {
      expect(isRateLimitedProviderError(error)).toBe(false)
    }
  })

  it('限流算可重试（否则第一次就直接失败）', () => {
    expect(isRetryableImageProviderError(axiosLike(429, {}))).toBe(true)
    expect(isRetryableImageProviderError({ message: LITELLM_429 })).toBe(true)
  })

  it('原来那批可重试的状态码没被改掉', () => {
    for (const status of [408, 425, 500, 502, 503, 504]) {
      expect(isRetryableImageProviderError(axiosLike(status, {})), String(status)).toBe(true)
    }
    expect(isRetryableImageProviderError(axiosLike(404, {}))).toBe(false)
  })
})

describe('② 限流要退避得更久', () => {
  it('限流的等待明显长于普通网关抽风', () => {
    const limited = imageRetryDelayMs({ message: LITELLM_429 }, 1)
    const transient = imageRetryDelayMs(axiosLike(502, {}), 1)
    expect(limited).toBeGreaterThan(transient * 2)
  })

  it('按次数指数增长，但有上限（不能让用户干等一分钟）', () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => imageRetryDelayMs({ message: LITELLM_429 }, attempt))
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1])
    expect(Math.max(...delays)).toBeLessThanOrEqual(12_000)
  })

  it('普通可重试错误还是原来那条快退避', () => {
    expect(imageRetryDelayMs(axiosLike(502, {}), 1)).toBe(900)
    expect(imageRetryDelayMs(axiosLike(502, {}), 3)).toBe(2700)
  })

  it('次数是脏值也不返回 0 或 NaN（0 等于不退避，等于原地猛冲）', () => {
    for (const attempt of [0, -1, NaN, undefined, 'x']) {
      const delay = imageRetryDelayMs({ message: LITELLM_429 }, attempt as number)
      expect(Number.isFinite(delay)).toBe(true)
      expect(delay).toBeGreaterThan(0)
    }
  })
})

describe('③ 说人话', () => {
  it('带上模型名、说了等一会儿、也说了可以换模型', () => {
    const message = rateLimitedProviderMessage('Nano-banana Pro', 3)
    expect(message).toContain('Nano-banana Pro')
    expect(message).toContain('限流')
    expect(message).toMatch(/稍等|等一会/)
    expect(message).toContain('换')
    // 不能再把英文栈原样带出去
    expect(message).not.toContain('litellm')
    expect(message).not.toContain('RESOURCE_EXHAUSTED')
  })

  it('重试过就告诉用户重试过（不然会以为一次都没试）', () => {
    expect(rateLimitedProviderMessage('X', 3)).toContain('重试 3 次')
    expect(rateLimitedProviderMessage('X', 1)).not.toContain('重试')
  })

  it('模型名缺失也不会出现 undefined', () => {
    expect(rateLimitedProviderMessage(undefined, 2)).not.toContain('undefined')
  })

  it('errorMessageFrom 兜住所有链路：litellm 的原文不会再露给用户', () => {
    for (const error of [
      axiosLike(429, { error: { message: LITELLM_429 } }),
      axiosLike(500, { error: { message: LITELLM_429 } }),
      { message: LITELLM_429 },
    ]) {
      const text = errorMessageFrom(error)
      expect(text).not.toContain('litellm')
      expect(text).not.toContain('RESOURCE_EXHAUSTED')
      expect(text).toContain('限流')
    }
  })

  it('别的上游报错还是原样透出（不能把所有错都糊成一句话）', () => {
    expect(errorMessageFrom(axiosLike(400, { error: { message: 'invalid image size' } })))
      .toBe('invalid image size')
    expect(errorMessageFrom(axiosLike(400, { detail: '参考图太大' }))).toBe('参考图太大')
  })

  /*
   * 图片生成那个重试循环没法在 jsdom 里跑（要真的打网关），所以退一步断言接线：
   * 少了这一句，用户拿到的就是 errorMessageFrom 的通用版本 —— 丢掉模型名和重试次数。
   */
  it('图片链路重试用尽后抛的是带模型名的那句，不是原始错误', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'server/canvasRoutes.js'),
      'utf8',
    ) as string
    const loop = source.slice(
      source.indexOf('image provider gateway request failed; retrying'),
      source.indexOf('if (isImageGatewayHtml400(error)) {', source.indexOf('image provider gateway request failed')),
    )
    expect(loop).toContain('isRateLimitedProviderError(error)')
    expect(loop).toContain('rateLimitedProviderMessage(model, attempts)')
  })

  it('友好文案自己不会被二次匹配成限流（避免来回改写）', () => {
    const friendly = rateLimitedProviderMessage('Nano-banana Pro', 3)
    expect(errorMessageFrom(new Error(friendly))).toBe(friendly)
    expect(isRateLimitedProviderError(new Error(friendly))).toBe(false)
  })
})
