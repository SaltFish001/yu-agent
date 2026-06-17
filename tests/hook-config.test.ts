/**
 * Unit tests — Hook config loading and toggle logic.
 *
 * Tests the config loading pattern used in extension/index.ts:
 *   loadConfig() reads ~/.yu/config.json
 *   hooks.beforeChat.enabled === false → hook disabled
 *
 * We test the logic inline since loadConfig is internal to index.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const CONFIG_PATH = resolve(process.env.HOME || '/home/saltfish', '.yu', 'config.json')

/**
 * Replicate the loadConfig function from extension/index.ts.
 */
function loadConfig(): Record<string, unknown> {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    }
  } catch {
    // non-fatal
  }
  return {}
}

/**
 * Replicate the hook toggle check from extension/index.ts.
 */
function isHookEnabled(config: Record<string, unknown>): boolean {
  const hooks = config.hooks as Record<string, { enabled: boolean }> | undefined
  return hooks?.beforeChat?.enabled !== false
}

describe('Hook config loading', () => {
  beforeEach(() => {
    // Ensure ~/.yu directory exists
    const dir = resolve(process.env.HOME || '/home/saltfish', '.yu')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  })

  afterEach(() => {
    // Clean up test config file
    try {
      if (existsSync(CONFIG_PATH)) {
        unlinkSync(CONFIG_PATH)
      }
    } catch {
      // best-effort
    }
  })

  it('returns empty object when config file does not exist', () => {
    // Ensure no config file
    try {
      unlinkSync(CONFIG_PATH)
    } catch {
      /* ok */
    }
    const config = loadConfig()
    expect(config).toEqual({})
  })

  it('loads config and detects hook is disabled', () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        hooks: {
          beforeChat: { enabled: false },
        },
      }),
      'utf-8',
    )

    const config = loadConfig()
    expect(isHookEnabled(config)).toBe(false)
  })

  it('loads config and detects hook is enabled (true)', () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        hooks: {
          beforeChat: { enabled: true },
        },
      }),
      'utf-8',
    )

    const config = loadConfig()
    expect(isHookEnabled(config)).toBe(true)
  })

  it('defaults to enabled when hooks config is absent', () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        someOtherConfig: 'value',
      }),
      'utf-8',
    )

    const config = loadConfig()
    expect(isHookEnabled(config)).toBe(true)
  })

  it('defaults to enabled when hooks.beforeChat is absent', () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        hooks: {},
      }),
      'utf-8',
    )

    const config = loadConfig()
    expect(isHookEnabled(config)).toBe(true)
  })

  it('defaults to enabled when hooks.beforeChat.enabled is missing', () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        hooks: {
          beforeChat: {},
        },
      }),
      'utf-8',
    )

    const config = loadConfig()
    expect(isHookEnabled(config)).toBe(true)
  })

  it('handles malformed JSON gracefully', () => {
    writeFileSync(CONFIG_PATH, 'not valid json{{', 'utf-8')

    const config = loadConfig()
    expect(config).toEqual({})
    expect(isHookEnabled(config)).toBe(true)
  })
})
