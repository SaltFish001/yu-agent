/**
 * Integration tests — agent tracker DB persistence.
 *
 * Tests that trackAgent() correctly writes to and updates the agent_runs
 * table in the SQLite database.
 *
 * API reference (tracker.ts):
 *   trackAgent(id: string, status: AgentStatus['status'], extra?: Record<string, unknown>)
 *   - extra.type    — agent type string
 *   - extra.model   — model string
 *   - extra.goal    — goal string
 *   - extra.files   — string array
 *   - extra.error   — error string
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { getDb } from '../../extension/db.js'
import { resetTracker, trackAgent } from '../../extension/tracker.js'

describe('Agent tracking', () => {
  const createdIds: string[] = []

  beforeEach(() => {
    // Ensure the DB schema is initialized (getDb() creates tables)
    getDb()
    // Reset in-memory tracker state
    resetTracker()
  })

  afterEach(() => {
    // Scoped cleanup: delete only rows created during this test
    const db = getDb()
    for (const id of createdIds) {
      db.prepare('DELETE FROM agent_runs WHERE agent_id = ?').run(id)
    }
    createdIds.length = 0
  })

  it('writes running status to agent_runs', () => {
    const id = 'test-1'
    createdIds.push(id)
    trackAgent(id, 'running', {
      type: 'coding',
      model: 'v4-flash',
      goal: 'fix bug',
    })

    const db = getDb()
    const row = db.prepare('SELECT * FROM agent_runs WHERE agent_id = ?').get('test-1') as
      | Record<string, unknown>
      | undefined

    expect(row).toBeTruthy()
    expect(row!.status).toBe('running')
    expect(row!.agent_id).toBe('test-1')
    expect(row!.agent_type).toBe('coding')
    expect(row!.model).toBe('v4-flash')
    // started_at should be set
    expect(row!.started_at).toBeGreaterThan(0)
  })

  it('transitions from running to completed', () => {
    const id = 'test-2'
    createdIds.push(id)
    trackAgent(id, 'running', {
      type: 'coding',
      model: 'v4-flash',
      goal: 'test transition',
    })
    trackAgent(id, 'completed', {
      type: 'coding',
      model: 'v4-flash',
    })

    const db = getDb()
    const row = db.prepare('SELECT * FROM agent_runs WHERE agent_id = ?').get('test-2') as
      | Record<string, unknown>
      | undefined

    expect(row).toBeTruthy()
    expect(row!.status).toBe('completed')
    // duration_ms may be 0 if the transition happens within same millisecond
    expect(row!.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('tracks multiple agents independently', () => {
    createdIds.push('agent-a', 'agent-b')
    trackAgent('agent-a', 'running', { type: 'coding', model: 'v4-flash' })
    trackAgent('agent-b', 'running', { type: 'review', model: 'v4-flash' })

    const db = getDb()
    const rows = db
      .prepare("SELECT agent_id, status FROM agent_runs WHERE agent_id IN ('agent-a', 'agent-b') ORDER BY agent_id")
      .all() as Array<Record<string, unknown>>

    expect(rows).toHaveLength(2)
    expect(rows[0].agent_id).toBe('agent-a')
    expect(rows[1].agent_id).toBe('agent-b')
  })

  it('records failed status with error message', () => {
    const id = 'test-3'
    createdIds.push(id)
    trackAgent(id, 'running', { type: 'coding', model: 'v4-flash' })
    trackAgent(id, 'failed', {
      type: 'coding',
      model: 'v4-flash',
      error: 'LLM API timeout',
    })

    const db = getDb()
    const row = db.prepare('SELECT * FROM agent_runs WHERE agent_id = ?').get('test-3') as
      | Record<string, unknown>
      | undefined

    expect(row).toBeTruthy()
    expect(row!.status).toBe('failed')
    expect(row!.error).toBe('LLM API timeout')
  })
})
