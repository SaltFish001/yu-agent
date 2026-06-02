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
} from './facts.js';

import type { SceneState, TemporalEntry } from './scene.js';
import type { FactEntry, FactCategory } from './facts.js';

export {
  ringAppend,
  ringRecent,
  ringSearch,
  ringStats,
  _ringHealth as ringHealth,
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
};

export type { FactEntry, FactCategory };

/**
 * Aggregate health check for the entire memory subsystem.
 * Runs ring, facts, and scene health checks and combines results.
 */
export function memoryHealth(): {
  ok: boolean;
  issues: string[];
  components: {
    ring: { ok: boolean; issues: string[]; total: number; dbSize: number };
    facts: { ok: boolean; issues: string[]; total: number; fileSize: number };
    scene: { ok: boolean; issues: string[]; fileSize: number };
  };
} {
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
