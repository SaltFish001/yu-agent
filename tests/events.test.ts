/**
 * Unit tests — event channel (pendingEvents, acknowledgeEvent, cleanOldEvents, writeEvent).
 *
 * Uses an in-memory SQLite database injected via __setDbForTest so tests
 * never touch the real ~/.yu/topics.db.
 */

import { Database as DatabaseSync } from 'bun:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { __setDbForTest, acknowledgeEvent, cleanOldEvents, pendingEvents, writeEvent } from '../extension/topic.js'

/**
 * Create an in-memory SQLite database with the events table schema
 * matching the one in extension/topic.ts initDb().
 */
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
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
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_topic_created ON events(topic_name, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)')
  return db
}

describe('Event channel', () => {
  let db: DatabaseSync

  beforeAll(() => {
    db = createTestDb()
    __setDbForTest(db)
  })

  afterAll(() => {
    // Restore the real DB singleton so other tests aren't affected
    __setDbForTest(null)
    db.close()
  })

  // Reset the events table between tests for clean isolation
  beforeEach(() => {
    db.exec('DELETE FROM events')
  })

  // ── pendingEvents ───────────────────────────────────────

  it('pendingEvents returns empty for non-existent topic', () => {
    const events = pendingEvents('nonexistent-topic')
    expect(events).toEqual([])
  })

  it('pendingEvents returns only unacknowledged events', () => {
    writeEvent('pending-unack', 'test_event', { msg: 'hello' })
    const events = pendingEvents('pending-unack')
    expect(events).toHaveLength(1)
    expect(events[0].event_type).toBe('test_event')
    expect(events[0].topic_name).toBe('pending-unack')
    // acknowledged field is not included in pendingEvents result
    expect(events[0].id).toBeGreaterThan(0)
  })

  it('pendingEvents excludes acknowledged events', () => {
    writeEvent('exclude-ack', 'will_ack', {})
    const beforeAck = pendingEvents('exclude-ack')
    expect(beforeAck).toHaveLength(1)
    acknowledgeEvent(beforeAck[0].id)
    const afterAck = pendingEvents('exclude-ack')
    expect(afterAck).toHaveLength(0)
  })

  it('pendingEvents returns events for broadcast (topic_name = "")', () => {
    db.prepare(`INSERT INTO events (topic_name, event_type, payload) VALUES (?, ?, ?)`).run(
      '',
      'broadcast_event',
      JSON.stringify({ global: true }),
    )
    const events = pendingEvents('some-topic')
    // pendingEvents query: WHERE acknowledged = 0 AND (topic_name = ? OR topic_name = '')
    expect(events.some((e) => e.event_type === 'broadcast_event')).toBe(true)
  })

  // ── acknowledgeEvent ────────────────────────────────────

  it('acknowledgeEvent marks event as acknowledged', () => {
    writeEvent('ack-test', 'ack_me', {})
    const events = pendingEvents('ack-test')
    expect(events).toHaveLength(1)
    acknowledgeEvent(events[0].id)
    const remaining = pendingEvents('ack-test')
    expect(remaining).toEqual([])
  })

  it('acknowledgeEvent is idempotent', () => {
    writeEvent('idempotent', 'idem_event', { n: 1 })
    const events = pendingEvents('idempotent')
    expect(events).toHaveLength(1)
    const eid = events[0].id
    acknowledgeEvent(eid)
    acknowledgeEvent(eid) // second call should not throw
    const remaining = pendingEvents('idempotent')
    expect(remaining).toEqual([])
  })

  // ── cleanOldEvents ──────────────────────────────────────

  it('cleanOldEvents removes events older than maxAgeDays', () => {
    // Insert an event that is 8 days old
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    const oldDateStr = oldDate
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
    db.prepare(
      `INSERT INTO events (topic_name, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('clean-old', 'old_event', '{}', oldDateStr)

    // Insert a recent event (now)
    const recentDate = new Date()
    const recentDateStr = recentDate
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
    db.prepare(
      `INSERT INTO events (topic_name, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('clean-old', 'recent_event', '{}', recentDateStr)

    const removed = cleanOldEvents(7)
    expect(removed).toBe(1)

    const remaining = pendingEvents('clean-old')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].event_type).toBe('recent_event')
  })

  it('cleanOldEvents with maxAgeDays=0 removes everything', () => {
    // Insert an event from 1 second ago (should be removed with 0-day threshold)
    const oldDate = new Date(Date.now() - 1000)
    const oldDateStr = oldDate
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
    db.prepare(
      `INSERT INTO events (topic_name, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('clean-all', 'very_recent', '{}', oldDateStr)

    const removed = cleanOldEvents(0)
    expect(removed).toBeGreaterThanOrEqual(1)
  })

  it('cleanOldEvents returns 0 when there are no old events', () => {
    // Insert a brand new event
    const now = new Date()
    const nowStr = now
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
    db.prepare(
      `INSERT INTO events (topic_name, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('clean-fresh', 'fresh_event', '{}', nowStr)

    const removed = cleanOldEvents(7)
    expect(removed).toBe(0)
  })

  // ── writeEvent ──────────────────────────────────────────

  it('writeEvent stores event with correct fields', () => {
    writeEvent('writer-test', 'custom_event', { foo: 'bar', num: 42 })
    const events = pendingEvents('writer-test')
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.topic_name).toBe('writer-test')
    expect(ev.event_type).toBe('custom_event')
    expect(ev.payload).toEqual({ foo: 'bar', num: 42 })
    expect(ev.created_at).toBeTruthy()
    expect(typeof ev.id).toBe('number')
  })

  it('writeEvent with empty payload stores empty object', () => {
    writeEvent('empty-payload', 'no_payload')
    const events = pendingEvents('empty-payload')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({})
  })

  // ── Event ordering ─────────────────────────────────────

  it('events are returned in chronological order (oldest first)', () => {
    writeEvent('order-test', 'event_a', { seq: 1 })
    writeEvent('order-test', 'event_b', { seq: 2 })
    writeEvent('order-test', 'event_c', { seq: 3 })

    const events = pendingEvents('order-test')
    expect(events).toHaveLength(3)

    // Verify chronological order by created_at
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(events[i - 1].created_at).getTime(),
      )
    }
    // Verify event types are in insertion order
    expect(events[0].event_type).toBe('event_a')
    expect(events[1].event_type).toBe('event_b')
    expect(events[2].event_type).toBe('event_c')
  })

  // ── Payload edge cases ─────────────────────────────────

  it('handles payload with special characters and unicode', () => {
    writeEvent('special-chars', 'unicode_event', {
      message: 'Hello 世界!',
      code: '<script>alert("xss")</script>',
      path: '/foo/bar/baz',
    })
    const events = pendingEvents('special-chars')
    expect(events).toHaveLength(1)
    expect(events[0].payload.message).toBe('Hello 世界!')
    expect(events[0].payload.code).toBe('<script>alert("xss")</script>')
    expect(events[0].payload.path).toBe('/foo/bar/baz')
  })

  // ── Multiple topic isolation ────────────────────────────

  it('events for different topics are isolated', () => {
    writeEvent('topic-alpha', 'alpha_event', { data: 1 })
    writeEvent('topic-beta', 'beta_event', { data: 2 })
    writeEvent('topic-alpha', 'alpha_event_2', { data: 3 })

    const alphaEvents = pendingEvents('topic-alpha')
    const betaEvents = pendingEvents('topic-beta')

    expect(alphaEvents).toHaveLength(2)
    expect(betaEvents).toHaveLength(1)

    expect(alphaEvents.every((e) => e.topic_name === 'topic-alpha')).toBe(true)
    expect(betaEvents.every((e) => e.topic_name === 'topic-beta')).toBe(true)

    expect(alphaEvents[0].payload.data).toBe(1)
    expect(alphaEvents[1].payload.data).toBe(3)
    expect(betaEvents[0].payload.data).toBe(2)
  })

  // ── pid/parent_pid/seq fields ───────────────────────────

  it('writeEvent stores pid, parent_pid, and seq from payload', () => {
    writeEvent('pid-test', 'child_spawned', {
      pid: 12345,
      parent_pid: 9876,
      seq: 42,
      custom: 'data',
    })

    // Verify via pendingEvents — payload includes pid/parent_pid/seq
    const events = pendingEvents('pid-test')
    expect(events).toHaveLength(1)
    expect(events[0].payload.pid).toBe(12345)
    expect(events[0].payload.parent_pid).toBe(9876)
    expect(events[0].payload.seq).toBe(42)
    expect(events[0].payload.custom).toBe('data')
  })

  // ── Multiple event types for same topic ─────────────────

  it('handles multiple event types for the same topic', () => {
    writeEvent('multi-type', 'child_spawned', {})
    writeEvent('multi-type', 'child_task_done', { status: 'ok' })
    writeEvent('multi-type', 'child_crashed', { reason: 'timeout' })

    const events = pendingEvents('multi-type')
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.event_type)).toEqual(['child_spawned', 'child_task_done', 'child_crashed'])
  })
})
