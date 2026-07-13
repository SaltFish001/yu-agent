import { useState, useEffect } from 'react'
import { useStore } from '../lib/store'
import { t, setLang, getLang } from '../lib/i18n'
import { type Theme, getStoredTheme, applyTheme, resolveTheme } from '../lib/theme'
import { updateConfig } from '../lib/api'

export default function SettingsModal() {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const status = useStore((s) => s.status)
  const agentBudget = useStore((s) => s.agentBudget)
  const setAgentBudget = useStore((s) => s.setAgentBudget)
  const agentIterations = useStore((s) => s.agentIterations)
  const setAgentIterations = useStore((s) => s.setAgentIterations)

  const [theme, setTheme] = useState<Theme>(getStoredTheme())
  const [lang, setLangState] = useState(getLang())
  const [budget, setBudget] = useState(String(agentBudget))
  const [iters, setIters] = useState(String(agentIterations || 25))
  const [model, setModel] = useState('deepseek-v4-flash')
  const [restarting, setRestarting] = useState(false)

  // Apply theme on change
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // On mount, ensure correct theme is applied (handles auto → resolved)
  useEffect(() => {
    applyTheme(getStoredTheme())
  }, [])

  const handleLangChange = (l: string) => {
    setLangState(l)
    setLang(l)
    // Force re-render by toggling a state that all t() calls will see
    window.dispatchEvent(new CustomEvent('yu-lang-change', { detail: l }))
  }

  const handleBudgetBlur = () => {
    const v = parseInt(budget, 10)
    if (!isNaN(v) && v > 0) {
      setAgentBudget(v)
    } else {
      setBudget(String(agentBudget))
    }
  }

  const handleRestart = async () => {
    if (!confirm(t('settings.restart.confirm'))) return
    setRestarting(true)
    try {
      await fetch('/api/restart', { method: 'POST' })
    } catch {
      // Server will disconnect
    }
    setTimeout(() => {
      location.reload()
    }, 3000)
  }

  const resolvedTheme = resolveTheme(theme)

  return (
    <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
      <div className="modal-window modal-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('settings.title')}</h3>
          <button className="modal-close" onClick={() => setSettingsOpen(false)} title={t('settings.close')}>✕</button>
        </div>
        <div className="modal-body">
          {/* General */}
          <div className="settings-section">
            <div className="settings-label">{t('settings.general')}</div>
            <div className="settings-row">
              <span>{t('settings.theme')}</span>
              <div className="settings-right">
                <select
                  className="settings-select"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as Theme)}
                >
                  <option value="dark">{t('settings.theme.dark')}</option>
                  <option value="light">{t('settings.theme.light')}</option>
                  <option value="auto">{t('settings.theme.auto')}</option>
                </select>
                {theme === 'auto' && (
                  <span className="settings-hint">
                    {resolvedTheme === 'dark' ? '🌙' : '☀️'}
                  </span>
                )}
              </div>
            </div>
            <div className="settings-row">
              <span>{t('settings.lang')}</span>
              <select
                className="settings-select"
                value={lang}
                onChange={(e) => handleLangChange(e.target.value)}
              >
                <option value="zh">{t('settings.lang.zh')}</option>
                <option value="en">{t('settings.lang.en')}</option>
              </select>
            </div>
          </div>

          {/* Model */}
          <div className="settings-section">
            <div className="settings-label">{t('settings.model')}</div>
            <div className="settings-row">
              <span>{t('settings.default.model')}</span>
              <select
                className="settings-select"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value)
                  updateConfig({ defaultModel: e.target.value })
                }}
              >
                <option value="deepseek-v4-flash">DeepSeek v4 Flash</option>
                <option value="deepseek-v4-pro">DeepSeek v4 Pro</option>
              </select>
            </div>
          </div>

          {/* Agent */}
          <div className="settings-section">
            <div className="settings-label">{t('settings.agent')}</div>
            <div className="settings-row">
              <div className="settings-col">
                <span>{t('settings.token.budget')}</span>
                <span className="settings-desc">{t('settings.token.budget.desc')}</span>
              </div>
              <input
                type="number"
                className="settings-input"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                onBlur={handleBudgetBlur}
                min={1000}
                max={999999}
                step={1000}
                style={{ width: 110 }}
              />
            </div>
            <div className="settings-row">
              <span>{t('settings.max.iters')}</span>
              <input
                type="number"
                className="settings-input"
                value={iters}
                onChange={(e) => setIters(e.target.value)}
                onBlur={() => {
                  const v = parseInt(iters, 10)
                  if (!isNaN(v) && v > 0) {
                    setAgentIterations(v)
                    updateConfig({ maxIterations: v })
                  } else {
                    setIters(String(agentIterations || 25))
                  }
                }}
                min={1}
                max={100}
                style={{ width: 80 }}
              />
            </div>
          </div>

          {/* System */}
          <div className="settings-section">
            <div className="settings-label">{t('settings.system')}</div>
            <div className="settings-row">
              <span>{t('settings.restart')}</span>
              <button
                className="settings-btn danger"
                onClick={handleRestart}
                disabled={restarting}
              >
                {restarting ? t('settings.restarting') : t('settings.restart')}
              </button>
            </div>
          </div>

          {/* About */}
          <div className="settings-section">
            <div className="settings-label">{t('settings.about')}</div>
            <div className="settings-row">
              <span>{t('settings.version')}</span>
              <span className="settings-version">
                yu v{status.version || '?'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
