/**
 * yu-agent — Agent 适配器
 *
 * 在旧的 Pi SDK spawn 和新的 AgentLoop 之间切换。
 * YU_AGENT_USE_PI=true 走旧路径，否则走新路径。
 *
 * 原则：spawn.ts 导出不改，executor.ts import 路径不变。
 */

import { createLogger } from './logger.js'

const log = createLogger('agent-adapter')

import { AgentLoop, type AgentLoopConfig, type AgentLoopResult } from './agent-loop.js'

// ── 适配器 ──────────────────────────────────────────────

export interface SpawnAgentOptions {
  task: string
  systemPrompt?: string
  agentType?: string
  maxIterations?: number
}

/**
 * 创建 agent 并执行任务。
 * YU_AGENT_USE_PI=true 时走旧的 spawn.ts 路径。
 */
export async function spawnAgent(options: SpawnAgentOptions): Promise<AgentLoopResult> {
  const usePi = process.env.YU_AGENT_USE_PI === 'true'

  if (usePi) {
    log.info('Using Pi SDK agent (YU_AGENT_USE_PI=true)')
    return spawnPiAgent(options)
  }

  log.info('Using AgentLoop (new path)')
  const config: AgentLoopConfig = {
    systemPrompt: options.systemPrompt,
    maxIterations: options.maxIterations ?? 30,
    agentType: options.agentType,
  }

  const loop = new AgentLoop(config)
  return loop.run(options.task)
}

// ── Pi SDK 回退 ─────────────────────────────────────────

async function spawnPiAgent(options: SpawnAgentOptions): Promise<AgentLoopResult> {
  try {
    const { spawnAgent: piSpawnAgent } = await import('./spawn.js')

    const result = await piSpawnAgent({
      type: options.agentType ?? 'coding',
      model: 'v4-flash',
      maxTurns: options.maxIterations ?? 10,
      task: options.task,
      timeout: 120_000,
    } as any)

    return {
      success: true,
      output: result.text ?? result.content ?? '(no output)',
      iterations: 1,
      totalTokens: 0,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: '', iterations: 0, totalTokens: 0, error: msg }
  }
}

// ── 判断是否可用 ─────────────────────────────────────────

export function isAgentLoopAvailable(): boolean {
  return process.env.YU_AGENT_USE_PI !== 'true'
}
