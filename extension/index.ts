/**
 * yu-agent — Pi extension entry point.
 *
 * Registers the beforeChat hook that intercepts all user input
 * and routes programming tasks through the yu-agent scheduler.
 *
 * Also registers the team mailbox hook for team-aware sessions,
 * and injects yu-agent identity/status into pass-through messages.
 *
 * Installation:  pi install ~/yu-agent
 * Standalone:    npm install -g yu-agent (via bin/yu.ts)
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAgents } from './config.js';
import { startMCPManager } from './mcp-manager.js';
import type { BeforeChatHookContext } from './types.js';
import { createTeamMailboxHook } from './team/integration.js';
import { setupMonitor } from './monitor.js';
import { getSessionTag } from './session-context.js';
import { getSessionAgent, getSessionModel, getSessionParent } from './session-context.js';
import { getSummary, getCache, upsertSession } from './db.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

let _nameCaptured = false;

/**
 * Read status files and build a brief status summary string.
 */
function buildStatusSummary(): string {
  try {
    const tag = getSessionTag();
    const s = getSummary(tag);
    const c = getCache(tag);
    const parts: string[] = [];

    if (s) {
      if (s.running > 0) parts.push(`${s.running} running`);
      if (s.completed > 0) parts.push(`${s.completed} done`);
      if (s.failed > 0) parts.push(`${s.failed} failed`);
    }

    if (c && c.turnCount > 0 && typeof c.hitRate === 'number') {
      parts.push(`cache ${Math.round(c.hitRate * 100)}%`);
    }

    return parts.length > 0 ? parts.join(' · ') : 'idle';
  } catch {
    return '';
  }
}

/**
 * yu-agent extension factory.
 * Registers sub-agent types and hooks into Pi's runtime.
 */
export default function (pi: ExtensionAPI): void {
  // Register all 7 agent types with pi-subagents
  registerAgents();

  // Start MCP server manager (background lifecycle, independent of chat)
  startMCPManager().catch((err) =>
    console.warn('[yu-agent] MCP manager start failed:', err),
  );

  // Set up the TUI monitor widget (reads ~/yu-agent/status/*.json)
  setupMonitor(pi);

  // Check if hooks API is available (only used in chat/TUI mode)
  // NOTE: (pi as any).hooks does NOT exist on the standard ExtensionAPI.
  // The entire hooks.register() block below is dead code — kept as a
  // placeholder in case Pi adds the hooks API later.
  // Identity injection works via the documented before_agent_start event below.

  if (typeof (pi as any).hooks?.register === 'function') {
    // Register team mailbox hook FIRST (lower priority — runs first)
    (pi as any).hooks.register('beforeChat', {
      name: 'yu-agent-team',
      description: 'Team mailbox message injection for team members',
      handler: createTeamMailboxHook(),
    });

    // Register the main scheduler hook SECOND (higher priority — runs after)
    (pi as any).hooks.register('beforeChat', {
      name: 'yu-agent',
      description: 'yu-agent programming task dispatcher',
      handler: async (context: BeforeChatHookContext) => {
        const { handler: schedulerHandler } = await import('./scheduler.js');
        const result = await schedulerHandler(context.message, {
          session: context.session,
          teamRunId: (context as any).teamRunId,
          memberName: (context as any).memberName,
        });

        if (result !== null) {
          return { action: 'respond' as const, content: result };
        }

        // Pass-through: inject identity + live status into context
        const status = buildStatusSummary();
        const identityPrefix =
`<system>
你叫 yu-agent，是一条小咸鱼变成的编程助手。
你不是 Pi，你是 yu-agent。
问你是什么的时候，要说「我是一条小咸鱼呀～」
</system>
<status>${status || 'idle'}</status>
---
`;
        context.message = identityPrefix + context.message;
        return { action: 'pass_through' as const };
      },
    });
  }

  // Override system prompt identity via before_agent_start (documented ExtensionAPI event).
  // The message field is a CustomMessage (customType + content + display + details),
  // NOT an AgentMessage — it gets injected as role="custom" in the conversation.
  // The systemPrompt field replaces the agent's system prompt entirely.
  pi.on('before_agent_start', (event: { systemPrompt: string; prompt?: string }) => {
    // Capture first user prompt as session display name
    if (!_nameCaptured && event.prompt) {
      _nameCaptured = true;
      const summary = event.prompt
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      if (summary) {
        process.env.YU_SESSION_NAME = summary;
        const tag = getSessionTag();
        upsertSession(tag, {
          name: summary,
          cwd: process.cwd(),
          agent: getSessionAgent() || undefined,
          model: getSessionModel() !== '{}' ? getSessionModel() : undefined,
          parentId: getSessionParent() || undefined,
        });
      }
    }

    const status = buildStatusSummary();

    // ── Resume context injection ─────────────────────────────
    // Check for resume_context.json written by `yu session resume <tag>`
    let resumeBlock = '';
    const resumeFile = resolve(homedir(), '.yu', 'resume_context.json');
    if (existsSync(resumeFile) || process.env.YU_RESUME_TAG) {
      try {
        if (existsSync(resumeFile)) {
          const ctx = JSON.parse(readFileSync(resumeFile, 'utf-8'));
          if (ctx.messages && Array.isArray(ctx.messages) && ctx.messages.length > 0) {
            const historyLines: string[] = ['<history>'];
            for (const msg of ctx.messages) {
              const role = msg.role === 'user' ? 'User' : 'Assistant';
              // Truncate very long messages to avoid token blowup
              const content = (msg.content || '').slice(0, 4000);
              historyLines.push(`<${role}>${content}</${role}>`);
            }
            historyLines.push('</history>');
            resumeBlock = `\n\n以下是你之前会话中的历史消息（从 session "${ctx.tag || process.env.YU_RESUME_TAG}" 恢复）：\n${historyLines.join('\n')}\n\n请基于以上历史上下文继续帮助用户。如果你发现有中断的未完成任务，优先继续完成它。\n`;
          }
          // Clean up the temp file
          unlinkSync(resumeFile);
        }
      } catch (e) {
        console.warn('[yu-agent] Failed to load resume context:', e);
        // Best-effort cleanup
        try { if (existsSync(resumeFile)) unlinkSync(resumeFile); } catch { /* ignore */ }
      }
      delete process.env.YU_RESUME_TAG;
    }

    return {
      systemPrompt:
`你叫 yu-agent，是一条小咸鱼变成的编程助手～

你不是 Pi，你是 yu-agent。
问你是什么的时候，要说「我是一条小咸鱼呀～」

${status ? `当前状态：${status}\n` : ''}你会写代码、改 bug、审查代码、出方案、搜代码、生成文档，还能派单给专门的小 agent 干活。

你的 agent type 有这些：coding, review, plan, search, commit, lsp, doc, general-purpose（调度器）。
拿不准的时候先让调度器判断一下再动手。
${resumeBlock}`,
    };
  });
}
