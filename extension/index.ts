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

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerAgents, validateMcpConfig, validateEnvVars } from './config.js';
import { startMCPManager } from './mcp-manager.js';
import { setupMonitor } from './monitor.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { MCP_CONFIG_PATH } from './paths.js';

// Module-level re-entry guard to prevent infinite recursion in the input hook
let _inBeforeChat = false;

/** Load ~/.yu/config.json */
function loadConfig(): Record<string, unknown> {
  try {
    const configPath = resolve(homedir(), '.yu', 'config.json');
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // non-fatal
  }
  return {};
}

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

  // ── Input hook (beforeChat equivalent) ──────────────────
  // Intercepts user input in Pi interactive mode, runs it through the
  // scheduler for intent classification and plan execution.

  /**
   * Adapter: ExtensionContext → Record<string, unknown>
   * Avoids unsafe `ctx as unknown as Record<string, unknown>` cast.
   * Only passes fields that executePlan's sessionContext actually uses.
   */
  function adaptContext(ctx: ExtensionContext): Record<string, unknown> {
    return { cwd: ctx.cwd, hasUI: ctx.hasUI, mode: ctx.mode };
  }

  pi.on('input', async (event, ctx) => {
    if (_inBeforeChat) {
      return; // re-entry guard
    }
    _inBeforeChat = true;
    try {
      // Check config: is the scheduler hook enabled?
      const config = loadConfig();
      const hooks = config.hooks as Record<string, { enabled: boolean }> | undefined;
      if (hooks?.beforeChat?.enabled === false) {
        return; // hook disabled, let Pi handle normally
      }

      const inputText = event.text?.trim();
      if (!inputText) return;

      const { classifyIntent } = await import('./classifier.js');
      const plan = await classifyIntent(inputText, {});

      // Pass-through: let Pi handle it
      if (plan.pass_through) return;

      // Execute the plan if we have intent + agents
      // (allow empty agents array — executePlan validates internally)
      if (plan.intent && plan.agents) {
        const { executePlan } = await import('./scheduler.js');
        const result = await executePlan(plan, inputText, adaptContext(ctx));
        if (result) {
          // Output the result. In TUI interactive mode, paste into editor
          // so the user sees the response.
          if (ctx.hasUI) {
            ctx.ui.pasteToEditor(result);
          } else {
            console.log(result);
          }
          return { action: 'handled' as const };
        }
      }

      return;
    } catch (err) {
      log.warn('Input hook error (non-fatal, passing through)', err);
      return;
    } finally {
      _inBeforeChat = false;
    }
  });

  // Register all 7 agent types with pi-subagents
  registerAgents();

  // Start MCP server manager (background lifecycle, independent of chat)
  startMCPManager().catch((err) =>
    log.warn('MCP manager start failed', err),
  );

  // Set up the TUI monitor widget (reads SQLite data written by the scheduler)
  setupMonitor(pi);
}
