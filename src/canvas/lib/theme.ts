export type ShotflowTheme = 'black' | 'white' | 'warm'

export const SHOTFLOW_THEME_STORAGE_KEY = 'shotflow:theme'
export const DEFAULT_SHOTFLOW_THEME: ShotflowTheme = 'black'

export const SHOTFLOW_THEME_OPTIONS: Array<{
  value: ShotflowTheme
  label: string
  description: string
  swatch: string
}> = [
  {
    value: 'black',
    label: '黑色',
    description: '沉浸式暗色画布',
    swatch: '#090a0d',
  },
  {
    value: 'white',
    label: '白色',
    description: '明亮冷白工作台',
    swatch: '#f4f6f8',
  },
  {
    value: 'warm',
    label: '暖色',
    description: '柔和米杏工作台',
    swatch: '#efe3d2',
  },
]

export function isShotflowTheme(value: unknown): value is ShotflowTheme {
  return value === 'black' || value === 'white' || value === 'warm'
}

export function readStoredShotflowTheme(): ShotflowTheme {
  if (typeof window === 'undefined') return DEFAULT_SHOTFLOW_THEME
  try {
    const stored = window.localStorage.getItem(SHOTFLOW_THEME_STORAGE_KEY)
    return isShotflowTheme(stored) ? stored : DEFAULT_SHOTFLOW_THEME
  } catch {
    return DEFAULT_SHOTFLOW_THEME
  }
}

export function applyShotflowTheme(theme: ShotflowTheme) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.shotflowTheme = theme
  document.documentElement.style.colorScheme = theme === 'black' ? 'dark' : 'light'
}

export function setShotflowTheme(theme: ShotflowTheme) {
  applyShotflowTheme(theme)
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SHOTFLOW_THEME_STORAGE_KEY, theme)
  } catch {
    // Theme switching should still work when storage is unavailable.
  }
}

export function initializeShotflowTheme() {
  applyShotflowTheme(readStoredShotflowTheme())
}
