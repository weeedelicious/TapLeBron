/**
 * Seedance 2.5 多模态带参考视频时，必须显式声明 omni_reference_task_type。
 *
 * 2026-09-02 周航「C段老鼠变异」：多模态 + 4 图 + 1 参考视频 + 16:9 / 1080P / 4 秒，
 * 提示词写「参考视频 … 内容」，上游判成 video editing，要求 ratio=adaptive、duration=-1，
 * 节点上只剩 InvalidParameter + Request id。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  seedanceOmniReferenceTaskType,
  seedanceOmniPrompt,
} = require('../server/videoRules.js')

describe('Seedance 2.5 多模态任务类型', () => {
  it('多模态带参考视频 → reference，避免被猜成编辑', () => {
    expect(seedanceOmniReferenceTaskType('Seedance_2_5', 'omni', 1)).toBe('reference')
    expect(seedanceOmniReferenceTaskType('bytedance/seedance-2.5', 'omni', 2)).toBe('reference')
    expect(seedanceOmniReferenceTaskType('dreamina-seedance-2-5-260628', 'mixed2video', 1)).toBe('reference')
  })

  it('多模态只有图、没有参考视频 → 不带这个字段', () => {
    expect(seedanceOmniReferenceTaskType('Seedance_2_5', 'omni', 0)).toBeNull()
  })

  it('用户点了视频编辑 / 延长，才声明 edit / extend', () => {
    expect(seedanceOmniReferenceTaskType('Seedance_2_5', 'video-edit', 1)).toBe('edit')
    expect(seedanceOmniReferenceTaskType('Seedance_2_5', 'extend', 1)).toBe('extend')
  })

  it('2.0 没有这个字段', () => {
    expect(seedanceOmniReferenceTaskType('Seedance_2_0', 'omni', 1)).toBeNull()
    expect(seedanceOmniReferenceTaskType('Seedance_2_0_Fast', 'omni', 1)).toBeNull()
  })
})

describe('Seedance 2.5 多模态提示词', () => {
  it('带参考视频时声明生成新视频，并把「参考视频 内容」改成镜头参考', () => {
    const text = seedanceOmniPrompt({
      model: 'Seedance_2_5',
      modeType: 'omni',
      modelPrompt: '参考视频 @视频1 内容\n灯光氛围参考 @图片4',
      videos: ['/a.mp4'],
    })
    expect(text).toContain('生成一段全新视频')
    expect(text).toContain('镜头运动与表演节拍参考 @视频1')
    expect(text).toContain('灯光氛围参考 @图片4')
    expect(text).not.toMatch(/删除|替换/)
    expect(text).not.toContain('不要对原视频做编辑')
    expect(text).not.toContain('参考视频 @视频1 内容')
    expect(text.startsWith('这是多模态参考生视频')).toBe(true)
  })

  it('药丸和「内容」之间没有空格也能改写', () => {
    const text = seedanceOmniPrompt({
      model: 'Seedance_2_5',
      modeType: 'omni',
      modelPrompt: '参考视频@视频1内容\n左边角色参考 @图片2',
      videos: ['/a.mp4'],
    })
    expect(text).toContain('镜头运动与表演节拍参考 @视频1')
    expect(text).toContain('左边角色外貌参考 @图片2')
    expect(text).not.toContain('参考视频@视频1内容')
  })

  it('上一版带编辑动词的前缀会被清掉，避免 TaskTypeMismatch', () => {
    const text = seedanceOmniPrompt({
      model: 'Seedance_2_5',
      modeType: 'omni',
      modelPrompt: '根据参考素材生成一段全新视频，不要对原视频做编辑、删除、替换或延长。\n参考视频内容',
      videos: ['/a.mp4'],
    })
    expect(text).not.toContain('不要对原视频做编辑')
    expect(text).toContain('镜头运动与表演节拍参考视频素材')
    expect(text.startsWith('这是多模态参考生视频')).toBe(true)
  })

  it('没有参考视频不加前缀', () => {
    expect(
      seedanceOmniPrompt({
        model: 'Seedance_2_5',
        modeType: 'omni',
        prompt: '一只猫走过屋顶',
        videos: [],
      }),
    ).toBe('一只猫走过屋顶')
  })
})
