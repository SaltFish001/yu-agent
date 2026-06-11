/**
 * yu-agent — SQLite session storage.
 *
 * Replaces per-session JSON files with a single SQLite database per project.
 * All operations are synchronous (DatabaseSync API).
 *
 * DB path: {getStatusDir()}/sessions.db
 *
 * Schema:
 *   sessions — metadata (name, cwd, agent, model, parent_id, slug,
 *              archived_at, metadata JSON, created_at, updated_at,
 *              summary_* stats)
 *   agents   — sub-agent state (JSON array)
 *   mcp      — MCP server connections (JSON array)
 *   lsp      — LSP server status (JSON array)
 *   team     — team mode state (JSON object)
 *   summary  — aggregated counts (running, completed, failed)
 *   cache    — cache stats (hits, misses, hit_rate, turn_count)
 *   messages — conversation messages (session_id, role, content)
 *   todos    — per-session task list
 */

import { createLogger } from './logger.js';
const log = createLogger('db');

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getStatusDir } from './session-context.js';

// ── Types ────────────────────────────────────────────────

export interface SessionMeta {
  tag: string;
  name: string;
  cwd: string;
  agent: string;
  model: string;
  parentId: string;
  slug: string;
  archivedAt: number;
  metadata: string;
  createdAt: number;
  updatedAt: number;
  summaryFiles?: number;
  summaryAdditions?: number;
  summaryDeletions?: number;
}

export interface MessageRow {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  timeCreated: number;
}

export interface TodoRow {
  id: number;
  sessionId: string;
  content: string;
  status: string;
  priority: string;
  position: number;
  timeCreated: number;
  timeUpdated: number;
}

export interface SummaryRow {
  running: number;
  completed: number;
  failed: number;
  mcp_connected: number;
  lsp_ready: number;
  updatedAt: number;
}

export interface CacheRow {
  totalHits: number;
  totalMisses: number;
  totalOutput: number;
  totalCost: number;
  turnCount: number;
  hitRate: number;
  updatedAt: number;
}

// ── Lazy singleton per project ───────────────────────────

const _dbs = new Map<string, DatabaseSync>();

export function getDbPath(): string {
  const dir = getStatusDir();
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch { /* best-effort */ }
  }
  return resolve(dir, 'sessions.db');
}

export function getStatusDirPath(): string {
  return getStatusDir();
}

export function getDb(): DatabaseSync {
  const path = getDbPath();
  let db = _dbs.get(path);
  if (db) return db;

  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous=NORMAL');
  // Wait up to 3 seconds for lock instead of immediately failing
  // Handles concurrent writes from multiple yu-agent processes
  db.exec('PRAGMA busy_timeout=3000');
  initSchema(db);
  runMigrations(db);
  _dbs.set(path, db);
  return db;
}

// ── Schema versions — used for migration ─────────────────
const SCHEMA_VERSION = 6;

function initSchema(db: DatabaseSync): void {
  // Create schema version tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      tag TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      cwd TEXT DEFAULT '',
      agent TEXT DEFAULT '',
      model TEXT DEFAULT '{}',
      parent_id TEXT DEFAULT '',
      slug TEXT DEFAULT '',
      archived_at INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      summary_files INTEGER DEFAULT 0,
      summary_additions INTEGER DEFAULT 0,
      summary_deletions INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      tag TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp (
      tag TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS lsp (
      tag TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS team (
      tag TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS summary (
      tag TEXT PRIMARY KEY,
      running INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      mcp_connected INTEGER DEFAULT 0,
      lsp_ready INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      tag TEXT PRIMARY KEY,
      total_hits INTEGER DEFAULT 0,
      total_misses INTEGER DEFAULT 0,
      total_output INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      turn_count INTEGER DEFAULT 0,
      hit_rate REAL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  // ── Messages table (P0 — conversation history) ──────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      time_created INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(tag) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
  `);

  // ── Todos table (P1 — per-session task list) ────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      position INTEGER NOT NULL DEFAULT 0,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(tag) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todos_session_id ON todos(session_id);
  `);

  // ── Logs table (P3 — structured logging) ───────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      module TEXT NOT NULL,
      message TEXT NOT NULL,
      error TEXT,
      data TEXT
    );
  `);

  // ── Token usage table (P3 — LLM token tracking) ────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_tag TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      model TEXT NOT NULL,
      cache_hit_tokens INTEGER DEFAULT 0,
      cache_miss_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      turn_count INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL
    );
  `);

  // ── Agent runs table (P3 — agent run tracking) ─────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_tag TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      goal TEXT,
      files TEXT,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER,
      error TEXT,
      timestamp INTEGER NOT NULL
    );
  `);
}

// ── Schema migration ────────────────────────────────────
// Handles adding new columns to existing databases.

function runMigrations(db: DatabaseSync): void {
  const currentVersion = (() => {
    try {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
      return row?.v ?? 0;
    } catch {
      return 0;
    }
  })();

  if (currentVersion >= SCHEMA_VERSION) return;

  // Migration 1 → 2: Add new columns to sessions table
  if (currentVersion < 2) {
    const newColumns = [
      ['agent', "TEXT DEFAULT ''"],
      ['model', "TEXT DEFAULT '{}'"],
      ['parent_id', "TEXT DEFAULT ''"],
      ['archived_at', 'INTEGER DEFAULT 0'],
      ['metadata', "TEXT DEFAULT '{}'"],
    ] as const;

    for (const [col, def] of newColumns) {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${def}`);
      } catch {
        // column already exists — ignore
      }
    }
  }

  // Migration 2 → 3: Add messages table, slug column, summary stats
  if (currentVersion < 3) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          time_created INTEGER NOT NULL
        );
      `);
    } catch { /* ignore if exists */ }
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)');
    } catch { /* ignore */ }

    // Add slug column to sessions
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN slug TEXT DEFAULT ''");
    } catch { /* ignore */ }
    // Add summary stats columns
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN summary_files INTEGER DEFAULT 0');
    } catch { /* ignore */ }
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN summary_additions INTEGER DEFAULT 0');
    } catch { /* ignore */ }
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN summary_deletions INTEGER DEFAULT 0');
    } catch { /* ignore */ }
  }

  // Migration 3 → 4: Add todos table
  if (currentVersion < 4) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS todos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          priority TEXT NOT NULL DEFAULT 'medium',
          position INTEGER NOT NULL DEFAULT 0,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL
        );
      `);
    } catch { /* ignore if exists */ }
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_todos_session_id ON todos(session_id)');
    } catch { /* ignore */ }
  }

  // Migration 4 → 5: Add total_output column to cache table
  if (currentVersion < 5) {
    try {
      db.exec('ALTER TABLE cache ADD COLUMN total_output INTEGER DEFAULT 0');
    } catch { /* column already exists — ignore */ }
  }

  // Migration 5 → 6: Add logs, token_usage, agent_runs tables
  if (currentVersion < 6) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          level TEXT NOT NULL,
          module TEXT NOT NULL,
          message TEXT NOT NULL,
          error TEXT,
          data TEXT
        );
      `);
    } catch { /* ignore if exists */ }
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_tag TEXT NOT NULL,
          agent_type TEXT NOT NULL,
          model TEXT NOT NULL,
          cache_hit_tokens INTEGER DEFAULT 0,
          cache_miss_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          cost REAL DEFAULT 0,
          duration_ms INTEGER DEFAULT 0,
          turn_count INTEGER DEFAULT 0,
          timestamp INTEGER NOT NULL
        );
      `);
    } catch { /* ignore if exists */ }
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_tag TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          agent_type TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          goal TEXT,
          files TEXT,
          started_at INTEGER NOT NULL,
          duration_ms INTEGER,
          error TEXT,
          timestamp INTEGER NOT NULL
        );
      `);
    } catch { /* ignore if exists */ }
  }

  db.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
  ).run(SCHEMA_VERSION, Date.now());
}

// ── Session metadata ─────────────────────────────────────

export function upsertSession(
  tag: string,
  data: {
    name?: string;
    cwd?: string;
    agent?: string;
    model?: string;
    parentId?: string;
    slug?: string;
    metadata?: string;
  },
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions (tag, name, cwd, agent, model, parent_id, slug, archived_at, metadata, summary_files, summary_additions, summary_deletions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET
      name = COALESCE(NULLIF(?, ''), sessions.name),
      cwd = COALESCE(NULLIF(?, ''), sessions.cwd),
      agent = COALESCE(NULLIF(?, ''), sessions.agent),
      model = COALESCE(NULLIF(?, ''), sessions.model),
      parent_id = COALESCE(NULLIF(?, ''), sessions.parent_id),
      slug = COALESCE(NULLIF(?, ''), sessions.slug),
      metadata = COALESCE(NULLIF(?, ''), sessions.metadata),
      updated_at = ?
  `).run(
    tag, data.name ?? '', data.cwd ?? '', data.agent ?? '', data.model ?? '',
    data.parentId ?? '', data.slug ?? '', data.metadata ?? '{}', now, now,
    data.name ?? '', data.cwd ?? '', data.agent ?? '', data.model ?? '',
    data.parentId ?? '', data.slug ?? '', data.metadata ?? '{}', now,
  );
}

export function getSessionMeta(tag: string): SessionMeta | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT tag, name, cwd, agent, model, parent_id, slug, archived_at, metadata, summary_files, summary_additions, summary_deletions, created_at, updated_at FROM sessions WHERE tag = ?',
  ).get(tag) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    tag: row.tag as string,
    name: row.name as string,
    cwd: row.cwd as string,
    agent: row.agent as string,
    model: row.model as string,
    parentId: row.parent_id as string,
    slug: (row.slug as string) || '',
    archivedAt: row.archived_at as number,
    metadata: row.metadata as string,
    summaryFiles: row.summary_files as number || 0,
    summaryAdditions: row.summary_additions as number || 0,
    summaryDeletions: row.summary_deletions as number || 0,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function listSessions(): SessionMeta[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT tag, name, cwd, agent, model, parent_id, slug, archived_at, metadata, summary_files, summary_additions, summary_deletions, created_at, updated_at FROM sessions ORDER BY updated_at DESC',
  ).all() as Record<string, unknown>[];
  return rows.map(r => ({
    tag: r.tag as string,
    name: r.name as string,
    cwd: r.cwd as string,
    agent: r.agent as string,
    model: r.model as string,
    parentId: r.parent_id as string,
    slug: (r.slug as string) || '',
    archivedAt: r.archived_at as number,
    metadata: r.metadata as string,
    summaryFiles: r.summary_files as number || 0,
    summaryAdditions: r.summary_additions as number || 0,
    summaryDeletions: r.summary_deletions as number || 0,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  }));
}

export function deleteSession(tag: string): void {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM sessions WHERE tag = ?').run(tag);
    db.prepare('DELETE FROM agents WHERE tag = ?').run(tag);
    db.prepare('DELETE FROM mcp WHERE tag = ?').run(tag);
    db.prepare('DELETE FROM lsp WHERE tag = ?').run(tag);
    db.prepare('DELETE FROM team WHERE tag = ?').run(tag);
    db.prepare('DELETE FROM summary WHERE tag = ?').run(tag);
    db.prepare('DELETE FROM cache WHERE tag = ?').run(tag);
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(tag);
    db.prepare('DELETE FROM todos WHERE session_id = ?').run(tag);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── Agents ───────────────────────────────────────────────

export function upsertAgents(tag: string, agentsJson: string, updatedAt: number = Date.now()): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO agents (tag, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = ?
  `).run(tag, agentsJson, updatedAt, agentsJson, updatedAt);
}

export function getAgents(tag: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT data FROM agents WHERE tag = ?').get(tag) as { data: string } | undefined;
  return row?.data ?? null;
}

// ── MCP ──────────────────────────────────────────────────

export function upsertMCP(tag: string, dataJson: string, updatedAt: number = Date.now()): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO mcp (tag, data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = ?
    `).run(tag, dataJson, updatedAt, dataJson, updatedAt);
  } catch (err: unknown) {
    // MCP status writing is non-critical — log and move on
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`upsertMCP failed (non-critical): ${msg}`);
  }
}

export function getMCP(tag: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT data FROM mcp WHERE tag = ?').get(tag) as { data: string } | undefined;
  return row?.data ?? null;
}

// ── LSP ──────────────────────────────────────────────────

export function upsertLSP(tag: string, dataJson: string, updatedAt: number = Date.now()): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO lsp (tag, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = ?
  `).run(tag, dataJson, updatedAt, dataJson, updatedAt);
}

export function getLSP(tag: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT data FROM lsp WHERE tag = ?').get(tag) as { data: string } | undefined;
  return row?.data ?? null;
}

// ── Team ─────────────────────────────────────────────────

export function upsertTeam(tag: string, dataJson: string, updatedAt: number = Date.now()): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO team (tag, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = ?
  `).run(tag, dataJson, updatedAt, dataJson, updatedAt);
}

export function getTeam(tag: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT data FROM team WHERE tag = ?').get(tag) as { data: string } | undefined;
  return row?.data ?? null;
}

// ── Summary ──────────────────────────────────────────────

export function upsertSummary(
  tag: string,
  data: {
    running?: number;
    completed?: number;
    failed?: number;
    mcpConnected?: number;
    lspReady?: number;
  },
  updatedAt: number = Date.now(),
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO summary (tag, running, completed, failed, mcp_connected, lsp_ready, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET
      running = ?, completed = ?, failed = ?,
      mcp_connected = ?, lsp_ready = ?, updated_at = ?
  `).run(
    tag,
    data.running ?? 0, data.completed ?? 0, data.failed ?? 0,
    data.mcpConnected ?? 0, data.lspReady ?? 0, updatedAt,
    data.running ?? 0, data.completed ?? 0, data.failed ?? 0,
    data.mcpConnected ?? 0, data.lspReady ?? 0, updatedAt,
  );
}

export function getSummary(tag: string): SummaryRow | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT running, completed, failed, mcp_connected, lsp_ready, updated_at FROM summary WHERE tag = ?',
  ).get(tag) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    running: row.running as number,
    completed: row.completed as number,
    failed: row.failed as number,
    mcp_connected: row.mcp_connected as number,
    lsp_ready: row.lsp_ready as number,
    updatedAt: row.updated_at as number,
  };
}

// ── Cache ────────────────────────────────────────────────

export function upsertCache(
  tag: string,
  data: {
    totalHits?: number;
    totalMisses?: number;
    totalOutput?: number;
    totalCost?: number;
    turnCount?: number;
    hitRate?: number;
  },
  updatedAt: number = Date.now(),
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO cache (tag, total_hits, total_misses, total_output, total_cost, turn_count, hit_rate, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET
      total_hits = ?, total_misses = ?, total_output = ?, total_cost = ?,
      turn_count = ?, hit_rate = ?, updated_at = ?
  `).run(
    tag,
    data.totalHits ?? 0, data.totalMisses ?? 0, data.totalOutput ?? 0, data.totalCost ?? 0,
    data.turnCount ?? 0, data.hitRate ?? 0, updatedAt,
    data.totalHits ?? 0, data.totalMisses ?? 0, data.totalOutput ?? 0, data.totalCost ?? 0,
    data.turnCount ?? 0, data.hitRate ?? 0, updatedAt,
  );
}

export function getCache(tag: string): CacheRow | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT total_hits, total_misses, total_output, total_cost, turn_count, hit_rate, updated_at FROM cache WHERE tag = ?',
  ).get(tag) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    totalHits: row.total_hits as number,
    totalMisses: row.total_misses as number,
    totalOutput: row.total_output as number,
    totalCost: row.total_cost as number,
    turnCount: row.turn_count as number,
    hitRate: row.hit_rate as number,
    updatedAt: row.updated_at as number,
  };
}

// ── Messages (P0 — conversation history) ────────────────

export function insertMessage(
  sessionId: string,
  role: string,
  content: string,
  timeCreated: number = Date.now(),
): number {
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO messages (session_id, role, content, time_created) VALUES (?, ?, ?, ?)',
  ).run(sessionId, role, content, timeCreated);
  return Number(result.lastInsertRowid);
}

export function getMessages(sessionId: string, limit?: number): MessageRow[] {
  const db = getDb();
  const sql = limit
    ? 'SELECT id, session_id, role, content, time_created FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT id, session_id, role, content, time_created FROM messages WHERE session_id = ? ORDER BY id ASC';
  const params: (string | number | null)[] = [sessionId];
  if (limit) params.push(limit);
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  const result = rows.map(r => ({
    id: r.id as number,
    sessionId: r.session_id as string,
    role: r.role as string,
    content: r.content as string,
    timeCreated: r.time_created as number,
  }));
  // If limit was used, reverse to chronological order
  if (limit) result.reverse();
  return result;
}

export function getMessageCount(sessionId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?').get(sessionId) as { cnt: number };
  return row.cnt;
}

// ── Todos (P1 — per-session task list) ──────────────────

export function insertTodo(
  sessionId: string,
  content: string,
  priority: string = 'medium',
  position?: number,
  timeCreated: number = Date.now(),
): number {
  const db = getDb();
  // Auto-assign position if not given
  if (position === undefined) {
    const maxRow = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM todos WHERE session_id = ?').get(sessionId) as { pos: number };
    position = maxRow.pos;
  }
  const result = db.prepare(
    'INSERT INTO todos (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(sessionId, content, 'pending', priority, position, timeCreated, timeCreated);
  return Number(result.lastInsertRowid);
}

export function getTodos(sessionId: string): TodoRow[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, session_id, content, status, priority, position, time_created, time_updated FROM todos WHERE session_id = ? ORDER BY position ASC',
  ).all(sessionId) as Record<string, unknown>[];
  return rows.map(r => ({
    id: r.id as number,
    sessionId: r.session_id as string,
    content: r.content as string,
    status: r.status as string,
    priority: r.priority as string,
    position: r.position as number,
    timeCreated: r.time_created as number,
    timeUpdated: r.time_updated as number,
  }));
}

export function updateTodoStatus(id: number, status: string): void {
  const db = getDb();
  db.prepare('UPDATE todos SET status = ?, time_updated = ? WHERE id = ?')
    .run(status, Date.now(), id);
}

export function updateTodoPriority(id: number, priority: string): void {
  const db = getDb();
  db.prepare('UPDATE todos SET priority = ?, time_updated = ? WHERE id = ?')
    .run(priority, Date.now(), id);
}

export function deleteTodo(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM todos WHERE id = ?').run(id);
}

// ── Summary stats ────────────────────────────────────────

export interface UpdateSummaryOptions {
  /** 'accumulate' (default): add values to existing counts (old updateSessionSummary behavior).
   *  'replace': overwrite existing counts (old updateSessionSummaryStats behavior). */
  mode?: 'accumulate' | 'replace';
}

/**
 * Update session summary stats. Merges the old updateSessionSummary (accumulate)
 * and updateSessionSummaryStats (replace) into one function with a mode parameter.
 */
export function updateSessionSummary(
  tag: string,
  data: {
    files?: number;
    additions?: number;
    deletions?: number;
  },
  opts?: UpdateSummaryOptions,
): void {
  const db = getDb();
  const mode = opts?.mode ?? 'accumulate';
  const op = mode === 'accumulate' ? '+' : '';
  db.prepare(`
    UPDATE sessions SET
      summary_files = summary_files ${op} ?,
      summary_additions = summary_additions ${op} ?,
      summary_deletions = summary_deletions ${op} ?,
      updated_at = ?
    WHERE tag = ?
  `).run(data.files ?? 0, data.additions ?? 0, data.deletions ?? 0, Date.now(), tag);
}

/** @deprecated Use updateSessionSummary with { mode: 'replace' } instead. */
export function updateSessionSummaryStats(
  tag: string,
  data: {
    files?: number;
    additions?: number;
    deletions?: number;
  },
): void {
  updateSessionSummary(tag, data, { mode: 'replace' });
}

// ── Token Usage ──────────────────────────────────────────

export interface TokenUsageEntry {
  sessionTag: string;
  agentType: string;
  model: string;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
  durationMs?: number;
  turnCount?: number;
}

export function insertTokenUsage(entry: TokenUsageEntry): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO token_usage (session_tag, agent_type, model, cache_hit_tokens, cache_miss_tokens, output_tokens, total_tokens, cost, duration_ms, turn_count, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionTag,
    entry.agentType,
    entry.model,
    entry.cacheHitTokens ?? 0,
    entry.cacheMissTokens ?? 0,
    entry.outputTokens ?? 0,
    entry.totalTokens ?? 0,
    entry.cost ?? 0,
    entry.durationMs ?? 0,
    entry.turnCount ?? 0,
    Date.now(),
  );
}

export function getTokenUsageBySession(sessionTag: string): {
  totalHits: number;
  totalMisses: number;
  totalOutput: number;
  totalTokens: number;
  totalCost: number;
  totalDurationMs: number;
  totalTurns: number;
  count: number;
} {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(cache_hit_tokens), 0) AS total_hits,
      COALESCE(SUM(cache_miss_tokens), 0) AS total_misses,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost), 0) AS total_cost,
      COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
      COALESCE(SUM(turn_count), 0) AS total_turns,
      COUNT(*) AS count
    FROM token_usage
    WHERE session_tag = ?
  `).get(sessionTag) as Record<string, unknown>;
  return {
    totalHits: row.total_hits as number,
    totalMisses: row.total_misses as number,
    totalOutput: row.total_output as number,
    totalTokens: row.total_tokens as number,
    totalCost: row.total_cost as number,
    totalDurationMs: row.total_duration_ms as number,
    totalTurns: row.total_turns as number,
    count: row.count as number,
  };
}

export function getTokenUsageAggregate(): {
  totalHits: number;
  totalMisses: number;
  totalOutput: number;
  totalTokens: number;
  totalCost: number;
  totalDurationMs: number;
  totalTurns: number;
  sessionCount: number;
} {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(cache_hit_tokens), 0) AS total_hits,
      COALESCE(SUM(cache_miss_tokens), 0) AS total_misses,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost), 0) AS total_cost,
      COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
      COALESCE(SUM(turn_count), 0) AS total_turns,
      COUNT(DISTINCT session_tag) AS session_count
    FROM token_usage
  `).get() as Record<string, unknown>;
  return {
    totalHits: row.total_hits as number,
    totalMisses: row.total_misses as number,
    totalOutput: row.total_output as number,
    totalTokens: row.total_tokens as number,
    totalCost: row.total_cost as number,
    totalDurationMs: row.total_duration_ms as number,
    totalTurns: row.total_turns as number,
    sessionCount: row.session_count as number,
  };
}

// ── Agent Runs ───────────────────────────────────────────

export interface AgentRunEntry {
  sessionTag: string;
  agentId: string;
  agentType: string;
  model: string;
  status: string;
  goal?: string;
  files?: string[];
  startedAt: number;
  durationMs?: number;
  error?: string;
}

export function insertAgentRun(entry: AgentRunEntry): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_runs (session_tag, agent_id, agent_type, model, status, goal, files, started_at, duration_ms, error, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionTag,
    entry.agentId,
    entry.agentType,
    entry.model,
    entry.status,
    entry.goal ?? null,
    entry.files ? JSON.stringify(entry.files) : null,
    entry.startedAt,
    entry.durationMs ?? null,
    entry.error ?? null,
    Date.now(),
  );
}

export function updateAgentRunStatus(
  agentId: string,
  status: string,
  durationMs?: number,
  error?: string,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE agent_runs SET
      status = ?,
      duration_ms = COALESCE(?, duration_ms),
      error = COALESCE(?, error),
      timestamp = ?
    WHERE agent_id = ?
  `).run(status, durationMs ?? null, error ?? null, Date.now(), agentId);
}

export function getAgentRunStats(): {
  total: number;
  completed: number;
  failed: number;
  avgDurationMs: number;
} & Record<string, { total: number; completed: number; failed: number; avgDurationMs: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      agent_type,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status IN ('failed', 'interrupted') THEN 1 ELSE 0 END) AS failed,
      COALESCE(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE NULL END), 0) AS avg_duration_ms
    FROM agent_runs
    GROUP BY agent_type
  `).all() as Record<string, unknown>[];

  const result: Record<string, { total: number; completed: number; failed: number; avgDurationMs: number }> = {};
  let total = 0;
  let completed = 0;
  let failed = 0;
  let totalDuration = 0;
  let durationCount = 0;

  for (const row of rows) {
    const agentType = row.agent_type as string;
    const t = row.total as number;
    const c = row.completed as number;
    const f = row.failed as number;
    const avg = row.avg_duration_ms as number;
    result[agentType] = {
      total: t,
      completed: c,
      failed: f,
      avgDurationMs: Math.round(avg),
    };
    total += t;
    completed += c;
    failed += f;
    totalDuration += avg * t;
    durationCount += t;
  }

  return {
    ...result,
    total,
    completed,
    failed,
    avgDurationMs: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
  } as {
    total: number;
    completed: number;
    failed: number;
    avgDurationMs: number;
  } & Record<string, { total: number; completed: number; failed: number; avgDurationMs: number }>;
}

// ── Logs ─────────────────────────────────────────────────

export function getRecentLogs(
  limit: number,
  level?: string,
  module?: string,
): { id: number; timestamp: string; level: string; module: string; message: string; error: string | null; data: string | null }[] {
  const db = getDb();
  let sql = 'SELECT id, timestamp, level, module, message, error, data FROM logs WHERE 1=1';
  const params: (string | number)[] = [];

  if (level) {
    sql += ' AND level = ?';
    params.push(level);
  }
  if (module) {
    sql += ' AND module = ?';
    params.push(module);
  }

  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as {
    id: number;
    timestamp: string;
    level: string;
    module: string;
    message: string;
    error: string | null;
    data: string | null;
  }[];
}

// ── Cleanup ──────────────────────────────────────────────

export function closeDb(): void {
  for (const [_path, db] of _dbs) {
    try { db.close(); } catch { /* ignore */ }
  }
  _dbs.clear();
}
