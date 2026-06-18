/**
 * yu-agent — MCP Transport 抽象接口。
 *
 * 定义统一的传输层抽象，支持 stdio 和 SSE 两种传输方式。
 * 每个 Transport 实例管理一个 MCP server 的连接生命周���。
 */

import type { McpTransportConfig } from '../types.js'

// ── JSON-RPC 核心类型 ─────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number | string
  result: unknown
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: number | string | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError

// ── Transport 抽象 ─────────────────────────────────────

export interface McpTransportEvents {
  /** 收到服务端推送的通知（无 id 的 JSON-RPC 消息） */
  onNotification?: (notification: JsonRpcNotification) => void
  /** 传输层关闭 */
  onClose?: () => void
  /** 传输层发生错误 */
  onError?: (error: Error) => void
}

export abstract class McpTransport {
  /** 传输配置 */
  protected config: McpTransportConfig
  /** 事件回调 */
  protected events: McpTransportEvents = {}

  constructor(config: McpTransportConfig) {
    this.config = config
  }

  /** 建立连接 */
  abstract connect(): Promise<void>

  /**
   * 发送 JSON-RPC 请求并等待响应。
   * @param method 方法名
   * @param params 参数
   * @param timeoutMs 超时时间（毫秒）
   */
  abstract request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>

  /**
   * 发送 JSON-RPC 通知（无需响应）。
   * @param method 方法名
   * @param params 参数
   */
  abstract sendNotification(method: string, params?: unknown): Promise<void>

  /**
   * 发送原始 JSON-RPC 消息（用于流式场景）。
   * @param message JSON-RPC 消息
   */
  abstract sendRaw(message: JsonRpcMessage): Promise<void>

  /** 关闭连接 */
  abstract close(): Promise<void>

  /** 当前连接状态 */
  abstract isConnected(): boolean

  /** 注册事件回调 */
  setEvents(events: McpTransportEvents): void {
    this.events = events
  }

  /** 生成递增消息 ID */
  protected _nextId = 0
  protected nextId(): number {
    return ++this._nextId
  }

  /**
   * 工厂方法：根据配置创建 Transport 实例。
   */
  static create(config: McpTransportConfig): McpTransport {
    if (config.type === 'sse') {
      const { SseTransport } = require('./transport-sse.js') as typeof import('./transport-sse.js')
      return new SseTransport(config)
    }
    const { StdioTransport } = require('./transport-stdio.js') as typeof import('./transport-stdio.js')
    return new StdioTransport(config)
  }
}
