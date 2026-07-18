import { useRef, useEffect, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useStore } from '../lib/store'
import { t } from '../lib/i18n'

const XTERM_THEME = {
  background: '#0e151b',
  foreground: '#c9d4dc',
  cursor: '#00d4ff',
  selectionBackground: '#2c3a47',
  black: '#1e2a35', red: '#ff5a5a', green: '#00e5a0', yellow: '#f0b030',
  blue: '#7aa8d8', magenta: '#b894d8', cyan: '#6fc4c9', white: '#c9d4dc',
  brightBlack: '#45505c', brightRed: '#ff5a5a', brightGreen: '#00e5a0',
  brightYellow: '#00d4ff', brightBlue: '#7aa8d8', brightMagenta: '#b894d8',
  brightCyan: '#6fc4c9', brightWhite: '#e9edf1',
}

export default function TerminalPanel() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [sessions, setSessions] = useState<string[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)

  useEffect(() => {
    // Fetch terminal sessions
    fetch('/api/terminals')
      .then((res) => res.json())
      .then((data) => {
        setSessions(data.sessions || [])
        if (data.sessions?.length > 0) setActiveSession(data.sessions[0])
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!hostRef.current || !activeSession) return

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: XTERM_THEME,
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(hostRef.current)
    fitAddon.fit()

    // Connect to WebSocket
    const ws = new WebSocket(`ws://localhost:9876/term-ws?session=${activeSession}`)
    ws.onopen = () => {
      term.writeln('Connected to terminal')
    }
    ws.onmessage = (event) => {
      term.write(event.data)
    }
    ws.onclose = () => {
      term.writeln('\\r\\nDisconnected')
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    const resizeObserver = new ResizeObserver(() => fitAddon.fit())
    resizeObserver.observe(hostRef.current)

    return () => {
      term.dispose()
      ws.close()
      resizeObserver.disconnect()
    }
  }, [activeSession])

  return (
    <div className="flex flex-col h-full">
      {/* Session tabs */}
      {sessions.length > 1 && (
        <div className="flex gap-1 p-2 border-b border-border">
          {sessions.map((s) => (
            <button
              key={s}
              onClick={() => setActiveSession(s)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                s === activeSession
                  ? 'bg-accent/10 text-accent border border-accent/20'
                  : 'text-text-tertiary hover:text-text hover:bg-bg-hover border border-transparent'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Terminal */}
      <div ref={hostRef} className="flex-1 min-h-0 bg-bg-code rounded-lg" />
    </div>
  )
}
