/**
 * Unit tests — Scope layer (global / user / project)
 *
 * Tests path resolution, file scanning, config merging, and priority ordering.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

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

function cleanScope(subdir: string): void {
  for (const dir of [USER_SCOPE, PROJECT_SCOPE]) {
    const target = resolve(dir, subdir)
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true })
    }
  }
  if (canWriteGlobal()) {
    const target = resolve(GLOBAL_SCOPE, subdir)
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true })
    }
  }
}

function writeScopeFileAt(scope: 'global' | 'user' | 'project', subdir: string, name: string, content: string): string {
  if (scope === 'global' && !canWriteGlobal()) {
    throw new Error('Cannot write to global scope (not root)')
  }
  const base = scope === 'global' ? GLOBAL_SCOPE : scope === 'project' ? PROJECT_SCOPE : USER_SCOPE
  const dir = resolve(base, subdir)
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, name)
  writeFileSync(path, content, 'utf-8')
  return path
}

// ── Tests ──────────────────────────────────────────────

describe('Scope paths', () => {
  it('getScopeDirs returns three levels', async () => {
    const { getScopeDirs } = await import('../extension/scope.js')
    const dirs = getScopeDirs()
    expect(dirs.global).toBe('/etc/yu')
    expect(dirs.user).toBe(resolve(homedir(), '.yu'))
    expect(dirs.project).toBe(resolve(process.cwd(), '.yu'))
  })

  it('scopeSubdir returns correct subdirectory', async () => {
    const { scopeSubdir } = await import('../extension/scope.js')
    expect(scopeSubdir('global', 'skills')).toBe('/etc/yu/skills')
    expect(scopeSubdir('user', 'tools')).toBe(resolve(homedir(), '.yu', 'tools'))
    expect(scopeSubdir('project', 'roles')).toBe(resolve(process.cwd(), '.yu', 'roles'))
  })

  it('SCOPE_PRIORITY is project-first (descending priority)', async () => {
    const { SCOPE_PRIORITY } = await import('../extension/scope.js')
    expect(SCOPE_PRIORITY).toEqual(['project', 'user', 'global'])
  })

  it('SCOPE_ASCENDING is global-first (ascending priority)', async () => {
    const { SCOPE_ASCENDING } = await import('../extension/scope.js')
    expect(SCOPE_ASCENDING).toEqual(['global', 'user', 'project'])
  })
})

describe('Scope file scanning', () => {
  beforeEach(() => {
    cleanScope('skills')
    cleanScope('roles')
  })

  afterEach(() => {
    cleanScope('skills')
    cleanScope('roles')
  })

  it('scanScopeFiles returns empty when no files exist', async () => {
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(0)
  })

  it('returns empty for nonexistent subdirectory', async () => {
    cleanScope('nonexistent_sub')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('nonexistent_sub', ['.ts'])
    expect(files).toHaveLength(0)
  })

  it('returns empty for empty extension list', async () => {
    writeScopeFileAt('user', 'skills', 'any.ts', '')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', [])
    expect(files).toHaveLength(0)
  })

  it('returns empty for empty directory', async () => {
    writeScopeFileAt('user', 'skills', '.gitkeep', '')
    const { scanScopeFiles } = await import('../extension/scope.js')
    // .gitkeep has no matching extension
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(0)
  })

  it('finds files in user scope', async () => {
    writeScopeFileAt('user', 'skills', 'hello.ts', 'export default {}')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(1)
    expect(files[0].scope).toBe('user')
    expect(files[0].stem).toBe('hello')
  })

  it('finds files in all three scopes', async () => {
    if (!canWriteGlobal()) return
    writeScopeFileAt('global', 'skills', 'g.ts', '')
    writeScopeFileAt('user', 'skills', 'u.ts', '')
    writeScopeFileAt('project', 'skills', 'p.ts', '')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(3)
    const scopes = files.map((f) => f.scope)
    expect(scopes).toContain('global')
    expect(scopes).toContain('user')
    expect(scopes).toContain('project')
  })

  it('project scope wins on name conflict', async () => {
    writeScopeFileAt('user', 'skills', 'common.ts', '')
    writeScopeFileAt('project', 'skills', 'common.ts', '')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(1)
    expect(files[0].scope).toBe('project')
    expect(files[0].stem).toBe('common')
  })

  it('user scope wins over global on name conflict (no project)', async () => {
    if (!canWriteGlobal()) return
    writeScopeFileAt('global', 'skills', 'overlap.ts', '')
    writeScopeFileAt('user', 'skills', 'overlap.ts', '')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(1)
    expect(files[0].scope).toBe('user')
  })

  it('filters by extension', async () => {
    writeScopeFileAt('user', 'roles', 'a.yaml', 'name: a')
    writeScopeFileAt('user', 'roles', 'b.ts', '')
    writeScopeFileAt('user', 'roles', 'c.json', '{}')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const yaml = scanScopeFiles('roles', ['.yaml', '.yml'])
    expect(yaml).toHaveLength(1)
    expect(yaml[0].stem).toBe('a')

    const ts = scanScopeFiles('roles', ['.ts'])
    expect(ts).toHaveLength(1)
    expect(ts[0].stem).toBe('b')

    const all = scanScopeFiles('roles', ['.yaml', '.yml', '.ts', '.json'])
    expect(all).toHaveLength(3)
  })

  it('matches files with mixed-case extensions', async () => {
    writeScopeFileAt('user', 'skills', 'hello.TS', '')
    writeScopeFileAt('user', 'skills', 'world.Ts', '')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(2)
  })

  it('ignores files without matching extension', async () => {
    writeScopeFileAt('user', 'skills', 'readme.md', '# docs')
    writeScopeFileAt('user', 'skills', 'data.json', '{}')
    writeScopeFileAt('user', 'skills', 'script.py', 'print("hello")')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(0)
  })

  it('finds dotfiles with matching extension', async () => {
    writeScopeFileAt('user', 'skills', '.hidden.ts', '')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(1)
    expect(files[0].stem).toBe('.hidden')
  })

  it('returns correct ScopedFile metadata', async () => {
    writeScopeFileAt('user', 'skills', 'my-skill.ts', '')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files[0]).toMatchObject({
      scope: 'user',
      stem: 'my-skill',
      name: 'my-skill.ts',
    })
    expect(files[0].path).toContain('.yu/skills/my-skill.ts')
    expect(files[0].path).toBe(resolve(USER_SCOPE, 'skills', 'my-skill.ts'))
  })

  it('handles project scope missing without crashing', async () => {
    // cleanScope removes project-scope dir
    cleanScope('skills')
    writeScopeFileAt('user', 'skills', 'only-user.ts', '')
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(1)
    expect(files[0].scope).toBe('user')
  })
})

describe('Scope config merging', () => {
  beforeEach(() => {
    cleanScope('')
  })

  afterEach(() => {
    cleanScope('')
  })

  it('mergeJsonConfig returns empty object when no config exists', async () => {
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig('mcp.config.json')
    expect(result).toEqual({})
  })

  it('returns empty object when config is empty JSON object', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', '{}')
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig('mcp.config.json')
    expect(result).toEqual({})
  })

  it('skips invalid JSON files without crashing', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', 'this is not json')
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig('mcp.config.json')
    expect(result).toEqual({})
  })

  it('skips non-dict JSON values without crashing', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', JSON.stringify('just a string'))
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig('mcp.config.json')
    expect(result).toEqual({})
  })

  it('skips array JSON without crashing', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', JSON.stringify([1, 2, 3]))
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig('mcp.config.json')
    expect(result).toEqual({})
  })

  it('skips malformed JSON at one scope, uses valid from another', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', 'not-json')
    writeScopeFileAt('project', '', 'mcp.config.json', JSON.stringify({ servers: { s1: { command: 'ok' } } }))
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ servers: Record<string, unknown> }>('mcp.config.json')
    const srvs = result.servers as Record<string, unknown>
    expect((srvs.s1 as Record<string, unknown>).command).toBe('ok')
  })

  it('merges from one scope', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', JSON.stringify({ servers: { s1: { command: 'echo' } } }))
    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ servers: Record<string, unknown> }>('mcp.config.json')
    expect(result.servers).toBeDefined()
    expect((result.servers as Record<string, unknown>).s1).toBeDefined()
  })

  it('project overrides user config (deep merge)', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', JSON.stringify({
      servers: {
        common: { command: 'old-cmd', args: ['--old'] },
        extra: { command: 'keep-me' },
      },
    }))
    writeScopeFileAt('project', '', 'mcp.config.json', JSON.stringify({
      servers: {
        common: { command: 'new-cmd', args: ['--new'] },
        newone: { command: 'new-srv' },
      },
    }))

    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ servers: Record<string, unknown> }>('mcp.config.json')
    const srvs = result.servers as Record<string, unknown>

    const common = srvs.common as Record<string, unknown>
    expect(common.command).toBe('new-cmd')
    expect(common.args).toEqual(['--new'])

    const extra = srvs.extra as Record<string, unknown>
    expect(extra.command).toBe('keep-me')

    const newone = srvs.newone as Record<string, unknown>
    expect(newone.command).toBe('new-srv')
  })

  it('null value in higher scope overwrites lower scope value', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', JSON.stringify({
      servers: {
        s1: { command: 'old', env: { KEY: 'val' } },
      },
    }))
    writeScopeFileAt('project', '', 'mcp.config.json', JSON.stringify({
      servers: {
        s1: { command: null },
      },
    }))

    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ servers: Record<string, unknown> }>('mcp.config.json')
    const srvs = result.servers as Record<string, unknown>
    const s1 = srvs.s1 as Record<string, unknown>
    // null should overwrite — command becomes null
    expect(s1.command).toBeNull()
    // env from user survives because project didn't touch it
    expect((s1.env as Record<string, string>).KEY).toBe('val')
  })

  it('deeply nested objects merge correctly', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', JSON.stringify({
      logging: { console: { level: 'info', format: 'text' }, file: { level: 'warn' } },
    }))
    writeScopeFileAt('project', '', 'mcp.config.json', JSON.stringify({
      logging: { console: { level: 'debug' } },
    }))

    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ logging: Record<string, unknown> }>('mcp.config.json')
    const log = result.logging as Record<string, unknown>
    const consoleCfg = log.console as Record<string, unknown>
    expect(consoleCfg.level).toBe('debug') // project overrides
    expect(consoleCfg.format).toBe('text') // user value survives
    const fileCfg = log.file as Record<string, unknown>
    expect(fileCfg.level).toBe('warn') // untouched by project
  })

  it('arrays are overwritten not merged', async () => {
    writeScopeFileAt('user', '', 'mcp.config.json', JSON.stringify({
      servers: { s1: { command: 'cmd', allowedUsers: ['alice', 'bob'] } },
    }))
    writeScopeFileAt('project', '', 'mcp.config.json', JSON.stringify({
      servers: { s1: { allowedUsers: ['charlie'] } },
    }))

    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ servers: Record<string, unknown> }>('mcp.config.json')
    const s1 = (result.servers as Record<string, unknown>).s1 as Record<string, unknown>
    // Array should be replaced, not concatenated
    expect(s1.allowedUsers).toEqual(['charlie'])
    // command from user survives
    expect(s1.command).toBe('cmd')
  })

  it('three-level merge works', async () => {
    if (!canWriteGlobal()) return
    writeScopeFileAt('global', '', 'mcp.config.json', JSON.stringify({
      servers: {
        base: { command: 'base-cmd' },
        shared: { command: 'shared-global' },
      },
    }))
    writeScopeFileAt('user', '', 'mcp.config.json', JSON.stringify({
      servers: {
        shared: { command: 'shared-user' },
        userOnly: { command: 'user-only' },
      },
    }))
    writeScopeFileAt('project', '', 'mcp.config.json', JSON.stringify({
      servers: {
        userOnly: { command: 'project-override' },
        projOnly: { command: 'proj-only' },
      },
    }))

    const { mergeJsonConfig } = await import('../extension/scope.js')
    const result = mergeJsonConfig<{ servers: Record<string, unknown> }>('mcp.config.json')
    const srvs = result.servers as Record<string, unknown>

    expect((srvs.base as Record<string, unknown>).command).toBe('base-cmd')
    expect((srvs.shared as Record<string, unknown>).command).toBe('shared-user')
    expect((srvs.userOnly as Record<string, unknown>).command).toBe('project-override')
    expect((srvs.projOnly as Record<string, unknown>).command).toBe('proj-only')
  })
})

describe('Scope find & ensure', () => {
  afterEach(() => {
    cleanScope('tools')
  })

  it('findInScope returns null when not found', async () => {
    const { findInScope } = await import('../extension/scope.js')
    expect(findInScope('tools', 'nonexistent.ts')).toBeNull()
  })

  it('findInScope finds highest priority match', async () => {
    writeScopeFileAt('user', 'tools', 'my-tool.ts', '')
    const { findInScope } = await import('../extension/scope.js')
    const found = findInScope('tools', 'my-tool.ts')
    expect(found).toContain('.yu/tools/my-tool.ts')
  })

  it('findInScope prefers project over user', async () => {
    writeScopeFileAt('user', 'tools', 'common.ts', '')
    const projectPath = writeScopeFileAt('project', 'tools', 'common.ts', '')
    const { findInScope } = await import('../extension/scope.js')
    const found = findInScope('tools', 'common.ts')
    expect(found).toBe(projectPath)
  })

  it('findInScope returns path when target is a directory (existsSync behavior)', async () => {
    const dirPath = resolve(USER_SCOPE, 'tools', 'mysub')
    mkdirSync(dirPath, { recursive: true })
    const { findInScope } = await import('../extension/scope.js')
    const found = findInScope('tools', 'mysub')
    // existsSync returns true for directories, so findInScope returns the path
    expect(found).toBe(dirPath)
  })

  it('findInScope searches subdirectory paths', async () => {
    const nestedDir = resolve(USER_SCOPE, 'tools', 'nested')
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(resolve(nestedDir, 'subtool.ts'), '', 'utf-8')
    const { findInScope } = await import('../extension/scope.js')
    const found = findInScope('tools', 'nested/subtool.ts')
    expect(found).not.toBeNull()
    expect(found).toContain('.yu/tools/nested/subtool.ts')
  })

  it('ensureScopeDirs creates directories', async () => {
    cleanScope('tools')
    const { ensureScopeDirs } = await import('../extension/scope.js')
    ensureScopeDirs('tools')
    expect(existsSync(resolve(PROJECT_SCOPE, 'tools'))).toBe(true)
    expect(existsSync(resolve(USER_SCOPE, 'tools'))).toBe(true)
  })

  it('ensureScopeDirs is idempotent (no error on existing)', async () => {
    const { ensureScopeDirs } = await import('../extension/scope.js')
    // Call twice — second should not throw
    ensureScopeDirs('randomsub')
    ensureScopeDirs('randomsub')
    expect(existsSync(resolve(USER_SCOPE, 'randomsub'))).toBe(true)
    cleanScope('randomsub')
  })

  it('ensureScopeDirs creates nested subdirectories', async () => {
    const { ensureScopeDirs } = await import('../extension/scope.js')
    ensureScopeDirs('skills/deep/nested')
    expect(existsSync(resolve(PROJECT_SCOPE, 'skills/deep/nested'))).toBe(true)
    expect(existsSync(resolve(USER_SCOPE, 'skills/deep/nested'))).toBe(true)
    cleanScope('skills')
  })
})

describe('Scope — edge case: many files', () => {
  afterEach(() => {
    cleanScope('skills')
    cleanScope('roles')
  })

  it('scanScopeFiles handles many files across scopes', async () => {
    const count = 50
    for (let i = 0; i < count; i++) {
      writeScopeFileAt(i % 2 === 0 ? 'user' : 'project', 'skills', `file-${i}.ts`, '')
    }
    const { scanScopeFiles } = await import('../extension/scope.js')
    const files = scanScopeFiles('skills', ['.ts'])
    expect(files).toHaveLength(count)
  })

  it('handles mixed extensions with many files', async () => {
    for (let i = 0; i < 20; i++) {
      writeScopeFileAt('user', 'roles', `role-${i}.yaml`, `name: role-${i}`)
      writeScopeFileAt('user', 'roles', `role-${i}.json`, JSON.stringify({ name: `role-${i}` }))
    }
    const { scanScopeFiles } = await import('../extension/scope.js')
    const yamls = scanScopeFiles('roles', ['.yaml'])
    expect(yamls).toHaveLength(20)
    const jsons = scanScopeFiles('roles', ['.json'])
    expect(jsons).toHaveLength(20)
  })
})
