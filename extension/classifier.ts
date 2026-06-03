/**
 * yu-agent — Intent classifier & scheduler plan types.
 *
 * Extracted from scheduler.ts for maintainability.
 */

import { createLogger } from './logger.js';
const log = createLogger('classifier');

import { spawnAgent } from './spawn.js';
import { parseSchedulerOutput } from './template.js';
import { trackAgent } from './tracker.js';
import { loadDecisions } from './tracker.js';
import { AGENT_TIMEOUT_MS } from './executor.js';

// ── Constants ──────────────────────────────────────────

const MAX_RETRY_SCHEDULER = 0;
const SHORT_INPUT_MAX_LENGTH = 200;

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

export async function classifyIntent(
  userInput: string,
  context: Record<string, unknown>,
  spawnAgentFn?: typeof spawnAgent,
): Promise<SchedulerPlan> {
  // Track the scheduler agent itself
  trackAgent('scheduler', 'running', {
    type: 'scheduler',
    model: 'v4-flash',
    goal: 'classify intent & generate plan',
  });

  // Fast path: if the input looks like a full instruction (role-playing,
  // long prompt, or contains specific task markers), skip scheduling.
  // The scheduler agent is for SHORT classification prompts like
  // "检查这个bug" or "帮我重构这个函数", not for full coding instructions.
  const trimmed = userInput.trim();
  const isLong = trimmed.length > SHORT_INPUT_MAX_LENGTH;
  const isRolePlay = /^你是|^你是一个/.test(trimmed);
  if (isLong || isRolePlay) {
    trackAgent('scheduler', 'completed');
    log.info(`Scheduler: full instruction detected (${trimmed.length} chars), passing through`);
    return { pass_through: true, reasoning: 'full instruction, no classification needed' };
  }

  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRY_SCHEDULER; attempt++) {
    try {
      const spawn = spawnAgentFn ?? spawnAgent;
      const result = await spawn({
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

      // If output contains no JSON structure at all, the agent returned pure
      // markdown/text — fall back immediately instead of retrying.
      const hasJson = /[{[]/.test(result.response) || /```json/i.test(result.response);
      if (!hasJson) {
        log.info(`── Scheduler raw output (attempt ${attempt + 1}) ──`);
        console.log(result.response);
        log.info(`── End scheduler raw output ──`);
        log.warn('Scheduler output is not JSON, falling back to pass-through');
        break;
      }

      log.info(`── Scheduler raw output (attempt ${attempt + 1}) ──`);
      console.log(result.response);
      log.info(`── End scheduler raw output ──`);
      log.warn(`Scheduler output invalid (attempt ${attempt + 1}), retrying...`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Scheduler spawn failed (attempt ${attempt + 1})`, err);
      lastError = msg;
    }
  }

  trackAgent('scheduler', 'failed', { error: lastError || 'all retries exhausted' });
  return { pass_through: true, reasoning: 'scheduler failed, falling back to Pi native' };
}
