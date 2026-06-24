/**
 * yu-agent — MCP Resources 协议实现
 *
 * 通过 Transport 发送 resources/list 和 resources/read 请求。
 * Resources 是 MCP 协议的核心能力之一，允许客户端发现和读取
 * 服务端暴露的各类资源（文件、数据、API 等）。
 */

import { createLogger } from '../logger.js'
import { McpTransport } from './transport.js'

const log = createLogger('mcp:resources')

// ── MCP Resources 类型 ─────────────────────────────────

/** 资源描述（标准 MCP Resource 类型） */
export interface McpResource {
  /** 资源 URI（如 file:///path, api://endpoint） */
  uri: string
  /** 资源名称 */
  name: string
  /** 资源描述 */
  description?: string
  /** MIME 类型 */
  mimeType?: string
  /** 资源元数据 */
  annotations?: Record<string, unknown>
}

/** 资源内容 */
export interface McpResourceContents {
  /** 资源 URI */
  uri: string
  /** MIME 类型 */
  mimeType?: string
  /** 文本内容 */
  text?: string
  /** 二进制内容（Base64 编码） */
  blob?: string
}

/** resources/list 响应 */
export interface ResourcesListResult {
  resources: McpResource[]
}

/** resources/read 响应 */
export interface ResourcesReadResult {
  contents: McpResourceContents[]
}

// ── Resources API ──────────────────────────────────────

/**
 * 列出 MCP server 暴露的所有资源。
 * @param transport 已连接的 Transport 实例
 * @param timeoutMs 超时时间
 */
export async function listResources(
  transport: McpTransport,
  timeoutMs = 15_000,
): Promise<McpResource[]> {
  const result = (await transport.request('resources/list', {}, timeoutMs)) as ResourcesListResult | null
  if (!result || !Array.isArray(result.resources)) {
    log.warn('resources/list returned unexpected result', { result })
    return []
  }
  return result.resources
}

/**
 * 读取指定的资源。
 * @param transport 已连接的 Transport 实例
 * @param uri 资源 URI
 * @param timeoutMs 超时时间
 */
export async function readResource(
  transport: McpTransport,
  uri: string,
  timeoutMs = 15_000,
): Promise<McpResourceContents[]> {
  const result = (await transport.request('resources/read', { uri }, timeoutMs)) as ResourcesReadResult | null
  if (!result || !Array.isArray(result.contents)) {
    log.warn('resources/read returned unexpected result', { uri, result })
    return []
  }
  return result.contents
}

/**
 * 订阅资源变更通知。
 * @param transport 已连接的 Transport 实例
 * @param uri 资源 URI
 */
export async function subscribeResource(
  transport: McpTransport,
  uri: string,
): Promise<void> {
  await transport.request('resources/subscribe', { uri }, 10_000)
}

/**
 * 取消订阅资源变更通知。
 * @param transport 已连接的 Transport 实例
 * @param uri 资源 URI
 */
export async function unsubscribeResource(
  transport: McpTransport,
  uri: string,
): Promise<void> {
  await transport.sendNotification('notifications/resources/unsubscribe', { uri })
}

/**
 * 将资源内容转换为文本（自动处理 text 和 blob）。
 */
export function resourceContentsAsText(contents: McpResourceContents): string {
  if (contents.text !== undefined) return contents.text
  if (contents.blob !== undefined) {
    // Base64 解码
    try {
      const decoded = atob(contents.blob)
      return decoded
    } catch {
      return `[base64: ${contents.blob.slice(0, 100)}...]`
    }
  }
  return '(empty content)'
}
