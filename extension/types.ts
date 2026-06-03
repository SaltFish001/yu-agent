/**
 * yu-agent — Shared type definitions.
 *
 * Central interface definitions for the memory subsystem and other
 * core components. All modules should depend on these interfaces
 * rather than concrete implementations.
 */

// ── Memory subsystem interfaces ────────────────────────

/** Overflow strategy for ring buffer when cap is reached. */
export type OverflowStrategy = 'delete_oldest' | 'sliding_window';

/** A single ring buffer entry. */
export interface RingEntry {
  id: number;
  platform: string;
  role: string;
  content: string;
  created_at: number;
}

/** Ring buffer health report. */
export interface RingHealthReport {
  ok: boolean;
  issues: string[];
  total: number;
  dbSize: number;
}

/** Ring buffer stats. */
export interface RingStats {
  total: number;
  by_platform: Record<string, number>;
}

/**
 * Ring buffer memory interface.
 * Captures conversation messages in a capped ring buffer.
 */
export interface IMemoryRing {
  /** Append a message. Auto-evicts when cap is reached. */
  append(role: 'user' | 'assistant' | 'system', content: string, platform?: string): void;

  /** Get the N most recent entries. */
  recent(n?: number, platform?: string): RingEntry[];

  /** Search entries by keyword. */
  search(keyword: string, limit?: number): RingEntry[];

  /** Get aggregate stats. */
  stats(): RingStats;

  /** Run a health check. */
  health(): RingHealthReport;

  /** The configured maximum number of entries. */
  readonly maxEntries: number;

  /** The overflow strategy in use. */
  readonly overflowStrategy: OverflowStrategy;
}

/** Aggregate memory health report (ring only). */
export interface MemoryHealthReport {
  ok: boolean;
  issues: string[];
  components: {
    ring: RingHealthReport;
  };
}

/**
 * Memory plugin lifecycle configuration.
 */
export interface MemoryPluginConfig {
  /** Ring buffer overflow strategy. Default: 'delete_oldest' */
  overflowStrategy?: OverflowStrategy;

  /** Ring buffer max entries. Default: 5000 */
  ringMaxEntries?: number;

  /** Auto-save user/assistant messages. Default: true */
  autoSave?: boolean;
}

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
