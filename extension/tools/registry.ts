/**
 * yu-agent — ToolRegistry
 *
 * 统一的工具注册、发现和执行入口。
 * 所有工具通过 registry.register() 注册，AgentLoop 通过 registry 调用。
 */

import { createLogger } from '../logger.js'
import type { ToolAuditHook, ToolEnhancement } from '../types.js'

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
}

export interface ToolResult {
  success: boolean
  output: string
  error?: string
}

// ── Registry ────────────────────────────────────────────

const _tools = new Map<string, ToolDefinition>()

export function registerTool(tool: ToolDefinition): void {
  if (_tools.has(tool.name)) {
    log.warn(`Tool already registered, overwriting: ${tool.name}`)
  }
  _tools.set(tool.name, tool)
}

export function getTool(name: string): ToolDefinition | undefined {
  return _tools.get(name)
}

export function listTools(): ToolDefinition[] {
  return Array.from(_tools.values())
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

  const enhancement = tool.enhancement
  const auth = enhancement?.auth
  const role = context?.role

  // ── Auth check ──────────────────────────────────────
  if (auth && role) {
    if (auth.denyRoles?.includes(role)) {
      return { success: false, output: '', error: `Role "${role}" is denied from using tool "${name}"` }
    }
    if (auth.requiredRoles?.length && !auth.requiredRoles.includes(role)) {
      return { success: false, output: '', error: `Tool "${name}" requires role(s): ${auth.requiredRoles.join(', ')}` }
    }
  }

  // ── Schema validation ───────────────────────────────
  if (enhancement?.schema) {
    const parsed = enhancement.schema.safeParse(params)
    if (!parsed.success) {
      return { success: false, output: '', error: `Invalid params for "${name}": ${parsed.error.message}` }
    }
  }

  // ── Execute with audit + timeout ────────────────────
  const start = performance.now()
  const audit = enhancement?.audit

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
    const duration = performance.now() - start
    const error = err instanceof Error ? err : new Error(String(err))
    audit?.error?.({ name, args: params, error, role })
    log.error(`Tool ${name} failed after ${duration.toFixed(0)}ms`, { error: error.message })
    return { success: false, output: '', error: error.message }
  }
}

/** 注册审计钩子到所有已注册工具 */
export function setGlobalAuditHook(hook: ToolAuditHook): void {
  for (const tool of _tools.values()) {
    tool.enhancement = { ...tool.enhancement, audit: hook }
  }
}
