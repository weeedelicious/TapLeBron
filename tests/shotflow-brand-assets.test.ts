import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const read = (relativePath: string) => readFileSync(path.join(ROOT, relativePath), 'utf8')

describe('Shotflow brand assets', () => {
  it('ships the supplied logo and icon as SVG assets', () => {
    expect(existsSync(path.join(ROOT, 'public/shotflow-logo.svg'))).toBe(true)
    expect(existsSync(path.join(ROOT, 'public/shotflow-icon.svg'))).toBe(true)
    expect(read('public/shotflow-logo.svg')).toContain('<svg')
    expect(read('public/shotflow-icon.svg')).toContain('<svg')
  })

  it('uses the icon favicon on every served HTML entry', () => {
    const releaseRoot = path.join(ROOT, 'public/releases')
    const releaseEntries = readdirSync(releaseRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `public/releases/${entry.name}/index.html`)
      .filter((relativePath) => existsSync(path.join(ROOT, relativePath)))
    const htmlEntries = ['index.html', 'public/admin.html', 'public/home/index.html', ...releaseEntries]

    for (const relativePath of htmlEntries) {
      expect(read(relativePath), relativePath).toContain('/shotflow-icon.svg')
    }
  })

  it('does not leave the retired PNG, mark, or placeholder glyph in active pages', () => {
    const activeSources = [
      'index.html',
      'public/admin.html',
      'public/home/index.html',
      'src/App.jsx',
      'src/ErrorLibraryPage.jsx',
      'src/canvas/components/ProjectList.tsx',
      'src/canvas/components/TopNav.tsx',
    ].map(read).join('\n')

    expect(activeSources).not.toContain('/shotflow-logo.png')
    expect(activeSources).not.toContain('/shotflow-mark.svg')
    expect(activeSources).not.toContain('brand-symbol')
    expect(activeSources).toContain('/shotflow-logo.svg')
  })
})
