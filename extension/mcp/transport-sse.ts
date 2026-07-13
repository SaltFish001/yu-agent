/**
 * yu-agent — SSE MCP Transport
 *
 * 通过 HTTP SSE (Server-Sent Events) 实现 MCP JSON-RPC 通信。
 * 流程：
 *   1. 打开 SSE 连接（GET /sse）
 *   2. 服务端发送 endpoint event（POST 地址）
 *   3. 客户端向 endpoint POST JSON-RPC 消息
 *   4. 响应通过 SSE message event 推送
 *
 * 支持流式 HTTP（Streamable HTTP）：当服务器的响应包含流式内容时，
 * 通过 SSE 推送多个 message events。
 */

import { createLogger } from '../logger.js'
import type { McpTransportConfig } from '../types.js'
import { type JsonRpcMessage, McpTransport } from './transport.js'

const log = createLogger('mcp:transport-sse')

// ── 常量 ──────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT = 30_000
const SSE_RECONNECT_DELAY_MS = 3_000

// ── SSE 事件解析 ───────────────────────────────────────

interface SseEvent {
  event?: string
  data: string
  id?: string
}

/**
 * 解析 SSE 文本流。
 * SSE 格式：
 *   event: <type>\n
 *   data: <payload>\n
 *   \n
 */
function parseSseStream(text: string): { events: SseEvent[]; remainder: string } {
  const events: SseEvent[] = []
  const lines = text.split('\n')
  let currentEvent: Partial<SseEvent> = {}
  let lastLineIdx = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line === '') {
      // 空行 = event 分隔符
      if (currentEvent.data !== undefined) {
        events.push(currentEvent as SseEvent)
      }
      currentEvent = {}
      lastLineIdx = i + 1
    } else if (line.startsWith('event: ')) {
      currentEvent.event = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      const prev = currentEvent.data ?? ''
      currentEvent.data = prev + (prev ? '\n' : '') + line.slice(6)
    } else if (line.startsWith('id: ')) {
      currentEvent.id = line.slice(4).trim()
    }
    // 忽略以 : 开头的注释行和未知字段
  }

  const remainder = lines.slice(lastLineIdx).join('\n')
  return { events, remainder }
}

// ── SseTransport ────────────────────────────────────────

export class SseTransport extends McpTransport {
  /** SSE 端点 URL */
  private sseUrl: string
  /** 服务端返回的 POST 端点 URL */
  private postUrl: string | null = null
  /** SSE 读取协程 promise */
  private sseReadPromise: Promise<void> | null = null
  /** SSE AbortController */
  private sseAbort: AbortController | null = null
  /** SSE 流 reader 引用，用于在 close() 时直接取消 */
  private sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null

  /** 挂起的请求：id → { resolve, reject, timer } */
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  private _connected = false
  private _closed = false

  constructor(config: McpTransportConfig) {
    super(config)
    this.sseUrl = config.target
  }

  override async connect(): Promise<void> {
    if (this._connected) return
    if (this._closed) throw new Error('Transport already closed')

    await this.startSseConnection()
    this._connected = true
  }

  override async request(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT): Promise<unknown> {
    this.ensureConnected()

    const id = this.nextId()
    const body = { jsonrpc: '2.0', id, method, params } as const

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`JSON-RPC timeout: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      // POST 请求到 server 的 endpoint
      // 响应会通过 SSE 流推送回来
      this.postJsonRpc(body).catch((err) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  override async sendNotification(method: string, params?: unknown): Promise<void> {
    this.ensureConnected()
    const body = { jsonrpc: '2.0', method, params } as const
    await this.postJsonRpc(body)
  }

  override async sendRaw(message: JsonRpcMessage): Promise<void> {
    this.ensureConnected()
    await this.postJsonRpc(message)
  }

  override async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this._connected = false

    // 直接取消 SSE reader（比 abort 更干净，不会产生 AbortError）
    if (this.sseReader) {
      try {
        await this.sseReader.cancel()
      } catch {
        // reader 可能已关闭
      }
      this.sseReader = null
    }

    // 清理 AbortController（如果还有）
    this.sseAbort = null

    // 等待 SSE 读取协程结束
    if (this.sseReadPromise) {
      try {
        await this.sseReadPromise
      } catch {
        // 忽略残留错误
      }
      this.sseReadPromise = null
    }

    // 拒绝所有挂起请求
    this.rejectAllPending(new Error('Transport closed'))

    this.events.onClose?.()
  }

  override isConnected(): boolean {
    return this._connected && this.postUrl !== null
  }

  // ── 内部方法 ──────────────────────────────────────────

  private ensureConnected(): void {
    if (this._closed) throw new Error('Transport closed')
    if (!this._connected) throw new Error('Transport not connected')
    if (!this.postUrl) throw new Error('SSE endpoint not yet received')
  }

  /**
   * 发起 SSE 连接，等待服务端推送 endpoint event。
   */
  private async startSseConnection(): Promise<void> {
    log.info(`Connecting to SSE endpoint: ${this.sseUrl}`)

    const ac = new AbortController()
    this.sseAbort = ac

    try {
      const resp = await fetch(this.sseUrl, {
        signal: ac.signal,
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      })

      if (!resp.ok) {
        throw new Error(`SSE connection failed: HTTP ${resp.status} ${resp.statusText}`)
      }

      if (!resp.body) {
        throw new Error('SSE response body is null')
      }

      log.info('SSE connection established, waiting for endpoint event...')

      // 读取 SSE 流
      this.sseReadPromise = this.readSseStream(resp.body).catch((err) => {
        // 静默吞噬所有残留错误（如 reader.cancel 后的死信）
        if (!this._closed) {
          log.warn('SSE read stream error', err as Error)
        }
      })

      // 等待第一个 endpoint event
      await this.waitForEndpoint()
    } catch (err) {
      this._connected = false
      this.sseAbort = null
      log.error('SSE connection failed', err as Error)
      throw err
    }
  }

  /**
   * 读取 SSE 流，解析 events 并分发。
   */
  private async readSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: Bun's ReadableStreamDefaultReader type requires readMany but Web Streams API doesn't provide it
    const reader = body.getReader() as any
    this.sseReader = reader
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (!this._closed) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const { events, remainder } = parseSseStream(buffer)
        buffer = remainder

        for (const event of events) {
          this.handleSseEvent(event)
        }
      }
    } catch (err) {
      if (!this._closed) {
        log.error('SSE stream read error', err as Error)
        this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
        // 尝试重连
        if (!this._closed) {
          await this.tryReconnect()
        }
      }
    } finally {
      try {
        reader.cancel()
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * 处理单个 SSE event。
   */
  private handleSseEvent(event: SseEvent): void {
    const eventType = event.event ?? 'message'

    if (eventType === 'endpoint') {
      // endpoint event: 包含 POST 地址
      this.postUrl = event.data
      log.info(`Received SSE endpoint: ${this.postUrl}`)
      return
    }

    if (eventType === 'message') {
      try {
        const msg = JSON.parse(event.data)

        // 有 id → 请求响应
        if (msg.id != null) {
          const pending = this.pending.get(msg.id)
          if (pending) {
            clearTimeout(pending.timer)
            this.pending.delete(msg.id)

            if (msg.error) {
              pending.reject(new Error(msg.error.message || 'JSON-RPC error'))
            } else {
              pending.resolve(msg.result)
            }
          }
          return
        }

        // 无 id → 服务端推送的通知
        if (msg.method) {
          this.events.onNotification?.(msg)
        }
      } catch (err) {
        log.warn('Failed to parse SSE message', err as Error, { raw: event.data.slice(0, 200) })
      }
      return
    }

    // 其他 event 类型（如 error, metrics 等）
    log.debug(`Unhandled SSE event: ${eventType}`, { data: event.data.slice(0, 200) })
  }

  /**
   * 等待服务端推送 endpoint event。
   * 使用 Promise + 轮询方式等待 postUrl 被设置。
   */
  private async waitForEndpoint(timeoutMs = 15_000): Promise<void> {
    const start = Date.now()
    while (!this.postUrl) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timeout waiting for SSE endpoint event')
      }
      if (this._closed) {
        throw new Error('Transport closed while waiting for endpoint')
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /**
   * POST JSON-RPC 消息到服务端 endpoint。
   */
  private async postJsonRpc(body: unknown): Promise<void> {
    const url = this.postUrl ?? this.sseUrl // fallback to sseUrl if endpoint not yet received
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok && resp.status !== 202) {
      throw new Error(`POST to MCP endpoint failed: HTTP ${resp.status} ${resp.statusText}`)
    }

    // 如果响应体是 JSON（非流式响应），直接处理
    // 这发生在某些 MCP 服务器直接返回结果而不是通过 SSE 推送
    const contentType = resp.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const responseBody = (await resp.json()) as Record<string, unknown>
      if (responseBody?.id != null || responseBody?.result != null || responseBody?.error != null) {
        this.handleSseEvent({ event: 'message', data: JSON.stringify(responseBody) })
      }
    }
    // 如果响应是 text/event-stream，流式内容会在 readSseStream 中处理
    // 忽略其他响应类型
  }

  /**
   * 断线重连：指数退避重试 SSE 连接。
   */
  private async tryReconnect(): Promise<void> {
    if (this._closed) return

    log.info('Attempting SSE reconnect...')
    this._connected = false
    this.postUrl = null

    const delay = SSE_RECONNECT_DELAY_MS
    await new Promise((r) => setTimeout(r, delay))

    if (this._closed) return

    try {
      await this.startSseConnection()
      this._connected = true
      log.info('SSE reconnected successfully')
    } catch (err) {
      log.error('SSE reconnect failed', err as Error)
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
