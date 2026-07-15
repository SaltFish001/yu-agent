import { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'

interface TermSession {
  topic: string
  cwd: string
  pid: number
  uptime: number
  alive: boolean
}

const XTERM_THEME = {
  background: '#0b0e14',
  foreground: '#cdd6f4',
  cursor: '#cdd6f4',
  selectionBackground: '#3b4261',
  black: '#1e1e2e', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
  blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#cdd6f4',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
  brightCyan: '#94e2d5', brightWhite: '#ffffff',
}

function InlineTerm({ topic }: { topic: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: XTERM_THEME,
      cursorBlink: true,
      convertEol: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    const doFit = () => {
      try { fit.fit() } catch { /* ignore */ }
    }
    requestAnimationFrame(doFit)

    let disposed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let ws: WebSocket | null = null
    let sendQueue: string[] = []

    const flushQueue = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const m of sendQueue) {
          try { ws.send(m) } catch { /* ignore */ }
        }
        sendQueue = []
      }
    }

    const sendInput = (msg: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg)
      else sendQueue.push(msg)
    }

    const sendResize = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) } catch { /* ignore */ }
      }
    }

    const connect = () => {
      if (disposed) return
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${proto}//${location.host}/term-ws/${encodeURIComponent(topic)}`)
      ws.onopen = () => {
        term.focus()
        flushQueue()
        sendResize()
      }
      ws.onmessage = (e) => {
        const data = e.data as string
        if (data.startsWith('{')) {
          try {
            const msg = JSON.parse(data)
            if (msg.type === 'term:init') {
              term.write(`\x1b[2m终端已就绪 (cwd: ${msg.data.cwd})\x1b[0m\n`)
              return
            }
            if (msg.type === 'term:exit') {
              term.write(`\n\x1b[31m进程退出 (code: ${msg.data.code})\x1b[0m\n`)
              return
            }
          } catch { /* not a control message, fall through */ }
        }
        term.write(data)
      }
      ws.onclose = () => {
        if (disposed) return
        term.write('\n\x1b[33m连接已断开，正在重连…\x1b[0m\n')
        reconnectTimer = setTimeout(connect, 3000)
      }
      ws.onerror = () => { try { ws?.close() } catch { /* ignore */ } }
    }

    const onData = term.onData((d) => {
      sendInput(JSON.stringify({ type: 'input', data: d.replace(/\r/g, '\n') }))
    })
    const ro = new ResizeObserver(() => { doFit(); sendResize() })
    ro.observe(host)

    connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ro.disconnect()
      onData.dispose()
      sendQueue = []
      try { ws?.close() } catch { /* ignore */ }
      term.dispose()
    }
  }, [topic])

  return <div className="terminal-host" ref={hostRef} />
}

export default function TerminalPanel() {
  const status = useStore((s) => s.status)
  const topics = status.topics || []
  const activeTopic = useStore((s) => s.activeTopic)
  const [tab, setTab] = useState<'term' | 'sessions'>('term')
  const [selectedTopic, setSelectedTopic] = useState<string>(activeTopic || '')
  const [sessions, setSessions] = useState<TermSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const nonArchived = topics.filter((t: any) => !t.archived)

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
    if (tab === 'sessions') {
      fetchSessions()
      const timer = setInterval(fetchSessions, 5000)
      return () => clearInterval(timer)
    }
  }, [tab, fetchSessions])

  const killSession = async (topic: string) => {
    try {
      const res = await fetch(`/api/terminals/${topic}`, { method: 'DELETE' })
      if (res.ok) fetchSessions()
    } catch { /* ignore */ }
  }

  const termTopic = selectedTopic || activeTopic || 'default'

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs">
        <button type="button" className={tab === 'term' ? 'active' : ''} onClick={() => setTab('term')}>
          {t('term.tab.term')}
        </button>
        <button type="button" className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>
          {t('term.tab.sessions')} ({sessions.length})
        </button>
      </div>

      {tab === 'term' ? (
        <div className="terminal-main">
          <div className="terminal-toolbar">
            <select value={termTopic} onChange={(e) => setSelectedTopic(e.target.value)}>
              <option value="default">default</option>
              {nonArchived.map((t: any) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
            <span className="hint">{t('term.hint')}</span>
          </div>
          <InlineTerm key={termTopic} topic={termTopic} />
        </div>
      ) : (
        <>
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
                          type="button"
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
      )}
    </div>
  )
}

function fmtDuration(s: number): string {
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}
