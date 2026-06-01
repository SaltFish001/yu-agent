/**
 * yu-agent — Agent executor utilities.
 *
 * Extracted from scheduler.ts for maintainability.
 * Provides parallel execution helpers with timeout and concurrency control.
 */

import { spawnAgent, type SpawnConfig } from './spawn.js';
import type { SpawnResult } from './spawn.js';
import { writeAgentStatus } from './status.js';
import { trackAgent } from './tracker.js';

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
