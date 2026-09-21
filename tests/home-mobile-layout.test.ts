import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, '..', 'public/home/index.html'), 'utf8')

describe('Shotflow home mobile layout', () => {
  it('overrides the late desktop width lock on phones and tablets', () => {
    const desktopLock = source.lastIndexOf('html,body{min-width:1280px')
    const mobileRule = source.lastIndexOf('@media(max-width:1024px)')
    expect(desktopLock).toBeGreaterThan(-1)
    expect(mobileRule).toBeGreaterThan(desktopLock)
    const mobile = source.slice(mobileRule, source.indexOf('@media(max-width:380px)', mobileRule))
    expect(mobile).toContain('html,body{width:100%;min-width:0')
    expect(mobile).toContain('.header-nav,.header-button:not(.primary){display:none}')
    expect(mobile).toContain('.hero-copy h1 em{display:block}')
    expect(mobile).toContain('.prompt input{width:0;min-width:0')
    expect(mobile).toContain('.creative-board{height:auto;min-height:0;grid-template-columns:1fr')
    expect(mobile).toContain('.demo-carousel-zone{width:100%;min-width:0')
  })

  it('keeps touch carousels responsive instead of using desktop pixel gaps', () => {
    expect(source).toContain('const mobile=window.innerWidth<=1024')
    expect(source).toContain('stage.clientWidth*.62')
    expect(source).toContain('gap:Math.max(210,window.innerWidth*.62)')
    expect(source).toContain('touch-action:pan-y')
  })

  it('preserves the creation links on mobile', () => {
    expect(source.match(/href="\/Shotflow"/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
