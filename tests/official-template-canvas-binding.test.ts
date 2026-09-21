import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const ROUTES = readFileSync(join(ROOT, 'server', 'canvasRoutes.js'), 'utf8')
const PROJECT_LIST = readFileSync(join(ROOT, 'src', 'canvas', 'components', 'ProjectList.tsx'), 'utf8')

describe('官方模板与专属画布 1:1 绑定', () => {
  it('新增模板由后端自动建模板画布，编辑时保留原 canvasId', () => {
    expect(ROUTES).toContain("createTemplate({ ...(req.body || {}), canvasId: '' })")
    expect(ROUTES).toContain('createOfficialTemplateCanvas(template, preferredOwnerId)')
    expect(ROUTES).toContain("reason: 'official_template_canvas_create'")
    expect(ROUTES).toContain('canvasId: existing.canvasId')
  })

  it('读取时修复空、失效和重复关联，并在项目列表中拆出官方分组', () => {
    expect(ROUTES).toContain('const usedCanvasIds = new Set()')
    expect(ROUTES).toContain("if (!canvasId) canvasId = await createOfficialTemplateCanvas(template, preferredOwnerId)")
    expect(ROUTES).toContain('scheduleOfficialTemplateCanvasRepair()')
    expect(ROUTES).toContain('officialTemplateCanvases: officialTemplateRows.map')
    expect(ROUTES).toContain("allTemplateRows.filter((row) => !officialTemplateIds.has(String(row.id)))")
  })

  it('管理页右侧分别显示官方模板和用户模板', () => {
    expect(PROJECT_LIST).toContain('title="官方画布模板"')
    expect(PROJECT_LIST).toContain('groups.officialTemplateCanvases.map')
    expect(PROJECT_LIST).toContain('title="画布模版"')
  })
})
