/**
 * Unit tests — executor.ts (Agent executor utilities)
 *
 * Tests runWithConcurrencyLimit, reviewDiff, printDiffSummary, runParallelGroup.
 * confirmDiff is interactive (readline) and not unit-testable.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

// ── Mock Bun.spawnSync for reviewDiff ────────────────────

let mockSpawn: ReturnType<typeof spyOn>

function makeMockProc(stdout: string, exitCode = 0) {
  return { exitCode, stdout: Buffer.from(stdout) }
}

beforeEach(() => {
  mockSpawn = spyOn(Bun, 'spawnSync')
})

afterEach(() => {
  mockSpawn.mockRestore()
})

// ── runWithConcurrencyLimit ──────────────────────────────

describe('runWithConcurrencyLimit', () => {
  it('executes all tasks and returns results in order', async () => {
    const { runWithConcurrencyLimit } = await import('../extension/executor.js')

    const tasks = [
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ]

    const results = await runWithConcurrencyLimit(tasks, 2)
    expect(results).toHaveLength(3)
    expect(results[0].status).toBe('fulfilled')
    if (results[0].status === 'fulfilled') expect(results[0].value).toBe(1)
    expect(results[1].status).toBe('fulfilled')
    if (results[1].status === 'fulfilled') expect(results[1].value).toBe(2)
    expect(results[2].status === 'fulfilled' && results[2].value === 3).toBe(true)
  })

  it('handles task rejection without crashing', async () => {
    const { runWithConcurrencyLimit } = await import('../extension/executor.js')

    const tasks = [
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('also ok'),
    ]

    const results = await runWithConcurrencyLimit(tasks, 2)
    expect(results).toHaveLength(3)
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    expect(results[2].status).toBe('fulfilled')
  })

  it('runs tasks with correct concurrency (limit=1 is sequential)', async () => {
    const { runWithConcurrencyLimit } = await import('../extension/executor.js')
    const order: number[] = []

    const tasks = [
      () => new Promise<number>((resolve) => setTimeout(() => { order.push(1); resolve(1) }, 5)),
      () => new Promise<number>((resolve) => setTimeout(() => { order.push(2); resolve(2) }, 3)),
    ]

    await runWithConcurrencyLimit(tasks, 1)
    expect(order).toEqual([1, 2])
  })

  it('respects limit higher than task count', async () => {
    const { runWithConcurrencyLimit } = await import('../extension/executor.js')
    const results = await runWithConcurrencyLimit([() => Promise.resolve('x')], 10)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('fulfilled')
  })

  it('handles empty task array', async () => {
    const { runWithConcurrencyLimit } = await import('../extension/executor.js')
    const results = await runWithConcurrencyLimit([], 4)
    expect(results).toEqual([])
  })
})

// ── reviewDiff ────────────────────────────────────────────

describe('reviewDiff', () => {
  it('returns diff with changes when git diff has output', async () => {
    mockSpawn.mockImplementation((args: string[], opts: unknown) => {
      if (args.includes('--stat') && !args.includes('--cached')) {
        return makeMockProc(' 2 files changed, 10 insertions(+)')
      }
      if (args.includes('--cached')) {
        return makeMockProc('')
      }
      return makeMockProc('diff --git a/src/main.ts b/src/main.ts\n+console.log("hello")')
    })

    const { reviewDiff } = await import('../extension/executor.js')
    const result = reviewDiff()
    expect(result.hasChanges).toBe(true)
    expect(result.diff).toContain('diff --git')
    expect(result.stats).toContain('2 files changed')
  })

  it('returns no changes when git diff is empty', async () => {
    mockSpawn.mockImplementation(() => makeMockProc(''))

    const { reviewDiff } = await import('../extension/executor.js')
    const result = reviewDiff()
    expect(result.hasChanges).toBe(false)
    expect(result.diff).toBe('')
  })

  it('detects staged changes', async () => {
    mockSpawn.mockImplementation((args: string[]) => {
      if (args.includes('--cached')) {
        return makeMockProc(' 1 file changed')
      }
      return makeMockProc('')
    })

    const { reviewDiff } = await import('../extension/executor.js')
    const result = reviewDiff()
    expect(result.hasChanges).toBe(true)
  })

  it('gracefully handles git failure', async () => {
    mockSpawn.mockImplementation(() => makeMockProc('', 128))

    const { reviewDiff } = await import('../extension/executor.js')
    const result = reviewDiff()
    expect(result.hasChanges).toBe(false)
    expect(result.diff).toBe('')
    expect(result.stats).toBe('')
  })
})

// ── printDiffSummary ─────────────────────────────────────

describe('printDiffSummary', () => {
  it('logs info when no changes', async () => {
    const { printDiffSummary } = await import('../extension/executor.js')
    // Should not throw; just logs
    printDiffSummary({ diff: '', hasChanges: false, stats: '' })
    // No assertion needed — just ensure no crash
  })

  it('prints diff when changes exist', async () => {
    const { printDiffSummary } = await import('../extension/executor.js')
    printDiffSummary({
      diff: '+console.log("hi")',
      hasChanges: true,
      stats: '1 file changed',
    })
  })
})

// ── runParallelGroup ─────────────────────────────────────

describe('runParallelGroup', () => {
  it('throws on unknown agent id in group', async () => {
    const { runParallelGroup } = await import('../extension/executor.js')
    const agentMap = new Map([['a', { type: 'coder', model: 'deepseek-v4-flash', id: 'a', task: 'test' }]])

    await expect(runParallelGroup(['b'], agentMap, {})).rejects.toThrow('Unknown agent id')
  })
})
