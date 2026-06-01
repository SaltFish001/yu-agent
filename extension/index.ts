/**
 * yu-agent — Pi extension entry point.
 *
 * Registers the beforeChat hook that intercepts all user input
 * and routes programming tasks through the yu-agent scheduler.
 *
 * Also registers the team mailbox hook for team-aware sessions.
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

        return { action: 'pass_through' as const };
      },
    });
  }
}
