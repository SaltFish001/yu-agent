/**
 * yu-agent — Orchestrator engine (Phase 3).
 *
 * Reads rules from ~/.yu/orchestrator.json and auto-triggers cross-topic
 * tasks based on events from the SQLite event bus.
 *
 * Rule format:
 * {
 *   "rules": [
 *     {
 *       "name": "trigger-api-backend",
 *       "when": {
 *         "topic": "frontend",        // exact match, or '*' for any topic
 *         "event": "child_task_done",
 *         "condition": "payload.status === 'completed'"
 *       },
 *       "then": {
 *         "action": "spawn_child",
 *         "topic": "backend",
 *         "prompt": "Build API endpoints based on {{payload}}"
 *       }
 *     }
 *   ]
 * }
 */

import { Database as DatabaseSync } from 'bun:sqlite'
import crypto from 'crypto'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import vm from 'vm'
import { ensureDaemonRunning, getMaxBackground, writeEvent } from './topic.js'
import { createLogger } from './logger.js'

const log = createLogger('orchestrator')

// ── Types ─────────────────────────────────────────────────

interface OrchestratorCondition {
  topic: string
  event: string
  condition?: string
}

interface OrchestratorAction {
  action: 'spawn_child'
  topic: string
  prompt: string
}

interface OrchestratorRule {
  name: string
  when: OrchestratorCondition
  then: OrchestratorAction
}

interface OrchestratorConfig {
  rules: OrchestratorRule[]
}

// ── Internal helpers ──────────────────────────────────────

const ORCHESTRATOR_PATH = resolve(process.env.HOME || '/home/saltfish', '.yu', 'orchestrator.json')

// P2-20: Connection cache for getOrchDb() — prevents resource leaks
const _orchDbCache = new Map<string, DatabaseSync>()

// P2-22: Circuit breaker — track orchestration depth per event to prevent
// infinite recursion loops. Uses module-level counter.
const MAX_ORCH_DEPTH = 5

/**
 * Get the current orchestration depth from the async context.
 * Uses a simple module-level counter (per-event-chain).
 */
let _currentDepth = 0

function getOrchDepth(): number {
  return _currentDepth
}

function incrementOrchDepth(): number {
  return ++_currentDepth
}

function resetOrchDepth(): void {
  _currentDepth = 0
}

function loadRules(): OrchestratorRule[] {
  if (!existsSync(ORCHESTRATOR_PATH)) return []
  try {
    const raw = readFileSync(ORCHESTRATOR_PATH, 'utf-8')
    const config = JSON.parse(raw) as OrchestratorConfig
    return Array.isArray(config.rules) ? config.rules : []
  } catch (err: unknown) {
    // P2-15: Log parse failures with context
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`Failed to load rules from ${ORCHESTRATOR_PATH}: ${msg}`)
    return []
  }
}

/**
 * Open a shared DB connection for orchestration writes.
 * Uses a module-level cache to avoid opening a new DatabaseSync every call.
 * P2-20: Connection cache prevents resource leaks.
 */
function getOrchDb(): DatabaseSync {
  const dbPath = resolve(process.env.HOME || '/home/saltfish', '.yu', 'topics.db')
  let db = _orchDbCache.get(dbPath)
  if (!db) {
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA busy_timeout=5000')
    _orchDbCache.set(dbPath, db)
  }
  return db
}

/**
 * Close all cached orchestrator DB connections.
 * Call during shutdown to clean up resources.
 */
export function closeOrchDb(): void {
  for (const [_key, db] of _orchDbCache) {
    try {
      db.close()
    } catch {
      // Best-effort close
    }
  }
  _orchDbCache.clear()
}

/**
 * Evaluate a condition expression against the payload.
 * The condition is a JS expression string evaluated where `payload` is
 * the event payload object. Returns true if condition is absent/empty
 * or if the expression evaluates truthy.
 *
 * Uses vm.Script with a timeout (100ms) and sandboxed context
 * instead of new Function() to prevent arbitrary code execution.
 */
function evaluateCondition(condition: string | undefined, payload: Record<string, unknown>): boolean {
  if (!condition || condition.trim() === '') return true
  try {
    const script = new vm.Script(`(${condition})`)
    const context = vm.createContext({ payload: Object.freeze({ ...payload }) })
    const result = script.runInContext(context, { timeout: 100 })
    return !!result
  } catch (err: unknown) {
    // P2-16: Explicit error logging for eval failures
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`Condition evaluation failed: condition="${condition}" error="${msg}"`)
    return false
  }
}

/**
 * Replace {{payload}} and {{payload.key}} / {{payload.key.subkey}} placeholders
 * in a template string. Supports deeply nested keys via dot-separated paths.
 *
 * P2-21: Add nested payload key interpolation support.
 */
function interpolatePrompt(template: string, payload: Record<string, unknown>): string {
  let result = template
  if (result.includes('{{payload}}')) {
    result = result.replace(/\{\{payload\}\}/g, JSON.stringify(payload))
  }
  // Support nested keys: {{payload.key}} and {{payload.key.subkey}}
  result = result.replace(/\{\{payload\.([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g, (_match, path: string) => {
    const parts = path.split('.')
    let val: unknown = payload
    for (const part of parts) {
      if (val === null || val === undefined) return ''
      if (typeof val === 'object' && val !== null) {
        val = (val as Record<string, unknown>)[part]
      } else {
        return ''
      }
    }
    if (val === undefined) return ''
    if (typeof val === 'object') return JSON.stringify(val)
    return String(val)
  })
  return result
}

/**
 * Execute a spawn_child action: find or create the target topic, then
 * set it to background with the given prompt.
 *
 * P2-18: Added DB transaction around get+insert/update.
 * P2-19: Moved backgroundCount check inside transaction (TOCTOU fix).
 */
function actionSpawnChild(topicName: string, promptTemplate: string, eventPayload: Record<string, unknown>): void {
  const prompt = interpolatePrompt(promptTemplate, eventPayload)
  const db = getOrchDb()
  const dir = resolve(process.env.HOME || '/home/saltfish', '.yu', 'topics', topicName)

  // Ensure topic directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  // P2-18: Use transaction for atomic get+insert/update
  // P2-19: Move background count check inside transaction to prevent TOCTOU
  try {
    db.exec('BEGIN IMMEDIATE')

    // Check background count limit inside the transaction (TOCTOU fix)
    const countRow = db
      .prepare("SELECT COUNT(*) AS count FROM topics WHERE archived = 0 AND status = 'background'")
      .get() as { count: number }
    const currentBg = countRow?.count ?? 0
    const maxBg = getMaxBackground()

    if (currentBg >= maxBg) {
      db.exec('ROLLBACK')
      log.warn(
        `Cannot spawn child for "${topicName}": background limit reached (${currentBg}/${maxBg})`,
      )
      writeEvent(topicName, 'child_spawn_failed', { reason: 'background_limit', maxBg, currentBg })
      return
    }

    // Find or create the target topic
    const topicRow = db.prepare('SELECT id, status FROM topics WHERE LOWER(name) = LOWER(?)').get(topicName) as
      | { id: string; status: string }
      | undefined

    if (topicRow) {
      // Already exists — check it's idle before proceeding
      if (topicRow.status !== 'idle') {
        db.exec('ROLLBACK')
        log.warn(
          `Cannot spawn child for "${topicName}": topic status is "${topicRow.status}", expected "idle"`,
        )
        writeEvent(topicName, 'child_spawn_failed', { reason: 'topic_not_idle', status: topicRow.status })
        return
      }
      const now = new Date().toISOString()
      db.prepare(`
        UPDATE topics
        SET status = 'background',
            summary = ?,
            turns = turns + 1,
            last_active = ?,
            cmd = ?,
            started_at = ?
        WHERE name = ? AND status = 'idle'
      `).run(`Running: ${prompt}`, now, prompt, now, topicName)
    } else {
      // Create new topic
      // P2-20: Use crypto.randomUUID() instead of Date.now()+Math.random
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      db.prepare(`
        INSERT INTO topics (id, name, dir, summary, status, turns, last_active, created_at, archived)
        VALUES (?, ?, ?, ?, 'background', 1, ?, ?, 0)
      `).run(id, topicName, dir, `Running: ${prompt}`, now, now)
    }

    db.exec('COMMIT')
  } catch (err: unknown) {
    db.exec('ROLLBACK')
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`Transaction failed for spawn_child on "${topicName}": ${msg}`)
    return
  }

  // No db.close() — connection is cached and shared (P2-20)

  // Write orchestrator event for traceability
  writeEvent(topicName, 'child_spawned', { source: 'orchestrator', prompt })

  // Ensure the supervisor daemon is running to pick up the new task
  ensureDaemonRunning()
}

// ── Public API ────────────────────────────────────────────

/**
 * Check orchestrator rules and trigger any matching actions.
 * Called after every event write in supervisor.ts.
 *
 * P2-17: Validate action type before evaluating condition
 *   (reordered: first check topic/event match, then validate action type,
 *    then evaluate condition, then execute).
 * P2-22: Circuit breaker — prevent infinite orchestration recursion.
 *
 * @param eventTopic   The topic name that the event occurred on
 * @param eventType    The event type (child_spawned, child_task_done, etc.)
 * @param eventPayload The event payload object
 */
export function checkAndTriggerOrchestrator(
  eventTopic: string,
  eventType: string,
  eventPayload: Record<string, unknown>,
): void {
  const rules = loadRules()
  if (rules.length === 0) return

  // P2-22: Circuit breaker — check depth before processing
  const depth = getOrchDepth()
  if (depth >= MAX_ORCH_DEPTH) {
    log.warn(
      `Circuit breaker triggered: max orchestration depth (${MAX_ORCH_DEPTH}) reached. Breaking chain.`,
    )
    resetOrchDepth()
    return
  }

  // Increment depth for this chain
  incrementOrchDepth()

  for (const rule of rules) {
    // Topic match: exact or '*'
    if (rule.when.topic !== '*' && rule.when.topic !== eventTopic) continue

    // Event type match
    if (rule.when.event !== eventType) continue

    // P2-17: Validate action type before evaluating condition
    if (!rule.then?.action) {
      log.warn(`Rule "${rule.name}" has no action defined, skipping`)
      continue
    }

    // Check if action type is known
    const knownActions = ['spawn_child']
    if (!knownActions.includes(rule.then.action)) {
      log.warn(`Unknown action "${rule.then.action}" in rule "${rule.name}", skipping`)
      continue
    }

    // Condition evaluation
    if (!evaluateCondition(rule.when.condition, eventPayload)) continue

    // Execute action
    log.info(`Rule "${rule.name}" triggered: ${rule.then.action} on topic "${rule.then.topic}"`)

    switch (rule.then.action) {
      case 'spawn_child':
        actionSpawnChild(rule.then.topic, rule.then.prompt, eventPayload)
        break
      default:
        log.warn(`Unknown action "${rule.then.action}" in rule "${rule.name}"`)
    }
  }
}
