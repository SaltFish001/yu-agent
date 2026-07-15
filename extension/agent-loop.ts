/**
 * yu-agent — AgentLoop
 *
 * 核心 agent 执行循环。
 * 调用 LLM → 解析 tool_calls → 执行工具 → 继续循环 → 返回结果。
 * Phase 2 集成 ContextManager（压缩 + 缓存追踪 + 自动持久化）。
 *
 * Phase 3 (reasonix-inspired): 状态快照 + 周期 checkpoint + 指令强化。
 * - 每 5 轮注入一次进度状态摘要，防止长上下文注意力漂移
 * - 系统指令定期强化，防止指令遗忘
 * - 状态外化跟踪（已改文件、关键决策）
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
import { executeTool, listTools, listToolsByType, getToolSchemas } from './tools/registry.js'
import './tools/aliases.js'
import { registerAliases } from './tools/aliases.js'
registerAliases() // 注册工具别名（write_file→write 等）

// ── Agent type 配置加载 ────────────────────────────────

import { AGENT_TYPES } from './config.js'
import type { AgentTypeConfig } from './config.js'

function getAgentTypeConfig(type: string | undefined): AgentTypeConfig | undefined {
  if (!type) return undefined
  return AGENT_TYPES[type]
}

// ── Skills 加载 ─────────────────────────────────────────

async function loadSkillsByName(names: string[]): Promise<string[]> {
  if (names.length === 0) return []
  try {
    const { listSkills } = await import('./skills/registry.js')
    const all = await listSkills()
    const prompts: string[] = []
    for (const name of names) {
      const skill = all.find(s => s.def.name === name)
      if (skill?.def.systemPrompt) {
        prompts.push(`── Skill: ${name} ──\n${skill.def.systemPrompt}`)
      }
    }
    return prompts
  } catch {
    return []
  }
}

// ── Types ───────────────────────────────────────────────

export type AgentEventType = 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'goal_check'

export interface AgentEvent {
  type: AgentEventType
  data: Record<string, unknown>
  iteration: number
}

export type AgentEventCallback = (event: AgentEvent) => void

/** 停止条件检查结果 */
export interface GoalCheckResult {
  met: boolean
  reason: string
}

export interface AgentLoopConfig {
  apiClient?: ApiClient
  systemPrompt?: string
  maxIterations?: number
  maxTokens?: number
  agentType?: string
  model?: string
  sessionId?: string
  autoPersist?: boolean
  /** 可选的 AbortSignal，用于超时/取消 (spawn/background 传入) */
  abortSignal?: AbortSignal
  /** 实时事件回调（用于 SSE 流推送） */
  onEvent?: AgentEventCallback
  /** 可验证的停止条件——每次工具调用后检查，达标则提前结束 */
  stopCondition?: (context: ContextManager) => Promise<GoalCheckResult>
  /** 最大 token 消耗预算（超了强制结束） */
  tokenBudget?: number
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
  reasoning?: string
  error?: string
}

/** 执行过程中的状态快照，用于 checkpoint 注入 */
interface StateSnapshot {
  filesRead: Set<string>
  filesWritten: Set<string>
  decisions: string[]
  currentGoal: string
  iteration: number
  toolsCalled: number
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

/** 关键行为指令（独立于 system prompt，用于强化注入） */
const CORE_INSTRUCTIONS = `## 核心行为规则

1. 始终使用工具完成任务。不要仅凭已有知识回答技术问题——先读代码再下结论。
2. 工具调用用 \`\`\`json [{ "function": "ToolName", "args": "..." }] \`\`\` 格式。
3. 每次迭代可以调多个工具，全部放在一个 JSON 数组里。
4. 读完工具输出后再决定下一步。先分析，后行动。
5. 任务全部完成之前不要提前结束。完成后给出改动总结。
6. 如果需要修改代码，优先用 write/edit 工具。`

/** Checkpoint 注入间隔 */
const CHECKPOINT_INTERVAL = 5

// ── AgentLoop ────────────────────────────────────────────

export class AgentLoop {
  private context: ContextManager
  private apiClient: ApiClient
  private maxIterations: number
  private totalTokensUsed = 0
  private abortSignal?: AbortSignal
  private lastReasoning: string | undefined
  private _remindedWrite = false
  private _actuallyWrote = false  // 记录整个 session 中是否调用了 write/edit 工具

  // Phase 3: 状态跟踪
  private state: StateSnapshot = {
    filesRead: new Set(),
    filesWritten: new Set(),
    decisions: [],
    currentGoal: '',
    iteration: 0,
    toolsCalled: 0,
  }
  private _lastCheckpointIteration = 0
  private _instructionsInjected = false

  /** Agent type（过滤 tools/MCP/skills） */
  private agentType: string | undefined
  private model: string | undefined

  private onEvent?: AgentEventCallback
  private stopCondition?: (context: ContextManager) => Promise<GoalCheckResult>
  private tokenBudget: number
  private tokenBudgetExceeded = false

  // ── Goal evaluator 缓存 ──
  private _lastEvalContent: string | null = null
  private _lastEvalResult: GoalCheckResult | null = null

  constructor(config: AgentLoopConfig = {}) {
    this.context = new ContextManager({
      id: config.sessionId,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      maxTokens: config.maxTokens ?? 999999,
      autoPersist: config.autoPersist ?? true,
    })
    this.apiClient = config.apiClient ?? { chatCompletion }
    this.maxIterations = config.maxIterations ?? 30
    this.abortSignal = config.abortSignal
    this.agentType = config.agentType
    this.model = config.model
    this.onEvent = config.onEvent
    this.stopCondition = config.stopCondition
    this.tokenBudget = config.tokenBudget ?? Infinity
  }

  /** 发射实时事件（如果已配置 onEvent 回调） */
  private emit(type: AgentEventType, data: Record<string, unknown>): void {
    if (this.onEvent) {
      this.onEvent({ type, data, iteration: this.state.iteration })
    }
  }

  /** 获取底层的 ContextManager（用于外部访问消息/状态） */
  getContext(): ContextManager {
    return this.context
  }

  async run(task: string): Promise<AgentLoopResult> {
    this.state.currentGoal = task
    this.context.addMessage({ role: 'user', content: task })

    // ── 获取 agent type 配置（按类型过滤 tools/MCP/skills） ──
    const agentCfg = getAgentTypeConfig(this.agentType)
    const builtinNames = agentCfg?.builtinToolNames ?? []
    const mcpServers = agentCfg?.mcpServers
    const skillNames = agentCfg?.skillNames

    // ── 首轮注入工具说明（含完整参数 schema） ────────────
    const tools = this.agentType
      ? listToolsByType(builtinNames, mcpServers)
      : listTools()
    const toolDetailLines = tools.map(t => {
      const schema = getToolSchemas().find(s => s.function.name === t.name)
      if (!schema) return `- ${t.name}: ${t.description || '(no description)'}`

      const props = schema.function.parameters?.properties
      const required = schema.function.parameters?.required as string[] | undefined
      let paramText = ''
      if (props && typeof props === 'object' && Object.keys(props as object).length > 0) {
        const entries = Object.entries(props as Record<string, { type?: string; description?: string; enum?: string[] }>)
        paramText = '\n    参数:\n' + entries.map(([k, v]) => {
          const typeStr = v.enum ? `enum[${v.enum.join('|')}]` : (v.type ?? 'any')
          const reqMark = required?.includes(k) ? ' (必填)' : ''
          return `      ${k}${reqMark}: ${typeStr} — ${v.description ?? ''}`
        }).join('\n')
      }

      return `- ${t.name}: ${t.description || '(no description)'}${paramText}`
    }).join('\n')

    const toolFormat = `你可以调用以下工具来协助完成任务。工具通过 JSON 格式调用：

\`\`\`json
[{"function": "ToolName", "args": "{\\"param1\\": \\"value1\\", \\"param2\\": \\"value2\\"}"}]
\`\`\`

其中 args 是一个 JSON 字符串（即 JSON.stringify(实际参数对象) 的结果），执行时会被自动解析。

### 可用工具

${toolDetailLines}

### 调用规则

1. 每次迭代可以调用多个工具（放在一个 JSON 数组里）
2. 工具调用的输出会在下一轮迭代提供
3. 阅读工具输出后决定下一步行动
4. 在任务目标全部完成之前，不要提前结束
5. 任务全部完成后，给出总结`

    // ── 加载 skills（如果 agent type 配置了） ──────────────
    let skillPrompt = ''
    if (skillNames && skillNames.length > 0) {
      const skillPrompts = await loadSkillsByName(skillNames)
      if (skillPrompts.length > 0) {
        skillPrompt = '\n\n── Skills ──\n' + skillPrompts.join('\n\n')
      }
    }

    // ── 合成最终 system prompt ─────────────────────────
    const currentSys = this.context.getSystemPrompt()
    const hasToolFormat = currentSys.includes('你可以调用以下工具')
    let updatedSys = currentSys
    if (!hasToolFormat) {
      updatedSys += '\n\n' + toolFormat
    }
    if (skillPrompt && !currentSys.includes(skillNames?.[0] ?? '')) {
      updatedSys += skillPrompt
    }
    this.context.updateSystemPrompt(updatedSys)

    // ── 首轮注入核心指令 ────────────────────────────
    this._injectCoreInstructions()

    for (let i = 0; i < this.maxIterations; i++) {
      this.state.iteration = i + 1

      // Check abort signal
      if (this.abortSignal?.aborted) {
        const lastMsg = this.context.getLastMessage()
        return {
          success: false,
          output: lastMsg?.content ?? '(cancelled)',
          iterations: i + 1,
          totalTokens: this.totalTokensUsed,
      reasoning: this.lastReasoning,
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
        const writeReminder = '⚠️ 你已经读了多次文件但从未产出任何代码改动。\n\n' +
          '请立即使用 write 或 edit 工具写文件。每个工具的可用参数已在上方列出。\n' +
          'edit 工具接受: path (必填), old_string/old_content (replace 模式用), new_string (必填)。\n\n' +
          '示例:\n' +
          '[{"function": "edit", "args": "{\\"path\\":\\"src/file.ts\\",\\"old_string\\":\\"旧内容\\",\\"new_string\\":\\"新内容\\"}"}]\n\n' +
          '或使用 write 创建新文件:\n' +
          '[{"function": "write", "args": "{\\"path\\":\\"src/new.ts\\",\\"content\\":\\"// 代码\\"}"}]\n\n' +
          '这是最后一次通过工具产出代码的机会。再不产出代码就结束了。'
        this.context.addMessage({ role: 'user', content: writeReminder })
        log.warn(`Forced write reminder at iteration ${i + 1} (reads=${readCount}, writes=0)`)
        continue
      }

      // ── Phase 3: Checkpoint 注入 ───────────────────
      // 每 CHECKPOINT_INTERVAL 轮注入一次进度状态
      if (i > 0 && i % CHECKPOINT_INTERVAL === 0 && i !== this._lastCheckpointIteration) {
        this._lastCheckpointIteration = i
        this._injectCheckpoint()

        // 同时在 checkpoint 时强化核心指令
        this._reinforceInstructions()
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

      // ── 发射 thinking 事件 ──
      // 从 content 中移去 tool_calls JSON 块，剩余部分为 thinking 文本
      let thinkingText = content
      const jsonBlockPattern = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/g
      thinkingText = thinkingText.replace(jsonBlockPattern, '').trim()
      if (thinkingText) {
        this.emit('thinking', { content: thinkingText })
      }

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
          this.state.toolsCalled++

          // ── 发射 tool_call 事件 ──
          this.emit('tool_call', { id: tc.id, name: tc.name, args: tc.args })

          // Phase 3: 跟踪文件操作
          this._trackToolCall(tc)
          
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
          let parsedArgs: Record<string, unknown> | string = {}
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
          // 当 LLM 传的是裸字符串而非 JSON 对象时，按工具名包装为对象
          if (typeof parsedArgs === 'string' && parsedArgs.length > 0) {
            const argKey = ({ read: 'path', bash: 'command', ls: 'path', glob: 'pattern', write: 'path' })[tc.name]
            if (argKey) {
              parsedArgs = { [argKey]: parsedArgs }
            }
          }

          // ── Tool retry: executeTool 内部已做 retry — 这里只汇报 ──
          const result = await executeTool(tc.name, typeof parsedArgs === 'string' ? {} : parsedArgs)
          this.context.addToolResult(
            tc.id ?? `call_${i}_0`,
            result.success ? result.output : `Error: ${result.error ?? 'Unknown error'}`,
          )

          // ── 发射 tool_result 事件 ──
          this.emit('tool_result', {
            id: tc.id ?? `call_${i}_0`,
            name: tc.name,
            success: result.success,
            output: result.success
              ? result.output.slice(0, 500)
              : (result.error ?? 'Unknown error'),
          })
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

      // ── Goal condition check ──────────────────────
      if (this.stopCondition) {
        // 缓存：如果 agent 输出没变化，复用上次评估结果
        const lastMsg = this.context.getLastMessage()
        const currentContent = lastMsg?.content ?? ''
        if (currentContent && currentContent === this._lastEvalContent && this._lastEvalResult) {
          log.info(`Goal evaluator cache hit (content unchanged, reusing previous result)`)
          const goalResult = this._lastEvalResult
          this.emit('goal_check', { met: goalResult.met, reason: `${goalResult.reason} (cached)` })
          if (goalResult.met) {
            return this.buildResult(lastMsg?.content ?? `✅ ${goalResult.reason}`, i + 1)
          }
        } else {
          // 有新输出 → 调 evaluator
          const goalResult = await this.stopCondition(this.context)
          this._lastEvalContent = currentContent
          this._lastEvalResult = goalResult
          this.emit('goal_check', { met: goalResult.met, reason: goalResult.reason })
          if (goalResult.met) {
            log.info(`Goal condition met: ${goalResult.reason}`)
            return this.buildResult(lastMsg?.content ?? `✅ ${goalResult.reason}`, i + 1)
          }
        }
      }

      // ── Token budget check ────────────────────────
      if (this.totalTokensUsed >= this.tokenBudget) {
        this.tokenBudgetExceeded = true
        log.warn(`Token budget exceeded: ${this.totalTokensUsed} >= ${this.tokenBudget}`)
        const lastMsg = this.context.getLastMessage()
        return this.buildResult(
          lastMsg?.content ?? `(stopped — token budget ${this.tokenBudget} exceeded after ${i + 1} iterations)`,
          i + 1,
        )
      }
    }

    // 超迭代次数
    const lastMsg = this.context.getLastMessage()
    return this.buildResult(lastMsg?.content ?? '(no output after max iterations)', this.maxIterations)
  }

  // ── Phase 3: 状态跟踪 ──────────────────────────────

  /** 从工具调用中提取文件路径，更新状态 */
  private _trackToolCall(tc: { name: string; args: string }): void {
    // 从 args 中提取文件路径
    const filePattern = /['"]?(?:file|path|src|target)['"]?\s*[:=]\s*['"]([^'"]+)['"]/i
    const match = filePattern.exec(tc.args)
    const filePath = match?.[1]

    if (filePath) {
      if (tc.name === 'read' || tc.name === 'grep' || tc.name === 'ls' || tc.name === 'glob') {
        this.state.filesRead.add(filePath)
      } else if (tc.name === 'write' || tc.name === 'edit' || tc.name === 'write_file' || tc.name === 'edit_file') {
        this.state.filesWritten.add(filePath)
      }
    }

    // 决策跟踪：bash 中的关键命令
    if (tc.name === 'bash') {
      const cmdText = tc.args.toLowerCase()
      if (cmdText.includes('install') || cmdText.includes('npm ') || cmdText.includes('pip ')) {
        this.state.decisions.push(`installed dependencies: ${tc.args.slice(0, 80)}`)
      }
      if (cmdText.includes('git commit') || cmdText.includes('git add')) {
        this.state.decisions.push('committed changes to git')
      }
      if (cmdText.includes('rm -rf') || cmdText.includes('rm -r')) {
        this.state.decisions.push(`removed: ${tc.args.slice(0, 60)}`)
      }
    }
  }

  /** 注入进度 checkpoint（每 5 轮） */
  private _injectCheckpoint(): void {
    const filesRead = [...this.state.filesRead]
    const filesWritten = [...this.state.filesWritten]
    const decisions = this.state.decisions

    let summary = `[进度检查点 — 第 ${this.state.iteration}/${this.maxIterations} 轮]\n`
    summary += `当前目标: ${this.state.currentGoal.slice(0, 200)}\n`
    
    if (filesRead.length > 0) {
      summary += `已读文件 (${filesRead.length}): ${filesRead.slice(-5).join(', ')}${filesRead.length > 5 ? ` ...` : ''}\n`
    }
    if (filesWritten.length > 0) {
      summary += `已修改文件 (${filesWritten.length}): ${filesWritten.join(', ')}\n`
    }
    if (decisions.length > 0) {
      summary += `关键决策: ${decisions.slice(-3).join('; ')}\n`
    }
    summary += `已调用工具: ${this.state.toolsCalled} 次\n`
    summary += `请继续推进，离完成目标还有距离。如果需要调整方向，说明原因。`

    this.context.addMessage({ role: 'user', content: summary })
    log.info(`Checkpoint injected at iteration ${this.state.iteration}`)
  }

  /** 注入核心行为指令（首轮用） */
  private _injectCoreInstructions(): void {
    if (this._instructionsInjected) return
    this._instructionsInjected = true
    // 核心指令放在首轮 toolFormat 之后，作为独立的 user message 强化
    this.context.addMessage({ role: 'user', content: CORE_INSTRUCTIONS })
  }

  /** 强化指令（checkpoint 时附带） */
  private _reinforceInstructions(): void {
    this.context.addMessage({
      role: 'user',
      content: `[指令提醒]\n${CORE_INSTRUCTIONS.split('\n').slice(0, 4).join('\n')}`,
    })
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
      reasoning: this.lastReasoning,
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
      model: this.model,
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
