/**
 * yu-agent — MCP 工具适配器
 *
 * 复用 mcp-manager.ts 的 jsonRpcCall() + _getServers()。
 * 增加：
 *   1. MCP 协议初始化握手（initialize → notifications/initialized）
 *   2. 工具列表缓存
 *   3. callTool 超时与错误恢复
 *   4. 动态注册到 ToolRegistry
 */

import { createLogger } from '../logger.js'

const log = createLogger('mcp-tools')

import { _getServers, getTransport, jsonRpcCall } from '../mcp-manager.js'
import { registerTool, type ToolDefinition, type ToolParameter, type ToolResult } from './registry.js'

// ── 常量 ────────────────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2024-11-05'
const INIT_TIMEOUT = 10_000
const CALL_TOOL_TIMEOUT = 60_000
const SERVER_REFRESH_INTERVAL = 30_000 // 30s 刷新一次工具列表

// ── 类型 ────────────────────────────────────────────────

interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

// ── 初始化握手 ────────────────────────────────────────────

/**
 * 向 MCP server 发送初始化握手。
 * 必须先完成握手才能发送任何请求。
 */
async function initializeServer(name: string, proc: Bun.Subprocess): Promise<boolean> {
  try {
    const result = (await jsonRpcCall(
      proc,
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'yu-agent', version: '0.1' },
      },
      INIT_TIMEOUT,
    )) as Record<string, unknown>

    if (!result) return false

    // 发送 notifications/initialized 握手（MCP 规范要求）
    try {
      const transport = getTransport(name)
      if (transport?.isConnected()) {
        await transport.sendNotification('notifications/initialized')
      } else {
        await jsonRpcCall(proc, 'notifications/initialized', {}, 3_000)
      }
    } catch {
      // fire-and-forget，失败不影响后续
    }

    return true
  } catch (err) {
    log.warn('MCP initialize failed', err)
    return false
  }
}

// ── 工具列表 ──────────────────────────────────────────────

const _toolCache = new Map<string, McpToolInfo[]>()
const _lastRefresh = new Map<string, number>()

async function listServerTools(name: string, proc: Bun.Subprocess): Promise<McpToolInfo[]> {
  try {
    const raw = (await jsonRpcCall(proc, 'tools/list', {}, CALL_TOOL_TIMEOUT)) as Record<string, unknown> | undefined
    if (!raw) return _toolCache.get(name) ?? []
    const tools = (raw.tools ?? []) as McpToolInfo[]
    _toolCache.set(name, tools)
    _lastRefresh.set(name, Date.now())
    return tools
  } catch (err) {
    log.warn(`MCP tools/list failed for ${name}`, err)
    return _toolCache.get(name) ?? []
  }
}

function needsRefresh(name: string): boolean {
  const last = _lastRefresh.get(name) ?? 0
  return Date.now() - last > SERVER_REFRESH_INTERVAL
}

// ── 注册到 ToolRegistry ─────────────────────────────────

function buildToolDef(_name: string, info: McpToolInfo, serverName: string): ToolDefinition {
  return {
    name: `mcp_${info.name}`,
    description: `[${serverName}] ${info.description ?? info.name}`,
    parameters: (info.inputSchema ?? {
      type: 'object',
      properties: {},
    }) as unknown as ToolParameter,
    async execute(params): Promise<ToolResult> {
      const servers = _getServers()
      const server = servers.get(serverName)
      if (server?.status !== 'running') {
        return { success: false, output: '', error: `MCP server '${serverName}' not running` }
      }
      try {
        const raw = (await jsonRpcCall(
          server.proc,
          'tools/call',
          { name: info.name, arguments: params },
          CALL_TOOL_TIMEOUT,
        )) as Record<string, unknown> | undefined

        if (!raw) return { success: false, output: '', error: 'Empty response from MCP server' }
        const contentArr = raw.content
        const content: Array<{ text?: string }> = Array.isArray(contentArr) ? contentArr : []
        const isError = raw.isError === true
        const text = content
          .map((c: { text?: string; [key: string]: unknown }) => c.text ?? JSON.stringify(c))
          .filter(Boolean)
          .join('\n')

        return { success: !isError, output: text || '(no output)' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, output: '', error: `MCP call failed: ${msg}` }
      }
    },
  }
}

// ── 刷新所有 MCP 工具 ────────────────────────────────────

export async function refreshMcpTools(): Promise<void> {
  const servers = _getServers()
  if (servers.size === 0) return

  for (const [name, server] of servers) {
    if (server.status !== 'running') continue

    // 需要初始化？
    if (!_lastRefresh.has(name)) {
      const ok = await initializeServer(name, server.proc)
      if (!ok) {
        log.warn(`MCP server '${name}' initialization failed, skipping`)
        continue
      }
    }

    // 需要刷新？
    if (!_lastRefresh.has(name) || needsRefresh(name)) {
      const tools = await listServerTools(name, server.proc)
      for (const tool of tools) {
        registerTool(buildToolDef(name, tool, name))
      }
      log.info(`Registered ${tools.length} tools from MCP server '${name}'`)
    }
  }
}

// ── 启动时自动刷新 ────────────────────────────────────────

let _refreshTimer: ReturnType<typeof setInterval> | null = null

export function startMcpToolRefresh(intervalMs: number = SERVER_REFRESH_INTERVAL): void {
  if (_refreshTimer) return
  // 首次延迟 2s 让 MCP manager 启动完
  setTimeout(() => refreshMcpTools(), 2000)
  _refreshTimer = setInterval(() => refreshMcpTools(), intervalMs)
}

export function stopMcpToolRefresh(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer)
    _refreshTimer = null
  }
}
