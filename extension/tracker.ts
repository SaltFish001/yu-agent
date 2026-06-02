/**
 * yu-agent — Scheduler agent tracker & decision persistence.
 *
 * Extracted from scheduler.ts for maintainability.
 * Tracks all spawned agents in the current invocation and
 * persists scheduling decisions to disk.
 */

import type { AgentStatus } from './status.js';
import type { SchedulerPlan } from './classifier.js';
import { writeAgentStatus, writeSnapshot, buildSummary, writeCacheStats } from './status.js';
import { getAllPoolsStats } from './spawn.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { DATA_DIR, DECISIONS_FILE } from './paths.js';

// ── Constants ──────────────────────────────────────────

const MAX_DECISIONS = 50;

// ── In-memory agent tracker ────────────────────────────
// Tracks all spawned agents in the current invocation.
// Reset on each handler call.

const _agentTrackers: Map<string, AgentStatus> = new Map();
let _handlerStartTime = 0;

export function resetTracker(): void {
  _agentTrackers.clear();
  _handlerStartTime = Date.now();
}

export function trackAgent(id: string, status: AgentStatus['status'], extra?: Record<string, unknown>): void {
  const existing = _agentTrackers.get(id);
  const entry: AgentStatus = {
    id,
    type: (extra?.type as string) || existing?.type || 'unknown',
    model: (extra?.model as string) || '',
    status,
    goal: (extra?.goal as string) || existing?.goal,
    files: (extra?.files as string[]) || existing?.files,
    startedAt: existing?.startedAt,
    durationMs: existing?.durationMs,
    error: (extra?.error as string) || existing?.error,
  };
  // Apply runtime computed fields
  if (status === 'running' && !entry.startedAt) {
    entry.startedAt = Date.now();
  }
  if ((status === 'completed' || status === 'failed' || status === 'interrupted') && entry.startedAt) {
    entry.durationMs = Date.now() - entry.startedAt;
  }
  _agentTrackers.set(id, entry);

  // Flush to disk
  writeAgentStatus(Array.from(_agentTrackers.values()));
}

export function getAgentStatusList(): AgentStatus[] {
  return Array.from(_agentTrackers.values());
}

export function flushFinalStatus(): void {
  const agents = getAgentStatusList();
  const summary = buildSummary(agents);
  writeSnapshot({
    updatedAt: Date.now(),
    agents,
    mcp: [],
    lsp: [],
    team: null,
    summary,
  });
  // Record cache hit/miss stats for external monitoring
  const cacheStats = getAllPoolsStats();
  writeCacheStats({
    updatedAt: Date.now(),
    totalHits: cacheStats.totalHits,
    totalMisses: cacheStats.totalMisses,
    totalCost: cacheStats.totalCost,
    turnCount: cacheStats.turnCount,
    hitRate: cacheStats.hitRate,
  });
}

// ── Decisions ──────────────────────────────────────────

export function loadDecisions(): Record<string, unknown> {
  if (existsSync(DECISIONS_FILE)) {
    try {
      return JSON.parse(readFileSync(DECISIONS_FILE, 'utf-8'));
    } catch (err) {
      console.warn('[yu-agent] Failed to parse decisions file, resetting:', err);
      return {};
    }
  }
  return {};
}

export function saveDecision(key: string, value: unknown): void {
  const decisions = loadDecisions();
  decisions[key] = value;

  // Keep only the most recent MAX_DECISIONS entries
  const entries = Object.entries(decisions)
    .sort(([a], [b]) => b.localeCompare(a)) // timestamp-prefixed keys → newest first
    .slice(0, MAX_DECISIONS);

  const trimmed = Object.fromEntries(entries);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DECISIONS_FILE, JSON.stringify(trimmed, null, 2));
}
