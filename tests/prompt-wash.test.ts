import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const require = createRequire(import.meta.url)
const service = require(path.join(root, 'server/services/PromptWashService.js')) as {
  alignPromptDuration(value: unknown, targetDuration: number): string
  extractSourceDuration(value: unknown): number | null
  listSeedanceSkills(): {
    categories: Array<{ id: string; label: string }>
    skills: Array<{ id: string; name: string; shortName: string; category: string }>
  }
  normalizeMode(value: unknown): string
  normalizeSkillId(value: unknown): string
  normalizeResult(raw: string, target: Record<string, unknown>): {
    prompt: string
    settings: Record<string, unknown>
    warnings: string[]
  }
  buildMessages(input: Record<string, unknown>): Array<{ role: string; content: string }>
  resolveTarget(sourceText: unknown, target: Record<string, unknown>): Record<string, unknown>
}

describe('文字节点洗提示词', () => {
  it('支持四种模式并提供可点击写回操作', () => {
    const source = fs.readFileSync(path.join(root, 'src/canvas/components/nodes/TextNode.tsx'), 'utf8')
    for (const label of ['保守优化', '电影化', '参考素材强化', '时间轴分镜']) {
      expect(source).toContain(label)
    }
    for (const project of [
      'dexhunter/seedance2-skill',
      'jnMetaCode/ai-shortfilm-prompts',
      'OSideMedia/higgsfield-ai-prompt-skill',
      'LearnPrompt/awesome-seedance',
    ]) {
      expect(source).toContain(project)
    }
    expect(source).toContain('aria-label="洗提示词"')
    expect(source).toContain('替换当前文字')
    expect(source).toContain('新建文字节点')
    expect(source).toContain('写入视频节点')
    expect(source).toContain('选择洗提示词模式，选中后立即执行')
    expect(source).toContain('正在洗提示词…')
    expect(source).toContain('正在创建新的文字节点')
    expect(source).toContain("addNodeAt('text'")
    expect(source).toContain('false && promptWashOpen')
    expect(source).not.toMatch(/applyPromptWashToVideo[\s\S]{0,1800}generateApi\.video\(/)
  })

  it('能清理代码围栏、归一化模型参数并锁定目标时长', () => {
    const result = service.normalizeResult(
      '```json\n{"prompt":"镜头缓慢推进","settings":{"model":"Seedance_2_5","modeType":"i2v","duration":99,"ratio":"16:9","resolution":"4K","enableSound":"off"},"warnings":["比例会自适应"]}\n```',
      { model: 'Seedance_2_5', modeType: 'omni', duration: 10, ratio: '16:9', resolution: '720P', enableSound: 'on' },
    )
    expect(result.prompt).toBe('镜头缓慢推进')
    expect(result.settings).toMatchObject({
      model: 'Seedance_2_5',
      modeType: 'i2v',
      duration: 10,
      ratio: 'adaptive',
      resolution: '720P',
      enableSound: 'off',
    })
    expect(result.warnings).toEqual(['比例会自适应'])
  })

  it('未知模式安全回退到保守优化', () => {
    expect(service.normalizeMode('anything')).toBe('conservative')
  })

  it('支持 MiniMax 官方洗词模式并加载官方规则文件', () => {
    expect(service.normalizeMode('minimax')).toBe('minimax')
    const skill = fs.readFileSync(path.join(root, 'server/skills/minimax-prompt-wash.md'), 'utf8')
    expect(skill).toContain('MiniMax-AI/skills')
    expect(skill).toContain('[Push in]')
    expect(skill).toContain('@图片N')
    const source = fs.readFileSync(path.join(root, 'src/canvas/components/nodes/VideoNode.tsx'), 'utf8')
    expect(source).toContain('MiniMax 官方优化')
    expect(source).toContain("option.value === 'minimax'")
  })

  it('时长优先级为原文秒数、下游视频节点、默认值', () => {
    const downstream = {
      model: 'Seedance_2_5',
      modeType: 'omni',
      duration: 8,
      ratio: '16:9',
      resolution: '720P',
      enableSound: 'on',
    }

    expect(service.extractSourceDuration('制作一段总时长12秒的视频')).toBe(12)
    expect(service.extractSourceDuration('给我设计共21秒对分镜')).toBe(21)
    expect(service.extractSourceDuration('给我设计21秒分镜')).toBe(21)
    expect(service.extractSourceDuration('21秒')).toBe(21)
    expect(service.extractSourceDuration('21秒。第一镜头建立氛围')).toBe(21)
    expect(service.extractSourceDuration('时长：21秒')).toBe(21)
    expect(service.extractSourceDuration('0-4秒建立场景，4-15秒完成动作')).toBe(15)
    expect(service.resolveTarget('制作一段总时长12秒的视频', downstream).duration).toBe(12)
    expect(service.resolveTarget('没有写时长的提示词', downstream).duration).toBe(8)
    expect(service.resolveTarget('没有写时长的提示词', {}).duration).toBe(5)
  })

  it('模型不能把已确定的 21 秒擅自缩短成 15 秒', () => {
    const result = service.normalizeResult(
      JSON.stringify({
        prompt: '15秒横屏连续打斗。0-5秒建立冲突，5-15秒完成反击。',
        sections: {
          timeline: [
            { start: 0, end: 5, shot: '建立冲突' },
            { start: 5, end: 15, shot: '完成反击' },
          ],
        },
        settings: { model: 'Seedance_2_5', duration: 15 },
      }),
      { model: 'Seedance_2_5', modeType: 'omni', duration: 21, ratio: '16:9', resolution: '720P', enableSound: 'on' },
    )

    expect(result.settings.duration).toBe(21)
    expect(result.prompt).toContain('21秒横屏')
    expect(result.prompt).toContain('7-21秒')
    expect(result.sections.timeline).toEqual([
      { start: 0, end: 7, shot: '建立冲突' },
      { start: 7, end: 21, shot: '完成反击' },
    ])
  })

  it('Seedance Skill 库覆盖 LearnPrompt 25 类并接到视频节点复制洗词', () => {
    const library = service.listSeedanceSkills()
    expect(library.categories.map((item) => item.id)).toEqual([
      'structure',
      'ugc',
      'commercial',
      'narrative',
      'style',
      'action',
    ])
    expect(library.skills).toHaveLength(25)
    expect(service.normalizeSkillId('product-commercial-shotlist')).toBe('product-commercial-shotlist')
    expect(service.normalizeSkillId('missing-skill')).toBe('')

    for (const skill of library.skills) {
      const body = fs.readFileSync(path.join(root, 'server/skills/seedance', `${skill.id}.md`), 'utf8')
      expect(body).toContain(`# ${skill.name}`)
      expect(body).toContain('## 空提示词')
    }

    const messages = service.buildMessages({
      sourceText: '',
      mode: 'conservative',
      skillId: 'handheld-ugc-vlog',
      nodeName: '视频节点 15',
      target: { model: 'Seedance_2_5', duration: 8 },
      references: { imageCount: 1, names: ['角色'] },
    })
    expect(messages[0].content).toContain('Shotflow Seedance Skill 共用契约')
    expect(messages[0].content).toContain('手持 UGC vlog')
    expect(messages[1].content).toContain('片种 Skill：手持 UGC vlog')
    expect(messages[1].content).toContain('原始提示词为空')
    expect(messages[1].content).toContain('视频节点 15')

    const videoSource = fs.readFileSync(path.join(root, 'src/canvas/components/nodes/VideoNode.tsx'), 'utf8')
    expect(videoSource).toContain('aria-label="Seedance Skill 库"')
    expect(videoSource).toContain("washVideoPrompt('conservative', choice.value, skill.id)")
    expect(videoSource).toContain('_promptWashSkillId')
    expect(videoSource).toContain('_promptWashSourceName')
    expect(videoSource).toContain('SEEDANCE_PROMPT_SKILLS')
    expect(videoSource).toContain('skill.name')
    expect(videoSource).toContain('promptSkillCategory')
    expect(videoSource).toContain('setPromptSkillCategory(category.id)')
    expect(videoSource).toContain('skill.category === promptSkillCategory')
    expect(videoSource).toContain('promptWashWrapRef')
    expect(videoSource).toContain('promptSkillWrapRef')
    expect(videoSource).toContain("document.addEventListener('mousedown', handler, true)")
  })
})
