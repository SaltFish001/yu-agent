/**
 * yu-agent — AgentLoop
 *
 * 核心 agent 执行循环。
 * 调用 LLM → 解析 tool_calls → 执行工具 → 继续循环 → 返回结果。
 * Phase 2 集成 ContextManager（压缩 + 缓存追踪 + 自动持久化）。
 *
 * Phase 1-2 仅 non-streaming。Phase 3 Web UI 做 streaming。
 */

import { createLogger } from './logger.js'

const log = createLogger('agent-loop')

import { ContextManager } from './context-manager.js'
import {
  type ApiClient,
  chatCompletion,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
} from './provider.js'
import { executeTool } from './tools/registry.js'

// ── Types ───────────────────────────────────────────────

export interface AgentLoopConfig {
  apiClient?: ApiClient
  systemPrompt?: string
  maxIterations?: number
  maxTokens?: number
  agentType?: string
  sessionId?: string
  autoPersist?: boolean
}

export interface AgentLoopResult {
  success: boolean
  output: string
  iterations: number
  totalTokens: number
  cacheStats?: {
    hitRate: number
    cacheHitTokens: number
    cacheMissTokens: number
  }
  compressCount?: number
  error?: string
}

// ── 默认 system prompt ───────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are yu-agent, an AI-powered programming agent.
You have access to tools that let you read files, search the web, and execute commands.
Use these tools to help the user accomplish their task.

When using tools:
1. Use native function calling format (valid JSON arguments)
2. Read the tool output carefully before deciding next steps
3. If a tool fails, try a different approach
4. Provide clear explanations of what you're doing

When you have completed the task, provide a summary of what was done.`

// ── AgentLoop ────────────────────────────────────────────

export class AgentLoop {
  private context: ContextManager
  private apiClient: ApiClient
  private maxIterations: number
  private totalTokensUsed = 0

  constructor(config: AgentLoopConfig = {}) {
    this.context = new ContextManager({
      id: config.sessionId,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      maxTokens: config.maxTokens ?? 8192,
      autoPersist: config.autoPersist ?? true,
    })
    this.apiClient = config.apiClient ?? { chatCompletion }
    this.maxIterations = config.maxIterations ?? 30
  }

  /** 获取底层的 ContextManager（用于外部访问消息/状态） */
  getContext(): ContextManager {
    return this.context
  }

  async run(task: string): Promise<AgentLoopResult> {
    this.context.addMessage({ role: 'user', content: task })

    for (let i = 0; i < this.maxIterations; i++) {
      log.info(`AgentLoop iteration ${i + 1}/${this.maxIterations}`)

      // Phase 2: LLM-based 压缩（>75% 自动触发）
      await this.context.compressIfNeeded(this.apiClient)

      // 调用 LLM
      const response = await this.callLLM()

      if (!response) {
        return {
          success: false,
          output: '',
          iterations: i + 1,
          totalTokens: this.totalTokensUsed,
          error: 'LLM returned no response',
        }
      }

      // Phase 2: 记录 usage
      this.context.recordUsage(response.usage)
      this.totalTokensUsed += response.usage?.total_tokens ?? 0

      const content = response.content ?? ''
      const finishReason = response.finish_reason

      // 解析 tool_calls
      const toolCalls = this.parseToolCalls(content)

      if (toolCalls.length > 0) {
        // 有 tool calls → 执行工具
        this.context.addToolCalls(
          toolCalls.map((tc, idx) => ({
            id: tc.id ?? `call_${i}_${idx}`,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.args },
          })),
          content,
        )

        for (const tc of toolCalls) {
          log.info(`Executing tool: ${tc.name}`)
          let parsedArgs: Record<string, unknown> = {}
          try {
            parsedArgs = JSON.parse(tc.args)
          } catch {
            const fixed = tc.args.replace(/'/g, '"').replace(/(\w+):/g, '"$1":')
            try {
              parsedArgs = JSON.parse(fixed)
            } catch {
              /* 保持空对象 */
            }
          }

          const result = await executeTool(tc.name, parsedArgs)
          this.context.addToolResult(
            tc.id ?? `call_${i}_0`,
            result.success ? result.output : `Error: ${result.error ?? 'Unknown error'}`,
          )
        }
      } else {
        // 无 tool calls → 最终回复
        this.context.addMessage({ role: 'assistant', content })

        if (finishReason === 'stop' || finishReason === 'end_turn') {
          return this.buildResult(content, i + 1)
        }
        return this.buildResult(content, i + 1)
      }
    }

    // 超迭代次数
    const lastMsg = this.context.getLastMessage()
    return this.buildResult(lastMsg?.content ?? '(no output after max iterations)', this.maxIterations)
  }

  private buildResult(output: string, iterations: number): AgentLoopResult {
    const cacheStats = this.context.getCacheStats()
    return {
      success: true,
      output,
      iterations,
      totalTokens: this.totalTokensUsed,
      cacheStats: {
        hitRate: cacheStats.hitRate,
        cacheHitTokens: cacheStats.cacheHitTokens,
        cacheMissTokens: cacheStats.cacheMissTokens,
      },
      compressCount: this.context.getCompressCount(),
    }
  }

  // ── LLM 调用 ────────────────────────────────────────────

  private async callLLM(): Promise<ProviderResponse | null> {
    const messages = this.context.getMessages()
    const providerMessages: ProviderMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_call_id: m.tool_call_id,
    }))

    const request: ProviderRequest = {
      messages: providerMessages,
      temperature: 0,
      max_tokens: 4096,
    }

    return this.apiClient.chatCompletion(request)
  }

  // ── tool_calls 解析 ─────────────────────────────────────

  private parseToolCalls(content: string): Array<{ id: string; name: string; args: string }> {
    const calls: Array<{ id: string; name: string; args: string }> = []

    // 格式 1: native function calling
    // {"function": "bash", "args": {"command": "ls"}}
    const nativePattern = /\{[^{]*"function"\s*:\s*"([^"]+)"[^}]*"args"\s*:\s*(\{[^}]+\})[^}]*\}/g
    for (const match of content.matchAll(nativePattern)) {
      calls.push({
        id: `call_${calls.length}`,
        name: match[1],
        args: match[2],
      })
    }

    // 格式 2: tool_use XML block
    // <tool_use><name>bash</name><args>{"command": "ls"}</args></tool_use>
    const xmlPattern = /<tool_use>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<args>([\s\S]*?)<\/args>[\s\S]*?<\/tool_use>/g
    for (const match of content.matchAll(xmlPattern)) {
      calls.push({
        id: `call_${calls.length}`,
        name: match[1].trim(),
        args: match[2].trim(),
      })
    }

    return calls
  }
}

// ── 便捷函数 ──────────────────────────────────────────────

export async function runAgent(task: string, config?: AgentLoopConfig): Promise<AgentLoopResult> {
  const agent = new AgentLoop(config)
  return agent.run(task)
}
