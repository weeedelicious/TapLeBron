import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, '../server/canvasRoutes.js'), 'utf8')

describe('Seedance 2.5 draft request', () => {
  it('sends draft true at 480p and upgrades with only the draft task id', () => {
    expect(source).toContain('if (params.draft) body.draft = true')
    expect(source).toContain("resolution: params.draft ? '480p'")
    expect(source).toContain("content: [{ type: 'draft_task', draft_task: { id: finalizeId } }]")
    expect(source).toContain("resolution: '1080p'")
    expect(source).toContain('if (!finalizeDraftTaskId) validateVideoCapabilities({')
    expect(source).toContain('draft,')
  })
})
