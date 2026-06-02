/**
 * Unit tests — classifier.ts (intent classification & fallback).
 *
 * Tests the fallback logic in classifyIntent when:
 *   1. Scheduler returns non-JSON text (pure markdown)
 *   2. Scheduler returns invalid JSON
 *   3. Spawn fails entirely
 *
 * We test by mocking spawnAgent to return controlled outputs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyIntent } from '../extension/classifier.js';

// ── Mock spawnAgent ────────────────────────────────────

type SpawnMock = (config: { task: string; type?: string }) => Promise<{ response: string }>;

let spawnMock: SpawnMock | null = null;

vi.mock('../extension/spawn.js', () => ({
  spawnAgent: (config: { task: string; type?: string; }) => {
    if (!spawnMock) throw new Error('spawnAgent mock not set');
    return spawnMock(config);
  },
}));

// Mock trackAgent to be a no-op
vi.mock('../extension/tracker.js', () => ({
  trackAgent: vi.fn(),
  loadDecisions: vi.fn(() => []),
}));

// Mock executor for AGENT_TIMEOUT_MS
vi.mock('../extension/executor.js', () => ({
  AGENT_TIMEOUT_MS: 1000,
}));

describe('classifyIntent — JSON output path', () => {
  beforeEach(() => {
    spawnMock = null;
  });

  it('returns a plan when scheduler returns valid JSON', async () => {
    spawnMock = async () => ({
      response: JSON.stringify({
        pass_through: false,
        intent: 'coding',
        reasoning: 'User wants code changes',
        agents: [{ type: 'coding', model: 'sonnet', id: 'c1' }],
        parallel_groups: [['c1']],
      }),
    });

    const plan = await classifyIntent('fix this bug', {});
    expect(plan.pass_through).toBe(false);
    expect(plan.intent).toBe('coding');
    expect(plan.agents).toHaveLength(1);
  });
});

describe('classifyIntent — fallback to pass_through', () => {
  beforeEach(() => {
    spawnMock = null;
  });

  it('falls back to pass_through when output is pure text (no JSON)', async () => {
    // Pure markdown text — no JSON structure at all
    spawnMock = async () => ({
      response: 'I think the user wants to fix a bug. Let me analyze the code...',
    });

    const plan = await classifyIntent('fix this bug', {});
    expect(plan.pass_through).toBe(true);
    expect(plan.reasoning).toContain('scheduler failed');
  });

  it('falls back to pass_through when output is empty string', async () => {
    spawnMock = async () => ({ response: '' });

    const plan = await classifyIntent('hello', {});
    expect(plan.pass_through).toBe(true);
  });

  it('falls back to pass_through when spawnAgent throws', async () => {
    spawnMock = async () => {
      throw new Error('API timeout');
    };

    const plan = await classifyIntent('do something', {});
    expect(plan.pass_through).toBe(true);
    expect(plan.reasoning).toContain('scheduler failed');
  });

  it('falls back to pass_through when JSON is malformed and not fixable', async () => {
    // JSON-like but not repairable
    spawnMock = async () => ({
      response: 'Some prefix text {broken: } some suffix',
    });

    const plan = await classifyIntent('fix this', {});
    expect(plan.pass_through).toBe(true);
  });
});

// Retry behavior not testable with MAX_RETRY_SCHEDULER = 0
// (module-level constant prevents retries in production)
