/**
 * yu-agent — ToolRegistry
 *
 * 统一的工具注册、发现和执行入口。
 * 所有工具通过 registry.register() 注册，AgentLoop 通过 registry 调用。
 */

import { createLogger } from '../logger.js'
import type { ToolAuditHook, ToolEnhancement } from '../types.js'
import { type AuthConfig, checkAuth, denyReason } from './auth.js'
import { isToolEnabled } from './toggle.js'

const log = createLogger('registry')

// ── Types ───────────────────────────────────────────────

export interface ToolParameter {
  type: string
  description?: string
  enum?: string[]
  items?: ToolParameter
  properties?: Record<string, ToolParameter>
  required?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameter
  execute: (params: Record<string, unknown>) => Promise<ToolResult>
  /** 增强配置 (可选) */
  enhancement?: ToolEnhancement
  /** 启用状态 (默认 true) */
  enabled?: boolean
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

// ── Registry ────────────────────────────────────────────

const _tools = new Map<string, ToolDefinition>()
let _globalAuditHook: ToolAuditHook | null = null

export function registerTool(tool: ToolDefinition): void {
  if (_tools.has(tool.name)) {
    log.warn(`Tool already registered, overwriting: ${tool.name}`)
  }
  _tools.set(tool.name, { ...tool, enabled: tool.enabled ?? true })
}

export function getTool(name: string): ToolDefinition | undefined {
  return _tools.get(name)
}

/** MCP 工具注册表 — 按 server 来源分组 */
const _mcpTools = new Map<string, ToolDefinition>()

export function registerMcpTool(source: string, tool: ToolDefinition): void {
  const key = `mcp_${source}_${tool.name}`
  _mcpTools.set(key, tool)
  // 同时注册到主 registry（加 mcp_ 前缀）
  registerTool({
    ...tool,
    name: `mcp_${tool.name}`,
    enhancement: { ...tool.enhancement, source: 'mcp' },
  })
}

export function getMcpTools(source?: string): ToolDefinition[] {
  if (source) {
    return Array.from(_mcpTools.values()).filter(t =>
      t.enhancement?.source === 'mcp' && t.name.startsWith(`mcp_${source}_`),
    )
  }
  return Array.from(_mcpTools.values())
}

export function listTools(): ToolDefinition[] {
  return Array.from(_tools.values())
}

/**
 * 按 agent type 名称过滤可用工具。
 * 返回：内置工具（匹配 builtinToolNames）+ MCP 工具（匹配 mcpServers）
 */
export function listToolsByType(
  builtinToolNames: string[],
  mcpServers?: string[],
): ToolDefinition[] {
  const result: ToolDefinition[] = []

  // 内置工具过滤
  const nameSet = new Set(builtinToolNames)
  for (const tool of _tools.values()) {
    if (tool.enhancement?.source === 'mcp') continue // MCP 工具单独处理
    if (nameSet.has(tool.name)) {
      result.push(tool)
    }
  }

  // MCP 工具：按 server 来源匹配
  if (mcpServers && mcpServers.length > 0) {
    const mcpServerSet = new Set(mcpServers)
    for (const [key, tool] of _mcpTools) {
      // key = mcp_{source}_{name}
      const source = key.split('_')[1] // 取 mcp_{source} 部分
      if (source && mcpServerSet.has(source)) {
        result.push(tool)
      }
    }
  }

  return result
}

export function getToolSchemas(): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: ToolParameter }
}> {
  return listTools().map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  context?: { role?: string },
): Promise<ToolResult> {
  const tool = _tools.get(name)
  if (!tool) {
    return { success: false, output: '', error: `Unknown tool: ${name}` }
  }

  // ── Enabled check (in-memory + persisted state) ──
  if (tool.enabled === false || !isToolEnabled(name)) {
    return { success: false, output: '', error: `Tool "${name}" is disabled` }
  }

  const enhancement = tool.enhancement
  const role = context?.role

  // ── Auth check (delegated to auth.ts) ──
  const authConfig = enhancement?.auth as AuthConfig | undefined
  const authResult = checkAuth(authConfig, { role, toolName: name, args: params })
  if (authResult === 'deny') {
    return { success: false, output: '', error: denyReason(authConfig, { role, toolName: name, args: params }) }
  }

  // ── Schema validation ───────────────────────────────
  if (enhancement?.schema) {
    const parsed = enhancement.schema.safeParse(params)
    if (!parsed.success) {
      return { success: false, output: '', error: `Invalid params for "${name}": ${parsed.error.message}` }
    }
  }

  // ── Execute with audit + timeout + retry ──────────────
  const start = performance.now()
  const audit = _globalAuditHook ?? enhancement?.audit
  const retryCount = enhancement?.retryCount ?? 0

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      audit?.before?.({ name, args: params, role })

      const timeout = enhancement?.timeout ?? 60_000
      const result = await Promise.race([
        tool.execute(params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${timeout}ms`)), timeout),
        ),
      ])

      const duration = performance.now() - start
      audit?.after?.({ name, args: params, result, durationMs: duration, role })
      log.info(`Tool ${name} completed in ${duration.toFixed(0)}ms`)
      return result
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < retryCount) {
        log.warn(`Tool ${name} failed on attempt ${attempt + 1}/${retryCount + 1}, retrying...`, {
          error: lastError.message,
        })
        continue
      }
      break
    }
  }
  const duration = performance.now() - start
  const finalError = lastError ?? new Error(`Tool "${name}" failed`)
  audit?.error?.({ name, args: params, error: finalError, role })
  log.error(`Tool ${name} failed after ${duration.toFixed(0)}ms`, { error: finalError.message })
  return { success: false, output: '', error: finalError.message }
}

/** 注册审计钩子到所有已注册工具 */
export function setGlobalAuditHook(hook: ToolAuditHook): void {
  _globalAuditHook = hook
}

/** 切换工具的启用/禁用状态（委托给 toggle.ts）。返回切换后的状态。 */
export async function toggleTool(name: string): Promise<boolean | null> {
  const { toggleTool: toggle } = await import('./toggle.js')
  const toolNames = Array.from(_tools.keys())
  return toggle(name, toolNames)
}
