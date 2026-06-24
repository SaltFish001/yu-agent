/**
 * Integration tests — Scope + STMR modules
 *
 * Tests that Skills/Tools/Roles/MCP actually pick up files from
 * all three scope levels (global / user / project) with correct priority.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'

const PROJECT_SCOPE = resolve(process.cwd(), '.yu')
const USER_SCOPE = resolve(homedir(), '.yu')
const GLOBAL_SCOPE = '/etc/yu'

// ── Helpers ────────────────────────────────────────────

/** Check if we can write to /etc/yu (needs root) */
let _canWriteGlobal: boolean | null = null
function canWriteGlobal(): boolean {
  if (_canWriteGlobal !== null) return _canWriteGlobal
  try {
    mkdirSync(GLOBAL_SCOPE, { recursive: true })
    rmSync(GLOBAL_SCOPE, { recursive: true, force: true })
    _canWriteGlobal = true
  } catch {
    _canWriteGlobal = false
  }
  return _canWriteGlobal
}

function cleanAll(subdir: string): void {
  for (const dir of [USER_SCOPE, PROJECT_SCOPE]) {
    const target = resolve(dir, subdir)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  }
  if (canWriteGlobal()) {
    const target = resolve(GLOBAL_SCOPE, subdir)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  }
}

function writeAt(scope: 'global' | 'user' | 'project', subdir: string, name: string, content: string): string {
  if (scope === 'global' && !canWriteGlobal()) throw new Error('Cannot write to global scope')
  const base = scope === 'global' ? GLOBAL_SCOPE : scope === 'project' ? PROJECT_SCOPE : USER_SCOPE
  const dir = resolve(base, subdir)
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, name)
  writeFileSync(path, content, 'utf-8')
  return path
}

/** Minimal valid skill file content */
function skillContent(name: string, version = '1.0.0', desc = 'test'): string {
  return `export default { name: '${name}', version: '${version}', description: '${desc}', systemPrompt: 'Be ${name}.', source: 'file' }`
}

/** Minimal valid role YAML content */
function roleContent(name: string): string {
  return `name: ${name}\ndescription: test role ${name}\n`
}

/** Minimal valid tool file content */
function toolContent(name: string): string {
  return `export default { name: '${name}', description: 'tool ${name}', parameters: { type: 'object', properties: {} }, execute: async () => ({ success: true, output: '${name}' }) }`
}

// ── Tests ──────────────────────────────────────────────

describe('Scope + Skills integration', () => {
  beforeEach(() => cleanAll('skills'))
  afterEach(() => cleanAll('skills'))

  it('loads skills from user scope', async () => {
    writeAt('user', 'skills', 'my-skill.ts', skillContent('my-skill'))
    const { scanSkills, listSkills } = await import('../extension/skills/registry.js')
    await scanSkills()
    const skills = await listSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].def.name).toBe('my-skill')
  })

  it('loads skills from all three scopes', async () => {
    if (!canWriteGlobal()) return
    writeAt('global', 'skills', 'g-skill.ts', skillContent('g-skill'))
    writeAt('user', 'skills', 'u-skill.ts', skillContent('u-skill'))
    writeAt('project', 'skills', 'p-skill.ts', skillContent('p-skill'))
    const { scanSkills, listSkills } = await import('../extension/skills/registry.js')
    await scanSkills()
    const skills = await listSkills()
    expect(skills).toHaveLength(3)
    const names = skills.map((s) => s.def.name).sort()
    expect(names).toEqual(['g-skill', 'p-skill', 'u-skill'])
  })

  it('project scope skill overrides user scope on name conflict', async () => {
    writeAt('user', 'skills', 'common.ts', skillContent('common', '1.0.0', 'user version'))
    writeAt('project', 'skills', 'common.ts', skillContent('common', '2.0.0', 'project version'))
    const { scanSkills, getSkill } = await import('../extension/skills/registry.js')
    await scanSkills()
    const skill = await getSkill('common')
    expect(skill).toBeDefined()
    expect(skill!.def.version).toBe('2.0.0')
    expect(skill!.def.description).toBe('project version')
  })

  it('user scope skill overrides global on name conflict', async () => {
    if (!canWriteGlobal()) return
    writeAt('global', 'skills', 'base.ts', skillContent('base', '1.0.0', 'global'))
    writeAt('user', 'skills', 'base.ts', skillContent('base', '1.0.0', 'user'))
    const { scanSkills, getSkill } = await import('../extension/skills/registry.js')
    await scanSkills()
    const skill = await getSkill('base')
    expect(skill!.def.description).toBe('user')
  })

  it('refreshSkills re-scans all scopes', async () => {
    writeAt('user', 'skills', 'v1.ts', skillContent('v1'))
    const { scanSkills, listSkills, refreshSkills } = await import('../extension/skills/registry.js')
    await scanSkills()
    expect((await listSkills()).length).toBe(1)

    writeAt('project', 'skills', 'v2.ts', skillContent('v2'))
    await refreshSkills()
    expect((await listSkills()).length).toBe(2)
  })
})

describe('Scope + Roles integration', () => {
  beforeEach(() => cleanAll('rules'))
  afterEach(() => cleanAll('rules'))

  it('loads roles from user scope', async () => {
    writeAt('user', 'rules', 'dev.yaml', roleContent('dev'))
    const { scanRules, listRules } = await import('../extension/rules/registry.js')
    await scanRules()
    const roles = await listRules()
    expect(roles).toHaveLength(1)
    expect(roles[0].name).toBe('dev')
  })

  it('loads roles from all three scopes', async () => {
    if (!canWriteGlobal()) return
    writeAt('global', 'rules', 'g.yaml', roleContent('global-role'))
    writeAt('user', 'rules', 'u.yaml', roleContent('user-role'))
    writeAt('project', 'rules', 'p.yaml', roleContent('project-role'))
    const { scanRules, listRules } = await import('../extension/rules/registry.js')
    await scanRules()
    const roles = await listRules()
    expect(roles).toHaveLength(3)
  })

  it('project scope role overrides user scope on name conflict', async () => {
    writeAt('user', 'rules', 'ops.yaml', `${roleContent('ops')}\nsystemPrompt: user-prompt\n`)
    writeAt('project', 'rules', 'ops.yaml', `${roleContent('ops')}\nsystemPrompt: project-prompt\n`)
    const { scanRules, getRule } = await import('../extension/rules/registry.js')
    await scanRules()
    const role = await getRule('ops')
    expect(role).toBeDefined()
    expect(role!.systemPrompt).toBe('project-prompt')
  })

  it('loads roles from .ts, .yaml, and .json across scopes', async () => {
    writeAt('user', 'rules', 'a.yaml', roleContent('role-a'))
    writeAt('project', 'rules', 'b.ts', `export default { name: 'role-b', description: 'ts role' }`)
    writeAt('project', 'rules', 'c.json', JSON.stringify({ name: 'role-c', description: 'json role' }))
    const { scanRules, listRules } = await import('../extension/rules/registry.js')
    await scanRules()
    expect(await listRules()).toHaveLength(3)
  })
})

describe('Scope + Tools integration', () => {
  beforeEach(() => cleanAll('tools'))
  afterEach(() => cleanAll('tools'))

  it('loads tools from user scope', async () => {
    writeAt('user', 'tools', 'greet.ts', toolContent('greet'))
    const { loadUserTools } = await import('../extension/tools/loader.js')
    const count = await loadUserTools()
    expect(count).toBe(1)
  })

  it('loads tools from all three scopes', async () => {
    if (!canWriteGlobal()) return
    writeAt('global', 'tools', 'g-tool.ts', toolContent('g-tool'))
    writeAt('user', 'tools', 'u-tool.ts', toolContent('u-tool'))
    writeAt('project', 'tools', 'p-tool.ts', toolContent('p-tool'))
    const { loadUserTools } = await import('../extension/tools/loader.js')
    const count = await loadUserTools()
    expect(count).toBe(3)
  })

  it('project scope tool overrides user scope on name conflict', async () => {
    writeAt('user', 'tools', 'helper.ts', toolContent('helper'))
    writeAt('project', 'tools', 'helper.ts', toolContent('helper'))
    const { loadUserTools } = await import('../extension/tools/loader.js')
    const count = await loadUserTools()
    expect(count).toBe(1) // deduped by name
  })
})

describe('Scope + MCP config integration', () => {
  beforeEach(() => cleanAll(''))
  afterEach(() => cleanAll(''))

  it('loads config from user scope only', async () => {
    writeAt('user', '', 'mcp.config.json', JSON.stringify({ servers: { s1: { command: 'echo' } } }))
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ servers: Record<string, unknown> }>('mcp.config.json')
    expect(result.servers).toBeDefined()
    expect((result.servers as Record<string, unknown>).s1).toBeDefined()
  })

  it('merges config from all three scopes', async () => {
    if (!canWriteGlobal()) return
    writeAt(
      'global',
      '',
      'mcp.config.json',
      JSON.stringify({
        servers: { base: { command: 'base' } },
      }),
    )
    writeAt(
      'user',
      '',
      'mcp.config.json',
      JSON.stringify({
        servers: { userSrv: { command: 'user-only' } },
      }),
    )
    writeAt(
      'project',
      '',
      'mcp.config.json',
      JSON.stringify({
        servers: { projSrv: { command: 'proj-only' } },
      }),
    )
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ servers: Record<string, unknown> }>('mcp.config.json')
    const srvs = result.servers as Record<string, unknown>
    expect(Object.keys(srvs)).toHaveLength(3)
    expect((srvs.base as Record<string, unknown>).command).toBe('base')
    expect((srvs.userSrv as Record<string, unknown>).command).toBe('user-only')
    expect((srvs.projSrv as Record<string, unknown>).command).toBe('proj-only')
  })

  it('project config overrides user config for same server', async () => {
    writeAt(
      'user',
      '',
      'mcp.config.json',
      JSON.stringify({
        servers: { s1: { command: 'old-cmd', args: ['--old'] } },
      }),
    )
    writeAt(
      'project',
      '',
      'mcp.config.json',
      JSON.stringify({
        servers: { s1: { command: 'new-cmd' } },
      }),
    )
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ servers: Record<string, unknown> }>('mcp.config.json')
    const s1 = (result.servers as Record<string, unknown>).s1 as Record<string, unknown>
    expect(s1.command).toBe('new-cmd')
    expect(s1.args).toEqual(['--old']) // from user, untouched by project
  })
})

describe('Scope + Skills Runner integration', () => {
  beforeEach(() => cleanAll('skills'))
  afterEach(() => cleanAll('skills'))

  it('SkillRunner activates skills loaded from any scope', async () => {
    writeAt('user', 'skills', 'from-user.ts', skillContent('from-user'))
    writeAt('project', 'skills', 'from-project.ts', skillContent('from-project'))
    const { scanSkills } = await import('../extension/skills/registry.js')
    await scanSkills()

    const { SkillRunner } = await import('../extension/skills/runner.js')
    const runner = new SkillRunner()
    await runner.activateSkills(['from-user', 'from-project'])
    expect(runner.getActiveSkills()).toHaveLength(2)
  })

  it('SkillRunner resolves name conflict using project scope', async () => {
    writeAt('user', 'skills', 'conflict.ts', skillContent('conflict', '1.0.0', 'user'))
    writeAt('project', 'skills', 'conflict.ts', skillContent('conflict', '2.0.0', 'project'))
    const { scanSkills } = await import('../extension/skills/registry.js')
    await scanSkills()

    const { SkillRunner } = await import('../extension/skills/runner.js')
    const runner = new SkillRunner()
    await runner.activateSkills(['conflict'])
    expect(runner.getActiveSkills()).toHaveLength(1)
    expect(runner.getActiveSkills()[0].def.version).toBe('2.0.0')
    expect(runner.getActiveSkills()[0].def.description).toBe('project')
  })
})
