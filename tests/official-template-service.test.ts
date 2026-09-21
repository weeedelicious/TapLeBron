import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { normalizeTemplate } = require('../server/services/OfficialTemplateLibraryService.js') as {
  normalizeTemplate: (value: Record<string, unknown>) => {
    category: 'image' | 'video' | '3d'
    categories: Array<'image' | 'video' | '3d'>
  }
}

describe('官方模板多分类数据兼容', () => {
  it('把旧 category 字段转换成 categories 数组', () => {
    const result = normalizeTemplate({ category: 'video', title: '旧模板' })
    expect(result.category).toBe('video')
    expect(result.categories).toEqual(['video'])
  })

  it('多分类会去重，并按固定分类顺序保存', () => {
    const result = normalizeTemplate({
      category: 'video',
      categories: ['video', 'image', 'video'],
      title: '跨分类模板',
    })
    expect(result.category).toBe('image')
    expect(result.categories).toEqual(['image', 'video'])
  })

  it('拒绝空分类和非法分类', () => {
    expect(() => normalizeTemplate({ categories: [], title: '空分类' })).toThrow('分类至少选择一项')
    expect(() => normalizeTemplate({ categories: ['audio'], title: '非法分类' })).toThrow('分类至少选择一项')
  })
})
