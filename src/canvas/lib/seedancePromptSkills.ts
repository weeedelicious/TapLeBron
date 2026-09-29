import catalog from '../../shared/seedance-prompt-skills.json'

export type SeedancePromptSkill = {
  id: string
  category: string
  name: string
  shortName: string
  description: string
}

export type SeedancePromptSkillCategory = {
  id: string
  label: string
}

export const SEEDANCE_PROMPT_SKILL_CATEGORIES = catalog.categories as SeedancePromptSkillCategory[]
export const SEEDANCE_PROMPT_SKILLS = catalog.skills as SeedancePromptSkill[]

export function seedancePromptSkillById(id: unknown) {
  const key = String(id || '').trim()
  return SEEDANCE_PROMPT_SKILLS.find(item => item.id === key) || null
}
