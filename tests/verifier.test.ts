/**
 * Unit tests — verifier.ts (LSP verification & test runner)
 *
 * Tests findProjectRoot, detectLspServer, runCommand, and runTests
 * with unique temp sub-directories per test to prevent marker pollution.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── Mock Bun.spawnSync for runCommand ────────────────────

let mockSpawn: ReturnType<typeof spyOn>

function makeMockProc(stdout: string, exitCode = 0) {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from('') }
}

beforeEach(() => {
  mockSpawn = spyOn(Bun, 'spawnSync')
})

afterEach(() => {
  mockSpawn.mockRestore()
})

// ── Helper: unique temp dir per test ─────────────────────

let testDirs: string[] = []

function makeTestDir(): string {
  const d = join(tmpdir(), `yu-test-verifier-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(d, { recursive: true })
  testDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of testDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  testDirs = []
})

// ── findProjectRoot ─────────────────────────────────────

describe('findProjectRoot', () => {
  it('returns cwd when files array is empty', async () => {
    const { findProjectRoot } = await import('../extension/verifier.js')
    const result = findProjectRoot([])
    expect(result.length).toBeGreaterThan(0)
  })

  it('walks up to find package.json', async () => {
    const d = makeTestDir()
    mkdirSync(join(d, 'sub'), { recursive: true })
    writeFileSync(join(d, 'package.json'), '{}', 'utf-8')

    const { findProjectRoot } = await import('../extension/verifier.js')
    const result = findProjectRoot([join(d, 'sub', 'test.ts')])
    expect(result).toBe(d)
  })

  it('falls back to cwd when no marker found', async () => {
    const d = makeTestDir()
    mkdirSync(join(d, 'deep', 'nested'), { recursive: true })

    const { findProjectRoot } = await import('../extension/verifier.js')
    const result = findProjectRoot([join(d, 'deep', 'nested', 'test.ts')])
    expect(result).toBe(process.cwd())
  })
})

// ── detectLspServer ─────────────────────────────────────

describe('detectLspServer', () => {
  it('detects TypeScript when tsconfig.json exists', async () => {
    const d = makeTestDir()
    writeFileSync(join(d, 'tsconfig.json'), '{}', 'utf-8')

    const { detectLspServer } = await import('../extension/verifier.js')
    const result = detectLspServer(d)
    expect(result!.name).toContain('typescript')
  })

  it('detects Python when pyproject.toml exists', async () => {
    const d = makeTestDir()
    writeFileSync(join(d, 'pyproject.toml'), '[tool.pytest]', 'utf-8')

    const { detectLspServer } = await import('../extension/verifier.js')
    const result = detectLspServer(d)
    expect(result!.name).toContain('pyright')
  })

  it('detects Go when go.mod exists', async () => {
    const d = makeTestDir()
    writeFileSync(join(d, 'go.mod'), 'module test', 'utf-8')

    const { detectLspServer } = await import('../extension/verifier.js')
    const result = detectLspServer(d)
    expect(result!.name).toBe('gopls')
  })

  it('detects Rust when Cargo.toml exists', async () => {
    const d = makeTestDir()
    writeFileSync(join(d, 'Cargo.toml'), '[package]', 'utf-8')

    const { detectLspServer } = await import('../extension/verifier.js')
    const result = detectLspServer(d)
    expect(result!.name).toContain('rust')
  })

  it('returns null when no known config exists', async () => {
    const d = makeTestDir()

    const { detectLspServer } = await import('../extension/verifier.js')
    const result = detectLspServer(d)
    expect(result).toBeNull()
  })
})

// ── runCommand ───────────────────────────────────────────

describe('runCommand', () => {
  it('returns true on zero exit code', async () => {
    mockSpawn.mockReturnValueOnce(makeMockProc('', 0))

    const { runCommand } = await import('../extension/verifier.js')
    expect(runCommand('echo', ['hello'], '/tmp')).toBe(true)
  })

  it('returns false on non-zero exit code', async () => {
    mockSpawn.mockReturnValueOnce(makeMockProc('error', 1))

    const { runCommand } = await import('../extension/verifier.js')
    expect(runCommand('false', [], '/tmp')).toBe(false)
  })

  it('returns false on spawn error', async () => {
    mockSpawn.mockImplementation(() => { throw new Error('not found') })

    const { runCommand } = await import('../extension/verifier.js')
    expect(runCommand('nonexistent', [], '/tmp')).toBe(false)
  })
})

// ── runTests ─────────────────────────────────────────────

describe('runTests', () => {
  it('skips tests when package.json has no test framework', async () => {
    const d = makeTestDir()
    // package.json exists but has no test framework deps
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'no-tests' }), 'utf-8')
    writeFileSync(join(d, 'test.ts'), '// empty', 'utf-8')

    const { runTests } = await import('../extension/verifier.js')
    const result = await runTests([join(d, 'test.ts')])
    expect(result).toBe(true)
  })

  it('runs vitest when package.json has vitest dep', async () => {
    const d = makeTestDir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }), 'utf-8')
    mockSpawn.mockReturnValueOnce(makeMockProc('', 0))

    const { runTests } = await import('../extension/verifier.js')
    const result = await runTests([join(d, 'test.ts')])

    expect(result).toBe(true)
    const args = mockSpawn.mock.calls[0][0]
    expect(args).toContain('vitest')
  })

  it('runs jest when package.json has jest dep', async () => {
    const d = makeTestDir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29.0.0' } }), 'utf-8')
    mockSpawn.mockReturnValueOnce(makeMockProc('', 0))

    const { runTests } = await import('../extension/verifier.js')
    const result = await runTests([join(d, 'test.ts')])

    expect(result).toBe(true)
    const args = mockSpawn.mock.calls[0][0]
    expect(args).toContain('jest')
  })

  it('detects mocha when package.json has mocha dep', async () => {
    const d = makeTestDir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ devDependencies: { mocha: '^10.0.0' } }), 'utf-8')
    mockSpawn.mockReturnValueOnce(makeMockProc('', 0))

    const { runTests } = await import('../extension/verifier.js')
    const result = await runTests([join(d, 'test.ts')])

    expect(result).toBe(true)
    const args = mockSpawn.mock.calls[0][0]
    expect(args).toContain('mocha')
  })
})
