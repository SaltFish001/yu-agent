import { useState } from 'react'
import { useStore } from '../lib/store'
import BgTasksPanel from './BgTasksPanel'
import RulesPanel from './RulesPanel'
import SkillsPanel from './SkillsPanel'

type AdminTab = 'status' | 'bg' | 'rules' | 'skills'

const TABS: { key: AdminTab; label: string }[] = [
  { key: 'status', label: '状态' },
  { key: 'bg', label: '后台' },
  { key: 'rules', label: '规则' },
  { key: 'skills', label: '技能' },
]

function StatusView() {
  const status = useStore((s) => s.status)
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          <tr><td style={{ color: 'var(--text-tertiary)' }}>版本</td><td style={{ fontFamily: 'var(--font-mono)' }}>{status.version || '—'}</td></tr>
          <tr><td style={{ color: 'var(--text-tertiary)' }}>运行时间</td><td style={{ fontFamily: 'var(--font-mono)' }}>{fmtDuration(status.uptime || 0)}</td></tr>
          <tr><td style={{ color: 'var(--text-tertiary)' }}>RSS</td><td style={{ fontFamily: 'var(--font-mono)' }}>{fmtBytes(status.memory?.rss || 0)}</td></tr>
          <tr><td style={{ color: 'var(--text-tertiary)' }}>Heap</td><td style={{ fontFamily: 'var(--font-mono)' }}>{fmtBytes(status.memory?.heapUsed || 0)} / {fmtBytes(status.memory?.heapTotal || 0)}</td></tr>
          <tr><td style={{ color: 'var(--text-tertiary)' }}>WS 连接</td><td style={{ fontFamily: 'var(--font-mono)' }}>{status.ws?.connected || 0}</td></tr>
          <tr><td style={{ color: 'var(--text-tertiary)' }}>Agent 运行</td><td style={{ fontFamily: 'var(--font-mono)' }}>{(status as any).agentStats?.total || 0} 次</td></tr>
        </tbody>
      </table>
    </div>
  )
}

export default function AdminPanel() {
  const [tab, setTab] = useState<AdminTab>('status')
  const setAdminOpen = useStore((s) => s.setAdminOpen)

  return (
    <div className="admin-overlay" onClick={() => setAdminOpen(false)}>
      <div className="admin-window" onClick={(e) => e.stopPropagation()}>
        <div className="admin-header">
          <div className="admin-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`admin-tab ${tab === t.key ? 'active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button className="admin-close" onClick={() => setAdminOpen(false)}>✕</button>
        </div>
        <div className="admin-body">
          {tab === 'status' && <StatusView />}
          {tab === 'bg' && <BgTasksPanel />}
          {tab === 'rules' && <RulesPanel />}
          {tab === 'skills' && <SkillsPanel />}
        </div>
      </div>
    </div>
  )
}

function fmtDuration(s: number): string {
  if (s < 60) return Math.floor(s) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}

function fmtBytes(b: number): string {
  if (!b || b === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}
