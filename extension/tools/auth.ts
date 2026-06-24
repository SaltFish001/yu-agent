/**
 * yu-agent — Tool authorization system
 *
 * Role-based access control for tool execution.
 * Supports role hierarchy (admin > power > user > guest),
 * deny-role override, and required-role enforcement.
 */

import { createLogger } from '../logger.js'

const log = createLogger('tools:auth')

// ── Types ──

export interface AuthConfig {
  /** Roles that are explicitly denied access (highest priority) */
  denyRoles?: string[]
  /** One of these roles is required for access */
  requiredRoles?: string[]
}

export interface AuthContext {
  role?: string
  toolName: string
  args: Record<string, unknown>
}

export type AuthDecision = 'allow' | 'deny'

// ── Role hierarchy (lower index = higher privilege) ──

const ROLE_HIERARCHY = ['admin', 'power', 'user', 'guest']

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role)
  return idx >= 0 ? idx : ROLE_HIERARCHY.length // unknown roles are lowest
}

// ── Auth check ──

/**
 * Check whether a role is allowed to execute a tool.
 * Returns 'allow' or 'deny'.
 */
export function checkAuth(config: AuthConfig | undefined, ctx: AuthContext): AuthDecision {
  if (!config) return 'allow'
  const { role } = ctx

  // No role provided — skip auth check (compat with old behavior)
  if (!role) return 'allow'

  // Deny roles take highest priority
  if (config.denyRoles?.some((denied) => denied === role || roleLevel(denied) <= roleLevel(role))) {
    log.info(`Auth DENY: ${ctx.toolName} for role=${role}`)
    return 'deny'
  }

  // Required roles check with hierarchy support
  if (config.requiredRoles?.length) {
    const minLevel = Math.min(...config.requiredRoles.map(roleLevel))
    if (roleLevel(role) > minLevel) {
      log.info(`Auth DENY: ${ctx.toolName} requires ${config.requiredRoles.join('/')}, role=${role}`)
      return 'deny'
    }
  }

  return 'allow'
}

/**
 * Create a deny reason message for display.
 */
export function denyReason(config: AuthConfig | undefined, ctx: AuthContext): string {
  if (!config) return ''
  if (config.denyRoles?.length) {
    return `Role "${ctx.role}" is denied from using tool "${ctx.toolName}"`
  }
  if (config.requiredRoles?.length) {
    return `Tool "${ctx.toolName}" requires role(s): ${config.requiredRoles.join(', ')}`
  }
  return `Access denied for tool "${ctx.toolName}"`
}
