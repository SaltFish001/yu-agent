/**
 * yu-agent — 缓存友好的子 agent 调度层 (Cache-First Spawn)
 *
 * 复刻 Reasonix 的 Cache-First Loop 三区域模型：
 *
 *   IMMUTABLE PREFIX  ← session 创建时固定（system prompt + tool schema）
 *   APPEND-ONLY LOG    ← 单调追加，不插入不修改
 *   VOLATILE SCRATCH   ← 调度器中间状态，不上送到 API
 *
 * 所有子 agent 共享同一个 Pi AgentSession，保证前缀缓存连续命中。
 * 工具输出超过阈值时自动压缩（turn-end compaction）。
 */

import { createLogger } from './logger.js';
import { webSearch, webExtract } from './browser/index.js';
import { shutdownManager } from './lifecycle.js';
const log = createLogger('spawn');

import type { AssistantMessage } from '@earendil-works/pi-ai';

import { getAgentTypeConfig } from './config.js';

import { Type } from 'typebox';

import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PI_AGENT_DIR, POOL_SESSIONS_DIR } from './paths.js';
import { getSessionTag } from './session-context.js';
import { insertTokenUsage } from './db.js';

// ── 配置常量 ──────────────────────────────────────────

/** 工具输出压缩阈值（超过此长度的结果被自动摘要） */
const RESULT_CAP_TOKENS = 3000;

/** session 最大轮数后自动重置（防止上下文无限膨胀） */
const MAX_TURNS_PER_SESSION = 300;

/** session 累计输入 token 上限后自动重置（防止上下文无限膨胀） */
// DeepSeek V4 系列支持 1M context window，保留 10% 余量
const MAX_TOKENS_PER_SESSION = 900_000;

/** 上下文压缩触发阈值：当上下文用量超过 context window 此比例时触发压缩 */
const CONTEXT_COMPRESSION_THRESHOLD = 0.75;

// ── 类型 ──────────────────────────────────────────────

export interface SpawnConfig {
  type: string;
  model: string;
  thinking?: string;
  maxTurns: number;
  task: string;
  files?: string[];
  context?: Record<string, unknown>;
  timeout: number;
  /** Team context for mailbox polling (team-aware spawns) */
  teamRunId?: string;
  memberName?: string;
  /** 使用独立 session 调用，不污染共享缓存（用于调度器等临时任务） */
  isolated?: boolean;
}

export interface SpawnResult {
  response: string;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Wall-clock duration of the API call in ms. */
  durationMs?: number;
  /** Model used for this call. */
  model?: string;
  /** Session tag for this call. */
  sessionTag?: string;
  /** Agent type for this call. */
  agentType?: string;
}

interface CacheStats {
  totalHits: number;
  totalMisses: number;
  totalCost: number;
  turnCount: number;
  hitRate: number;
}

// ── 辅助：提取 assistant 响应文本 ────────────────────

/**
 * 从 AgentSession 的消息列表中提取新增的 assistant 响应文本。
 * AgentMessage.content 类型为 string | (TextContent | ImageContent)[]，
 * 这里统一转成纯文本。
 */
function extractAssistantResponse(
  messages: { role: string; content?: unknown }[],
): string {
  return messages
    .filter((m) => m.role === 'assistant')
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c: unknown) => (c as { type?: string }).type === 'text')
          .map((c: unknown) => (c as { text?: string }).text ?? '')
          .join('\n');
      }
      return '';
    })
    .join('\n');
}

// ── Turn-end compaction ──────────────────────────────

function compactResult(text: string, maxLen: number = RESULT_CAP_TOKENS): string {
  if (text.length <= maxLen) return text;
  const head = text.slice(0, Math.floor(maxLen / 2));
  const tail = text.slice(-Math.floor(maxLen / 2));
  return `${head}\n\n[... ${text.length - maxLen} chars compressed ...]\n\n${tail}`;
}

// ── 三区域上下文管理器 ──────────────────────────────

export class SessionPool {
  private session: AgentSession | null = null;
  private turnCount = 0;
  private totalTokensUsed = 0;
  private sessionOptions: CreateAgentSessionOptions | null = null;
  private stats: CacheStats = {
    totalHits: 0,
    totalMisses: 0,
    totalCost: 0,
    turnCount: 0,
    hitRate: 0,
  };

  /**
   * Optional persistence directory for session continuity across process restarts.
   * When set, sessions are saved to disk and resumed on next init().
   * Each pool type gets its own subdirectory for isolation.
   */
  private persistDir: string | null = null;

  /** Enable disk persistence for this pool. Sessions survive process restarts. */
  setPersist(_poolType: string, dir: string): void {
    this.persistDir = dir;
  }
  /** Serialization mutex: prevents concurrent call() from corrupting shared session */
  private _callMutex: Promise<void> = Promise.resolve();

  /**
   * Serialize concurrent access to the shared session.
   * Ensures only one call() executes at a time.
   */
  private async _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._callMutex;
    let release: () => void;
    this._callMutex = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  async init(options: CreateAgentSessionOptions): Promise<void> {
    this.dispose();

    // 如果 resourceLoader 是 DefaultResourceLoader，需要先 reload()
    const loader = options.resourceLoader;
    if (loader && 'reload' in loader && typeof (loader as DefaultResourceLoader).reload === 'function') {
      await (loader as DefaultResourceLoader).reload();
    }

    const result = await createAgentSession(options);
    this.session = result.session;
    this.sessionOptions = options;
    this.turnCount = 0;
    this.totalTokensUsed = 0;
    log.info('New session created (prefix pinned)');
  }

  async call(task: string, spawnCfg: SpawnConfig): Promise<SpawnResult> {
    return this._serialize(async () => {
      if (!this.session) {
        await this.init(this.buildDefaultConfig(spawnCfg));
      }

      // 检查上下文用量，若接近限制则先压缩再继续
      await this._compressIfNeeded();

      const needsReset =
        this.turnCount >= MAX_TURNS_PER_SESSION ||
        this.totalTokensUsed >= MAX_TOKENS_PER_SESSION;

      if (needsReset) {
        const reason = this.turnCount >= MAX_TURNS_PER_SESSION
          ? `${this.turnCount} turns`
          : `${this.totalTokensUsed} tokens`;
        log.info(`Session reset after ${reason}`);
        await this.init(this.sessionOptions!);
      }

      const session = this.session!;
      const beforeLen = session.messages.length;

      // Execute with retry for recoverable errors
      const result = await this._callWithRetry(session, task, spawnCfg, beforeLen);

      this.totalTokensUsed += result.totalTokens ?? 0;
      this.turnCount++;

      // Persist token usage to DB (fire-and-forget)
      this._persistTokenUsage(result, spawnCfg);

      return result;
    });
  }

  /**
   * Execute _doCall with retry logic for recoverable errors.
   * Recoverable: timeout, transient API errors.
   * Non-recoverable: validation errors, session corruption.
   */
  private async _callWithRetry(
    session: AgentSession,
    task: string,
    spawnCfg: SpawnConfig,
    beforeLen: number,
  ): Promise<SpawnResult> {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this._doCall(session, task, spawnCfg, beforeLen);
      } catch (err) {
        const isRecoverable =
          err instanceof Error &&
          (err.message.includes('timed out') ||
           err.message.includes('timeout') ||
           err.message.includes('ETIMEDOUT') ||
           err.message.includes('ECONNRESET') ||
           err.message.includes('rate limit') ||
           err.message.includes('429') ||
           err.message.includes('503') ||
           err.message.includes('Service Unavailable'));

        log.error(`Session call failed (attempt ${attempt}/${maxAttempts})`, err, {
          type: spawnCfg.type,
          task: task.slice(0, 100),
          recoverable: isRecoverable,
        });

        if (attempt < maxAttempts && isRecoverable) {
          log.info(`Retrying after recoverable error (attempt ${attempt})`);
          // Brief backoff before retry
          await new Promise<void>((r) => setTimeout(r, 1_000 * attempt));
          continue;
        }

        throw err;
      }
    }
    // Unreachable
    throw new Error('Unexpected: callWithRetry exhausted without returning or throwing');
  }

  /**
   * 检查会话上下文用量，若接近 context window 限制则触发 Pi SDK 内置压缩。
   * 压缩后保留关键摘要，丢弃旧的工具调用细节，释放上下文空间。
   */
  private async _compressIfNeeded(): Promise<void> {
    const session = this.session;
    if (!session) return;

    try {
      const usage = session.getContextUsage();
      if (!usage || usage.percent === null) return;

      if (usage.percent >= CONTEXT_COMPRESSION_THRESHOLD) {
        log.info(`Context at ${(usage.percent * 100).toFixed(0)}% (${usage.tokens}/${usage.contextWindow}), triggering compression...`);
        await session.compact(
          'Compress the conversation history: keep the key context (task goals, decisions, file changes) ' +
          'and discard old tool call details. Preserve the overall flow so work can continue.',
        );
        log.info('Context compression complete');
      }
    } catch (err) {
      // 压缩是尽力而为的操作，失败不影响继续执行
      log.warn('Context compression failed (non-fatal)', err);
    }
  }

  /**
   * 对 session.prompt() 加上超时控制。
   * 超时后调用 session.abort() 防止卡死。
   */
  private async _promptWithTimeout(
    session: AgentSession,
    text: string,
    timeoutMs: number,
    opts?: { expandPromptTemplates?: boolean },
  ): Promise<void> {
    const timedPromise = session.prompt(text, opts);
    if (timeoutMs <= 0) {
      await timedPromise;
      return;
    }

    // settled 守卫：防止 timer 回调在 timedPromise 已兑现后仍调用 session.abort()
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    // 用 .then() 在 timedPromise 兑现/拒绝时立即标记 settled，
    // 确保 timer 回调执行前先检查 settled 标志，避免重复兑现或误 abort。
    const guardedTimedPromise = timedPromise.then(
      (value) => { settled = true; return value; },
      (err)  => {
        // 如果已经 settled（timer 先触发），不抛异常——race 已经结束了
        if (settled) return undefined as never;
        settled = true;
        throw err;
      },
    );

    const abortPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        // timer 回调执行前先检查 settled 标志
        if (settled) return;
        settled = true;
        session.abort().catch(() => {});
        reject(new Error(`Session prompt timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      await Promise.race([guardedTimedPromise, abortPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * 使用临时独立 session 执行一次调用，不污染共享缓存池。
   * 适用于调度器（classifyIntent）等不应计入主会话的临时任务。
   */
  async callIsolated(task: string, spawnCfg: SpawnConfig): Promise<SpawnResult> {
    const { session: agentSession } = await createAgentSession(
      this.buildDefaultConfig(spawnCfg),
    );
    try {
      const result = await this._callWithRetry(agentSession, task, spawnCfg, 0);
      // Persist token usage to DB (fire-and-forget)
      this._persistTokenUsage(result, spawnCfg);
      return result;
    } catch (err) {
      log.error('Isolated session call failed', err, {
        type: spawnCfg.type,
        task: task.slice(0, 100),
      });
      throw err;
    } finally {
      try {
        (agentSession as unknown as { dispose?: () => void }).dispose?.();
      } catch {
        // ignore
      }
    }
  }

  /**
   * 共享的子调用逻辑：构建完整 task → prompt → 提取 response → 计算 usage → compact。
   * 被 call() 和 callIsolated() 共用，消除重复。
   * 同时累加公共统计（totalHits / totalMisses / totalCost / turnCount / hitRate）。
   */
  private async _doCall(
    session: AgentSession,
    task: string,
    spawnCfg: SpawnConfig,
    beforeLen: number,
  ): Promise<SpawnResult> {
    // Agent type 指令作为消息内容（不进 system prompt）
    const agentPrefix = this.buildAgentPrefix(spawnCfg);
    const suffix = this.buildTaskSuffix(spawnCfg);
    const fullTask = agentPrefix
      ? suffix
        ? `${agentPrefix}\n\n${task}\n\n${suffix}`
        : `${agentPrefix}\n\n${task}`
      : task;

    // APPEND-ONLY LOG: 只追加，不修改
    const startTime = Date.now();
    await this._promptWithTimeout(session, fullTask, spawnCfg.timeout);
    const durationMs = Date.now() - startTime;

    // 提取新增的 assistant 响应
    const newMessages = (session.messages as { role: string; content?: unknown }[]).slice(beforeLen);
    const response = extractAssistantResponse(newMessages);

    // 只取最后一条 assistant 消息的 usage（避免工具调用多轮重复计数）
    let cacheHit = 0;
    let cacheMiss = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let cost = 0;
    const assistantMsgs = newMessages.filter(
      (m): m is AssistantMessage => m.role === 'assistant',
    );
    if (assistantMsgs.length > 0) {
      const last = assistantMsgs[assistantMsgs.length - 1];
      cacheHit = last.usage.cacheRead;
      cacheMiss = last.usage.input;
      outputTokens = last.usage.output;
      totalTokens = last.usage.totalTokens;
      cost = last.usage.cost.total;
    }

    // 累积公共统计
    this.stats.totalHits += cacheHit;
    this.stats.totalMisses += cacheMiss;
    this.stats.totalCost += cost;
    this.stats.turnCount++;
    this.stats.hitRate =
      this.stats.totalHits + this.stats.totalMisses > 0
        ? this.stats.totalHits / (this.stats.totalHits + this.stats.totalMisses)
        : 0;

    // Turn-end compaction
    const compacted = compactResult(response);

    return {
      response: compacted,
      cacheHitTokens: cacheHit || undefined,
      cacheMissTokens: cacheMiss || undefined,
      outputTokens: outputTokens || undefined,
      totalTokens: totalTokens || undefined,
      durationMs,
      model: spawnCfg.model,
      sessionTag: getSessionTag(),
      agentType: spawnCfg.type,
    };
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Persist token usage to the token_usage table (fire-and-forget).
   * Uses sessionTag from SpawnResult if available, else spawnCfg info.
   */
  private _persistTokenUsage(result: SpawnResult, spawnCfg: SpawnConfig): void {
    if (!result.totalTokens && !result.cacheHitTokens && !result.outputTokens) return; // nothing useful to record
    try {
      insertTokenUsage({
        sessionTag: result.sessionTag || getSessionTag(),
        agentType: result.agentType || spawnCfg.type,
        model: spawnCfg.model,
        cacheHitTokens: result.cacheHitTokens,
        cacheMissTokens: result.cacheMissTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
        cost: 0, // cost is internal, not exposed via result
        durationMs: result.durationMs,
        turnCount: 1,
      });
    } catch {
      // best-effort
    }
  }

  /** 重置统计（用于测试） */
  resetStats(): void {
    this.stats = {
      totalHits: 0,
      totalMisses: 0,
      totalCost: 0,
      turnCount: 0,
      hitRate: 0,
    };
  }

  dispose(): void {
    if (this.session) {
      try {
        (this.session as unknown as { dispose?: () => void }).dispose?.();
      } catch {
        // ignore
      }
      this.session = null;
    }
    this.turnCount = 0;
    this.totalTokensUsed = 0;
  }

  private buildAgentPrefix(cfg: SpawnConfig): string {
    // per-type 指令已注入 system prompt（IMMUTABLE PREFIX），
    // user message 只带文件上下文和任务标记。
    const typeConfig = getAgentTypeConfig(cfg.type);
    if (typeConfig) {
      const files = cfg.files?.length
        ? `\n相关文件: ${cfg.files.join(', ')}`
        : '';
      return `[用户任务]${files}`;
    }

    // 回退：硬编码的简短提示
    const typeHints: Record<string, string> = {
      coding: '你是一个编码 agent，负责编写和修改代码。',
      review: '你是一个审查 agent，只读不改，返回审查意见。',
      plan: '你是一个计划 agent，负责分析代码结构并出技术方案。',
      lsp: '你是一个 LSP agent，负责检查并修复类型错误。',
      commit: '你是一个 git commit agent，负责生成 commit 信息。',
      doc: '你是一个文档 agent，负责生成代码文档。',
      search: '你是一个搜索 agent，负责搜索代码库或网页。',
    };

    const hint = typeHints[cfg.type] || '';
    const files = cfg.files?.length
      ? `\n相关文件: ${cfg.files.join(', ')}`
      : '';
    return `[系统指令]\n${hint}${files}\n\n[用户任务]`;
  }

  /**
   * 返回任务消息后缀（放在用户输入之后）。
   * 用于 scheduler 等需要强制输出格式的 agent 类型。
   * 利用 recency effect——LLM 倾向于以最后看到的指令为准。
   */
  private buildTaskSuffix(_cfg: SpawnConfig): string {
    // 格式提醒已注入 system prompt，user message 不再需要
    return '';
  }

  /**
   * 构建 session 配置。
   * 使用固定的工具集 + 默认模型（从 Pi settings 读取 opencode-go provider）。
   * 每次调用此方法返回相同的配置，保证 IMMUTABLE PREFIX 固定。
   */
  private buildDefaultConfig(cfg: SpawnConfig): CreateAgentSessionOptions {
    // scheduler 不需要工具——只管输出 JSON 调度；其他 type 用全集
    const isScheduler = cfg.type === 'general-purpose';
    const tools = isScheduler ? [] : UNIFIED_TOOLS;
    const options: CreateAgentSessionOptions = {
      tools,
      customTools: isScheduler ? [] : [READ_TERMINAL_TOOL, WEB_SEARCH_TOOL, WEB_EXTRACT_TOOL],
    };

    // 将 per-type 指令注入 system prompt（IMMUTABLE PREFIX 层），
    // 而非 user message——让指令本身也参与 API 层前缀缓存。
    const typeConfig = getAgentTypeConfig(cfg.type);
    if (typeConfig) {
      const agentDir = PI_AGENT_DIR;
      const typePrompt = typeConfig.systemPrompt;
      options.resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir,
        settingsManager: SettingsManager.create(process.cwd(), agentDir),
        appendSystemPromptOverride: (base) => [
          ...base,
          `[${typeConfig.displayName} 指令]\n${typePrompt}`,
        ],
        // 不加载技能/模板/主题——只取 system prompt
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
    }

    // 持久化 session：跨进程复用对话历史，让 API 层前缀缓存持续命中
    if (this.persistDir) {
      // persistDir 已包含 pool type 路径（由 getSessionPool 设置）
      mkdirSync(this.persistDir, { recursive: true });
      options.sessionManager = SessionManager.continueRecent(
        process.cwd(),
        this.persistDir,
      );
    }

    return options;
  }
}

// ── 全局 pool（按 type 分池 + 统一 tools）─────────────
//
// Reasonix Cache-First 三区域模型完整实现：
//   1. IMMUTABLE PREFIX ← 所有 pool 共用同一套 tools，API 层前缀缓存全局命中
//   2. APPEND-ONLY LOG  ← 每个 type 独立 session 文件，user message 前缀恒定
//   3. VOLATILE SCRATCH ← tool 结果自动压缩，不膨胀缓存
//
// 每个 type 的 session 持久化到磁盘，跨进程复用。
// API 层缓存 system prompt + tools（全 pool 共享），
// 消息层缓存该 type 的历史对话（每 pool 独立）。

const globalPools = new Map<string, SessionPool>();
// POOL_SESSIONS_DIR defined in paths.ts

/** 所有 pool 共用同一套 tools——IMMUTABLE PREFIX 恒定的关键 */
const UNIFIED_TOOLS = [
  'bash', 'read', 'edit', 'write',
  'grep', 'find', 'ls',
  'read_terminal',
  'web_search',
  'web_extract',
];

/** `read_terminal` 工具定义：agent 可通过它 attach 到本地终端进程 */
const READ_TERMINAL_TOOL = defineTool({
  name: 'read_terminal',
  label: 'Read Terminal Output',
  description:
    'Attach to a running terminal process and read its stdout output. ' +
    'Use list first to find PIDs of running shells/tty processes. ' +
    'Read-only — cannot send input to the terminal.',
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal('list'),
      Type.Literal('attach'),
    ], { description: 'Action: list processes or attach to a PID' }),
    pid: Type.Optional(Type.Number({ description: 'Process ID to attach (required for attach action)' })),
  }),
  async execute(_toolCallId: string, params: { action: 'list' | 'attach'; pid?: number }) {
    let text = '';
    const detail: Record<string, unknown> = {};
    let isError = false;

    if (params.action === 'list') {
      const { listTerminalProcesses } = await import('./terminal/index.js');
      const procs = listTerminalProcesses();
      if (procs.length === 0) {
        text = 'No terminal processes found for current user.';
      } else {
        const lines = procs.map(
          (p) => `PID ${p.pid} — ${p.command} (started ${new Date(p.startedAt).toLocaleString()})`,
        );
        text = lines.join('\n');
        detail.processes = procs.length;
      }
    } else if (params.action === 'attach') {
      const pid = params.pid;
      if (!pid) {
        text = 'Error: pid is required for attach action.';
        isError = true;
      } else {
        const { readProcessOutput } = await import('./terminal/index.js');
        try {
          const output = readProcessOutput(pid);
          text = output
            ? `--- stdout of PID ${pid} ---\n${output}`
            : `Process ${pid} stdout buffer is empty.`;
          detail.bytes = output.length;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          text = `Error attaching to PID ${pid}: ${msg}`;
          isError = true;
        }
      }
    } else {
      text = 'Invalid action. Use list or attach.';
      isError = true;
    }

    return {
      content: [{ type: 'text' as const, text }],
      details: detail,
      ...(isError ? { isError: true as const } : {}),
    };
  },
});

/** `web_search` 工具：通过 DuckDuckGo 搜索网页 */
const WEB_SEARCH_TOOL = defineTool({
  name: 'web_search',
  label: 'Web Search',
  description:
    'Search the web via DuckDuckGo. Returns titles, links, and snippets. ' +
    'No API key required. Supports advanced query syntax (site:, OR, intitle:).',
  parameters: Type.Object({
    query: Type.String({ description: 'Search query' }),
    limit: Type.Optional(Type.Number({ description: 'Max results (1-20, default 5)' })),
  }),
  async execute(_toolCallId: string, params: { query: string; limit?: number }) {
    const result = await webSearch(params);
    return {
      content: [{ type: 'text' as const, text: result.text }],
      details: result.detail ?? {},
      ...(result.isError ? { isError: true as const } : {}),
    };
  },
});

/** `web_extract` 工具：从网页提取可读内容 */
const WEB_EXTRACT_TOOL = defineTool({
  name: 'web_extract',
  label: 'Web Extract',
  description:
    'Fetch a webpage and extract its readable content as clean text. ' +
    'Useful for reading article content, documentation, or API references. ' +
    'Max 10,000 characters by default.',
  parameters: Type.Object({
    url: Type.String({ description: 'URL to fetch and extract' }),
    maxLength: Type.Optional(Type.Number({ description: 'Max characters to return (default 10000)' })),
  }),
  async execute(_toolCallId: string, params: { url: string; maxLength?: number }) {
    const result = await webExtract(params);
    return {
      content: [{ type: 'text' as const, text: result.text }],
      details: result.detail ?? {},
      ...(result.isError ? { isError: true as const } : {}),
    };
  },
});


/**
 * 获取指定 agent type 的 SessionPool。
 * 每个 type 独立 pool，user message 前缀在各自 session 中恒定。
 * 所有 pool 共用同一套 tools，API 层 system prompt 缓存跨 pool 命中。
 */
export function getSessionPool(type?: string): SessionPool {
  const key = type || 'default';
  if (!globalPools.has(key)) {
    const pool = new SessionPool();
    // dir 已包含 type 路径，buildDefaultConfig 直接用它
    pool.setPersist(key, join(POOL_SESSIONS_DIR, key));
    globalPools.set(key, pool);
  }
  return globalPools.get(key)!;
}

/** 聚合所有 pool 的缓存统计 */
export function getAllPoolsStats(): CacheStats {
  if (globalPools.size === 0) {
    return { totalHits: 0, totalMisses: 0, totalCost: 0, turnCount: 0, hitRate: 0 };
  }
  const pools = Array.from(globalPools.values());
  const total = pools.reduce(
    (acc, pool) => {
      const s = pool.getStats();
      acc.totalHits += s.totalHits;
      acc.totalMisses += s.totalMisses;
      acc.totalCost += s.totalCost;
      acc.turnCount += s.turnCount;
      return acc;
    },
    { totalHits: 0, totalMisses: 0, totalCost: 0, turnCount: 0, hitRate: 0 },
  );
  total.hitRate =
    total.totalHits + total.totalMisses > 0
      ? total.totalHits / (total.totalHits + total.totalMisses)
      : 0;
  return total;
}

export async function resetSessionPool(type?: string): Promise<void> {
  if (type) {
    const pool = globalPools.get(type);
    if (pool) {
      pool.dispose();
      globalPools.delete(type);
    }
  } else {
    for (const pool of globalPools.values()) {
      pool.dispose();
    }
    globalPools.clear();
  }
}

/** 缓存优先的子 agent 调用入口 */
export async function spawnAgent(config: SpawnConfig): Promise<SpawnResult> {
  const agentId = `${config.type}-${config.task.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_')}-${Date.now()}`;
  shutdownManager.agentStarted(agentId);

  try {
    const pool = getSessionPool(config.type);

    // Isolated: 使用临时独立 session，不污染共享缓存池
    if (config.isolated) {
      return await pool.callIsolated(config.task, config);
    }

    // Team-aware spawn: wrap with mailbox polling + ack lifecycle
    if (config.teamRunId && config.memberName) {
      const { TeamSession } = await import('./team/session.js');
      const teamSession = new TeamSession(config.teamRunId, config.memberName);
      // TeamSession.call() handles: poll → inject → call → ack
      return await teamSession.call(() => pool.call(config.task, config));
    }

    return await pool.call(config.task, config);
  } catch (err) {
    log.error('Agent spawn failed', err, { type: config.type, task: config.task.slice(0, 100) });
    throw err;
  } finally {
    shutdownManager.agentFinished(agentId);
  }
}
