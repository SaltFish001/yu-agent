/**
 * yu-agent — Shared type definitions.
 *
 * Central interface definitions used across the project.
 * Memory subsystem types removed — yu-agent is a coding agent dispatcher
 * and does not need persistent memory. Conversation context is managed
 * by Pi's internal AgentSession.
 */

// ── Legacy hook context types ──────────────────────────

/** Context passed to the beforeChat hook. */
export interface BeforeChatHookContext {
  message: string;
  session: unknown;
  teamRunId?: string;
  memberName?: string;
}

/** Context passed to the scheduler handler. */
export interface SchedulerContext {
  session?: unknown;
  teamRunId?: string;
  memberName?: string;
}

/** Structured result from scheduler handler. */
export interface HookActionResult {
  action: 'respond' | 'pass_through';
  content?: string;
}

// ── Supervisor / Daemon types (Phase 0) ────────────────

/** Extended topic status with supervisor lifecycle states. */
export type ExtendedTopicStatus = 'idle' | 'active' | 'background' | 'spawning' | 'spawn_failed';

/** Status of a child process managed by the supervisor. */
export type ChildStatus =
  | 'spawning'
  | 'running'
  | 'degraded'
  | 'disconnected'
  | 'dead'
  | 'spawn_failed'
  | 'restarting'
  | 'stopped';

/** Information about a managed child process. */
export interface ChildProcessInfo {
  pid: number;
  topicName: string;
  status: ChildStatus;
  startedAt: number;
  memoryEstimate?: number;
}

/** Configuration for spawning a child process. */
export interface ChildSpawnConfig {
  /** Timeout in ms before spawning is considered failed (default: 15000). */
  timeout: number;
  /** Extra environment variables to pass to the child. */
  env: Record<string, string>;
  /**
   * Maximum time in ms to wait for the child to send its first
   * ready/pong signal before marking as spawn_failed (default: 30000).
   */
  spawning_timeout?: number;
}

/** Status report from the supervisor daemon. */
export interface SupervisorStatus {
  pid: number;
  uptime: number;
  children: ChildProcessInfo[];
  daemonVersion: string;
}
