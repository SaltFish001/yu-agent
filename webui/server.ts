/**
 * yu-agent — Web UI 服务器
 *
 * Bun.serve() 启动 HTTP 服务（默认端口 9876）。
 * - GET  /              → index.html（聊天界面）
 * - GET  /api/status    → JSON 状态快照
 * - POST /api/chat      → 发送消息，返回 AgentLoop 结果
 * - GET  /events        → SSE 状态推送（agent 启停等）
 *
 * Phase 3 接入 yu bootstrap。
 */

import { createLogger } from '../extension/logger.js'

const log = createLogger('webui')

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

// ── Config ──────────────────────────────────────────────

const PORT = parseInt(process.env.YU_WEBUI_PORT || '9876', 10)
const HOST = process.env.YU_WEBUI_HOST || '0.0.0.0'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')

// ── HTML 模板（内嵌防止 CDN 断线） ────────────────────────

let _htmlCache: string | null = null

function getHtml(): string {
  if (_htmlCache) return _htmlCache
  const htmlPath = resolve(__dirname, '..', '..', 'webui', 'demo.html')
  if (existsSync(htmlPath)) {
    _htmlCache = readFileSync(htmlPath, 'utf-8')
    return _htmlCache
  }
  return '<html><body><h1>yu-agent Web UI</h1><p>demo.html not found</p></body></html>'
}

// ── SSE 客户端管理 ───────────────────────────────────────

const sseClients = new Set<Bun.ServerWebSocket<unknown>>()

function broadcastSSE(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const ws of sseClients) {
    try {
      ws.send(msg)
    } catch {
      sseClients.delete(ws)
    }
  }
}

// ── 状态快照 ─────────────────────────────────────────────

function getStatus(): Record<string, unknown> {
  return {
    version: process.env.YU_VERSION || '0.1.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    agents: [],
    session: {
      id: process.env.YU_SESSION_ID || '(none)',
      active: false,
    },
  }
}

// ── Server ──────────────────────────────────────────────

export function createServer(): ReturnType<typeof Bun.serve> {
  log.info(`Starting Web UI server on ${HOST}:${PORT}`)

  const server = Bun.serve({
    hostname: HOST,
    port: PORT,

    // HTTP handler
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const path = url.pathname

      // ── SSE endpoint ──
      if (path === '/events') {
        // SSE via WebSocket upgrade (Bun's approach)
        const upgraded = server.upgrade(req)
        if (!upgraded) {
          return new Response('SSE upgrade failed', { status: 426 })
        }
        return new Response() // upgrade handles it
      }

      // ── API: status ──
      if (path === '/api/status') {
        return new Response(JSON.stringify(getStatus(), null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
      }

      // ── API: chat ──
      if (path === '/api/chat' && req.method === 'POST') {
        try {
          const body = (await req.json()) as { message?: string }
          const userMessage = body?.message?.trim()
          if (!userMessage) {
            return new Response(JSON.stringify({ error: 'Empty message' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            })
          }

          log.info(`Chat request: "${userMessage.slice(0, 100)}"`)

          // TODO Phase 3.2: Connect to AgentLoop
          // For now, return a mock response
          const result = {
            success: true,
            output: `[mock] Received: "${userMessage}"\n\nWeb UI chat is wired up. AgentLoop integration is pending the Pi SDK removal step.`,
            iterations: 1,
            totalTokens: 0,
          }

          // Broadcast via SSE
          broadcastSSE('agent_complete', {
            id: Date.now().toString(),
            result: result.output,
          })

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }

      // ── Static files ──
      if (path === '/' || path === '/index.html') {
        return new Response(getHtml(), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        })
      }

      return new Response('Not Found', { status: 404 })
    },

    // WebSocket handler (SSE)
    websocket: {
      open(ws) {
        sseClients.add(ws)
        // Send initial state
        ws.send(`event: connected\ndata: ${JSON.stringify({ status: 'ok', timestamp: Date.now() })}\n\n`)
        log.info('SSE client connected')
      },
      close(ws) {
        sseClients.delete(ws)
        log.info('SSE client disconnected')
      },
      message(_ws, _msg) {
        // SSE clients don't send data, just receive
      },
    },
  })

  log.info(`Web UI ready at http://${HOST}:${PORT}`)
  return server
}

// ── 直接运行 ─────────────────────────────────────────────

if (process.argv[1]?.includes('server')) {
  createServer()
  console.log(`\n  🎣 yu-agent Web UI`)
  console.log(`  ─────────────────────`)
  console.log(`  → http://localhost:${PORT}\n`)
}
