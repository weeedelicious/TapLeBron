/**
 * 画布模版 / 共享画布复制时必须看得见进度条。
 *
 * 事故：复制是一次阻塞 POST，大画布要拷很多素材。卡片只在 hover 时显示
 * 「复制中...」，鼠标一离开就空了，用户以为卡死。
 *
 * 这里盯两件事：估算函数本身走得动；管理页真的接到了进度条，而不是
 * 只改了文案。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { displayDuplicateProgress, estimateDuplicateMs } from '@/lib/duplicateProgress'

const ROOT = join(__dirname, '..')
const PROJECT_LIST = readFileSync(join(ROOT, 'src/canvas/components/ProjectList.tsx'), 'utf8')
const STYLES = readFileSync(join(ROOT, 'src/canvas/styles.css'), 'utf8')

describe('复制时长估算', () => {
  it('空画布也给一个下限，不会是 0', () => {
    expect(estimateDuplicateMs(0)).toBeGreaterThanOrEqual(5000)
    expect(estimateDuplicateMs(undefined)).toBeGreaterThanOrEqual(5000)
  })

  it('节点越多估得越久，但封顶 3 分钟', () => {
    expect(estimateDuplicateMs(40)).toBeGreaterThan(estimateDuplicateMs(4))
    expect(estimateDuplicateMs(10_000)).toBe(3 * 60 * 1000)
  })
})

describe('复制进度条', () => {
  it('一开始就有可见进度，不是空白条', () => {
    expect(displayDuplicateProgress({ startedAtMs: 1000, estimatedMs: 20_000, nowMs: 1000 }).percent).toBe(6)
  })

  it('时间过半大约走到中段，请求没回来前不超过 96%', () => {
    const mid = displayDuplicateProgress({ startedAtMs: 0, estimatedMs: 20_000, nowMs: 10_000 })
    expect(mid.percent).toBeGreaterThanOrEqual(40)
    expect(mid.percent).toBeLessThanOrEqual(60)
    const overtime = displayDuplicateProgress({ startedAtMs: 0, estimatedMs: 10_000, nowMs: 60_000 })
    expect(overtime.percent).toBeLessThanOrEqual(96)
  })

  it('请求完成才到 100%', () => {
    expect(displayDuplicateProgress({ startedAtMs: 0, estimatedMs: 20_000, nowMs: 1000, done: true }).percent).toBe(100)
  })
})

describe('接到管理页卡片上了', () => {
  it('ProjectCard 复制 busy 时不靠 hover 才显示 overlay', () => {
    expect(PROJECT_LIST).toContain('showOverlay = hovered || Boolean(isBusy)')
    expect(PROJECT_LIST).toContain('shotflow-project-card-copy-progress')
    expect(PROJECT_LIST).toContain('displayDuplicateProgress')
    expect(PROJECT_LIST).toContain('estimateDuplicateMs')
  })

  it('画布模版和共享画布都把复制进度交给卡片', () => {
    expect(PROJECT_LIST).toContain('copyProgress={workingUuid === canvas.uuid ? duplicateProgress : null}')
    const templateBlock = PROJECT_LIST.slice(PROJECT_LIST.indexOf('title="画布模版"'), PROJECT_LIST.indexOf('title="共享画布"'))
    const sharedBlock = PROJECT_LIST.slice(PROJECT_LIST.indexOf('title="共享画布"'), PROJECT_LIST.indexOf('title="个人分享"'))
    expect(templateBlock).toContain('copyProgress={workingUuid === canvas.uuid ? duplicateProgress : null}')
    expect(sharedBlock).toContain('copyProgress={workingUuid === canvas.uuid ? duplicateProgress : null}')
  })

  it('进度条 CSS 还在', () => {
    expect(STYLES).toContain('.shotflow-project-card-copy-progress')
    expect(STYLES).toContain('.shotflow-project-card-copy-progress-fill')
  })
})
