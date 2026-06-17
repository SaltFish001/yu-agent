/**
 * Unit tests — config.ts (agent type config + MCP validation)
 *
 * Tests validateEnvVars logic. validateMcpConfig reads from a fixed path
 * (~/.yu/mcp.config.json) and calls process.exit on failure, making it
 * unsuitable for unit testing without process mocking.
 */

import { describe, expect, it } from 'bun:test'

describe('validateEnvVars', () => {
  it('returns empty errors/warnings when MCP config has no servers', async () => {
    const { validateEnvVars } = await import('../extension/config.js')
    const result = validateEnvVars({ servers: {} })
    expect(result.errors).toEqual([])
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('returns empty errors/warnings when no MCP config is provided', async () => {
    const { validateEnvVars } = await import('../extension/config.js')
    const result = validateEnvVars()
    expect(result.errors).toEqual([])
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('flags missing required env vars from MCP config', async () => {
    const { validateEnvVars } = await import('../extension/config.js')
    // Code checks config key names that reference ${VAR} syntax
    // If config key matches an env var name and that var isn't set, it's an error
    const result = validateEnvVars({
      servers: {
        api1: {
          env: { API_KEY: '${API_KEY}', DB_URL: '${DB_URL}' },
        },
      },
    })

    expect(result.errors.length).toBeGreaterThanOrEqual(2)
    expect(result.errors.some((e) => e.includes('API_KEY'))).toBe(true)
    expect(result.errors.some((e) => e.includes('DB_URL'))).toBe(true)
  })

  it('skips env vars that are properly set', async () => {
    const { validateEnvVars } = await import('../extension/config.js')
    process.env.TEST_EXISTING_VAR = 'present'
    const result = validateEnvVars({
      servers: {
        svc: {
          env: {
            EXISTING: '${EXISTING}',
            TEST_EXISTING_VAR: '${TEST_EXISTING_VAR}',
          },
        },
      },
    })

    // EXISTING is not set → error
    expect(result.errors.some((e) => e.includes('EXISTING'))).toBe(true)
    // TEST_EXISTING_VAR IS set → no error for it
    expect(result.errors.some((e) => e.includes('TEST_EXISTING_VAR'))).toBe(false)
    // But errors should still be > 0 due to EXISTING
    expect(result.errors.length).toBeGreaterThan(0)
    delete process.env.TEST_EXISTING_VAR
  })

  it('warns about PI_PROVIDER not being set', async () => {
    const { validateEnvVars } = await import('../extension/config.js')
    const oldVal = process.env.PI_PROVIDER
    delete process.env.PI_PROVIDER

    const result = validateEnvVars()
    expect(result.warnings.some((w) => w.includes('PI_PROVIDER'))).toBe(true)

    if (oldVal) process.env.PI_PROVIDER = oldVal
  })

  it('does not warn about PI_PROVIDER when it is set', async () => {
    const { validateEnvVars } = await import('../extension/config.js')
    process.env.PI_PROVIDER = 'deepseek'

    const result = validateEnvVars()
    expect(result.warnings.some((w) => w.includes('PI_PROVIDER'))).toBe(false)

    delete process.env.PI_PROVIDER
  })
})

describe('config module exports', () => {
  it('exports expected public API', async () => {
    const configModule = await import('../extension/config.js')
    expect(configModule).toHaveProperty('validateMcpConfig')
    expect(configModule).toHaveProperty('validateEnvVars')
  })
})
