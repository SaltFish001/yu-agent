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
import { setupMonitor } from './monitor.js';
import { getSessionTag, getSessionAgent, getSessionModel, getSessionParent } from './session-context.js';
import { getSummary, getCache, upsertSession, insertMessage, ensureSlug, listSessions, getSessionMeta, getMessages } from './db.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { YU_HOME } from './paths.js';

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
  // The hooks.register() block was removed — kept as history:
  // https://github.com/SaltFish001/yu-agent/commit/...

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

    // ── Save user message (every before_agent_start = each user prompt) ──
    if (event.prompt) {
      try {
        const tag = getSessionTag();
        insertMessage(tag, 'user', event.prompt);
        ensureSlug(tag); // ensure slug exists on first user message
      } catch (e) {
        console.warn('[yu-agent] Failed to save user message:', e);
      }
    }

    const status = buildStatusSummary();

    // ── Resume context injection ─────────────────────────────
    // Check for resume_context.json written by `yu session resume <tag>`
    let resumeBlock = '';
    const resumeFile = resolve(YU_HOME, 'resume_context.json');
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

  // ── Register /session slash command ──
  pi.registerCommand('session', {
    description: '查看/恢复历史 session。用法：/session list, /session resume <tag>, /session show <tag>',
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || '';

      if (sub === 'list' || !sub) {
        const sessions = listSessions().filter(s => !s.archivedAt);
        if (sessions.length === 0) {
          ctx.ui.notify('No historical sessions found.', 'info');
          return;
        }

        if (!sub && ctx.hasUI && sessions.length > 0) {
          // Interactive: show select dialog
          const options = sessions.slice(0, 20).map(s => {
            const name = s.name || s.tag.slice(0, 20);
            const agent = s.agent ? `[${s.agent}]` : '';
            const slug = s.slug ? `(${s.slug})` : '';
            return `${name} ${agent}${slug} — ${new Date(s.updatedAt).toLocaleString()}`;
          });

          const choice = await ctx.ui.select('Select session to resume:', options);
          if (!choice) {
            ctx.ui.notify('Session selection cancelled.', 'info');
            return;
          }

          const idx = options.indexOf(choice);
          if (idx === -1 || idx >= sessions.length) return;
          const picked = sessions[idx];
          const meta = getSessionMeta(picked.tag);
          if (!meta) {
            ctx.ui.notify(`Session "${picked.tag}" metadata not found.`, 'error');
            return;
          }

          const md = meta.metadata ? JSON.parse(meta.metadata) : {};
          const piPath = md.piSessionPath;
          if (!piPath || !existsSync(piPath)) {
            ctx.ui.notify(`Session "${picked.tag}" has no recoverable Pi session file.`, 'warning');
            return;
          }

          try {
            await ctx.switchSession(piPath);
            ctx.ui.notify(`Switched to session: ${meta.name || picked.tag}`, 'info');
          } catch (e: any) {
            ctx.ui.notify(`Failed to switch session: ${e.message}`, 'error');
          }
          return;
        }

        // Non-interactive: show table
        const lines = sessions.slice(0, 15).map(s => {
          const name = (s.name || s.tag.slice(0, 20)).padEnd(30);
          const agent = s.agent ? s.agent.padEnd(10) : ' '.repeat(10);
          const time = new Date(s.updatedAt).toLocaleString();
          return `${name} ${agent} ${time}`;
        });
        lines.unshift('Session                          Agent      Updated');
        lines.unshift('─'.repeat(65));
        if (sessions.length > 15) lines.push(`... and ${sessions.length - 15} more`);
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      if (sub === 'resume') {
        const tag = parts.slice(1).join(' ');
        if (!tag) {
          ctx.ui.notify('Usage: /session resume <tag>', 'warning');
          return;
        }
        const meta = getSessionMeta(tag);
        if (!meta) {
          ctx.ui.notify(`Session "${tag}" not found.`, 'error');
          return;
        }
        const md = meta.metadata ? JSON.parse(meta.metadata) : {};
        const piPath = md.piSessionPath;
        if (!piPath || !existsSync(piPath)) {
          ctx.ui.notify(`Session "${tag}" has no recoverable Pi session file.`, 'warning');
          return;
        }
        try {
          await ctx.switchSession(piPath);
          ctx.ui.notify(`Switched to session: ${meta.name || tag}`, 'info');
        } catch (e: any) {
          ctx.ui.notify(`Failed to switch session: ${e.message}`, 'error');
        }
        return;
      }

      if (sub === 'show') {
        const tag = parts.slice(1).join(' ');
        if (!tag) {
          ctx.ui.notify('Usage: /session show <tag>', 'warning');
          return;
        }
        const meta = getSessionMeta(tag);
        if (!meta) {
          ctx.ui.notify(`Session "${tag}" not found.`, 'error');
          return;
        }
        const md = meta.metadata ? JSON.parse(meta.metadata) : {};
        const lines = [
          `Session: ${meta.name || tag}`,
          `  tag: ${tag}`,
          `  slug: ${meta.slug || '—'}`,
          `  agent: ${meta.agent || '—'}`,
          `  cwd: ${meta.cwd}`,
          `  created: ${new Date(meta.createdAt).toLocaleString()}`,
          `  updated: ${new Date(meta.updatedAt).toLocaleString()}`,
          `  archived: ${meta.archivedAt ? new Date(meta.archivedAt).toLocaleString() : 'no'}`,
          `  piSessionPath: ${md.piSessionPath || '—'}`,
          '',
          'Recent messages:',
        ];
        const msgs = getMessages(tag, 5);
        for (const m of msgs) {
          const role = m.role === 'user' ? 'You' : 'yu';
          const content = m.content.slice(0, 200);
          lines.push(`  [${role}] ${content}`);
        }
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      ctx.ui.notify('Unknown subcommand. Usage: /session list, /session resume <tag>, /session show <tag>', 'warning');
    },
  });
}
