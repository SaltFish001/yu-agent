/**
 * yu-agent — ToolRegistry
 *
 * 统一的工具注册、发现和执行入口。
 * 所有工具通过 registry.register() 注册，AgentLoop 通过 registry 调用。
 */

import { createLogger } from '../logger.js'

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

export async function executeTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const tool = _tools.get(name)
  if (!tool) {
    return { success: false, output: '', error: `Unknown tool: ${name}` }
  }
  try {
    log.info(`Executing tool: ${name}`, { params })
    const result = await tool.execute(params)
    log.info(`Tool result: ${name}`, { success: result.success, output_len: result.output.length })
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`Tool execution failed: ${name}`, { error: msg })
    return { success: false, output: '', error: msg }
  }
}
