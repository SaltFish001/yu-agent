/**
 * yu-agent — Agent executor utilities.
 *
 * Extracted from scheduler.ts for maintainability.
 * Provides parallel execution helpers with timeout and concurrency control.
 */

import { createLogger } from './logger.js';
const log = createLogger('executor');

import { spawnAgent, type SpawnConfig } from './spawn.js';
import type { SpawnResult } from './spawn.js';
import { trackAgent } from './tracker.js';
import { checkpointGuard } from './checkpoint.js';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ResourceLimits } from './config.js';

// ── Constants ──────────────────────────────────────────

const MAX_CONCURRENCY = 4;
export const AGENT_TIMEOUT_MS = 120_000;

// ── Concurrency limiter ───────────────────────────────

const activeAgents = new Set<string>();
const activeByType = new Map<string, number>();

/**
 * Acquire a concurrency slot for agent execution.
 * Blocks until the global and per-type limits allow a new agent.
 */
export async function acquireConcurrencySlot(
  type: string,
  sessionTag: string,
  limits: ResourceLimits = {}
): Promise<void> {
  const maxGlobal = limits.maxConcurrentAgents ?? 8;
  const maxPerType = limits.maxPerPool ?? 4;

  while (activeAgents.size >= maxGlobal || (activeByType.get(type) ?? 0) >= maxPerType) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }

  const id = `${type}-${sessionTag}-${Date.now()}`;
  activeAgents.add(id);
  activeByType.set(type, (activeByType.get(type) ?? 0) + 1);
}

/**
 * Release a concurrency slot after agent execution completes.
 */
export function releaseConcurrencySlot(type: string): void {
  const count = activeByType.get(type) ?? 1;
  if (count <= 1) activeByType.delete(type);
  else activeByType.set(type, count - 1);
  // Remove first matching entry from activeAgents
  for (const id of activeAgents) {
    if (id.startsWith(type)) {
      activeAgents.delete(id);
      break;
    }
  }
}

/**
 * Get the current concurrency snapshot (for monitoring / debugging).
 */
export function getConcurrencySnapshot(): { global: number; byType: Record<string, number> } {
  const byType: Record<string, number> = {};
  for (const [type, count] of activeByType) {
    byType[type] = count;
  }
  return { global: activeAgents.size, byType };
}

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
  // 保存 checkpoint: agent spawn 前
  const done = checkpointGuard('agent_spawn', task.files ?? [], {
    agentType: task.type,
    agentModel: task.model,
    taskGoal: task.task?.slice(0, 200),
  });
  try {
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
  } finally {
    done(); // 无论成功或失败都清理 checkpoint
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
/**
 * 交互式 diff 确认：打印变更并等待用户 y/N 确认。
 * 超时 60 秒无输入则自动放弃。
 *
 * @returns true 用户确认（y） | false 用户拒绝或超时（N）
 */
export async function confirmDiff(diffResult: {
  diff: string;
  hasChanges: boolean;
  stats: string;
}): Promise<boolean> {
  if (!diffResult.hasChanges) {
    return true; // 无变更，无需确认
  }

  console.log('');
  console.log('═ 人类审批 ═══════════════════════════════════════════════');
  console.log('  以上是 agent 的变更。请确认是否继续：');
  console.log('');

  return new Promise<boolean>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rl.close();
        console.log('  ⏱ 超时未响应，自动放弃变更。');
        console.log('════════════════════════════════════════════════════════════════');
        console.log('');
        resolve(false);
      }
    }, 60_000);

    rl.question('  Apply these changes? (y/N) ', (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();

      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'y' || trimmed === 'yes') {
        console.log('  ✓ 已确认，继续执行。');
        console.log('════════════════════════════════════════════════════════════════');
        console.log('');
        resolve(true);
      } else {
        console.log('  ✗ 已放弃变更。');
        console.log('════════════════════════════════════════════════════════════════');
        console.log('');
        resolve(false);
      }
    });
  });
}

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
    log.warn('git diff failed', msg);
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
    log.info('No changes detected after agent execution.');
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
      log.error('Agent failed', result.reason);
    }
  }

  return resultMap;
}
