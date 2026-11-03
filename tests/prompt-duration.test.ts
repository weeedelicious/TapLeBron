import { describe, expect, it } from 'vitest'
import { extractPromptDurationSeconds } from '@/lib/promptDuration'

describe('extractPromptDurationSeconds', () => {
  it('reads an explicit total duration', () => {
    expect(extractPromptDurationSeconds('一共17秒，人物转身离开')).toBe(17)
    expect(extractPromptDurationSeconds('总时长：12.5秒')).toBe(12.5)
    expect(extractPromptDurationSeconds('15秒分镜，雨中奔跑')).toBe(15)
  })

  it('uses the end of a timeline when no total is written', () => {
    expect(extractPromptDurationSeconds('0-3秒 起身\n3-8秒 跑向门口')).toBe(8)
  })

  it('ignores prompts without a duration', () => {
    expect(extractPromptDurationSeconds('人物在雨里奔跑')).toBeNull()
  })
})
