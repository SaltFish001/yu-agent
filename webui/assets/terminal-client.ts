/**
 * yu-agent Web UI — Terminal client module
 *
 * Manages xterm.js instances for per-topic Web terminals.
 * Each terminal connects to /term-ws/:topic via WebSocket.
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

// ── Types ──

interface TermSession {
  topic: string
  term: Terminal
  fitAddon: FitAddon
  ws: WebSocket | null
  container: HTMLDivElement
  tab: HTMLDivElement
  active: boolean
  cwd: string
  pid: number | null
}

// ── State ──

const sessions = new Map<string, TermSession>()
let activeTopic: string | null = null

// DOM refs
let panelEl: HTMLDivElement
let tabBarEl: HTMLDivElement
let terminalContainer: HTMLDivElement

// ── Init ──

export function initTerminal(): void {
  panelEl = document.getElementById('terminal-panel') as HTMLDivElement
  tabBarEl = document.getElementById('term-tab-bar') as HTMLDivElement
  terminalContainer = document.getElementById('term-containers') as HTMLDivElement

  if (!panelEl || !tabBarEl || !terminalContainer) {
    console.warn('Terminal panel elements not found in DOM')
    return
  }

  // Toggle button
  const toggleBtn = document.getElementById('term-toggle-btn')
  toggleBtn?.addEventListener('click', () => togglePanel())

  // New terminal button
  const newBtn = document.getElementById('term-new-btn')
  newBtn?.addEventListener('click', () => openTerminal('default'))

  // Close panel button
  const closeBtn = document.getElementById('term-close-btn')
  closeBtn?.addEventListener('click', () => closePanel())
}

// ── Panel toggle ──

let isPanelOpen = false

export function togglePanel(): void {
  if (isPanelOpen) {
    closePanel()
  } else {
    openPanel()
  }
}

export function openPanel(): void {
  panelEl.classList.remove('hidden')
  isPanelOpen = true
  // Fit active terminal
  if (activeTopic) {
    const sess = sessions.get(activeTopic)
    if (sess) {
      setTimeout(() => sess.fitAddon.fit(), 50)
    }
  }
}

export function closePanel(): void {
  panelEl.classList.add('hidden')
  isPanelOpen = false
}

// ── Open terminal for a topic ──

export function openTerminal(topic: string, cwd?: string): void {
  // If session already exists, just switch to it
  const existing = sessions.get(topic)
  if (existing) {
    switchTab(topic)
    openPanel()
    return
  }

  // Create container
  const container = document.createElement('div')
  container.className = 'term-container'
  container.id = `term-c-${topic.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  terminalContainer.appendChild(container)

  // Create tab
  const tab = document.createElement('div')
  tab.className = 'term-tab'
  const label = topic === 'default' ? 'terminal' : topic
  tab.innerHTML = `<span class="term-tab-label">${escapeHtml(label)}</span><span class="term-tab-close" data-topic="${escapeHtml(topic)}">&times;</span>`
  tab.addEventListener('click', () => switchTab(topic))
  tab.querySelector('.term-tab-close')?.addEventListener('click', (e) => {
    e.stopPropagation()
    closeTerminal(topic)
  })
  tabBarEl.insertBefore(tab, tabBarEl.lastElementChild) // before the "+" button

  // Init xterm
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: 13,
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", "Consolas", monospace',
    theme: {
      background: '#0d0d0f',
      foreground: '#c8c8cc',
      cursor: '#c8c8cc',
      selectionBackground: '#2a2a3a',
      black: '#1a1a1e',
      red: '#e05050',
      green: '#4aca6b',
      yellow: '#d4a040',
      blue: '#4a6aff',
      magenta: '#b060d0',
      cyan: '#40b0d0',
      white: '#c8c8cc',
      brightBlack: '#3a3a42',
      brightRed: '#e06060',
      brightGreen: '#5ada7b',
      brightYellow: '#e0b050',
      brightBlue: '#5b7aff',
      brightMagenta: '#c070e0',
      brightCyan: '#50c0e0',
      brightWhite: '#e8e8ee',
    },
    allowTransparency: true,
    cols: 80,
    rows: 24,
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  // Open terminal in container
  term.open(container)

  // Try to fit
  setTimeout(() => {
    try { fitAddon.fit() } catch { /* ignore */ }
  }, 100)

  // Show "connecting..."
  term.write('\x1b[90mConnecting...\x1b[0m\r\n')

  const session: TermSession = {
    topic,
    term,
    fitAddon,
    ws: null,
    container,
    tab,
    active: false,
    cwd: cwd || '',
    pid: null,
  }
  sessions.set(topic, session)

  // Connect WebSocket
  connectTermWS(session)

  // Switch to this tab
  switchTab(topic)
  openPanel()
}

// ── WebSocket connection ──

function connectTermWS(session: TermSession): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = location.host
  const url = `${protocol}//${host}/term-ws/${encodeURIComponent(session.topic)}`
  const ws = new WebSocket(url)

  ws.onopen = () => {
    session.ws = ws
    session.term.write('\x1b[32mConnected.\x1b[0m\r\n')
  }

  ws.onmessage = (e: MessageEvent) => {
    const data = e.data as string
    // Check for JSON control messages
    if (data.startsWith('{') && data.includes('"type":"term:')) {
      try {
        const msg = JSON.parse(data)
        if (msg.type === 'term:init') {
          session.cwd = msg.data?.cwd || ''
          session.pid = msg.data?.pid || null
          // Update tab tooltip
          session.tab.title = `PID: ${session.pid} | ${session.cwd}`
          return
        }
        if (msg.type === 'term:exit') {
          const code = msg.data?.code
          session.term.write(`\r\n\x1b[33mProcess exited (code: ${code})\x1b[0m\r\n`)
          return
        }
      } catch { /* not JSON, treat as terminal output */ }
    }
    // Terminal output
    session.term.write(data)
  }

  ws.onclose = () => {
    if (session.ws === ws) {
      session.ws = null
      session.term.write('\r\n\x1b[31mDisconnected.\x1b[0m\r\n')
      // Auto-reconnect after 3s
      setTimeout(() => {
        if (sessions.has(session.topic) && !session.ws) {
          session.term.write('\x1b[90mReconnecting...\x1b[0m\r\n')
          connectTermWS(session)
        }
      }, 3000)
    }
  }

  ws.onerror = () => {
    session.term.write('\r\n\x1b[31mConnection error.\x1b[0m\r\n')
  }

  // Input handler: forward keystrokes from terminal to WebSocket
  session.term.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }))
    }
  })

  // Resize handler
  session.term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  })

  // Window resize → fit
  const onWinResize = () => {
    if (session.active) {
      setTimeout(() => {
        try { session.fitAddon.fit() } catch { /* ignore */ }
      }, 100)
    }
  }
  window.addEventListener('resize', onWinResize)
}

// ── Tab switching ──

function switchTab(topic: string): void {
  // Deactivate all
  for (const [key, sess] of sessions) {
    sess.active = false
    sess.tab.classList.remove('active')
    sess.container.classList.add('hidden')
  }

  // Activate target
  const session = sessions.get(topic)
  if (session) {
    session.active = true
    session.tab.classList.add('active')
    session.container.classList.remove('hidden')
    activeTopic = topic
    // Fit after switching
    setTimeout(() => {
      try { session.fitAddon.fit() } catch { /* ignore */ }
    }, 50)
  }
}

// ── Close terminal ──

function closeTerminal(topic: string): void {
  const session = sessions.get(topic)
  if (!session) return

  // Close WebSocket
  if (session.ws) {
    session.ws.close()
    session.ws = null
  }

  // Destroy terminal
  session.term.dispose()

  // Remove DOM elements
  session.tab.remove()
  session.container.remove()

  sessions.delete(topic)

  // If no sessions left, close panel
  if (sessions.size === 0) {
    closePanel()
    activeTopic = null
  } else if (topic === activeTopic) {
    // Switch to first available
    const first = sessions.keys().next().value
    if (first) switchTab(first)
  }
}

// ── Helpers ──

function escapeHtml(s: string): string {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}
