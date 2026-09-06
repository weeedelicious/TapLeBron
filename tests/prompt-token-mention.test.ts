/**
 * 提示词里手写 `image1` 自动变成 @引用（2026-08-25 用户要求：
 * 「模糊识别 "image1 " "image1/" 等」）。
 *
 * 这个功能只要判断错一点，代价就是**用户正在打字被抢**——最难受的两种错法：
 *   ① 太早转：打 `image1` 想接着打成 `image15`，结果 `image1` 当场变成了 chip。
 *      所以规则是**必须等他敲下分隔符**才转，这也正好对上用户给的例子（"image1 " / "image1/"）。
 *   ② 太贪心：`myimage1`、`animage1` 这种粘在词里的不能算；`image12` 是第 12 个而不是
 *      第 1 个后面跟个 2。
 *
 * 还有一条也算数据安全：编号对不上（写了 image5 但只接了 3 张图）时**必须什么都不做**，
 * 既不能悄悄换成第 3 张，也不能把字吃掉。
 */
import { describe, expect, it } from 'vitest'
import {
  findMentionTokens,
  matchMentionToken,
  resolveMentionToken,
  resolveTextMentionAt,
  resolveTextMentionsIn,
  clipboardLabelFromChipName,
} from '@/lib/promptTokenMention'

type Chip = { nodeId: string; url: string; name: string }
const CANDIDATES: Chip[] = [
  { nodeId: 'n1', url: '/assets/1/a.png', name: '图片1' },
  { nodeId: 'n2', url: '/assets/1/b.png', name: '图片2' },
  { nodeId: 'n3', url: '/assets/1/c.mp4', name: '视频1' },
  { nodeId: 'n4', url: '/assets/1/d.mp3', name: '音频1' },
]

describe('① 必须等敲下分隔符才转（别抢用户输入）', () => {
  it('刚打完 image1、还没敲分隔符 → 不动', () => {
    expect(matchMentionToken('image1')).toBeNull()
    expect(matchMentionToken('画面里 image1')).toBeNull()
  })

  it('正在打 image12（想打两位数）→ 不能当成第 1 个', () => {
    // 少了分隔符检查时，最后一个字符会被当成分隔符切掉，`image12` 就成了 `image1` ——
    // 用户想打第 12 个，结果第 1 张被塞进来。这一条专门盯这个错法。
    expect(matchMentionToken('image12')).toBeNull()
    expect(matchMentionToken('video10')).toBeNull()
  })

  it('用户给的两个例子都要认', () => {
    expect(matchMentionToken('image1 ')?.index).toBe(1)
    expect(matchMentionToken('image1/')?.index).toBe(1)
  })

  it('其它常见断词处也认（中英标点、括号、换行）', () => {
    for (const tail of ['，', ',', '。', '、', ':', '：', ')', '）', '\n', '\t', '+', '&']) {
      expect(matchMentionToken(`image1${tail}`), `分隔符 ${JSON.stringify(tail)} 应该触发`).not.toBeNull()
    }
  })

  it('分隔符原样带回来，好补到 chip 后面（不能把用户敲的字吃掉）', () => {
    expect(matchMentionToken('image1/')?.tail).toBe('/')
    expect(matchMentionToken('image1 ')?.tail).toBe(' ')
  })

  it('要删的长度 = token + 那个分隔符', () => {
    const hit = matchMentionToken('image1/')
    expect(hit?.raw).toBe('image1')
    expect(hit?.removeCount).toBe('image1/'.length)
  })
})

describe('② 不许贪心匹配', () => {
  it('粘在别的词里 → 不算', () => {
    expect(matchMentionToken('myimage1 ')).toBeNull()
    expect(matchMentionToken('animage1 ')).toBeNull()
    expect(matchMentionToken('reimage1 ')).toBeNull()
  })

  it('下划线/连字符连着前一个词 → 也不算', () => {
    // 上面那几个是靠"捕获到的词根不认识"挡掉的（myimage 不是别名）；
    // 而 `_` `-` 不算词字符，正则会从它后面开始、正好捕到 image ——
    // 这一条才是左边界检查真正管的场景。
    expect(matchMentionToken('foo_image1 ')).toBeNull()
    expect(matchMentionToken('ref-image1 ')).toBeNull()
  })

  it('前面隔开了就算（空格、标点、括号、开头）', () => {
    expect(matchMentionToken('image1 ')?.index).toBe(1)
    expect(matchMentionToken('画面 image1 ')?.index).toBe(1)
    expect(matchMentionToken('参考(image1 ')?.index).toBe(1)
    expect(matchMentionToken('参考：image1 ')?.index).toBe(1)
  })

  it('image12 是第 12 个，不是第 1 个', () => {
    expect(matchMentionToken('image12 ')?.index).toBe(12)
  })

  it('不认识的词根 → 不算', () => {
    expect(matchMentionToken('mask1 ')).toBeNull()
    expect(matchMentionToken('shot1 ')).toBeNull()
    expect(matchMentionToken('1 ')).toBeNull()
  })

  it('三位以上数字不当序号（避免把长串数字误认）', () => {
    expect(matchMentionToken('image123 ')).toBeNull()
  })
})

describe('模糊识别的范围', () => {
  it('大小写都认', () => {
    for (const raw of ['image1 ', 'Image1 ', 'IMAGE1 ', 'ImAgE1 ']) {
      expect(matchMentionToken(raw)?.prefix, raw).toBe('图片')
    }
  })

  it('常见简写和中文写法都认', () => {
    expect(matchMentionToken('img1 ')?.prefix).toBe('图片')
    expect(matchMentionToken('pic1 ')?.prefix).toBe('图片')
    expect(matchMentionToken('图片1 ')?.prefix).toBe('图片')
    expect(matchMentionToken('video1 ')?.prefix).toBe('视频')
    expect(matchMentionToken('vid1 ')?.prefix).toBe('视频')
    expect(matchMentionToken('视频1 ')?.prefix).toBe('视频')
    expect(matchMentionToken('audio1 ')?.prefix).toBe('音频')
    expect(matchMentionToken('音频1 ')?.prefix).toBe('音频')
  })

  it('词和数字之间有空格或下划线也认', () => {
    expect(matchMentionToken('image 1 ')?.index).toBe(1)
    expect(matchMentionToken('image_1 ')?.index).toBe(1)
    expect(matchMentionToken('image-2 ')?.index).toBe(2)
  })

  it('空输入 / 只有分隔符 → 不炸', () => {
    for (const raw of ['', ' ', '/', '\n']) expect(matchMentionToken(raw)).toBeNull()
  })
})

describe('③ 对不上编号时什么都不做', () => {
  it('写了 image5 但只接了 2 张图 → null（不能退而求其次换成第 2 张）', () => {
    const hit = matchMentionToken('image5 ')!
    expect(resolveMentionToken(hit, CANDIDATES)).toBeNull()
    expect(resolveTextMentionAt('image5 ', CANDIDATES)).toBeNull()
  })

  it('一个引用都没接 → null', () => {
    expect(resolveTextMentionAt('image1 ', [])).toBeNull()
  })

  it('候选项没有可用地址 → 不当作命中（chip 没地址等于坏图）', () => {
    const broken = [{ nodeId: 'n1', url: '', name: '图片1' }]
    expect(resolveTextMentionAt('image1 ', broken)).toBeNull()
  })
})

describe('对上编号时给出正确的引用', () => {
  it('image1 / image2 分别对上 图片1 / 图片2', () => {
    expect(resolveTextMentionAt('image1 ', CANDIDATES)?.chip.nodeId).toBe('n1')
    expect(resolveTextMentionAt('image2 ', CANDIDATES)?.chip.nodeId).toBe('n2')
  })

  it('video1 对上 视频1，audio1 对上 音频1（视频节点能接三种）', () => {
    expect(resolveTextMentionAt('video1 ', CANDIDATES)?.chip.nodeId).toBe('n3')
    expect(resolveTextMentionAt('audio1 ', CANDIDATES)?.chip.nodeId).toBe('n4')
  })

  it('image1 不会串到 视频1 上（词根决定类型）', () => {
    expect(resolveTextMentionAt('image1 ', [CANDIDATES[2]])).toBeNull()
  })

  it('一步到位版本把删除长度和分隔符一起带出来', () => {
    const hit = resolveTextMentionAt('给 image1/ 加雨', CANDIDATES.slice(0, 1))
    // 注意：光标前的文字截到分隔符为止，后面的内容不参与判断
    expect(hit).toBeNull()
    const real = resolveTextMentionAt('给 image1/', CANDIDATES)
    expect(real?.removeCount).toBe('image1/'.length)
    expect(real?.tail).toBe('/')
    expect(real?.chip.name).toBe('图片1')
  })
})

describe('中文紧跟在后面也要认（2026-08-25 实测漏掉的情形）', () => {
  /*
   * 第一版把断词字符写成白名单（空格 / 斜杠 / 各种标点），**汉字不在里面**。
   * 而中文提示词写出来就是 `以输入图片作为首帧，image1保持图片中主体的外形…` ——
   * image1 后面直接跟「保」，永远等不到分隔符，于是一次都不转。
   */
  it('image1 后面直接跟汉字 → 认', () => {
    expect(matchMentionToken('image1保')?.index).toBe(1)
    expect(matchMentionToken('，image1保')?.prefix).toBe('图片')
  })

  it('用户截图里那句真实提示词能对上', () => {
    const real = '以输入图片作为首帧，image1保'
    const hit = matchMentionToken(real)
    expect(hit?.raw).toBe('image1')
    expect(hit?.tail).toBe('保')
    expect(hit?.removeCount).toBe('image1保'.length)
  })

  it('数字还在打的时候仍然不抢（这条不能因为放宽而失效）', () => {
    expect(matchMentionToken('image15')).toBeNull()
    expect(matchMentionToken('image1')).toBeNull()
  })

  it('后面跟英文字母也不算打完（image1a 不是引用）', () => {
    expect(matchMentionToken('image1a')).toBeNull()
    expect(matchMentionToken('image1_')).toBeNull()
  })
})

describe('整段扫描：管「中间插入 / 粘贴 / 已有提示词」', () => {
  const CAND3 = [
    { nodeId: 'n1', url: '/a.png', name: '图片1' },
    { nodeId: 'n2', url: '/b.png', name: '图片2' },
  ]

  it('一段里多个 token 全找出来，按出现顺序', () => {
    const hits = findMentionTokens('先看 image1 再看 image2 结束')
    expect(hits.map(h => h.index)).toEqual([1, 2])
    expect(hits.map(h => h.raw)).toEqual(['image1', 'image2'])
  })

  it('结尾没有任何字符也能找到（用户压根没敲尾随字符）', () => {
    expect(findMentionTokens('保持一致 image1').map(h => h.index)).toEqual([1])
  })

  it('汉字包着也能找到', () => {
    const hits = findMentionTokens('以输入图片作为首帧，image1保持主体一致。')
    expect(hits).toHaveLength(1)
    expect(hits[0].raw).toBe('image1')
    expect(hits[0].start).toBe('以输入图片作为首帧，'.length)
  })

  it('两位数编号要认出来（贪婪正则那版会把 image12 切成 image1 而整个漏掉）', () => {
    expect(findMentionTokens('用 image12 那条').map(h => h.index)).toEqual([12])
    expect(findMentionTokens('image15').map(h => h.index)).toEqual([15])
  })

  it('后面粘着字母 → 不是引用（右边界要查）', () => {
    expect(findMentionTokens('image1a')).toEqual([])
    expect(findMentionTokens('image1_ref')).toEqual([])
  })

  it('三位以上数字不当序号', () => {
    expect(findMentionTokens('image123')).toEqual([])
  })

  it('词根和序号之间有空格/下划线/连字符也能扫到', () => {
    expect(findMentionTokens('image 1').map(h => h.index)).toEqual([1])
    expect(findMentionTokens('image_2').map(h => h.raw)).toEqual(['image_2'])
  })

  it('光秃秃的数字前面没有词根 → 跳过', () => {
    expect(findMentionTokens('第 3 张')).toEqual([])
  })

  it('粘在词里的不算', () => {
    expect(findMentionTokens('myimage1 foo_image1 ref-image1')).toEqual([])
  })

  it('对不上引用的被过滤掉，只留能用的', () => {
    const hits = resolveTextMentionsIn('image1 和 image9', CAND3)
    expect(hits).toHaveLength(1)
    expect(hits[0].chip.nodeId).toBe('n1')
  })

  it('倒序返回 —— 调用方逐个替换时前面的下标才不会失效', () => {
    const hits = resolveTextMentionsIn('image1 然后 image2', CAND3)
    expect(hits.map(h => h.chip.name)).toEqual(['图片2', '图片1'])
    expect(hits[0].start).toBeGreaterThan(hits[1].start)
  })

  it('start/length 精确框住 token 本身，不含后面的字', () => {
    const text = '，image1保持'
    const [hit] = resolveTextMentionsIn(text, CAND3)
    expect(text.slice(hit.start, hit.start + hit.length)).toBe('image1')
  })

  it('空文本 / 没有 token → 空数组', () => {
    expect(findMentionTokens('')).toEqual([])
    expect(findMentionTokens('完全没有编号的一段话')).toEqual([])
    expect(resolveTextMentionsIn('image1', [])).toEqual([])
  })
})

describe('两个 token 紧挨着（复制粘贴很容易出现 图片1图片2）', () => {
  it('挨在一起的两个都要认，不能只认前一个', () => {
    // 复制时 chip 写成的是中文名（图片1），所以两个挨着的引用长这样
    expect(findMentionTokens('图片1图片2').map(h => h.index)).toEqual([1, 2])
    expect(findMentionTokens('视频1图片3').map(h => h.prefix)).toEqual(['视频', '图片'])
  })

  it('纯 ASCII 挨着（image1image2）仍然不认 —— 数字后面跟字母按规则就是"没打完"', () => {
    // 跟 image1a 同一条规则。这种写法本来也不是复制粘贴会产生的形状。
    expect(findMentionTokens('image1image2')).toEqual([])
  })

  it('三个挨着也全认', () => {
    expect(findMentionTokens('图片1图片2视频1').map(h => h.prefix)).toEqual(['图片', '图片', '视频'])
  })

  it('start/length 各自框住自己那一段', () => {
    const text = '图片1图片2'
    const hits = findMentionTokens(text)
    expect(text.slice(hits[0].start, hits[0].start + hits[0].length)).toBe('图片1')
    expect(text.slice(hits[1].start, hits[1].start + hits[1].length)).toBe('图片2')
  })

  it('紧挨着这条放宽不能顺带放过真正粘在词里的', () => {
    // 前面没有已采纳的 token，所以 foo_ / my 这些照旧挡住
    expect(findMentionTokens('foo_image1')).toEqual([])
    expect(findMentionTokens('myimage1')).toEqual([])
    // 前一个 token 后面紧跟英文字母时，按右边界规则连第一个都不算（同 image1a）
    expect(findMentionTokens('图片1myimage2')).toEqual([])
  })

  it('截图里那句 图片1以输入图片作为首帧 也能认（汉字紧跟）', () => {
    expect(findMentionTokens('图片1以输入图片作为首帧').map(h => h.index)).toEqual([1])
  })
})

describe('汉字紧贴在 token **左边**也要认（2026-08-25 第二次实测漏掉的）', () => {
  /*
   * 上一轮只放开了右边（`image1保`），左边界那条仍把汉字当词字符，
   * 于是用户截图里的 `编辑image1。` 不转 —— 中文写作不用空格，
   * 「编辑」和 `image1` 本来就是两个词。
   */
  it('编辑image1。→ 认（边打边转）', () => {
    const hit = matchMentionToken('编辑image1。')
    expect(hit?.raw).toBe('image1')
    expect(hit?.prefix).toBe('图片')
    expect(hit?.tail).toBe('。')
  })

  it('编辑image1。→ 认（整段扫描）', () => {
    const text = '编辑image1。是SC004的白模构图主控图'
    const hits = findMentionTokens(text)
    expect(hits.map(h => h.raw)).toEqual(['image1'])
    expect(text.slice(hits[0].start, hits[0].start + hits[0].length)).toBe('image1')
  })

  it('中文写法也一样（编辑图片1）', () => {
    expect(matchMentionToken('编辑图片1。')?.prefix).toBe('图片')
    expect(findMentionTokens('参考视频1的节奏').map(h => h.prefix)).toEqual(['视频'])
  })

  it('放开左边的汉字**不能**顺带放过英文粘连', () => {
    expect(matchMentionToken('myimage1 ')).toBeNull()
    expect(matchMentionToken('foo_image1 ')).toBeNull()
    expect(matchMentionToken('ref-image1 ')).toBeNull()
    expect(findMentionTokens('myimage1 foo_image1 ref-image1')).toEqual([])
  })

  it('别名取最长的那个后缀（编辑image 里取 image，不是 e/ge）', () => {
    expect(matchMentionToken('编辑image1。')?.raw).toBe('image1')
  })

  it('SC004 这种编号不会被当成引用（词根不认识）', () => {
    expect(findMentionTokens('是SC004的白模')).toEqual([])
    expect(matchMentionToken('SC004 ')).toBeNull()
  })
})

describe('复制到画布外：chip 名收成 image1 / video1', () => {
  it('中文名变成英文编号', () => {
    expect(clipboardLabelFromChipName('图片1')).toBe('image1')
    expect(clipboardLabelFromChipName('图片2')).toBe('image2')
    expect(clipboardLabelFromChipName('视频1')).toBe('video1')
    expect(clipboardLabelFromChipName('音频3')).toBe('audio3')
  })

  it('已经是英文编号就原样（大小写不敏感）', () => {
    expect(clipboardLabelFromChipName('image1')).toBe('image1')
    expect(clipboardLabelFromChipName('Image 2')).toBe('image2')
    expect(clipboardLabelFromChipName('VIDEO1')).toBe('video1')
  })

  it('对不上编号就原样返回，别把名字吞掉', () => {
    expect(clipboardLabelFromChipName('角色图')).toBe('角色图')
    expect(clipboardLabelFromChipName('')).toBe('')
    expect(clipboardLabelFromChipName(undefined)).toBe('')
  })
})
