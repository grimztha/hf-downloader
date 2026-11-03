import { writable } from 'svelte/store'
import { WindowSetDarkTheme, WindowSetLightTheme } from '../../../wailsjs/runtime/runtime'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'hf_downloader_theme'

function getInitialTheme(): Theme {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null
    if (saved === 'light' || saved === 'dark') {
      return saved
    }
  }
  // Default to dark theme as requested
  return 'dark'
}

export const theme = writable<Theme>(getInitialTheme())

export function initTheme() {
  if (typeof window === 'undefined') return
  const current = getInitialTheme()
  applyTheme(current)
}

function applyTheme(newTheme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (newTheme === 'light') {
    root.classList.remove('dark')
    root.classList.add('light')
    root.style.colorScheme = 'light'
    try {
      WindowSetLightTheme()
    } catch {}
  } else {
    root.classList.remove('light')
    root.classList.add('dark')
    root.style.colorScheme = 'dark'
    try {
      WindowSetDarkTheme()
    } catch {}
  }
}

export function setTheme(newTheme: Theme) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, newTheme)
  }
  applyTheme(newTheme)
  theme.set(newTheme)
}

export function toggleTheme() {
  theme.update(current => {
    const next: Theme = current === 'dark' ? 'light' : 'dark'
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, next)
    }
    applyTheme(next)
    return next
  })
}
