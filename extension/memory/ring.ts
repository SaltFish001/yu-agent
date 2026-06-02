/**
 * yu-agent — Ring buffer memory.
 *
 * Auto-saves conversation messages to a capped SQLite ring buffer.
 * When the cap is reached, the oldest entries are evicted.
 * Supports two overflow strategies:
 *   - 'delete_oldest' (default): batch-delete excess oldest rows.
 *   - 'sliding_window':  delete one oldest row before each insert.
 *
 * Schema:
 *   ring_memory(id, platform, role, content, created_at)
 *
 * Default cap: 5000 entries (matching Hermes ring_memory.py)
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { YU_HOME } from '../paths.js';
import type { OverflowStrategy, IMemoryRing, RingEntry, RingStats, RingHealthReport } from '../types.js';

// ── Constants ──────────────────────────────────────────

const DB_PATH = resolve(YU_HOME, 'ring_memory.db');
const DEFAULT_MAX_ENTRIES = 5000;

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

function closeDb(): void {
  try {
    if (_db) {
      _db.close();
      _db = null;
    }
  } catch { /* best-effort */ }
}

/**
 * Default ring buffer max entries.
 * Used by both the standalone functions and the class.
 */
export const RING_DEFAULT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;

// ── Public API (standalone functions) ──────────────────

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
  if (count.c > DEFAULT_MAX_ENTRIES) {
    const excess = count.c - DEFAULT_MAX_ENTRIES;
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
  ).all(like, limit) as unknown as RingEntry[];
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

/**
 * Health check for the ring buffer database.
 * Validates DB connectivity, table schema, and entry integrity.
 */
export function ringHealth(): { ok: boolean; issues: string[]; total: number; dbSize: number } {
  const issues: string[] = [];
  let total = 0;
  let dbSize = 0;

  try {
    const db = getDb();
    // Verify table exists and has correct columns
    const tableInfo = db.prepare('PRAGMA table_info(ring_memory)').all() as Array<{ name: string }>;
    const columns = tableInfo.map(r => r.name);
    const required = ['id', 'platform', 'role', 'content', 'created_at'];
    const missing = required.filter(c => !columns.includes(c));
    if (missing.length > 0) {
      issues.push(`ring_memory table missing columns: ${missing.join(', ')}`);
    }

    total = (db.prepare('SELECT COUNT(*) AS c FROM ring_memory').get() as { c: number }).c;

    // Check for NULL content entries
    const nullCount = (db.prepare("SELECT COUNT(*) AS c FROM ring_memory WHERE content IS NULL OR content = ''").get() as { c: number }).c;
    if (nullCount > 0) {
      issues.push(`${nullCount} entries have empty/null content`);
    }

    // Check for anomalous timestamps
    const futureCount = (db.prepare('SELECT COUNT(*) AS c FROM ring_memory WHERE created_at > ?').get(Date.now() + 60000) as { c: number }).c;
    if (futureCount > 0) {
      issues.push(`${futureCount} entries have future timestamps`);
    }
  } catch (err) {
    issues.push(`ring database error: ${err}`);
  }

  try {
    if (existsSync(DB_PATH)) {
      dbSize = readFileSync(DB_PATH).length;
    }
  } catch { /* best-effort */ }

  const ok = issues.length === 0;
  if (!ok) {
    console.warn('[yu-memory] ringHealth: issues found:', issues.join('; '));
  }

  return { ok, issues, total, dbSize };
}

// ── RingMemory class (implements IMemoryRing) ──────────

/**
 * Class-based ring buffer memory with configurable overflow strategy.
 * Wraps the same underlying SQLite storage.
 *
 * Use this when you need dependency injection or custom config.
 * The standalone functions above use default config.
 */
export class RingMemory implements IMemoryRing {
  readonly maxEntries: number;
  readonly overflowStrategy: OverflowStrategy;

  constructor(options?: { maxEntries?: number; overflowStrategy?: OverflowStrategy }) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.overflowStrategy = options?.overflowStrategy ?? 'delete_oldest';
  }

  append(role: 'user' | 'assistant' | 'system', content: string, platform: string = 'local'): void {
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO ring_memory (platform, role, content, created_at) VALUES (?, ?, ?, ?)',
    ).run(platform, role, content, now);

    const count = db.prepare('SELECT COUNT(*) AS c FROM ring_memory').get() as { c: number };
    if (count.c > this.maxEntries) {
      if (this.overflowStrategy === 'sliding_window') {
        // Delete oldest entry before next insert is triggered
        db.prepare(
          'DELETE FROM ring_memory WHERE id = (SELECT id FROM ring_memory ORDER BY created_at ASC LIMIT 1)',
        ).run();
      } else {
        // Batch delete all excess entries
        const excess = count.c - this.maxEntries;
        db.prepare(
          'DELETE FROM ring_memory WHERE id IN (SELECT id FROM ring_memory ORDER BY created_at ASC LIMIT ?)',
        ).run(excess);
      }
    }
  }

  recent(n: number = 20, platform?: string): RingEntry[] {
    const db = getDb();
    if (platform) {
      return db.prepare(
        'SELECT * FROM ring_memory WHERE platform = ? ORDER BY created_at DESC LIMIT ?',
      ).all(platform, n) as unknown as RingEntry[];
    }
    return db.prepare(
      'SELECT * FROM ring_memory ORDER BY created_at DESC LIMIT ?',
    ).all(n) as unknown as RingEntry[];
  }

  search(keyword: string, limit: number = 10): RingEntry[] {
    const db = getDb();
    const like = `%${keyword}%`;
    return db.prepare(
      'SELECT * FROM ring_memory WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?',
    ).all(like, limit) as unknown as RingEntry[];
  }

  stats(): RingStats {
    return ringStats();
  }

  health(): RingHealthReport {
    return ringHealth();
  }

  /** Close the database connection (for clean shutdown). */
  close(): void {
    closeDb();
  }
}
