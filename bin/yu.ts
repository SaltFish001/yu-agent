#!/usr/bin/env node
/**
 * yu-agent — Standalone CLI entry point.
 *
 * Wraps Pi's programming agent runtime with yu-agent extensions.
 * Usage:
 *   yu "prompt"            → One-shot programming task (Pi print mode)
 *   yu chat                → Interactive REPL (Pi interactive mode)
 *   yu review <path>       → Review code
 *   yu plan <task>         → Generate plan
 *   yu team <subcommand>   → Team mode management
 *   yu install <package>   → Install MCP server
 *   yu update              → Self-update
 *   yu uninstall           → Remove yu-agent
 */

import { main } from '@earendil-works/pi-coding-agent';
import subagents from '@tintinweb/pi-subagents/dist/index.js';
import yuAgent from '../extension/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/** Print cache hit-rate summary from cache.json if available. */
function printCacheStats(): void {
  const cachePath = resolve(homedir(), 'yu-agent', 'status', 'cache.json');
  if (!existsSync(cachePath)) return;
  try {
    const data: Record<string, unknown> = JSON.parse(readFileSync(cachePath, 'utf-8'));
    if (data && typeof data.hitRate === 'number' && (data as { turnCount?: number }).turnCount! > 0) {
      const pct = Math.round((data.hitRate as number) * 100);
      const hits = (data.totalHits as number) ?? 0;
      const total = hits + ((data.totalMisses as number) ?? 0);
      console.log(`\nCache: ${pct}% hit rate (${hits} hits / ${total} total)`);
    }
  } catch {
    // ignore — no data yet
  }
}

const COMMANDS = new Set([
  'review', 'plan', 'team', 'coding',
  'commit', 'doc', 'search', 'lsp', 'run', 'monitor',
]);

const HELP = `yu-agent — AI-powered programming agent

Usage:
  yu <prompt>                  One-shot programming task
  yu coding <prompt>           Start a coding task
  yu review <path>             Review code
  yu plan <task>               Generate implementation plan
  yu commit <msg>              Generate commit message
  yu doc <task>                Generate documentation
  yu search <query>            Search codebase
  yu lsp <path>                LSP type check & fix
  yu team create <name> ...    Create a team for multi-agent work
  yu team list                 List active teams
  yu team status <runId>       Show team status
  yu team send <runId> <to>    Send message to team member
  yu team task <runId> <act>   Manage shared task board
  yu team shutdown <runId>     Request team shutdown
  yu team delete <runId>       Delete team run
  yu chat                      Interactive REPL
  yu run <prompt>               Direct scheduler invocation (bypass Pi hooks)
  yu monitor [--once]           Live status dashboard (--once for single snapshot)
  yu install <pkg>             Install MCP server
  yu update                    Self-update
  yu uninstall                 Remove yu-agent

Team Examples:
  yu team create my-team       Create single-member team
  yu team create squad \ 
    lead:architect coder:coding reviewer:review
  yu team task <runId> create "Fix login bug"
  yu team send <runId> coder "Check task #abc123"
`;

async function mainCli(): Promise<void> {
  const args = process.argv.slice(2);

  // Help
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log(HELP);
    process.exit(0);
  }

  // Version
  if (args[0] === '--version' || args[0] === '-v') {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    console.log(`yu-agent v${pkg.default.version}`);
    process.exit(0);
  }

  // `yu team <subcommand>` — handled directly, no Pi session needed
  if (args[0] === 'team') {
    const subcommand = args[1] || 'help';
    const teamArgs = args.slice(2);
    const { teamCommand } = await import('../extension/team/index.js');
    const result = await teamCommand(subcommand, teamArgs);
    console.log(result);
    process.exit(0);
  }

  // `yu run <prompt>` — direct scheduler invocation, no Pi hooks
  if (args[0] === 'run') {
    const prompt = args.slice(1).join(' ');
    if (!prompt) {
      console.error('Usage: yu run <prompt>');
      process.exit(1);
    }
    const { handler } = await import('../extension/scheduler.js');
    const result = await handler(prompt, {});
    if (result !== null) {
      console.log(result);
    }
    printCacheStats();
    return;
  }

  // `yu monitor` — live dashboard
  if (args[0] === 'monitor') {
    const { resolve } = await import('node:path');
    const { homedir } = await import('node:os');
    const scriptPath = resolve(homedir(), 'yu-agent', 'scripts', 'monitor.mjs');
    await import(scriptPath);
    return;
  }

  // Subcommand dispatch (review, plan, etc.)
  if (args[0] && COMMANDS.has(args[0])) {
    const command = args.shift()!;
    const rest = args.join(' ');
    const piArgs = ['--print'];
    if (rest) {
      piArgs.push(`/${command} ${rest}`);
    } else {
      piArgs.push(`/${command}`);
    }

    await main(piArgs, {
      extensionFactories: [subagents, yuAgent],
    });
    printCacheStats();
    return;
  }

  // Default: pass through to Pi main() with yu-agent extensions loaded
  await main(args, {
    extensionFactories: [subagents, yuAgent],
  });
  printCacheStats();
}

mainCli().catch((err) => {
  console.error('yu-agent error:', err);
  process.exit(1);
});
