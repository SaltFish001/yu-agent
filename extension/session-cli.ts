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
  deleteOldSessions, getDbPath, getStatusDirPath, sessionCount,
} from './db.js';
import { existsSync, statSync, copyFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

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
    default:
      return `Usage:
  yu session list              列出当前目录下的所有 session
  yu session show <tag>        查看指定 session 的状态
  yu session info              显示数据库路径、会话数等信息
  yu session backup [path]     备份 sessions.db 到指定路径（默认带时间戳）
  yu session restore <path>    从备份文件恢复 sessions.db
  yu session clean [--days N]  清理 N 天前的 session（默认 7 天）`;
  }
}

function getAgentCount(tag: string): number {
  try {
    const data = getAgents(tag);
    if (!data) return 0;
    const parsed = JSON.parse(data);
    return parsed.agents?.length ?? 0;
  } catch {
    return 0;
  }
}

function cmdList(): string {
  const sessions = listSessions();
  if (sessions.length === 0) return 'No sessions found.';

  const lines: string[] = [];

  // Table header
  lines.push('Session                                 Agents  Created         Updated         Age  ');
  lines.push('────────────────────────────────────── ─────── ─────────────── ─────────────── ─────');

  for (const s of sessions) {
    const name = trunc(s.name || s.tag.slice(0, 14), 38);
    const agentCount = getAgentCount(s.tag);

    lines.push(
      `${name.padEnd(38)} ${String(agentCount).padStart(5)}   ${fmtTime(s.createdAt).padEnd(15)} ${fmtTime(s.updatedAt).padEnd(15)} ${fmtAgo(s.updatedAt).padEnd(5)}`
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

function cmdShow(args: string[]): string {
  if (args.length === 0) return 'Usage: yu session show <tag>';

  const tag = args[0];
  const meta = getSessionMeta(tag);
  if (!meta) return `Session "${tag}" not found.`;

  const lines: string[] = [
    `Session: ${meta.name || tag}`,
    `  tag: ${tag}`,
    `  cwd: ${meta.cwd}`,
    `  created: ${new Date(meta.createdAt).toLocaleString()}`,
    `  updated: ${new Date(meta.updatedAt).toLocaleString()}`,
    '',
  ];

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

  return lines.join('\n');
}
