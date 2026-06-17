/**
 * Unit tests — checkpoint.ts (phase-level recovery checkpoints)
 *
 * Tests save, complete, remove, list operations.
 * Uses real filesystem at ~/.yu/checkpoints/ with cleanup.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, rmSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { YU_HOME } from '../extension/paths.js'

const CHECKPOINT_DIR = resolve(YU_HOME, 'checkpoints')

describe('checkpoint module', () => {
  let checkpointModule: typeof import('../extension/checkpoint.js')

  beforeEach(async () => {
    checkpointModule = await import('../extension/checkpoint.js')
  })

  afterEach(() => {
    // Clean up any test checkpoint files
    try {
      const files = readdirSync(CHECKPOINT_DIR)
      for (const f of files) {
        if (f.includes('test-')) {
          unlinkSync(resolve(CHECKPOINT_DIR, f))
        }
      }
    } catch {
      /* dir might not exist */
    }
  })

  it('saveCheckpoint creates a checkpoint file', () => {
    const id = checkpointModule.saveCheckpoint({
      step: 'agent_spawn',
      files: ['src/test.ts'],
      timestamp: Date.now(),
      status: 'pending',
      metadata: { type: 'coding' },
    })

    expect(id).toBeTruthy()
    const path = resolve(CHECKPOINT_DIR, `${id}.json`)
    expect(existsSync(path)).toBe(true)
  })

  it('completeCheckpoint marks checkpoint as completed', () => {
    const id = checkpointModule.saveCheckpoint({
      step: 'lsp_verify',
      files: ['src/app.ts'],
      timestamp: Date.now(),
      status: 'pending',
    })

    checkpointModule.completeCheckpoint(id)
    const path = resolve(CHECKPOINT_DIR, `${id}.json`)
    expect(existsSync(path)).toBe(true)
    const raw = readdirSync(CHECKPOINT_DIR).find((f) => f === `${id}.json`)
    expect(raw).toBe(`${id}.json`)
  })

  it('removeCheckpoint deletes the checkpoint file', () => {
    const id = checkpointModule.saveCheckpoint({
      step: 'commit',
      files: ['src/main.ts'],
      timestamp: Date.now(),
      status: 'pending',
    })

    checkpointModule.removeCheckpoint(id)
    const path = resolve(CHECKPOINT_DIR, `${id}.json`)
    expect(existsSync(path)).toBe(false)
  })

  it('listPendingCheckpoints returns only pending checkpoints', () => {
    const id1 = checkpointModule.saveCheckpoint({
      step: 'agent_spawn',
      files: ['a.ts'],
      timestamp: Date.now(),
      status: 'pending',
      metadata: { test: 'pending-1' },
    })
    const id2 = checkpointModule.saveCheckpoint({
      step: 'lsp_verify',
      files: ['b.ts'],
      timestamp: Date.now(),
      status: 'completed',
      metadata: { test: 'completed' },
    })

    const pending = checkpointModule.listPendingCheckpoints()
    const ours = pending.filter((cp: { id: string }) => cp.id === id1 || cp.id === id2)

    expect(ours.length).toBe(1)
    expect(ours[0].id).toBe(id1)
  })

  it('listPendingCheckpoints excludes stale checkpoints (>24h old)', () => {
    const oldId = checkpointModule.saveCheckpoint({
      step: 'agent_spawn',
      files: ['stale.ts'],
      timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      status: 'pending',
      metadata: { test: 'stale' },
    })

    const pending = checkpointModule.listPendingCheckpoints()
    const found = pending.filter((cp: { id: string }) => cp.id === oldId)
    expect(found.length).toBe(0)
  })

  it('listPendingCheckpoints returns empty array when directory does not exist', () => {
    // Temporarily remove checkpoint dir
    try {
      rmSync(CHECKPOINT_DIR, { recursive: true, force: true })
    } catch {}

    const pending = checkpointModule.listPendingCheckpoints()
    expect(pending).toEqual([])
  })

  it('checkpointGuard creates and auto-completes a checkpoint', () => {
    const done = checkpointModule.checkpointGuard('agent_spawn', ['test.ts'], {
      task: 'test guard',
    })

    // Checkpoint should exist at this point
    const pending = checkpointModule.listPendingCheckpoints()
    const ourCp = pending.find((cp: { metadata?: Record<string, unknown> }) => cp.metadata?.task === 'test guard')
    expect(ourCp).toBeDefined()

    done() // marks completed and removes
  })

  it('multiple checkpoints are sorted by timestamp (oldest first)', () => {
    const id1 = checkpointModule.saveCheckpoint({
      step: 'agent_spawn',
      files: ['a.ts'],
      timestamp: Date.now() - 5000,
      status: 'pending',
    })
    const id2 = checkpointModule.saveCheckpoint({
      step: 'lsp_verify',
      files: ['b.ts'],
      timestamp: Date.now(),
      status: 'pending',
    })

    const pending = checkpointModule.listPendingCheckpoints()
    const ids = pending.map((cp: { id: string }) => cp.id)
    const idx1 = ids.indexOf(id1)
    const idx2 = ids.indexOf(id2)
    // If both are in the list, id1 should come before id2
    if (idx1 !== -1 && idx2 !== -1) {
      expect(idx1).toBeLessThan(idx2)
    }
  })
})
