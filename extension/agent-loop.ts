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
import { executeTool, listTools } from './tools/registry.js'
import './tools/aliases.js'
import { registerAliases } from './tools/aliases.js'
registerAliases() // 注册工具别名（write_file→write 等）

// ── Types ───────────────────────────────────────────────

export interface AgentLoopConfig {
  apiClient?: ApiClient
  systemPrompt?: string
  maxIterations?: number
  maxTokens?: number
  agentType?: string
  sessionId?: string
  autoPersist?: boolean
  /** 可选的 AbortSignal，用于超时/取消 (spawn/background 传入) */
  abortSignal?: AbortSignal
}

export interface AgentLoopResult {
  success: boolean
  output: string
  iterations: number
  totalTokens: number
  wroteCode?: boolean
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
  private abortSignal?: AbortSignal
  private _remindedWrite = false
  private _actuallyWrote = false  // 记录整个 session 中是否调用了 write/edit 工具

  constructor(config: AgentLoopConfig = {}) {
    this.context = new ContextManager({
      id: config.sessionId,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      maxTokens: config.maxTokens ?? 8192,
      autoPersist: config.autoPersist ?? true,
    })
    this.apiClient = config.apiClient ?? { chatCompletion }
    this.maxIterations = config.maxIterations ?? 30
    this.abortSignal = config.abortSignal
  }

  /** 获取底层的 ContextManager（用于外部访问消息/状态） */
  getContext(): ContextManager {
    return this.context
  }

  async run(task: string): Promise<AgentLoopResult> {
    this.context.addMessage({ role: 'user', content: task })

    // ── 首轮注入工具说明 ─────────────────────────────
    const tools = listTools()

    const toolFormat = `你可以调用以下工具来协助完成任务。工具通过 JSON 格式调用：

\`\`\`json
[{"function": "ToolName", "args": "JSON encoded arguments string"}]
\`\`\`

可用工具: ${tools.map(t => t.name).join(', ')}

调用规则：
1. 每次迭代可以调用多个工具（放在一个 JSON 数组里）
2. 工具调用的输出会在下一轮迭代提供
3. 阅读工具输出后决定下一步行动
4. 在任务目标全部完成之前，不要提前结束
5. 任务全部完成后，给出总结`

    // 只在首次运行且系统 prompt 不含工具说明时注入
    const currentSys = this.context.getSystemPrompt()
    if (currentSys && !currentSys.includes('你可以调用以下工具')) {
      this.context.updateSystemPrompt(currentSys + '\n\n' + toolFormat)
    }

    for (let i = 0; i < this.maxIterations; i++) {
      // Check abort signal
      if (this.abortSignal?.aborted) {
        const lastMsg = this.context.getLastMessage()
        return {
          success: false,
          output: lastMsg?.content ?? '(cancelled)',
          iterations: i + 1,
          totalTokens: this.totalTokensUsed,
          wroteCode: false,
          error: `AgentLoop cancelled: ${this.abortSignal.reason?.toString() ?? 'unknown'}`,
        }
      }

      log.info(`AgentLoop iteration ${i + 1}/${this.maxIterations}`)

      // ── Track read/write ratio — if too many reads without writes, force reminder ──
      // Track tool usage from assistant messages' tool_calls arrays
      const allAssistantMsgs = this.context.getMessages().filter(m => m.role === 'assistant' && m.tool_calls)
      let readCount = 0
      let writeCount = 0
      const readNames = ['bash', 'read', 'grep', 'ls', 'glob']
      const writeNames = ['write', 'edit']
      for (const msg of allAssistantMsgs) {
        for (const tc of (msg.tool_calls ?? [])) {
          const name = tc.function?.name ?? ''
          if (readNames.includes(name)) readCount++
          if (writeNames.includes(name)) writeCount++
        }
      }

      // If 6+ reads and 0 writes and not reminded yet, inject a forceful reminder once
      if (i >= 6 && readCount >= 6 && writeCount === 0 && !this._remindedWrite) {
        this._remindedWrite = true
        const writeReminder = '⚠️ 你已经读了多次文件但从未产出任何代码改动。' +
          '请立即产出实际代码改动。用以下格式写代码块（系统会自动提取）：\n\n' +
          '```typescript:src/file.ts\n// 改完后的完整文件内容\n```\n\n' +
          '不要输出工具调用 JSON 块当代码。那不算产出。' +
          '这是最后一次机会写出代码。'
        this.context.addMessage({ role: 'user', content: writeReminder })
        log.warn(`Forced write reminder at iteration ${i + 1} (reads=${readCount}, writes=0)`)
        continue
      }

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
          // Track whether any write/edit tool was actually called
          if (tc.name === 'write' || tc.name === 'edit' || tc.name === 'write_file' || tc.name === 'edit_file') {
            this._actuallyWrote = true
          }
          // Also track bash heredoc writes (cat > file, tee, etc.)
          if (tc.name === 'bash' && typeof tc.args === 'string') {
            const cmd = tc.args.toLowerCase()
            if (cmd.includes('cat >') || cmd.includes('cat <<') || cmd.includes("'eof'") || cmd.includes('writefilesync') || cmd.includes('bun.write')) {
              this._actuallyWrote = true
            }
          }
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

          // ── Tool retry: executeTool 内部已做 retry — 这里只汇报 ──
          const result = await executeTool(tc.name, parsedArgs)
          this.context.addToolResult(
            tc.id ?? `call_${i}_0`,
            result.success ? result.output : `Error: ${result.error ?? 'Unknown error'}`,
          )
        }
      } else if (finishReason === 'stop' || finishReason === 'end_turn' || finishReason === 'end_call') {
        // 无 tool calls 且 LLM 表示完成
        // 前 3 轮不允许直接结束——强制 LLM 使用工具
        if (i < 3) {
          const reminder = '请使用工具来完成任务。先调用一个工具看看结果。'
          this.context.addMessage({ role: 'user', content: reminder })
          log.info(`Agent stopped early (iter ${i + 1}), sending reminder to use tools`)
          continue
        }
        // 3 轮之后才真正结束
        this.context.addMessage({ role: 'assistant', content })
        return this.buildResult(content, i + 1)
      }
      // 无 tool calls 但 finishReason 不是以上终止信号
      // 如果已经提醒过写代码但仍然无 tool calls → 接受当前输出并结束
      if (this._remindedWrite && i >= 10) {
        log.info(`Agent not producing tool calls after write reminder, ending with text output (iter ${i + 1})`)
        this.context.addMessage({ role: 'assistant', content })
        return this.buildResult(content, i + 1)
      }
      // 否则继续循环
    }

    // 超迭代次数
    const lastMsg = this.context.getLastMessage()
    return this.buildResult(lastMsg?.content ?? '(no output after max iterations)', this.maxIterations)
  }

  private buildResult(output: string, iterations: number): AgentLoopResult {
    const cacheStats = this.context.getCacheStats()
    // Also detect code blocks in output (non-JSON language tag with path)
    const hasCodeBlock = /```\w+:(?!json)[^\n]+\n[\s\S]*?```/.test(output)
    const actuallyWrote = this._actuallyWrote || hasCodeBlock
    return {
      success: true,
      output,
      iterations,
      totalTokens: this.totalTokensUsed,
      wroteCode: actuallyWrote,
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

    // 格式 1: code block JSON — ```json [...] ```
    const jsonBlockPattern = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/g
    for (const match of content.matchAll(jsonBlockPattern)) {
      try {
        const parsed = JSON.parse(match[1])
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.function && item.args !== undefined) {
              calls.push({
                id: item.id ?? `call_${calls.length}`,
                name: item.function,
                args: typeof item.args === 'string' ? item.args : JSON.stringify(item.args),
              })
            }
          }
        }
      } catch {
        /* skip malformed */
      }
    }

    // 格式 2: 内联 JSON 对象 — brace-counting 提取所有顶层 JSON
    for (const maybeJson of this.extractJsonObjects(content)) {
      try {
        const parsed = JSON.parse(maybeJson)
        if (parsed.function && parsed.args !== undefined) {
          // Deduplicate: skip if already found via JSON block
          if (!calls.some((c) => c.name === parsed.function)) {
            calls.push({
              id: parsed.id ?? `call_${calls.length}`,
              name: parsed.function,
              args: typeof parsed.args === 'string' ? parsed.args : JSON.stringify(parsed.args),
            })
          }
        }
      } catch {
        /* not valid JSON, skip */
      }
    }

    // 格式 3: tool_use XML block
    const xmlPattern = /<tool_use>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<args>([\s\S]*?)<\/args>[\s\S]*?<\/tool_use>/g
    for (const match of content.matchAll(xmlPattern)) {
      if (!calls.some((c) => c.name === match[1].trim())) {
        calls.push({
          id: `call_${calls.length}`,
          name: match[1].trim(),
          args: match[2].trim(),
        })
      }
    }

    return calls
  }

  /**
   * Brace-counting JSON 对象提取器。
   * 从文本中提取所有顶级 {…} 对象，支持任意深度嵌套。
   */
  private extractJsonObjects(text: string): string[] {
    const results: string[] = []
    let depth = 0
    let start = -1
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '{') {
        if (depth === 0) start = i
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0 && start >= 0) {
          results.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
    return results
  }
}

// ── 便捷函数 ──────────────────────────────────────────────

export async function runAgent(task: string, config?: AgentLoopConfig): Promise<AgentLoopResult> {
  const agent = new AgentLoop(config)
  return agent.run(task)
}
