/**
 * yu-agent — Role router
 *
 * Filters available tools based on the active role's capabilities.
 * Integrates with ToolRegistry to restrict which tools can be called
 * by a given role.
 */

import { createLogger } from '../logger.js'
import type { RoleDef, RoleCapability } from '../types.js'
import { listTools, type ToolDefinition } from '../tools/registry.js'

const log = createLogger('roles:router')

// ── Tool filtering ─────────────────────────────────────

/**
 * Filter tools based on a role's capabilities.
 *
 * Logic:
 * 1. If role has no capabilities, all tools are allowed.
 * 2. If allowTools is specified, only those tools are included.
 * 3. If denyTools is specified, those tools are excluded.
 * 4. denyTools takes precedence over allowTools.
 */
export function filterToolsForRole(role: RoleDef): ToolDefinition[] {
  const caps = role.capabilities
  if (!caps) {
    // No capability constraints — return all tools
    return listTools()
  }

  const allTools = listTools()

  // If allowTools is set, filter to only those
  let filtered = allTools
  if (caps.allowTools && caps.allowTools.length > 0) {
    const allowSet = new Set(caps.allowTools)
    filtered = filtered.filter((t) => allowSet.has(t.name))
  }

  // Apply denyTools (takes precedence)
  if (caps.denyTools && caps.denyTools.length > 0) {
    const denySet = new Set(caps.denyTools)
    filtered = filtered.filter((t) => !denySet.has(t.name))
  }

  return filtered
}

/**
 * Check if a specific tool is allowed for a given role.
 * Returns { allowed: boolean; reason?: string }.
 */
export function isToolAllowedForRole(
  toolName: string,
  role: RoleDef,
): { allowed: boolean; reason?: string } {
  const caps = role.capabilities
  if (!caps) {
    return { allowed: true }
  }

  // denyTools takes precedence
  if (caps.denyTools && caps.denyTools.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" is denied by role "${role.name}"` }
  }

  // allowTools constraint
  if (caps.allowTools && caps.allowTools.length > 0) {
    if (!caps.allowTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" is not in allow list for role "${role.name}". Allowed: ${caps.allowTools.join(', ')}`,
      }
    }
  }

  return { allowed: true }
}

/**
 * Get tool schemas filtered for a role — used by AgentLoop
 * to present only allowed tools to the LLM.
 */
export function getToolSchemasForRole(role: RoleDef): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  const tools = filterToolsForRole(role)
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
    },
  }))
}

/**
 * Get max tool calls for a role (from capabilities or default).
 */
export function getMaxToolCalls(role?: RoleDef): number {
  return role?.capabilities?.maxToolCalls ?? 50
}

/**
 * Get max tokens for a role (from capabilities or default).
 */
export function getMaxTokensForRole(role?: RoleDef): number {
  return role?.capabilities?.maxTokens ?? 8192
}
