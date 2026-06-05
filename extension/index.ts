/**
 * yu-agent — Pi extension entry point.
 *
 * Registers sub-agent types (for Pi-managed commands), starts the MCP
 * server manager, and sets up the TUI monitor widget.
 *
 * Identity injection and session management have been replaced by
 * direct DeepSeek API calls and the Topic system.
 *
 * Installation:  pi install ~/yu-agent
 * Standalone:    npm install -g yu-agent (via bin/yu.ts)
 */

import { createLogger } from './logger.js';
const log = createLogger('index');

import type { ExtensionAPI, ExtensionCommandContext, ContextEvent } from '@earendil-works/pi-coding-agent';
import { registerAgents, validateMcpConfig, validateEnvVars } from './config.js';
import { startMCPManager } from './mcp-manager.js';
import { setupMonitor } from './monitor.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { MCP_CONFIG_PATH } from './paths.js';

export default async function (pi: ExtensionAPI): Promise<void> {
  // Inject DeepSeek API key from ~/.yu/config.json into env for Pi's auth system
  try {
    const configPath = resolve(homedir(), '.yu', 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const dsKey = config?.apiKeys?.deepseek;
      if (dsKey && typeof dsKey === 'string' && dsKey.trim() && !process.env.DEEPSEEK_API_KEY) {
        process.env.DEEPSEEK_API_KEY = dsKey.trim();
        log.info('DeepSeek API key loaded from ~/.yu/config.json');
      }
    }
  } catch {
    // non-fatal
  }

  // ── Topic integration ─────────────────────────────────
  try {
    const { getActive, topicCommand } = await import('./topic.js');

    // Register /topic slash command
    pi.registerCommand('topic', {
      description: 'Topic management. Usage: /topic list | switch <name> | new <name> <dir> | rename <old> <new> | archive <name>',
      async handler(args: string, ctx: ExtensionCommandContext) {
        const parts = args.trim().split(/\s+/);
        const sub = parts[0] || 'list';
        const out = topicCommand(sub, parts.slice(1));
        ctx.ui.notify(out);
      },
    });

    // On session start, set session name to active topic
    pi.on('session_start', () => {
      const active = getActive();
      if (active) {
        pi.setSessionName(`topic:${active.name}`);
        try {
          process.chdir(active.dir);
        } catch {
          // dir might be gone
        }
      }
    });

    // Inject topic info into system prompt before each agent start
    pi.on('before_agent_start', (event) => {
      const active = getActive();
      if (active) {
        const suffix = active.summary
          ? `\n\n[Current topic: ${active.name} — ${active.dir}] ${active.summary}`
          : `\n\n[Current topic: ${active.name} — ${active.dir}]`;
        return { systemPrompt: event.systemPrompt + suffix };
      }
    });
  } catch (err) {
    log.warn('Topic integration failed (non-fatal)', err);
  }

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
