/**
 * yu-agent — Stdio MCP Transport
 *
 * 通过子进程 stdin/stdout 实现 MCP JSON-RPC 通信。
 * 封装 Bun.spawn() + Line-delimited JSON 读写。
 */

import { createLogger } from '../logger.js'
import { McpTransport, type JsonRpcMessage } from './transport.js'
import type { McpTransportConfig } from '../types.js'

const log = createLogger('mcp:transport-stdio')

// ── 常量 ──────────────────────────────────────────────

const DEFAULT_RESPONSE_TIMEOUT = 10_000
const MAX_BUFFER_LINES = 10_000

// ── StdioTransport ────────────────────────────────────

export class StdioTransport extends McpTransport {
  private proc: Bun.Subprocess | null = null
  private _connected = false
  private _closed = false

  /** 挂起的请求：id → { resolve, reject, timer } */
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  /** 行读取协程的 abort 控制器 */
  private readAbort: AbortController | null = null

  constructor(config: McpTransportConfig) {
    super(config)
  }

  override async connect(): Promise<void> {
    if (this._connected) return
    if (this._closed) throw new Error('Transport already closed')

    const { target, args: rawArgs, env: rawEnv } = this.config
    if (!target) throw new Error('StdioTransport requires a command')

    const args = rawArgs ?? []
    const env = { ...process.env, ...(rawEnv ?? {}) } as Record<string, string>

    log.info(`Spawning MCP server: ${target} ${args.join(' ')}`)

    this.proc = Bun.spawn([target, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })

    // 丢弃 stderr（MCP server 可能向 stderr 输出日志）
    this.discardStderr()

    // 启动行读取协程
    this.startLineReader()

    this._connected = true

    // 监听进程退出
    this.proc.exited
      .then((code) => {
        log.warn(`MCP subprocess exited (code=${code})`)
        this._connected = false
        if (!this._closed) {
          this._closed = true
          this.rejectAllPending(new Error(`Process exited (code=${code})`))
          this.events.onClose?.()
        }
      })
      .catch(() => {
        // process spawn error handled below
      })
  }

  override async request(method: string, params?: unknown, timeoutMs = DEFAULT_RESPONSE_TIMEOUT): Promise<unknown> {
    this.ensureConnected()

    const id = this.nextId()
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`JSON-RPC timeout: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      this.writeToStdin(body).catch((err) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  override async sendNotification(method: string, params?: unknown): Promise<void> {
    this.ensureConnected()
    const body = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'
    await this.writeToStdin(body)
  }

  override async sendRaw(message: JsonRpcMessage): Promise<void> {
    this.ensureConnected()
    const body = JSON.stringify(message) + '\n'
    await this.writeToStdin(body)
  }

  override async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this._connected = false

    this.readAbort?.abort()

    this.rejectAllPending(new Error('Transport closed'))

    if (this.proc) {
      try {
        this.proc.kill()
      } catch {
        // ignore
      }
      this.proc = null
    }

    this.events.onClose?.()
  }

  override isConnected(): boolean {
    return this._connected && this.proc !== null && this.proc.exitCode === null
  }

  // ── 内部方法 ──────────────────────────────────────────

  private ensureConnected(): void {
    if (this._closed) throw new Error('Transport closed')
    if (!this._connected || !this.proc) throw new Error('Transport not connected')
    if (this.proc.exitCode !== null) {
      this._connected = false
      throw new Error('Process already exited')
    }
  }

  private async writeToStdin(data: string): Promise<void> {
    const proc = this.proc
    if (!proc?.stdin) throw new Error('stdin not available')

    const writer = (proc.stdin as unknown as WritableStream).getWriter()
    try {
      await writer.write(new TextEncoder().encode(data))
    } finally {
      writer.releaseLock()
    }
  }

  private startLineReader(): void {
    const proc = this.proc
    if (!proc?.stdout) return

    this.readAbort = new AbortController()
    const reader = (proc.stdout as unknown as ReadableStream).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let lineCount = 0

    const readLoop = async () => {
      try {
        while (!this._closed) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')

          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i].trim()
            if (!line) continue

            lineCount++
            if (lineCount > MAX_BUFFER_LINES) {
              log.warn('Line buffer overflow, discarding old lines')
              lineCount = 0
            }

            try {
              this.handleMessage(JSON.parse(line))
            } catch (parseErr) {
              log.warn('Failed to parse MCP message', parseErr as Error, { raw: line.slice(0, 200) })
            }
          }
          buffer = lines[lines.length - 1] || ''
        }
      } catch (err) {
        if (!this._closed) {
          log.error('Line reader error', err as Error)
          this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
        }
      } finally {
        try {
          reader.cancel()
        } catch {
          /* best effort */
        }
      }
    }

    readLoop()
  }

  private handleMessage(msg: any): void {
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
      this.events.onNotification?.(msg as any)
    }
  }

  private discardStderr(): void {
    const stderr = this.proc?.stderr
    if (!stderr || typeof stderr === 'number') return
    ;(async () => {
      try {
        const reader = (stderr as ReadableStream<Uint8Array>).getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      } catch {
        /* discard */
      }
    })()
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
