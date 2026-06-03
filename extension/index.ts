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

import { createLogger } from './logger.js';
const log = createLogger('index');

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAgents, validateMcpConfig, validateEnvVars } from './config.js';
import { startMCPManager } from './mcp-manager.js';
import { setupMonitor } from './monitor.js';
import { existsSync, readFileSync } from 'node:fs';
import { MCP_CONFIG_PATH } from './paths.js';

export default function (pi: ExtensionAPI): void {
  // Validate mcp.config.json before anything else
  validateMcpConfig();

  // Validate environment variables at startup
  try {
    let mcpConfig: { servers?: Record<string, { env?: Record<string, string> }> } | undefined;
    if (existsSync(MCP_CONFIG_PATH)) {
      mcpConfig = JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf-8'));
    }
    const { errors, warnings } = validateEnvVars(mcpConfig);
    if (errors.length > 0) {
      for (const err of errors) {
        log.error(err);
      }
    }
    if (warnings.length > 0) {
      for (const warn of warnings) {
        log.warn(warn);
      }
    }
  } catch (err) {
    log.warn('Environment variable validation failed (non-fatal)', err);
  }

  // Register all 7 agent types with pi-subagents
  registerAgents();

  // Start MCP server manager (background lifecycle, independent of chat)
  startMCPManager().catch((err) =>
    log.warn('MCP manager start failed', err),
  );

  // Set up the TUI monitor widget (reads SQLite data written by the scheduler)
  setupMonitor(pi);
}
