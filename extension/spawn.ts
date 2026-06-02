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

import type { AssistantMessage } from '@earendil-works/pi-ai';

import { getAgentTypeConfig } from './config.js';

import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PI_AGENT_DIR, POOL_SESSIONS_DIR } from './paths.js';

// ── 配置常量 ──────────────────────────────────────────

/** 工具输出压缩阈值（超过此长度的结果被自动摘要） */
const RESULT_CAP_TOKENS = 3000;

/** session 最大轮数后自动重置（防止上下文无限膨胀） */
const MAX_TURNS_PER_SESSION = 300;

/** session 累计输入 token 上限后自动重置（防止上下文无限膨胀） */
// DeepSeek V4 系列支持 1M context window，保留 10% 余量
const MAX_TOKENS_PER_SESSION = 900_000;

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
  totalTokens?: number;
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
    console.log('[yu-agent/cache] New session created (prefix pinned)');
  }

  async call(task: string, spawnCfg: SpawnConfig): Promise<SpawnResult> {
    return this._serialize(async () => {
      if (!this.session) {
        await this.init(this.buildDefaultConfig(spawnCfg));
      }

      const needsReset =
        this.turnCount >= MAX_TURNS_PER_SESSION ||
        this.totalTokensUsed >= MAX_TOKENS_PER_SESSION;

      if (needsReset) {
        const reason = this.turnCount >= MAX_TURNS_PER_SESSION
          ? `${this.turnCount} turns`
          : `${this.totalTokensUsed} tokens`;
        console.log(`[yu-agent/cache] Session reset after ${reason}`);
        await this.init(this.sessionOptions!);
      }

      const session = this.session!;
      const beforeLen = session.messages.length;

      const result = await this._doCall(session, task, spawnCfg, beforeLen);

      this.totalTokensUsed += result.totalTokens ?? 0;
      this.turnCount++;

      return result;
    });
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
      (err)  => { settled = true; throw err; },
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
      return await this._doCall(agentSession, task, spawnCfg, 0);
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
    await this._promptWithTimeout(session, fullTask, spawnCfg.timeout);

    // 提取新增的 assistant 响应
    const newMessages = (session.messages as { role: string; content?: unknown }[]).slice(beforeLen);
    const response = extractAssistantResponse(newMessages);

    // 只取最后一条 assistant 消息的 usage（避免工具调用多轮重复计数）
    let cacheHit = 0;
    let cacheMiss = 0;
    let totalTokens = 0;
    let cost = 0;
    const assistantMsgs = newMessages.filter(
      (m): m is AssistantMessage => m.role === 'assistant',
    );
    if (assistantMsgs.length > 0) {
      const last = assistantMsgs[assistantMsgs.length - 1];
      cacheHit = last.usage.cacheRead;
      cacheMiss = last.usage.input;
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
      totalTokens: totalTokens || undefined,
    };
  }

  getStats(): CacheStats {
    return { ...this.stats };
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
    const options: CreateAgentSessionOptions = { tools };

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
];

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
  const pool = getSessionPool(config.type);

  // Isolated: 使用临时独立 session，不污染共享缓存池
  if (config.isolated) {
    return pool.callIsolated(config.task, config);
  }

  // Team-aware spawn: wrap with mailbox polling + ack lifecycle
  if (config.teamRunId && config.memberName) {
    const { TeamSession } = await import('./team/session.js');
    const teamSession = new TeamSession(config.teamRunId, config.memberName);
    // TeamSession.call() handles: poll → inject → call → ack
    return teamSession.call(() => pool.call(config.task, config));
  }

  return pool.call(config.task, config);
}
