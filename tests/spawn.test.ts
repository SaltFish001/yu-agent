/**
 * Unit tests — spawn.ts (AgentLoop proxy)
 *
 * Tests spawnAgent, createSpawnPool, and stats tracking.
 * agent-loop.ts is mocked to avoid real LLM calls.
 */

import { beforeAll, describe, expect, it, vi } from 'bun:test'

// Mock agent-loop before importing spawn
const mockRunAgent = vi.fn()
vi.mock('../extension/agent-loop.js', () => ({
  runAgent: mockRunAgent,
}))

const { spawnAgent, createSpawnPool, getSpawnStats, getAllPoolsStats } = await import('../extension/spawn.js')

beforeAll(() => {
  // Reset internal state between test files
  // Note: spawn module has module-level counters; tests below rely on relative counts
})

describe('spawnAgent', () => {
  it('returns a successful SpawnResult on valid config', async () => {
    mockRunAgent.mockResolvedValueOnce({
      output: 'Task completed successfully.',
      iterations: 3,
      totalTokens: 500,
      cacheStats: { cacheHitTokens: 100, cacheMissTokens: 400 },
    })

    const result = await spawnAgent({
      type: 'coder',
      model: 'v4-flash',
      task: 'Write a test',
      maxTurns: 10,
      timeout: 120_000,
    })

    expect(result.response).toBe('Task completed successfully.')
    expect(result.text).toBe(result.response)
    expect(result.content).toBe(result.response)
    expect(result.totalTokens).toBe(500)
    expect(result.cacheHitTokens).toBe(100)
    expect(result.cacheMissTokens).toBe(400)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.model).toBe('v4-flash')
  })

  it('caps maxIterations at 50', async () => {
    mockRunAgent.mockResolvedValueOnce({
      output: 'ok',
      iterations: 50,
      totalTokens: 10,
    })

    await spawnAgent({
      type: 'coder',
      model: 'v4-flash',
      task: 'test',
      maxTurns: 999,
      timeout: 120_000,
    })

    // runAgent should have been called with maxIterations=50 (not 999)
    const callArgs = mockRunAgent.mock.calls.find(([_task, opts]) => opts?.maxIterations === 50)
    expect(callArgs).toBeTruthy()
  })

  it('returns empty response on error', async () => {
    mockRunAgent.mockRejectedValueOnce(new Error('LLM timeout'))

    const result = await spawnAgent({
      type: 'coder',
      model: 'v4-flash',
      task: 'This will fail',
      maxTurns: 5,
      timeout: 1000,
    })

    expect(result.response).toBe('')
    expect(result.content).toBe('')
    expect(typeof result.durationMs).toBe('number')
  })

  it('handles non-Error thrown values gracefully', async () => {
    mockRunAgent.mockRejectedValueOnce('string error')

    const result = await spawnAgent({
      type: 'coder',
      model: 'v4-flash',
      task: 'fail',
      maxTurns: 5,
      timeout: 1000,
    })

    expect(result.response).toBe('')
  })
})

describe('spawn pool management', () => {
  it('createSpawnPool registers a pool', async () => {
    const poolKey = 'test-pool'
    await createSpawnPool(poolKey, 3, {
      type: 'coder',
      model: 'v4-flash',
      task: 'pool task',
      maxTurns: 5,
      timeout: 30_000,
    })

    const stats = getAllPoolsStats()
    expect(stats[poolKey]).toBeDefined()
    expect((stats[poolKey] as { totalSpawned: number }).totalSpawned).toBeGreaterThanOrEqual(0)
  })
})

describe('getSpawnStats', () => {
  it('returns spawn stats object with correct shape', () => {
    const stats = getSpawnStats()
    expect(stats).toHaveProperty('activeCount')
    expect(stats).toHaveProperty('totalSpawned')
    expect(stats).toHaveProperty('errors')
    expect(typeof stats.totalSpawned).toBe('number')
    expect(typeof stats.errors).toBe('number')
  })
})
