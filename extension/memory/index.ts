/**
 * yu-agent — Memory subsystem index.
 *
 * Re-exports all memory modules for convenient imports.
 * Also provides an aggregate health check function.
 *
 * Usage:
 *   import { ringAppend, sceneGet, factSet } from './memory/index.js';
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

import {
  sceneGet,
  sceneSet,
  sceneSetClothing,
  sceneTemporalAdd,
  sceneTemporalList,
  sceneTemporalClear,
  sceneSwitch,
  sceneReset,
  sceneHealth as _sceneHealth,
  SceneManager,
} from './scene.js';

import {
  factGet,
  factSet,
  factIncrement,
  factDelete,
  factList,
  factCleanup,
  factStats,
  factHealth as _factHealth,
  FactStore,
} from './facts.js';

import type { SceneState, TemporalEntry } from './scene.js';
import type { FactEntry, FactCategory } from './facts.js';
import type {
  IMemoryRing,
  IFactStore,
  ISceneManager,
  MemoryHealthReport,
  MemoryPluginConfig,
  OverflowStrategy,
  RingEntry,
  RingStats,
  RingHealthReport,
  FactHealthReport,
  SceneHealthReport,
  FactStats,
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

export {
  sceneGet,
  sceneSet,
  sceneSetClothing,
  sceneTemporalAdd,
  sceneTemporalList,
  sceneTemporalClear,
  sceneSwitch,
  sceneReset,
  _sceneHealth as sceneHealth,
  SceneManager,
};

export type { SceneState, TemporalEntry };

export {
  factGet,
  factSet,
  factIncrement,
  factDelete,
  factList,
  factCleanup,
  factStats,
  _factHealth as factHealth,
  FactStore,
};

export type { FactEntry, FactCategory };

export type {
  IMemoryRing,
  IFactStore,
  ISceneManager,
  MemoryHealthReport,
  MemoryPluginConfig,
  OverflowStrategy,
  RingEntry,
  RingStats,
  RingHealthReport,
  FactHealthReport,
  SceneHealthReport,
  FactStats,
};

/**
 * Aggregate health check for the entire memory subsystem.
 * Runs ring, facts, and scene health checks and combines results.
 */
export function memoryHealth(): MemoryHealthReport {
  const ring = _ringHealth();
  const facts = _factHealth();
  const scene = _sceneHealth();

  const allIssues = [...ring.issues, ...facts.issues, ...scene.issues];
  const ok = allIssues.length === 0;

  if (!ok) {
    console.warn('[yu-memory] memoryHealth: issues found:', allIssues.join('; '));
  }

  return { ok, issues: allIssues, components: { ring, facts, scene } };
}
