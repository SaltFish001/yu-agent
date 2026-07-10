import { useEffect, useCallback } from 'react'

export type Theme = 'dark' | 'light' | 'auto'

export function getStoredTheme(): Theme {
  return (localStorage.getItem('yu-theme') as Theme) || 'dark'
}

export function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme === 'auto') {
    if (typeof window === 'undefined') return 'dark'
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return theme
}

export function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme)
  document.documentElement.setAttribute('data-theme', resolved)
  localStorage.setItem('yu-theme', theme)
}

/**
 * Hook that reads theme from localStorage and applies it.
 * Call in any page/component that needs theme awareness (main page, admin popup, etc.)
 */
export function useTheme() {
  useEffect(() => {
    const stored = getStoredTheme()
    applyTheme(stored)

    // Listen for system preference changes when in auto mode
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      if (getStoredTheme() === 'auto') {
        applyTheme('auto')
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
}

/**
 * For components that want to toggle theme.
 * Returns [theme, setTheme] where setTheme stores + applies.
 */
export function useThemeControl(): [Theme, (t: Theme) => void] {
  const setTheme = useCallback((t: Theme) => {
    applyTheme(t)
  }, [])
  return [getStoredTheme(), setTheme]
}
