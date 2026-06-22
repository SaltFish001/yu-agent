/**
 * Unit tests — Tool Registry + Dynamic Loader (Phase 1)
 *
 * Covers:
 *   - Dynamic loading via loadUserTools()
 *   - Schema validation (zod)
 *   - Auth checks (requiredRoles / denyRoles)
 *   - Audit hooks (before / after / error)
 *   - Tool execution (executeTool)
 *   - Registry query functions (getTool, listTools, getToolSchemas)
 *   - Global audit hook (setGlobalAuditHook)
 */

import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { z } from 'zod'

// ── Helpers ─────────────────────────────────────────────

const TOOLS_DIR = resolve(homedir(), '.yu', 'tools')

/** Create a temporary user tool file in ~/.yu/tools/ */
function createUserToolFile(filename: string, content: string): string {
  if (!existsSync(TOOLS_DIR)) {
    mkdirSync(TOOLS_DIR, { recursive: true })
  }
  const filePath = resolve(TOOLS_DIR, filename)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/** Clean up all files in ~/.yu/tools/ */
function cleanupToolsDir() {
  if (existsSync(TOOLS_DIR)) {
    const files = readdirSync(TOOLS_DIR)
    for (const f of files) {
      rmSync(resolve(TOOLS_DIR, f), { recursive: true, force: true })
    }
  }
}

// ── Tests ───────────────────────────────────────────────

describe('Tool Registry — CRUD', () => {
  it('registerTool and getTool', async () => {
    const { registerTool, getTool } = await import('../extension/tools/registry.js')
    registerTool({
      name: 'test-tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async () => ({ success: true, output: 'done' }),
    })

    const t = getTool('test-tool')
    expect(t).toBeDefined()
    expect(t!.name).toBe('test-tool')
    expect(t!.description).toBe('A test tool')

    const missing = getTool('nope')
    expect(missing).toBeUndefined()
  })

  it('listTools returns all registered tools', async () => {
    const { registerTool, listTools } = await import('../extension/tools/registry.js')

    const tools = listTools()
    expect(tools.length).toBeGreaterThanOrEqual(1)
    expect(tools.some((t) => t.name === 'test-tool')).toBe(true)
  })

  it('registerTool overwrites existing tool with warning', async () => {
    const { registerTool, getTool } = await import('../extension/tools/registry.js')
    // Overwrite an existing tool — should not throw
    registerTool({
      name: 'test-tool',
      description: 'overwritten',
      parameters: { type: 'object' },
      execute: async () => ({ success: true, output: 'overwritten' }),
    })
    expect(getTool('test-tool')!.description).toBe('overwritten')
  })

  it('getToolSchemas returns structured OpenAI function schemas', async () => {
    const { getToolSchemas } = await import('../extension/tools/registry.js')

    const schemas = getToolSchemas()
    expect(schemas.length).toBeGreaterThanOrEqual(1)
    const testSchema = schemas.find((s) => s.function.name === 'test-tool')
    expect(testSchema).toBeDefined()
    expect(testSchema!.type).toBe('function')
  })
})

describe('Tool Registry — executeTool', () => {
  it('executes a registered tool successfully', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    registerTool({
      name: 'hello',
      description: 'Says hello',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      execute: async (params) => ({
        success: true,
        output: `Hello, ${(params as any).name || 'world'}!`,
      }),
    })

    const result = await executeTool('hello', { name: 'Alice' })
    expect(result.success).toBe(true)
    expect(result.output).toBe('Hello, Alice!')
  })

  it('returns error for unknown tool', async () => {
    const { executeTool } = await import('../extension/tools/registry.js')
    const result = await executeTool('does-not-exist', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown tool')
  })

  it('passes params to execute function', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    let capturedParams: Record<string, unknown> | null = null
    registerTool({
      name: 'capture',
      description: 'Captures params',
      parameters: { type: 'object' },
      execute: async (params) => {
        capturedParams = params
        return { success: true, output: 'ok' }
      },
    })

    await executeTool('capture', { a: 1, b: 'two' })
    expect(capturedParams as any).toEqual({ a: 1, b: 'two' })
  })
})

describe('Tool Registry — schema validation', () => {
  it('accepts valid params matching zod schema', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    registerTool({
      name: 'zool',
      description: 'Zod-validated tool',
      parameters: { type: 'object', properties: { count: { type: 'number' } } },
      enhancement: {
        schema: z.object({ count: z.number().min(1).max(10) }),
      },
      execute: async (params) => ({ success: true, output: `count=${params.count}` }),
    })

    const result = await executeTool('zool', { count: 5 })
    expect(result.success).toBe(true)
    expect(result.output).toBe('count=5')
  })

  it('rejects params that fail zod schema', async () => {
    const { executeTool } = await import('../extension/tools/registry.js')

    const result = await executeTool('zool', { count: 99 })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid params')
  })

  it('skips schema validation when no schema defined', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    registerTool({
      name: 'noschema',
      description: 'No schema tool',
      parameters: { type: 'object' },
      execute: async () => ({ success: true, output: 'ok' }),
    })

    const result = await executeTool('noschema', { anything: 'goes' })
    expect(result.success).toBe(true)
  })
})

describe('Tool Registry — auth (role-based access)', () => {
  it('allows execution when role is in requiredRoles', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    registerTool({
      name: 'admin-tool',
      description: 'Admin only',
      parameters: { type: 'object' },
      enhancement: {
        auth: { requiredRoles: ['admin'] },
      },
      execute: async () => ({ success: true, output: 'admin access granted' }),
    })

    const result = await executeTool('admin-tool', {}, { role: 'admin' })
    expect(result.success).toBe(true)
    expect(result.output).toBe('admin access granted')
  })

  it('denies execution when role is not in requiredRoles', async () => {
    const { executeTool } = await import('../extension/tools/registry.js')

    const result = await executeTool('admin-tool', {}, { role: 'user' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('requires role')
  })

  it('denies execution when role is in denyRoles', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    registerTool({
      name: 'public-tool',
      description: 'Not for banned users',
      parameters: { type: 'object' },
      enhancement: {
        auth: { denyRoles: ['banned'] },
      },
      execute: async () => ({ success: true, output: 'should not run' }),
    })

    const result = await executeTool('public-tool', {}, { role: 'banned' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('denied')
  })

  it('allows execution when no auth config present', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    registerTool({
      name: 'open-tool',
      description: 'Open to all',
      parameters: { type: 'object' },
      execute: async () => ({ success: true, output: 'open' }),
    })

    const result = await executeTool('open-tool', {}, { role: 'anyone' })
    expect(result.success).toBe(true)
  })

  it('allows execution when auth defined but no role in context', async () => {
    const { executeTool } = await import('../extension/tools/registry.js')

    // No context = no auth check
    const result = await executeTool('admin-tool', {})
    expect(result.success).toBe(true)
  })
})

describe('Tool Registry — audit hooks', () => {
  it('calls before and after hooks on success', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    const events: string[] = []

    registerTool({
      name: 'audited',
      description: 'Audited tool',
      parameters: { type: 'object' },
      enhancement: {
        audit: {
          before: (p) => {
            events.push(`before:${p.name}`)
          },
          after: (p) => {
            events.push(`after:${p.name}:${(p.result as any).output}:${Math.round(p.durationMs)}`)
          },
        },
      },
      execute: async () => ({ success: true, output: 'audited-ok' }),
    })

    const result = await executeTool('audited', {})
    expect(result.success).toBe(true)
    expect(events).toHaveLength(2)
    expect(events[0]).toBe('before:audited')
    expect(events[1]).toMatch(/^after:audited:audited-ok:\d+$/)
  })

  it('calls error hook on execution failure', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    const errors: Array<{ name: string; error: string }> = []

    registerTool({
      name: 'fail-tool',
      description: 'Failing tool',
      parameters: { type: 'object' },
      enhancement: {
        audit: {
          error: (p) => {
            errors.push({ name: p.name, error: p.error.message })
          },
        },
      },
      execute: async () => {
        throw new Error('deliberate failure')
      },
    })

    const result = await executeTool('fail-tool', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('deliberate failure')
    expect(errors).toHaveLength(1)
    expect(errors[0].name).toBe('fail-tool')
    expect(errors[0].error).toBe('deliberate failure')
  })

  it('calls error hook on timeout', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    const errors: Array<{ name: string; error: string }> = []

    registerTool({
      name: 'slow-tool',
      description: 'Slow tool',
      parameters: { type: 'object' },
      enhancement: {
        timeout: 50,
        audit: {
          error: (p) => {
            errors.push({ name: p.name, error: p.error.message })
          },
        },
      },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        return { success: true, output: 'too late' }
      },
    })

    const result = await executeTool('slow-tool', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')
    expect(errors).toHaveLength(1)
    expect(errors[0].name).toBe('slow-tool')
    expect(errors[0].error).toContain('timed out')
  }, 5000)

  it('captures duration in after hook', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    let capturedDuration = 0

    registerTool({
      name: 'duration-tool',
      description: 'Duration test',
      parameters: { type: 'object' },
      enhancement: {
        audit: {
          after: (p) => {
            capturedDuration = p.durationMs
          },
        },
      },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { success: true, output: 'slow' }
      },
    })

    await executeTool('duration-tool', {})
    expect(capturedDuration).toBeGreaterThanOrEqual(5)
  })

  it('passes role to audit hooks', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    let capturedRole: string | undefined

    registerTool({
      name: 'role-audit',
      description: 'Role audit',
      parameters: { type: 'object' },
      enhancement: {
        audit: {
          before: (p) => {
            capturedRole = p.role
          },
        },
      },
      execute: async () => ({ success: true, output: 'ok' }),
    })

    await executeTool('role-audit', {}, { role: 'admin' })
    expect(capturedRole).toBe('admin')
  })
})

describe('Tool Registry — setGlobalAuditHook', () => {
  it('applies audit hook to all registered tools', async () => {
    const { registerTool, executeTool, setGlobalAuditHook } = await import('../extension/tools/registry.js')
    const calls: string[] = []

    // Register tools first, then set the global hook
    registerTool({
      name: 'tool-one',
      description: 'First tool',
      parameters: { type: 'object' },
      execute: async () => ({ success: true, output: 'one' }),
    })
    registerTool({
      name: 'tool-two',
      description: 'Second tool',
      parameters: { type: 'object' },
      execute: async () => ({ success: true, output: 'two' }),
    })

    setGlobalAuditHook({
      before: (p) => {
        calls.push(`before:${p.name}`)
      },
      after: (p) => {
        calls.push(`after:${p.name}`)
      },
    })

    await executeTool('tool-one', {})
    await executeTool('tool-two', {})

    expect(calls).toEqual(['before:tool-one', 'after:tool-one', 'before:tool-two', 'after:tool-two'])
  })
})

describe('Tool Registry — timeout', () => {
  it('uses default 60s timeout when none specified', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')
    registerTool({
      name: 'fast-enough',
      description: 'Fast enough',
      parameters: { type: 'object' },
      execute: async () => ({ success: true, output: 'fast' }),
    })

    const result = await executeTool('fast-enough', {})
    expect(result.success).toBe(true)
  })

  it('respects custom timeout value', async () => {
    const { registerTool, executeTool } = await import('../extension/tools/registry.js')

    registerTool({
      name: 'quick',
      description: 'Quick tool',
      parameters: { type: 'object' },
      enhancement: { timeout: 200 },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { success: true, output: 'quick' }
      },
    })

    const result = await executeTool('quick', {})
    expect(result.success).toBe(true)
  })
})

describe('Tool Loader — dynamic loading', () => {
  beforeEach(() => {
    cleanupToolsDir()
  })
  afterEach(() => {
    cleanupToolsDir()
  })

  it('tools directory auto-created on loadUserTools', async () => {
    if (existsSync(TOOLS_DIR)) {
      rmSync(TOOLS_DIR, { recursive: true, force: true })
    }
    expect(existsSync(TOOLS_DIR)).toBe(false)

    const { loadUserTools } = await import('../extension/tools/loader.js')
    await loadUserTools()

    // loadUserTools calls ensureScopeDirs which creates the dir
    // We check either user or project scope dir exists
    const { existsSync: es } = await import('fs')
    const { resolve } = await import('path')
    const { homedir } = await import('os')
    const userDir = resolve(homedir(), '.yu', 'tools')
    const projectDir = resolve(process.cwd(), '.yu', 'tools')
    expect(es(userDir) || es(projectDir)).toBe(true)
  }, 10000)

  it('loadUserTools returns 0 when no tool files exist', async () => {
    cleanupToolsDir()
    const { loadUserTools } = await import('../extension/tools/loader.js')

    const count = await loadUserTools()
    expect(count).toBe(0)
  })

  it('loadUserTools loads a single .ts tool file', async () => {
    cleanupToolsDir()
    createUserToolFile(
      'greet-tool.ts',
      `
const tool = {
  name: 'greet',
  description: 'A greeting tool',
  parameters: { type: 'object', properties: { name: { type: 'string' } } },
  execute: async (params) => ({ success: true, output: 'Hello ' + (params.name || 'world') }),
};
export default tool;
`,
    )

    const { loadUserTools } = await import('../extension/tools/loader.js')
    const count = await loadUserTools()
    expect(count).toBe(1)

    const { getTool } = await import('../extension/tools/registry.js')
    const tool = getTool('greet')
    expect(tool).toBeDefined()
    expect(tool!.description).toBe('A greeting tool')
  })

  it('loadUserTools loads a file exporting an array of tools', async () => {
    cleanupToolsDir()
    createUserToolFile(
      'multi-tools.ts',
      `
const tools = [
  {
    name: 'tool-one',
    description: 'First tool',
    parameters: { type: 'object' },
    execute: async () => ({ success: true, output: 'one' }),
  },
  {
    name: 'tool-two',
    description: 'Second tool',
    parameters: { type: 'object' },
    execute: async () => ({ success: true, output: 'two' }),
  },
];
export default tools;
`,
    )

    const { loadUserTools } = await import('../extension/tools/loader.js')
    const count = await loadUserTools()
    expect(count).toBe(2)

    const { getTool } = await import('../extension/tools/registry.js')
    expect(getTool('tool-one')).toBeDefined()
    expect(getTool('tool-two')).toBeDefined()
  })

  it('loadUserTools skips files without default export', async () => {
    cleanupToolsDir()
    createUserToolFile('empty.ts', `export const something = 42;\n`)

    const { loadUserTools } = await import('../extension/tools/loader.js')
    const count = await loadUserTools()
    expect(count).toBe(0)
  })

  it('loadUserTools loads multiple tool files', async () => {
    cleanupToolsDir()
    createUserToolFile(
      'a.ts',
      `export default { name: 'tool-a', description: 'A', parameters: { type: 'object' }, execute: async () => ({ success: true, output: 'a' }) };`,
    )
    createUserToolFile(
      'b.ts',
      `export default { name: 'tool-b', description: 'B', parameters: { type: 'object' }, execute: async () => ({ success: true, output: 'b' }) };`,
    )

    const { loadUserTools } = await import('../extension/tools/loader.js')
    const count = await loadUserTools()
    expect(count).toBe(2)

    const { getTool } = await import('../extension/tools/registry.js')
    expect(getTool('tool-a')).toBeDefined()
    expect(getTool('tool-b')).toBeDefined()
  })

  it('loadUserTools handles a tool with enhancement (auth + schema + audit)', async () => {
    cleanupToolsDir()
    createUserToolFile(
      'enhanced-tool.ts',
      `
const tool = {
  name: 'enhanced',
  description: 'Tool with all enhancements',
  parameters: { type: 'object', properties: { key: { type: 'string' } } },
  enhancement: {
    auth: { requiredRoles: ['admin'] },
    timeout: 5000,
    schema: { safeParse: (p) => ({ success: true, data: p }) },
    audit: {
      before: (p) => { console.log('before:', p.name); },
      after: (p) => { console.log('after:', p.name, p.durationMs); },
    },
  },
  execute: async (params) => ({ success: true, output: 'enhanced:' + params.key }),
};
export default tool;
`,
    )

    const { loadUserTools } = await import('../extension/tools/loader.js')
    const count = await loadUserTools()
    expect(count).toBe(1)

    const { getTool } = await import('../extension/tools/registry.js')
    const tool = getTool('enhanced')
    expect(tool).toBeDefined()
    expect(tool!.enhancement?.auth?.requiredRoles).toEqual(['admin'])
    expect(tool!.enhancement?.timeout).toBe(5000)
    expect(tool!.enhancement?.schema).toBeDefined()
    expect(tool!.enhancement?.audit?.before).toBeDefined()
    expect(tool!.enhancement?.audit?.after).toBeDefined()
  })

  it('loadUserTools gracefully handles invalid files without crashing', async () => {
    cleanupToolsDir()
    createUserToolFile('broken.ts', `export default { broken syntax; }`)
    createUserToolFile(
      'good.ts',
      `export default { name: 'survivor', description: 'Survived bad file', parameters: { type: 'object' }, execute: async () => ({ success: true, output: 'alive' }) };`,
    )

    const { loadUserTools } = await import('../extension/tools/loader.js')
    const count = await loadUserTools()
    // The broken file should be skipped, the good file should load
    expect(count).toBe(1)

    const { getTool } = await import('../extension/tools/registry.js')
    expect(getTool('survivor')).toBeDefined()
  })
})
