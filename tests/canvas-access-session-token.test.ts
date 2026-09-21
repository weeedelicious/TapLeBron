import { describe, expect, it } from 'vitest'

process.env.DB_USER ||= 'test'
process.env.DB_PASSWORD ||= 'test'
process.env.DB_NAME ||= 'test'
process.env.SESSION_SECRET ||= 'test'
process.env.INITIAL_ADMIN_PASSWORD ||= 'test'

const { tokenFromRequest } = require('../server/services/CanvasAccessSessionService') as {
  tokenFromRequest: (request: { get?: (name: string) => string; query?: { canvasSession?: string } }) => string
}

function requestWithHeader(value: string) {
  return { get: () => value, query: {} }
}

describe('canvas access session request token', () => {
  it('accepts a single token unchanged', () => {
    expect(tokenFromRequest(requestWithHeader('live-token'))).toBe('live-token')
  })

  it('collapses identical XHR duplicate values', () => {
    expect(tokenFromRequest(requestWithHeader('live-token, live-token'))).toBe('live-token')
  })

  it('does not accept conflicting duplicate values', () => {
    expect(tokenFromRequest(requestWithHeader('live-token, stale-token'))).toBe('live-token, stale-token')
  })
})
