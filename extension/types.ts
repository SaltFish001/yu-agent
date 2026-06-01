/**
 * yu-agent — Shared type definitions.
 */

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
