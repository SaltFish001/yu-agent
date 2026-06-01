/**
 * yu-agent — Pi extension entry point.
 *
 * Registers sub-agent types, starts the MCP server manager,
 * and sets up the TUI monitor widget.
 *
 * Identity, session persistence, resume context, and the /session
 * command have been split into separate plugin files:
 *   identity.ts, session-store.ts, resumer.ts, session-cmd.ts
 *
 * Installation:  pi install ~/yu-agent
 * Standalone:    npm install -g yu-agent (via bin/yu.ts)
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAgents } from './config.js';
import { startMCPManager } from './mcp-manager.js';
import { setupMonitor } from './monitor.js';

export default function (pi: ExtensionAPI): void {
  // Register all 7 agent types with pi-subagents
  registerAgents();

  // Start MCP server manager (background lifecycle, independent of chat)
  startMCPManager().catch((err) =>
    console.warn('[yu-agent] MCP manager start failed:', err),
  );

  // Set up the TUI monitor widget (reads SQLite data written by the scheduler)
  setupMonitor(pi);
}
