/**
 * 取消参考时把那根连线也断掉（2026-08-25 用户要求）。
 *
 * 改动前：视频节点会断线，**图片节点不会** —— 引用列表里没了，画布上那根线还挂着，
 * 看起来像还在参考。两边各写了一遍同样的过滤条件，所以只改一处很容易再次跑偏，
 * 现在提成 edgesWithoutLink 共用。
 *
 * 要锁住的关键点：
 *   · **两个方向都断**。画布允许反着连，只删一个方向会留下一根看不出来源的线；
 *   · **别的线一根都不能动**。这个节点往往还接着别的图、文本、上游视频，
 *     多删一根就是把用户的工作流悄悄拆了。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { edgesWithoutLink } from '@/lib/referenceEdges'

type E = { id: string; source: string; target: string }
/** img1 → me、me → out、另外还有一对无关的线 */
const EDGES: E[] = [
  { id: 'e1', source: 'img1', target: 'me' },
  { id: 'e2', source: 'img2', target: 'me' },
  { id: 'e3', source: 'me', target: 'out' },
  { id: 'e4', source: 'other', target: 'elsewhere' },
]

describe('断掉指定的那一对', () => {
  it('上游 → 本节点：断掉，其余不动', () => {
    expect(edgesWithoutLink(EDGES, 'img1', 'me').map(e => e.id)).toEqual(['e2', 'e3', 'e4'])
  })

  it('反向连的也断（本节点 → 那个节点）', () => {
    expect(edgesWithoutLink(EDGES, 'out', 'me').map(e => e.id)).toEqual(['e1', 'e2', 'e4'])
  })

  it('参数顺序不影响结果（两个方向都查）', () => {
    expect(edgesWithoutLink(EDGES, 'me', 'img1').map(e => e.id)).toEqual(['e2', 'e3', 'e4'])
  })

  it('同时存在正反两根 → 一起断', () => {
    const both: E[] = [...EDGES, { id: 'e5', source: 'me', target: 'img1' }]
    expect(edgesWithoutLink(both, 'img1', 'me').map(e => e.id)).toEqual(['e2', 'e3', 'e4'])
  })
})

describe('别的线一根都不许动', () => {
  it('这一对本来就没有连线 → 原样返回', () => {
    expect(edgesWithoutLink(EDGES, 'img1', 'out').map(e => e.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
  })

  it('完全不相干的 id → 原样返回', () => {
    expect(edgesWithoutLink(EDGES, 'nope', 'nada')).toHaveLength(4)
  })

  it('空 id → 什么都不做（别把整张图清空）', () => {
    expect(edgesWithoutLink(EDGES, '', 'me')).toHaveLength(4)
    expect(edgesWithoutLink(EDGES, 'me', '')).toHaveLength(4)
  })

  it('连线自己带空端点时也不许被空 id 顺手删掉', () => {
    // 正常数据里不会有空端点，所以上一条其实靠"匹配不上"就过了。
    // 这一条把脏边放进来，逼着函数真的靠开头那道空值检查挡 —— 否则
    // 一次 nodeId 为空的调用会把这种边悄悄删掉。
    const dirty: E[] = [...EDGES, { id: 'e7', source: '', target: 'me' }]
    expect(edgesWithoutLink(dirty, '', 'me')).toHaveLength(5)
  })

  it('空列表 → 空列表', () => {
    expect(edgesWithoutLink([], 'a', 'b')).toEqual([])
  })

  it('自己连自己也只断那一根，不影响其它', () => {
    const loop: E[] = [...EDGES, { id: 'e6', source: 'me', target: 'me' }]
    expect(edgesWithoutLink(loop, 'me', 'me').map(e => e.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
  })
})

/*
 * 上面测的是过滤函数。但「两个节点的取消参考到底有没有调它」是另一回事 ——
 * 图片节点原本就是漏了这一步，而漏掉时没有任何报错、也没有测试会红。
 * 完整渲染这两个节点需要的上下文太多，所以退一步做接线断言。
 */
describe('两个节点的取消参考都真的断线了', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

  for (const [label, rel, fn] of [
    ['图片节点', 'src/canvas/components/nodes/ImageNode.tsx', 'removeConnectedImageRef'],
    ['视频节点', 'src/canvas/components/nodes/VideoNode.tsx', 'removeConnectedRef'],
  ] as const) {
    it(`${label}的 ${fn} 里调了 edgesWithoutLink`, () => {
      const source = read(rel)
      const start = source.indexOf(`const ${fn} = useCallback(`)
      expect(start, `找不到 ${fn}，测试锚点要更新`).toBeGreaterThan(0)
      // 截到这个 useCallback 的依赖数组结尾为止，别把后面别的函数算进来
      const body = source.slice(start, start + 2200)
      expect(body, `${label}取消参考后没有断线，画布上会留一根空挂的线`).toContain('edgesWithoutLink(')
      expect(body).toContain('setEdges(')
    })
  }
})
