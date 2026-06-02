/**
 * yu-agent — Scheduler: hook handler.
 *
 * The core handler registered on Pi's beforeChat hook.
 * Flow:
 *   1. Spawn scheduler sub-agent (LLM) for intent classification
 *   2. Parse JSON output → determine intent, agents, parallel groups
 *   3. If non-programming → pass through to Pi native agent
 *   4. If programming → spawn sub-agents in parallel groups, handle results
 *   5. Diff review — git diff surfaced for agent self-review
 *   6. LSP verification → test run → decisions → merge → return
 *
 * Timeout: sub-agents use AGENT_TIMEOUT_MS (120s, from executor.ts).
 *          The scheduler agent itself also uses AGENT_TIMEOUT_MS (classifier.ts).
 */

import type { SpawnResult } from './spawn.js';
import { classifyIntent, } from './classifier.js';
import {
  runParallelGroup,
  reviewDiff,
  printDiffSummary,
} from './executor.js';

import type { SchedulerContext } from './types.js';
import { parseAgentOutput } from './template.js';
import type { CodingOutput } from './template.js';

import { resetTracker, trackAgent, flushFinalStatus, loadDecisions, saveDecision } from './tracker.js';
import { verifyWithLsp, runTests } from './verifier.js';
import { runTeamMode } from './team-orchestrator.js';

// ── Main handler ───────────────────────────────────────

export async function handler(
  userInput: string,
  sessionContext: Record<string, unknown> | SchedulerContext,
): Promise<string | null> {
  // Initialize tracker for this invocation
  resetTracker();

  // Step 1: Classify intent via scheduler agent
  const plan = await classifyIntent(userInput, sessionContext as Record<string, unknown>);

  // ── Pass-through: hand off to Pi native agent ──
  if (plan.pass_through) {
    trackAgent('pi-native', 'running', {
      type: 'pi-default',
      model: '',
      goal: `处理: ${userInput.slice(0, 100)}`,
    });
    trackAgent('pi-native', 'completed');
    flushFinalStatus();
    return null;
  }

  // ── Team mode: multi-agent orchestration ──
  if (plan.intent === 'team') {
    try {
      const result = await runTeamMode(plan, sessionContext as Record<string, unknown>);
      return result;
    } finally {
      flushFinalStatus();
    }
  }

  // ── Multi-agent execution ──
  try {
    // Step 2: Build agent map
    const agentTasks = (plan.agents || []).map((a) => ({
      type: a.type,
      model: a.model,
      id: a.id,
      files: a.files,
      task: userInput,
    }));
    const agentMap = new Map(agentTasks.map((t) => [t.id, t]));

    // Step 3: Execute parallel groups in order
    const allResults = new Map<string, SpawnResult>();
    const groups = plan.parallel_groups || agentTasks.map((t) => [t.id]);

    const context = { decisions: loadDecisions() };

    for (const group of groups) {
      const groupResults = await runParallelGroup(group, agentMap, context);
      for (const [id, result] of groupResults) {
        allResults.set(id, result);
      }
    }

    // Step 4: Collect modified files
    const modifiedFiles: string[] = [];
    for (const [, result] of allResults) {
      const output = parseAgentOutput(result?.response || '');
      if (output && 'files_modified' in output && Array.isArray((output as CodingOutput).files_modified)) {
        modifiedFiles.push(...(output as CodingOutput).files_modified);
      }
    }

    // Step 4b: Diff review — show the agent what changed
    if (modifiedFiles.length > 0) {
      const diffInfo = reviewDiff();
      printDiffSummary(diffInfo);
    }

    // Step 5: LSP verification
    let lspOk = true;
    if (modifiedFiles.length > 0) {
      const lspResult = await verifyWithLsp(modifiedFiles, []);
      if (!lspResult.ok) {
        lspOk = false;
        const errorSummary = lspResult.errors
          .slice(0, 10)
          .map((e) => `${(e as Record<string, unknown>).file || '?'}:${(e as Record<string, unknown>).line || '?'} — ${(e as Record<string, unknown>).error || '?'}`)
          .join('\n      ');
        console.warn(`[yu-agent] LSP verification failed with ${lspResult.errors.length} remaining errors:\n      ${errorSummary}`);
      }
    }

    // Step 6: Run tests (skip if LSP has errors — tests will likely fail anyway)
    if (modifiedFiles.length > 0 && lspOk) {
      await runTests(modifiedFiles);
    } else if (modifiedFiles.length > 0 && !lspOk) {
      console.log('[yu-agent] Skipping tests due to unresolved LSP errors');
    }

    // Step 7: Save decision
    if (plan.intent) {
      saveDecision(`${Date.now()}-${plan.intent}`, {
        intent: plan.intent,
        agents: plan.agents,
        files: modifiedFiles,
      });
    }

    // Step 8: Aggregate and return
    const summaries: string[] = [];
    for (const [, result] of allResults) {
      const output = parseAgentOutput(result?.response || '');
      if (output && 'summary' in output) {
        summaries.push((output as CodingOutput).summary);
      }
    }

    return summaries.join('\n') || JSON.stringify(Object.fromEntries(allResults));
  } finally {
    flushFinalStatus();
  }
}
