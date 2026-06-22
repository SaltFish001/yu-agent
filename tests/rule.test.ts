/**
 * Unit tests — Roles subsystem (registry, router, compose)
 *
 * Tests the rule loading, tool filtering, and rule composition logic.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

const RULES_DIR = resolve(homedir(), '.yu', 'rules')

// ── Helpers ────────────────────────────────────────────

async function cleanRulesDir(): Promise<void> {
  if (existsSync(RULES_DIR)) {
    rmSync(RULES_DIR, { recursive: true, force: true })
  }
  mkdirSync(RULES_DIR, { recursive: true })
}

async function writeRuleFile(name: string, content: string): Promise<void> {
  writeFileSync(resolve(RULES_DIR, name), content, 'utf-8')
}

// ── Tests ──────────────────────────────────────────────

describe('Role Registry', () => {
  beforeEach(async () => {
    await cleanRulesDir()
  })

  afterEach(async () => {
    await cleanRulesDir()
  })

  it('scanRules returns empty map when no role files exist', async () => {
    const { scanRules } = await import('../extension/rules/registry.js')
    const rules = await scanRules()
    expect(rules.size).toBe(0)
  })

  it('loads a role from a YAML file', async () => {
    await writeRuleFile(
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

    const { scanRules, getRule } = await import('../extension/rules/registry.js')
    await scanRules()
    const role = await getRule('coder')
    expect(role).toBeDefined()
    expect(role!.name).toBe('coder')
    expect(role!.description).toBe('A coding agent')
    expect(role!.model).toBe('deepseek-v4-flash')
    expect(role!.capabilities?.allowTools).toEqual(['read', 'write', 'bash'])
    expect(role!.capabilities?.maxToolCalls).toBe(30)
  })

  it('loads a role from a JSON file', async () => {
    await writeRuleFile(
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

    const { scanRules, getRule } = await import('../extension/rules/registry.js')
    await scanRules()
    const role = await getRule('reviewer')
    expect(role).toBeDefined()
    expect(role!.name).toBe('reviewer')
    expect(role!.capabilities?.allowTools).toEqual(['read', 'grep'])
    expect(role!.capabilities?.denyTools).toEqual(['write', 'bash'])
  })

  it('loads multiple rules from multiple files', async () => {
    await writeRuleFile(
      'role1.yaml',
      `name: role1
description: First role
`,
    )
    await writeRuleFile(
      'role2.yaml',
      `name: role2
description: Second role
`,
    )

    const { scanRules, listRules } = await import('../extension/rules/registry.js')
    await scanRules()
    const rules = await listRules()
    expect(rules.length).toBe(2)
    const names = rules.map((r) => r.name).sort()
    expect(names).toEqual(['role1', 'role2'])
  })

  it('refreshRules clears and reloads', async () => {
    await writeRuleFile('r1.yaml', 'name: r1\n')
    const { scanRules, listRules, refreshRules } = await import('../extension/rules/registry.js')
    await scanRules()
    expect((await listRules()).length).toBe(1)

    await writeRuleFile('r2.yaml', 'name: r2\n')
    await refreshRules()
    expect((await listRules()).length).toBe(2)
  })
})

describe('Role Router', () => {
  beforeEach(async () => {
    await cleanRulesDir()
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
    await cleanRulesDir()
  })

  it('filterToolsForRule returns all tools when no capabilities', async () => {
    const { filterToolsForRule } = await import('../extension/rules/router.js')
    const role = {
      name: 'unrestricted',
      capabilities: undefined,
    }
    const tools = filterToolsForRule(role)
    expect(tools.length).toBeGreaterThanOrEqual(5)
  })

  it('filterToolsForRule respects allowTools', async () => {
    const { filterToolsForRule } = await import('../extension/rules/router.js')
    const role = {
      name: 'reader',
      capabilities: { allowTools: ['read', 'grep'] },
    }
    const tools = filterToolsForRule(role)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('grep')
    expect(names).not.toContain('write')
    expect(names).not.toContain('bash')
  })

  it('filterToolsForRule respects denyTools', async () => {
    const { filterToolsForRule } = await import('../extension/rules/router.js')
    const role = {
      name: 'safe',
      capabilities: { denyTools: ['bash', 'write'] },
    }
    const tools = filterToolsForRule(role)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('grep')
    expect(names).not.toContain('write')
    expect(names).not.toContain('bash')
  })

  it('denyTools takes precedence over allowTools', async () => {
    const { filterToolsForRule } = await import('../extension/rules/router.js')
    const role = {
      name: 'conflicted',
      capabilities: {
        allowTools: ['read', 'write', 'bash'],
        denyTools: ['bash'],
      },
    }
    const tools = filterToolsForRule(role)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).not.toContain('bash')
  })

  it('isToolAllowedForRule returns correct results', async () => {
    const { isToolAllowedForRule } = await import('../extension/rules/router.js')
    const role = { name: 'test', capabilities: { allowTools: ['read'], denyTools: ['bash'] } }

    expect(isToolAllowedForRule('read', role).allowed).toBe(true)
    expect(isToolAllowedForRule('bash', role).allowed).toBe(false)
    expect(isToolAllowedForRule('write', role).allowed).toBe(false)
    expect(isToolAllowedForRule('write', { name: 'free', capabilities: undefined }).allowed).toBe(true)
  })

  it('getMaxToolCalls returns default when not set', async () => {
    const { getMaxToolCalls } = await import('../extension/rules/router.js')
    expect(getMaxToolCalls(undefined)).toBe(50)
    expect(getMaxToolCalls({ name: 'test', capabilities: { maxToolCalls: 10 } })).toBe(10)
  })
})

describe('Role Compose', () => {
  beforeEach(async () => {
    await cleanRulesDir()
    // Refresh the role registry cache after cleaning
    const { refreshRules } = await import('../extension/rules/registry.js')
    await refreshRules()
    // Write parent rules
    await writeRuleFile(
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
    await writeRuleFile(
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
    await cleanRulesDir()
  })

  it('resolveRule returns base role as-is (no extend)', async () => {
    const { resolveRule } = await import('../extension/rules/compose.js')
    const role = await resolveRule('base')
    expect(role).toBeDefined()
    expect(role!.name).toBe('base')
    expect(role!.systemPrompt).toBe('Base system prompt')
  })

  it('resolveRule merges extended role', async () => {
    const { resolveRule } = await import('../extension/rules/compose.js')
    const role = await resolveRule('admin')
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

  it('composeRules merges multiple rules left-to-right', async () => {
    await writeRuleFile(
      'limited.yaml',
      `name: limited
capabilities:
  maxToolCalls: 5
`,
    )

    const { composeRules } = await import('../extension/rules/compose.js')
    const composed = await composeRules(['base', 'limited'])
    expect(composed).toBeDefined()
    expect(composed!.name).toBe('limited') // Last role's name wins
    // maxToolCalls: min of 50 and 5 = 5
    expect(composed!.capabilities?.maxToolCalls).toBe(5)
  })

  it('handles circular dependency gracefully', async () => {
    await writeRuleFile(
      'a.yaml',
      `name: a
extend:
  - b
`,
    )
    await writeRuleFile(
      'b.yaml',
      `name: b
extend:
  - a
`,
    )

    const { refreshRules } = await import('../extension/rules/registry.js')
    await refreshRules()
    const { resolveRule } = await import('../extension/rules/compose.js')
    // Should not throw; should return undefined or the role without cycling
    const role = await resolveRule('a')
    // Circular -> warns and returns undefined
    // It might resolve to the base level if one is found
    expect(role).toBeDefined()
  })
})
