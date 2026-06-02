/**
 * yu-agent — Facts store (long-term key-value memory).
 *
 * Stores counters, preferences, milestones, and secrets
 * with optional TTL (time-to-live in days).
 *
 * Mirrors Hermes yu_facts.py concept but built into yu-agent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { YU_HOME } from '../paths.js';

// ── Zod schemas ────────────────────────────────────────

const FactCategorySchema = z.enum(['counter', 'pref', 'secret', 'milestone']);

export type FactCategory = z.infer<typeof FactCategorySchema>;

const FactEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  category: FactCategorySchema,
  created_at: z.number(),
  ttl_days: z.number().nullable(),
});

export type FactEntry = z.infer<typeof FactEntrySchema>;

const FactsStoreSchema = z.object({
  entries: z.array(FactEntrySchema),
});

export type FactsStore = z.infer<typeof FactsStoreSchema>;

// ── Constants ──────────────────────────────────────────

const FACTS_PATH = resolve(YU_HOME, 'facts.json');

// ── Internal ───────────────────────────────────────────

function loadRaw(): FactsStore {
  try {
    if (existsSync(FACTS_PATH)) {
      const raw = JSON.parse(readFileSync(FACTS_PATH, 'utf-8'));
      const result = FactsStoreSchema.safeParse(raw);
      if (result.success) return result.data;
      console.warn('[yu-memory] facts.json validation failed, resetting:', result.error.issues);
    }
  } catch (err) {
    console.warn('[yu-memory] facts.json corrupted or unreadable, resetting:', err);
  }
  return { entries: [] };
}

function saveRaw(store: FactsStore): void {
  if (!existsSync(YU_HOME)) mkdirSync(YU_HOME, { recursive: true });
  writeFileSync(FACTS_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Clean up expired entries.
 */
function cleanExpired(store: FactsStore): number {
  const now = Date.now();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => {
    if (e.ttl_days === null) return true; // permanent
    const age = (now - e.created_at) / (1000 * 60 * 60 * 24);
    return age < e.ttl_days;
  });
  return before - store.entries.length;
}

// ── Public API ─────────────────────────────────────────

/**
 * Get a fact value by key.
 */
export function factGet(key: string): unknown | undefined {
  const store = loadRaw();
  cleanExpired(store);
  return store.entries.find((e) => e.key === key)?.value;
}

/**
 * Set a fact.
 */
export function factSet(
  key: string,
  value: unknown,
  category: FactCategory = 'milestone',
  ttlDays: number | null = null,
): void {
  const store = loadRaw();
  cleanExpired(store);

  // Remove existing entry with same key
  store.entries = store.entries.filter((e) => e.key !== key);

  store.entries.push({
    key,
    value,
    category,
    created_at: Date.now(),
    ttl_days: ttlDays,
  });

  saveRaw(store);
}

/**
 * Increment a numeric counter.
 * Creates with default 1 if not exists.
 */
export function factIncrement(key: string, by: number = 1): number {
  const store = loadRaw();
  cleanExpired(store);

  const existing = store.entries.find((e) => e.key === key);
  let newVal: number;

  if (existing && typeof existing.value === 'number') {
    newVal = existing.value + by;
    existing.value = newVal;
  } else {
    newVal = by;
    store.entries.push({
      key,
      value: newVal,
      category: 'counter',
      created_at: Date.now(),
      ttl_days: null,
    });
  }

  saveRaw(store);
  return newVal;
}

/**
 * Delete a fact by key.
 */
export function factDelete(key: string): boolean {
  const store = loadRaw();
  cleanExpired(store);
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.key !== key);
  saveRaw(store);
  return store.entries.length < before;
}

/**
 * List facts by category.
 */
export function factList(category?: FactCategory): FactEntry[] {
  const store = loadRaw();
  cleanExpired(store);
  if (category) return store.entries.filter((e) => e.category === category);
  return store.entries;
}

/**
 * Run cleanup and return count of removed entries.
 */
export function factCleanup(): number {
  const store = loadRaw();
  const removed = cleanExpired(store);
  if (removed > 0) saveRaw(store);
  return removed;
}

/**
 * Get summary counts by category.
 */
export function factStats(): { total: number; by_category: Record<string, number> } {
  const store = loadRaw();
  cleanExpired(store);
  const by_category: Record<string, number> = {};
  for (const e of store.entries) {
    by_category[e.category] = (by_category[e.category] || 0) + 1;
  }
  return { total: store.entries.length, by_category };
}

/**
 * Health check for the facts store.
 * Returns diagnostic info including file integrity, entry count, and any issues found.
 */
export function factHealth(): { ok: boolean; issues: string[]; total: number; fileSize: number } {
  const issues: string[] = [];
  let fileSize = 0;

  try {
    if (existsSync(FACTS_PATH)) {
      fileSize = readFileSync(FACTS_PATH).length;
    }
  } catch (err) {
    issues.push(`facts.json unreadable: ${err}`);
  }

  let store: FactsStore;
  try {
    const raw = JSON.parse(readFileSync(FACTS_PATH, 'utf-8'));
    const result = FactsStoreSchema.safeParse(raw);
    if (result.success) {
      store = result.data;
    } else {
      issues.push(`facts.json: schema validation failed: ${result.error.issues.map(i => i.message).join('; ')}`);
      store = { entries: [] };
    }
  } catch (err) {
    issues.push(`facts.json parse failed: ${err}`);
    store = { entries: [] };
  }

  const total = store.entries.length;
  const ok = issues.length === 0;
  if (!ok) {
    console.warn('[yu-memory] factHealth: issues found:', issues.join('; '));
  }

  return { ok, issues, total, fileSize };
}
