/**
 * yu-agent — Scene state.
 *
 * Persistent JSON state for the agent's current "scene":
 * location, clothing, mood, mode (omote/ura), and temporal tags.
 *
 * Mirrors the Hermes scene_state.json concept but built into
 * yu-agent itself for self-contained character continuity.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { YU_HOME } from '../paths.js';

// ── Types ──────────────────────────────────────────────

export interface SceneState {
  version: number;
  meta: {
    last_updated: string;
    rule: string;
  };
  scene: {
    location: string;
    mode: 'omote' | 'ura' | 'unknown';
    position: string;
    mood: string;
  };
  clothing: Record<string, string | null>;
  temporal: TemporalEntry[];
}

export interface TemporalEntry {
  id: string;
  text: string;
  cat?: string;
  created_at: number;
  ttl_min: number;
}

// ── Constants ──────────────────────────────────────────

const STATE_PATH = resolve(YU_HOME, 'scene_state.json');

const DEFAULT_STATE: SceneState = {
  version: 2,
  meta: {
    last_updated: new Date().toISOString().slice(0, 16),
    rule: '场景状态',
  },
  scene: {
    location: '未知',
    mode: 'unknown',
    position: '未知',
    mood: '平静',
  },
  clothing: {
    top: null,
    bottom: null,
    outer: null,
    shoes: null,
    hair: '散开',
    leg_wear: null,
    accessory: null,
    makeup: null,
    mode: 'unknown',
  },
  temporal: [],
};

// ── Internal ───────────────────────────────────────────

function loadRaw(): SceneState {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    }
  } catch {
    // corrupted file — reset
  }
  return structuredClone(DEFAULT_STATE);
}

function saveRaw(state: SceneState): void {
  if (!existsSync(YU_HOME)) mkdirSync(YU_HOME, { recursive: true });
  state.meta.last_updated = new Date().toISOString().slice(0, 16);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

// ── Public API ─────────────────────────────────────────

/**
 * Read the full scene state.
 */
export function sceneGet(): SceneState {
  return loadRaw();
}

/**
 * Update scene state fields (partial merge).
 */
export function sceneSet(updates: Partial<SceneState['scene']>): SceneState {
  const state = loadRaw();
  Object.assign(state.scene, updates);
  saveRaw(state);
  return state;
}

/**
 * Update clothing fields (partial merge).
 */
export function sceneSetClothing(updates: Record<string, string | null>): SceneState {
  const state = loadRaw();
  Object.assign(state.clothing, updates);
  saveRaw(state);
  return state;
}

/**
 * Add a temporal tag with auto-expiry.
 */
export function sceneTemporalAdd(
  text: string,
  cat?: string,
  ttlMin: number = 120,
): SceneState {
  const state = loadRaw();
  state.temporal.push({
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    cat,
    created_at: Date.now(),
    ttl_min: ttlMin,
  });
  saveRaw(state);
  return state;
}

/**
 * List temporal entries (cleans expired first).
 */
export function sceneTemporalList(): TemporalEntry[] {
  const state = loadRaw();
  const now = Date.now();
  state.temporal = state.temporal.filter(
    (e) => (now - e.created_at) < e.ttl_min * 60 * 1000,
  );
  saveRaw(state);
  return state.temporal;
}

/**
 * Clear all temporal entries.
 */
export function sceneTemporalClear(): void {
  const state = loadRaw();
  state.temporal = [];
  saveRaw(state);
}

/**
 * Switch to a preset scene (home / office / reset).
 */
export function sceneSwitch(name: 'home' | 'office' | 'reset'): SceneState {
  const presets: Record<string, Partial<SceneState>> = {
    home: {
      scene: { location: '家', mode: 'ura', position: '沙发上', mood: '放松' },
      clothing: { top: '家居服', bottom: null, shoes: null, mode: 'ura' },
    },
    office: {
      scene: { location: '办公室', mode: 'omote', position: '工位', mood: '工作中' },
      clothing: { top: '白衬衫', bottom: '包臀裙', shoes: '细高跟', mode: 'omote' },
    },
    reset: structuredClone(DEFAULT_STATE),
  };

  const preset = presets[name];
  if (!preset) return loadRaw();

  const state = loadRaw();
  if (preset.scene) Object.assign(state.scene, preset.scene);
  if (preset.clothing) Object.assign(state.clothing, preset.clothing);
  saveRaw(state);
  return state;
}

/**
 * Reset scene state to defaults.
 */
export function sceneReset(): SceneState {
  const fresh = structuredClone(DEFAULT_STATE);
  fresh.meta.last_updated = new Date().toISOString().slice(0, 16);
  saveRaw(fresh);
  return fresh;
}
