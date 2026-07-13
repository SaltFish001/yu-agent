import { useEffect, useState, useCallback } from 'react'
import { useStore, type StatusData } from '../lib/store'
import { fetchStatus, connectWS } from '../lib/api'
import { useTheme } from '../lib/theme'
import BgTasksPanel from '../components/BgTasksPanel'
import TopicsPanel from '../components/TopicsPanel'
import RulesPanel from '../components/RulesPanel'
import SkillsPanel from '../components/SkillsPanel'
import TerminalPanel from '../components/TerminalPanel'
import FileBrowserPanel from '../components/FileBrowserPanel'

type Tab = 'status' | 'agents' | 'bg' | 'rules' | 'skills' | 'terminal' | 'files'

// Use t() for labels so language follows settings modal
import { t } from '../lib/i18n'
function getTabs() {
  return [
    { key: 'status' as Tab, label: t('status') },
    { key: 'agents' as Tab, label: t('admin.tab.agents') },
    { key: 'bg' as Tab, label: t('admin.tab.bg') },
    { key: 'terminal' as Tab, label: t('admin.tab.terminal') },
    { key: 'files' as Tab, label: t('admin.tab.files') },
    { key: 'rules' as Tab, label: t('admin.tab.rules') },
    { key: 'skills' as Tab, label: t('admin.tab.skills') },
  ]
}

function fmtDuration(s: number): string {
  if (s < 60) return Math.floor(s) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h + 'h ' + m + 'm'
}

function fmtBytes(b: number): string {
  if (!b || b === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

function StatusView() {
  const status = useStore((s) => s.status)
  return (
    <div>
      <div className="admin-dash-grid">
        <div className="card">
          <div className="card-label">{t('admin.version')}</div>
          <div className="card-value" style={{ fontSize: 16 }}>{status.version || '—'}</div>
        </div>
        <div className="card">
          <div className="card-label">{t('admin.uptime')}</div>
          <div className="card-value">{status.uptime ? fmtDuration(status.uptime) : '—'}</div>
        </div>
        <div className="card">
          <div className="card-label">RSS</div>
          <div className="card-value">{status.memory?.rss ? fmtBytes(status.memory.rss) : '—'}</div>
        </div>
        <div className="card">
          <div className="card-label">{t('admin.heap')}</div>
          <div className="card-value" style={{ fontSize: 16 }}>
            {status.memory?.heapUsed ? fmtBytes(status.memory.heapUsed) : '—'}
          </div>
          <div className="card-sub">/ {status.memory?.heapTotal ? fmtBytes(status.memory.heapTotal) : '—'}</div>
        </div>
        <div className="card">
          <div className="card-label">{t('admin.ws.conn')}</div>
          <div className="card-value">{status.ws?.connected ?? '—'}</div>
        </div>
        <div className="card">
          <div className="card-label">{t('admin.agent.running')}</div>
          <div className="card-value">{(status as any).agentStats?.total ?? '—'}</div>
          <div className="card-sub">{(status as any).agentStats?.completed ?? 0} {t('admin.completed')}</div>
        </div>
      </div>

      {status.memory && (
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('admin.metric')}</th>
                <th>{t('admin.value')}</th>
              </tr>
            </thead>
            <tbody>
              <tr><td style={{ color: 'var(--text-tertiary)' }}>{t('admin.heap.usage')}</td><td style={{ fontFamily: 'var(--font-mono)' }}>
                {status.memory.heapTotal ? Math.round((status.memory.heapUsed! / status.memory.heapTotal) * 100) + '%' : '—'}
              </td></tr>
              {status.ws && (
                <>
                  <tr><td style={{ color: 'var(--text-tertiary)' }}>{t('admin.ws.msg')}</td><td style={{ fontFamily: 'var(--font-mono)' }}>{status.ws.messagesSent ?? '—'}</td></tr>
                  <tr><td style={{ color: 'var(--text-tertiary)' }}>{t('admin.ws.alive')}</td><td style={{ fontFamily: 'var(--font-mono)' }}>{status.ws.uptimeSec ? fmtDuration(status.ws.uptimeSec) : '—'}</td></tr>
                </>
              )}
              <tr><td style={{ color: 'var(--text-tertiary)' }}>{t('admin.agent.failed')}</td><td style={{ fontFamily: 'var(--font-mono)' }}>{(status as any).agentStats?.failed ?? '—'}</td></tr>
              <tr><td style={{ color: 'var(--text-tertiary)' }}>{t('admin.avg.duration')}</td><td style={{ fontFamily: 'var(--font-mono)' }}>
                {(status as any).agentStats?.avgDurationMs ? fmtDuration((status as any).agentStats.avgDurationMs / 1000) : '—'}
              </td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function AdminPage() {
  useTheme()
  const [tab, setTab] = useState<Tab>('status')
  const setStatus = useStore((s) => s.setStatus)

  useEffect(() => {
    fetchStatus().then(setStatus).catch(() => {})
    const ws = connectWS((data: StatusData) => setStatus(data))
    return () => ws.close()
  }, [setStatus])

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') window.close()
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  return (
    <div className="admin-page">
      <aside className="admin-sidebar">
        <div className="admin-brand">y</div>
        <nav className="admin-nav">
          {getTabs().map((t) => (
            <button
              key={t.key}
              className={`admin-nav-item ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
              title={t.label}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="admin-nav-footer">
          <button className="admin-nav-item" onClick={() => window.close()} title={t('admin.close')}>✕</button>
        </div>
      </aside>
      <main className="admin-main">
        <div className="admin-content">
          {tab === 'status' && <StatusView />}
          {tab === 'agents' && <TopicsPanel />}
          {tab === 'bg' && <BgTasksPanel />}
          {tab === 'terminal' && <TerminalPanel />}
          {tab === 'files' && <FileBrowserPanel />}
          {tab === 'rules' && <RulesPanel />}
          {tab === 'skills' && <SkillsPanel />}
        </div>
      </main>
    </div>
  )
}
