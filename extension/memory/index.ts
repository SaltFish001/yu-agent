/**
 * yu-agent — Memory subsystem index.
 *
 * Provides ring buffer memory only (recent conversation context).
 * Facts store and scene state have been removed — they belong to
 * the 予鱼 character agent, not the coding agent dispatcher.
 *
 * Usage:
 *   import { ringAppend, ringRecent, memoryHealth } from './memory/index.js';
 */

import {
  ringAppend,
  ringRecent,
  ringSearch,
  ringStats,
  ringHealth as _ringHealth,
  RingMemory,
  RING_DEFAULT_MAX_ENTRIES,
} from './ring.js';

import type {
  IMemoryRing,
  MemoryHealthReport,
  MemoryPluginConfig,
  OverflowStrategy,
  RingEntry,
  RingStats,
  RingHealthReport,
} from '../types.js';

export {
  ringAppend,
  ringRecent,
  ringSearch,
  ringStats,
  _ringHealth as ringHealth,
  RingMemory,
  RING_DEFAULT_MAX_ENTRIES,
};

export type {
  IMemoryRing,
  MemoryHealthReport,
  MemoryPluginConfig,
  OverflowStrategy,
  RingEntry,
  RingStats,
  RingHealthReport,
};

/**
 * Aggregate health check for the memory subsystem.
 * Currently only checks ring buffer.
 */
export function memoryHealth(): MemoryHealthReport {
  const ring = _ringHealth();

  return {
    ok: ring.ok,
    issues: ring.issues,
    components: { ring },
  };
}
