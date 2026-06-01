/**
 * yu-agent — Intent classifier & scheduler plan types.
 *
 * Extracted from scheduler.ts for maintainability.
 */

import { spawnAgent } from './spawn.js';
import type { SpawnConfig } from './spawn.js';
import { parseSchedulerOutput } from './template.js';
import { trackAgent } from './tracker.js';
import { loadDecisions } from './tracker.js';
import { AGENT_TIMEOUT_MS } from './executor.js';

// ── Constants ──────────────────────────────────────────

const MAX_RETRY_SCHEDULER = 2;

// ── Types ──────────────────────────────────────────────

export interface SchedulerPlan {
  pass_through?: boolean;
  reasoning?: string;
  intent?: string;
  agents?: { type: string; model: string; id: string; files?: string[]; task?: string }[];
  parallel_groups?: string[][];
  dependencies?: Record<string, string[]>;
}

// ── Scheduler agent call ───────────────────────────────

export async function classifyIntent(userInput: string, context: Record<string, unknown>): Promise<SchedulerPlan> {
  // Track the scheduler agent itself
  trackAgent('scheduler', 'running', {
    type: 'scheduler',
    model: 'v4-flash',
    goal: 'classify intent & generate plan',
  });

  for (let attempt = 0; attempt <= MAX_RETRY_SCHEDULER; attempt++) {
    try {
      const result = await spawnAgent({
        type: 'general-purpose',
        model: 'v4-flash',
        thinking: 'max',
        maxTurns: 3,
        task: userInput,
        context: { ...context, decisions: loadDecisions(), prompt_type: 'scheduler' },
        timeout: AGENT_TIMEOUT_MS,
      });

      const plan = parseSchedulerOutput(result.response);
      if (plan && (plan.pass_through !== undefined || (plan.intent && plan.agents))) {
        trackAgent('scheduler', 'completed');
        return plan;
      }

      console.log(`[yu-agent] ── Scheduler raw output (attempt ${attempt + 1}) ──`);
      console.log(result.response);
      console.log(`[yu-agent] ── End scheduler raw output ──`);
      console.warn(`[yu-agent] Scheduler output invalid (attempt ${attempt + 1}), retrying...`);
    } catch (err) {
      console.warn(`[yu-agent] Scheduler spawn failed (attempt ${attempt + 1}):`, err);
    }
  }

  trackAgent('scheduler', 'failed', { error: 'all retries exhausted' });
  return { pass_through: true, reasoning: 'scheduler failed, falling back to Pi native' };
}
