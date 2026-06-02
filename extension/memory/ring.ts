/**
 * yu-agent — Ring buffer memory.
 *
 * Auto-saves conversation messages to a capped SQLite ring buffer.
 * When the cap is reached, the oldest entries are evicted.
 *
 * Schema:
 *   ring_memory(id, platform, role, content, created_at)
 *
 * Cap: 5000 entries (matching Hermes ring_memory.py)
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { YU_HOME } from '../paths.js';

// ── Constants ──────────────────────────────────────────

const DB_PATH = resolve(YU_HOME, 'ring_memory.db');
const MAX_ENTRIES = 5000;

// ── DB init (lazy singleton) ───────────────────────────

let _db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!_db) {
    if (!existsSync(YU_HOME)) mkdirSync(YU_HOME, { recursive: true });
    _db = new DatabaseSync(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS ring_memory (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        platform  TEXT    NOT NULL DEFAULT 'local',
        role      TEXT    NOT NULL,
        content   TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ring_created
        ON ring_memory(created_at);
    `);
  }
  return _db;
}

// ── Public API ─────────────────────────────────────────

/**
 * Append a message to the ring buffer.
 * Auto-evicts oldest entries when cap is reached.
 */
export function ringAppend(
  role: 'user' | 'assistant' | 'system',
  content: string,
  platform: string = 'local',
): void {
  const db = getDb();
  const now = Date.now();

  db.prepare(
    'INSERT INTO ring_memory (platform, role, content, created_at) VALUES (?, ?, ?, ?)',
  ).run(platform, role, content, now);

  // Evict oldest if over cap
  const count = db.prepare('SELECT COUNT(*) AS c FROM ring_memory').get() as { c: number };
  if (count.c > MAX_ENTRIES) {
    const excess = count.c - MAX_ENTRIES;
    db.prepare(
      'DELETE FROM ring_memory WHERE id IN (SELECT id FROM ring_memory ORDER BY created_at ASC LIMIT ?)',
    ).run(excess);
  }
}

/**
 * Query recent messages from the ring buffer.
 * Supports optional platform filter.
 */
export function ringRecent(
  n: number = 20,
  platform?: string,
): Array<{ id: number; platform: string; role: string; content: string; created_at: number }> {
  const db = getDb();

  if (platform) {
    return db.prepare(
      'SELECT * FROM ring_memory WHERE platform = ? ORDER BY created_at DESC LIMIT ?',
    ).all(platform, n) as Array<{ id: number; platform: string; role: string; content: string; created_at: number }>;
  } else {
    return db.prepare(
      'SELECT * FROM ring_memory ORDER BY created_at DESC LIMIT ?',
    ).all(n) as Array<{ id: number; platform: string; role: string; content: string; created_at: number }>;
  }
}

/**
 * Search ring buffer by keyword.
 */
export function ringSearch(
  keyword: string,
  limit: number = 10,
): Array<{ id: number; platform: string; role: string; content: string; created_at: number }> {
  const db = getDb();
  const like = `%${keyword}%`;
  return db.prepare(
    'SELECT * FROM ring_memory WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?',
  ).all(like, limit) as any[];
}

/**
 * Get ring buffer stats.
 */
export function ringStats(): { total: number; by_platform: Record<string, number> } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS c FROM ring_memory').get() as { c: number }).c;

  const rows = db.prepare('SELECT platform, COUNT(*) AS c FROM ring_memory GROUP BY platform').all() as Array<{ platform: string; c: number }>;
  const by_platform: Record<string, number> = {};
  for (const r of rows) by_platform[r.platform] = r.c;

  return { total, by_platform };
}
