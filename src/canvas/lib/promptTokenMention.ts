/**
 * 提示词里手写的 `image1` 自动变成 @引用（2026-08-25 用户要求：
 * 「提示词里有 image1，会自动变成 @对应图片，模糊识别 "image1 " "image1/" 等」）。
 *
 * 这里只做**纯字符串判断**，不碰 DOM —— 光标和节点替换由 PromptEditor 负责。
 * 分开是因为「什么算一个 token」这件事全是边界情况，值得单独测：
 *   · `myimage1` 不能算（前面粘着别的字母，那是一个更长的词）；
 *   · `image12` 是第 12 个，不是第 1 个后面跟个 2；
 *   · 编号对不上（写了 image5 但只接了 3 张图）时什么都不做，不能悄悄换成第 3 张。
 *
 * 两条入口：
 *   · matchMentionToken —— 边打边转，判断"光标前刚好打完一个 token"；
 *   · findMentionTokens —— 整段扫一遍，管「在中间插入、压根没敲尾随字符」和已有的提示词。
 */
import type { ChipRef } from '@/components/PromptEditor'

/** 词根 → 引用名的前缀。引用名由节点侧生成（图片1 / 视频1 / 音频1）。 */
const KIND_ALIASES: Array<{ prefix: string; words: string[] }> = [
  { prefix: '图片', words: ['image', 'img', 'pic', 'picture', '图片', '图'] },
  { prefix: '视频', words: ['video', 'vid', 'clip', '视频'] },
  { prefix: '音频', words: ['audio', 'sound', '音频', '音'] },
]

/** 复制到画布外时 chip 写成的英文名。图片1 → image1，视频2 → video2。 */
const CLIPBOARD_KIND: Record<string, string> = {
  图片: 'image',
  视频: 'video',
  音频: 'audio',
}

/**
 * 把 chip 显示名收成外部能认的纯文本：`图片1` / `image 1` → `image1`。
 * 对不上编号就原样返回，别把名字吞掉。
 */
export function clipboardLabelFromChipName(name: string | undefined | null): string {
  const raw = String(name ?? '').trim()
  if (!raw) return ''
  const match = /^(图片|视频|音频|image|img|pic|picture|video|vid|clip|audio|sound)\s*[-_]?\s*(\d{1,2})$/i.exec(raw)
  if (!match) return raw
  const kind = match[1]
  const index = match[2]
  const english = CLIPBOARD_KIND[kind] ?? kind.toLowerCase()
  const word = english === 'img' || english === 'pic' || english === 'picture'
    ? 'image'
    : english === 'vid' || english === 'clip'
      ? 'video'
      : english === 'sound'
        ? 'audio'
        : english
  return `${word}${index}`
}

/**
 * 什么字符会让 token「继续长」—— 只有它们跟在后面时才不能转换。
 *
 * 一开始写成了分隔符白名单（空格、斜杠、各种标点），结果**汉字不在名单里**：
 * 中文提示词 `image1保持画面一致` 里 image1 后面直接跟汉字，永远等不到分隔符，
 * 于是一次都不转（2026-08-25 用户实测发现）。中文本来就不靠空格断词，白名单这条路走不通。
 *
 * 反过来列就干净了：只有**数字**（还在打 image15）和 **ASCII 字母 / _ / -**
 * （还在打 image1a、image1_ref 这种）算"没打完"，其余一切都算断词，汉字自然就包含进来了。
 */
function canExtendToken(char: string | undefined) {
  if (char === undefined) return false
  return /[0-9A-Za-z_-]/.test(char)
}

/**
 * 词根**左边**紧贴着什么算"同一个词"。
 *
 * 只有 ASCII 字母、数字、`_`、`-` 才算 —— 挡的是 `myimage1`、`foo_image1`、`ref-image1`。
 * **汉字不算**：中文写作没有空格，`编辑image1` 里「编辑」和 `image1` 是两个词，
 * 把汉字算成粘连的话中文提示词里几乎所有写法都转不了（2026-08-25 用户实测发现）。
 * 注意这跟 token **内部**允许 `image-1` 不冲突：那是词根和序号之间的分隔，是另一回事。
 */
function isGluedLeft(char: string | undefined) {
  if (char === undefined) return false
  return /[0-9A-Za-z_-]/.test(char)
}

function prefixForWord(word: string): string | null {
  const lowered = word.toLowerCase()
  return KIND_ALIASES.find((entry) => entry.words.includes(lowered))?.prefix ?? null
}

/**
 * 在 [runStart, runEnd) 这段连续词字符里，从左往右找**最长**的、能对上类型的别名后缀。
 *
 * 为什么要找后缀而不是拿整段去比：中文里词是连着写的，`编辑image1` 取到的词字符串是
 * `编辑image`，整段当然不是别名，但它的后缀 `image` 是。
 * 找到之后还要确认别名左边不是 ASCII 粘连（否则 `myimage1` 的后缀 `image` 也会命中）。
 */
function aliasSuffix(
  text: string,
  runStart: number,
  runEnd: number,
  /**
   * 这个位置上的左粘连要放过 —— 传的是**前一个已采纳 token 的结束位置**。
   * `图片1图片2` 的第二个别名左边紧贴着前一个的数字 `1`，那不是粘在同一个词里，
   * 而正好是前一个词结束的地方。不放过的话这种要点两次才全转。
   */
  boundaryAt = -1,
): { prefix: string; start: number } | null {
  for (let start = runStart; start < runEnd; start++) {
    const prefix = prefixForWord(text.slice(start, runEnd))
    if (!prefix) continue
    if (start !== boundaryAt && isGluedLeft(text[start - 1])) continue
    return { prefix, start }
  }
  return null
}

export interface MentionTokenMatch {
  /** 匹配到的原文，如 `image1` */
  raw: string
  /** 引用名前缀，如 `图片` */
  prefix: string
  /** 第几个，从 1 开始 */
  index: number
  /** 要从光标前删掉多少个字符（token + 那个断词字符） */
  removeCount: number
  /** 断词字符原样补回 chip 后面，别把用户敲的字吃掉 */
  tail: string
}

/**
 * 看光标前的这段文字是不是刚好敲完一个 `image1` 加一个断词字符。
 *
 * 只在最后一个字符**不能再延长 token** 时才返回结果 —— 这是「不要抢用户输入」的关键：
 * 打到 `image1` 还在犹豫要不要变成 `image15` 时不动，等他敲下别的字才转。
 */
export function matchMentionToken(textBeforeCaret: string): MentionTokenMatch | null {
  if (!textBeforeCaret) return null
  const tail = textBeforeCaret.slice(-1)
  if (canExtendToken(tail)) return null
  const head = textBeforeCaret.slice(0, -1)
  if (!head) return null

  // 以末尾的数字为锚点往左拆，跟 findMentionTokens 同一套办法。
  // 数字最多两位：够用（一个节点不会接 100 张参考图），也避免把长串数字当序号。
  const digitsMatch = /(\d{1,2})$/.exec(head)
  if (!digitsMatch) return null
  const digits = digitsMatch[1]
  // 不用再单独挡"三位以上数字"：多出来的那一位会落进下面取到的词根串里
  // （`image123` 的词根变成 `image1`），别名检查自然就不认了。单独写一句是死代码。

  // 往左跳过词根与序号之间的分隔（image 1 / image_1 / image-2）
  let wordEnd = head.length - digits.length
  let seps = 0
  while (wordEnd > 0 && seps < 2 && /[\s_-]/.test(head[wordEnd - 1])) {
    wordEnd--
    seps++
  }
  // 再往左把连续的词字符取完
  let runStart = wordEnd
  while (runStart > 0 && /[0-9A-Za-z一-龥]/.test(head[runStart - 1])) runStart--

  const alias = aliasSuffix(head, runStart, wordEnd)
  if (!alias) return null

  const index = Number(digits)
  if (!Number.isInteger(index) || index < 1) return null

  const raw = head.slice(alias.start)
  return { raw, prefix: alias.prefix, index, removeCount: raw.length + 1, tail }
}

export interface MentionTokenHit {
  /** 在这段文字里的起始下标 */
  start: number
  /** token 长度（只含 token 自己，不含后面的断词字符） */
  length: number
  raw: string
  prefix: string
  index: number
}

/**
 * 整段文字里所有能转的 token，按出现顺序。
 *
 * 边打边转只能覆盖「打完 token 又敲了一个字」这一种；用户在已有文字中间插进一个
 * `image1`（后面本来就跟着汉字、他也没再敲任何键），或者粘贴 / Cindy 写好的提示词，
 * 都得靠整段扫。判据跟上面那条一致：左边界要断开，右边不能是还能延长 token 的字符。
 */
export function findMentionTokens(text: string): MentionTokenHit[] {
  const hits: MentionTokenHit[] = []
  if (!text) return hits
  // 以**数字**为锚点往左找词根，而不是用一条 `词根+数字` 的正则去扫。
  // 用正则扫会踩这个坑：贪婪的词根会把 `image12` 切成词根 `image1` + 序号 `2`，
  // 而 `image1` 不是别名，于是**两位数编号整段扫描时全部漏掉**。
  // 数字串取最长（\d+），所以「后面还跟着数字」这种情况天然不存在。
  const re = /\d+/g
  let match: RegExpExecArray | null
  /**
   * 上一个已采纳 token 的结束位置。
   * 两个 token 直接挨着时（复制粘贴很容易出现 `图片1图片2`），后一个的左边紧贴着
   * 前一个的数字，按"左边不能是数字/字母"那条会被当成粘在词里而跳过 ——
   * 于是要点两次失焦才全部转完。前一个 token 刚好在这里结束，那就是个合法的边界。
   */
  let prevEnd = -1
  while ((match = re.exec(text)) !== null) {
    const digits = match[0]
    const digitStart = match.index
    const end = digitStart + digits.length
    if (digits.length > 2) continue // 三位以上不当序号
    if (canExtendToken(text[end])) continue // 后面粘着字母/下划线 → 不是引用（image1a）

    // 往左跳过词根与序号之间的分隔（image 1 / image_1 / image-2）
    let wordEnd = digitStart
    let seps = 0
    while (wordEnd > 0 && seps < 2 && /[\s_-]/.test(text[wordEnd - 1])) {
      wordEnd--
      seps++
    }
    // 再往左把词根取完。**不能越过前一个 token**：词字符里含数字，
    // `图片1图片2` 的第二个会一路吃到开头、词根变成 `图片1图片` 而认不出来。
    const floor = prevEnd > 0 ? prevEnd : 0
    let wordStart = wordEnd
    while (wordStart > floor && /[0-9A-Za-z一-龥]/.test(text[wordStart - 1])) wordStart--
    if (wordStart === wordEnd) continue // 数字前面没有词根

    const alias = aliasSuffix(text, wordStart, wordEnd, prevEnd)
    if (!alias) continue
    const index = Number(digits)
    if (!Number.isInteger(index) || index < 1) continue
    hits.push({
      start: alias.start,
      length: end - alias.start,
      raw: text.slice(alias.start, end),
      prefix: alias.prefix,
      index,
    })
    prevEnd = end
  }
  return hits
}

/**
 * 把匹配到的 token 对上真正的引用。
 *
 * 对不上就返回 null，**文字原样留着** —— 用户写了 `image5` 但只接了 3 张图时，
 * 悄悄转成第 3 张或者把字吃掉都是错的，不动才对。
 */
export function resolveMentionToken(
  match: { prefix: string; index: number },
  candidates: ChipRef[],
): ChipRef | null {
  const wanted = `${match.prefix}${match.index}`
  return candidates.find((chip) => chip.name === wanted && Boolean(chip.url)) ?? null
}

/** PromptEditor 边打边转用：给一段光标前文字，要么给出替换方案，要么 null。 */
export function resolveTextMentionAt(
  textBeforeCaret: string,
  candidates: ChipRef[],
): { chip: ChipRef; removeCount: number; tail: string } | null {
  const match = matchMentionToken(textBeforeCaret)
  if (!match) return null
  const chip = resolveMentionToken(match, candidates)
  if (!chip) return null
  return { chip, removeCount: match.removeCount, tail: match.tail }
}

/**
 * PromptEditor 整段扫描用：一段文字里所有**能对上引用**的 token。
 * 倒序返回（从后往前），这样调用方逐个替换时前面那些的下标不会失效。
 */
export function resolveTextMentionsIn(
  text: string,
  candidates: ChipRef[],
): Array<{ start: number; length: number; chip: ChipRef }> {
  return findMentionTokens(text)
    .map((hit) => {
      const chip = resolveMentionToken(hit, candidates)
      return chip ? { start: hit.start, length: hit.length, chip } : null
    })
    .filter((hit): hit is { start: number; length: number; chip: ChipRef } => hit !== null)
    .reverse()
}
