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

import { createLogger } from '../logger.js'

const _log = createLogger('db')

import { Database as DatabaseSync } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { getStatusDir } from '../session-context.js'

// ── Types ────────────────────────────────────────────────

export interface SessionMeta {
  tag: string
  name: string
  cwd: string
  agent: string
  model: string
  parentId: string
  slug: string
  archivedAt: number
  metadata: string
  createdAt: number
  updatedAt: number
  summaryFiles?: number
  summaryAdditions?: number
  summaryDeletions?: number
}

export interface MessageRow {
  id: number
  sessionId: string
  role: string
  content: string
  timeCreated: number
}

export interface TodoRow {
  id: number
  sessionId: string
  content: string
  status: string
  priority: string
  position: number
  timeCreated: number
  timeUpdated: number
}

export interface SummaryRow {
  running: number
  completed: number
  failed: number
  mcp_connected: number
  lsp_ready: number
  updatedAt: number
}

export interface CacheRow {
  totalHits: number
  totalMisses: number
  totalOutput: number
  totalCost: number
  turnCount: number
  hitRate: number
  updatedAt: number
}

// ── Lazy singleton per project ───────────────────────────

const _dbs = new Map<string, DatabaseSync>()

export function getDbPath(): string {
  const dir = getStatusDir()
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* best-effort */
    }
  }
  return resolve(dir, 'sessions.db')
}

export function getStatusDirPath(): string {
  return getStatusDir()
}

export function getDb(): DatabaseSync {
  const path = getDbPath()
  let db = _dbs.get(path)
  if (db) return db

  db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous=NORMAL')
  // Wait up to 3 seconds for lock instead of immediately failing
  // Handles concurrent writes from multiple yu-agent processes
  db.exec('PRAGMA busy_timeout=3000')
  initSchema(db)
  runMigrations(db)
  _dbs.set(path, db)
  return db
}

// ── Schema versions — used for migration ─────────────────
const SCHEMA_VERSION = 6

function initSchema(db: DatabaseSync): void {
  // Create schema version tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

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
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      tag TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp (
      tag TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS lsp (
      tag TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS team (
      tag TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );
  `)
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
  `)
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
  `)
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
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
  `)

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
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_todos_session_id ON todos(session_id);
  `)

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
  `)

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
  `)

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
  `)
}

// ── Schema migration ────────────────────────────────────
// Handles adding new columns to existing databases.

function runMigrations(db: DatabaseSync): void {
  const currentVersion = (() => {
    try {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined
      return row?.v ?? 0
    } catch {
      return 0
    }
  })()

  if (currentVersion >= SCHEMA_VERSION) return

  // Migration 1 → 2: Add new columns to sessions table
  if (currentVersion < 2) {
    const newColumns = [
      ['agent', "TEXT DEFAULT ''"],
      ['model', "TEXT DEFAULT '{}'"],
      ['parent_id', "TEXT DEFAULT ''"],
      ['archived_at', 'INTEGER DEFAULT 0'],
      ['metadata', "TEXT DEFAULT '{}'"],
    ] as const

    for (const [col, def] of newColumns) {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${def}`)
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
      `)
    } catch {
      /* ignore if exists */
    }
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)')
    } catch {
      /* ignore */
    }

    // Add slug column to sessions
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN slug TEXT DEFAULT ''")
    } catch {
      /* ignore */
    }
    // Add summary stats columns
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN summary_files INTEGER DEFAULT 0')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN summary_additions INTEGER DEFAULT 0')
    } catch {
      /* ignore */
    }
    try {
      db.exec('ALTER TABLE sessions ADD COLUMN summary_deletions INTEGER DEFAULT 0')
    } catch {
      /* ignore */
    }
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
      `)
    } catch {
      /* ignore if exists */
    }
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_todos_session_id ON todos(session_id)')
    } catch {
      /* ignore */
    }
  }

  // Migration 4 → 5: Add total_output column to cache table
  if (currentVersion < 5) {
    try {
      db.exec('ALTER TABLE cache ADD COLUMN total_output INTEGER DEFAULT 0')
    } catch {
      /* column already exists — ignore */
    }
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
      `)
    } catch {
      /* ignore if exists */
    }
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
      `)
    } catch {
      /* ignore if exists */
    }
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
      `)
    } catch {
      /* ignore if exists */
    }
  }

  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, Date.now())
}

// ── Cleanup ──────────────────────────────────────────────

export function closeDb(): void {
  for (const [_path, db] of _dbs) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
  _dbs.clear()
}
