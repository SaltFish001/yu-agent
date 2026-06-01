/**
 * yu-agent — SQLite session storage.
 *
 * Replaces per-session JSON files with a single SQLite database per project.
 * All operations are synchronous (DatabaseSync API).
 *
 * DB path: {getStatusDir()}/sessions.db
 *
 * Schema:
 *   sessions — metadata (name, cwd, created_at, updated_at)
 *   agents   — sub-agent state (JSON array)
 *   mcp      — MCP server connections (JSON array)
 *   lsp      — LSP server status (JSON array)
 *   team     — team mode state (JSON object)
 *   summary  — aggregated counts (running, completed, failed)
 *   cache    — cache stats (hits, misses, hit_rate, turn_count)
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
  createdAt: number;
  updatedAt: number;
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
  initSchema(db);
  _dbs.set(path, db);
  return db;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      tag TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      cwd TEXT DEFAULT '',
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
}

// ── Session metadata ─────────────────────────────────────

export function upsertSession(
  tag: string,
  data: { name?: string; cwd?: string },
): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions (tag, name, cwd, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET
      name = COALESCE(NULLIF(?, ''), sessions.name),
      cwd = COALESCE(NULLIF(?, ''), sessions.cwd),
      updated_at = ?
  `).run(tag, data.name ?? '', data.cwd ?? '', now, now,
        data.name ?? '', data.cwd ?? '', now);
}

export function getSessionMeta(tag: string): SessionMeta | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT tag, name, cwd, created_at, updated_at FROM sessions WHERE tag = ?',
  ).get(tag) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    tag: row.tag as string,
    name: row.name as string,
    cwd: row.cwd as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function listSessions(): SessionMeta[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT tag, name, cwd, created_at, updated_at FROM sessions ORDER BY updated_at DESC',
  ).all() as Record<string, unknown>[];
  return rows.map(r => ({
    tag: r.tag as string,
    name: r.name as string,
    cwd: r.cwd as string,
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function deleteOldSessions(cutoffMs: number): number {
  const db = getDb();
  const rows = db.prepare(
    'SELECT tag FROM sessions WHERE updated_at < ?',
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
  const db = getDb();
  db.prepare(`
    INSERT INTO mcp (tag, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = ?
  `).run(tag, dataJson, updatedAt, dataJson, updatedAt);
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

// ── Cleanup ──────────────────────────────────────────────

export function closeDb(): void {
  for (const [path, db] of _dbs) {
    try { db.close(); } catch { /* ignore */ }
  }
  _dbs.clear();
}
