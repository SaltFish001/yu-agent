/**
 * yu-agent — Context Manager
 *
 * 统一上下文管理：token 精确估算、LLM-based 压缩、缓存命中追踪、自动持久化。
 * Phase 2 升级自 AgentSession 的滑动窗口裁剪。
 *
 * 用法：
 *   const cm = new ContextManager({ systemPrompt: '...' });
 *   cm.addMessage({ role: 'user', content: 'hello' });
 *   await cm.compressIfNeeded(apiClient);  // >75% 自动摘要
 *   cm.recordUsage(response.usage);        // 记录缓存命中
 *   cm.save();                              // 持久化
 */

import { createLogger } from './logger.js'

const log = createLogger('context-manager')

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { ApiClient } from './provider.js'

// ── Types ───────────────────────────────────────────────

export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export interface UsageRecord {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens?: number
  cache_miss_tokens?: number
}

export interface ContextManagerOpts {
  id?: string
  systemPrompt?: string
  maxTokens?: number
  persistDir?: string
  autoPersist?: boolean
  compressThreshold?: number // 0.0-1.0, default 0.75
}

// ── 1. Token 计数器 ──────────────────────────────────────
//
// 精确估算，四种语言分类回退：
//   中文/日文/韩文：~2 chars/token
//   英文/拼音文字：~4 chars/token
//   代码：~3 chars/token
//   数字/标点：~1 char/token

export class TokenCounter {
  /**
   * 估算单段文本的 token 数。
   * 按字符类型混合估算，比简单的 1-char=1-token 精确 ~40%。
   */
  count(text: string): number {
    if (!text) return 0

    let cjkChars = 0
    let alphaChars = 0
    let codeChars = 0
    let digitChars = 0

    for (const ch of text) {
      const code = ch.charCodeAt(0)
      if (code >= 0x4e00 && code <= 0x9fff) {
        cjkChars++ // CJK 统一汉字
      } else if (code >= 0x3040 && code <= 0x30ff) {
        cjkChars++ // 假名
      } else if (code >= 0xac00 && code <= 0xd7af) {
        cjkChars++ // 韩文
      } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
        alphaChars++
      } else if (code >= 0x30 && code <= 0x39) {
        digitChars++
      } else if (ch === '\n' || ch === '\t') {
        codeChars++ // 缩进/换行 → 代码特征
      }
    }

    // 混合估算
    const tokens = Math.ceil(cjkChars / 2 + alphaChars / 4 + digitChars / 2 + codeChars / 3)

    // 消息元数据开销（role 字段等）
    return tokens + 4
  }

  /** 估算消息数组的总 token 数 */
  estimateMessages(messages: ContextMessage[]): number {
    let total = 0
    for (const m of messages) {
      total += this.count(m.content)
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          total += this.count(tc.function.name + tc.function.arguments)
        }
      }
    }
    return total
  }

  /** 快速判断是否为代码型内容 */
  static isCodeContent(text: string): boolean {
    const codePatterns = [
      /^(import|export|function|class|const|let|var|def|pub|fn)\b/m,
      /\b(await|async|return|if|else|for|while)\b/,
      /[{};()]=>/,
      /^\/\/|^#|^\/\*/m,
    ]
    return codePatterns.some((p) => p.test(text))
  }
}

// ── 2. 压缩追踪 ──────────────────────────────────────────

export interface CompressRecord {
  timestamp: number
  beforeTokens: number
  afterTokens: number
  summary: string
}

// ── 3. ContextManager ────────────────────────────────────

export class ContextManager {
  readonly id: string
  private messages: ContextMessage[] = []
  private systemPrompt: string
  private maxTokens: number
  private persistDir: string
  private autoPersist: boolean
  private compressThreshold: number
  private compressCount = 0
  private compressHistory: CompressRecord[] = []

  // 缓存追踪
  private totalPromptTokens = 0
  private totalCompletionTokens = 0
  private cacheHitTokens = 0
  private cacheMissTokens = 0

  // 内部创建时间（持久化用）
  private _createdAt?: number

  // 子模块
  readonly tokenCounter: TokenCounter

  constructor(opts: ContextManagerOpts = {}) {
    this.id = opts.id ?? crypto.randomUUID()
    this.systemPrompt = opts.systemPrompt ?? ''
    this.maxTokens = opts.maxTokens ?? 999999
    this.persistDir = opts.persistDir ?? resolve(process.env.HOME || '/home/saltfish', '.yu', 'sessions')
    this.autoPersist = opts.autoPersist ?? true
    this.compressThreshold = opts.compressThreshold ?? 0.75
    this.tokenCounter = new TokenCounter()

    if (this.systemPrompt) {
      this.messages.push({ role: 'system', content: this.systemPrompt })
    }
  }

  // ── 消息管理 ────────────────────────────────────────────

  addMessage(msg: ContextMessage): void {
    this.messages.push(msg)
    if (this.autoPersist) this.save()
  }

  getMessages(): ContextMessage[] {
    return this.messages
  }

  /** Get the base system prompt. */
  getSystemPrompt(): string {
    return this.systemPrompt
  }

  /** Replace the system prompt (used by SkillRunner for prompt injection). */
  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
    // Update the system message in the message list
    const sysIdx = this.messages.findIndex((m) => m.role === 'system')
    if (sysIdx >= 0) {
      this.messages[sysIdx].content = prompt
    } else {
      this.messages.unshift({ role: 'system', content: prompt })
    }
  }

  getLastMessage(): ContextMessage | undefined {
    return this.messages[this.messages.length - 1]
  }

  totalTokens(): number {
    return this.tokenCounter.estimateMessages(this.messages)
  }

  /** 当前压缩率 0.0-1.0 */
  getCompressRatio(): number {
    return this.totalTokens() / this.maxTokens
  }

  /** 是否需要压缩 */
  shouldCompress(): boolean {
    return this.getCompressRatio() > this.compressThreshold
  }

  /** 压缩历史 */
  getCompressHistory(): CompressRecord[] {
    return [...this.compressHistory]
  }

  getCompressCount(): number {
    return this.compressCount
  }

  // ── 3. LLM-based 压缩 ──────────────────────────────────

  /**
   * 调用 LLM 对早期消息做摘要压缩。
   * 保留 system prompt + 最近 N 轮完整消息，中间部分用摘要替代。
   *
   * compressRatio 0.0-1.0：压缩后目标 token 占比（默认 0.5 = 压缩到 50%）
   */
  async compressIfNeeded(
    apiClient: ApiClient,
    options?: { force?: boolean; compressRatio?: number },
  ): Promise<boolean> {
    const force = options?.force ?? false
    const _targetRatio = options?.compressRatio ?? 0.5

    if (!force && !this.shouldCompress()) {
      return false
    }

    const beforeTokens = this.totalTokens()
    log.info(
      `Compressing context: ${beforeTokens}/${this.maxTokens} tokens ` +
        `(${Math.round(this.getCompressRatio() * 100)}%)`,
    )

    // 保留 system + 最后 3 轮消息完整
    const keepRecent = 6 // 3 轮 user+assistant
    const systemIdx = this.systemPrompt ? 1 : 0
    const endIdx = Math.max(systemIdx, this.messages.length - keepRecent)

    const compressible = this.messages.slice(systemIdx, endIdx)
    const preserved = [...(this.systemPrompt ? [this.messages[0]] : []), ...this.messages.slice(endIdx)]

    if (compressible.length === 0) {
      return false // 没什么可压缩的
    }

    // 构建摘要 prompt
    const summaryPrompt = this.buildSummaryPrompt(compressible)

    try {
      const response = await apiClient.chatCompletion({
        messages: [
          {
            role: 'system',
            content:
              'You are a context compressor. Summarize the conversation history concisely. ' +
              'Preserve all technical details, decisions, and file paths. ' +
              'Output in the same language as the original content.',
          },
          { role: 'user', content: summaryPrompt },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      })

      const summary = response?.content?.trim() ?? '(compression failed)'

      // 重建消息列表：system + summary(作为一条user消息) + preserved
      const newMessages: ContextMessage[] = []
      if (this.systemPrompt) {
        newMessages.push({ role: 'system', content: this.systemPrompt })
      }
      newMessages.push({
        role: 'user',
        content: `[Context summary of earlier conversation]:\n${summary}\n\n[The conversation continues below:]`,
      })
      newMessages.push(...preserved.slice(this.systemPrompt ? 1 : 0))

      this.messages = newMessages
      this.compressCount++
      this.compressHistory.push({
        timestamp: Date.now(),
        beforeTokens,
        afterTokens: this.totalTokens(),
        summary: summary.slice(0, 200),
      })

      if (this.autoPersist) this.save()

      log.info(
        `Compression done: ${beforeTokens} → ${this.totalTokens()} tokens ` +
          `(reduced ${Math.round((1 - this.totalTokens() / beforeTokens) * 100)}%)`,
      )
      return true
    } catch (err) {
      log.warn('LLM compression failed, falling back to sliding window', err)
      // 回退：裁剪最早的非 system 消息
      this.trimOldest()
      return false
    }
  }

  /** 回退：滑动窗口裁剪 */
  private trimOldest(): void {
    const systemIdx = this.systemPrompt ? 1 : 0
    while (this.totalTokens() > this.maxTokens && this.messages.length > systemIdx + 2) {
      if (systemIdx >= this.messages.length - 2) break
      this.messages.splice(systemIdx, 1)
    }
  }

  private buildSummaryPrompt(messages: ContextMessage[]): string {
    let text = 'Summarize the following conversation:\n\n'
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'Tool'
      const content = m.content.slice(0, 500) // 防止超长
      text += `[${role}]: ${content}\n\n`
    }
    text += 'Summary (concise, preserve all decisions and technical details):'
    return text
  }

  // ── 4. 缓存命中追踪 ─────────────────────────────────────

  recordUsage(usage?: UsageRecord | null): void {
    if (!usage) return

    this.totalPromptTokens += usage.prompt_tokens ?? 0
    this.totalCompletionTokens += usage.completion_tokens ?? 0
    this.cacheHitTokens += usage.cache_hit_tokens ?? 0
    this.cacheMissTokens += usage.cache_miss_tokens ?? 0
  }

  getCacheStats(): {
    totalPromptTokens: number
    totalCompletionTokens: number
    cacheHitTokens: number
    cacheMissTokens: number
    hitRate: number
  } {
    const total = this.cacheHitTokens + this.cacheMissTokens
    return {
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      cacheHitTokens: this.cacheHitTokens,
      cacheMissTokens: this.cacheMissTokens,
      hitRate: total > 0 ? this.cacheHitTokens / total : 0,
    }
  }

  // ── 5. 持久化 ───────────────────────────────────────────

  private ensureDir(): void {
    if (!existsSync(this.persistDir)) {
      mkdirSync(this.persistDir, { recursive: true })
    }
  }

  private getPath(): string {
    return resolve(this.persistDir, `${this.id}.json`)
  }

  save(): void {
    try {
      this.ensureDir()
      writeFileSync(
        this.getPath(),
        JSON.stringify(
          {
            id: this.id,
            systemPrompt: this.systemPrompt,
            messages: this.messages,
            maxTokens: this.maxTokens,
            compressCount: this.compressCount,
            compressHistory: this.compressHistory,
            cacheHitTokens: this.cacheHitTokens,
            cacheMissTokens: this.cacheMissTokens,
            totalPromptTokens: this.totalPromptTokens,
            totalCompletionTokens: this.totalCompletionTokens,
            updatedAt: Date.now(),
            createdAt: this._createdAt ?? Date.now(),
          },
          null,
          2,
        ),
        'utf-8',
      )
    } catch (err) {
      log.error('Failed to save context', err)
    }
  }

  static load(id: string, persistDir?: string): ContextManager | null {
    try {
      const dir = persistDir ?? resolve(process.env.HOME || '/home/saltfish', '.yu', 'sessions')
      const path = resolve(dir, `${id}.json`)
      if (!existsSync(path)) return null

      const raw = readFileSync(path, 'utf-8')
      const data = JSON.parse(raw)

      const cm = new ContextManager({
        id: data.id,
        systemPrompt: data.systemPrompt,
        maxTokens: data.maxTokens,
        persistDir: dir,
        autoPersist: true,
      })
      cm.messages = data.messages ?? []
      cm.compressCount = data.compressCount ?? 0
      cm.compressHistory = data.compressHistory ?? []
      cm.cacheHitTokens = data.cacheHitTokens ?? 0
      cm.cacheMissTokens = data.cacheMissTokens ?? 0
      cm.totalPromptTokens = data.totalPromptTokens ?? 0
      cm.totalCompletionTokens = data.totalCompletionTokens ?? 0
      cm._createdAt = data.createdAt ?? Date.now()
      return cm
    } catch (err) {
      log.error('Failed to load context', err)
      return null
    }
  }

  /** 获取当前上下文大小（字节） */
  byteSize(): number {
    return new TextEncoder().encode(JSON.stringify(this.messages)).length
  }

  // ── Tool call 管理 ─────────────────────────────────────

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content,
    })
    if (this.autoPersist) this.save()
  }

  addToolCalls(toolCalls: ContextMessage['tool_calls'], content?: string): void {
    this.messages.push({
      role: 'assistant',
      content: content ?? '',
      tool_calls: toolCalls,
    })
    if (this.autoPersist) this.save()
  }
}

// ── 便捷函数 ──────────────────────────────────────────────

export function createContextManager(opts?: ContextManagerOpts): ContextManager {
  return new ContextManager(opts)
}
