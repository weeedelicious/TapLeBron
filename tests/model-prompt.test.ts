/**
 * 药丸在发送时展开成 @图片1（2026-08-19 用户反馈"角色没认到参考图"）。
 *
 * 编辑器里的药丸只进 promptChips，一个字都不进纯文本 —— 界面上写着
 * 「[图片1] 里的角色飞起来」，模型收到的只有「里的角色飞起来」，没有任何指代把这句话
 * 和参考图绑起来。火山方舟文档要求用 @图片1 这种写法指代素材。
 *
 * 关键约束：**不许改存储的文本**。编辑器没有 promptHtml 时会走兜底渲染，那个兜底把药丸
 * 全部追加到末尾；文本里若已含 @图片1，就会变成"文本里一个、末尾再挂一个"的重复显示。
 * 所以只在发送这一刻按 promptHtml 的原位展开，这里验的就是这个展开。
 */
import { describe, expect, it } from 'vitest'
import { modelPromptFromNodeParams } from '@/lib/modelPrompt'

function chip(name: string) {
  return `<span data-chip="1" data-nodeid="n1" data-url="/assets/1/a.png" data-name="${name}"><span>${name}</span></span>`
}

describe('modelPromptFromNodeParams', () => {
  it('按药丸的原位展开成 @名字', () => {
    expect(modelPromptFromNodeParams({
      prompt: '里的角色飞起来',
      promptHtml: `${chip('图片1')}​里的角色飞起来`,
    })).toBe('@图片1 里的角色飞起来')
  })

  it('药丸在中间也按原位展开', () => {
    expect(modelPromptFromNodeParams({
      prompt: '让里的人跳舞',
      promptHtml: `让${chip('图片2')}​里的人跳舞`,
    })).toBe('让 @图片2 里的人跳舞')
  })

  it('多个药丸各自展开', () => {
    const html = `${chip('图片1')}​的角色，用${chip('视频1')}​的动作`
    expect(modelPromptFromNodeParams({ prompt: '的角色，用的动作', promptHtml: html }))
      .toBe('@图片1 的角色，用 @视频1 的动作')
  })

  it('没有 promptHtml 时原样返回纯文本', () => {
    expect(modelPromptFromNodeParams({ prompt: '一只猫走过屋顶' })).toBe('一只猫走过屋顶')
  })

  it('promptHtml 里没有药丸时也原样返回纯文本（不去动它）', () => {
    expect(modelPromptFromNodeParams({ prompt: '一只猫', promptHtml: '<div>一只猫</div>' }))
      .toBe('一只猫')
  })

  it('只有药丸、没有文字时展开成纯指代', () => {
    expect(modelPromptFromNodeParams({ prompt: '', promptHtml: `${chip('图片1')}​` }))
      .toBe('@图片1')
  })

  it('药丸缺 data-name 时跳过它，不产出一个孤零零的 @', () => {
    const broken = '<span data-chip="1" data-nodeid="n1" data-url="/x.png"><span>?</span></span>飞起来'
    expect(modelPromptFromNodeParams({ prompt: '飞起来', promptHtml: broken })).toBe('飞起来')
  })

  it('换行保留', () => {
    expect(modelPromptFromNodeParams({
      prompt: '第一行\n第二行',
      promptHtml: `${chip('图片1')}​第一行<br>第二行`,
    })).toBe('@图片1 第一行\n第二行')
  })

  it('promptHtml 是垃圾时退回纯文本，绝不抛异常', () => {
    expect(modelPromptFromNodeParams({
      prompt: '兜底文本',
      promptHtml: '<span data-chip="1" <<<>>> 坏结构',
    })).toBeTruthy()
  })
})
