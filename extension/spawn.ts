/**
 * yu-agent — 子 agent 调度层 (Pi-free AgentLoop 代理)
 *
 * Phase 3: Pi SDK 已移除。所有 spawn 调用委托给 AgentLoop。
 * 保持 SpawnConfig / SpawnResult 接口不变，executor/tracker/scheduler 无需修改。
 */

import { createLogger } from './logger.js'

const log = createLogger('spawn')

import { runAgent } from './agent-loop.js'

// ── 类型 ──────────────────────────────────────────────

export interface SpawnConfig {
  type: string
  model: string
  thinking?: string
  maxTurns: number
  task: string
  files?: string[]
  context?: Record<string, unknown>
  timeout: number
  teamRunId?: string
  memberName?: string
  isolated?: boolean
  background?: boolean // P2: run as background task
}

export interface SpawnResult {
  response: string
  cacheHitTokens?: number
  cacheMissTokens?: number
  outputTokens?: number
  totalTokens?: number
  durationMs?: number
  model?: string
  text?: string
  content?: string
}

export interface SpawnStats {
  activeCount: number
  totalSpawned: number
  errors: number
}

// ── Pool management ───────────────────────────────────

interface PoolSlot {
  maxConcurrency: number
  running: number
  queue: Array<() => void>
}

const pools = new Map<string, PoolSlot>()
let totalSpawned = 0
let errorCount = 0

/**
 * Create (or update) a spawn pool with a concurrency limit.
 * Agents of this type will queue up when at capacity.
 */
export async function createSpawnPool(type: string, concurrency: number, _config?: SpawnConfig): Promise<void> {
  const existing = pools.get(type)
  if (existing) {
    existing.maxConcurrency = concurrency
    log.info(`Spawn pool updated: type=${type} concurrency=${concurrency}`)
  } else {
    pools.set(type, { maxConcurrency: concurrency, running: 0, queue: [] })
    log.info(`Spawn pool created: type=${type} concurrency=${concurrency}`)
  }
}

/**
 * Acquire a pool slot — resolve when under concurrency limit.
 * Returns a release function the caller must invoke when done.
 */
async function acquireSlot(type: string): Promise<() => void> {
  const pool = pools.get(type)
  if (!pool) return () => {} // no pool = no limit

  if (pool.running < pool.maxConcurrency) {
    pool.running++
    return () => {
      pool.running--
      dequeueNext(type)
    }
  }

  // Queue
  return new Promise<() => void>((resolve) => {
    pool.queue.push(() => {
      pool.running++
      resolve(() => {
        pool.running--
        dequeueNext(type)
      })
    })
  })
}

function dequeueNext(type: string): void {
  const pool = pools.get(type)
  if (!pool || pool.queue.length === 0) return
  if (pool.running < pool.maxConcurrency) {
    const next = pool.queue.shift()
    next?.()
  }
}

// ── Core: spawnAgent ──────────────────────────────────

export async function spawnAgent(config: SpawnConfig): Promise<SpawnResult> {
  totalSpawned++
  const startTime = Date.now()

  // ── Foreground mode: synchronous ──
  if (!config.background) {
    log.info(`Spawning agent: type=${config.type} model=${config.model}`)

    // Emit agent.started
    try {
      const { eventBus } = await import('./events.js')
      eventBus.emit('agent.started', { type: config.type, model: config.model, task: config.task.slice(0, 200) })
    } catch {
      /* non-critical */
    }

    // Acquire pool slot
    const release = await acquireSlot(config.type)

    try {
      const maxIter = Math.min(config.maxTurns ?? 30, 50)

      const result = await runAgent(config.task, {
        systemPrompt: `You are a ${config.type} agent. Complete the assigned task.`,
        maxIterations: maxIter,
        maxTokens: 8192,
      })

      const duration = Date.now() - startTime

      log.info(`Agent completed: type=${config.type} iterations=${result.iterations} duration=${duration}ms`)

      // Emit agent.completed
      try {
        const { eventBus } = await import('./events.js')
        eventBus.emit('agent.completed', {
          type: config.type,
          model: config.model,
          duration,
          iterations: result.iterations,
        })
      } catch {
        /* non-critical */
      }

      return {
        response: result.output,
        text: result.output,
        content: result.output,
        totalTokens: result.totalTokens,
        cacheHitTokens: result.cacheStats?.cacheHitTokens,
        cacheMissTokens: result.cacheStats?.cacheMissTokens,
        outputTokens: result.totalTokens,
        durationMs: duration,
        model: config.model,
      }
    } catch (err) {
      errorCount++
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`Agent failed: type=${config.type} error=${msg}`)

      // Emit agent.error
      try {
        const { eventBus } = await import('./events.js')
        eventBus.emit('agent.error', { type: config.type, model: config.model, error: msg })
      } catch {
        /* non-critical */
      }

      return {
        response: '',
        text: '',
        content: '',
        totalTokens: 0,
        durationMs: Date.now() - startTime,
        model: config.model,
      }
    } finally {
      release()
    }
  }

  // ── Background mode: fire & forget ──
  const { bg } = await import('./background.js')
  const id = bg.register({
    type: config.type,
    prompt: config.task,
    timeout: config.timeout > 0 ? config.timeout : undefined,
  })

  // Emit task.started
  try {
    const { eventBus } = await import('./events.js')
    eventBus.emit('task.started', { taskId: id, type: config.type, task: config.task.slice(0, 200) })
  } catch {
    /* non-critical */
  }

  // Fire the agent in background (no await)
  const signal = bg.getSignal(id)
  ;(async () => {
    const release = await acquireSlot(config.type)
    try {
      bg.markRunning(id)
      const maxIter = Math.min(config.maxTurns ?? 30, 50)
      const result = await runAgent(config.task, {
        systemPrompt: `You are a ${config.type} agent. Complete the assigned task.`,
        maxIterations: maxIter,
        maxTokens: 8192,
        abortSignal: signal,
      })
      if (signal?.aborted) {
        bg.cancel(id, signal.reason?.toString())
        return
      }
      bg.markCompleted(id, result.output)
    } catch (err) {
      if (signal?.aborted) {
        bg.cancel(id, signal.reason?.toString())
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      bg.markFailed(id, msg)
    } finally {
      release()
      // Emit task.failed if cancelled/timeout (markFailed already emits)
      const task = bg.get(id)
      if (task && task.status === 'failed') {
        try {
          const { eventBus } = await import('./events.js')
          eventBus.emit('task.failed', { taskId: id, type: config.type, error: task.error ?? 'unknown' })
        } catch {
          /* non-critical */
        }
      }
    }
  })()

  log.info(`Background agent spawned: type=${config.type} id=${id}`)
  return {
    response: `[background] Task submitted (id: ${id})`,
    text: `[background] Task submitted (id: ${id})`,
    content: `[background] Task submitted (id: ${id})`,
    totalTokens: 0,
    durationMs: 0,
    model: config.model,
  }
}

// ── Pool stats ────────────────────────────────────────

export function getAllPoolsStats(): Record<string, unknown> {
  const stats: Record<string, unknown> = {}
  for (const [type, pool] of pools) {
    stats[type] = {
      maxConcurrency: pool.maxConcurrency,
      activeCount: pool.running,
      queued: pool.queue.length,
      totalSpawned,
      errors: errorCount,
    }
  }
  return stats
}

export function getSpawnStats(): SpawnStats {
  let activeCount = 0
  for (const pool of pools.values()) {
    activeCount += pool.running
  }
  return {
    activeCount,
    totalSpawned,
    errors: errorCount,
  }
}
