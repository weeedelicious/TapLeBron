/**
 * 把提示词编辑器里的内容变成**发给模型**的文本：药丸按原位展开成 `@图片1` 这样的指代。
 *
 * 为什么需要这一步：编辑器里的药丸（data-chip）只进 promptChips，**一个字都不进纯文本**。
 * 于是界面上写着「[图片1] 里的角色飞起来」，模型收到的却只有「里的角色飞起来」，
 * 没有任何指代能把这句话和那张参考图绑起来（2026-08-19 用户反馈"角色没认到参考图"）。
 *
 * 火山方舟对全模态参考生视频的提示词惯例写得很明确：
 *   「明确素材职责：使用 @图片1、@视频1、@音频1 指代参考素材，说明每份素材具体提供什么
 *    （如外貌、动作、音色），以及不采用什么。」
 *
 * 为什么不直接改存储的文本：编辑器在没有 promptHtml 时会走 buildEditorHtml 兜底，
 * 它把药丸**全部追加到文本末尾**。若文本里已经含 `@图片1`，就会变成"文本里一个、末尾再挂一个"
 * 的重复显示。所以存储保持原样，只在发送这一刻按 promptHtml 的原位展开。
 */

/** 药丸展开后的前缀。跟上游文档的写法保持一致。 */
const MENTION_PREFIX = '@'

export interface ModelPromptInput {
  /** 存在节点上的纯文本（不含药丸） */
  prompt?: string
  /** 存在节点上的富文本，药丸的位置信息只有这里有 */
  promptHtml?: string
}

/**
 * 从 promptHtml 里按原位展开药丸。拿不到 DOM、没有 promptHtml、或解析出问题时
 * 一律退回纯文本 —— 宁可少一个指代，也不能让生成因为提示词处理挂掉。
 */
export function modelPromptFromNodeParams(input: ModelPromptInput): string {
  const fallback = String(input.prompt ?? '').trim()
  const html = String(input.promptHtml ?? '')
  if (!html || !html.includes('data-chip')) return fallback
  if (typeof document === 'undefined') return fallback

  try {
    const container = document.createElement('div')
    container.innerHTML = html
    let text = ''
    let needsNewline = false

    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        // 编辑器在药丸后面塞了零宽空格占位，去掉它
        const value = (node.textContent ?? '').replace(/​/g, '')
        if (value) {
          if (needsNewline && text) { text += '\n'; needsNewline = false }
          text += value
        }
        return
      }
      const element = node as HTMLElement
      if (element.tagName === 'BR') { needsNewline = true; return }
      if (element.dataset?.chip) {
        const name = String(element.dataset.name ?? '').trim()
        if (name) {
          if (needsNewline && text) { text += '\n'; needsNewline = false }
          // 前后各留一个空格，免得跟中文黏成「@图片1里」这种模型不好切分的形态；
          // 末尾多余空格最后统一收拾。
          text += `${text.endsWith(' ') || text === '' ? '' : ' '}${MENTION_PREFIX}${name} `
        }
        return
      }
      element.childNodes.forEach(walk)
    }

    container.childNodes.forEach(walk)
    const expanded = text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
    return expanded || fallback
  } catch (error) {
    console.error('[modelPrompt] 展开药丸失败，按纯文本发送', error)
    return fallback
  }
}
