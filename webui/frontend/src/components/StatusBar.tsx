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
  const status = useStore((s) => s.status)
  const openWindow = useStore((s) => s.openWindow)
  const bgActive = status.bgStats?.active || 0

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-t border-border bg-bg-sidebar">
      {/* Connection status */}
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-ok shadow-[0_0_6px_rgba(0,229,160,0.5)]' : 'bg-err'}`} />
        <span className="text-xs text-text-tertiary">
          {connected ? t('connected') : t('disconnected')}
        </span>
      </div>

      {/* Stats */}
      <div className="hidden sm:flex items-center gap-3 text-xs text-text-tertiary">
        <span>Token: {tokenUsage.toLocaleString()}</span>
        <span>迭代: {agentIterations}</span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Window buttons */}
      <div className="flex items-center gap-1">
        {WIN_BUTTONS.map((b) => (
          <button
            key={b.type}
            onClick={() => openWindow(b.type)}
            title={b.label}
            className="relative w-7 h-7 flex items-center justify-center rounded-lg text-sm text-text-tertiary hover:text-text hover:bg-bg-hover transition-colors"
          >
            {b.icon}
            {b.type === 'bg' && bgActive > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 flex items-center justify-center bg-accent text-on-accent text-[9px] font-bold rounded-full">
                {bgActive}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Version */}
      <span className="text-[10px] text-text-muted font-mono">yu v{status.version || '?'}</span>
    </div>
  )
}
