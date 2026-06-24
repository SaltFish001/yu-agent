/**
 * yu-agent — Rule composition (multi-rule merge)
 *
 * Supports the `extend` field on RuleDef: a rule can extend one or more
 * parent rules, inheriting and merging their settings. Child settings
 * take precedence over parent settings.
 *
 * Merge rules (child wins):
 *   - systemPrompt: child overrides parent
 *   - model: child overrides parent
 *   - thinking: child overrides parent
 *   - maxTurns: child overrides parent
 *   - capabilities.allowTools: union of parent + child
 *   - capabilities.denyTools: union of parent + child
 *   - capabilities.allowMcpServers: union of parent + child
 *   - capabilities.maxToolCalls: min of parent and child
 *   - capabilities.maxTokens: min of parent and child
 */

import { createLogger } from '../logger.js'
import type { RuleCapability, RuleDef } from '../types.js'
import { getRule } from './registry.js'

const log = createLogger('rules:compose')

// ── Merge helper ───────────────────────────────────────

function mergeCapabilities(parent: RuleCapability, child: RuleCapability): RuleCapability {
  return {
    // Union: parent tools + child tools
    allowTools: [...new Set([...(parent.allowTools ?? []), ...(child.allowTools ?? [])])],
    // Union: parent denies + child denies
    denyTools: [...new Set([...(parent.denyTools ?? []), ...(child.denyTools ?? [])])],
    // Stricter limit: smallest wins
    maxToolCalls:
      parent.maxToolCalls !== undefined && child.maxToolCalls !== undefined
        ? Math.min(parent.maxToolCalls, child.maxToolCalls)
        : (child.maxToolCalls ?? parent.maxToolCalls),
    // Union: parent + child MCP servers
    allowMcpServers: [...new Set([...(parent.allowMcpServers ?? []), ...(child.allowMcpServers ?? [])])],
    // Stricter limit: smallest wins
    maxTokens:
      parent.maxTokens !== undefined && child.maxTokens !== undefined
        ? Math.min(parent.maxTokens, child.maxTokens)
        : (child.maxTokens ?? parent.maxTokens),
  }
}

function mergeRules(parent: RuleDef, child: RuleDef): RuleDef {
  return {
    name: child.name,
    description: child.description ?? parent.description,
    extend: child.extend,
    systemPrompt: child.systemPrompt ?? parent.systemPrompt,
    model: child.model ?? parent.model,
    thinking: child.thinking ?? parent.thinking,
    maxTurns: child.maxTurns ?? parent.maxTurns,
    capabilities:
      child.capabilities || parent.capabilities
        ? mergeCapabilities(parent.capabilities ?? {}, child.capabilities ?? {})
        : undefined,
  }
}

// ── Public API ─────────────────────────────────────────

/**
 * Resolve a rule with its full inheritance chain.
 *
 * Walks the `extend` array recursively, merging ancestor rules
 * bottom-up (furthest ancestor first), then applying the child on top.
 *
 * @param ruleName - The name of the rule to resolve
 * @param ruleMap - Optional pre-loaded map of rules (avoids repeated scans)
 * @param visited - Internal: prevents circular dependency loops
 */
export async function resolveRule(
  ruleName: string,
  ruleMap?: Map<string, RuleDef>,
  visited?: Set<string>,
): Promise<RuleDef | undefined> {
  if (visited?.has(ruleName)) {
    log.warn(`Circular rule dependency detected: ${ruleName}`)
    return undefined
  }

  const _visited = visited ?? new Set<string>()
  _visited.add(ruleName)

  const rule = ruleMap?.get(ruleName) ?? (await getRule(ruleName))
  if (!rule) {
    log.warn(`Rule not found: ${ruleName}`)
    return undefined
  }

  // No parents → return as-is
  if (!rule.extend || rule.extend.length === 0) {
    return rule
  }

  // Resolve parents (furthest ancestor first)
  let merged: RuleDef | undefined
  for (const parentName of rule.extend) {
    const parent = await resolveRule(parentName, ruleMap, _visited)
    if (parent) {
      if (!merged) {
        merged = parent
      } else {
        // Merge grandparent into accumulated parent
        merged = mergeRules(parent, merged)
      }
    }
  }

  // Apply child on top of merged parent
  if (merged) {
    return mergeRules(merged, rule)
  }

  // No valid parents found
  return rule
}

/**
 * Compose multiple rules into a single effective rule.
 * Useful when an agent has multiple applicable rules.
 *
 * Roles are applied left-to-right: each subsequent rule overrides
 * the previous one in the merge chain.
 */
export async function composeRules(ruleNames: string[]): Promise<RuleDef | undefined> {
  if (ruleNames.length === 0) return undefined
  if (ruleNames.length === 1) return resolveRule(ruleNames[0])

  let composed: RuleDef | undefined
  for (const name of ruleNames) {
    const resolved = await resolveRule(name)
    if (!resolved) {
      log.warn(`Role "${name}" not found, skipping in composition.`)
      continue
    }
    if (!composed) {
      composed = { ...resolved }
    } else {
      composed = mergeRules(composed, resolved)
    }
  }

  return composed
}
