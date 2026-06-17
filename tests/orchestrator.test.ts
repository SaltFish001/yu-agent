/**
 * Unit tests — Orchestrator engine (closeOrchDb, checkAndTriggerOrchestrator)
 *
 * Tests the public API surface of the orchestrator module.
 * closeOrchDb cleans up cached DB connections; checkAndTriggerOrchestrator
 * triggers cross-topic tasks based on event rules.
 *
 * Note: getOrchDb is a private function (not exported), so we test it
 * indirectly through closeOrchDb (which clears the internal cache)
 * and checkAndTriggerOrchestrator (which uses getOrchDb internally).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const ORCHESTRATOR_PATH = resolve(process.env.HOME || '/home/saltfish', '.yu', 'orchestrator.json')

describe('Orchestrator DB cache', () => {
  afterEach(() => {
    // Clean up orchestrator config between tests
    try {
      unlinkSync(ORCHESTRATOR_PATH)
    } catch {
      /* ok */
    }
  })

  it('closeOrchDb does not throw when cache is empty', async () => {
    const { closeOrchDb } = await import('../extension/orchestrator.js')
    expect(() => closeOrchDb()).not.toThrow()
  })

  it('closeOrchDb is idempotent (multiple calls safe)', async () => {
    const { closeOrchDb } = await import('../extension/orchestrator.js')
    // First call
    expect(() => closeOrchDb()).not.toThrow()
    // Second call — cache is already empty
    expect(() => closeOrchDb()).not.toThrow()
    // Third call — still safe
    expect(() => closeOrchDb()).not.toThrow()
  })

  it('checkAndTriggerOrchestrator handles empty input gracefully (no rules file)', async () => {
    // Without ~/.yu/orchestrator.json, loadRules() returns []
    const { checkAndTriggerOrchestrator } = await import('../extension/orchestrator.js')
    // Should not throw when there are no rules
    expect(() => {
      checkAndTriggerOrchestrator('test-topic', 'child_task_done', { status: 'completed' })
    }).not.toThrow()
  })

  it('checkAndTriggerOrchestrator does nothing with empty rules array', async () => {
    // Create orchestrator.json with empty rules
    const dir = resolve(process.env.HOME || '/home/saltfish', '.yu')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(ORCHESTRATOR_PATH, JSON.stringify({ rules: [] }), 'utf-8')

    const { checkAndTriggerOrchestrator } = await import('../extension/orchestrator.js')
    expect(() => {
      checkAndTriggerOrchestrator('any-topic', 'any_event', {})
    }).not.toThrow()
  })

  it('checkAndTriggerOrchestrator handles rules with unknown action gracefully', async () => {
    // Create orchestrator.json with a rule that has an unknown action
    const dir = resolve(process.env.HOME || '/home/saltfish', '.yu')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(
      ORCHESTRATOR_PATH,
      JSON.stringify({
        rules: [
          {
            name: 'test-unknown-action',
            when: { topic: '*', event: 'test_event' },
            // biome-ignore lint/suspicious/noThenProperty: ECA rule field
            then: { action: 'unknown_action', topic: 'target', prompt: 'test' },
          },
        ],
      }),
      'utf-8',
    )

    const { checkAndTriggerOrchestrator } = await import('../extension/orchestrator.js')
    // Should handle unknown action without throwing
    expect(() => {
      checkAndTriggerOrchestrator('test-topic', 'test_event', { foo: 'bar' })
    }).not.toThrow()
  })
})
