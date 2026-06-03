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
