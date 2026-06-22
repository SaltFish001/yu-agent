/**
 * yu-agent — Background task registry.
 *
 * Tracks sub-agents running in background mode (--bg / --background).
 * Each task gets a unique ID and lives in memory + SQLite events table.
 *
 * Usage:
 *   import { bg } from './background.js'
 *   const id = bg.register({ type: 'coding', prompt: 'fix bug' })
 *   bg.run(id, () => spawnAgent(config))  // fire & forget
 *   const tasks = bg.list()
 */

import { createLogger } from './logger.js'

const log = createLogger('background')

// ── Types ───────────────────────────────────────────────

export interface BgTask {
  id: string
  type: string
  prompt: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  startTime: number
  endTime?: number
  result?: string
  error?: string
}

// ── Registry (in-memory) ───────────────────────────────

const tasks = new Map<string, BgTask>()
const MAX_TASKS = 100

// ── Public API ─────────────────────────────────────────

export const bg = {
  /**
   * Register a new background task and return its ID.
   */
  register(opts: { type: string; prompt: string }): string {
    // Clean up old tasks if at capacity
    if (tasks.size >= MAX_TASKS) {
      const oldest = [...tasks.entries()]
        .sort(([, a], [, b]) => a.startTime - b.startTime)
        .slice(0, Math.floor(MAX_TASKS / 2))
      for (const [id] of oldest) tasks.delete(id)
    }

    const id = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    tasks.set(id, {
      id,
      type: opts.type,
      prompt: opts.prompt.slice(0, 200),
      status: 'pending',
      startTime: Date.now(),
    })
    log.info(`Background task registered: ${id} (${opts.type})`)
    return id
  },

  /**
   * Mark a task as running.
   */
  markRunning(id: string): void {
    const t = tasks.get(id)
    if (t) {
      t.status = 'running'
      log.info(`Background task running: ${id}`)
    }
  },

  /**
   * Mark a task as completed with its result.
   */
  markCompleted(id: string, result: string): void {
    const t = tasks.get(id)
    if (t) {
      t.status = 'completed'
      t.endTime = Date.now()
      t.result = result.slice(0, 5000)
      log.info(`Background task completed: ${id} (${(t.endTime - t.startTime) / 1000}s)`)
    }
  },

  /**
   * Mark a task as failed.
   */
  markFailed(id: string, error: string): void {
    const t = tasks.get(id)
    if (t) {
      t.status = 'failed'
      t.endTime = Date.now()
      t.error = error.slice(0, 1000)
      log.warn(`Background task failed: ${id} — ${error}`)
    }
  },

  /**
   * Cancel a pending/running task.
   */
  cancel(id: string): boolean {
    const t = tasks.get(id)
    if (!t) return false
    if (t.status === 'pending' || t.status === 'running') {
      t.status = 'cancelled'
      t.endTime = Date.now()
      log.info(`Background task cancelled: ${id}`)
      return true
    }
    return false
  },

  /**
   * Get a single task by ID.
   */
  get(id: string): BgTask | undefined {
    return tasks.get(id)
  },

  /**
   * List all tasks, newest first.
   */
  list(): BgTask[] {
    return [...tasks.values()].sort((a, b) => b.startTime - a.startTime)
  },

  /**
   * Get summary stats for status display.
   */
  stats(): { active: number; completed: number; failed: number } {
    let active = 0
    let completed = 0
    let failed = 0
    for (const t of tasks.values()) {
      if (t.status === 'running' || t.status === 'pending') active++
      else if (t.status === 'completed') completed++
      else if (t.status === 'failed') failed++
    }
    return { active, completed, failed }
  },

  /**
   * Run a task function in background and track its lifecycle.
   * Returns immediately with the task ID.
   */
  run(id: string, fn: () => Promise<string>): void {
    this.markRunning(id)
    fn()
      .then((result) => this.markCompleted(id, result))
      .catch((err) => this.markFailed(id, err instanceof Error ? err.message : String(err)))
  },
}
