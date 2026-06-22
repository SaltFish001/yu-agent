/**
 * yu-agent — Shared type definitions.
 *
 * Central interface definitions used across the project.
 * Memory subsystem types removed — yu-agent is a coding agent dispatcher
 * and does not need persistent memory. Conversation context is managed
 * by Pi's internal AgentSession.
 */

// ── IPC message types (P2-01, P2-02, P2-03) ──────────────

/** Types of messages that can be exchanged between parent and child via IPC. */
export type IpcMessageType =
  | 'ping'
  | 'pong'
  | 'task_result'
  | 'error'
  | 'status_update'
  | 'heartbeat'
  | 'shutdown'
  | 'parent:shutdown'
  | 'parent:new_task'
  | 'parent:die'

/** A message exchanged between parent and child processes over IPC. */
export interface IpcMessage {
  type: IpcMessageType
  /** Event payload — must be a serialisable object or primitive. */
  payload?: Record<string, unknown>
  /** Monotonic timestamp (ms since epoch) the message was created. */
  timestamp: number
  /** Optional sequence number for deduplication at the receiver (P2-03). */
  seq?: number
}

// ── Legacy hook context types ──────────────────────────

/** Context passed to the beforeChat hook. */
export interface BeforeChatHookContext {
  message: string
  session: unknown
  teamRunId?: string
  memberName?: string
}

/** Context passed to the scheduler handler. */
export interface SchedulerContext {
  session?: unknown
  teamRunId?: string
  memberName?: string
  agentType?: string // --agent <name> override for yu run
  background?: boolean // P2: run sub-agents in background mode
}

/** Structured result from scheduler handler. */
export interface HookActionResult {
  action: 'respond' | 'pass_through'
  content?: string
}

// ── Supervisor / Daemon types (Phase 0) ────────────────

/** Extended topic status with supervisor lifecycle states (P2-19). */
export type ExtendedTopicStatus =
  | 'idle'
  | 'active'
  | 'background'
  | 'spawning'
  | 'spawn_failed'
  | 'restarting'
  | 'degraded'

/** Status of a child process managed by the supervisor. */
export type ChildStatus =
  | 'spawning'
  | 'running'
  | 'degraded'
  | 'disconnected'
  | 'dead'
  | 'spawn_failed'
  | 'restarting'
  | 'stopped'

/** Information about a managed child process. */
export interface ChildProcessInfo {
  pid: number
  topicName: string
  status: ChildStatus
  startedAt: number
  lastHeartbeat: number
  restartCount: number
  resident?: boolean
  memoryEstimate?: number
}

/** Configuration for spawning a child process. */
export interface ChildSpawnConfig {
  /** Timeout in ms before spawning is considered failed (default: 15000). */
  timeout: number
  /** Extra environment variables to pass to the child. */
  env: Record<string, string>
  /**
   * Maximum time in ms to wait for the child to send its first
   * ready/pong signal before marking as spawn_failed (default: 30000).
   */
  spawning_timeout?: number
  /** If true, child stays alive after task completion (default: true). */
  resident?: boolean
  /** Automatically restart on unexpected exit (default: true). */
  autoRetry?: boolean
  /** Maximum restart attempts before giving up (default: 3). */
  maxRetries?: number
}

/** Status report from the supervisor daemon. */
export interface SupervisorStatus {
  pid: number
  uptime: number
  children: ChildProcessInfo[]
  daemonVersion: string
}

// ── Tools — 增强 ─────────────────────────────────────────

export interface ToolAuditHook {
  before?: (params: { name: string; args: Record<string, unknown>; role?: string }) => void
  after?: (params: { name: string; args: Record<string, unknown>; result: unknown; durationMs: number; role?: string }) => void
  error?: (params: { name: string; args: Record<string, unknown>; error: Error; role?: string }) => void
}

export interface ToolEnhancement {
  schema?: import('zod').ZodType<unknown>
  auth?: { requiredRoles?: string[]; denyRoles?: string[] }
  audit?: ToolAuditHook
  timeout?: number
  sandbox?: boolean
}

// ── MCP 传输 ─────────────────────────────────────────────

export type McpTransportType = 'stdio' | 'sse'

export interface McpTransportConfig {
  type: McpTransportType
  target: string
  args?: string[]
  env?: Record<string, string>
}

// ── Rules ────────────────────────────────────────────────

export interface RuleCapability {
  allowTools?: string[]
  denyTools?: string[]
  maxToolCalls?: number
  allowMcpServers?: string[]
  maxTokens?: number
}

export interface RuleDef {
  name: string
  description?: string
  extend?: string[]
  systemPrompt?: string
  model?: string
  thinking?: 'none' | 'low' | 'high' | 'max'
  maxTurns?: number
  capabilities?: RuleCapability
}

// ── Skills ───────────────────────────────────────────────

export interface SkillDef {
  name: string
  version: string
  description: string
  systemPrompt: string
  requiresTools?: string[]
  providesTools?: string[]
  source?: 'builtin' | 'file' | 'remote'
  filePath?: string
}
