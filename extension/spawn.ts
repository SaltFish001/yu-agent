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

// ── Internal state ────────────────────────────────────

let totalSpawned = 0
let errorCount = 0

// ── Core: spawnAgent ──────────────────────────────────

export async function spawnAgent(config: SpawnConfig): Promise<SpawnResult> {
  totalSpawned++
  const startTime = Date.now()

  log.info(`Spawning agent: type=${config.type} model=${config.model}`)

  try {
    // 限制迭代次数
    const maxIter = Math.min(config.maxTurns ?? 30, 50)

    const result = await runAgent(config.task, {
      systemPrompt: `You are a ${config.type} agent. Complete the assigned task.`,
      maxIterations: maxIter,
      maxTokens: 8192,
    })

    const duration = Date.now() - startTime

    log.info(`Agent completed: type=${config.type} iterations=${result.iterations} duration=${duration}ms`)

    const response: SpawnResult = {
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

    return response
  } catch (err) {
    errorCount++
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`Agent failed: type=${config.type} error=${msg}`)

    return {
      response: '',
      text: '',
      content: '',
      totalTokens: 0,
      durationMs: Date.now() - startTime,
      model: config.model,
    }
  }
}

// ── Pool management (previously Pi-based, now lightweight) ──

const pools = new Map<string, number>()

export async function createSpawnPool(type: string, _count: number, _config: SpawnConfig): Promise<void> {
  pools.set(type, (pools.get(type) ?? 0) + 1)
  log.info(`Spawn pool created: type=${type} (total pools: ${pools.size})`)
}

export function getAllPoolsStats(): Record<string, unknown> {
  const stats: Record<string, unknown> = {}
  for (const [type] of pools) {
    stats[type] = {
      activeCount: 0,
      totalSpawned,
      errors: errorCount,
    }
  }
  return stats
}

export function getSpawnStats(): SpawnStats {
  return {
    activeCount: 0,
    totalSpawned,
    errors: errorCount,
  }
}
