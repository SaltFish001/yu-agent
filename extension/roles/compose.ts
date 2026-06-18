/**
 * yu-agent — Role composition (multi-role merge)
 *
 * Supports the `extend` field on RoleDef: a role can extend one or more
 * parent roles, inheriting and merging their settings. Child settings
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
import type { RoleDef, RoleCapability } from '../types.js'
import { getRole } from './registry.js'

const log = createLogger('roles:compose')

// ── Merge helper ───────────────────────────────────────

function mergeCapabilities(parent: RoleCapability, child: RoleCapability): RoleCapability {
  return {
    // Union: parent tools + child tools
    allowTools: [
      ...new Set([...(parent.allowTools ?? []), ...(child.allowTools ?? [])]),
    ],
    // Union: parent denies + child denies
    denyTools: [
      ...new Set([...(parent.denyTools ?? []), ...(child.denyTools ?? [])]),
    ],
    // Stricter limit: smallest wins
    maxToolCalls:
      parent.maxToolCalls !== undefined && child.maxToolCalls !== undefined
        ? Math.min(parent.maxToolCalls, child.maxToolCalls)
        : (child.maxToolCalls ?? parent.maxToolCalls),
    // Union: parent + child MCP servers
    allowMcpServers: [
      ...new Set([...(parent.allowMcpServers ?? []), ...(child.allowMcpServers ?? [])]),
    ],
    // Stricter limit: smallest wins
    maxTokens:
      parent.maxTokens !== undefined && child.maxTokens !== undefined
        ? Math.min(parent.maxTokens, child.maxTokens)
        : (child.maxTokens ?? parent.maxTokens),
  }
}

function mergeRoles(parent: RoleDef, child: RoleDef): RoleDef {
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
        ? mergeCapabilities(
            parent.capabilities ?? {},
            child.capabilities ?? {},
          )
        : undefined,
  }
}

// ── Public API ─────────────────────────────────────────

/**
 * Resolve a role with its full inheritance chain.
 *
 * Walks the `extend` array recursively, merging ancestor roles
 * bottom-up (furthest ancestor first), then applying the child on top.
 *
 * @param roleName - The name of the role to resolve
 * @param roleMap - Optional pre-loaded map of roles (avoids repeated scans)
 * @param visited - Internal: prevents circular dependency loops
 */
export async function resolveRole(
  roleName: string,
  roleMap?: Map<string, RoleDef>,
  visited?: Set<string>,
): Promise<RoleDef | undefined> {
  if (visited?.has(roleName)) {
    log.warn(`Circular role dependency detected: ${roleName}`)
    return undefined
  }

  const _visited = visited ?? new Set<string>()
  _visited.add(roleName)

  const role = roleMap?.get(roleName) ?? (await getRole(roleName))
  if (!role) {
    log.warn(`Role not found: ${roleName}`)
    return undefined
  }

  // No parents → return as-is
  if (!role.extend || role.extend.length === 0) {
    return role
  }

  // Resolve parents (furthest ancestor first)
  let merged: RoleDef | undefined
  for (const parentName of role.extend) {
    const parent = await resolveRole(parentName, roleMap, _visited)
    if (parent) {
      if (!merged) {
        merged = parent
      } else {
        // Merge grandparent into accumulated parent
        merged = mergeRoles(parent, merged)
      }
    }
  }

  // Apply child on top of merged parent
  if (merged) {
    return mergeRoles(merged, role)
  }

  // No valid parents found
  return role
}

/**
 * Compose multiple roles into a single effective role.
 * Useful when an agent has multiple applicable roles.
 *
 * Roles are applied left-to-right: each subsequent role overrides
 * the previous one in the merge chain.
 */
export async function composeRoles(roleNames: string[]): Promise<RoleDef | undefined> {
  if (roleNames.length === 0) return undefined
  if (roleNames.length === 1) return resolveRole(roleNames[0])

  let composed: RoleDef | undefined
  for (const name of roleNames) {
    const resolved = await resolveRole(name)
    if (!resolved) {
      log.warn(`Role "${name}" not found, skipping in composition.`)
      continue
    }
    if (!composed) {
      composed = { ...resolved }
    } else {
      composed = mergeRoles(composed, resolved)
    }
  }

  return composed
}
