/**
 * yu-agent — Role registry
 *
 * Scans ~/.yu/roles/*.yaml and ~/.yu/roles/*.ts for role definitions.
 * Loads and caches RoleDef objects for use by the router and compose modules.
 */

import { createLogger } from '../logger.js'
import type { RoleDef } from '../types.js'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

const log = createLogger('roles:registry')

// ── Constants ──────────────────────────────────────────

const ROLES_DIR = resolve(homedir(), '.yu', 'roles')

// ── In-memory cache ────────────────────────────────────

const _roles = new Map<string, RoleDef>()

// ── Simple YAML parser (no external dep) ───────────────
// Stack-based approach to handle nested maps and lists.

function parseYamlRoles(content: string): RoleDef[] {
  const results: RoleDef[] = []
  const docs = content.split(/^---\s*$/m).filter(Boolean)

  for (const doc of docs) {
    const lines = doc.split('\n')
    const root: Record<string, unknown> = {}

    // Stack of { obj, indent } — the current object at each indent level
    const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [{ obj: root, indent: -1 }]
    // Track the most recent key that had no value (expecting list or nested map)
    // Stores { parentObj, key, indent } so we can set lists on the parent.
    let pending: { parent: Record<string, unknown>; key: string; indent: number } | null = null

    for (const raw of lines) {
      const line = raw.trimEnd()
      if (!line.trim() || line.trim().startsWith('#')) continue

      const indent = line.search(/\S/)
      const trimmed = line.trim()

      // List item
      if (trimmed.startsWith('- ')) {
        const itemVal = parseYamlValue(trimmed.slice(2).trim())

        // Pop stack to find the right parent
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
          stack.pop()
        }

        const currentObj = stack[stack.length - 1].obj

        // If we have a pending key at a lower indent, use it to set/append to parent
        if (pending && indent > pending.indent) {
          const existing = pending.parent[pending.key]
          if (Array.isArray(existing)) {
            existing.push(itemVal)
          } else {
            pending.parent[pending.key] = [itemVal]
            // Pop the nested object from stack — it was replaced by the array
            if (stack.length > 1) {
              stack.pop()
            }
          }
          pending = null
          continue
        }

        // Find the most recent key on currentObj that has an array value
        const keys = Object.keys(currentObj)
        for (let i = keys.length - 1; i >= 0; i--) {
          const val = currentObj[keys[i]]
          if (Array.isArray(val)) {
            val.push(itemVal)
            pending = null
            break
          }
        }
        continue
      }

      // Regular key:value line
      pending = null
      const colonIdx = trimmed.indexOf(':')
      if (colonIdx === -1) continue

      const key = trimmed.slice(0, colonIdx).trim()
      const val = trimmed.slice(colonIdx + 1).trim()

      // Pop stack to find the right parent for this indent
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }

      const currentObj = stack[stack.length - 1].obj

      if (val) {
        // Scalar value
        currentObj[key] = parseYamlValue(val)
      } else {
        // No value — could be nested object or list parent
        // Remember parent for potential list items
        pending = { parent: currentObj, key, indent }
        // Push an empty object for potential sub-keys
        const nested: Record<string, unknown> = {}
        currentObj[key] = nested
        stack.push({ obj: nested, indent })
      }
    }

    if (root.name) {
      const def = yamlToRoleDef(root)
      if (def) results.push(def)
    }
  }

  return results
}

function parseYamlValue(val: string): unknown {
  if (val === 'true') return true
  if (val === 'false') return false
  if (val === 'null' || val === '~') return null
  if (/^\d+$/.test(val)) return parseInt(val, 10)
  if (/^\d+\.\d+$/.test(val)) return parseFloat(val)
  // Remove surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1)
  }
  return val
}

function yamlToRoleDef(raw: Record<string, unknown>): RoleDef | null {
  const name = String(raw.name ?? '')
  if (!name) return null

  const caps = raw.capabilities as Record<string, unknown> | undefined

  return {
    name,
    description: raw.description ? String(raw.description) : undefined,
    extend: raw.extend ? (raw.extend as string[]) : undefined,
    systemPrompt: raw.systemPrompt ? String(raw.systemPrompt) : undefined,
    model: raw.model ? String(raw.model) : undefined,
    thinking: raw.thinking as RoleDef['thinking'] | undefined,
    maxTurns: raw.maxTurns ? Number(raw.maxTurns) : undefined,
    capabilities: caps
      ? {
          allowTools: caps.allowTools ? (caps.allowTools as string[]) : undefined,
          denyTools: caps.denyTools ? (caps.denyTools as string[]) : undefined,
          maxToolCalls: caps.maxToolCalls ? Number(caps.maxToolCalls) : undefined,
          allowMcpServers: caps.allowMcpServers ? (caps.allowMcpServers as string[]) : undefined,
          maxTokens: caps.maxTokens ? Number(caps.maxTokens) : undefined,
        }
      : undefined,
  }
}

// ── Loader ─────────────────────────────────────────────

function ensureRolesDir(): void {
  if (!existsSync(ROLES_DIR)) {
    try {
      const { mkdirSync } = require('fs')
      mkdirSync(ROLES_DIR, { recursive: true })
    } catch {
      // Best-effort
    }
  }
}

async function loadRoleFromFile(filePath: string): Promise<RoleDef | null> {
  try {
    const ext = filePath.split('.').pop()?.toLowerCase()

    if (ext === 'ts' || ext === 'mts') {
      // Dynamic import for TypeScript files
      const mod = await import(filePath)
      const exported = mod.default || mod
      if (exported && typeof exported === 'object' && exported.name) {
        return exported as RoleDef
      }
      return null
    }

    if (ext === 'yaml' || ext === 'yml') {
      const content = readFileSync(filePath, 'utf-8')
      const roles = parseYamlRoles(content)
      return roles[0] ?? null
    }

    if (ext === 'json') {
      const content = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        return parsed[0] ?? null
      }
      if (parsed.name) {
        return parsed as RoleDef
      }
      return null
    }

    log.warn(`Unsupported role file format: ${filePath}`)
    return null
  } catch (err) {
    log.error(`Failed to load role from ${filePath}:`, err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── Public API ─────────────────────────────────────────

/**
 * Scan the roles directory and load all role definitions.
 * Caches results; call refreshRoles() to re-scan.
 */
export async function scanRoles(): Promise<Map<string, RoleDef>> {
  ensureRolesDir()
  _roles.clear()

  if (!existsSync(ROLES_DIR)) {
    log.warn(`Roles directory not found: ${ROLES_DIR}`)
    return _roles
  }

  const files = readdirSync(ROLES_DIR).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.ts') || f.endsWith('.mts') || f.endsWith('.json'),
  )

  for (const file of files) {
    const filePath = resolve(ROLES_DIR, file)
    const role = await loadRoleFromFile(filePath)
    if (role) {
      if (_roles.has(role.name)) {
        log.warn(`Duplicate role name "${role.name}" from ${file}, overwriting.`)
      }
      _roles.set(role.name, role)
      log.info(`Loaded role: ${role.name} from ${file}`)
    }
  }

  return _roles
}

/** Get a role by name (lazy-loads cache on first call). */
export async function getRole(name: string): Promise<RoleDef | undefined> {
  if (_roles.size === 0) {
    await scanRoles()
  }
  return _roles.get(name)
}

/** List all loaded roles. */
export async function listRoles(): Promise<RoleDef[]> {
  if (_roles.size === 0) {
    await scanRoles()
  }
  return Array.from(_roles.values())
}

/** Force re-scan the roles directory. */
export async function refreshRoles(): Promise<void> {
  _roles.clear()
  await scanRoles()
}
