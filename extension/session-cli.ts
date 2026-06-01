/**
 * yu-agent — 命令行 session 管理。
 *
 * Usage:
 *   yu session list         列出当前目录下的所有 session
 *   yu session clean [--days N]  清理 N 天前的 session 文件（默认 7）
 *   yu session show <tag>   查看指定 session 的状态
 */

import { getStatusDir } from './session-context.js';
import {
  listSessions, getSessionMeta, getAgents, getSummary, getCache,
  deleteOldSessions, archiveSession, unarchiveSession,
  getDbPath, getStatusDirPath, sessionCount,
  getMessages, getTodos, insertTodo, updateTodoStatus, updateTodoPriority, deleteTodo,
  forkSession, generateSlug, ensureSlug,
  updateSessionSummary, updateSessionSummaryStats,
} from './db.js';
import { existsSync, statSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { YU_HOME } from './paths.js';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtAgo(ts: number): string {
  const ago = Math.floor((Date.now() - ts) / 1000);
  if (ago < 60) return `${ago}s`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h`;
  return `${Math.floor(ago / 86400)}d`;
}

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

export async function sessionCommand(subcommand: string, args: string[]): Promise<string> {
  switch (subcommand) {
    case 'list':
      return cmdList();
    case 'clean':
      return cmdClean(args);
    case 'show':
      return cmdShow(args);
    case 'info':
      return cmdInfo();
    case 'backup':
      return cmdBackup(args);
    case 'restore':
      return cmdRestore(args);
    case 'archive':
      return cmdArchive(args);
    case 'unarchive':
      return cmdUnarchive(args);
    case 'resume':
      return cmdResume(args);
    case 'todo':
      return cmdTodo(args);
    case 'fork':
      return cmdFork(args);
    default:
      return `Usage:
  yu session list                   列出当前目录下的所有 session
  yu session show <tag>             查看指定 session 的详情和消息历史
  yu session resume <tag>           从指定 session 恢复上下文
  yu session archive <tag>          归档 session（软删除）
  yu session unarchive <tag>        取消归档 session
  yu session fork <tag>             从历史 session 创建新 session（分支）
  yu session todo <tag> [action]    管理 session 的任务列表（add/list/done/delete）
  yu session info                   显示数据库路径、会话数等信息
  yu session backup [path]          备份 sessions.db 到指定路径（默认带时间戳）
  yu session restore <path>         从备份文件恢复 sessions.db
  yu session clean [--days N]       清理 N 天前的 session（默认 7 天）

Todo actions:
  yu session todo <tag> list        列出所有任务
  yu session todo <tag> add <text>  添加新任务
  yu session todo <tag> done <id>   标记任务完成
  yu session todo <tag> delete <id> 删除任务`;
  }
}

function cmdList(): string {
  const sessions = listSessions();
  if (sessions.length === 0) return 'No sessions found.';

  const lines: string[] = [];

  // Table header
  lines.push('Session                                 Slug                            Agent           Age  ');
  lines.push('────────────────────────────────────── ──────────────────────────────── ─────────────── ─────');

  for (const s of sessions) {
    const name = trunc(s.name || s.tag.slice(0, 14), 38);
    const slug = trunc(s.slug || '-', 32);
    const agent = trunc(s.agent || '-', 14);

    lines.push(
      `${name.padEnd(38)} ${slug.padEnd(32)} ${agent.padEnd(14)} ${fmtAgo(s.updatedAt).padEnd(5)}`
    );
  }

  lines.push('');
  lines.push(`Total: ${sessions.length} session(s) at ${getStatusDir()}`);
  return lines.join('\n');
}

function cmdClean(args: string[]): string {
  let days = 7;
  const daysIdx = args.indexOf('--days');
  if (daysIdx !== -1 && daysIdx + 1 < args.length) {
    days = parseInt(args[daysIdx + 1], 10);
    if (isNaN(days) || days < 0) return 'Invalid --days value. Use a positive number.';
  }

  const cutoff = Date.now() - days * 86400 * 1000;
  const count = deleteOldSessions(cutoff);
  if (count === 0) return 'No sessions to clean.';
  return `Cleaned ${count} session(s) older than ${days} days.`;
}

function cmdInfo(): string {
  const dbPath = getDbPath();
  const statusDir = getStatusDirPath();
  const count = sessionCount();

  let fileSize = 'unknown';
  try {
    if (existsSync(dbPath)) {
      const st = statSync(dbPath);
      fileSize = fmtSize(st.size);
    }
  } catch { /* ignore */ }

  return [
    'Session Database Info:',
    `  Status dir:  ${statusDir}`,
    `  DB path:     ${dbPath}`,
    `  DB size:     ${fileSize}`,
    `  Sessions:    ${count}`,
    '',
    `  getStatusDir() resolution:`,
    `    cwd:             ${process.cwd()}`,
    `    has .yu-agent/:  ${existsSync(resolve(process.cwd(), '.yu-agent', 'status')) ? 'yes' : 'no'}`,
  ].join('\n');
}

function cmdBackup(args: string[]): string {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    return `No database found at ${dbPath}. Nothing to backup.`;
  }

  const destPath = args[0] || resolve(process.cwd(), `sessions-backup-${Date.now()}.db`);
  const resolved = resolve(destPath);

  try {
    copyFileSync(dbPath, resolved);
    return `Backup created: ${resolved} (${fmtSize(statSync(resolved).size)})`;
  } catch (e: any) {
    return `Backup failed: ${e.message}`;
  }
}

async function cmdRestore(args: string[]): Promise<string> {
  if (args.length === 0) return 'Usage: yu session restore <path>';
  const backupPath = resolve(args[0]);

  if (!existsSync(backupPath)) {
    return `Backup file not found: ${backupPath}`;
  }

  const dbPath = getDbPath();
  // Verify the backup file is a valid SQLite DB
  try {
    const mod = await import('node:sqlite');
    const DatabaseSync = mod.DatabaseSync as unknown as new (path: string) => {
      prepare(sql: string): { get(...args: unknown[]): unknown };
      close(): void;
    };
    const testDb = new DatabaseSync(backupPath);
    testDb.prepare('SELECT COUNT(*) FROM sessions').get();
    testDb.close();
  } catch {
    return `Invalid backup file: not a valid sessions.db.`;
  }

  // Create a pre-restore backup just in case
  const preBackup = `${dbPath}.pre-restore`;
  if (existsSync(dbPath)) {
    try {
      copyFileSync(dbPath, preBackup);
    } catch { /* best-effort */ }
  }

  try {
    copyFileSync(backupPath, dbPath);
    const lines = [`Restored from ${backupPath}`];
    if (existsSync(preBackup)) {
      lines.push(`Pre-restore backup saved to ${preBackup}`);
    }
    return lines.join('\n');
  } catch (e: any) {
    return `Restore failed: ${e.message}`;
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function cmdArchive(args: string[]): string {
  if (args.length === 0) return 'Usage: yu session archive <tag>';
  const tag = args[0];
  const meta = getSessionMeta(tag);
  if (!meta) return `Session "${tag}" not found.`;
  if (meta.archivedAt > 0) return `Session "${tag}" is already archived.`;
  archiveSession(tag);
  return `Session "${tag}" archived.`;
}

function cmdUnarchive(args: string[]): string {
  if (args.length === 0) return 'Usage: yu session unarchive <tag>';
  const tag = args[0];
  const meta = getSessionMeta(tag);
  if (!meta) return `Session "${tag}" not found.`;
  if (meta.archivedAt === 0) return `Session "${tag}" is not archived.`;
  unarchiveSession(tag);
  return `Session "${tag}" unarchived.`;
}

/**
 * Resume a session: read Pi session file history and prepare resume context.
 * Sets YU_RESUME_TAG env var and writes resume_context.json for before_agent_start to pick up.
 * The caller (bin/yu.ts) should continue to launch Pi after this succeeds.
 */
function cmdResume(args: string[]): string {
  if (args.length === 0) return 'Usage: yu session resume <tag>';
  const tag = args[0];

  // 1. Look up session metadata
  const meta = getSessionMeta(tag);
  if (!meta) return `Session "${tag}" not found.`;

  // 2. Extract piSessionPath from metadata
  let piSessionPath: string | undefined;
  try {
    const md = JSON.parse(meta.metadata || '{}');
    piSessionPath = md.piSessionPath;
  } catch {
    return `Session "${tag}" has unparseable metadata.`;
  }
  if (!piSessionPath) {
    return `Session "${tag}" has no Pi session file path stored in metadata.`;
  }

  // 3. Read and parse the Pi session JSONL file
  if (!existsSync(piSessionPath)) {
    return `Pi session file not found: ${piSessionPath}`;
  }

  const raw = readFileSync(piSessionPath, 'utf-8');
  const messages: { role: string; content: string }[] = [];

  // JSONL: each line is a JSON event, filter type === 'message'
  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'message' && event.message) {
        const role = event.message.role;
        // Extract text content from content array
        const contentParts: string[] = [];
        if (Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              contentParts.push(block.text);
            }
          }
        } else if (typeof event.message.content === 'string') {
          contentParts.push(event.message.content);
        }
        const text = contentParts.join('\n');
        if (text.trim()) {
          messages.push({ role, content: text });
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  if (messages.length === 0) {
    return 'No message history found in Pi session file.';
  }

  // 4. Take last N messages (recent history, max 30)
  const MAX_RESUME_MSGS = 30;
  const recent = messages.slice(-MAX_RESUME_MSGS);

  // 5. Write resume context to ~/.yu/resume_context.json
  if (!existsSync(YU_HOME)) {
    mkdirSync(YU_HOME, { recursive: true });
  }
  const resumeFile = resolve(YU_HOME, 'resume_context.json');
  writeFileSync(resumeFile, JSON.stringify({ tag, messages: recent }, null, 2));

  // 6. Set env var so before_agent_start can detect
  process.env.YU_RESUME_TAG = tag;

  return `✅ Resume context ready. Restoring ${recent.length} messages from session "${tag}". Starting new session...`;
}

function cmdShow(args: string[]): string {
  if (args.length === 0) return 'Usage: yu session show <tag>';

  const tag = args[0];
  const meta = getSessionMeta(tag);
  if (!meta) return `Session "${tag}" not found.`;

  const lines: string[] = [
    `Session: ${meta.name || tag}`,
    `  tag: ${tag}`,
    `  slug: ${meta.slug || '(not set)'}`,
    `  cwd: ${meta.cwd}`,
    `  agent: ${meta.agent || '(not set)'}`,
  ];

  // Show model (prettify JSON if present)
  if (meta.model && meta.model !== '{}') {
    try {
      const modelObj = JSON.parse(meta.model);
      lines.push(`  model: ${JSON.stringify(modelObj)}`);
    } catch {
      lines.push(`  model: ${meta.model}`);
    }
  }

  // Show parent if set
  if (meta.parentId) {
    lines.push(`  parent: ${meta.parentId}`);
  }

  // Show archival status
  if (meta.archivedAt > 0) {
    lines.push(`  archived: ${new Date(meta.archivedAt).toLocaleString()}`);
  }

  // Show metadata
  if (meta.metadata && meta.metadata !== '{}') {
    try {
      const md = JSON.parse(meta.metadata);
      const mdStr = JSON.stringify(md).slice(0, 200);
      lines.push(`  metadata: ${mdStr}`);
    } catch {
      // skip unparseable metadata
    }
  }

  lines.push(`  created: ${new Date(meta.createdAt).toLocaleString()}`);
  lines.push(`  updated: ${new Date(meta.updatedAt).toLocaleString()}`);

  // Show summary stats (P4)
  if (meta.summaryFiles || meta.summaryAdditions || meta.summaryDeletions) {
    lines.push(`  changes: ${meta.summaryFiles} files, +${meta.summaryAdditions} / -${meta.summaryDeletions} lines`);
  }
  lines.push('');

  // Show agents
  const agentsJson = getAgents(tag);
  if (agentsJson) {
    try {
      const parsed = JSON.parse(agentsJson);
      lines.push(`  agents (${parsed.agents?.length ?? 0}): ${JSON.stringify(parsed).slice(0, 200)}`);
    } catch (e) {
      lines.push(`  agents: (parse error: ${e})`);
    }
  }

  // Show summary
  const summary = getSummary(tag);
  if (summary) {
    lines.push(`  summary: ${summary.running} running, ${summary.completed} done, ${summary.failed} failed`);
  }

  // Show cache
  const cache = getCache(tag);
  if (cache && cache.turnCount > 0) {
    const pct = Math.round(cache.hitRate * 100);
    lines.push(`  cache: ${pct}% hit rate (${cache.totalHits} hits / ${cache.totalMisses} misses, ${cache.turnCount} turns)`);
  }

  // Show messages (P0)
  lines.push('');
  const messages = getMessages(tag);
  if (messages.length > 0) {
    lines.push(`  Messages (${messages.length}):`);
    for (const msg of messages) {
      const time = new Date(msg.timeCreated).toLocaleTimeString();
      const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : msg.role;
      const content = msg.content.slice(0, 200).replace(/\n/g, '\\n');
      lines.push(`    [${time}] ${role}: ${content}${msg.content.length > 200 ? '…' : ''}`);
    }
  } else {
    lines.push('  Messages: (none)');
  }

  // Show todos (P1)
  const todos = getTodos(tag);
  if (todos.length > 0) {
    lines.push('');
    lines.push(`  Todos (${todos.length}):`);
    for (const todo of todos) {
      const status = todo.status === 'pending' ? '○' : '✓';
      const prio = todo.priority === 'high' ? '❗' : todo.priority === 'low' ? '↓' : '·';
      lines.push(`    #${todo.id} ${status} ${prio} ${todo.content}`);
    }
  }

  return lines.join('\n');
}

/**
 * `yu session todo <tag>` — manage todos.
 * Actions: list (default), add <text>, done <id>, delete <id>
 */
function cmdTodo(args: string[]): string {
  if (args.length === 0) {
    return 'Usage: yu session todo <tag> [action] [args...]\n\nActions:\n  list                 列出所有任务\n  add <text>           添加新任务\n  done <id>            标记任务完成\n  delete <id>          删除任务\n  priority <id> <low|medium|high>  设置优先级';
  }

  const tag = args[0];
  const meta = getSessionMeta(tag);
  if (!meta) return `Session "${tag}" not found.`;

  const action = args[1] || 'list';

  switch (action) {
    case 'list': {
      const todos = getTodos(tag);
      if (todos.length === 0) return `No todos for session "${tag}".`;
      const lines: string[] = [`Todos for session "${tag}" (${meta.name || tag}):`];
      for (const todo of todos) {
        const status = todo.status === 'pending' ? '○' : '✓';
        const prio = todo.priority === 'high' ? '❗' : todo.priority === 'low' ? '↓' : '·';
        const ago = fmtAgo(todo.timeUpdated);
        lines.push(`  #${todo.id} ${status} ${prio} ${todo.content} (${ago})`);
      }
      return lines.join('\n');
    }

    case 'add': {
      const content = args.slice(2).join(' ').trim();
      if (!content) return 'Usage: yu session todo <tag> add <text>';
      const id = insertTodo(tag, content);
      return `Todo #${id} added to session "${tag}".`;
    }

    case 'done': {
      const idStr = args[2];
      if (!idStr) return 'Usage: yu session todo <tag> done <id>';
      const id = parseInt(idStr, 10);
      if (isNaN(id)) return `Invalid id: ${idStr}`;
      updateTodoStatus(id, 'completed');
      return `Todo #${id} marked as completed.`;
    }

    case 'delete': {
      const idStr = args[2];
      if (!idStr) return 'Usage: yu session todo <tag> delete <id>';
      const id = parseInt(idStr, 10);
      if (isNaN(id)) return `Invalid id: ${idStr}`;
      deleteTodo(id);
      return `Todo #${id} deleted.`;
    }

    case 'priority': {
      const idStr = args[2];
      const priority = args[3];
      if (!idStr || !priority) return 'Usage: yu session todo <tag> priority <id> <low|medium|high>';
      const id = parseInt(idStr, 10);
      if (isNaN(id)) return `Invalid id: ${idStr}`;
      if (!['low', 'medium', 'high'].includes(priority)) return 'Priority must be low, medium, or high.';
      updateTodoPriority(id, priority);
      return `Todo #${id} priority set to ${priority}.`;
    }

    default:
      return `Unknown action: ${action}. Use: list, add, done, delete, priority`;
  }
}

/**
 * `yu session fork <tag>` — create a new session branching from an existing one.
 * Copies messages and todos to the new session.
 * Usage: yu session fork <tag> [new-name]
 */
function cmdFork(args: string[]): string {
  if (args.length === 0) return 'Usage: yu session fork <tag> [new-name]';

  const sourceTag = args[0];
  const newName = args.slice(1).join(' ') || undefined;

  // Generate a new unique tag
  const newTag = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const result = forkSession(sourceTag, newTag, newName);
  if (!result) return `Session "${sourceTag}" not found.`;

  return [
    `✅ Forked session "${sourceTag}" -> "${newTag}"`,
    `  name: ${result.name}`,
    `  slug: ${result.slug}`,
    `  parent: ${sourceTag}`,
  ].join('\n');
}
