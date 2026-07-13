/**
 * Unit tests — bootstrap.ts
 *
 * Tests registerTypes (pure function) and bootstrap() orchestrator.
 * validateAll / injectApiKeys depend on fs module mocking which is
 * unreliable with ESM imports — covered by integration tests.
 */

import { describe, expect, it } from 'bun:test'

// ── registerTypes ───────────────────────────────────────

describe('registerTypes', () => {
  it('返回 agent type 注册列表', async () => {
    const { registerTypes } = await import('../extension/bootstrap.js')
    const types = registerTypes()
    expect(Array.isArray(types)).toBe(true)
    expect(types.length).toBeGreaterThan(0)
  })

  it('每个注册项包含必要字段', async () => {
    const { registerTypes } = await import('../extension/bootstrap.js')
    const types = registerTypes()
    for (const t of types) {
      expect(t).toHaveProperty('name')
      expect(t).toHaveProperty('displayName')
      expect(t).toHaveProperty('description')
      expect(t).toHaveProperty('model')
      expect(t).toHaveProperty('maxTurns')
      expect(t).toHaveProperty('builtinToolNames')
      expect(t).toHaveProperty('systemPrompt')
    }
  })

  it('包含 coding agent type', async () => {
    const { registerTypes } = await import('../extension/bootstrap.js')
    const types = registerTypes()
    const coding = types.find((t) => t.name === 'coding')
    expect(coding).toBeDefined()
    expect(coding!.displayName).toBeTruthy()
  })

  it('返回的所有 name 唯一', async () => {
    const { registerTypes } = await import('../extension/bootstrap.js')
    const types = registerTypes()
    const names = types.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

// ── bootstrap ──────────────────────────────────────────

describe('bootstrap', () => {
  it('全 skip 时返回 BootstrapResult', async () => {
    const { bootstrap } = await import('../extension/bootstrap.js')
    const result = await bootstrap({ skipApiKeys: true, skipValidation: true, skipTypes: true, skipMCP: true, skipHooks: true })
    expect(result).toHaveProperty('apiKeys')
    expect(result).toHaveProperty('validation')
    expect(result).toHaveProperty('types')
    expect(result).toHaveProperty('mcp')
    expect(result).toHaveProperty('hooks')
    expect(result.apiKeys).toBe(false)
    expect(result.validation.errors).toBe(0)
    expect(result.types).toBe(0)
    expect(result.mcp).toBe(false)
    expect(result.hooks).toBe(false)
  })

  it('只注册 types', async () => {
    const { bootstrap } = await import('../extension/bootstrap.js')
    const result = await bootstrap({ skipApiKeys: true, skipValidation: true, skipMCP: true, skipHooks: true })
    expect(result.apiKeys).toBe(false)
    expect(result.types).toBeGreaterThan(0)
  })

  it('只做 validation', async () => {
    const { bootstrap } = await import('../extension/bootstrap.js')
    const result = await bootstrap({ skipApiKeys: true, skipMCP: true, skipHooks: true, skipTypes: true })
    expect(result.validation).toBeDefined()
    expect(typeof result.validation.errors).toBe('number')
    expect(typeof result.validation.warnings).toBe('number')
  })

  it('不 skip 时按默认顺序执行', async () => {
    const { bootstrap } = await import('../extension/bootstrap.js')
    // 默认执行所有步骤（无 skip），但需要环境干净
    const result = await bootstrap({ skipMCP: true, skipHooks: true })
    // apiKeys 不会报错（无 config 文件时静默跳过）
    expect(result.apiKeys).toBe(true)
    // types 应该注册
    expect(result.types).toBeGreaterThan(0)
  })
})
