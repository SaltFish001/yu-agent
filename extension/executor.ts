/**
 * yu-agent — Agent executor utilities.
 *
 * Extracted from scheduler.ts for maintainability.
 * Provides parallel execution helpers with timeout and concurrency control.
 */

import { spawnAgent, type SpawnConfig } from './spawn.js';
import type { SpawnResult } from './spawn.js';
import { trackAgent } from './tracker.js';
import { execSync } from 'node:child_process';

// ── Constants ──────────────────────────────────────────

const MAX_CONCURRENCY = 4;
export const AGENT_TIMEOUT_MS = 120_000;

// ── Types ──────────────────────────────────────────────

export interface AgentTask {
  type: string;
  model: string;
  id: string;
  files?: string[];
  task: string;
}

// ── Sub-agent spawn helpers ────────────────────────────

export async function spawnAgentWithTimeout(
  task: AgentTask,
  extraContext: Record<string, unknown>,
): Promise<SpawnResult> {
  trackAgent(task.id, 'running', {
    type: task.type,
    model: task.model,
    goal: task.task?.slice(0, 120) ?? '',
    files: task.files,
  });

  try {
    const config: SpawnConfig = {
      type: task.type,
      model: task.model,
      thinking: 'max',
      maxTurns: 50,
      task: task.task || (task.files?.join(', ') || ''),
      files: task.files,
      context: extraContext,
      timeout: AGENT_TIMEOUT_MS,
      teamRunId: extraContext.teamRunId as string | undefined,
      memberName: extraContext.memberName as string | undefined,
    };
    const result = await spawnAgent(config);
    trackAgent(task.id, 'completed');
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trackAgent(task.id, 'failed', { error: msg });
    throw err;
  }
}

/**
 * Run tasks with a concurrency limit. At most `limit` tasks execute
 * simultaneously. Returns PromiseSettledResult array (same shape as
 * Promise.allSettled) so callers can handle individual failures.
 */
export async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      try {
        const value = await tasks[i]();
        results[i] = { status: 'fulfilled' as const, value };
      } catch (reason) {
        results[i] = { status: 'rejected' as const, reason };
      }
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Diff review ────────────────────────────────────────

/**
 * Run git diff and print the changes.
 * Used as a quality gate: after agents modify files, the diff is
 * surfaced so the coding agent can review its own changes before
 * moving to LSP verification → tests → commit.
 *
 * Returns an object with:
 *   - diff: the raw git diff output (empty string if no changes)
 *   - hasChanges: boolean indicating if there are uncommitted changes
 *   - stats: short stat summary (files changed, insertions, deletions)
 */
export function reviewDiff(): { diff: string; hasChanges: boolean; stats: string } {
  try {
    const stats = execSync('git diff --stat', {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: process.cwd(),
    }).trim();

    const diff = execSync('git diff', {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: process.cwd(),
    });

    // Also check for staged changes (in case of partial commits)
    const stagedDiff = execSync('git diff --cached --stat', {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: process.cwd(),
    }).trim();

    const hasChanges = diff.length > 0 || stagedDiff.length > 0;

    return { diff, hasChanges, stats };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[yu-agent] git diff failed:', msg);
    return { diff: '', hasChanges: false, stats: '' };
  }
}

/**
 * Log a summary of the diff to the console.
 * This is called automatically after agents finish modifying files,
 * giving the user (and the agent) visibility into what changed.
 */
export function printDiffSummary(diffResult: { diff: string; hasChanges: boolean; stats: string }): void {
  if (!diffResult.hasChanges) {
    console.log('[yu-agent] No changes detected after agent execution.');
    return;
  }

  console.log('');
  console.log('═ y u - a g e n t   D i f f   R e v i e w ═══════════════════════');
  console.log('');

  if (diffResult.stats) {
    console.log(`  ${diffResult.stats}`);
    console.log('');
  }

  // Show the full diff
  console.log(diffResult.diff);
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');
}

export async function runParallelGroup(
  group: string[],
  agentMap: Map<string, AgentTask>,
  context: Record<string, unknown>,
): Promise<Map<string, SpawnResult>> {
  const taskFactories = group.map((id) => {
    const task = agentMap.get(id);
    if (!task) throw new Error(`Unknown agent id: ${id}`);
    return () => spawnAgentWithTimeout(task, context).then((r) => [id, r] as const);
  });

  const results = await runWithConcurrencyLimit(taskFactories, MAX_CONCURRENCY);
  const resultMap = new Map<string, SpawnResult>();

  for (const result of results) {
    if (result.status === 'fulfilled') {
      resultMap.set(result.value[0], result.value[1]);
    } else {
      console.log('[yu-agent] Agent failed:', result.reason);
    }
  }

  return resultMap;
}
