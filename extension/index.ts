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
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const STATUS_DIR = resolve(homedir(), 'yu-agent', 'status');

/**
 * Read status files and build a brief status summary string.
 */
function buildStatusSummary(): string {
  try {
    const summaryPath = resolve(STATUS_DIR, 'summary.json');
    const cachePath = resolve(STATUS_DIR, 'cache.json');
    const parts: string[] = [];

    if (existsSync(summaryPath)) {
      const s = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      if (s.running > 0) parts.push(`${s.running} running`);
      if (s.completed > 0) parts.push(`${s.completed} done`);
      if (s.failed > 0) parts.push(`${s.failed} failed`);
    }

    if (existsSync(cachePath)) {
      const c = JSON.parse(readFileSync(cachePath, 'utf-8'));
      if (c.turnCount > 0 && typeof c.hitRate === 'number') {
        parts.push(`cache ${Math.round(c.hitRate * 100)}%`);
      }
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

        // Pass-through: inject yu-agent identity and live status into context
        const status = buildStatusSummary();
        const identityBlock = `[yu-agent] You are yu-agent, an AI-powered programming agent. You are a specialized layer on top of Pi — not Pi itself. When asked who you are, say you are yu-agent.\n${status ? `[Status] ${status}` : ''}\n---\n`;
        return { action: 'pass_through' as const, content: identityBlock + context.message };
      },
    });
  }
}
