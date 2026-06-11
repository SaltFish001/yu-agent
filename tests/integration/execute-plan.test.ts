/**
 * Integration tests — executePlan() scheduler execution.
 *
 * Tests executePlan() with various plan shapes:
 * - Empty agents array
 * - Pass-through plan (mocked spawn)
 * - Basic multi-agent plan with mocked agents
 *
 * NOTE: We mock spawn.js to avoid real LLM calls/timeouts.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock spawn.js to prevent real LLM calls
const mockSpawnResult = { response: JSON.stringify({ status: 'success', summary: 'Mocked result' }) };
vi.mock('../../extension/spawn.js', () => ({
  spawnAgent: vi.fn(() => Promise.resolve(mockSpawnResult)),
}));

// Mock tracker to avoid side effects
vi.mock('../../extension/tracker.js', () => ({
  trackAgent: vi.fn(),
  loadDecisions: vi.fn(() => []),
  resetTracker: vi.fn(),
  flushFinalStatus: vi.fn(),
  saveDecision: vi.fn(),
}));

// Mock checkpoint to avoid checkpoint guards
vi.mock('../../extension/checkpoint.js', () => ({
  checkpointGuard: vi.fn(() => vi.fn()),
}));

// Mock knowledge to avoid RAG calls
vi.mock('../../extension/knowledge/index.js', () => ({
  getRelevantContext: vi.fn(() => []),
}));

// Mock git commands for diff operations
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

// Mock diff review + confirm
vi.mock('../../extension/executor.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    // Override runParallelGroup to return the mock result for any agent
    runParallelGroup: vi.fn(() => Promise.resolve(new Map([['c1', mockSpawnResult]]))),
    reviewDiff: vi.fn(() => ({ diff: '', hasChanges: false, stats: '' })),
    printDiffSummary: vi.fn(),
    confirmDiff: vi.fn(() => Promise.resolve(true)),
    // Override spawnAgentWithTimeout to use mock
    spawnAgentWithTimeout: vi.fn(() => Promise.resolve(mockSpawnResult)),
  };
});

describe('executePlan', () => {
  it('returns a result for valid single-agent plan (non-empty)', async () => {
    const { executePlan } = await import('../../extension/scheduler.js');
    const plan = {
      intent: 'chat',
      agents: [{ type: 'chat', model: 'v4-flash', id: 'c1', task: 'Say hello' }],
      parallel_groups: [['c1']],
    };
    const result = await executePlan(plan, 'Say hello', {});
    // Should return the summary from the mock result
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
  });

  it('returns a string for empty agents array (no pass_through, no team)', async () => {
    const { executePlan } = await import('../../extension/scheduler.js');
    const plan = {
      intent: 'chat',
      agents: [],
      parallel_groups: [],
    };
    const result = await executePlan(plan, 'hello', {});
    // Empty agents + no pass_through → returns JSON string of empty results
    expect(typeof result).toBe('string');
    // Empty Map serializes to '{}'
    expect(result).toBe('{}');
  });

  it('handles pass_through plan without crashing', async () => {
    const { executePlan } = await import('../../extension/scheduler.js');
    const plan = {
      pass_through: true,
    };
    const result = await executePlan(plan, 'hello', {});
    // With mocked spawn, pass_through returns the mocked response
    expect(typeof result).toBe('string');
  });

  it('returns string for plan with no intent but empty agents', async () => {
    const { executePlan } = await import('../../extension/scheduler.js');
    const plan = {
      agents: [],
      parallel_groups: [],
    };
    const result = await executePlan(plan, 'hi', {});
    expect(typeof result).toBe('string');
    expect(result).toBe('{}');
  });

  it('handles undefined parallel_groups gracefully', async () => {
    const { executePlan } = await import('../../extension/scheduler.js');
    const plan = {
      intent: 'chat',
      agents: [],
    };
    const result = await executePlan(plan, 'hello', {});
    expect(typeof result).toBe('string');
    expect(result).toBe('{}');
  });

  it('handles null sessionContext gracefully', async () => {
    const { executePlan } = await import('../../extension/scheduler.js');
    const plan = {
      intent: 'chat',
      agents: [],
      parallel_groups: [],
    };
    const result = await executePlan(plan, 'hello', null as unknown as Record<string, unknown>);
    expect(typeof result).toBe('string');
  });
});
