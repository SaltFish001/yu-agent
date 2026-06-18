/**
 * Unit tests — Roles subsystem (registry, router, compose)
 *
 * Tests the role loading, tool filtering, and role composition logic.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

const ROLES_DIR = resolve(homedir(), '.yu', 'roles')

// ── Helpers ────────────────────────────────────────────

async function cleanRolesDir(): Promise<void> {
  if (existsSync(ROLES_DIR)) {
    rmSync(ROLES_DIR, { recursive: true, force: true })
  }
  mkdirSync(ROLES_DIR, { recursive: true })
}

async function writeRoleFile(name: string, content: string): Promise<void> {
  writeFileSync(resolve(ROLES_DIR, name), content, 'utf-8')
}

// ── Tests ──────────────────────────────────────────────

describe('Role Registry', () => {
  beforeEach(async () => {
    await cleanRolesDir()
  })

  afterEach(async () => {
    await cleanRolesDir()
  })

  it('scanRoles returns empty map when no role files exist', async () => {
    const { scanRoles } = await import('../extension/roles/registry.js')
    const roles = await scanRoles()
    expect(roles.size).toBe(0)
  })

  it('loads a role from a YAML file', async () => {
    await writeRoleFile(
      'coder.yaml',
      `name: coder
description: A coding agent
model: deepseek-v4-flash
capabilities:
  allowTools:
    - read
    - write
    - bash
  maxToolCalls: 30
`,
    )

    const { scanRoles, getRole } = await import('../extension/roles/registry.js')
    await scanRoles()
    const role = await getRole('coder')
    expect(role).toBeDefined()
    expect(role!.name).toBe('coder')
    expect(role!.description).toBe('A coding agent')
    expect(role!.model).toBe('deepseek-v4-flash')
    expect(role!.capabilities?.allowTools).toEqual(['read', 'write', 'bash'])
    expect(role!.capabilities?.maxToolCalls).toBe(30)
  })

  it('loads a role from a JSON file', async () => {
    await writeRoleFile(
      'reviewer.json',
      JSON.stringify({
        name: 'reviewer',
        description: 'Code reviewer',
        capabilities: {
          allowTools: ['read', 'grep'],
          denyTools: ['write', 'bash'],
        },
      }),
    )

    const { scanRoles, getRole } = await import('../extension/roles/registry.js')
    await scanRoles()
    const role = await getRole('reviewer')
    expect(role).toBeDefined()
    expect(role!.name).toBe('reviewer')
    expect(role!.capabilities?.allowTools).toEqual(['read', 'grep'])
    expect(role!.capabilities?.denyTools).toEqual(['write', 'bash'])
  })

  it('loads multiple roles from multiple files', async () => {
    await writeRoleFile(
      'role1.yaml',
      `name: role1
description: First role
`,
    )
    await writeRoleFile(
      'role2.yaml',
      `name: role2
description: Second role
`,
    )

    const { scanRoles, listRoles } = await import('../extension/roles/registry.js')
    await scanRoles()
    const roles = await listRoles()
    expect(roles.length).toBe(2)
    const names = roles.map((r) => r.name).sort()
    expect(names).toEqual(['role1', 'role2'])
  })

  it('refreshRoles clears and reloads', async () => {
    await writeRoleFile('r1.yaml', 'name: r1\n')
    const { scanRoles, listRoles, refreshRoles } = await import('../extension/roles/registry.js')
    await scanRoles()
    expect((await listRoles()).length).toBe(1)

    await writeRoleFile('r2.yaml', 'name: r2\n')
    await refreshRoles()
    expect((await listRoles()).length).toBe(2)
  })
})

describe('Role Router', () => {
  beforeEach(async () => {
    await cleanRolesDir()
    // Register some test tools
    const { registerTool } = await import('../extension/tools/registry.js')

    // Avoid duplicate registration errors
    for (const name of ['read', 'write', 'bash', 'grep', 'search']) {
      try {
        registerTool({
          name,
          description: `Tool ${name}`,
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ success: true, output: '' }),
        })
      } catch {
        // Already registered
      }
    }
  })

  afterEach(async () => {
    await cleanRolesDir()
  })

  it('filterToolsForRole returns all tools when no capabilities', async () => {
    const { filterToolsForRole } = await import('../extension/roles/router.js')
    const role = {
      name: 'unrestricted',
      capabilities: undefined,
    }
    const tools = filterToolsForRole(role)
    expect(tools.length).toBeGreaterThanOrEqual(5)
  })

  it('filterToolsForRole respects allowTools', async () => {
    const { filterToolsForRole } = await import('../extension/roles/router.js')
    const role = {
      name: 'reader',
      capabilities: { allowTools: ['read', 'grep'] },
    }
    const tools = filterToolsForRole(role)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('grep')
    expect(names).not.toContain('write')
    expect(names).not.toContain('bash')
  })

  it('filterToolsForRole respects denyTools', async () => {
    const { filterToolsForRole } = await import('../extension/roles/router.js')
    const role = {
      name: 'safe',
      capabilities: { denyTools: ['bash', 'write'] },
    }
    const tools = filterToolsForRole(role)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('grep')
    expect(names).not.toContain('write')
    expect(names).not.toContain('bash')
  })

  it('denyTools takes precedence over allowTools', async () => {
    const { filterToolsForRole } = await import('../extension/roles/router.js')
    const role = {
      name: 'conflicted',
      capabilities: {
        allowTools: ['read', 'write', 'bash'],
        denyTools: ['bash'],
      },
    }
    const tools = filterToolsForRole(role)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).not.toContain('bash')
  })

  it('isToolAllowedForRole returns correct results', async () => {
    const { isToolAllowedForRole } = await import('../extension/roles/router.js')
    const role = { name: 'test', capabilities: { allowTools: ['read'], denyTools: ['bash'] } }

    expect(isToolAllowedForRole('read', role).allowed).toBe(true)
    expect(isToolAllowedForRole('bash', role).allowed).toBe(false)
    expect(isToolAllowedForRole('write', role).allowed).toBe(false)
    expect(isToolAllowedForRole('write', { name: 'free', capabilities: undefined }).allowed).toBe(true)
  })

  it('getMaxToolCalls returns default when not set', async () => {
    const { getMaxToolCalls } = await import('../extension/roles/router.js')
    expect(getMaxToolCalls(undefined)).toBe(50)
    expect(getMaxToolCalls({ name: 'test', capabilities: { maxToolCalls: 10 } })).toBe(10)
  })
})

describe('Role Compose', () => {
  beforeEach(async () => {
    await cleanRolesDir()
    // Refresh the role registry cache after cleaning
    const { refreshRoles } = await import('../extension/roles/registry.js')
    await refreshRoles()
    // Write parent roles
    await writeRoleFile(
      'base.yaml',
      `name: base
systemPrompt: Base system prompt
model: deepseek-v4-flash
capabilities:
  allowTools:
    - read
    - write
  maxToolCalls: 50
  maxTokens: 4096
`,
    )
    await writeRoleFile(
      'admin.yaml',
      `name: admin
extend:
  - base
systemPrompt: Admin override
capabilities:
  allowTools:
    - bash
  maxTokens: 8192
`,
    )
  })

  afterEach(async () => {
    await cleanRolesDir()
  })

  it('resolveRole returns base role as-is (no extend)', async () => {
    const { resolveRole } = await import('../extension/roles/compose.js')
    const role = await resolveRole('base')
    expect(role).toBeDefined()
    expect(role!.name).toBe('base')
    expect(role!.systemPrompt).toBe('Base system prompt')
  })

  it('resolveRole merges extended role', async () => {
    const { resolveRole } = await import('../extension/roles/compose.js')
    const role = await resolveRole('admin')
    expect(role).toBeDefined()
    expect(role!.name).toBe('admin')
    // Child systemPrompt overrides parent
    expect(role!.systemPrompt).toBe('Admin override')
    // Capabilities are merged (union of allowTools, stricter maxToolCalls)
    expect(role!.capabilities?.allowTools?.sort()).toEqual(['bash', 'read', 'write'])
    // maxToolCalls: min of 50 and undefined -> 50
    expect(role!.capabilities?.maxToolCalls).toBe(50)
    // maxTokens: min of 4096 and 8192 -> 4096
    expect(role!.capabilities?.maxTokens).toBe(4096)
  })

  it('composeRoles merges multiple roles left-to-right', async () => {
    await writeRoleFile(
      'limited.yaml',
      `name: limited
capabilities:
  maxToolCalls: 5
`,
    )

    const { composeRoles } = await import('../extension/roles/compose.js')
    const composed = await composeRoles(['base', 'limited'])
    expect(composed).toBeDefined()
    expect(composed!.name).toBe('limited') // Last role's name wins
    // maxToolCalls: min of 50 and 5 = 5
    expect(composed!.capabilities?.maxToolCalls).toBe(5)
  })

  it('handles circular dependency gracefully', async () => {
    await writeRoleFile(
      'a.yaml',
      `name: a
extend:
  - b
`,
    )
    await writeRoleFile(
      'b.yaml',
      `name: b
extend:
  - a
`,
    )

    const { refreshRoles } = await import('../extension/roles/registry.js')
    await refreshRoles()
    const { resolveRole } = await import('../extension/roles/compose.js')
    // Should not throw; should return undefined or the role without cycling
    const role = await resolveRole('a')
    // Circular -> warns and returns undefined
    // It might resolve to the base level if one is found
    expect(role).toBeDefined()
  })
})
