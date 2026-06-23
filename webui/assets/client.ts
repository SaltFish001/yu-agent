/**
 * yu-agent Web UI — Client logic
 *
 * 通信: WebSocket (status) + SSE (events) + fetch (chat)
 * 特性: markdown 渲染、代码复制、快捷建议、加载动画
 */

import { initTerminal, openTerminal } from './terminal-client.js'

// ── Types ──

interface MemoryInfo {
  rss: number
  heapTotal: number
  heapUsed: number
}

interface StatusData {
  version: string
  uptime: number
  memory: MemoryInfo
  tools: Array<{ name: string; description?: string; paramCount?: number }>
  rules: Array<{ name: string; trigger?: string; action?: string }>
  topics?: Array<{
    name: string; status: string; turns: number; summary?: string
    archived?: boolean; lastActive?: string | null
  }>
  activeTopic?: string | null
  events?: { total: number; unacknowledged: number; pendingTopics: string[] }
  agentStats?: { total?: number; completed?: number; failed?: number; avgDurationMs?: number } | null
  tokenUsage?: { totalTokens?: number; sessionCount?: number; totalCost?: number } | null
  skills?: Array<{ name: string; description?: string }>
  backgroundTasks?: Array<{
    id: string; type: string; status: string; prompt?: string; duration?: number | null
  }>
  bgStats?: { active: number; completed: number; failed: number }
  ws?: {
    connected: number; total: number; peak: number; messagesSent: number; uptimeSec: number
  }
}

interface ChatResponse {
  success: boolean
  output: string
  iterations: number
  totalTokens: number
}

interface WsMessage {
  type: string
  data: unknown
  timestamp: number
}

interface TopicData {
  id: string
  name: string
  dir: string
  summary: string
  status: string
  turns: number
  lastActive: string | null
  createdAt: string
  archived: number
}

interface TopicDetail {
  topic: TopicData
  files: Array<{ name: string; path: string; isDir: boolean; size: number }>
  git: { hasGit: boolean; lastCommit: string; diffStat: string; diff: string }
}

interface TopicListResponse {
  topics: TopicData[]
  activeName: string | null
}

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

// ── State ──

const state: {
  messages: Message[]
  uptime: number
  memory: MemoryInfo
  topics: TopicData[]
  activeTopic: string | null
  requestCount: number
  iterationCount: number
  sending: boolean
  wsConnected: number
  wsTotal: number
  wsMsgs: number
  wsUptime: number
  backgroundTasks: Array<{ id: string; type: string; status: string; prompt?: string; duration?: number | null }>
  bgStats: { active: number; completed: number; failed: number }
} = {
  messages: [],
  uptime: 0,
  memory: { rss: 0, heapTotal: 0, heapUsed: 0 },
  topics: [],
  activeTopic: null,
  requestCount: 0,
  iterationCount: 0,
  sending: false,
  wsConnected: 0,
  wsTotal: 0,
  wsMsgs: 0,
  wsUptime: 0,
}

// ── DOM refs ──

const $ = (id: string): HTMLElement => document.getElementById(id)!
const chatEl = $('chat') as HTMLDivElement
const inputEl = $('message-input') as HTMLInputElement
const sendBtn = $('send-btn') as HTMLButtonElement
const uptimeEl = $('uptime-val') as HTMLSpanElement
const memEl = $('mem-val') as HTMLSpanElement
const versionEl = $('version-label') as HTMLSpanElement
const statsReqsEl = document.getElementById('stats-reqs') as HTMLSpanElement
const wsStatusEl = document.getElementById('ws-status') as HTMLSpanElement
const statusBadge = document.getElementById('status-badge') as HTMLDivElement
const loadingEl = document.getElementById('loading-indicator') as HTMLDivElement
const sidebarEl = document.getElementById('sidebar') as HTMLDivElement

// ── Initial loading state ──
// Show after 3s if no WS connection yet (slow network)
let loadTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
  if (wsStatusEl.textContent === '离线') {
    wsStatusEl.textContent = '连接中…'
  }
}, 3000)
const topicInfoEl = $('topic-info') as HTMLDivElement
const topicListEl = $('topic-list') as HTMLDivElement
const topicsCountEl = $('topics-count') as HTMLSpanElement

// ── WS detail refs ──
const wsDetailStatus = document.getElementById('ws-detail-status') as HTMLSpanElement
const wsDetailClients = document.getElementById('ws-detail-clients') as HTMLSpanElement
const wsDetailMsgs = document.getElementById('ws-detail-msgs') as HTMLSpanElement
const wsDetailUptime = document.getElementById('ws-detail-uptime') as HTMLSpanElement

// ── Simple Markdown Renderer ──

function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text)

  // Code blocks (```) — must be first to avoid conflicting with inline processing
  let html = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langClass = lang ? ` class="lang-${escapeHtml(lang)}"` : ''
    return `<pre><code${langClass}>${code.trim()}</code></pre>`
  })

  // Inline code (`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Bold (**text**)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // Unordered list (lines starting with - or *)
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

  // Newlines
  html = html.replace(/\n/g, '<br>')

  return html
}

function escapeHtml(s: string): string {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

// ── Render ──

function render(): void {
  if (state.messages.length === 0) {
    chatEl.innerHTML = `
      <div id="empty-state">
        <div class="icon">🎣</div>
        <h3>yu-agent</h3>
        <p>输入消息开始对话</p>
        <div class="empty-hints">
          <span class="hint">试试: <code>yu help</code></span>
          <span class="hint">试试: <code>yu doctor</code></span>
        </div>
      </div>`
  } else {
    chatEl.innerHTML = state.messages
      .map((m, i) => {
        const cls = m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant'
        const label = m.role === 'user' ? '你' : m.role === 'system' ? '系统' : 'yu'
        const isLast = i === state.messages.length - 1
        const loading = isLast && m.role === 'assistant' && m.content === '...'
        const content = loading
          ? '<span class="typing-dots"><span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>'
          : renderMarkdown(m.content)
        return `<div class="message ${cls}">
          <div class="msg-avatar ${cls}">${label === '你' ? 'U' : 'Y'}</div>
          <div class="msg-body">
            <div class="msg-label">${label}</div>
            <div class="msg-content">${content}</div>
          </div>
        </div>`
      })
      .join('')
    chatEl.scrollTop = chatEl.scrollHeight
  }

  // Sidebar
  uptimeEl.textContent = fmtDuration(state.uptime)
  memEl.textContent = fmtBytes(state.memory.rss || 0)
  statsReqsEl.textContent = `${state.requestCount} / ${state.iterationCount}`
  versionEl.textContent = `v${(window as any).YU_VERSION || '0.1.0'}`

  // Topic list
  if (state.topics.length > 0) {
    const max = 6
    const visible = state.topics.slice(0, max)
    const remaining = state.topics.length - max
    topicListEl.innerHTML = visible
      .map((t) => {
        const isActive = t.name === state.activeTopic
        const statusIcon = t.status === 'active' ? '▶' : t.status === 'background' ? '⏳' : '○'
        const archiveMark = t.archived ? '📦' : ''
        return `<div class="topic-item${isActive ? ' active' : ''}" data-topic="${escapeHtml(t.name)}">
          <span class="topic-status">${statusIcon}</span>
          <span class="item-name">${escapeHtml(t.name)}</span>
          <span class="item-desc">${t.turns}t</span>
          ${archiveMark ? `<span class="topic-archive">${archiveMark}</span>` : ''}
          <span class="topic-term-btn" data-topic="${escapeHtml(t.name)}" title="Open terminal">$_</span>
        </div>`
      })
      .join('')
    if (remaining > 0) {
      topicListEl.innerHTML += `<div class="list-more">+${remaining} more</div>`
    }
    topicsCountEl.textContent = `${state.topics.length}`

    // Add click handlers
    topicListEl.querySelectorAll('.topic-item').forEach((el) => {
      (el as HTMLElement).addEventListener('click', (e) => {
        // Don't navigate to topic detail if terminal button was clicked
        if ((e.target as HTMLElement).classList.contains('topic-term-btn')) return
        const name = (el as HTMLElement).dataset.topic || ''
        if (name) showTopicDetail(name)
      })
    })
    // Terminal button handlers
    topicListEl.querySelectorAll('.topic-term-btn').forEach((el) => {
      (el as HTMLElement).addEventListener('click', (e) => {
        e.stopPropagation()
        const name = (el as HTMLElement).dataset.topic || ''
        if (name) openTerminal(name)
      })
    })
  } else {
    topicListEl.innerHTML = '<span class="sidebar-hint">暂无主题</span>'
    topicsCountEl.textContent = '0'
  }

  // WS details
  const isOnline = document.getElementById('ws-status')?.textContent === '在线'
  wsDetailStatus.textContent = isOnline ? '🟢 在线' : '🔴 离线'
  wsDetailClients.textContent = `${state.wsConnected} (累计 ${state.wsTotal})`
  wsDetailMsgs.textContent = state.wsMsgs.toLocaleString()
  wsDetailUptime.textContent = fmtDuration(state.wsUptime)
}

// ── Formatting ──

function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

function fmtDuration(secs: number): string {
  if (secs < 60) return Math.floor(secs) + 's'
  if (secs < 3600) return Math.floor(secs / 60) + 'm ' + Math.floor(secs % 60) + 's'
  return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm'
}

// ── Status update ──

function applyStatus(data: StatusData): void {
  state.uptime = data.uptime ?? 0
  state.memory = data.memory ?? { rss: 0, heapTotal: 0, heapUsed: 0 }
  if (data.ws) {
    state.wsConnected = data.ws.connected
    state.wsTotal = data.ws.total
    state.wsMsgs = data.ws.messagesSent
    state.wsUptime = data.ws.uptimeSec
  }
  // Topics from full push
  if (data.topics) {
    state.topics = data.topics as unknown as TopicData[]
    state.activeTopic = data.activeTopic ?? null
  }
  // Events
  if (data.events) {
    ;(window as any).__events = data.events
  }
  // Agent stats
  if (data.agentStats) {
    ;(window as any).__agentStats = data.agentStats
  }
  // Token usage
  if (data.tokenUsage) {
    ;(window as any).__tokenUsage = data.tokenUsage
  }
  // Skills
  if (data.skills) {
    ;(window as any).__skills = data.skills
  }
  // Background tasks
  if (data.backgroundTasks) {
    state.backgroundTasks = data.backgroundTasks as any
  }
  if (data.bgStats) {
    state.bgStats = data.bgStats
  }
  // Store raw data for dashboard
  ;(window as any).__lastStatus = data
  versionEl.textContent = data.version ?? 'v0.1.0'
  render()
  renderPanels()
}

// ── WebSocket ──

let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

function connectWS(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${location.host}/ws`
  const ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    wsStatusEl.textContent = '在线'
    statusBadge.className = 'connected'
    topicInfoEl.textContent = '已连接'
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer)
      wsReconnectTimer = null
    }
  }

  ws.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(e.data as string) as WsMessage
      switch (msg.type) {
        case 'connected':
          wsStatusEl.textContent = '在线'
          statusBadge.className = 'connected'
          break
        case 'status':
          applyStatus(msg.data as StatusData)
          break
        case 'chat:complete': {
          const d = msg.data as { result?: string }
          const last = state.messages[state.messages.length - 1]
          if (last?.role === 'assistant' && last.content === '...') {
            last.content = d.result || '(done)'
            render()
          }
          break
        }
      }
    } catch { /* ignore */ }
  }

  ws.onclose = () => {
    wsStatusEl.textContent = '离线'
    statusBadge.className = 'disconnected'
    state.wsConnected = 0
    render()
    wsReconnectTimer = setTimeout(() => connectWS(), 3000)
  }

  ws.onerror = () => ws.close()
}

// ── API calls ──

async function sendMessage(text: string): Promise<void> {
  if (state.sending || !text.trim()) return
  state.sending = true
  sendBtn.disabled = true
  inputEl.disabled = true

  state.messages.push({ role: 'user', content: text })
  state.messages.push({ role: 'assistant', content: '...' })
  render()

  try {
    state.requestCount++
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    })
    const data = (await res.json()) as ChatResponse
    state.iterationCount += data.iterations ?? 0

    const last = state.messages[state.messages.length - 1]
    if (last?.role === 'assistant') {
      last.content = data.output || '(empty response)'
    }
  } catch (e) {
    const last = state.messages[state.messages.length - 1]
    if (last?.role === 'assistant') {
      last.content = `请求失败: ${(e as Error).message}`
    }
  } finally {
    state.sending = false
    sendBtn.disabled = false
    inputEl.disabled = false
    inputEl.focus()
    render()
  }
}

function clearChat(): void {
  state.messages = []
  state.requestCount = 0
  state.iterationCount = 0
  render()
  inputEl.focus()
}

// ── Topic detail ──

async function showTopicDetail(name: string): Promise<void> {
  // Show loading
  state.messages.push({ role: 'system', content: `📂 加载主题: ${name}...` })
  render()

  try {
    const res = await fetch(`/api/topic/${encodeURIComponent(name)}`)
    if (!res.ok) {
      const err = await res.json() as { error?: string }
      state.messages.push({ role: 'system', content: `❌ ${err.error || '加载失败'}` })
      render()
      return
    }
    const detail = await res.json() as TopicDetail

    // Build detail content
    const lines: string[] = []
    lines.push(`# 📁 ${detail.topic.name}`)
    lines.push('')
    lines.push(`**状态:** ${detail.topic.status}  |  **目录:** \`${detail.topic.dir}\``)
    lines.push(`**轮次:** ${detail.topic.turns}  |  **创建:** ${detail.topic.createdAt ? new Date(detail.topic.createdAt).toLocaleDateString() : '-'}`)
    if (detail.topic.summary) lines.push(`**摘要:** ${detail.topic.summary}`)
    lines.push('')
    lines.push('---')
    lines.push(`[🖥 打开终端](javascript:void(0)) — 在 \`${detail.topic.dir}\` 目录下打开终端`)
    lines.push('')

    // File tree
    lines.push('## 📄 文件')
    lines.push('')
    if (detail.files.length > 0) {
      const dirs = detail.files.filter((f) => f.isDir)
      const files = detail.files.filter((f) => !f.isDir)
      for (const d of dirs) lines.push(`📁 \`${d.name}/\``)
      for (const f of files) lines.push(`📄 \`${f.name}\`  (${fmtBytes(f.size)})`)
    } else {
      lines.push('*(目录不存在或为空)*')
    }
    lines.push('')

    // Git status
    if (detail.git.hasGit) {
      lines.push('## 🔄 Git')
      lines.push('')
      lines.push(`**最后提交:** \`${detail.git.lastCommit || '(无提交)'}\``)
      if (detail.git.diffStat) {
        lines.push('')
        lines.push('**未提交变更:**')
        lines.push('```')
        lines.push(detail.git.diffStat)
        lines.push('```')
      }
      if (detail.git.diff) {
        lines.push('')
        lines.push('**Diff:**')
        lines.push('```diff')
        lines.push(detail.git.diff.slice(0, 2000)) // cap to avoid huge messages
        if (detail.git.diff.length > 2000) lines.push('...(diff 过长，已截断)')
        lines.push('```')
      } else if (!detail.git.diffStat) {
        lines.push('')
        lines.push('*(工作区干净)*')
      }
    }

    state.messages.push({ role: 'system', content: lines.join('\n') })
  } catch (e) {
    state.messages.push({ role: 'system', content: `❌ 请求失败: ${(e as Error).message}` })
  }

  // Remove loading message
  const loadingIdx = state.messages.findIndex((m) => m.role === 'system' && m.content.startsWith('📂'))
  if (loadingIdx >= 0) state.messages.splice(loadingIdx, 1)

  render()
}

// ── Panel rendering ──

function renderPanels(): void {
  const data = (window as any).__lastStatus as StatusData | undefined
  if (!data) return

  // Dashboard
  const dashUptime = document.getElementById('dash-uptime')
  const dashMem = document.getElementById('dash-mem')
  const dashRules = document.getElementById('dash-rules')
  const dashTools = document.getElementById('dash-tools')
  const dashBgActive = document.getElementById('dash-bg-active')
  const dashBgDetail = document.getElementById('dash-bg-detail')
  const dashEvents = document.getElementById('dash-events')
  const dashEventsDetail = document.getElementById('dash-events-detail')
  const dashVersion = document.getElementById('dash-version')
  const dashAgentRuns = document.getElementById('dash-agent-runs')

  if (dashUptime) dashUptime.textContent = fmtDuration(data.uptime ?? 0)
  if (dashMem) dashMem.textContent = fmtBytes(data.memory?.rss ?? 0)
  if (dashRules) dashRules.textContent = String(data.rules?.length ?? 0)
  if (dashTools) dashTools.textContent = String(data.tools?.length ?? 0)
  if (dashVersion) dashVersion.textContent = data.version ?? '0.1.0'

  // Background tasks stats
  const bgStats = data.bgStats || state.bgStats
  if (dashBgActive && bgStats) {
    const total = (bgStats.active ?? 0) + (bgStats.completed ?? 0) + (bgStats.failed ?? 0)
    dashBgActive.textContent = String(bgStats.active ?? 0)
    if (dashBgDetail) {
      const parts: string[] = []
      if (bgStats.active > 0) parts.push(`${bgStats.active} 运行中`)
      if (bgStats.completed > 0) parts.push(`${bgStats.completed} 完成`)
      if (bgStats.failed > 0) parts.push(`${bgStats.failed} 失败`)
      dashBgDetail.textContent = parts.join(' · ') || '无任务'
    }
  }

  // Events
  const ev = data.events as { total?: number; unacknowledged?: number } | undefined
  if (dashEvents) dashEvents.textContent = String(ev?.total ?? 0)
  if (dashEventsDetail) dashEventsDetail.textContent = `${ev?.unacknowledged ?? 0} 未确认`

  // Agent runs
  const agentStats = data.agentStats as { total?: number } | undefined
  if (dashAgentRuns) dashAgentRuns.textContent = String(agentStats?.total ?? 0)

  // Topics table
  const topicsTbody = document.getElementById('topics-tbody')
  if (topicsTbody && state.topics.length > 0) {
    topicsTbody.innerHTML = state.topics
      .map((t) => {
        const statusIcon = t.status === 'active' ? '▶' : t.status === 'background' ? '⏳' : '○'
        const lastActive = t.lastActive ? new Date(t.lastActive).toLocaleString() : '-'
        return `<tr data-topic="${escapeHtml(t.name)}">
          <td>${escapeHtml(t.name)}</td>
          <td>${statusIcon} ${t.status}</td>
          <td>${t.turns}</td>
          <td>${lastActive}</td>
        </tr>`
      })
      .join('')
    // Click to load topic detail
    topicsTbody.querySelectorAll('tr').forEach((row) => {
      row.addEventListener('click', () => {
        const name = (row as HTMLElement).dataset.topic || ''
        if (name) showTopicDetail(name)
      })
    })
  } else if (topicsTbody) {
    topicsTbody.innerHTML = '<tr><td colspan="4"><span class="sidebar-hint">暂无主题</span></td></tr>'
  }

  // Background tasks table
  const bgTbody = document.getElementById('bg-tbody')
  const bgTasks = data.backgroundTasks || state.backgroundTasks
  if (bgTbody && bgTasks && bgTasks.length > 0) {
    bgTbody.innerHTML = bgTasks
      .map((t) => {
        const statusIcon = t.status === 'running' ? '🟢' : t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'pending' ? '⏳' : '○'
        const dur = t.duration != null ? fmtDuration(Math.floor(t.duration / 1000)) : '-'
        const prompt = t.prompt ? escapeHtml(t.prompt.slice(0, 60)) : '-'
        return `<tr>
          <td>${escapeHtml(t.id)}</td>
          <td>${escapeHtml(t.type)}</td>
          <td>${statusIcon} ${t.status}</td>
          <td>${dur}</td>
          <td>${prompt}</td>
        </tr>`
      })
      .join('')
  } else if (bgTbody) {
    bgTbody.innerHTML = '<tr><td colspan="5"><span class="sidebar-hint">无后台任务</span></td></tr>'
  }
}

// ── Panel tab switching ──

function initPanelTabs(): void {
  document.querySelectorAll('.panel-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      // Deactivate all tabs and panels
      document.querySelectorAll('.panel-tab').forEach((t) => t.classList.remove('active'))
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'))
      // Activate selected
      tab.classList.add('active')
      const panelId = `panel-${(tab as HTMLElement).dataset.panel || ''}`
      const panel = document.getElementById(panelId)
      if (panel) panel.classList.add('active')
    })
  })
}

// ── Fetch topics ──

async function fetchTopics(): Promise<void> {
  try {
    const res = await fetch('/api/topics')
    if (!res.ok) return
    const data = await res.json() as TopicListResponse
    state.topics = data.topics || []
    state.activeTopic = data.activeName
    render()
  } catch { /* ignore */ }
}

// ── SSE ──

function connectSSE(): void {
  const evtSource = new EventSource('/events')

  evtSource.addEventListener('agent_complete', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { result?: string }
      const last = state.messages[state.messages.length - 1]
      if (last?.role === 'assistant' && last.content === '...') {
        last.content = data.result || '(done)'
        render()
      }
    } catch { /* ignore */ }
  })

  evtSource.onerror = () => { /* WS handles state */ }
}

// ── Sidebar collapse ──

// Store collapse state per section name
const COLLAPSE_KEY = 'yu:sidebar-collapse'

function loadCollapseState(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') } catch { return {} }
}

function saveCollapseState(name: string, collapsed: boolean): void {
  const s = loadCollapseState()
  s[name] = collapsed
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify(s))
}

function initSidebarCollapse(): void {
  const saved = loadCollapseState()
  document.querySelectorAll('.sidebar-section').forEach((section) => {
    const h2 = section.querySelector('h2')
    if (!h2) return
    const name = h2.textContent?.trim().replace(/\s+\d+$/, '') || ''

    // Restore saved state
    if (saved[name]) {
      section.classList.add('collapsed')
    }

    h2.addEventListener('click', () => {
      section.classList.toggle('collapsed')
      saveCollapseState(name, section.classList.contains('collapsed'))
    })
  })
}

// ── Event binding ──

// Send
sendBtn.addEventListener('click', () => {
  const text = inputEl.value
  inputEl.value = ''
  sendMessage(text)
})

inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = inputEl.value
    inputEl.value = ''
    sendMessage(text)
  }
})

// Suggestion buttons
document.querySelectorAll('.suggestion-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const cmd = (btn as HTMLElement).dataset.cmd || ''
    sendMessage(cmd)
  })
})

// Clear button
$('btn-clear').addEventListener('click', () => {
  if (state.messages.length === 0) return
  if (confirm('清空当前对话？')) clearChat()
})

// New chat button
$('btn-new').addEventListener('click', () => {
  if (state.messages.length === 0) return
  if (confirm('开始新对话？当前对话将清空。')) clearChat()
})

// ── Init ──

fetch('/api/status')
  .then((r) => r.json())
  .then((data) => applyStatus(data as StatusData))
  .catch(() => {})

fetchTopics()
connectWS()
connectSSE()
initTerminal()
initSidebarCollapse()
initPanelTabs()
inputEl.focus()

// Re-fetch topics periodically (every 10s)
setInterval(fetchTopics, 10_000)
