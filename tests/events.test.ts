/**
 * Unit tests — event channel (pendingEvents, acknowledgeEvent, cleanOldEvents, writeEvent).
 *
 * Uses an in-memory SQLite database injected via __setDbForTest so tests
 * never touch the real ~/.yu/topics.db.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  pendingEvents,
  acknowledgeEvent,
  cleanOldEvents,
  writeEvent,
  __setDbForTest,
} from '../extension/topic.js';

/**
 * Create an in-memory SQLite database with the events table schema
 * matching the one in extension/topic.ts initDb().
 */
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
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

describe('Event channel', () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = createTestDb();
    __setDbForTest(db);
  });

  afterAll(() => {
    // Restore the real DB singleton so other tests aren't affected
    __setDbForTest(null);
    db.close();
  });

  // Reset the events table between tests for clean isolation
  beforeEach(() => {
    db.exec('DELETE FROM events');
  });

  // ── pendingEvents ───────────────────────────────────────

  it('pendingEvents returns empty for non-existent topic', () => {
    const events = pendingEvents('nonexistent-topic');
    expect(events).toEqual([]);
  });

  it('pendingEvents returns only unacknowledged events', () => {
    writeEvent('pending-unack', 'test_event', { msg: 'hello' });
    const events = pendingEvents('pending-unack');
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('test_event');
    expect(events[0].topic_name).toBe('pending-unack');
    // acknowledged field is not included in pendingEvents result
    expect(events[0].id).toBeGreaterThan(0);
  });

  it('pendingEvents excludes acknowledged events', () => {
    writeEvent('exclude-ack', 'will_ack', {});
    const beforeAck = pendingEvents('exclude-ack');
    expect(beforeAck).toHaveLength(1);
    acknowledgeEvent(beforeAck[0].id);
    const afterAck = pendingEvents('exclude-ack');
    expect(afterAck).toHaveLength(0);
  });

  it('pendingEvents returns events for broadcast (topic_name = "")', () => {
    db.prepare(
      `INSERT INTO events (topic_name, event_type, payload) VALUES (?, ?, ?)`
    ).run('', 'broadcast_event', JSON.stringify({ global: true }));
    const events = pendingEvents('some-topic');
    // pendingEvents query: WHERE acknowledged = 0 AND (topic_name = ? OR topic_name = '')
    expect(events.some((e) => e.event_type === 'broadcast_event')).toBe(true);
  });

  // ── acknowledgeEvent ────────────────────────────────────

  it('acknowledgeEvent marks event as acknowledged', () => {
    writeEvent('ack-test', 'ack_me', {});
    const events = pendingEvents('ack-test');
    expect(events).toHaveLength(1);
    acknowledgeEvent(events[0].id);
    const remaining = pendingEvents('ack-test');
    expect(remaining).toEqual([]);
  });

  it('acknowledgeEvent is idempotent', () => {
    writeEvent('idempotent', 'idem_event', { n: 1 });
    const events = pendingEvents('idempotent');
    expect(events).toHaveLength(1);
    const eid = events[0].id;
    acknowledgeEvent(eid);
    acknowledgeEvent(eid); // second call should not throw
    const remaining = pendingEvents('idempotent');
    expect(remaining).toEqual([]);
  });

  // ── cleanOldEvents ──────────────────────────────────────

  it('cleanOldEvents removes events older than maxAgeDays', () => {
    // Insert an event that is 8 days old
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldDateStr = oldDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.prepare(
      `INSERT INTO events (topic_name, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`
    ).run('clean-old', 'old_event', '{}', oldDateStr);

    // Insert a recent event (now)
    const recentDate = new Date();
    const recentDateStr = recentDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.prepare(
      `INSERT INTO events (topic_name, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`
    ).run('clean-old', 'recent_event', '{}', recentDateStr);

    const removed = cleanOldEvents(7);
    expect(removed).toBe(1);

    const remaining = pendingEvents('clean-old');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event_type).toBe('recent_event');
  });

  it('cleanOldEvents with maxAgeDays=0 removes everything', () => {
    // Insert an event from 1 second ago (should be removed with 0-day threshold)
    const oldDate = new Date(Date.now() - 1000);
    const oldDateStr = oldDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.prepare(
      `INSERT INTO events (topic_name, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`
    ).run('clean-all', 'very_recent', '{}', oldDateStr);

    const removed = cleanOldEvents(0);
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it('cleanOldEvents returns 0 when there are no old events', () => {
    // Insert a brand new event
    const now = new Date();
    const nowStr = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.prepare(
      `INSERT INTO events (topic_name, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`
    ).run('clean-fresh', 'fresh_event', '{}', nowStr);

    const removed = cleanOldEvents(7);
    expect(removed).toBe(0);
  });

  // ── writeEvent ──────────────────────────────────────────

  it('writeEvent stores event with correct fields', () => {
    writeEvent('writer-test', 'custom_event', { foo: 'bar', num: 42 });
    const events = pendingEvents('writer-test');
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.topic_name).toBe('writer-test');
    expect(ev.event_type).toBe('custom_event');
    expect(ev.payload).toEqual({ foo: 'bar', num: 42 });
    expect(ev.created_at).toBeTruthy();
    expect(typeof ev.id).toBe('number');
  });

  it('writeEvent with empty payload stores empty object', () => {
    writeEvent('empty-payload', 'no_payload');
    const events = pendingEvents('empty-payload');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({});
  });
});
