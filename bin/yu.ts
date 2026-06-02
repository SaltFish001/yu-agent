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
 *   yu doctor              → One-click health diagnosis
 *   yu team <subcommand>   → Team mode management
 *   yu install <package>   → Install MCP server
 *   yu update              → Self-update
 *   yu uninstall           → Remove yu-agent
 */

import { main } from '@earendil-works/pi-coding-agent';
import subagents from '@tintinweb/pi-subagents/dist/index.js';
import yuAgent from '../extension/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// For ESM: __dirname equivalent
const __dirname = dirname(fileURLToPath(import.meta.url));
// Project root: dist/bin/ -> dist/ -> project root
const PROJECT_ROOT = resolve(__dirname, '..', '..');

/** Print cache hit-rate summary from SQLite sessions.db if available. */
async function printCacheStats(): Promise<void> {
  try {
    const { getDbPath, getCache } = await import('../extension/db.js');
    const { getSessionTag } = await import('../extension/session-context.js');
    const tag = getSessionTag();
    if (!tag || tag === 'shared') return;
    const cache = getCache(tag);
    if (!cache || cache.turnCount === 0) return;
    const pct = Math.round(cache.hitRate * 100);
    const total = cache.totalHits + cache.totalMisses;
    console.log(`\nCache: ${pct}% hit rate (${cache.totalHits} hits / ${total} total, ${cache.turnCount} turns)`);
  } catch {
    // ignore — no data yet or SQLite unavailable
  }
}

const COMMANDS = new Set([
  'review', 'plan', 'team', 'coding',
  'commit', 'doc', 'search', 'lsp', 'run', 'monitor', 'session', 'memory',
]);

// ── Factory function ───────────────────────────────────

/**
 * Create a yu-agent application with memory lifecycle managed.
 * Returns an object with run() for starting the CLI.
 *
 * This is the factory function for programmatic use.
 * Instead of `new YuApp()`, call `createApp()`.
 */
export async function createApp(options?: {
  /** Skip memory initialization (e.g. for read-only commands). */
  skipMemory?: boolean;
  /** Print startup config summary. */
  printSummary?: boolean;
}): Promise<{ run: () => Promise<void> }> {
  if (!options?.skipMemory) {
    const { getMemoryLifecycle } = await import('../extension/memory-plugin.js');
    getMemoryLifecycle();
  }

  if (options?.printSummary) {
    await printStartupSummary();
  }

  return {
    run: async () => {
      await mainCli();
    },
  };
}

// ── Startup summary ────────────────────────────────────

/**
 * Print a concise startup configuration summary.
 */
async function printStartupSummary(): Promise<void> {
  try {
    const { YU_HOME, MCP_CONFIG_PATH, PROMPTS_DIR } = await import('../extension/paths.js');
    const { readdirSync } = await import('node:fs');
    const osInfo = `${process.platform} ${process.version}`;

    const lines: string[] = [
      `yu-agent v${getVersion()} — ${osInfo}`,
      `  Data dir: ${YU_HOME}`,
    ];

    // Check MCP config
    if (existsSync(MCP_CONFIG_PATH)) {
      try {
        const mcpRaw = readFileSync(MCP_CONFIG_PATH, 'utf-8');
        const mcp = JSON.parse(mcpRaw);
        const serverCount = Object.keys(mcp.servers || {}).length;
        lines.push(`  MCP servers: ${serverCount} configured`);
      } catch {
        lines.push(`  MCP config: unreadable`);
      }
    } else {
      lines.push(`  MCP servers: none configured`);
    }

    // Check prompts
    if (existsSync(PROMPTS_DIR)) {
      const promptFiles = readdirSync(PROMPTS_DIR).filter((f: string) => f.endsWith('.md'));
      lines.push(`  Prompts: ${promptFiles.length} files`);
    }

    console.log(lines.join('\n'));
  } catch {
    // Best-effort
  }
}

// ── Health diagnosis (--doctor) ────────────────────────

/**
 * One-click health diagnosis.
 * Checks all subsystems: memory, config, MCP, session DB.
 */
async function runDoctor(): Promise<void> {
  console.log('═ yu-agent 健康诊断 ════════════════════════');
  console.log(`Version: ${getVersion()}`);
  console.log();

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];

  // ── Paths ──
  const { YU_HOME, MCP_CONFIG_PATH, PROMPTS_DIR } = await import('../extension/paths.js');
  results.push({
    name: '数据目录',
    ok: existsSync(YU_HOME),
    detail: existsSync(YU_HOME) ? YU_HOME : `${YU_HOME} (不存在)`,
  });

  // ── MCP config ──
  const mcpOk = existsSync(MCP_CONFIG_PATH);
  let mcpDetail = MCP_CONFIG_PATH;
  if (mcpOk) {
    try {
      const raw = readFileSync(MCP_CONFIG_PATH, 'utf-8');
      const mcp = JSON.parse(raw);
      const servers = Object.keys(mcp.servers || {});
      mcpDetail = `${MCP_CONFIG_PATH} (${servers.length} servers: ${servers.join(', ') || 'none'})`;
    } catch (e: any) {
      mcpDetail = `${MCP_CONFIG_PATH} (解析失败: ${e.message})`;
    }
  } else {
    mcpDetail = `${MCP_CONFIG_PATH} (文件不存在)`;
  }
  results.push({ name: 'MCP 配置', ok: mcpOk, detail: mcpDetail });

  // ── Prompt files ──
  const promptsOk = existsSync(PROMPTS_DIR);
  let promptCount = 0;
  if (promptsOk) {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.md'));
    promptCount = files.length;
    results.push({
      name: 'Prompt 文件',
      ok: promptCount >= 8,
      detail: `${PROMPTS_DIR} (${promptCount} files, expected >= 8)`,
    });
  } else {
    results.push({
      name: 'Prompt 文件',
      ok: false,
      detail: `${PROMPTS_DIR} (目录不存在)`,
    });
  }

  // ── Memory subsystem ──
  try {
    const { memoryHealth } = await import('../extension/memory/index.js');
    const memHealth = memoryHealth();
    results.push({
      name: 'Ring 缓冲',
      ok: memHealth.components.ring.ok,
      detail: memHealth.components.ring.ok
        ? `${memHealth.components.ring.total} 条目, ${formatBytes(memHealth.components.ring.dbSize)}`
        : memHealth.components.ring.issues.join('; '),
    });
    results.push({
      name: 'Facts 存储',
      ok: memHealth.components.facts.ok,
      detail: memHealth.components.facts.ok
        ? `${memHealth.components.facts.total} 条目, ${formatBytes(memHealth.components.facts.fileSize)}`
        : memHealth.components.facts.issues.join('; '),
    });
    results.push({
      name: 'Scene 状态',
      ok: memHealth.components.scene.ok,
      detail: memHealth.components.scene.ok
        ? formatBytes(memHealth.components.scene.fileSize)
        : memHealth.components.scene.issues.join('; '),
    });
  } catch (e: any) {
    results.push({ name: 'Memory', ok: false, detail: `诊断失败: ${e.message}` });
  }

  // ── Session DB ──
  try {
    const { getDbPath } = await import('../extension/db.js');
    const dbPath = getDbPath();
    const dbExists = existsSync(dbPath);
    let dbDetail = dbPath;
    if (dbExists) {
      const size = readFileSync(dbPath).length;
      dbDetail = `${dbPath} (${formatBytes(size)})`;
    } else {
      dbDetail = `${dbPath} (文件不存在, 首次使用时会自动创建)`;
    }
    results.push({ name: 'Session DB', ok: dbExists || true, detail: dbDetail });
  } catch (e: any) {
    results.push({ name: 'Session DB', ok: false, detail: `诊断失败: ${e.message}` });
  }

  // ── Print results ──
  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    console.log(` ${icon} ${r.name}`);
    console.log(`    ${r.detail}`);
    if (!r.ok) allOk = false;
  }

  console.log();
  console.log(allOk ? '✓ 全部正常' : '✗ 发现问题，请检查上方 ✗ 标记项');
  console.log('═══════════════════════════════════════════');
}

/** Format bytes to human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ── Help text ──────────────────────────────────────────

const HELP_TEXT = `yu-agent — AI-powered programming agent  (v${getVersion()})

Usage:
  yu <prompt>                  One-shot programming task (automatic dispatch)
  yu chat                      Interactive REPL (Pi interactive mode)

Agent Commands:
  yu coding <prompt>           Start a coding task
  yu review <path>             Review code (read-only)
  yu plan <task>               Generate implementation plan
  yu commit <msg>              Generate commit message
  yu doc <task>                Generate documentation
  yu search <query>            Search codebase or web
  yu lsp <path>                LSP type check & fix

Diagnostics:
  yu doctor                    One-click health diagnosis

Scheduler & Monitor:
  yu run <prompt>              Direct scheduler invocation (bypass Pi hooks)
  yu monitor [--once]          Live status dashboard (--once for single snapshot)

Session Management:
  yu session list              List all sessions
  yu session show <tag>        Show session details and message history
  yu session resume <tag>      Resume session context
  yu session fork <tag>        Fork/branch from a session
  yu session todo <tag> ...    Manage session task list
  yu session archive <tag>     Archive a session (soft-delete)
  yu session unarchive <tag>   Unarchive a session
  yu session info              Show session database info
  yu session backup [path]     Backup sessions database
  yu session restore <path>    Restore sessions from backup
  yu session clean [--days N]  Clean sessions older than N days (default 7)

Memory System:
  yu memory stats              Show memory stats (ring + facts + scene)
  yu memory recent [n]         Show recent ring memory entries
  yu memory facts [category]   List facts by category
  yu memory scene              Show current scene state
  yu memory health             Run memory subsystem health check

Code Search (CodeGraph):
  yu search <query>            Semantic code search across the project
  yu graph <symbol>            Show callers/callees for a symbol
  yu context <task>            Build context for a task

Team Mode:
  yu team create <name> ...    Create a team for multi-agent work
  yu team list                 List active teams
  yu team status <runId>       Show team status
  yu team send <runId> <to>    Send message to team member
  yu team task <runId> <act>   Manage shared task board
  yu team shutdown <runId>     Request team shutdown
  yu team delete <runId>       Delete team run
  yu team specs                List saved team specs

Package Management:
  yu install <pkg>             Install MCP server package
  yu update                    Self-update
  yu uninstall                 Remove yu-agent

General:
  yu help [command]            Show this help, or help for a specific command
  yu --help / -h               Same as "yu help"
  yu --version / -v            Show version

Environment:
  YU_SESSION_ID                Session tag (auto-generated, or set manually)
  YU_PROJECT_DIR               Project directory (default: process.cwd())

Data Directory:  ~/.yu/
  ~/.yu/sessions.db            SQLite session database
  ~/.yu/prompts/               Agent type system prompts
  ~/.yu/mcp.config.json        MCP server configuration
  ~/.yu/pool-sessions/         Cached agent sessions (disk persistence)
  ~/.yu/runtime/{runId}/       Team runtime data (mailboxes, state)
  ~/.yu/teams/{name}/          Saved team specs

Agent Types (auto-dispatched by scheduler):
  coding    — 编写和修改代码
  review    — 审查代码，只读不改
  plan      — 出技术方案，只读不改
  search    — 代码库搜索 + 网页搜索
  commit    — git commit 信息生成
  lsp       — LSP 诊断与自动修复
  doc       — 文档生成
  general-purpose — 通用意图识别与任务分发

Team Examples:
  yu team create my-team                           Single-member team
  yu team create squad lead:plan coder:coding reviewer:review
  yu team task <runId> create "Fix login bug"
  yu team send <runId> coder "Check task #abc123"
`;

function getVersion(): string {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function showHelpForCommand(command: string): string {
  switch (command) {
    case 'help':
      return 'yu help [command]  —  Show this help, or help for a specific command.';

    case 'doctor':
      return `yu doctor — One-click health diagnosis

Checks all yu-agent subsystems:
  - Data directory (~/.yu/)
  - MCP configuration file
  - Prompt files
  - Memory subsystem (ring buffer, facts store, scene state)
  - Session database

Reports any issues found. No arguments needed.`;

    case 'session':
      return `yu session — Session management

Usage:
  yu session list               List all sessions
  yu session show <tag>         Show session details and message history
  yu session resume <tag>       Resume session context
  yu session fork <tag>         Fork/branch from a session
  yu session todo <tag> ...     Manage session task list (add/list/done/delete)
  yu session archive <tag>      Archive a session (soft-delete)
  yu session unarchive <tag>    Unarchive a session
  yu session info               Show database path, session count, etc.
  yu session backup [path]      Backup sessions.db (default: ./sessions-backup-<timestamp>.db)
  yu session restore <path>     Restore sessions.db from backup file
  yu session clean [--days N]   Remove sessions older than N days (default 7)

Todo actions:
  yu session todo <tag> list             List all tasks
  yu session todo <tag> add <text>       Add a new task
  yu session todo <tag> done <id>        Mark task as completed
  yu session todo <tag> delete <id>      Delete a task

Data stored in ~/.yu/sessions.db (SQLite).`;

    case 'team':
      return `yu team — Multi-agent team mode

Usage:
  yu team create <name> [member:role ...]   Create a team
  yu team list                              List active teams
  yu team status <teamRunId>                Show team details & member status
  yu team send <teamRunId> <to> <msg>       Send a message to a team member
  yu team task <teamRunId> <action> [...]   Manage shared task board
  yu team shutdown <teamRunId>              Request team shutdown
  yu team delete <teamRunId> [--force]      Delete a team run
  yu team specs                             List saved team specs

Actions for "yu team task":
  create <subject> [description]   Create a new task
  list                              List all tasks
  get <taskId>                      Get task details
  update <taskId> <status>          Update task status
  delete <taskId>                   Delete a task

Team data stored in ~/.yu/runtime/{runId}/`;

    case 'monitor':
      return `yu monitor [--once] — Live status dashboard

Shows real-time status of sub-agents, MCP servers, LSP servers,
and team mode activity.

Options:
  --once    Print a single snapshot and exit (no live refresh)

Reads from ~/.yu/sessions.db (SQLite).`;

    case 'coding':    case 'review':    case 'plan':
    case 'commit':    case 'doc':       case 'search':
    case 'lsp':
      return `yu ${command} <prompt> — Agent command

Dispatches a ${command} sub-agent task.
Examples:
  yu ${command} <your task description>
  yu ${command} <path or query>

The scheduler automatically routes to the ${command} agent type.`;

    case 'run':
      return `yu run <prompt> — Direct scheduler invocation

Bypasses Pi's command routing and calls the yu-agent scheduler directly.
Useful for testing or when Pi's dispatch doesn't match your intent.`;

    case 'install':
      return `yu install <package> — Install an MCP server package

Installs a new MCP server and adds it to ~/.yu/mcp.config.json.`;

    case 'update':
      return 'yu update — Self-update yu-agent to the latest version.';

    case 'uninstall':
      return 'yu uninstall — Remove yu-agent from the system.';

    default:
      return `Unknown command: ${command}\nRun "yu help" to see all available commands.`;
  }
}

async function mainCli(): Promise<void> {
  const args = process.argv.slice(2);

  // Help
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    if (args[1]) {
      console.log(showHelpForCommand(args[1]));
    } else {
      console.log(HELP_TEXT);
    }
    process.exit(0);
  }

  // Version
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`yu-agent v${getVersion()}`);
    process.exit(0);
  }

  // Use yu-specific config directory (separate from pi)
  process.env.PI_CODING_AGENT_DIR = resolve(homedir(), '.yu', 'agent');
  // Suppress Pi's version check — yu-agent manages its own updates
  process.env.PI_SKIP_VERSION_CHECK = '1';

  // `yu doctor` — one-click health diagnosis
  if (args[0] === 'doctor') {
    await runDoctor();
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
    await printCacheStats();
    return;
  }

  // `yu session <subcommand>` — manage session status files
  if (args[0] === 'session') {
    const subcommand = args[1] || 'help';
    const sessionArgs = args.slice(2);
    const { sessionCommand } = await import('../extension/session-cli.js');
    const result = await sessionCommand(subcommand, sessionArgs);
    console.log(result);

    // For `yu session resume <tag>`, continue to Pi session instead of exiting
    if (subcommand === 'resume') {
      // Check if resume was successful by looking for the env var
      if (process.env.YU_RESUME_TAG) {
        // Replace args to start interactive session
        args.length = 0;
        args.push('--chat');
      } else {
        process.exit(0);
      }
    } else {
      process.exit(0);
    }
  }

  // `yu memory <subcommand>` — memory system management
  if (args[0] === 'memory') {
    const subcommand = args[1] || 'stats';
    const memArgs = args.slice(2);
    const { memoryCommand } = await import('../extension/memory-cli.js');
    const result = await memoryCommand(subcommand, memArgs);
    console.log(result);
    process.exit(0);
  }

  // `yu search <query>` — semantic code search via CodeGraph
  if (args[0] === 'search') {
    const query = args.slice(1).join(' ');
    if (!query) {
      console.error('Usage: yu search <query>');
      process.exit(1);
    }
    const { execSync } = await import('node:child_process');
    const cgPath = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'codegraph');
    try {
      const result = execSync(`"${cgPath}" query "${query.replace(/"/g, '\\"')}" --limit 15`, {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 15000,
      });
      console.log(result);
    } catch (e: any) {
      console.error('Search failed:', e.stderr || e.message);
    }
    process.exit(0);
  }

  // `yu graph <symbol>` — show callers/callees
  if (args[0] === 'graph') {
    const symbol = args.slice(1).join(' ');
    if (!symbol) {
      console.error('Usage: yu graph <symbol>');
      process.exit(1);
    }
    const { execSync } = await import('node:child_process');
    const cgPath = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'codegraph');
    try {
      console.log('=== Callers ===');
      const callers = execSync(`"${cgPath}" callers "${symbol.replace(/"/g, '\\"')}" --limit 10`, {
        cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000,
      });
      console.log(callers);
      console.log('=== Callees ===');
      const callees = execSync(`"${cgPath}" callees "${symbol.replace(/"/g, '\\"')}" --limit 10`, {
        cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000,
      });
      console.log(callees);
    } catch (e: any) {
      console.error('Graph query failed:', e.stderr || e.message);
    }
    process.exit(0);
  }

  // `yu context <task>` — build task context
  if (args[0] === 'context') {
    const task = args.slice(1).join(' ');
    if (!task) {
      console.error('Usage: yu context <task description>');
      process.exit(1);
    }
    const { execSync } = await import('node:child_process');
    const cgPath = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'codegraph');
    try {
      const result = execSync(`"${cgPath}" context "${task.replace(/"/g, '\\"')}"`, {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 30000,
      });
      console.log(result);
    } catch (e: any) {
      console.error('Context build failed:', e.stderr || e.message);
    }
    process.exit(0);
  }

  // `yu monitor` — live dashboard
  if (args[0] === 'monitor') {
    const scriptPath = resolve(PROJECT_ROOT, 'scripts', 'monitor.mjs');
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

    // Set session agent info for the CLI command
    const { setSessionAgent } = await import('../extension/session-context.js');
    setSessionAgent(command);

    await main(piArgs, {
      extensionFactories: [subagents, yuAgent],
    });
    await printCacheStats();
    return;
  }

  // Default: pass through to Pi main() with yu-agent extensions loaded
  await main(args, {
    extensionFactories: [subagents, yuAgent],
  });
  await printCacheStats();
}

// ── Entry ──────────────────────────────────────────────
// Direct invocation: run mainCli()
// Programmatic: use createApp().then(app => app.run())
mainCli().catch((err) => {
  console.error('yu-agent error:', err);
  process.exit(1);
});
