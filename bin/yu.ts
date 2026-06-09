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
import { shutdownManager } from '../extension/lifecycle.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// For ESM: __dirname equivalent
const __dirname = dirname(fileURLToPath(import.meta.url));
// Project root: dist/bin/ -> dist/ -> project root
const PROJECT_ROOT = resolve(__dirname, '..', '..');

let _version: string | null = null;

/**
 * 估算 DeepSeek v4 系列 API 费用。
 *
 * Pricing (元/百万 token):
 *   v4-flash:  输入 ¥3,  输出 ¥6,  缓存命中 ¥0.3 (10%)
 *   v4-pro:    输入 ¥12, 输出 ¥24, 缓存命中 ¥1.2 (10%)
 *
 * 当模型信息不可用时默认使用 v4-flash 价格估算。
 */
function estimateCost(
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens: number,
  model: string = 'v4-flash',
): { inputCost: number; outputCost: number; totalCost: number; cacheSavings: number } {
  const isPro = model.includes('pro');
  const inputPrice = isPro ? 12 : 3;
  const outputPrice = isPro ? 24 : 6;
  const cachePrice = isPro ? 1.2 : 0.3;

  const cacheMissInput = Math.max(0, inputTokens - cacheHitTokens);
  const inputCost = (cacheMissInput * inputPrice + cacheHitTokens * cachePrice) / 1_000_000;
  const outputCost = (outputTokens * outputPrice) / 1_000_000;
  const noCacheCost = (inputTokens * inputPrice) / 1_000_000;
  const totalCost = inputCost + outputCost;
  const cacheSavings = noCacheCost - (cacheHitTokens * cachePrice) / 1_000_000;

  return { inputCost, outputCost, totalCost, cacheSavings };
}

/** Print cache hit-rate + cost summary from SQLite if available. */
async function printCacheStats(recentResult?: {
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  model?: string;
}): Promise<void> {
  try {
    const { getCache } = await import('../extension/db.js');
    const tag = process.env.YU_SESSION_ID || 'shared';
    if (!tag || tag === 'shared') return;
    const cache = getCache(tag);
    if (!cache || cache.turnCount === 0) return;
    const pct = Math.round(cache.hitRate * 100);
    const total = cache.totalHits + cache.totalMisses;

    // Use most recent result if available, otherwise aggregate from DB
    const hitTokens = recentResult?.cacheHitTokens ?? cache.totalHits;
    const missTokens = recentResult?.cacheMissTokens ?? cache.totalMisses;
    const outTokens = recentResult?.outputTokens ?? cache.totalOutput;
    const model = recentResult?.model ?? 'v4-flash';

    const cost = estimateCost(missTokens, outTokens, hitTokens, model);

    console.log(`\n── Cost ──────────────────────────────────`);
    console.log(`  Cache hit rate: ${pct}% (${cache.totalHits} hits / ${total} total, ${cache.turnCount} turns)`);
    console.log(`  Input tokens:  ${(missTokens / 1000).toFixed(1)}k (cache hit: ${(hitTokens / 1000).toFixed(1)}k)`);
    console.log(`  Output tokens: ${(outTokens / 1000).toFixed(1)}k`);
    console.log(`  Est. cost:     ¥${cost.totalCost.toFixed(4)} (input ¥${cost.inputCost.toFixed(4)} + output ¥${cost.outputCost.toFixed(4)})`);
    if (cost.cacheSavings > 0) {
      console.log(`  Cache saved:   ¥${cost.cacheSavings.toFixed(4)}`);
    }
    if (recentResult?.durationMs) {
      console.log(`  API duration:  ${(recentResult.durationMs / 1000).toFixed(1)}s`);
    }
    console.log(`──────────────────────────────────────────`);
  } catch {
    // ignore — no data yet or SQLite unavailable
  }
}

const COMMANDS = new Set([
  'review', 'plan', 'team', 'coding',
  'commit', 'doc', 'search', 'lsp', 'run', 'monitor', 'memory',
  'refactor',
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
  /** Print startup config summary. */
  printSummary?: boolean;
}): Promise<{ run: () => Promise<void> }> {
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
async function runDoctor(jsonOutput?: boolean): Promise<void> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];

  if (!jsonOutput) {
    console.log('═ yu-agent 健康诊断 ════════════════════════');
    console.log(`Version: ${getVersion()}`);
    console.log();
  }

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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      mcpDetail = `${MCP_CONFIG_PATH} (解析失败: ${msg})`;
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

  // ── Session DB ──
  let dbIntegrityOk = true;
  let dbIntegrityDetail = '';
  try {
    const { getDbPath, closeDb } = await import('../extension/db.js');
    const dbPath = getDbPath();
    const dbExists = existsSync(dbPath);
    let dbDetail = dbPath;
    if (dbExists) {
      const { DatabaseSync } = await import('node:sqlite');
      const size = readFileSync(dbPath).length;
      dbDetail = `${dbPath} (${formatBytes(size)})`;
      // Run integrity check
      try {
        const checkDb = new DatabaseSync(dbPath);
        const integrityRow = checkDb.prepare('PRAGMA integrity_check').get() as { 'integrity_check': string };
        checkDb.close();
        if (integrityRow && integrityRow['integrity_check'] === 'ok') {
          dbIntegrityOk = true;
          dbIntegrityDetail = 'ok';
        } else {
          dbIntegrityOk = false;
          dbIntegrityDetail = integrityRow?.['integrity_check'] || 'unknown error';
        }
      } catch (e2: unknown) {
        dbIntegrityOk = false;
        dbIntegrityDetail = e2 instanceof Error ? e2.message : String(e2);
      }
    } else {
      dbDetail = `${dbPath} (文件不存在, 首次使用时会自动创建)`;
    }
    results.push({ name: 'Session DB', ok: dbExists || true, detail: dbDetail });
    if (dbExists) {
      results.push({ name: 'DB 完整性', ok: dbIntegrityOk, detail: dbIntegrityDetail });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name: 'Session DB', ok: false, detail: `诊断失败: ${msg}` });
  }

  // ── Token Usage Stats ──
  try {
    const { getTokenUsageAggregate, getTokenUsageBySession } = await import('../extension/db.js');
    const agg = getTokenUsageAggregate();
    if (agg.sessionCount > 0) {
      results.push({
        name: 'Token 用量 (累计)',
        ok: true,
        detail: `${agg.totalTokens.toLocaleString()} tokens (命中: ${agg.totalHits.toLocaleString()}, 未命中: ${agg.totalMisses.toLocaleString()}, 输出: ${agg.totalOutput.toLocaleString()}) | ¥${agg.totalCost.toFixed(4)} | ${agg.sessionCount} 会话`,
      });
      // Today's stats
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const today = getTokenUsageBySession('__today__');
      // Use aggregate for now since we don't have a date filter
    }
    // Current session stats
    const tag = process.env.YU_SESSION_ID || 'shared';
    if (tag && tag !== 'shared') {
      const sessionUsage = getTokenUsageBySession(tag);
      if (sessionUsage.count > 0) {
        results.push({
          name: 'Token 用量 (当前会话)',
          ok: true,
          detail: `${sessionUsage.totalTokens.toLocaleString()} tokens (${sessionUsage.count} 次调用, 耗时 ${(sessionUsage.totalDurationMs / 1000).toFixed(1)}s)`,
        });
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name: 'Token 用量', ok: true, detail: `统计失败: ${msg}` });
  }

  // ── Agent Run Stats ──
  try {
    const { getAgentRunStats } = await import('../extension/db.js');
    const stats = getAgentRunStats();
    const { total, completed, failed, avgDurationMs, ...byType } = stats;
    if (total > 0) {
      const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
      const lines = [`${total} 次运行, ${completed} 成功, ${failed} 失败, ${successRate}% 成功率, 平均 ${(avgDurationMs / 1000).toFixed(1)}s`];
      for (const [type, t] of Object.entries(byType)) {
        const typed = t as { total: number; completed: number; failed: number; avgDurationMs: number };
        const rate = typed.total > 0 ? Math.round((typed.completed / typed.total) * 100) : 0;
        lines.push(`  ${type}: ${typed.total} 次, ${rate}% 成功率, 平均 ${(typed.avgDurationMs / 1000).toFixed(1)}s`);
      }
      results.push({
        name: 'Agent 运行统计',
        ok: failed === 0,
        detail: lines.join('\n'),
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name: 'Agent 运行统计', ok: true, detail: `统计失败: ${msg}` });
  }

  // ── Checkpoints ──
  try {
    const { listPendingCheckpoints } = await import('../extension/checkpoint.js');
    const pending = listPendingCheckpoints();
    if (pending.length > 0) {
      const lines = pending.map(
        (cp) => `    ${cp.step} (${new Date(cp.timestamp).toLocaleString()}, files: ${cp.files.length})`,
      );
      results.push({
        name: '未完成的 Checkpoint',
        ok: false,
        detail: `${pending.length} 个未完成:\n${lines.join('\n')}\n    运行 yu agent-recover 查看详情`,
      });
    } else {
      results.push({ name: 'Checkpoints', ok: true, detail: '无未完成项' });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name: 'Checkpoints', ok: true, detail: `检查失败: ${msg}` });
  }

  // ── Print results ──
  let allOk = true;
  for (const r of results) {
    if (!r.ok) allOk = false;
  }

  if (jsonOutput) {
    const output = {
      version: getVersion(),
      timestamp: new Date().toISOString(),
      healthy: allOk,
      checks: results.map(r => ({
        name: r.name,
        ok: r.ok,
        detail: r.detail,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    console.log(` ${icon} ${r.name}`);
    console.log(`    ${r.detail}`);
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
  const val = bytes / 1024 ** i;
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

Refactoring:
  yu refactor rename <from> <to> [files...]  Rename a symbol (AST-safe)
  yu refactor extract <type> <file>          Extract inline type to interface

Diagnostics:
  yu doctor                    One-click health diagnosis

Scheduler & Monitor:
  yu run <prompt>              Spawn coding agent directly
  yu monitor [--once]          Live status dashboard (--once for single snapshot)

Knowledge Base (RAG):
  yu knowledge search <query>  Full-text search across project files (FTS5)
  yu knowledge index [dir]     Index/reindex project files
  yu knowledge status          Show knowledge base stats

Terminal Integration:
  yu terminal list             List current user's terminal processes
  yu terminal attach <pid>     Read process stdout buffer (one-shot)
  yu terminal watch <pid>      Live-tail process stdout (Linux only)

Sandbox Execution:
  yu sandbox <command>         Run command in isolated Docker container
  yu sandbox status            Check sandbox availability

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

Git Integration:
  yu git pr create [branch]    Create PR from current branch (needs gh CLI)
  yu git pr list               List open PRs
  yu git branch <name>         Create and switch to branch
  yu git merge <branch>        Merge branch with conflict detection

Package Management:
  yu install <pkg>             Install MCP server package
  yu update                    Self-update
  yu uninstall                 Remove yu-agent

Topic Management:
  yu topic list                List all topics
  yu topic switch <name>       Switch to a topic
  yu topic new <name> <dir>    Create a new topic
  yu topic rename <old> <new>  Rename a topic
  yu topic archive <name>      Archive a topic (soft-delete)
  yu topic bg <name> <prompt>  Start a background task on a topic
  yu topic status              Show background task progress

General:
  yu help [command]            Show this help, or help for a specific command
  yu --help / -h               Same as "yu help"
  yu --version / -v            Show version

Environment:
  YU_SESSION_ID                Session tag (auto-generated, or set manually)
  YU_PROJECT_DIR               Project directory (default: process.cwd())

Data Directory:  ~/.yu/
  ~/.yu/prompts/               Agent type system prompts
  ~/.yu/mcp.config.json        MCP server configuration
  ~/.yu/runtime/{runId}/       Team runtime data (mailboxes, state)
  ~/.yu/teams/{name}/          Saved team specs
  ~/.yu/topics.db              SQLite topic database

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
  if (!_version) {
    try {
      _version = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version || '0.1.0';
    } catch {
      _version = '0.1.0';
    }
  }
  return _version as string;
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
  - Memory subsystem (ring buffer)
  - Session database (integrity check)
  - Token usage statistics
  - Agent run statistics

Options:
  --json    Output results as structured JSON

Reports any issues found. No arguments needed.`;

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

Reads from SQLite databases in ~/.yu/.`;

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

    case 'topic':
      return `yu topic — Topic management

Manages named topics (contexts) with their own working directory,
summary, status tracking, and turn counting.

Usage:
  yu topic list                    List all topics
  yu topic list --all              List all topics including archived
  yu topic switch <name>           Switch to a topic (changes cwd)
  yu topic new <name> <dir>        Create a new topic at <dir>
  yu topic rename <old> <new>      Rename a topic
  yu topic archive <name>          Archive a topic (soft-delete)
  yu topic bg <name> <prompt>      Start a background task on a topic
  yu topic status                  Show background task progress

Background limits:
  Config key: topic.maxBackground in ~/.yu/config.json
  Default: 3 concurrent background tasks

Data stored in ~/.yu/topics.db (SQLite).`;

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

  // ═ 启动时检测未完成的 checkpoint ═
  try {
    const { listPendingCheckpoints } = await import('../extension/checkpoint.js');
    const pending = listPendingCheckpoints();
    if (pending.length > 0) {
      console.warn('');
      console.warn('═ 检测到未完成的 Checkpoint ═══════════════════');
      for (const cp of pending) {
        console.warn(`  • ${cp.step} — ${new Date(cp.timestamp).toLocaleString()}`);
        if (cp.files.length > 0) {
          console.warn(`    文件: ${cp.files.join(', ')}`);
        }
      }
      console.warn('');
      console.warn('  运行 yu doctor 查看完整诊断');
      console.warn('═══════════════════════════════════════════════');
      console.warn('');
    }
  } catch {
    // Best-effort
  }

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
    const useJson = args.includes('--json');
    await runDoctor(useJson);
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

  // `yu knowledge <subcommand>` — RAG knowledge base
  if (args[0] === 'knowledge') {
    const sub = args[1] || 'help';
    const { knowledgeCommand } = await import('../extension/knowledge/index.js');
    try {
      const out = knowledgeCommand(sub, args.slice(2));
      console.log(out);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`knowledge 操作失败: ${msg}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // `yu terminal <subcommand>` — terminal attach/watch
  if (args[0] === 'terminal') {
    const { terminalCommand, watchProcessOutput, isLinux } = await import('../extension/terminal/index.js');
    const sub = args[1] || 'help';

    try {
      if (sub === 'watch') {
        if (!isLinux()) {
          console.error('terminal 功能仅支持 Linux 平台。');
          process.exit(1);
        }
        const pidStr = args[2];
        if (!pidStr || !/^\d+$/.test(pidStr)) {
          console.error('Usage: yu terminal watch <pid>');
          process.exit(1);
        }
        const pid = parseInt(pidStr, 10);

        // 检查是否为交互式终端
        if (!process.stdin.isTTY) {
          console.log('非交互式环境，watch 模式不可用。使用 yu terminal attach <pid> 一次性读取。');
          process.exit(1);
        }

        console.log(`正在观察进程 ${pid} 的输出...（按 Ctrl+C 停止）`);
        const handle = watchProcessOutput(pid, (output) => {
          process.stdout.write(output.text);
        });

        // Wait for Ctrl+C
        process.on('SIGINT', () => {
          handle.disconnect();
          console.log('\n[yu-terminal] 已断开');
          process.exit(0);
        });

        // Keep alive
        await new Promise(() => {});
      } else {
        const out = terminalCommand(args.slice(1));
        console.log(out);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`terminal 操作失败: ${msg}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // `yu sandbox <command...>` — isolated execution
  if (args[0] === 'sandbox') {
    const { sandboxCommand } = await import('../extension/sandbox/index.js');
    try {
      const out = sandboxCommand(args.slice(1));
      console.log(out);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`sandbox 操作失败: ${msg}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // `yu git <subcommand>` — Git integration via gh CLI
  if (args[0] === 'git') {
    const sub = args[1] || 'help';
    const { prCreate, prList, createBranch, mergeBranch } = await import('../extension/git-commands.js');
    try {
      switch (sub) {
        case 'pr': {
          const prSub = args[2];
          if (prSub === 'create') {
            const out = prCreate(args[3] || 'main');
            console.log(out);
          } else if (prSub === 'list') {
            const out = prList();
            console.log(out);
          } else {
            console.error('Usage: yu git pr create [target-branch]');
            console.error('       yu git pr list');
            process.exit(1);
          }
          break;
        }
        case 'branch': {
          const branchName = args[2];
          if (!branchName) {
            console.error('Usage: yu git branch <name>');
            process.exit(1);
          }
          const out = createBranch(branchName);
          console.log(out);
          break;
        }
        case 'merge': {
          const mergeBranchName = args[2];
          if (!mergeBranchName) {
            console.error('Usage: yu git merge <branch>');
            process.exit(1);
          }
          const out = mergeBranch(mergeBranchName);
          console.log(out);
          break;
        }
        default:
          console.error('Usage: yu git pr create [target-branch]');
          console.error('       yu git pr list');
          console.error('       yu git branch <name>');
          console.error('       yu git merge <branch>');
          process.exit(1);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`git 操作失败: ${msg}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // `yu run <prompt>` — scheduler dispatch (Plan B).
  // Classifies intent → pass_through to chat agent, or dispatch to
  // coding/search/review/etc. Replaces the old hardcoded coding-agent spawn.
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
    return;
  }

  // `yu topic <subcommand>` — topic management
  // For `bg` subcommand, cmdBg() atomically sets status='background',
  // ensures the supervisor daemon is running (spawns if needed),
  // and returns a confirmation message. The CLI exits immediately
  // while the daemon picks up the task asynchronously.
  if (args[0] === 'topic') {
    const sub = args[1] || 'help';
    const topicArgs = args.slice(2);
    const { topicCommand } = await import('../extension/topic.js');
    const out = topicCommand(sub, topicArgs);
    console.log(out);
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
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('Search failed:', errMsg);
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
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('Graph query failed:', errMsg);
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
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('Context build failed:', errMsg);
    }
    process.exit(0);
  }

  // `yu refactor <action>` — AST-aware refactoring
  if (args[0] === 'refactor') {
    const action = args[1] || 'help';
    const refactorArgs = args.slice(2);
    const { refactorCommand } = await import('../extension/refactor/index.js');
    const result = await refactorCommand(action, refactorArgs);
    console.log(result);
    process.exit(0);
  }

  // `yu monitor` — live dashboard
  if (args[0] === 'monitor') {
    const scriptPath = resolve(PROJECT_ROOT, 'scripts', 'monitor.mjs');
    await import(scriptPath);
    return;
  }

  // Subcommand dispatch (Pi-managed commands)
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
    await printCacheStats();
    return;
  }

  // Default: check if non-coding → use chat agent directly
  const query = args.join(' ');
  if (query) {
    try {
      const { classifyIntent } = await import('../extension/classifier.js');
      const plan = await classifyIntent(query, {});
      // Route to chat agent if: pass_through explicitly, OR no intent/agents,
      // OR intent is none of the known work intents (non-coding general chat)
      const isPassThrough = plan.pass_through === true;
      const isGeneralQuery = !plan.intent || !['coding', 'review', 'commit', 'lsp', 'doc', 'refactor', 'team', 'search'].includes(plan.intent);
      if (isPassThrough || isGeneralQuery) {
        // Non-coding task: use chat.md prompt directly via DeepSeek API
        const { chatCompletion } = await import('../extension/deepseek.js');
        const { readFileSync, existsSync } = await import('node:fs');
        const { resolve: resolvePath } = await import('node:path');
        const promptsDir = resolvePath(PROJECT_ROOT, 'prompts');
        const chatPromptPath = resolvePath(promptsDir, 'chat.md');
        let systemPrompt = '';
        if (existsSync(chatPromptPath)) {
          systemPrompt = readFileSync(chatPromptPath, 'utf-8');
        }
        const result = await chatCompletion({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt || 'You are a concise, direct assistant.' },
            { role: 'user', content: query },
          ],
          max_tokens: 2048,
          temperature: 0.7,
        });
        if (result?.choices?.[0]?.message?.content) {
          console.log(result.choices[0].message.content);
          await printCacheStats();
          return;
        }
      }
    } catch {
      // Scheduler classification failed — fall through to Pi
    }
  }

  // Fall through to Pi main() with yu-agent extensions loaded
  // Auto-continue: resume the most recent session unless user explicitly opted out
  if (!args.includes('--continue') && !args.includes('--resume') && !args.includes('--no-session') && !args.includes('--new')) {
    args.unshift('--continue');
  }
  await main(args, {
    extensionFactories: [subagents, yuAgent],
  });
  await printCacheStats();
}

// ── Graceful shutdown handlers ──────────────────────────
process.on('SIGTERM', () => shutdownManager.shutdown('SIGTERM').then(() => process.exit(143)));
process.on('SIGINT', () => shutdownManager.shutdown('SIGINT').then(() => process.exit(130)));

shutdownManager.registerHandler("close-db", async () => {
  const { closeDb } = await import("../extension/db.js");
  const { flushLogs } = await import("../extension/logger.js");
  await flushLogs?.();
  closeDb?.();
});
shutdownManager.registerHandler("stop-mcp", async () => {
  const { stopMCPManager } = await import("../extension/mcp-manager.js");
  await stopMCPManager?.();
});

// ── Entry ──────────────────────────────────────────────
// Direct invocation: run mainCli()
// Programmatic: use createApp().then(app => app.run())
mainCli().catch((err) => {
  console.error('yu-agent error:', err);
  process.exit(1);
});
