/**
 * Tests for scripts/migrate-json-to-sqlite.ts
 *
 * One-shot migration tool that reads JSON session files from a directory
 * and writes them into a SQLite database using bun:sqlite.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'

const SCRIPT = resolve(import.meta.dir, '..', 'scripts', 'migrate-json-to-sqlite.ts')

// ── Fixture helpers ──────────────────────────────────────

/** Write a JSON file in the format {type}.{tag}.json */
function writeFixture(dir: string, type: string, tag: string, data: unknown) {
  writeFileSync(resolve(dir, `${type}.${tag}.json`), JSON.stringify(data))
}

/** Create a fresh temp dir for a test */
function makeTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'yu-migrate-'))
}

/** Run the migration script and return { exitCode, stdout, stderr } */
function runMigration(dir: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bun', 'run', SCRIPT, '--dir', dir], {
    env: { ...process.env },
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

/** Read a SQLite DB file as JSON via bun -e, retrying on transient failures */
function readDbJson(dbPath: string, table: string): unknown[] {
  const result = Bun.spawnSync([
    'bun',
    '-e',
    `
      import { Database } from 'bun:sqlite';
      const db = new Database('${dbPath}');
      const rows = db.query('SELECT * FROM ${table} ORDER BY tag').all();
      db.close();
      console.log(JSON.stringify(rows));
    `,
  ], {
    env: { ...process.env },
  })
  if (result.exitCode !== 0) throw new Error(`readDbJson failed: ${result.stderr.toString()}`)
  return JSON.parse(result.stdout.toString())
}

/** Clean up a temp dir */
function cleanupDir(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ── Tests ────────────────────────────────────────────────

describe('migrate-json-to-sqlite', () => {
  test('exits cleanly on empty directory', () => {
    const dir = makeTempDir()
    try {
      const { exitCode, stdout } = runMigration(dir)
      expect(exitCode).toBe(0)
      expect(stdout).toContain('No JSON session files found')
    } finally {
      cleanupDir(dir)
    }
  })

  test('imports a session.json file', () => {
    const dir = makeTempDir()
    try {
      const tag = 'test-session-1'
      writeFixture(dir, 'session', tag, {
        name: 'Test Session',
        cwd: '/home/test',
        updatedAt: 1700000000000,
      })

      const { exitCode, stdout } = runMigration(dir)
      expect(exitCode).toBe(0)
      expect(stdout).toContain(tag)

      // Verify the SQLite DB was created
      const dbPath = resolve(dir, 'sessions.db')
      expect(existsSync(dbPath)).toBe(true)

      // Read back session data
      const rows = readDbJson(dbPath, 'sessions')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        tag,
        name: 'Test Session',
        cwd: '/home/test',
      })
    } finally {
      cleanupDir(dir)
    }
  })

  test('imports multiple related files for the same tag', () => {
    const dir = makeTempDir()
    try {
      const tag = 'test-multi-1'

      writeFixture(dir, 'session', tag, {
        name: 'Multi Session',
        cwd: '/tmp/work',
        updatedAt: 1700000001000,
      })
      writeFixture(dir, 'agents', tag, {
        agents: [{ name: 'agent-1' }],
        updatedAt: 1700000001000,
      })
      writeFixture(dir, 'summary', tag, {
        running: 1,
        completed: 3,
        failed: 0,
        mcpConnected: 2,
        lspReady: 1,
        updatedAt: 1700000001000,
      })
      writeFixture(dir, 'cache', tag, {
        totalHits: 10,
        totalMisses: 5,
        totalCost: 0.01,
        turnCount: 15,
        hitRate: 66.67,
        updatedAt: 1700000001000,
      })

      const dbPath = resolve(dir, 'sessions.db')
      const { exitCode, stdout } = runMigration(dir)
      expect(exitCode).toBe(0)
      expect(stdout).toContain(tag)
      expect(stdout).toContain('session, agents, summary, cache')

      const sessions = readDbJson(dbPath, 'sessions')
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ tag, name: 'Multi Session' })

      const agents = readDbJson(dbPath, 'agents')
      expect(agents).toHaveLength(1)
      expect(JSON.parse((agents[0] as any).data)).toMatchObject({ agents: [{ name: 'agent-1' }] })

      const summary = readDbJson(dbPath, 'summary')
      expect(summary).toHaveLength(1)
      expect(summary[0]).toMatchObject({ running: 1, completed: 3, failed: 0 })

      const cache = readDbJson(dbPath, 'cache')
      expect(cache).toHaveLength(1)
      expect(cache[0]).toMatchObject({ total_hits: 10, total_misses: 5 })
    } finally {
      cleanupDir(dir)
    }
  })

  test('imports MCP/LSP/Team data', () => {
    const dir = makeTempDir()
    try {
      const tag = 'test-ext-1'

      writeFixture(dir, 'mcp', tag, {
        servers: [{ name: 'fs-tools' }],
        updatedAt: 1700000002000,
      })
      writeFixture(dir, 'lsp', tag, {
        servers: [{ name: 'typescript' }],
        updatedAt: 1700000002000,
      })
      writeFixture(dir, 'team', tag, {
        members: ['alice', 'bob'],
        updatedAt: 1700000002000,
      })

      const dbPath = resolve(dir, 'sessions.db')
      const { exitCode, stdout } = runMigration(dir)
      expect(exitCode).toBe(0)
      expect(stdout).toContain('mcp, lsp, team')

      const mcp = readDbJson(dbPath, 'mcp')
      expect(mcp).toHaveLength(1)

      const lsp = readDbJson(dbPath, 'lsp')
      expect(lsp).toHaveLength(1)

      const team = readDbJson(dbPath, 'team')
      expect(team).toHaveLength(1)
    } finally {
      cleanupDir(dir)
    }
  })

  test('skips malformed JSON files', () => {
    const dir = makeTempDir()
    try {
      writeFileSync(resolve(dir, 'session.bad-tag.json'), '{ invalid json }')

      const { exitCode, stderr } = runMigration(dir)
      expect(exitCode).toBe(0)
      expect(stderr).toContain('skip')
    } finally {
      cleanupDir(dir)
    }
  })

  test('reports error for non-existent directory', () => {
    const { exitCode } = runMigration('/tmp/non-existent-dir-12345')
    expect(exitCode).toBe(1)
  })
})
