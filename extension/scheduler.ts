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

import { createLogger } from './logger.js';
const log = createLogger('scheduler');

import type { SpawnResult } from './spawn.js';
import { classifyIntent, } from './classifier.js';
import {
  runParallelGroup,
  spawnAgentWithTimeout,
  reviewDiff,
  printDiffSummary,
  confirmDiff,
} from './executor.js';

import type { SchedulerContext } from './types.js';
import { parseAgentOutput } from './template.js';
import type { CodingOutput } from './template.js';

import { resetTracker, trackAgent, flushFinalStatus, loadDecisions, saveDecision } from './tracker.js';
import { checkpointGuard } from './checkpoint.js';
import { getRelevantContext } from './knowledge/index.js';
import { verifyWithLsp, runTests } from './verifier.js';
import { runTeamMode } from './team-orchestrator.js';

// ── executePlan: shared logic for handler() and beforeChat hook ──

/**
 * Execute a scheduler plan after classification.
 * Handles pass-through chat, team mode, and multi-agent execution.
 * Returns a response string, or null for unhandled pass-through.
 */
export async function executePlan(
  plan: import('./classifier.js').SchedulerPlan,
  userInput: string,
  sessionContext: Record<string, unknown> = {},
): Promise<string | null> {
  try {
    // ── Pass-through: dispatch to chat agent ──
    if (plan.pass_through) {
      try {
        // Try Pi SDK spawn first (has tool access). Add hard timeout to
        // prevent hanging when provider is misconfigured.
        const chatResult = await Promise.race([
          spawnAgentWithTimeout({
            type: 'chat',
            model: 'v4-flash',
            id: 'chat-1',
            task: userInput,
          }, {}),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Pi spawn timeout')), 30_000)
          ),
        ]);
        return chatResult?.response || '';
      } catch (err) {
        log.warn('Chat agent via Pi failed, falling back to direct API', err);
        // Fallback: direct DeepSeek API (no Pi dependency)
        try {
          const { chatCompletion } = await import('./deepseek.js');
          const { readFileSync, existsSync } = await import('node:fs');
          const { resolve } = await import('node:path');
          const { homedir } = await import('node:os');
          const chatPromptPath = resolve(homedir(), '.yu', 'prompts', 'chat.md');
          const systemPrompt = existsSync(chatPromptPath)
            ? readFileSync(chatPromptPath, 'utf-8')
            : 'You are a helpful assistant.';
          const result = await chatCompletion({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
              { role: 'user', content: userInput },
            ],
            max_tokens: 4096,
            temperature: 0.7,
          });
          if (result?.choices?.[0]?.message?.content) {
            return result.choices[0].message.content;
          }
        } catch { /* fallback failed too */ }
        log.warn('All chat paths failed, returning null');
        return null;
      }
    }

    // ── Team mode: multi-agent orchestration ──
    if (plan.intent === 'team') {
      const result = await runTeamMode(plan, sessionContext);
      return result;
    }

    // ── Multi-agent execution ──
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

    const context: Record<string, unknown> = { decisions: loadDecisions() };

    // 注入知识库上下文（RAG）
    try {
      const knowledgeContext = getRelevantContext(userInput, 5);
      if (knowledgeContext.length > 0) {
        context.knowledge = knowledgeContext;
      }
    } catch {
      // 非阻塞，知识库不可用不影响执行
    }

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
    let diffInfo: ReturnType<typeof reviewDiff> | undefined;
    if (modifiedFiles.length > 0) {
      diffInfo = reviewDiff();
      printDiffSummary(diffInfo);
    }

    // Step 4c: 交互审批 — 用户确认后才继续 LSP 验证
    if (diffInfo && diffInfo.hasChanges) {
      const approved = await confirmDiff(diffInfo);
      if (!approved) {
        // 用户放弃变更：还原工作区
        try {
          const { execSync } = await import('node:child_process');
          execSync('git checkout -- .', { encoding: 'utf-8', timeout: 10_000 });
          log.info('已还原所有未暂存变更。');
        } catch {
          log.warn('git checkout 失败，请手动还原。');
        }
        return '用户已放弃本次变更。';
      }
    }

    // Step 5: LSP verification
    let lspOk = true;
    if (modifiedFiles.length > 0) {
      const lspDone = checkpointGuard('lsp_verify', modifiedFiles, {
        intent: plan.intent,
        agents: plan.agents?.map((a) => a.type),
      });
      try {
        const lspResult = await verifyWithLsp(modifiedFiles, []);
        if (!lspResult.ok) {
          lspOk = false;
          const errorSummary = lspResult.errors
            .slice(0, 10)
            .map((e) => `${(e as Record<string, unknown>).file || '?'}:${(e as Record<string, unknown>).line || '?'} — ${(e as Record<string, unknown>).error || '?'}`)
            .join('\n      ');
          log.warn(`LSP verification failed with ${lspResult.errors.length} remaining errors`, { errors: errorSummary });
        }
      } finally {
        lspDone();
      }
    }

    // Step 6: Run tests (skip if LSP has errors — tests will likely fail anyway)
    if (modifiedFiles.length > 0 && lspOk) {
      await runTests(modifiedFiles);
    } else if (modifiedFiles.length > 0 && !lspOk) {
      log.info('Skipping tests due to unresolved LSP errors');
    }

    // Step 7: Save decision
    const commitDone = checkpointGuard('commit', modifiedFiles, {
      intent: plan.intent,
      lspOk,
    });
    try {
      if (plan.intent) {
        saveDecision(`${Date.now()}-${plan.intent}`, {
          intent: plan.intent,
          agents: plan.agents,
          files: modifiedFiles,
        });
      }
      commitDone();
    } catch {
      commitDone();
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

// ── Main handler ───────────────────────────────────────

export async function handler(
  userInput: string,
  sessionContext: Record<string, unknown> | SchedulerContext,
): Promise<string | null> {
  try {
    // Initialize tracker for this invocation
    resetTracker();

    // Step 1: Classify intent via scheduler agent
    const plan = await classifyIntent(userInput, sessionContext as Record<string, unknown>);

    // Step 2: Execute the plan
    return await executePlan(plan, userInput, sessionContext as Record<string, unknown>);
  } catch (err) {
    log.error('Scheduler handler failed', err, {
      userInput: userInput.slice(0, 200),
    });
    flushFinalStatus();
    return `调度器处理失败: ${err instanceof Error ? err.message : String(err)}。请重试或使用更简单的描述。`;
  }
}
