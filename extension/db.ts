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

function getDb(): DatabaseSync {
  const path = getDbPath();
  let db = _dbs.get(path);
  if (db) return db;

  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
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
const SCHEMA_VERSION = 4;

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

/** Archive a session (soft-delete with timestamp). */
export function archiveSession(tag: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE tag = ?')
    .run(Date.now(), Date.now(), tag);
}

/** Un-archive a session. */
export function unarchiveSession(tag: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET archived_at = 0, updated_at = ? WHERE tag = ?')
    .run(Date.now(), tag);
}

/** Set the parent session (for session forking/branching). */
export function setSessionParent(tag: string, parentTag: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET parent_id = ?, updated_at = ? WHERE tag = ?')
    .run(parentTag, Date.now(), tag);
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

export function deleteOldSessions(cutoffMs: number): number {
  const db = getDb();
  // Skip archived sessions — they are soft-deleted and preserved
  const rows = db.prepare(
    'SELECT tag FROM sessions WHERE updated_at < ? AND archived_at = 0',
  ).all(cutoffMs) as { tag: string }[];
  for (const r of rows) {
    deleteSession(r.tag);
  }
  return rows.length;
}

export function sessionCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM sessions').get() as { cnt: number };
  return row.cnt;
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
    console.warn(`[yu-agent/db] upsertMCP failed (non-critical): ${msg}`);
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
    totalCost?: number;
    turnCount?: number;
    hitRate?: number;
  },
  updatedAt: number = Date.now(),
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO cache (tag, total_hits, total_misses, total_cost, turn_count, hit_rate, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET
      total_hits = ?, total_misses = ?, total_cost = ?,
      turn_count = ?, hit_rate = ?, updated_at = ?
  `).run(
    tag,
    data.totalHits ?? 0, data.totalMisses ?? 0, data.totalCost ?? 0,
    data.turnCount ?? 0, data.hitRate ?? 0, updatedAt,
    data.totalHits ?? 0, data.totalMisses ?? 0, data.totalCost ?? 0,
    data.turnCount ?? 0, data.hitRate ?? 0, updatedAt,
  );
}

export function getCache(tag: string): CacheRow | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT total_hits, total_misses, total_cost, turn_count, hit_rate, updated_at FROM cache WHERE tag = ?',
  ).get(tag) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    totalHits: row.total_hits as number,
    totalMisses: row.total_misses as number,
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
  const params: any[] = [sessionId];
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

// ── Slug generation (P3) ────────────────────────────────

const ADJECTIVES = [
  'curious', 'brave', 'calm', 'eager', 'fancy', 'golden', 'happy', 'jolly',
  'keen', 'lucky', 'merry', 'neat', 'proud', 'quick', 'quiet', 'rapid',
  'shy', 'silent', 'sunny', 'swift', 'tiny', 'warm', 'wise', 'young',
  'bold', 'bright', 'cool', 'crisp', 'dapper', 'droll', 'faint', 'fresh',
  'gentle', 'grand', 'humble', 'jolly', 'kind', 'lively', 'mellow', 'mild',
  'noble', 'odd', 'peppy', 'plain', 'regal', 'royal', 'sharp', 'smooth',
  'spry', 'stark', 'sturdy', 'subtle', 'sweet', 'tame', 'taut', 'vast',
];

const NOUNS = [
  'cabin', 'brook', 'cloud', 'dawn', 'delta', 'dune', 'echo', 'ember',
  'frost', 'glade', 'glen', 'harbor', 'haven', 'islet', 'knoll', 'lagoon',
  'marsh', 'meadow', 'mirth', 'moss', 'oasis', 'pixel', 'pond', 'prairie',
  'reef', 'ridge', 'rivet', 'rock', 'shallows', 'shard', 'spark', 'stone',
  'surge', 'swamp', 'swirl', 'thaw', 'torch', 'tower', 'trace', 'vale',
  'vertex', 'vista', 'vortex', 'wisp', 'yield', 'zenith', 'bloom', 'cove',
];

/**
 * Generate a random readable slug like "curious-cabin".
 */
export function generateSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

/**
 * Ensure a session has a slug. If empty, generate one and save it.
 */
export function ensureSlug(tag: string): string {
  const meta = getSessionMeta(tag);
  if (meta && meta.slug) return meta.slug;
  const slug = generateSlug();
  const db = getDb();
  db.prepare('UPDATE sessions SET slug = ?, updated_at = ? WHERE tag = ?')
    .run(slug, Date.now(), tag);
  return slug;
}

// ── Session fork (P2) ───────────────────────────────────

/**
 * Fork a session: create a new session with the same messages.
 * Returns the new session tag.
 */
export function forkSession(
  sourceTag: string,
  newTag: string,
  newName?: string,
): SessionMeta | null {
  const source = getSessionMeta(sourceTag);
  if (!source) return null;

  const db = getDb();
  const now = Date.now();
  const slug = generateSlug();

  // Create new session
  upsertSession(newTag, {
    name: newName || `${source.name} (fork)` || slug,
    cwd: source.cwd,
    agent: source.agent || undefined,
    model: source.model !== '{}' ? source.model : undefined,
    parentId: sourceTag,
    slug,
  });

  // Copy messages
  const messages = getMessages(sourceTag);
  for (const msg of messages) {
    insertMessage(newTag, msg.role, msg.content, msg.timeCreated);
  }

  // Copy todos
  const todos = getTodos(sourceTag);
  for (const todo of todos) {
    db.prepare(
      'INSERT INTO todos (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(newTag, todo.content, 'pending', todo.priority, todo.position, now, now);
  }

  return getSessionMeta(newTag);
}

// ── Summary stats (P4) ──────────────────────────────────

export function updateSessionSummary(
  tag: string,
  data: {
    files?: number;
    additions?: number;
    deletions?: number;
  },
): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET
      summary_files = summary_files + ?,
      summary_additions = summary_additions + ?,
      summary_deletions = summary_deletions + ?,
      updated_at = ?
    WHERE tag = ?
  `).run(data.files ?? 0, data.additions ?? 0, data.deletions ?? 0, Date.now(), tag);
}

export function updateSessionSummaryStats(
  tag: string,
  data: {
    files?: number;
    additions?: number;
    deletions?: number;
  },
): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET
      summary_files = ?,
      summary_additions = ?,
      summary_deletions = ?,
      updated_at = ?
    WHERE tag = ?
  `).run(data.files ?? 0, data.additions ?? 0, data.deletions ?? 0, Date.now(), tag);
}

// ── Cleanup ──────────────────────────────────────────────

export function closeDb(): void {
  for (const [path, db] of _dbs) {
    try { db.close(); } catch { /* ignore */ }
  }
  _dbs.clear();
}
