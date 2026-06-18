/**
 * yu-agent — MCP Prompts 协议实现
 *
 * 通过 Transport 发送 prompts/list 和 prompts/get 请求。
 * Prompts 是 MCP 协议的核心能力之一，允许客户端发现和获取
 * 服务端预定义的提示模板。
 */

import { createLogger } from '../logger.js'
import { McpTransport } from './transport.js'

const log = createLogger('mcp:prompts')

// ── MCP Prompts 类型 ───────────────────────────────────

/** 提示模板参数定义 */
export interface McpPromptArgument {
  /** 参数名称 */
  name: string
  /** 参数描述 */
  description?: string
  /** 是否必需 */
  required?: boolean
}

/** 提示模板 */
export interface McpPrompt {
  /** 提示名称 */
  name: string
  /** 提示描述 */
  description?: string
  /** 参数列表 */
  arguments?: McpPromptArgument[]
}

/** 提示消息内容（文本或资源） */
export interface McpPromptMessage {
  /** 角色：user / assistant / system */
  role: 'user' | 'assistant' | 'system'
  /** 文本内容 */
  content: {
    type: 'text'
    text: string
  } | {
    type: 'resource'
    resource: {
      uri: string
      mimeType?: string
      text?: string
      blob?: string
    }
  }
}

/** prompts/list 响应 */
export interface PromptsListResult {
  prompts: McpPrompt[]
}

/** prompts/get 响应 */
export interface PromptsGetResult {
  /** 提示内容消息列表 */
  messages: McpPromptMessage[]
  /** 提示描述 */
  description?: string
}

// ── Prompts API ────────────────────────────────────────

/**
 * 列出 MCP server 暴露的所有提示模板。
 * @param transport 已连接的 Transport 实例
 * @param timeoutMs 超时时间
 */
export async function listPrompts(
  transport: McpTransport,
  timeoutMs = 15_000,
): Promise<McpPrompt[]> {
  const result = (await transport.request('prompts/list', {}, timeoutMs)) as PromptsListResult | null
  if (!result || !Array.isArray(result.prompts)) {
    log.warn('prompts/list returned unexpected result', { result })
    return []
  }
  return result.prompts
}

/**
 * 获取指定提示模板的完整内容。
 * @param transport 已连接的 Transport 实例
 * @param name 提示名称
 * @param args 参数
 * @param timeoutMs 超时时间
 */
export async function getPrompt(
  transport: McpTransport,
  name: string,
  args?: Record<string, string>,
  timeoutMs = 15_000,
): Promise<McpPromptMessage[]> {
  const params: Record<string, unknown> = { name }
  if (args && Object.keys(args).length > 0) {
    params.arguments = args
  }

  const result = (await transport.request('prompts/get', params, timeoutMs)) as PromptsGetResult | null
  if (!result || !Array.isArray(result.messages)) {
    log.warn('prompts/get returned unexpected result', { name, result })
    return []
  }
  return result.messages
}

/**
 * 将 prompts 消息列表转换为纯文本（拼接角色+内容）。
 */
export function promptMessagesAsText(messages: McpPromptMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role.toUpperCase()
      if (m.content.type === 'text') {
        return `[${role}]\n${m.content.text}`
      }
      if (m.content.type === 'resource') {
        const text = m.content.resource.text ?? '(resource content)'
        return `[${role} RESOURCE: ${m.content.resource.uri}]\n${text}`
      }
      return `[${role} UNKNOWN]`
    })
    .join('\n\n')
}
