/**
 * Unit tests — db.ts (SQLite session storage)
 *
 * Tests the most critical CRUD operations: sessions, messages, cache.
 * Uses the real SQLite database (getDb() singleton) with afterEach cleanup.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { getDb } from '../extension/db.js'

// Test tag prefix to scope test data for easy cleanup
const T = 'test-db-'

describe('Session CRUD', () => {
  const testTag = `${T}sess-${Date.now()}`

  afterEach(() => {
    const db = getDb()
    db.prepare('DELETE FROM sessions WHERE tag LIKE ?').run(`${T}%`)
  })

  it('creates and reads a session', async () => {
    const { upsertSession, getSessionMeta } = await import('../extension/db.js')
    const _now = Date.now()
    upsertSession(testTag, {
      name: 'test session',
      cwd: '/tmp',
      agent: 'coding',
      model: 'v4-flash',
    })

    const meta = getSessionMeta(testTag)
    expect(meta).not.toBeNull()
    expect(meta!.tag).toBe(testTag)
    expect(meta!.name).toBe('test session')
    expect(meta!.agent).toBe('coding')
  })

  it('lists sessions including the test session', async () => {
    const { upsertSession, listSessions } = await import('../extension/db.js')
    upsertSession(testTag, {
      name: 'listable session',
      agent: 'review',
    })

    const allSessions = listSessions()
    const found = allSessions.find((s) => s.tag === testTag)
    expect(found).toBeDefined()
    expect(found!.name).toBe('listable session')
  })

  it('updates an existing session', async () => {
    const { upsertSession, getSessionMeta } = await import('../extension/db.js')
    upsertSession(testTag, { name: 'original name' })
    upsertSession(testTag, { name: 'updated name' })

    const meta = getSessionMeta(testTag)
    expect(meta!.name).toBe('updated name')
  })

  it('deletes a session', async () => {
    const { upsertSession, deleteSession, getSessionMeta } = await import('../extension/db.js')
    upsertSession(testTag, { name: 'to delete' })
    expect(getSessionMeta(testTag)).not.toBeNull()

    deleteSession(testTag)
    expect(getSessionMeta(testTag)).toBeNull()
  })

  it('returns null for non-existent session', async () => {
    const { getSessionMeta } = await import('../extension/db.js')
    const meta = getSessionMeta('nonexistent-tag-12345')
    expect(meta).toBeNull()
  })

  it('handles empty strings in session metadata', async () => {
    const { upsertSession, getSessionMeta } = await import('../extension/db.js')
    upsertSession(testTag, { name: '', agent: '', model: '' })

    const meta = getSessionMeta(testTag)
    expect(meta).not.toBeNull()
    expect(meta!.name).toBe('')
  })
})

describe('Message operations', () => {
  const testSessionId = `${T}msg-${Date.now()}`

  afterEach(() => {
    const db = getDb()
    db.prepare('DELETE FROM messages WHERE session_id LIKE ?').run(`${T}%`)
    db.prepare('DELETE FROM sessions WHERE tag LIKE ?').run(`${T}%`)
  })

  it('inserts and retrieves messages', async () => {
    const { insertMessage, getMessages, upsertSession } = await import('../extension/db.js')
    // Session must exist first (FK constraint)
    upsertSession(testSessionId, { name: 'msg test' })

    insertMessage(testSessionId, 'user', 'hello')
    insertMessage(testSessionId, 'assistant', 'hi there')

    const msgs = getMessages(testSessionId)
    expect(msgs.length).toBe(2)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('hello')
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].content).toBe('hi there')
  })

  it('returns messages in chronological order', async () => {
    const { insertMessage, getMessages, upsertSession } = await import('../extension/db.js')
    upsertSession(testSessionId, { name: 'order test' })

    insertMessage(testSessionId, 'user', 'first')
    insertMessage(testSessionId, 'assistant', 'second')
    insertMessage(testSessionId, 'user', 'third')

    const msgs = getMessages(testSessionId)
    expect(msgs[0].content).toBe('first')
    expect(msgs[1].content).toBe('second')
    expect(msgs[2].content).toBe('third')
  })

  it('limits messages count when limit parameter is provided', async () => {
    const { insertMessage, getMessages, upsertSession } = await import('../extension/db.js')
    upsertSession(testSessionId, { name: 'limit test' })

    for (let i = 0; i < 5; i++) {
      insertMessage(testSessionId, 'user', `msg-${i}`)
    }

    const limited = getMessages(testSessionId, 3)
    expect(limited.length).toBe(3)
  })

  it('counts messages correctly', async () => {
    const { insertMessage, getMessageCount, upsertSession } = await import('../extension/db.js')
    upsertSession(testSessionId, { name: 'count test' })

    for (let i = 0; i < 4; i++) {
      insertMessage(testSessionId, 'user', `m-${i}`)
    }

    const count = getMessageCount(testSessionId)
    expect(count).toBe(4)
  })

  it('returns 0 count for session with no messages', async () => {
    const { getMessageCount, upsertSession } = await import('../extension/db.js')
    upsertSession(testSessionId, { name: 'empty test' })

    const count = getMessageCount(testSessionId)
    expect(count).toBe(0)
  })
})

describe('Cache operations', () => {
  const testTag = `${T}cache-${Date.now()}`

  afterEach(() => {
    const db = getDb()
    db.prepare('DELETE FROM cache WHERE tag LIKE ?').run(`${T}%`)
  })

  it('creates and reads cache entry', async () => {
    const { upsertCache, getCache } = await import('../extension/db.js')
    upsertCache(testTag, {
      totalHits: 10,
      totalMisses: 5,
      totalOutput: 1000,
      totalCost: 0.05,
      turnCount: 3,
    })

    const cache = getCache(testTag)
    expect(cache).not.toBeNull()
    expect(cache!.totalHits).toBe(10)
    expect(cache!.totalMisses).toBe(5)
    expect(cache!.turnCount).toBe(3)
  })

  it('updates existing cache entry', async () => {
    const { upsertCache, getCache } = await import('../extension/db.js')
    upsertCache(testTag, { totalHits: 1, turnCount: 1 })
    upsertCache(testTag, { totalHits: 5, turnCount: 3 })

    const cache = getCache(testTag)
    expect(cache!.totalHits).toBe(5)
    expect(cache!.turnCount).toBe(3)
  })

  it('returns null for non-existent cache tag', async () => {
    const { getCache } = await import('../extension/db.js')
    const cache = getCache('nonexistent-cache-key')
    expect(cache).toBeNull()
  })

  it('stores and retrieves hitRate correctly', async () => {
    const { upsertCache, getCache } = await import('../extension/db.js')
    upsertCache(testTag, {
      totalHits: 80,
      totalMisses: 20,
      hitRate: 0.8,
    })

    const cache = getCache(testTag)
    expect(Math.abs(cache!.hitRate - 0.8)).toBeLessThan(0.01)
  })
})

describe('DB module health', () => {
  it('getDbPath returns a valid path string', async () => {
    const { getDbPath } = await import('../extension/db.js')
    const path = getDbPath()
    expect(typeof path).toBe('string')
    expect(path.length).toBeGreaterThan(0)
    expect(path.endsWith('sessions.db')).toBe(true)
  })

  it('getDb returns a working database instance', () => {
    const db = getDb()
    expect(db).toBeDefined()
    // Run a simple query to verify
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number }
    expect(row.ok).toBe(1)
  })

  it('getStatusDirPath returns a non-empty string', async () => {
    const { getStatusDirPath } = await import('../extension/db.js')
    const dir = getStatusDirPath()
    expect(typeof dir).toBe('string')
    expect(dir.length).toBeGreaterThan(0)
  })
})
