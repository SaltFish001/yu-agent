/**
 * yu-agent — Status reporter.
 *
 * Writes runtime status to SQLite database (sessions.db) in the
 * per-project .yu-agent/status/ directory.
 *
 * SQLite-based IPC: any process on the same machine can query the DB.
 *
 * Tables:
 *   agents   — spawned sub-agent statuses
 *   mcp      — MCP server connections
 *   lsp      — LSP server statuses
 *   team     — team mode state
 *   summary  — aggregated quick-view summary
 */

import { getSessionTag } from './session-context.js';
import {
  upsertAgents, upsertMCP, upsertLSP, upsertTeam,
  upsertSummary, upsertCache,
} from './db.js';

// ── Types ──────────────────────────────────────────────

export interface AgentStatus {
  id: string;
  type: string;
  model: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  goal?: string;
  files?: string[];
  startedAt?: number;   // epoch ms
  durationMs?: number;  // 0 if still running
  error?: string;
}

export interface MCPServerStatus {
  name: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  tools?: string[];
  url?: string;
  error?: string;
  lastSeen?: number;
}

export interface LSPServerStatus {
  name: string;
  status: 'running' | 'idle' | 'starting' | 'error' | 'stopped';
  project?: string;
  error?: string;
}

export interface TeamStatus {
  active: boolean;
  mode?: string;            // 'architect-searcher' | 'coder-reviewer' | etc
  members?: TeamMember[];
  currentPhase?: string;
  sharedDir?: string;
}

export interface TeamMember {
  role: string;
  status: 'running' | 'completed' | 'waiting' | 'failed';
  model?: string;
}

export interface YuStatusSnapshot {
  updatedAt: number;
  agents: AgentStatus[];
  mcp: MCPServerStatus[];
  lsp: LSPServerStatus[];
  team: TeamStatus | null;
  summary: {
    running: number;
    completed: number;
    failed: number;
    mcpConnected: number;
    lspReady: number;
  };
}

// ── Public API ─────────────────────────────────────────

/** Write the full status snapshot. Called after any state change. */
export function writeSnapshot(snapshot: YuStatusSnapshot): void {
  const tag = getSessionTag();
  upsertAgents(tag, JSON.stringify({ updatedAt: snapshot.updatedAt, agents: snapshot.agents }), snapshot.updatedAt);
  upsertMCP(tag, JSON.stringify({ updatedAt: snapshot.updatedAt, servers: snapshot.mcp }), snapshot.updatedAt);
  upsertLSP(tag, JSON.stringify({ updatedAt: snapshot.updatedAt, servers: snapshot.lsp }), snapshot.updatedAt);
  upsertTeam(tag, JSON.stringify({ ...snapshot.team ?? { active: false }, updatedAt: snapshot.updatedAt }), snapshot.updatedAt);
  upsertSummary(tag, {
    running: snapshot.summary.running,
    completed: snapshot.summary.completed,
    failed: snapshot.summary.failed,
    mcpConnected: snapshot.summary.mcpConnected,
    lspReady: snapshot.summary.lspReady,
  }, snapshot.updatedAt);
}

/** Quick shorthand: write agents only (most common update path). */
export function writeAgentStatus(
  agents: AgentStatus[],
  updatedAt: number = Date.now(),
): void {
  const tag = getSessionTag();
  upsertAgents(tag, JSON.stringify({ updatedAt, agents }), updatedAt);
}

/** Write MCP status independently (updated by Pi MCP watcher). */
export function writeMCPStatus(
  servers: MCPServerStatus[],
  updatedAt: number = Date.now(),
): void {
  const tag = getSessionTag();
  upsertMCP(tag, JSON.stringify({ updatedAt, servers }), updatedAt);
}

/** Write LSP status independently. */
export function writeLSPStatus(
  servers: LSPServerStatus[],
  updatedAt: number = Date.now(),
): void {
  const tag = getSessionTag();
  upsertLSP(tag, JSON.stringify({ updatedAt, servers }), updatedAt);
}

/** Write team mode status independently. */
export function writeTeamStatus(
  team: TeamStatus,
  updatedAt: number = Date.now(),
): void {
  const tag = getSessionTag();
  upsertTeam(tag, JSON.stringify({ ...team, updatedAt }), updatedAt);
}

/** Build a summary from agent list. */
// ── Cache stats ────────────────────────────────────────────

export interface CacheStatsData {
  updatedAt: number;
  totalHits: number;
  totalMisses: number;
  totalCost: number;
  turnCount: number;
  hitRate: number;
}

/** Write cache stats to cache table. Only writes when there is actual data. */
export function writeCacheStats(stats: CacheStatsData): void {
  if (stats.turnCount === 0 && stats.totalHits === 0 && stats.totalMisses === 0) return;
  upsertCache(getSessionTag(), {
    totalHits: stats.totalHits,
    totalMisses: stats.totalMisses,
    totalCost: stats.totalCost,
    turnCount: stats.turnCount,
    hitRate: stats.hitRate,
  }, stats.updatedAt);
}

export function buildSummary(agents: AgentStatus[]): YuStatusSnapshot['summary'] {
  let running = 0;
  let completed = 0;
  let failed = 0;

  for (const a of agents) {
    if (a.status === 'running' || a.status === 'queued') running++;
    else if (a.status === 'completed') completed++;
    else if (a.status === 'failed' || a.status === 'interrupted') failed++;
  }

  return {
    running,
    completed,
    failed,
    mcpConnected: 0,
    lspReady: 0,
  };
}
