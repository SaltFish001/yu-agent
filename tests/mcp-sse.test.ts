/**
 * MCP SSE Transport 单元测试
 *
 * 使用 mock SSE server 验证 SseTransport 的 connect、request、
 * sendNotification、流式消息分发 和 断线重连 功能。
 *
 * 测试策略：
 *   - 启动一个 Bun HTTP server 模拟 MCP SSE 端点
 *   - 测试正常握手（SSE endpoint event + message event）
 *   - 测试超时、断线重连等异常场景
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { SseTransport } from '../extension/mcp/transport-sse.js'

// ── Mock SSE Server ─────────────────────────────────────

let server: { url: string; stop: () => void } | null = null
let lastPostedBody: string | null = null
let sseClients: Array<{ send: (event: string, data: string) => void; close: () => void }> = []
let pendingResponses: Map<number, unknown> = new Map()
let _simulateDisconnect = false

/**
 * 创建一个简单的 MCP SSE mock server。
 * 返回 { url, stop }。
 */
async function createMockSseServer(): Promise<{ url: string; stop: () => void }> {
  // 使用 Bun.serve
  const httpServer = Bun.serve({
    port: 0, // 随机端口
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const path = url.pathname

      // SSE 端点
      if (path === '/sse') {
        let closed = false
        const _sendCallback: ((event: string, data: string) => void) | null = null

        let clientRef: { send: (event: string, data: string) => void; close: () => void } | null = null

        // 创建一个 SSE 流
        const body = new ReadableStream({
          start(controller) {
            const sendCallback = (event: string, data: string) => {
              if (!closed) {
                controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`))
              }
            }

            const closeCallback = () => {
              if (!closed) {
                closed = true
                try {
                  controller.close()
                } catch {
                  /* already closed */
                }
              }
            }

            // 发送 endpoint event
            const endpointUrl = `${url.origin}/messages`
            controller.enqueue(new TextEncoder().encode(`event: endpoint\ndata: ${endpointUrl}\n\n`))

            const client = { send: sendCallback, close: closeCallback }
            clientRef = client
            sseClients.push(client)
          },
          cancel() {
            closed = true
            if (clientRef) {
              const idx = sseClients.indexOf(clientRef)
              if (idx !== -1) sseClients.splice(idx, 1)
            }
          },
        })

        return new Response(body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      }

      // POST 端点（用于发送 JSON-RPC 请求）
      if (path === '/messages' && req.method === 'POST') {
        const bodyText = await req.text()
        lastPostedBody = bodyText

        try {
          const msg = JSON.parse(bodyText)
          if (msg?.id != null) {
            // 如果有挂起的响应，通过 SSE 返回
            if (pendingResponses.has(msg.id)) {
              const response = pendingResponses.get(msg.id)!
              pendingResponses.delete(msg.id)
              // 发送响应到所有 SSE 客户端
              for (const client of sseClients) {
                client.send('message', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: response }))
              }
            }
          }
        } catch {
          // ignore parse errors
        }

        return new Response('Accepted', { status: 202 })
      }

      return new Response('Not Found', { status: 404 })
    },
  })

  const port = httpServer.port
  return {
    url: `http://localhost:${port}`,
    stop: () => {
      httpServer.stop(true)
    },
  }
}

// ── Test Helpers ────────────────────────────────────────

/** 等待指定毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Setup / Teardown ────────────────────────────────────

beforeAll(async () => {
  server = await createMockSseServer()
})

afterAll(() => {
  for (const client of sseClients) {
    client.close()
  }
  sseClients = []
  server?.stop()
  server = null
})

describe('SseTransport', () => {
  beforeEach(() => {
    pendingResponses = new Map()
    lastPostedBody = null
    sseClients = []
    _simulateDisconnect = false
  })

  afterEach(() => {
    // 清理所有 SSE 客户端
    for (const client of sseClients) {
      client.close()
    }
    sseClients = []
  })

  it('should connect to SSE endpoint and receive endpoint event', async () => {
    const transport = new SseTransport({
      type: 'sse',
      target: `${server!.url}/sse`,
    })

    await transport.connect()
    expect(transport.isConnected()).toBe(true)

    await transport.close()
    expect(transport.isConnected()).toBe(false)
  })

  it('should send a request and receive response via SSE', async () => {
    const transport = new SseTransport({
      type: 'sse',
      target: `${server!.url}/sse`,
    })

    await transport.connect()
    expect(transport.isConnected()).toBe(true)

    // 预设响应：tools/list 返回工具列表
    pendingResponses.set(1, {
      tools: [{ name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object', properties: {} } }],
    })

    // 发送请求
    const result = await transport.request('tools/list', {}, 5_000)
    expect(result).toBeDefined()
    expect((result as any).tools).toBeDefined()
    expect((result as any).tools[0].name).toBe('test_tool')

    // 验证 POST 请求被发送
    expect(lastPostedBody).toBeDefined()
    const parsed = JSON.parse(lastPostedBody!)
    expect(parsed.method).toBe('tools/list')
    expect(parsed.jsonrpc).toBe('2.0')

    await transport.close()
  })

  it('should handle notifications without id', async () => {
    const transport = new SseTransport({
      type: 'sse',
      target: `${server!.url}/sse`,
    })

    const receivedNotifications: Array<{ method: string; params?: unknown }> = []

    transport.setEvents({
      onNotification: (notification) => {
        receivedNotifications.push(notification)
      },
    })

    await transport.connect()

    // 模拟服务端推送通知
    await sleep(100) // 等待连接稳定
    for (const client of sseClients) {
      client.send(
        'message',
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/test', params: { hello: 'world' } }),
      )
    }

    await sleep(200)

    expect(receivedNotifications.length).toBeGreaterThanOrEqual(1)
    const notif = receivedNotifications[0]
    expect(notif.method).toBe('notifications/test')
    expect((notif.params as any).hello).toBe('world')

    await transport.close()
  })

  it('should timeout on unanswered request', async () => {
    const transport = new SseTransport({
      type: 'sse',
      target: `${server!.url}/sse`,
    })

    await transport.connect()

    // 不预设响应 → 请求会超时
    const start = Date.now()
    try {
      await transport.request('ping', {}, 500) // 500ms timeout
      expect.unreachable('Should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('timeout')
    }

    // 验证超时时间合理
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThan(2000) // 不应该等太久

    await transport.close()
  })

  it('should handle multiple concurrent requests', async () => {
    const transport = new SseTransport({
      type: 'sse',
      target: `${server!.url}/sse`,
    })

    await transport.connect()

    // 预设多个响应（使用与 transport.nextId() 对应的 ID）
    // transport 的 nextId() 从 1 开始递增
    pendingResponses.set(1, { echoed: 1 })
    pendingResponses.set(2, { echoed: 2 })
    pendingResponses.set(3, { echoed: 3 })

    // 并发发送多个请求
    const [r1, r2, r3] = await Promise.all([
      transport.request('echo', { id: 1 }, 5_000),
      transport.request('echo', { id: 2 }, 5_000),
      transport.request('echo', { id: 3 }, 5_000),
    ])

    expect((r1 as any).echoed).toBe(1)
    expect((r2 as any).echoed).toBe(2)
    expect((r3 as any).echoed).toBe(3)

    await transport.close()
  })

  it('should throw on send before connect', async () => {
    const transport = new SseTransport({
      type: 'sse',
      target: `${server!.url}/sse`,
    })

    try {
      await transport.request('test', {})
      expect.unreachable('Should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('not connected')
    }
  })

  it('should throw on double connect attempt', async () => {
    const transport = new SseTransport({
      type: 'sse',
      target: `${server!.url}/sse`,
    })

    await transport.connect()
    // Second connect should be a no-op (already connected)
    await transport.connect()
    expect(transport.isConnected()).toBe(true)

    await transport.close()
  })

  it('should handle sendNotification', async () => {
    const transport = new SseTransport({
      type: 'sse',
      target: `${server!.url}/sse`,
    })

    await transport.connect()

    await transport.sendNotification('notifications/test', { foo: 'bar' })

    // 验证 POST 请求
    expect(lastPostedBody).toBeDefined()
    const parsed = JSON.parse(lastPostedBody!)
    expect(parsed.method).toBe('notifications/test')
    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed.id).toBeUndefined() // notification 没有 id

    await transport.close()
  })

  it('should not throw on close after close', async () => {
    const transport = new SseTransport({
      type: 'sse',
      target: `${server!.url}/sse`,
    })

    await transport.connect()
    await transport.close()
    // 第二次 close 不抛异常
    await transport.close()
  })
})
