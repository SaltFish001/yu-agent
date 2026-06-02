/**
 * yu-agent — Shared type definitions.
 *
 * Central interface definitions for the memory subsystem and other
 * core components. All modules should depend on these interfaces
 * rather than concrete implementations.
 */

import type { SceneState, TemporalEntry } from './memory/scene.js';
import type { FactEntry, FactCategory } from './memory/facts.js';

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

/** Facts store health report. */
export interface FactHealthReport {
  ok: boolean;
  issues: string[];
  total: number;
  fileSize: number;
}

/** Facts store stats. */
export interface FactStats {
  total: number;
  by_category: Record<string, number>;
}

/**
 * Long-term key-value memory interface.
 * Stores counters, preferences, milestones, and secrets.
 */
export interface IFactStore {
  /** Get a fact value by key. */
  get(key: string): unknown | undefined;

  /** Set a fact value. */
  set(key: string, value: unknown, category?: FactCategory, ttlDays?: number | null): void;

  /** Increment a numeric counter. */
  increment(key: string, by?: number): number;

  /** Delete a fact by key. */
  delete(key: string): boolean;

  /** List facts, optionally filtered by category. */
  list(category?: FactCategory): FactEntry[];

  /** Run cleanup and return count of removed entries. */
  cleanup(): number;

  /** Get aggregate stats. */
  stats(): FactStats;

  /** Run a health check. */
  health(): FactHealthReport;
}

/** Scene state health report. */
export interface SceneHealthReport {
  ok: boolean;
  issues: string[];
  fileSize: number;
}

/**
 * Scene state manager interface.
 * Tracks the agent's current scene: location, mood, clothing, temporal tags.
 */
export interface ISceneManager {
  /** Read the full scene state. */
  get(): SceneState;

  /** Update scene fields (partial merge). */
  set(updates: Partial<SceneState['scene']>): SceneState;

  /** Update clothing fields (partial merge). */
  setClothing(updates: Record<string, string | null>): SceneState;

  /** Add a temporal tag with auto-expiry. */
  temporalAdd(text: string, cat?: string, ttlMin?: number): SceneState;

  /** List temporal entries (cleans expired first). */
  temporalList(): TemporalEntry[];

  /** Clear all temporal entries. */
  temporalClear(): void;

  /** Switch to a preset scene. */
  switch(name: 'home' | 'office' | 'reset'): SceneState;

  /** Reset scene state to defaults. */
  reset(): SceneState;

  /** Run a health check. */
  health(): SceneHealthReport;
}

/** Aggregate memory health report. */
export interface MemoryHealthReport {
  ok: boolean;
  issues: string[];
  components: {
    ring: RingHealthReport;
    facts: FactHealthReport;
    scene: SceneHealthReport;
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

  /** Enable scene tracking. Default: true */
  sceneTracking?: boolean;
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
