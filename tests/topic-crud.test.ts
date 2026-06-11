/**
 * Unit tests — Topic CRUD operations (create, get, list, setStatus, archive, rename, etc.)
 *
 * Uses the __setDbForTest() test hook to inject an in-memory SQLite database
 * so tests never touch the real ~/.yu/topics.db.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/**
 * Create an in-memory SQLite database with the full topic schema
 * matching extension/topic.ts initDb().
 */
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
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
  // Add supervisor columns (P2-10)
  try { db.exec('ALTER TABLE topics ADD COLUMN pid INTEGER'); } catch { /* ignore */ }
  try { db.exec('ALTER TABLE topics ADD COLUMN cmd TEXT DEFAULT ""'); } catch { /* ignore */ }
  try { db.exec('ALTER TABLE topics ADD COLUMN started_at TEXT'); } catch { /* ignore */ }

  // Events table (needed by setStatus event writes and writeEvent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_name    TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      payload       TEXT DEFAULT '{}',
      pid           INTEGER,
      parent_pid    INTEGER,
      seq           INTEGER,
      acknowledged  INTEGER DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_topic_created ON events(topic_name, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)');
  return db;
}

describe('Topic CRUD', () => {
  let db: DatabaseSync;

  beforeAll(async () => {
    db = createTestDb();
    const { __setDbForTest } = await import('../extension/topic.js');
    __setDbForTest(db);
  });

  afterAll(async () => {
    const { __setDbForTest } = await import('../extension/topic.js');
    __setDbForTest(null);
    db.close();
  });

  // Reset tables between tests for clean isolation
  beforeEach(() => {
    db.exec('DELETE FROM topics');
    db.exec('DELETE FROM events');
  });

  // ── create ──────────────────────────────────────────────

  it('create returns a topic with correct default values', async () => {
    const { create } = await import('../extension/topic.js');
    const topic = create('test-topic', '/tmp/test-dir');
    expect(topic.name).toBe('test-topic');
    expect(topic.dir).toBe('/tmp/test-dir');
    expect(topic.status).toBe('idle');
    expect(topic.turns).toBe(0);
    expect(topic.summary).toBe('');
    expect(topic.archived).toBe(0);
    expect(topic.lastActive).toBeNull();
    expect(topic.createdAt).toBeTruthy();
    expect(topic.id).toBeTruthy();
  });

  it('create throws when topic with same name already exists', async () => {
    const { create } = await import('../extension/topic.js');
    create('duplicate-topic', '/tmp/one');
    expect(() => create('duplicate-topic', '/tmp/two')).toThrow('already exists');
  });

  // ── get ─────────────────────────────────────────────────

  it('get returns undefined for non-existent topic', async () => {
    const { get } = await import('../extension/topic.js');
    const topic = get('does-not-exist');
    expect(topic).toBeUndefined();
  });

  it('get returns topic by name (case-insensitive)', async () => {
    const { create, get } = await import('../extension/topic.js');
    create('CaseTest', '/tmp/test');
    const topic = get('casetest');
    expect(topic).toBeDefined();
    expect(topic!.name).toBe('CaseTest');
  });

  // ── list ────────────────────────────────────────────────

  it('list returns all non-archived topics by default', async () => {
    const { create, list } = await import('../extension/topic.js');
    create('topic-a', '/tmp/a');
    create('topic-b', '/tmp/b');
    create('topic-c', '/tmp/c');
    const all = list();
    expect(all).toHaveLength(3);
    const names = all.map(t => t.name).sort();
    expect(names).toEqual(['topic-a', 'topic-b', 'topic-c']);
  });

  // ── setStatus ───────────────────────────────────────────

  it('setStatus updates topic status', async () => {
    const { create, get, setStatus } = await import('../extension/topic.js');
    create('status-test', '/tmp/test');
    setStatus('status-test', 'active');
    const topic = get('status-test');
    expect(topic!.status).toBe('active');
  });

  it('setStatus throws on invalid status value', async () => {
    const { create, setStatus } = await import('../extension/topic.js');
    create('invalid-status', '/tmp/test');
    expect(() => setStatus('invalid-status', 'bogus_status')).toThrow('Invalid status');
  });

  it('setStatus throws for non-existent topic', async () => {
    const { setStatus } = await import('../extension/topic.js');
    expect(() => setStatus('nobody', 'active')).toThrow('not found');
  });

  // ── archive ─────────────────────────────────────────────

  it('archive soft-deletes a topic', async () => {
    const { create, get, list, archive } = await import('../extension/topic.js');
    create('archivable', '/tmp/test');
    expect(list().some(t => t.name === 'archivable')).toBe(true);
    archive('archivable');
    // Archived topics are excluded from default list
    expect(list().some(t => t.name === 'archivable')).toBe(false);
    // But included when archived=true
    const all = list(true);
    expect(all.some(t => t.name === 'archivable')).toBe(true);
    expect(all.find(t => t.name === 'archivable')!.archived).toBe(1);
  });

  // ── rename ──────────────────────────────────────────────

  it('rename changes topic name', async () => {
    const { create, get, rename } = await import('../extension/topic.js');
    create('old-name', '/tmp/test');
    rename('old-name', 'new-name');
    expect(get('old-name')).toBeUndefined();
    const renamed = get('new-name');
    expect(renamed).toBeDefined();
    expect(renamed!.name).toBe('new-name');
  });

  it('rename throws for non-existent topic', async () => {
    const { rename } = await import('../extension/topic.js');
    expect(() => rename('ghost', 'new-name')).toThrow('not found');
  });

  // ── setSummary ──────────────────────────────────────────

  it('setSummary updates topic summary', async () => {
    const { create, get, setSummary } = await import('../extension/topic.js');
    create('summary-test', '/tmp/test');
    setSummary('summary-test', 'This is a test summary');
    const topic = get('summary-test');
    expect(topic!.summary).toBe('This is a test summary');
  });

  // ── incrementTurns ──────────────────────────────────────

  it('incrementTurns increases turn count by 1', async () => {
    const { create, get, incrementTurns } = await import('../extension/topic.js');
    create('turns-test', '/tmp/test');
    expect(get('turns-test')!.turns).toBe(0);
    incrementTurns('turns-test');
    expect(get('turns-test')!.turns).toBe(1);
    incrementTurns('turns-test');
    incrementTurns('turns-test');
    expect(get('turns-test')!.turns).toBe(3);
  });

  // ── getActive ───────────────────────────────────────────

  it('getActive returns the active topic', async () => {
    const { create, getActive, setStatus } = await import('../extension/topic.js');
    create('inactive-1', '/tmp/a');
    create('the-active', '/tmp/b');
    create('inactive-2', '/tmp/c');
    // Initially no active topic
    expect(getActive()).toBeUndefined();
    // Set one topic to active
    setStatus('the-active', 'active');
    const active = getActive();
    expect(active).toBeDefined();
    expect(active!.name).toBe('the-active');
    expect(active!.status).toBe('active');
  });
});
