/**
 * Unit tests — topic.ts (topic management)
 *
 * Tests topic CRUD, event channel, and status management.
 * Uses __setDbForTest to inject an in-memory SQLite database for isolation.
 */

import { Database as DatabaseSync } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

// ── Test helpers ──────────────────────────────────────────

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA journal_mode=WAL')
  return db
}

// ── Tests ─────────────────────────────────────────────────

describe('Topic CRUD', () => {
  let db: DatabaseSync
  let topicModule: typeof import('../extension/topic.js')

  beforeEach(async () => {
    db = createTestDb()
    topicModule = await import('../extension/topic.js')
    topicModule.__setDbForTest(db)
    topicModule.initDb(db)
  })

  afterEach(() => {
    topicModule.__setDbForTest(null)
    db.close()
  })

  it('creates a topic with correct default values', () => {
    const topic = topicModule.create('test-topic', '/tmp')
    expect(topic.name).toBe('test-topic')
    expect(topic.dir).toBe('/tmp')
    expect(topic.status).toBe('idle')
    expect(topic.turns).toBe(0)
    expect(topic.archived).toBe(0)
  })

  it('lists all non-archived topics by default', () => {
    topicModule.create('topic-a', '/tmp/a')
    topicModule.create('topic-b', '/tmp/b')
    const topics = topicModule.list()
    expect(topics.length).toBe(2)
    expect(topics.map((t) => t.name).sort()).toEqual(['topic-a', 'topic-b'])
  })

  it('get returns a topic by name (case-insensitive)', () => {
    topicModule.create('MyTopic', '/tmp')
    const found = topicModule.get('mytopic')
    expect(found).toBeDefined()
    expect(found!.name).toBe('MyTopic')
  })

  it('get returns undefined for non-existent topic', () => {
    const result = topicModule.get('nonexistent')
    expect(result).toBeUndefined()
  })

  it('create throws when topic with same name already exists', () => {
    topicModule.create('dup', '/tmp')
    expect(() => topicModule.create('dup', '/other')).toThrow()
  })

  it('archive soft-deletes a topic', () => {
    topicModule.create('archivable', '/tmp')
    topicModule.archive('archivable')
    const defaultList = topicModule.list()
    expect(defaultList.find((t) => t.name === 'archivable')).toBeUndefined()
    const allList = topicModule.list(true)
    expect(allList.find((t) => t.name === 'archivable' && t.archived === 1)).toBeDefined()
  })

  it('rename changes topic name', () => {
    topicModule.create('old-name', '/tmp')
    topicModule.rename('old-name', 'new-name')
    expect(topicModule.get('new-name')).toBeDefined()
    expect(topicModule.get('old-name')).toBeUndefined()
  })

  it('rename throws for non-existent topic', () => {
    expect(() => topicModule.rename('nope', 'newname')).toThrow()
  })

  it('setSummary updates topic summary', () => {
    topicModule.create('summarizable', '/tmp')
    topicModule.setSummary('summarizable', 'this is a test summary')
    const topic = topicModule.get('summarizable')
    expect(topic!.summary).toBe('this is a test summary')
  })

  it('setStatus updates topic status', () => {
    topicModule.create('status-test', '/tmp')
    topicModule.setStatus('status-test', 'background')
    const topic = topicModule.get('status-test')
    expect(topic!.status).toBe('background')
  })

  it('setStatus throws on invalid status value', () => {
    topicModule.create('bad-status', '/tmp')
    expect(() => topicModule.setStatus('bad-status', 'invalid_status')).toThrow()
  })

  it('setStatus throws for non-existent topic', () => {
    expect(() => topicModule.setStatus('absent', 'idle')).toThrow()
  })

  it('incrementTurns increases turn count by 1', () => {
    topicModule.create('counter', '/tmp')
    const t1 = topicModule.get('counter')!
    expect(t1.turns).toBe(0)
    topicModule.incrementTurns('counter')
    const t2 = topicModule.get('counter')!
    expect(t2.turns).toBe(1)
    topicModule.incrementTurns('counter')
    const t3 = topicModule.get('counter')!
    expect(t3.turns).toBe(2)
  })

  it('getActive returns the active topic (status = active)', () => {
    topicModule.create('no-activity', '/tmp/a')
    topicModule.create('active-one', '/tmp/b')
    topicModule.setStatus('active-one', 'active')
    const active = topicModule.getActive()
    expect(active).toBeDefined()
    expect(active!.name).toBe('active-one')
  })
})

describe('Topic event channel', () => {
  let db: DatabaseSync
  let topicModule: typeof import('../extension/topic.js')

  beforeEach(async () => {
    db = createTestDb()
    topicModule = await import('../extension/topic.js')
    topicModule.__setDbForTest(db)
    topicModule.initDb(db)
  })

  afterEach(() => {
    topicModule.__setDbForTest(null)
    db.close()
  })

  it('writeEvent stores event with correct fields', () => {
    topicModule.writeEvent('test-topic', 'user_message', { content: 'hello' })
    const events = topicModule.pendingEvents('test-topic')
    expect(events.length).toBe(1)
    expect(events[0].topic_name).toBe('test-topic')
    expect(events[0].event_type).toBe('user_message')
    expect(events[0].payload).toEqual({ content: 'hello' })
  })

  it('writeEvent with empty payload stores empty object', () => {
    topicModule.writeEvent('test-topic', 'ping', {})
    const events = topicModule.pendingEvents('test-topic')
    expect(events.length).toBe(1)
    expect(events[0].payload).toEqual({})
  })

  it('pendingEvents returns only unacknowledged events', () => {
    topicModule.writeEvent('t', 'e1', {})
    topicModule.writeEvent('t', 'e2', {})
    let events = topicModule.pendingEvents('t')
    expect(events.length).toBe(2)

    topicModule.acknowledgeEvent(events[0].id)
    events = topicModule.pendingEvents('t')
    expect(events.length).toBe(1)
    expect(events[0].event_type).toBe('e2')
  })

  it('pendingEvents returns empty for non-existent topic', () => {
    const events = topicModule.pendingEvents('no-such-topic')
    expect(events).toEqual([])
  })

  it('events are returned in chronological order (oldest first)', () => {
    topicModule.writeEvent('t', 'first', { seq: 1 })
    topicModule.writeEvent('t', 'second', { seq: 2 })
    topicModule.writeEvent('t', 'third', { seq: 3 })

    const events = topicModule.pendingEvents('t')
    expect(events[0].event_type).toBe('first')
    expect(events[1].event_type).toBe('second')
    expect(events[2].event_type).toBe('third')
  })

  it('acknowledgeEvent is idempotent', () => {
    topicModule.writeEvent('t', 'e', {})
    const events = topicModule.pendingEvents('t')
    const id = events[0].id

    topicModule.acknowledgeEvent(id)
    topicModule.acknowledgeEvent(id) // second call should not throw
    const remaining = topicModule.pendingEvents('t')
    expect(remaining.length).toBe(0)
  })

  it('cleanOldEvents removes events with negative maxAgeDays (delete all)', () => {
    topicModule.writeEvent('t', 'fresh', {})
    const removed = topicModule.cleanOldEvents(-1)
    expect(removed).toBe(1)
    const remaining = topicModule.pendingEvents('t')
    expect(remaining.length).toBe(0)
  })

  it('cleanOldEvents returns 0 when there are no old events', () => {
    topicModule.writeEvent('t', 'fresh', {})
    const removed = topicModule.cleanOldEvents(7)
    expect(removed).toBe(0)
  })

  it('handles special characters and unicode in payload', () => {
    topicModule.writeEvent('t', 'test', {
      message: '你好世界🚀',
      html: '<tag>value</tag>',
    })
    const events = topicModule.pendingEvents('t')
    expect(events[0].payload.message).toBe('你好世界🚀')
    expect(events[0].payload.html).toBe('<tag>value</tag>')
  })
})

describe('Topic initDb', () => {
  it('initializes schema when given an in-memory database', async () => {
    const db = createTestDb()
    const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string
    }>
    expect(tablesBefore.length).toBe(0)

    const topicModule = await import('../extension/topic.js')
    topicModule.__setDbForTest(db)
    topicModule.initDb(db)

    const tablesAfter = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    const tableNames = tablesAfter.map((t) => t.name)
    expect(tableNames).toContain('topics')
    expect(tableNames).toContain('events')

    topicModule.__setDbForTest(null)
    db.close()
  })
})
