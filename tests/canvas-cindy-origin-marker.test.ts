/**
 * Cindy 建的节点那圈粉色标记（2026-08-24 用户问「ai建的节点 为什么不是粉色的了？」）。
 *
 * 事故本身：粉框和呼吸光靠外壳 div 上的 `canvas-node-cindy-wrap` 的 ::after 画。
 * 某次改动把那个条件类换成了硬编码字符串 `"relative flex flex-col"`，于是 CSS 还在、
 * 没有任何元素带这个类。**没有报错、没有测试变红**，只剩一条 42% 透明度的 1px 粉边——
 * 在暗色画布上等于看不见。就这样静默坏了 11 天（08-13 → 08-24）。
 *
 * 为什么用源码断言而不是渲染断言：NodeShell 依赖 @xyflow/react 的 useStore / useViewport /
 * NodeResizer，脱离 ReactFlow 上下文渲染不起来；而这个类除了"长成粉色"没有任何可观测行为，
 * 硬造一个半残的渲染环境只会变成噪声源。所以这里老实用结构断言，并配一条通用护栏——
 *
 * 下面第二组才是真正有价值的部分：**扫出所有"CSS 里有、代码里没人用"的类**。
 * 这次的 bug 正是这个形状，那条护栏当天就会把它抓住，而且对以后同类失效一样有效。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

const NODE_SHELL = read('src/canvas/components/nodes/NodeShell.tsx')
const GROUP_NODE = read('src/canvas/components/nodes/GroupNode.tsx')
const STYLES = read('src/canvas/styles.css')

describe('粉色标记的三个零件都得在', () => {
  it('① 外壳 div 上的 canvas-node-cindy-wrap 是**按标记条件**加的，不是硬编码', () => {
    const lines = NODE_SHELL.split('\n').filter((line) => line.includes('canvas-node-cindy-wrap'))
    expect(lines.length, 'NodeShell 里完全没有 canvas-node-cindy-wrap —— 粉框没有宿主元素').toBeGreaterThan(0)
    // 同一行里必须还带着那个判据，否则就是又被写死了
    expect(
      lines.some((line) => line.includes('isCindyOrigin')),
      'canvas-node-cindy-wrap 没有跟 isCindyOrigin 条件绑在一起（可能又被硬编码了）',
    ).toBe(true)
  })

  it('② 判据本身来自 _cindyProposalMessageId', () => {
    expect(NODE_SHELL).toContain('const isCindyOrigin = Boolean(data._cindyProposalMessageId)')
  })

  it('③ 组节点走另一条规则，也不能丢', () => {
    expect(GROUP_NODE).toContain('is-cindy-origin')
    expect(STYLES).toContain('.group-node-drag-surface.is-cindy-origin')
  })

  it('CSS 那一侧：外壳的 ::after 粉框 + 呼吸光动画都还在', () => {
    expect(STYLES).toContain('.canvas-node-cindy-wrap::after')
    expect(STYLES).toContain('@keyframes canvas-node-pink-glow')
    expect(STYLES).toContain('@keyframes canvas-node-pink-breathe')
    // ::after 那条规则里必须真的有个可见的粉色边框，不然框是透明的
    const afterRule = STYLES.slice(STYLES.indexOf('.canvas-node-cindy-wrap::after'))
      .slice(0, STYLES.slice(STYLES.indexOf('.canvas-node-cindy-wrap::after')).indexOf('}'))
    expect(afterRule).toMatch(/border:\s*2px solid rgba\(255,\s*118,\s*220/)
    expect(afterRule).toContain('animation: canvas-node-pink-glow')
  })
})

describe('通用护栏：styles.css 里不许有"没人用"的类', () => {
  /*
   * 已知的死 CSS，早于这条护栏就在那儿了。留着 allowlist 而不是顺手删：
   * 删 CSS 得逐个确认没有别的入口在用（admin 页是 .html），那是另一件事。
   * 谁哪天确认了就把对应规则和这里的条目一起删掉。
   */
  const KNOWN_DEAD = new Set([
    'shotflow-assigned-project-select',
    'shotflow-logout-button',
    'shotflow-primary-action',
    'shotflow-text-node-surface',
  ])

  /** 把 src 下所有源码（含 .html/.jsx，admin 页也算）拼成一个大字符串来找引用 */
  const collectSources = () => {
    let text = ''
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        // .bak-* 是历史备份，不算"在用"
        if (entry.includes('.bak-')) continue
        if (!/\.(tsx?|jsx?|html)$/.test(entry)) continue
        text += readFileSync(full, 'utf8')
      }
    }
    walk(join(ROOT, 'src'))
    for (const rel of ['public', 'index.html']) {
      const full = join(ROOT, rel)
      try {
        if (statSync(full).isDirectory()) walk(full)
        else text += readFileSync(full, 'utf8')
      } catch {
        // 没有就算了
      }
    }
    return text
  }

  it('canvas-node-* / group-node-* / shotflow-* 每个类都至少被引用一次', () => {
    const classes = new Set(
      [...STYLES.matchAll(/\.((?:canvas-node|group-node|shotflow)[a-z0-9-]+)/g)].map((m) => m[1]),
    )
    expect(classes.size, '一个类都没扫到，说明正则或文件路径不对').toBeGreaterThan(100)

    const sources = collectSources()
    const orphans = [...classes].filter((name) => !KNOWN_DEAD.has(name) && !sources.includes(name))

    expect(
      orphans,
      `这些类只在 styles.css 里出现、没有任何代码给元素加上它们 —— 也就是样式静默失效。\n` +
        `要么补上应用它们的地方，要么把 CSS 规则删掉：\n  ${orphans.join('\n  ')}`,
    ).toEqual([])
  })

  it('allowlist 自己也要保持诚实：里面的类确实还在 CSS 里', () => {
    for (const name of KNOWN_DEAD) {
      expect(STYLES, `${name} 已经不在 CSS 里了，把它从 allowlist 删掉`).toContain(`.${name}`)
    }
  })
})
