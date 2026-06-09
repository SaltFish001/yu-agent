/**
 * yu-agent — Topic management system.
 *
 * SQLite-backed topic registry with CLI commands.
 * Each topic represents a named context with its own working directory,
 * summary, status tracking, and turn counting.
 *
 * DB path: ~/.yu/topics.db
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { handler as schedulerHandler } from './scheduler.js';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ExtendedTopicStatus } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

// ── Types ─────────────────────────────────────────────────

export interface Topic {
  id: string;
  name: string;
  dir: string;
  summary: string;
  status: ExtendedTopicStatus;
  turns: number;
  lastActive: string | null;
  createdAt: string;
  archived: number; // 0 or 1
  pid?: number;         // child process PID (if running as background)
  cmd?: string;         // command string (the prompt)
  startedAt?: string;   // ISO timestamp of when the task started
}

// ── DB path ────────────────────────────────────────────────

const DB_PATH = resolve(homedir(), '.yu', 'topics.db');

let _db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (_db) return _db;

  const dir = resolve(homedir(), '.yu');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode=WAL');
  _db.exec('PRAGMA busy_timeout=3000');
  initDb(_db);
  return _db;
}

// ── Schema ─────────────────────────────────────────────────

export function initDb(db?: DatabaseSync): void {
  const d = db ?? getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id          TEXT PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      dir         TEXT NOT NULL,
      summary     TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'idle',
      turns       INTEGER NOT NULL DEFAULT 0,
      last_active TEXT,
      created_at  TEXT NOT NULL,
      archived    INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Phase 0: Add supervisor-related columns if they don't exist yet.
  // Use ALTER TABLE ADD COLUMN which is safe — fails silently if column exists.
  const newColumns = [
    ['pid', 'INTEGER'],
    ['cmd', 'TEXT DEFAULT ""'],
    ['started_at', 'TEXT'],
  ] as const;

  for (const [col, def] of newColumns) {
    try {
      d.exec(`ALTER TABLE topics ADD COLUMN ${col} ${def}`);
    } catch {
      // Column already exists — ignore
    }
  }
}

// ── Internal helpers ──────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function findByName(name: string): Topic | undefined {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM topics WHERE LOWER(name) = LOWER(?)'
  ).get(name) as Record<string, unknown> | undefined;

  if (!row) return undefined;
  return rowToTopic(row);
}

function rowToTopic(row: Record<string, unknown>): Topic {
  return {
    id: row.id as string,
    name: row.name as string,
    dir: row.dir as string,
    summary: (row.summary as string) ?? '',
    status: (row.status as ExtendedTopicStatus) ?? 'idle',
    turns: (row.turns as number) ?? 0,
    lastActive: (row.last_active as string) ?? null,
    createdAt: row.created_at as string,
    archived: (row.archived as number) ?? 0,
    pid: (row.pid as number) ?? undefined,
    cmd: (row.cmd as string) ?? undefined,
    startedAt: (row.started_at as string) ?? undefined,
  };
}

// ── Public API ─────────────────────────────────────────────

/**
 * List all topics, optionally including archived ones.
 */
export function list(archived?: boolean): Topic[] {
  const db = getDb();
  let rows: Record<string, unknown>[];

  if (archived) {
    rows = db.prepare('SELECT * FROM topics ORDER BY created_at DESC').all() as Record<string, unknown>[];
  } else {
    rows = db.prepare('SELECT * FROM topics WHERE archived = 0 ORDER BY created_at DESC').all() as Record<string, unknown>[];
  }

  return rows.map(rowToTopic);
}

/**
 * Get a single topic by name (case-insensitive).
 */
export function get(name: string): Topic | undefined {
  return findByName(name);
}

/**
 * Get the currently active topic (status = 'active').
 * Returns undefined if no topic is active.
 */
export function getActive(): Topic | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM topics WHERE status = ? AND archived = 0 LIMIT 1').get('active') as Record<string, unknown> | undefined;
  return row ? rowToTopic(row) : undefined;
}

/**
 * Create a new topic.
 * Throws if a topic with the same name (case-insensitive) already exists.
 */
export function create(name: string, dir: string): Topic {
  const db = getDb();
  const existing = findByName(name);
  if (existing) {
    throw new Error(`Topic "${name}" already exists.`);
  }

  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO topics (id, name, dir, summary, status, turns, last_active, created_at, archived)
    VALUES (?, ?, ?, '', 'idle', 0, NULL, ?, 0)
  `).run(id, name, dir, now);

  return {
    id,
    name,
    dir,
    summary: '',
    status: 'idle',
    turns: 0,
    lastActive: null,
    createdAt: now,
    archived: 0,
  };
}

/**
 * Switch to a topic: set its status to 'active' and update cwd.
 */
export function switchTopic(name: string): void {
  const db = getDb();
  const topic = findByName(name);
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE topics SET status = 'active', last_active = ? WHERE id = ?
  `).run(now, topic.id);

  // Update cwd for the main session
  process.chdir(topic.dir);
}

/**
 * Rename a topic (case-insensitive lookup, name must be unique).
 */
export function rename(oldName: string, newName: string): void {
  const db = getDb();
  const topic = findByName(oldName);
  if (!topic) {
    throw new Error(`Topic "${oldName}" not found.`);
  }

  const existing = findByName(newName);
  if (existing && existing.id !== topic.id) {
    throw new Error(`Topic "${newName}" already exists.`);
  }

  db.prepare('UPDATE topics SET name = ? WHERE id = ?').run(newName, topic.id);
}

/**
 * Archive a topic (soft-delete).
 */
export function archive(name: string): void {
  const db = getDb();
  const topic = findByName(name);
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`);
  }

  db.prepare('UPDATE topics SET archived = 1 WHERE id = ?').run(topic.id);
}

/**
 * Set a topic's summary text.
 */
export function setSummary(name: string, summary: string): void {
  const db = getDb();
  const topic = findByName(name);
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`);
  }

  db.prepare('UPDATE topics SET summary = ? WHERE id = ?').run(summary, topic.id);
}

/**
 * Set a topic's status.
 */
export function setStatus(name: string, status: string): void {
  const db = getDb();
  const topic = findByName(name);
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`);
  }

  if (!['idle', 'active', 'background', 'spawning', 'spawn_failed'].includes(status)) {
    throw new Error(`Invalid status "${status}". Must be idle, active, background, spawning, or spawn_failed.`);
  }

  db.prepare('UPDATE topics SET status = ?, last_active = ? WHERE id = ?')
    .run(status, new Date().toISOString(), topic.id);
}

/**
 * Increment the turn counter for a topic.
 */
export function incrementTurns(name: string): void {
  const db = getDb();
  const topic = findByName(name);
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`);
  }

  db.prepare('UPDATE topics SET turns = turns + 1 WHERE id = ?').run(topic.id);
}

/**
 * Read topic.maxBackground from ~/.yu/config.json.
 * Default: 3.
 */
export function getMaxBackground(): number {
  try {
    const configPath = resolve(homedir(), '.yu', 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const max = config?.topic?.maxBackground;
      if (typeof max === 'number' && max > 0) {
        return max;
      }
    }
  } catch {
    // ignore — fall through to default
  }
  return 3;
}

/**
 * Count currently running background topics.
 */
export function backgroundCount(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM topics WHERE archived = 0 AND status = 'background'"
  ).get() as { count: number };

  return row?.count ?? 0;
}

/** Path to the supervisor daemon script (compiled JS). */
const DAEMON_SCRIPT = resolve(PROJECT_ROOT, 'dist/extension/supervisor-daemon.js');

/** PID file for the supervisor daemon. */
const DAEMON_PID_PATH = resolve(homedir(), '.yu', 'supervisor.pid');

/** Logs directory. */
const DAEMON_LOGS_DIR = resolve(homedir(), '.yu', 'logs');

/**
 * Ensure the supervisor daemon is running.
 * If the PID file exists and points to a live process, do nothing.
 * Otherwise, spawn a new daemon process (detached) and write its PID.
 *
 * Called by cmdBg() before returning, so the daemon can pick
 * up the newly created background task.
 */
export function ensureDaemonRunning(): void {
  // Check if daemon is already running
  if (existsSync(DAEMON_PID_PATH)) {
    try {
      const pidStr = readFileSync(DAEMON_PID_PATH, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && pid > 0) {
        try {
          // Signal 0 tests whether the process exists without actually sending a signal
          process.kill(pid, 0);
          return; // Daemon is alive
        } catch {
          // Stale PID file — process is dead, proceed to spawn
        }
      }
    } catch {
      // Corrupted PID file — proceed to spawn
    }
  }

  // Ensure logs directory exists
  if (!existsSync(DAEMON_LOGS_DIR)) {
    mkdirSync(DAEMON_LOGS_DIR, { recursive: true });
  }

  // Check that the compiled daemon script exists
  if (!existsSync(DAEMON_SCRIPT)) {
    // In dev mode, try the source file via tsx
    console.warn(`Daemon script not found at ${DAEMON_SCRIPT}. Build the project first (npx tsc).`);
    return;
  }

  try {
    const child = spawn(process.execPath, [DAEMON_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });

    // Allow the child to live independently of this parent
    child.unref();

    if (child.pid) {
      writeFileSync(DAEMON_PID_PATH, String(child.pid) + '\n');
    } else {
      console.warn('Daemon spawned but PID is null');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to spawn daemon: ${msg}`);
  }
}

// ── CLI command handler ───────────────────────────────────

const HELP_TEXT = `yu topic — Topic management

Usage:
  yu topic list                    List all topics
  yu topic switch <name>           Switch to a topic (updates cwd)
  yu topic new <name> <dir>        Create a new topic
  yu topic rename <old> <new>      Rename a topic
  yu topic archive <name>          Archive a topic (soft-delete)
  yu topic bg <name> <prompt...>   Run a background task on a topic
  yu topic status                  Show background task progress

Data stored in ~/.yu/topics.db (SQLite).`;

export function topicCommand(subcommand: string, args: string[]): string {
  switch (subcommand) {
    case 'list':
      return cmdList(args);
    case 'switch':
      return cmdSwitch(args);
    case 'new':
      return cmdNew(args);
    case 'rename':
      return cmdRename(args);
    case 'archive':
      return cmdArchive(args);
    case 'bg':
      return cmdBg(args);
    case 'status':
      return cmdStatus();
    case 'help':
    default:
      return HELP_TEXT;
  }
}

function cmdList(args: string[]): string {
  const showArchived = args.includes('--all') || args.includes('-a');
  const topics = list(showArchived);

  if (topics.length === 0) {
    return 'No topics found. Use `yu topic new <name> <dir>` to create one.';
  }

  const lines: string[] = [];
  lines.push('Topics:');
  lines.push('');

  for (const t of topics) {
    const archiveMark = t.archived ? ' (archived)' : '';
    const statusIcon = t.status === 'active' ? '▶' : t.status === 'background' ? '⏳' : '○';
    const lastActive = t.lastActive
      ? `last: ${new Date(t.lastActive).toLocaleDateString()}`
      : 'never';
    lines.push(
      `  ${statusIcon} ${t.name}${archiveMark}` +
      `  [${t.status}]  ${t.turns} turns  ${lastActive}`
    );
    if (t.summary) {
      lines.push(`     ${t.summary}`);
    }
  }

  lines.push('');
  lines.push(`Total: ${topics.length} topic(s)`);
  return lines.join('\n');
}

function cmdSwitch(args: string[]): string {
  if (args.length === 0) {
    return 'Usage: yu topic switch <name>';
  }

  const name = args[0];
  try {
    switchTopic(name);
    return `Switched to topic "${name}". CWD is now ${process.cwd()}.`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: ${msg}`;
  }
}

function cmdNew(args: string[]): string {
  if (args.length < 2) {
    return 'Usage: yu topic new <name> <dir>';
  }

  const name = args[0];
  const dir = resolve(process.cwd(), args[1]);

  if (!existsSync(dir)) {
    return `Error: Directory does not exist: ${dir}`;
  }

  try {
    // Check background limit if topic would be background
    // (default status is 'idle', so this check only applies if bg is explicitly set)
    create(name, dir);
    return `Created topic "${name}" at ${dir}.`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: ${msg}`;
  }
}

function cmdRename(args: string[]): string {
  if (args.length < 2) {
    return 'Usage: yu topic rename <old-name> <new-name>';
  }

  const oldName = args[0];
  const newName = args[1];

  try {
    rename(oldName, newName);
    return `Renamed topic "${oldName}" to "${newName}".`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: ${msg}`;
  }
}

function cmdArchive(args: string[]): string {
  if (args.length === 0) {
    return 'Usage: yu topic archive <name>';
  }

  const name = args[0];
  try {
    archive(name);
    return `Archived topic "${name}".`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: ${msg}`;
  }
}

function cmdBg(args: string[]): string {
  if (args.length < 2) {
    return 'Usage: yu topic bg <name> <prompt...>';
  }

  const name = args[0];
  const prompt = args.slice(1).join(' ');

  const topic = get(name);
  if (!topic) {
    return `Error: Topic "${name}" not found.`;
  }

  // Check background limit first
  const maxBg = getMaxBackground();
  const currentBg = backgroundCount();
  if (currentBg >= maxBg) {
    const topics = list(false);
    const bgTopics = topics.filter(t => t.status === 'background' || t.status === 'spawning');
    const bgList = bgTopics.map(t => `  • ${t.name} (${t.summary || 'no summary'})`).join('\n');
    return `Error: Maximum background topics reached (${maxBg}).\nCurrently running:\n${bgList}`;
  }

  try {
    const db = getDb();
    const now = new Date().toISOString();

    // Atomic UPDATE: only set to 'spawning' if topic is currently 'idle'.
    // This prevents TOCTOU races between concurrent `yu topic bg` invocations.
    const result = db.prepare(`
      UPDATE topics
      SET status = 'spawning',
          summary = ?,
          turns = turns + 1,
          last_active = ?,
          cmd = ?,
          started_at = ?
      WHERE name = ? AND status = 'idle'
    `).run(`Running: ${prompt}`, now, prompt, now, name);

    if (result.changes === 0) {
      const currentStatus = get(name)?.status ?? 'unknown';
      return `Error: Topic "${name}" is not idle (current status: ${currentStatus}).`;
    }

    // Now set status to 'background' so the daemon can pick it up
    setStatus(name, 'background');

    // Ensure the supervisor daemon is running
    ensureDaemonRunning();

    return `Background task started on topic "${name}".\nPrompt: ${prompt}`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: ${msg}`;
  }
}

function cmdStatus(): string {
  const topics = list(false);
  const bgTopics = topics.filter(t => t.status === 'background');

  if (bgTopics.length === 0) {
    return 'No background tasks running.';
  }

  const maxBg = getMaxBackground();
  const lines: string[] = [
    `Background tasks (${bgTopics.length}/${maxBg}):`,
    '',
  ];

  for (const t of bgTopics) {
    const lastActive = t.lastActive
      ? `last active: ${new Date(t.lastActive).toLocaleString()}`
      : 'never active';
    lines.push(`  ⏳ ${t.name}`);
    lines.push(`     summary: ${t.summary || '(no summary)'}`);
    lines.push(`     turns: ${t.turns}  ${lastActive}`);
    lines.push('');
  }

  return lines.join('\n');
}
