/**
 * yu-agent — Rule router
 *
 * Filters available tools based on the active rule's capabilities.
 * Integrates with ToolRegistry to restrict which tools can be called
 * by a given rule.
 */

import { createLogger } from '../logger.js'
import { listTools, type ToolDefinition } from '../tools/registry.js'
import type { RuleDef } from '../types.js'

const _log = createLogger('rules:router')

// ── Tool filtering ─────────────────────────────────────

/**
 * Filter tools based on a rule's capabilities.
 *
 * Logic:
 * 1. If rule has no capabilities, all tools are allowed.
 * 2. If allowTools is specified, only those tools are included.
 * 3. If denyTools is specified, those tools are excluded.
 * 4. denyTools takes precedence over allowTools.
 */
export function filterToolsForRule(rule: RuleDef): ToolDefinition[] {
  const caps = rule.capabilities
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
 * Check if a specific tool is allowed for a given rule.
 * Returns { allowed: boolean; reason?: string }.
 */
export function isToolAllowedForRule(toolName: string, rule: RuleDef): { allowed: boolean; reason?: string } {
  const caps = rule.capabilities
  if (!caps) {
    return { allowed: true }
  }

  // denyTools takes precedence
  if (caps.denyTools?.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" is denied by rule "${rule.name}"` }
  }

  // allowTools constraint
  if (caps.allowTools && caps.allowTools.length > 0) {
    if (!caps.allowTools.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" is not in allow list for rule "${rule.name}". Allowed: ${caps.allowTools.join(', ')}`,
      }
    }
  }

  return { allowed: true }
}

/**
 * Get tool schemas filtered for a rule — used by AgentLoop
 * to present only allowed tools to the LLM.
 */
export function getToolSchemasForRule(rule: RuleDef): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  const tools = filterToolsForRule(rule)
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
 * Get max tool calls for a rule (from capabilities or default).
 */
export function getMaxToolCalls(rule?: RuleDef): number {
  return rule?.capabilities?.maxToolCalls ?? 50
}

/**
 * Get max tokens for a rule (from capabilities or default).
 */
export function getMaxTokensForRule(rule?: RuleDef): number {
  return rule?.capabilities?.maxTokens ?? 8192
}
