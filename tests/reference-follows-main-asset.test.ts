/**
 * 参考图 / 参考视频跟着上游的「设为主图 / 设为主视频」走（2026-08-25 用户要求）。
 *
 * 原来的写法是 `srcNode.data.url?.[0]` —— 在七八个地方各抄了一遍。
 * `url[]` 是**生成顺序**，`_primaryAssetUrl` 才是用户选中的那个，
 * 取 [0] 等于永远拿上游第一次生成的结果：源节点上明明换成了第 3 张，
 * 下游的参考图还是第 1 张，点生成也是拿第 1 张去生成。
 *
 * 这里锁三层：
 *   ① 规则本身（primaryOutputUrl / liveRefUrl）；
 *   ② 提示词里的 @引用也要跟着换 —— 服务端算参考素材时把素材列表和 promptChips 的地址
 *      **取并集**，只换一边等于把新旧两张图一起当参考发出去，比不换更糟；
 *   ③ 接线：节点是不是真的在用这套（ImageNode / VideoNode 太大，整棵挂起来不现实，
 *      退一步做源码断言 —— 2026-08-24 粉色标记失效就是"实现都在、只是没人接上"）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { primaryOutputUrl, liveRefUrl } = await import('@/lib/primaryOutput')
const { refreshPromptChipUrlsInHtml, refreshPromptChipUrlsInParams } = await import('@/lib/promptChips')
const { resolveImageCompareInputs } = await import('@/features/image-compare/image-compare')

const A = '/assets/1/a.png'
const B = '/assets/1/b.png'
const C = '/assets/1/c.png'

describe('① 主图规则', () => {
  it('设为主图之后取到的是主图，不是第一张', () => {
    expect(primaryOutputUrl({ url: [A, B, C], _primaryAssetUrl: C })).toBe(C)
  })

  it('没设过主图 → 第一张', () => {
    expect(primaryOutputUrl({ url: [A, B] })).toBe(A)
  })

  it('主图指向一张已经被删掉的图（悬空）→ 退回第一张，而不是给下游一个看不见的地址', () => {
    expect(primaryOutputUrl({ url: [A, B], _primaryAssetUrl: C })).toBe(A)
  })

  it('空串 / 空白 / 非字符串都不算产物', () => {
    expect(primaryOutputUrl({ url: ['', '   ', B] })).toBe(B)
    expect(primaryOutputUrl({ url: [null, 7, A] as never })).toBe(A)
    expect(primaryOutputUrl({ url: [], _primaryAssetUrl: A })).toBe('')
    expect(primaryOutputUrl({ url: [A], _primaryAssetUrl: '   ' })).toBe(A)
    // 主图和 url[] 里都是全空白：也不能当成有效地址交给下游
    expect(primaryOutputUrl({ url: ['   ', A], _primaryAssetUrl: '   ' })).toBe(A)
  })

  it('没有节点 / 没有 url 字段 → 空串，不抛', () => {
    expect(primaryOutputUrl(undefined)).toBe('')
    expect(primaryOutputUrl(null)).toBe('')
    expect(primaryOutputUrl({})).toBe('')
    expect(primaryOutputUrl({ url: 'not-an-array' as never })).toBe('')
  })

  it('不 trim：主图存的就是 url[] 里的原值，比较必须逐字一致', () => {
    expect(primaryOutputUrl({ url: [' padded.png '], _primaryAssetUrl: 'padded.png' })).toBe(' padded.png ')
  })
})

describe('① 引用解析：跟着上游，上游没了才退回快照', () => {
  it('上游还在 → 用上游当前的主图，哪怕引用里存的是旧地址', () => {
    expect(liveRefUrl({ url: [A, B], _primaryAssetUrl: B }, A)).toBe(B)
  })

  it('上游被删了 → 退回引用里存的快照，参考图不凭空消失', () => {
    expect(liveRefUrl(undefined, A)).toBe(A)
  })

  it('上游还在但还没生成出东西 → 也退回快照（?? 不会，必须用 ||）', () => {
    expect(liveRefUrl({ url: [] }, A)).toBe(A)
  })

  it('两边都没有 → 空串（调用方按这个把引用过滤掉）', () => {
    expect(liveRefUrl(undefined, undefined)).toBe('')
    expect(liveRefUrl({ url: [] }, 123 as never)).toBe('')
  })
})

describe('① 图片对比节点这条真实的引用链也跟着换', () => {
  const nodes = (data: Record<string, unknown>) => [
    { id: 'src', data: { type: 'image', name: '源', ...data } },
  ] as never
  const compareData = {
    type: 'image_compare',
    params: { compareRefA: { nodeId: 'src', url: A }, compareRefB: { nodeId: 'src', url: A } },
  } as never

  it('源节点设为主图 B → 对比输入变成 B', () => {
    const result = resolveImageCompareInputs(compareData, nodes({ url: [A, B], _primaryAssetUrl: B }))
    expect(result.inputA?.fullUrl).toBe(B)
  })

  it('主图悬空 → 退回第一张，不会拿一个已删地址去加载', () => {
    const result = resolveImageCompareInputs(compareData, nodes({ url: [A, B], _primaryAssetUrl: C }))
    expect(result.inputA?.fullUrl).toBe(A)
  })
})

describe('② 提示词里的 @引用也跟着换', () => {
  const imageChip = (url: string) =>
    `<span data-chip="1" data-nodeid="n1" data-url="${url}" data-name="图片1">` +
    `<img data-chip-preview="1" src="${url}"><span>图片1</span><span data-del="1">×</span></span>`
  const videoChip = (url: string) =>
    `<span data-chip="1" data-nodeid="n2" data-url="${url}" data-name="视频1" data-media-type="video">` +
    `<span data-chip-preview="1"><video src="${url}"></video></span><span>视频1</span></span>`

  it('data-url 和小预览的 src 两处都换 —— 只换一处就是"指向新图、显示旧图"', () => {
    const html = refreshPromptChipUrlsInHtml(imageChip(A), { n1: B }) as string
    expect(html).toContain(`data-url="${B}"`)
    expect(html).toContain(`src="${B}"`)
    expect(html).not.toContain(A)
  })

  it('视频药丸换的是里层 <video> 的 src', () => {
    const html = refreshPromptChipUrlsInHtml(videoChip('/v/a.mp4'), { n2: '/v/b.mp4' }) as string
    expect(html).toContain('data-url="/v/b.mp4"')
    expect(html).toContain('<video src="/v/b.mp4">')
    expect(html).not.toContain('/v/a.mp4')
  })

  it('音频药丸没有 src，只换 data-url，不报错', () => {
    const audio =
      '<span data-chip="1" data-nodeid="n3" data-url="/a/a.mp3" data-name="音频1" data-media-type="audio">' +
      '<span data-chip-preview="1">♪</span><span>音频1</span></span>'
    const html = refreshPromptChipUrlsInHtml(audio, { n3: '/a/b.mp3' }) as string
    expect(html).toContain('data-url="/a/b.mp3"')
    expect(html).toContain('♪')
  })

  it('一段里多个药丸各自对上自己的上游', () => {
    const html = refreshPromptChipUrlsInHtml(
      `前${imageChip(A)}中${videoChip('/v/a.mp4')}后`,
      { n1: B, n2: '/v/b.mp4' },
    ) as string
    expect(html).toContain(`data-url="${B}"`)
    expect(html).toContain('data-url="/v/b.mp4"')
    expect(html).toContain('前')
    expect(html).toContain('中')
    expect(html).toContain('后')
  })

  it('地址没变 → 原样返回**同一个字符串**（不能重新序列化）', () => {
    // 编辑器靠 `el.innerHTML === nextHtml` 决定要不要重建 DOM。
    // 每次都吐一份重新序列化的 HTML 会让它反复重建、把光标顶掉、打字打不下去。
    //
    // 这里故意把 <img> 写成 `/>` 自闭合形式：浏览器序列化出来是 `>`，
    // 所以只要函数走过一遍「解析 + 重新序列化」，返回值就一定不等于入参 ——
    // 用规范化前后不同的写法才测得出「真的没动过那个字符串」。
    const html =
      `<span data-chip="1" data-nodeid="n1" data-url="${A}" data-name="图片1">` +
      `<img data-chip-preview="1" src="${A}" /><span>图片1</span></span>`
    expect(refreshPromptChipUrlsInHtml(html, { n1: A })).toBe(html)
    expect(refreshPromptChipUrlsInHtml(html, {})).toBe(html)
    expect(refreshPromptChipUrlsInHtml(html, { other: B })).toBe(html)
  })

  it('幂等：换完再换一次不动（否则显示 → 回读 → 再改会来回抖）', () => {
    const once = refreshPromptChipUrlsInHtml(imageChip(A), { n1: B }) as string
    expect(refreshPromptChipUrlsInHtml(once, { n1: B })).toBe(once)
  })

  it('没有药丸 / 不是字符串 → 原样返回', () => {
    expect(refreshPromptChipUrlsInHtml('纯文字', { n1: B })).toBe('纯文字')
    expect(refreshPromptChipUrlsInHtml(undefined, { n1: B })).toBeUndefined()
  })

  it('引用回来了 → 顺手把「引用没了」的标记清掉', () => {
    const missing =
      `<span data-chip="1" data-nodeid="n1" data-url="" data-name="图片1" data-missing="1">` +
      `<img data-chip-preview="1" src=""><span>图片1</span></span>`
    const html = refreshPromptChipUrlsInHtml(missing, { n1: B }) as string
    expect(html).toContain(`data-url="${B}"`)
    expect(html).not.toContain('data-missing')
  })

  it('params 层：promptChips 和 promptHtml 两份一起换', () => {
    const params = {
      promptChips: [{ nodeId: 'n1', url: A, name: '图片1' }],
      promptHtml: imageChip(A),
    }
    const next = refreshPromptChipUrlsInParams(params, { n1: B })
    expect((next.promptChips as Array<{ url: string }>)[0].url).toBe(B)
    expect(next.promptHtml).toContain(`data-url="${B}"`)
  })

  it('params 层没变化 → 返回**同一个对象**，调用方可以用 !== 判断要不要落库', () => {
    const params = { promptChips: [{ nodeId: 'n1', url: A, name: '图片1' }], promptHtml: imageChip(A) }
    expect(refreshPromptChipUrlsInParams(params, { n1: A })).toBe(params)
    expect(refreshPromptChipUrlsInParams(params, {})).toBe(params)
    expect(refreshPromptChipUrlsInParams({ promptChips: undefined, promptHtml: undefined }, { n1: B }))
      .toEqual({ promptChips: undefined, promptHtml: undefined })
  })

  it('params 层：对不上的药丸原样留着（上游已经断开的引用不复活）', () => {
    const chip = { nodeId: 'gone', url: A, name: '图片1' }
    const next = refreshPromptChipUrlsInParams({ promptChips: [chip] }, { n1: B })
    expect((next.promptChips as unknown[])[0]).toBe(chip)
  })
})

/*
 * ③ 接线。规则和药丸函数都对，但只要哪个节点又写回 `url?.[0]`，用户看到的就还是旧图 ——
 * 上面所有断言一条都不会红。ImageNode / VideoNode 完整挂载需要的上下文太多，
 * 所以这里退一步断言源码用的是共用规则。
 */
describe('③ 各节点确实在用这套规则', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

  const FILES = [
    ['图片节点', 'src/canvas/components/nodes/ImageNode.tsx'],
    ['视频节点', 'src/canvas/components/nodes/VideoNode.tsx'],
    ['文字节点', 'src/canvas/components/nodes/TextNode.tsx'],
    ['氛围迁移节点', 'src/canvas/features/atmosphere-transfer/AtmosphereTransferNode.tsx'],
  ] as const

  for (const [label, rel] of FILES) {
    it(`${label}引用了共用的主图规则`, () => {
      expect(read(rel)).toMatch(/from '@\/lib\/primaryOutput'/)
    })

    it(`${label}解析引用时不再取 url[0]`, () => {
      const source = read(rel)
      // 历史写法一律形如 `const liveUrl = ...url?.[0]` / `const live = ...url?.[0]`。
      // 节点显示自己产物时用 url[0] 是合理的，所以只挡「解析上游引用」这种赋值。
      const offenders = source
        .split('\n')
        .filter((line) => /\b(liveUrl|live)\s*=/.test(line) && /url\?\.\[0\]/.test(line))
      expect(offenders, `${label}又用 url[0] 解析上游引用了`).toEqual([])
    })
  }

  for (const [label, rel] of FILES.slice(0, 2)) {
    it(`${label}把刷新过的提示词 HTML 交给编辑器（不是原始的 params.promptHtml）`, () => {
      const source = read(rel)
      expect(source, `${label}的 @引用不会跟着主图换`).toContain('htmlSnapshot={promptHtmlSnapshot}')
      expect(source).not.toContain('htmlSnapshot={params.promptHtml}')
    })

    it(`${label}提交生成前把药丸地址一起刷新`, () => {
      const source = read(rel)
      // 只断言"文件里出现过这个函数"是不够的：显示那一路也调它，
      // 把提交那一路删掉照样能通过。所以钉住提交时用的那个变量本身。
      const submitted = label === '图片节点' ? 'requestParams' : 'freshParams'
      expect(
        source,
        `${label}提交生成的 ${submitted} 没有经过药丸地址刷新，旧素材会跟着一起发出去`,
      ).toContain(`const ${submitted} = refreshPromptChipUrlsInParams({`)
      // 刷新过还得写回节点，否则页面上的药丸预览要等下一次编辑才更新
      expect(source).toContain(`${submitted}.promptHtml !== params.promptHtml`)
    })
  }
})
