/**
 * Integration tests — knowledge/index.ts (FTS5 knowledge base)
 *
 * Single describe block to avoid the module-level _db singleton issue.
 * Bun caches ES modules, so all imports share one _db reference across
 * the test file. We use one temp HOME + one project dir for the whole run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── Fixture setup ───────────────────────────────────────

const origHome = process.env.HOME
const tmpHome = join(tmpdir(), `yu-test-kb-${Date.now()}`)
const tmpProject = join(tmpdir(), `yu-test-project-${Date.now()}`)

beforeAll(() => {
  mkdirSync(join(tmpHome, '.yu'), { recursive: true })
  process.env.HOME = tmpHome
})

afterAll(() => {
  process.env.HOME = origHome
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(tmpProject, { recursive: true, force: true }) } catch { /* ignore */ }
})

function writeFile(relPath: string, content: string): void {
  const full = join(tmpProject, relPath)
  const parentDir = relPath.includes('/')
    ? join(tmpProject, relPath.replace(/\/[^/]+$/, ''))
    : tmpProject
  mkdirSync(parentDir, { recursive: true })
  writeFileSync(full, content, 'utf-8')
}

// ── Tests ────────────────────────────────────────────────

describe('knowledge', () => {
  it('throws on non-existent directory', async () => {
    const { indexProject } = await import('../extension/knowledge/index.js')
    expect(() => indexProject('/path/does/not/exist/xyz')).toThrow('目录不存在')
  })

  it('indexes markdown files', async () => {
    writeFile('README.md', '# My Project\nThis is a test project with cool features.')
    writeFile('docs/guide.md', '# User Guide\nFollow these steps to get started.')

    const { indexProject } = await import('../extension/knowledge/index.js')
    const result = indexProject(tmpProject)
    expect(result.indexed).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
  })

  it('indexes JSDoc from TypeScript files', async () => {
    writeFile(
      'src/main.ts',
      `/**
 * Calculate the sum of two numbers.
 * @param a - First number
 * @param b - Second number
 */
function add(a: number, b: number): number { return a + b }`,
    )

    const { indexProject } = await import('../extension/knowledge/index.js')
    const result = indexProject(tmpProject)
    expect(result.indexed).toBe(1)
  })

  it('indexes TSX files', async () => {
    writeFile(
      'src/component.tsx',
      `/**
 * A button component.
 * Renders a clickable button with given label.
 */
export function Button(props: { label: string }) { return null }`,
    )

    const { indexProject } = await import('../extension/knowledge/index.js')
    const result = indexProject(tmpProject)
    expect(result.indexed).toBe(1)
  })

  it('handles ADR files with correct type', async () => {
    writeFile('docs/adr/001-use-fts5.md', '# ADR-001: Use FTS5 for full-text search')

    const { indexProject, searchKnowledge } = await import('../extension/knowledge/index.js')
    indexProject(tmpProject)

    const results = searchKnowledge('FTS5')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].type).toBe('adr')
  })

  it('skips node_modules and .git directories', async () => {
    writeFile('just-check.md', '# should be indexed')
    writeFile('node_modules/pkg/index.ts', '/** ignored */ const x = 1')
    writeFile('.git/HEAD', 'ref: refs/heads/main')

    const { indexProject } = await import('../extension/knowledge/index.js')
    const result = indexProject(tmpProject)
    // 5 previously indexed files + 1 new = should see 1 indexed, rest skipped
    expect(result.indexed).toBe(1)
  })

  it('skips unchanged files on re-index', async () => {
    const { indexProject } = await import('../extension/knowledge/index.js')
    const result = indexProject(tmpProject)
    expect(result.indexed).toBe(0)
    expect(result.skipped).toBeGreaterThanOrEqual(5)
  })

  it('finds indexed content with search', async () => {
    const { searchKnowledge } = await import('../extension/knowledge/index.js')
    const results = searchKnowledge('project')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].path).toBe('README.md')
    expect(results[0].type).toBe('md')
  })

  it('respects search limit', async () => {
    const { searchKnowledge } = await import('../extension/knowledge/index.js')
    const results = searchKnowledge('file', 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('is safe against FTS5 injection', async () => {
    const { searchKnowledge } = await import('../extension/knowledge/index.js')
    const results = searchKnowledge('" OR 1=1 --')
    expect(Array.isArray(results)).toBe(true)
  })

  it('returns knowledge stats', async () => {
    const { knowledgeStats } = await import('../extension/knowledge/index.js')
    const stats = knowledgeStats()
    expect(stats.totalFiles).toBeGreaterThan(5)
    expect(stats.byType.md).toBeGreaterThanOrEqual(3)
    expect(stats.byType.ts).toBeGreaterThanOrEqual(1)
    expect(stats.lastIndexed).not.toBeNull()
    expect(typeof stats.dbSize).toBe('number')
  })

  it('returns relevant context for queries', async () => {
    const { getRelevantContext } = await import('../extension/knowledge/index.js')
    const ctx = getRelevantContext('project')
    expect(ctx.length).toBeGreaterThan(0)
    expect(ctx[0]).toContain('[md]')
  })

  it('returns empty context for non-matching queries', async () => {
    const { getRelevantContext } = await import('../extension/knowledge/index.js')
    const ctx = getRelevantContext('nonexistent_topic_xyz')
    expect(ctx).toEqual([])
  })

  describe('knowledgeCommand', () => {
    it('shows usage for unknown subcommand', async () => {
      const { knowledgeCommand } = await import('../extension/knowledge/index.js')
      expect(knowledgeCommand('foo', [])).toContain('Usage:')
    })

    it('shows search usage without query', async () => {
      const { knowledgeCommand } = await import('../extension/knowledge/index.js')
      expect(knowledgeCommand('search', [])).toContain('Usage:')
    })

    it('returns formatted search results', async () => {
      const { knowledgeCommand } = await import('../extension/knowledge/index.js')
      const output = knowledgeCommand('search', ['project'])
      expect(output).toContain('[md]')
    })

    it('returns index results', async () => {
      const { knowledgeCommand } = await import('../extension/knowledge/index.js')
      const output = knowledgeCommand('index', [tmpProject])
      expect(output).toContain('索引完成')
    })

    it('returns stats', async () => {
      const { knowledgeCommand } = await import('../extension/knowledge/index.js')
      const output = knowledgeCommand('stats', [])
      expect(output).toContain('知识库状态')
    })
  })
})
