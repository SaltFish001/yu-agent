import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'

interface TermSession {
  topic: string
  cwd: string
  pid: number
  uptime: number
  alive: boolean
}

export default function TerminalPanel() {
  const status = useStore((s) => s.status)
  const topics = status.topics || []
  const [sessions, setSessions] = useState<TermSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedTopic, setSelectedTopic] = useState('')

  const fetchSessions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/terminals')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSessions(data.sessions || [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
    const timer = setInterval(fetchSessions, 5000)
    return () => clearInterval(timer)
  }, [fetchSessions])

  const openTerminal = (topic: string) => {
    const termUrl = `/term-ws/${topic}`
    window.open(termUrl, `terminal-${topic}`, 'width=800,height=500,resizable=yes')
  }

  const killSession = async (topic: string) => {
    try {
      const res = await fetch(`/api/terminals/${topic}`, { method: 'DELETE' })
      if (res.ok) fetchSessions()
    } catch { /* ignore */ }
  }

  const nonArchived = topics.filter((t: any) => !t.archived)

  return (
    <>
      <div className="panel-header">
        <h2>{t('term.title')} ({sessions.length})</h2>
      </div>

      {/* New terminal */}
      <div className="admin-panel-row">
        <select
          value={selectedTopic}
          onChange={(e) => setSelectedTopic(e.target.value)}
        >
          <option value="">{t('term.select.topic')}</option>
          {nonArchived.map((t: any) => (
            <option key={t.name} value={t.name}>{t.name}</option>
          ))}
        </select>
        <button
          className="action-btn"
          disabled={!selectedTopic}
          onClick={() => { if (selectedTopic) openTerminal(selectedTopic) }}
        >
          ▶ {t('term.open')}
        </button>
        <button
          className="action-btn"
          onClick={fetchSessions}
        >
          ↻ {t('term.refresh')}
        </button>
      </div>

      {/* Active sessions */}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Topic</th>
              <th>{t('term.dir')}</th>
              <th>PID</th>
              <th>{t('term.uptime')}</th>
              <th>{t('term.status')}</th>
              <th>{t('term.action')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && sessions.length === 0 ? (
              <tr><td colSpan={6}><span className="hint">{t('loading')}</span></td></tr>
            ) : sessions.length > 0 ? sessions.map((s) => (
              <tr key={s.topic}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.topic}</td>
                <td style={{ fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.cwd}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{s.pid}</td>
                <td>{fmtDuration(s.uptime)}</td>
                <td>
                  <span className={`status-tag tag-${s.alive ? 'active' : 'failed'}`}>
                    <span className="tag-dot" />
                    {s.alive ? t('active') : t('term.disconnected')}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      className="topic-action-btn switch"
                      onClick={() => openTerminal(s.topic)}
                      title={t('term.reopen')}
                    >▶</button>
                    <button
                      className="topic-action-btn archive"
                      onClick={() => killSession(s.topic)}
                      title={t('term.kill')}
                    >✕</button>
                  </div>
                </td>
              </tr>
            )) : (
              <tr><td colSpan={6}><span className="hint">{t('term.no.sessions')}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {error && <div style={{ marginTop: 8, fontSize: 12, color: '#ef4444' }}>❌ {error}</div>}
    </>
  )
}

function fmtDuration(s: number): string {
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}
