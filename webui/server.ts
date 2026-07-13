/**
 * yu-agent — Web UI 服务器
 *
 * Hono (v4) + Bun.serve() — 纯 TypeScript。
 * - GET  /              → index.html（聊天界面）
 * - GET  /api/status    → JSON 状态快照
 * - POST /api/chat      → 发送消息，返回 AgentLoop 结果
 * - GET  /events        → SSE 状态推送（标准 EventSource 协议）
 * - GET  /ws            → WebSocket 实时状态推送（每 2s）
 */

import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { validator } from 'hono/validator'
import { z } from 'zod'

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { resolve } from 'path'

import { createLogger } from '../extension/logger.js'

const log = createLogger('webui')

// ── WebSocket Adapter ──────────────────────────────────

const { upgradeWebSocket, websocket: wsAdapters } = createBunWebSocket()

// ── Config ──────────────────────────────────────────────

const DEFAULT_PORT = parseInt(process.env.YU_WEBUI_PORT || '9876', 10)
const HOST = process.env.YU_WEBUI_HOST || '0.0.0.0'
const WS_STATUS_INTERVAL = 2_000 // 每 2 秒推送一次状态

// ── Per-client push config ──────────────────────────────

interface ClientPushConfig {
  interval: number      // 推送间隔 (ms), default WS_STATUS_INTERVAL
  channels: Set<string> // 订阅通道, default all
}
const clientConfigs = new Map<any, ClientPushConfig>()
const clientLastPush = new Map<any, number>()

// Hono's Bun WS adapter wraps each callback in a new WSContext.
// ws.raw gives the underlying Bun ServerWebSocket — use it as Map key.
function rawWs(ws: any): any {
  return ws?.raw ?? ws
}

let wsTicker: ReturnType<typeof setInterval> | null = null
const TICK_INTERVAL = 500 // 每 500ms 检查一次到期 client

// ── HTML 模板 ──────────────────────────────────────────

let _htmlCache: string | null = null

function getHtml(): string {
  if (_htmlCache) return _htmlCache

  // Try frontend/dist/index.html first (Vite build)
  const distIndex = resolve(process.cwd(), 'webui', 'frontend', 'dist', 'index.html')
  if (existsSync(distIndex)) {
    _htmlCache = readFileSync(distIndex, 'utf-8')
    return _htmlCache
  }

  const candidates = [
    import.meta.dir,
    process.cwd(),
    resolve(process.cwd(), 'webui'),
    resolve(import.meta.dir, '..'),
    resolve(import.meta.dir, '..', '..'),
  ]
  for (const dir of candidates) {
    if (!dir) continue
    const htmlPath = resolve(dir, 'demo.html')
    if (existsSync(htmlPath)) {
      _htmlCache = readFileSync(htmlPath, 'utf-8')
      return _htmlCache
    }
    const webuiPath = resolve(dir, 'webui', 'demo.html')
    if (existsSync(webuiPath)) {
      _htmlCache = readFileSync(webuiPath, 'utf-8')
      return _htmlCache
    }
  }
  return '<html><body><h1>yu-agent Web UI</h1><p>Frontend build not found. Run: cd webui/frontend && npm run build</p></body></html>'
}

export function getNotFoundHtml(path: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 — yu-agent</title>
<style>
  :root {
    --bg: #0d0d0f;
    --bg-card: #1a1a1e;
    --text: #c8c8cc;
    --text-muted: #4a4a50;
    --text-secondary: #8c8c94;
    --text-code: #5a5a62;
    --accent: #6b8aff;
    --accent-hover: #8ba4ff;
    --border: #1e1e22;
    --border-hover: #2a2a30;
    --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 24px;
    padding: 24px;
  }
  .icon { font-size: 40px; color: var(--text-muted); }
  .code { font-size: 72px; font-weight: 700; color: var(--text-muted); line-height: 1; letter-spacing: -2px; }
  .desc { font-size: 14px; color: var(--text-secondary); }
  .path {
    font-family: "SF Mono", "Fira Code", "Cascadia Code", "Consolas", monospace;
    font-size: 12px;
    color: var(--text-code);
    background: var(--bg-card);
    padding: 8px 16px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    max-width: 90vw;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  a {
    color: var(--accent);
    text-decoration: none;
    font-size: 14px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: color 0.15s;
  }
  a:hover { color: var(--accent-hover); }
</style>
</head>
<body>
<div class="icon">🎣</div>
<div class="code">404</div>
<div class="desc">页面不存在</div>
<div class="path">${escapeHtml(path)}</div>
<a href="/">← 返回首页</a>
</body>
</html>`
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── 静态文件 ──────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function serveStatic(pathname: string): Response | null {
  // Try frontend/dist first (Vite build)
  const distDir = resolve(process.cwd(), 'webui', 'frontend', 'dist')
  if (existsSync(distDir)) {
    const distFile = resolve(distDir, pathname.replace(/^\//, ''))
    if (distFile.startsWith(distDir) && existsSync(distFile)) {
      const ext = Object.keys(CONTENT_TYPES).find((e) => distFile.endsWith(e))
      if (ext) {
        const content = readFileSync(distFile)
        return new Response(content, {
          headers: {
            'Content-Type': CONTENT_TYPES[ext],
            'Cache-Control': 'no-cache',
          },
        })
      }
    }
  }

  // Try possible webui roots (source dir, cwd, project root)
  const candidates = [
    import.meta.dir,
    process.cwd(),
    resolve(process.cwd(), 'webui'),
    resolve(import.meta.dir, '..', 'webui'),
    resolve(import.meta.dir, '..', '..', 'webui'),
  ]
  for (const webuiRoot of candidates) {
    if (!webuiRoot) continue
    const requestedFile = resolve(webuiRoot, pathname.replace(/^\//, ''))
    if (!requestedFile.startsWith(webuiRoot)) continue
    if (!existsSync(requestedFile)) continue

    const ext = Object.keys(CONTENT_TYPES).find((e) => requestedFile.endsWith(e))
    if (!ext) return null

    const content = readFileSync(requestedFile)
    return new Response(content, {
      headers: {
        'Content-Type': CONTENT_TYPES[ext],
        'Cache-Control': 'no-cache',
      },
    })
  }
  return null
}

// ── SSE 客户端管理 ─────────────────────────────────────

interface SseClient {
  controller: ReadableStreamDefaultController
  id: string
}

const sseClients = new Set<SseClient>()

function broadcastSSE(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try {
      client.controller.enqueue(new TextEncoder().encode(msg))
    } catch {
      sseClients.delete(client)
    }
  }
}

// ── WebSocket 客户端管理 ───────────────────────────────

interface WsStats {
  startedAt: number
  connectionsTotal: number
  connectionsCurrent: number
  connectionsPeak: number
  messagesSent: number
}

const wsClients = new Set<any>()
const wsStats: WsStats = {
  startedAt: Date.now(),
  connectionsTotal: 0,
  connectionsCurrent: 0,
  connectionsPeak: 0,
  messagesSent: 0,
}

function broadcastWS(type: string, data: unknown): void {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() })
  wsStats.messagesSent++
  for (const ws of wsClients) {
    try {
      ws.send(msg)
    } catch {
      wsClients.delete(ws)
    }
  }
}

// ── 全量状态快照 (WS 推送所有数据) ──────────────────────

const ORCHESTRATOR_PATH = resolve(process.env.HOME || '/home/saltfish', '.yu', 'orchestrator.json')

async function getFullStatus(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    version: process.env.YU_VERSION || '0.1.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  }

  // ── WS stats ──
  result.ws = {
    connected: wsClients.size,
    total: wsStats.connectionsTotal,
    peak: wsStats.connectionsPeak,
    messagesSent: wsStats.messagesSent,
    uptimeSec: Math.floor((Date.now() - wsStats.startedAt) / 1000),
  }

  // ── Rules from orchestrator.json ──
  let rules: Array<Record<string, unknown>> = []
  if (existsSync(ORCHESTRATOR_PATH)) {
    try {
      const raw = readFileSync(ORCHESTRATOR_PATH, 'utf-8')
      const config = JSON.parse(raw)
      rules = (config.rules ?? []).map((r: Record<string, unknown>) => ({
        name: r.name,
        trigger: r.trigger ?? null,
        action: r.action ?? null,
        condition: r.condition ?? null,
      }))
    } catch { /* 忽略 */ }
  }
  result.rules = rules

  // ── Tools from registry ──
  try {
    const { listTools } = await import('../extension/tools/registry.js') as {
      listTools: () => Array<{ name: string; description: string; parameters?: { properties?: Record<string, unknown> }; enhancement?: { auth?: unknown; timeout?: number } }>
    }
    result.tools = listTools().map((t) => ({
      name: t.name,
      description: t.description || '',
      paramCount: t.parameters?.properties ? Object.keys(t.parameters.properties).length : 0,
      hasAuth: !!t.enhancement?.auth,
      timeout: t.enhancement?.timeout ?? null,
    }))
  } catch {
    result.tools = []
  }

  // ── Topics from topics.db ──
  try {
    const { list } = await import('../extension/topic.js')
    const topics = list(true) // include archived
    result.topics = topics.map((t) => ({
      name: t.name,
      dir: t.dir,
      status: t.status,
      turns: t.turns,
      summary: t.summary ? t.summary.slice(0, 200) : '',
      archived: !!t.archived,
      lastActive: t.lastActive ?? null,
      createdAt: t.createdAt ?? null,
      pid: t.pid ?? null,
    }))
    const active = topics.find((t) => t.status === 'active')
    result.activeTopic = active?.name ?? null
  } catch {
    result.topics = []
    result.activeTopic = null
  }

  // ── Event channel stats ──
  try {
    const { Database: DatabaseSync } = await import('bun:sqlite')
    const topicsDbPath = resolve(process.env.HOME || '/home/saltfish', '.yu', 'topics.db')
    if (existsSync(topicsDbPath)) {
      const evDb = new DatabaseSync(topicsDbPath)
      try {
        const totalRow = evDb.prepare('SELECT COUNT(*) AS cnt FROM events').get() as { cnt: number } | undefined
        const unackRow = evDb.prepare('SELECT COUNT(*) AS cnt FROM events WHERE acknowledged = 0').get() as { cnt: number } | undefined
        const topicsWithPending = evDb
          .prepare('SELECT DISTINCT topic_name FROM events WHERE acknowledged = 0 ORDER BY topic_name')
          .all() as Array<{ topic_name: string }>
        result.events = {
          total: totalRow?.cnt ?? 0,
          unacknowledged: unackRow?.cnt ?? 0,
          pendingTopics: topicsWithPending.map((r) => r.topic_name),
        }
      } finally {
        evDb.close()
      }
    } else {
      result.events = { total: 0, unacknowledged: 0, pendingTopics: [] }
    }
  } catch {
    result.events = { total: 0, unacknowledged: 0, pendingTopics: [] }
  }

  // ── Agent run stats ──
  try {
    const { getAgentRunStats } = await import('../extension/db.js')
    const stats = getAgentRunStats()
    result.agentStats = stats
  } catch {
    result.agentStats = null
  }

  // ── Token usage aggregate ──
  try {
    const { getTokenUsageAggregate } = await import('../extension/db.js')
    const agg = getTokenUsageAggregate()
    result.tokenUsage = agg
  } catch {
    result.tokenUsage = null
  }

  // ── Skills summary ──
  try {
    const mod = await import('../extension/skills/registry.js')
    const skills: Array<{ name: string; description?: string }> = await mod.listSkills() as any
    result.skills = skills.map((s) => ({ name: s.name, description: (s.description || '').slice(0, 100) }))
  } catch {
    result.skills = []
  }

  // ── Background tasks ──
  try {
    const { bg } = await import('../extension/background.js')
    result.backgroundTasks = bg.list().slice(0, 10).map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      prompt: t.prompt.slice(0, 80),
      duration: t.endTime ? t.endTime - t.startTime : null,
    }))
    result.bgStats = bg.stats()
  } catch {
    result.backgroundTasks = []
    result.bgStats = { active: 0, completed: 0, failed: 0 }
  }

  return result
}

// Keep getStatus() for backward compat — now delegates to getFullStatus() with limited fields
async function getStatus(): Promise<Record<string, unknown>> {
  const full = await getFullStatus()
  return {
    version: full.version,
    uptime: full.uptime,
    memory: full.memory,
    agents: full.agents ?? [],
    tools: full.tools ?? [],
    memories: full.memories ?? [],
    rules: full.rules ?? [],
    ws: full.ws,
  }
}

// ── Zod Schemas ──────────────────────────────────────────

const chatSchema = z.object({
  message: z
    .string({ message: '消息必须是字符串' })
    .min(1, '消息不能为空')
    .max(10_000, '消息过长（最多 10000 字符）')
    .transform((s) => s.trim()),
})

// ── Terminal Session Manager ─────────────────────────────

interface TerminalSession {
  proc: Bun.Subprocess
  topic: string
  cwd: string
  createdAt: number
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  errReader: ReadableStreamDefaultReader<Uint8Array> | null
  readerActive: boolean
}

const terminalSessions = new Map<string, TerminalSession>()

// ── Hono App ──────────────────────────────────────────

const app = new Hono()

// ── WebSocket ──

app.get(
  '/ws',
  upgradeWebSocket((c) => {
    // Parse per-client interval from query param
    const intervalParam = c.req.query('interval')
    const clientInterval = intervalParam ? Math.max(500, parseInt(intervalParam, 10) || WS_STATUS_INTERVAL) : WS_STATUS_INTERVAL
    return {
    onOpen(_event, ws) {
      wsClients.add(rawWs(ws))
      clientConfigs.set(rawWs(ws), { interval: clientInterval, channels: new Set() })
      clientLastPush.set(rawWs(ws), Date.now())
      wsStats.connectionsTotal++
      wsStats.connectionsCurrent = wsClients.size
      if (wsClients.size > wsStats.connectionsPeak) {
        wsStats.connectionsPeak = wsClients.size
      }
      log.info(`WS client connected (${wsClients.size} active, interval=${clientInterval}ms)`)

      // Start ticker on first client
      if (wsClients.size === 1 && !wsTicker) {
        wsTicker = setInterval(async () => {
          const full = await getFullStatus()
          const now = Date.now()
          for (const [client, cfg] of clientConfigs) {
            if (!wsClients.has(client)) {
              clientConfigs.delete(client)
              clientLastPush.delete(client)
              continue
            }
            const last = clientLastPush.get(client) ?? 0
            if (now - last >= cfg.interval) {
              clientLastPush.set(client, now)
              try {
                client.send(JSON.stringify({ type: 'status', data: full, timestamp: now }))
                wsStats.messagesSent++
              } catch {
                wsClients.delete(client)
              }
            }
          }
        }, TICK_INTERVAL)
      }

      ws.send(
        JSON.stringify({
          type: 'connected',
          data: { status: 'ok', interval: clientInterval, timestamp: Date.now() },
          timestamp: Date.now(),
        }),
      )
    },

    onMessage(event, ws) {
      try {
        const parsed = JSON.parse(event.data as string)
        switch (parsed.type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
            break
          case 'set_interval': {
            const newInterval = Math.max(500, parseInt(parsed.interval, 10) || WS_STATUS_INTERVAL)
            const cfg = clientConfigs.get(rawWs(ws))
            if (cfg) {
              cfg.interval = newInterval
              clientLastPush.set(rawWs(ws), Date.now())
              ws.send(JSON.stringify({ type: 'interval_set', data: { interval: newInterval }, timestamp: Date.now() }))
            }
            break
          }
          case 'set_channels': {
            const cfg = clientConfigs.get(rawWs(ws))
            if (cfg && Array.isArray(parsed.channels)) {
              cfg.channels = new Set(parsed.channels)
              ws.send(JSON.stringify({ type: 'channels_set', data: { channels: parsed.channels }, timestamp: Date.now() }))
            }
            break
          }
        }
      } catch { /* 忽略无法解析的消息 */ }
    },

    onClose(_event, ws) {
      wsClients.delete(rawWs(ws))
      clientConfigs.delete(rawWs(ws))
      clientLastPush.delete(rawWs(ws))
      wsStats.connectionsCurrent = wsClients.size
      log.info(`WS client disconnected (${wsClients.size} remaining)`)

      if (wsClients.size === 0 && wsTicker) {
        clearInterval(wsTicker)
        wsTicker = null
      }
    },
  }}),
)

// ── Terminal WebSocket ──

// Serve terminal page for regular GET requests (not WebSocket upgrade)
app.get('/term-ws/:topic?', async (c) => {
  const topicName = c.req.param('topic') || 'default'
  return c.html(`<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>终端 - ${topicName}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#000;color:#e8e8e8;font:14px/1.5 system-ui,sans-serif;overflow:hidden;height:100vh;display:flex;flex-direction:column}
.term-header{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#111;border-bottom:1px solid #222;font-size:13px;flex-shrink:0}
.term-header h3{font-weight:500;color:#888}
.term-header .topic{color:#e8e8e8;font-family:monospace}
#term{flex:1;padding:12px 14px;overflow-y:auto;font:13px/1.5 monospace;color:#ccc;white-space:pre-wrap;word-break:break-all}
#term .prompt{color:#4caf7d}
#term .out{color:#ccc}
#term .err{color:#ef4444}
.input-row{display:flex;border-top:1px solid #222;flex-shrink:0}
.input-row input{flex:1;background:#111;border:none;padding:10px 14px;font:13px monospace;color:#e8e8e8;outline:none}
.input-row input::placeholder{color:#555}
.input-row button{background:#222;border:none;color:#888;padding:10px 16px;cursor:pointer;font-size:13px}
.input-row button:hover{background:#333;color:#e8e8e8}
#status{padding:4px 14px;font-size:11px;color:#555;flex-shrink:0;border-top:1px solid #111}
</style></head><body>
<div class="term-header"><h3>终端 <span class="topic">${topicName}</span></h3><span id="status">连接中…</span></div>
<pre id="term"><span class="out">正在连接终端 ${topicName}…</span></pre>
<div class="input-row"><input id="input" type="text" placeholder="$ " disabled /><button id="send" disabled>发送</button></div>
<script>
(function(){var ws,term=document.getElementById('term'),inp=document.getElementById('input'),sendBtn=document.getElementById('send'),status=document.getElementById('status')
function connect(){status.textContent='连接中…'
ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/term-ws/${topicName}')
ws.onopen=function(){status.textContent='已连接';inp.disabled=false;sendBtn.disabled=false;inp.focus()}
ws.onclose=function(){status.textContent='已断开';inp.disabled=true;sendBtn.disabled=true;setTimeout(connect,3000)}
ws.onmessage=function(e){try{var msg=JSON.parse(e.data);if(msg.type==='term:init'){term.innerHTML='<span class="out">终端已就绪 (cwd: '+msg.cwd+')</span>\\n'}else if(msg.type==='term:data'){var div=document.createElement('span');div.className=msg.stream==='stderr'?'err':'out';div.textContent=msg.data;term.appendChild(div);term.scrollTop=term.scrollHeight}else if(msg.type==='term:exit'){term.innerHTML+='\\n<span class="err">进程退出 (code: '+msg.code+')</span>';inp.disabled=true;sendBtn.disabled=true}}catch(e){term.innerHTML+='<span class="err">'+e.message+'</span>'}}}
function send(){var v=inp.value.trim();if(!v)return;ws.send(JSON.stringify({type:'input',data:v+'\\n'}));inp.value=''}
inp.addEventListener('keydown',function(e){if(e.key==='Enter')send()})
sendBtn.addEventListener('click',send)
connect()})()
</script></body></html>`)
})

app.get(
  '/term-ws/:topic?',
  upgradeWebSocket((c) => {
  const topicName = c.req.param('topic') || 'default'
  return {
    async onOpen(_event, ws) {
      let cwd = process.env.HOME || '/home/saltfish'

      // Look up topic directory
      if (topicName !== 'default') {
        try {
          const { get } = await import('../extension/topic.js')
          const topic = get(topicName)
          if (topic && existsSync(topic.dir)) {
            cwd = topic.dir
          }
        } catch { /* fallback to home */ }
      }

      // Spawn bash in topic's directory
      const proc = Bun.spawn(['bash', '--norc'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          YU_TOPIC: topicName,
        },
      })

      const session: TerminalSession = {
        proc,
        topic: topicName,
        cwd,
        createdAt: Date.now(),
        reader: null,
        errReader: null,
        readerActive: true,
      }
      terminalSessions.set(topicName, session)

      log.info(`Terminal opened: topic="${topicName}" cwd="${cwd}"`)

      // Forward stdout → WS
      const reader = proc.stdout.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>
      session.reader = reader
      ;(async () => {
        try {
          while (session.readerActive) {
            const { done, value } = await reader.read()
            if (done) break
            // Send as text (UTF-8 with ANSI codes intact)
            ws.send(new TextDecoder().decode(value))
          }
        } catch { /* ignore */ } finally {
          reader.releaseLock()
        }
      })()

      // Forward stderr → WS (merged like a real terminal)
      const errReader = proc.stderr.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>
      session.errReader = errReader
      ;(async () => {
        try {
          while (session.readerActive) {
            const { done, value } = await errReader.read()
            if (done) break
            ws.send(new TextDecoder().decode(value))
          }
        } catch { /* ignore */ } finally {
          errReader.releaseLock()
        }
      })()

      // Send { topic, cwd } metadata so the frontend can label the tab
      ws.send(JSON.stringify({
        type: 'term:init',
        data: { topic: topicName, cwd, pid: proc.pid },
      }) + '\n')

      // Cleanup on process exit
      proc.exited.then((code) => {
        ws.send(JSON.stringify({
          type: 'term:exit',
          data: { code, topic: topicName },
        }) + '\n')
        try { ws.close() } catch { /* ignore */ }
      })
    },

    onMessage(event, ws) {
      const raw = event.data as string | ArrayBuffer
      const session = terminalSessions.get(topicName)
      if (!session || !session.readerActive) return

      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw)
          if (parsed.type === 'input' && typeof parsed.data === 'string') {
            ;(session.proc.stdin as any).write(new TextEncoder().encode(parsed.data))
            return
          }
          if (parsed.type === 'resize') {
            // Bun spawn doesn't support dynamic TTY resize,
            // but we set COLUMNS/ROWS for future subprocesses
            if (parsed.cols) process.env.COLUMNS = String(parsed.cols)
            if (parsed.rows) process.env.LINES = String(parsed.rows)
            return
          }
        } catch {
          // Not JSON — send as raw input
          ;(session.proc.stdin as any).write(new TextEncoder().encode(raw))
        }
      } else if (raw instanceof ArrayBuffer) {
        // Binary input (rare for terminal)
        ;(session.proc.stdin as any).write(new Uint8Array(raw))
      }
    },

    onClose() {
      const session = terminalSessions.get(topicName)
      if (session) {
        session.readerActive = false
        session.proc.kill('SIGTERM')
        setTimeout(() => {
          try { session.proc.kill('SIGKILL') } catch { /* ignore */ }
        }, 3000)
        terminalSessions.delete(topicName)
        log.info(`Terminal closed: topic="${topicName}"`)
      }
    },
  }
}),
)

// ── Terminal API: list active sessions ──

app.get('/api/terminals', (c) => {
  const sessions = Array.from(terminalSessions.entries()).map(([topic, s]) => ({
    topic,
    cwd: s.cwd,
    pid: s.proc.pid,
    uptime: Math.floor((Date.now() - s.createdAt) / 1000),
    alive: s.readerActive,
  }))
  return c.json({ sessions })
})

// ── Terminal API: kill session ──

app.delete('/api/terminals/:topic', (c) => {
  const topic = c.req.param('topic')
  const session = terminalSessions.get(topic)
  if (!session) return c.json({ error: 'Session not found' }, 404)
  try { session.proc.kill() } catch { /* already dead */ }
  terminalSessions.delete(topic)
  log.info(`Terminal killed: topic="${topic}"`)
  return c.json({ ok: true })
})

// ── SSE ──

app.get('/events', (c) => {
  const clientId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const stream = new ReadableStream({
    start(controller) {
      sseClients.add({ controller, id: clientId })
      const initMsg = `event: connected\ndata: ${JSON.stringify({ status: 'ok', clientId, timestamp: Date.now() })}\n\n`
      try {
        controller.enqueue(new TextEncoder().encode(initMsg))
      } catch { /* ignore */ }
      log.info(`SSE client connected: ${clientId}`)
    },
    cancel() {
      for (const c of sseClients) {
        if (c.id === clientId) {
          sseClients.delete(c)
          break
        }
      }
      log.info(`SSE client disconnected: ${clientId}`)
    },
  })

  return c.newResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// ── API: status (with optional ?fields= filter) ──

app.get('/api/status', async (c) => {
  const fields = c.req.query('fields')
  if (!fields) return c.json(await getStatus())

  // Field-filtered mode: only return requested fields
  const full = await getFullStatus()
  const fieldList = fields.split(',').map((f) => f.trim()).filter(Boolean)
  const filtered: Record<string, unknown> = {}
  for (const f of fieldList) {
    if (f in full) filtered[f] = full[f]
  }
  return c.json(filtered)
})

// ── API: ws stats ──

app.get('/api/ws', (c) => {
  return c.json({
    connected: wsClients.size,
    total: wsStats.connectionsTotal,
    peak: wsStats.connectionsPeak,
    messagesSent: wsStats.messagesSent,
    uptime: Math.floor((Date.now() - wsStats.startedAt) / 1000),
    startedAt: new Date(wsStats.startedAt).toISOString(),
  })
})

// ── API: ws reset stats ──

app.post('/api/ws/reset', (c) => {
  wsStats.messagesSent = 0
  wsStats.connectionsTotal = 0
  wsStats.connectionsPeak = wsClients.size
  wsStats.startedAt = Date.now()
  return c.json({ status: 'ok' })
})

// ── API: topics ──

app.get('/api/topics', async (c) => {
  try {
    const { list, getActive } = await import('../extension/topic.js')
    const topics = list(true) // include archived
    const active = getActive()
    return c.json({ topics, activeName: active?.name ?? null })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ error: msg }, 500)
  }
})

// ── API: topic detail (info + file tree + diff) ──

function walkDir(dir: string, prefix = ''): Array<{ name: string; path: string; isDir: boolean; size: number }> {
  const entries: Array<{ name: string; path: string; isDir: boolean; size: number }> = []
  try {
    const names = readdirSync(dir).sort()
    for (const name of names) {
      if (name.startsWith('.git') || name.startsWith('.') && name !== '.gitignore') continue
      const fullPath = resolve(dir, name)
      const stat = existsSync(fullPath) ? statSync(fullPath) : null
      const isDir = stat?.isDirectory() ?? false
      entries.push({ name, path: fullPath, isDir, size: stat?.size ?? 0 })
      if (isDir) {
        entries.push(...walkDir(fullPath, `${prefix}${name}/`))
      }
    }
  } catch { /* 忽略权限错误 */ }
  return entries
}

app.get('/api/topic/:name', async (c) => {
  const name = c.req.param('name')
  try {
    const { get } = await import('../extension/topic.js')
    const topic = get(name)
    if (!topic) return c.json({ error: `Topic "${name}" not found` }, 404)

    // File tree
    let files: Array<{ name: string; path: string; isDir: boolean; size: number }> = []
    if (existsSync(topic.dir)) {
      files = walkDir(topic.dir)
    }

    // Git diff
    let diff = ''
    let diffStat = ''
    let lastCommit = ''
    let hasGit = false
    const gitDir = resolve(topic.dir, '.git')
    if (existsSync(gitDir)) {
      hasGit = true
      try {
        const proc = Bun.spawnSync(['git', '-C', topic.dir, 'log', '-1', '--oneline'], { timeout: 3000 })
        lastCommit = proc.stdout.toString().trim()

        const statProc = Bun.spawnSync(['git', '-C', topic.dir, 'diff', '--stat'], { timeout: 5000 })
        diffStat = statProc.stdout.toString().trim()

        const diffProc = Bun.spawnSync(['git', '-C', topic.dir, 'diff'], { timeout: 5000 })
        diff = diffProc.stdout.toString().trim()
      } catch { /* git not available */ }
    }

    return c.json({ topic, files, git: { hasGit, lastCommit, diffStat, diff } })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ error: msg }, 500)
  }
})

// ── API: topic write operations (delete / rename / archive) ──

app.delete('/api/topic/:name', async (c) => {
  const name = c.req.param('name')
  try {
    const { deleteTopic } = await import('../extension/topic.js')
    deleteTopic(name)
    log.info(`Topic deleted: \"${name}\"`)
    return c.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ error: msg }, 500)
  }
})

app.patch('/api/topic/:name', async (c) => {
  const name = c.req.param('name')
  const body = await c.req.json()
  try {
    const { rename, archive } = await import('../extension/topic.js')
    if (body.action === 'rename' && body.newName) {
      rename(name, body.newName)
      log.info(`Topic renamed: \"${name}\" → \"${body.newName}\"`)
      return c.json({ ok: true, newName: body.newName })
    }
    if (body.action === 'archive') {
      archive(name)
      log.info(`Topic archived: \"${name}\"`)
      return c.json({ ok: true, archived: true })
    }
    return c.json({ error: 'Unknown action. Supported: rename, archive' }, 400)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ error: msg }, 500)
  }
})

// ── API: chat ──

app.post(
  '/api/chat',
  validator('json', (value, c) => {
    const parsed = chatSchema.safeParse(value)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return c.json({ error: `参数错误: ${first.message}` }, 400)
    }
    return parsed.data
  }),
  async (c) => {
    const { message } = c.req.valid('json')

    log.info(`Chat request: "${message.slice(0, 100)}"`)

    broadcastWS('chat:start', { message })

    const { runAgent } = await import('../extension/agent-loop.js')
    const raw = await runAgent(message, { maxIterations: 20 })
    const result = raw ?? {
      success: false,
      output: '(AgentLoop returned no result — check API key configuration)',
      iterations: 0,
      totalTokens: 0,
    }

    broadcastSSE('agent_complete', {
      id: Date.now().toString(),
      result: result.output,
      iterations: result.iterations,
    })

    broadcastWS('chat:complete', {
      result: result.output,
      iterations: result.iterations,
      totalTokens: result.totalTokens,
    })

    log.info(`Chat completed: ${result.iterations} iters, ${result.totalTokens} tokens`)
    return c.json(result)
  },
)

// ── API: chat stream (SSE) ──

app.post(
  '/api/chat/stream',
  validator('json', (value, c) => {
    const parsed = chatSchema.safeParse(value)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return c.json({ error: `参数错误: ${first.message}` }, 400)
    }
    return parsed.data
  }),
  async (c) => {
    const { message } = c.req.valid('json')

    const stream = new ReadableStream({
      async start(controller) {
        const enc = (text: string) => {
          try {
            controller.enqueue(new TextEncoder().encode(text))
          } catch { /* stream closed */ }
        }

        // 发送开始事件
        enc(`event: start\ndata: ${JSON.stringify({ message, timestamp: Date.now() })}\n\n`)

        // ── 全量走 scheduler（LLM 分类比正则准确）──
        // 不在这里做正则匹配——scheduler 用 DeepSeek 判断意图
        const trimmed = message.trim()
        if (!trimmed) {
          enc(`event: error\ndata: ${JSON.stringify({ error: 'empty message' })}\n\n`)
          enc('data: [DONE]\n\n')
          try { controller.close() } catch { /* already closed */ }
          return
        }
        const isChat = false // 所有输入走 AgentLoop，由 scheduler 分类

        if (isChat) {
          // 走 chat 模式：一次 LLM 调用，无工具循环
          try {
            const { readFileSync, existsSync } = await import('fs')
            const { resolve } = await import('path')
            const chatPromptPath = resolve(process.env.HOME || '/home/saltfish', '.yu', 'prompts', 'chat.md')
            const chatPrompt = existsSync(chatPromptPath) ? readFileSync(chatPromptPath, 'utf-8') : '你是一个友好的聊天助手，简洁直接地回答用户。'

            const { chatCompletion } = await import('../extension/provider.js')
            const result = await chatCompletion({
              messages: [
                { role: 'system', content: chatPrompt },
                { role: 'user', content: trimmed },
              ],
              max_tokens: 1024,
              temperature: 0.7,
            })

            const output = result?.content ?? '嗯？'
            const reasoning = result?.reasoning_content
            // 真正的推理链来自 reasoning_content
            if (reasoning) {
              enc(`event: thinking\ndata: ${JSON.stringify({ content: reasoning })}\n\n`)
            }
            // 最终回复来自 content
            if (output) {
              const CHUNK_SIZE = 20
              for (let i = 0; i < output.length; i += CHUNK_SIZE) {
                const chunk = output.slice(i, i + CHUNK_SIZE)
                enc(`event: text\ndata: ${JSON.stringify({ output: chunk })}\n\n`)
              }
            }
            enc(`event: done\ndata: ${JSON.stringify({ iterations: 0, totalTokens: result?.usage?.total_tokens ?? 0 })}\n\n`)
            enc('data: [DONE]\n\n')
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            enc(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`)
            enc('data: [DONE]\n\n')
          } finally {
            try { controller.close() } catch { /* already closed */ }
          }
          return // 不走 AgentLoop
        }

        // ── 编程任务：后台运行 agent，实时推送事件 ──
        const runPromise = (async () => {
          try {
            // Parse /goal command
            let taskMessage = message
            let goalCondition: string | null = null
            const goalMatch = message.match(/^\/goal\s+(.+)/i)
            if (goalMatch) {
              goalCondition = goalMatch[1].trim()
              taskMessage = goalCondition // the goal IS the task
            }

            const { AgentLoop } = await import('../extension/agent-loop.js')
            // /goal 任务使用 coding agent system prompt
            let systemPrompt: string | undefined
            if (goalCondition) {
              try {
                const { readFileSync, existsSync } = await import('fs')
                const { resolve } = await import('path')
                const codingPromptPath = resolve(process.env.HOME || '/home/saltfish', '.yu', 'prompts', 'coding.md')
                if (existsSync(codingPromptPath)) {
                  systemPrompt = readFileSync(codingPromptPath, 'utf-8')
                }
              } catch {
                /* fallback to default */
              }
            }
            const agent = new AgentLoop({
              systemPrompt,
              maxIterations: 20,
              tokenBudget: 40000, // ~$0.10 max per task
              onEvent: (event) => {
                // Include iteration & token info in every event payload
                const data = {
                  ...(typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}),
                  _iteration: event.iteration,
                  _totalTokens: agent['totalTokensUsed'] ?? 0,
                }
                const payload = JSON.stringify(data)
                enc(`event: ${event.type}\ndata: ${payload}\n\n`)
              },
              ...(goalCondition ? {
                stopCondition: async (ctx) => {
                  const lastMsg = ctx.getLastMessage()
                  if (!lastMsg || !lastMsg.content) {
                    return { met: false, reason: 'no output yet' }
                  }
                  // 用一次轻量 LLM 调用来判断目标是否达成
                  try {
                    const { chatCompletion } = await import('../extension/provider.js')
                    const result = await chatCompletion({
                      messages: [
                        { role: 'system', content: `You are a goal evaluator. Determine if the following goal has been achieved based on the conversation. Respond with exactly one word: YES or NO.\n\nGoal: ${goalCondition}` },
                        { role: 'user', content: `Latest output from the agent:\n\n${lastMsg.content.slice(0, 2000)}` },
                      ],
                      max_tokens: 10,
                      temperature: 0,
                    })
                    const answer = result?.content?.trim().toUpperCase() ?? ''
                    if (answer.startsWith('Y') || answer.includes('YES')) {
                      return { met: true, reason: goalCondition }
                    }
                    return { met: false, reason: 'continue' }
                  } catch {
                    return { met: false, reason: 'evaluator error, continuing' }
                  }
                },
              } : {}),
            })

            const raw = await agent.run(taskMessage)
            const result = raw ?? {
              success: false,
              output: '(Agent returned no result)',
              iterations: 0,
              totalTokens: 0,
            }

            // 发送最终文本输出
            const output = typeof result.output === 'string' ? result.output : JSON.stringify(result)
            enc(`event: text\ndata: ${JSON.stringify({ output })}\n\n`)

            enc(`event: done\ndata: ${JSON.stringify({ iterations: result.iterations, totalTokens: result.totalTokens })}\n\n`)
            enc('data: [DONE]\n\n')
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            enc(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`)
            enc('data: [DONE]\n\n')
          } finally {
            try { controller.close() } catch { /* already closed */ }
          }
        })()

        // start 函数不 await runPromise，立即返回
        // 流在后台持续推送
      },
    })

    return c.newResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  },
)

// ── 首页 ──

app.get('/', (c) =>
  c.newResponse(getHtml(), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  }),
)

// ── 静态文件 ──

app.get('/assets/*', (c) => {
  const res = serveStatic(c.req.path)
  if (res) return res
  // 文件不存在（hash changed）→ 返回 index.html 让浏览器重新加载
  return c.newResponse(getHtml(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
})

// ── API: config (P1.8) ────────────────────────────────

const serverConfig: Record<string, unknown> = {}

app.post('/api/config', async (c) => {
  try {
    const body = await c.req.json()
    Object.assign(serverConfig, body)
    log.info(`Config updated: ${JSON.stringify(body)}`)
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 400)
  }
})

app.get('/api/config', (c) => {
  return c.json(serverConfig)
})

// ── SPA fallback: 非 API 路由返回 index.html ──

app.get('/*', (c) => {
  const path = c.req.path
  // API routes and WS should already be matched before this
  if (path.startsWith('/api/') || path.startsWith('/ws') || path.startsWith('/events') || path.startsWith('/term-ws')) {
    return c.notFound()
  }
  // Check for actual file first (favicon, etc.)
  const fileRes = serveStatic(path)
  if (fileRes) return fileRes
  // Serve index.html for SPA routing
  return c.newResponse(getHtml(), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
})

// ── 未匹配 404 ──

app.notFound((c) => {
  const body = getNotFoundHtml(c.req.path)
  return c.newResponse(body, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// ── Server ──────────────────────────────────────────────

export async function createServer(port?: number): Promise<ReturnType<typeof Bun.serve>> {
  const activePort = port ?? DEFAULT_PORT
  log.info(`Starting Web UI server on ${HOST}:${activePort}`)

  const server = Bun.serve({
    hostname: HOST,
    port: activePort,
    fetch: app.fetch,
    websocket: wsAdapters,
  })

  log.info(`Web UI ready at http://${HOST}:${activePort}`)

  // ── Wire EventBus → WebSocket broadcast ──
  try {
    const { eventBus } = await import('../extension/events.js')
    const unsubCompleted = eventBus.on('task.completed', (event) => {
      broadcastWS('task.completed', event.payload)
    })
    const unsubFailed = eventBus.on('task.failed', (event) => {
      broadcastWS('task.failed', event.payload)
    })
    const unsubStarted = eventBus.on('task.started', (event) => {
      broadcastWS('task.started', event.payload)
    })
    const unsubAgentStarted = eventBus.on('agent.started', (event) => {
      broadcastWS('agent.started', event.payload)
    })
    const unsubAgentCompleted = eventBus.on('agent.completed', (event) => {
      broadcastWS('agent.completed', event.payload)
    })
    const unsubAgentError = eventBus.on('agent.error', (event) => {
      broadcastWS('agent.error', event.payload)
    })
    // Clean up on server shutdown
    const origStop: (() => void) | undefined = server.stop?.bind(server)
    ;(server as unknown as Record<string, unknown>).stop = () => {
      unsubCompleted()
      unsubFailed()
      unsubStarted()
      unsubAgentStarted()
      unsubAgentCompleted()
      unsubAgentError()
      return origStop?.()
    }
    log.info('EventBus → WebSocket bridge active')
  } catch {
    log.warn('EventBus bridge not available (events.ts not loaded)')
  }

  return server
}

// ── 直接运行 ─────────────────────────────────────────────

if (process.argv[1]?.includes('server')) {
  await createServer()
  console.log(`\n  🎣 yu-agent Web UI`)
  console.log(`  ─────────────────────`)
  console.log(`  → http://localhost:${DEFAULT_PORT}\n`)
}
