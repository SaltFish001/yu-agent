/** yu-agent — global status bar (app-level, persistent across views) */

import { useStore, type WindowType } from '../lib/store'
import { t } from '../lib/i18n'

const WIN_BUTTONS: Array<{ type: WindowType; icon: string; label: string }> = [
  { type: 'status', icon: '📊', label: '系统状态' },
  { type: 'bg', icon: '🗂', label: '后台任务' },
  { type: 'terminal', icon: '⌨', label: '终端' },
  { type: 'files', icon: '📁', label: '文件' },
  { type: 'rules', icon: '📐', label: '规则' },
  { type: 'skills', icon: '🧩', label: '技能' },
]

export default function StatusBar() {
  const connected = useStore((s) => s.connected)
  const tokenUsage = useStore((s) => s.tokenUsage)
  const agentIterations = useStore((s) => s.agentIterations)
  const agentBudget = useStore((s) => s.agentBudget)
  const status = useStore((s) => s.status)
  const openWindow = useStore((s) => s.openWindow)
  const bgActive = status.bgStats?.active || 0

  return (
    <div className="chat-status-bar">
      <span
        className={`status-indicator ${connected ? 'connected' : 'disconnected'}`}
        title={connected ? t('connected') : t('disconnected')}
      >
        <span className="status-dot" />
        <span className="status-label">{connected ? t('connected') : t('disconnected')}</span>
      </span>
      <span className="status-sep">·</span>
      <span className="status-item" title="Token 使用量">
        Token: {tokenUsage.toLocaleString()}
      </span>
      <span className="status-sep">·</span>
      <span className="status-item" title="Agent 循环迭代次数">
        迭代: {agentIterations}
      </span>
      {agentIterations > 0 && (
        <>
          <span className="status-sep">·</span>
          <span className="status-item" title="Token 预算">
            预算: {Math.round((tokenUsage / agentBudget) * 100)}%
          </span>
        </>
      )}
      <span className="status-filler" />
      <span className="status-win-group">
        {WIN_BUTTONS.map((b) => (
          <button
            key={b.type}
            type="button"
            className="status-win-btn"
            title={b.label}
            data-tip={b.label}
            aria-label={b.label}
            onClick={() => openWindow(b.type)}
          >
            {b.icon}
            {b.type === 'bg' && bgActive > 0 && <span className="status-badge">{bgActive}</span>}
          </button>
        ))}
      </span>
      <span className="status-item status-version">yu v{status.version || '?'}</span>
    </div>
  )
}
