import { useState, useEffect } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'
import { applyTheme, type Theme } from '../lib/theme'

export default function SettingsModal() {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [theme, setThemeState] = useState<Theme>('dark')
  const [lang, setLangState] = useState('zh')
  const [model, setModel] = useState('deepseek-chat')
  const [maxIterations, setMaxIterations] = useState(50)
  const [budget, setBudget] = useState(40000)

  useEffect(() => {
    const storedTheme = localStorage.getItem('yu-theme') as Theme || 'dark'
    setThemeState(storedTheme)
    const storedLang = localStorage.getItem('yu-lang') || 'zh'
    setLangState(storedLang)
  }, [])

  const handleThemeChange = (val: Theme) => {
    setThemeState(val)
    applyTheme(val)
  }

  const handleLangChange = (val: string) => {
    setLangState(val)
    localStorage.setItem('yu-lang', val)
    window.dispatchEvent(new CustomEvent('yu-lang-change', { detail: val }))
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" onClick={() => setSettingsOpen(false)}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-[480px] max-w-[90vw] max-h-[80vh] bg-bg border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-base font-semibold text-text">{t('settings')}</h3>
          <button
            onClick={() => setSettingsOpen(false)}
            className="w-7 h-7 flex items-center justify-center rounded text-text-tertiary hover:text-text hover:bg-bg-hover transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Theme */}
          <div>
            <label className="block text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">{t('settings.theme')}</label>
            <select
              value={theme}
              onChange={(e) => handleThemeChange(e.target.value as Theme)}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
            >
              <option value="dark">深色</option>
              <option value="light">浅色</option>
              <option value="auto">自动</option>
            </select>
          </div>

          {/* Language */}
          <div>
            <label className="block text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">{t('settings.lang')}</label>
            <select
              value={lang}
              onChange={(e) => handleLangChange(e.target.value)}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">{t('settings.model')}</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
            />
          </div>

          {/* Max Iterations */}
          <div>
            <label className="block text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">{t('settings.agent.maxIterations')}</label>
            <input
              type="number"
              value={maxIterations}
              onChange={(e) => setMaxIterations(Number(e.target.value))}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
            />
          </div>

          {/* Budget */}
          <div>
            <label className="block text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">{t('settings.agent.budget')}</label>
            <input
              type="number"
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
              className="w-full px-3 py-2 bg-bg-surface border border-border rounded-lg text-sm text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            onClick={() => setSettingsOpen(false)}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => setSettingsOpen(false)}
            className="px-4 py-2 text-sm font-semibold text-on-accent bg-accent rounded-lg hover:bg-accent-hover transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
