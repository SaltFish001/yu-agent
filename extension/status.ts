/**
 * yu-agent — Status reporter.
 *
 * Writes runtime status to JSON files in ~/yu-agent/status/
 * for the standalone yu-agent monitor.
 *
 * File-based IPC: zero coupling, any process can read the JSON files.
 *
 * Status files (all optional — missing = no data yet):
 *   agents.json   — spawned sub-agent statuses
 *   mcp.json      — MCP server connections
 *   lsp.json      — LSP server statuses
 *   team.json     — team mode state
 *   summary.json  — aggregated quick-view summary
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ──────────────────────────────────────────

const STATUS_DIR = resolve(homedir(), 'yu-agent', 'status');

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

// ── Helpers ────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(STATUS_DIR)) {
    try {
      mkdirSync(STATUS_DIR, { recursive: true });
    } catch (err) {
      console.warn(`[yu-agent/status] Failed to create ${STATUS_DIR}:`, err);
    }
  }
}

function writeFile(name: string, data: unknown): void {
  ensureDir();
  try {
    writeFileSync(
      resolve(STATUS_DIR, name),
      JSON.stringify(data, null, 2),
      'utf-8',
    );
  } catch (err) {
    console.warn(`[yu-agent/status] Failed to write ${name}:`, err);
  }
}

// ── Public API ─────────────────────────────────────────

/** Write the full status snapshot. Called after any state change. */
export function writeSnapshot(snapshot: YuStatusSnapshot): void {
  writeFile('agents.json', {
    updatedAt: snapshot.updatedAt,
    agents: snapshot.agents,
  });
  writeFile('mcp.json', {
    updatedAt: snapshot.updatedAt,
    servers: snapshot.mcp,
  });
  writeFile('lsp.json', {
    updatedAt: snapshot.updatedAt,
    servers: snapshot.lsp,
  });
  writeFile('team.json', snapshot.team ?? { active: false });
  writeFile('summary.json', {
    updatedAt: snapshot.updatedAt,
    ...snapshot.summary,
  });
}

/** Quick shorthand: write agents only (most common update path). */
export function writeAgentStatus(
  agents: AgentStatus[],
  updatedAt: number = Date.now(),
): void {
  writeFile('agents.json', { updatedAt, agents });
}

/** Write MCP status independently (updated by Pi MCP watcher). */
export function writeMCPStatus(
  servers: MCPServerStatus[],
  updatedAt: number = Date.now(),
): void {
  writeFile('mcp.json', { updatedAt, servers });
}

/** Write LSP status independently. */
export function writeLSPStatus(
  servers: LSPServerStatus[],
  updatedAt: number = Date.now(),
): void {
  writeFile('lsp.json', { updatedAt, servers });
}

/** Write team mode status independently. */
export function writeTeamStatus(
  team: TeamStatus,
  updatedAt: number = Date.now(),
): void {
  writeFile('team.json', { ...team, updatedAt });
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

/** Write cache stats to cache.json. Only writes when there is actual data. */
export function writeCacheStats(stats: CacheStatsData): void {
  if (stats.turnCount === 0 && stats.totalHits === 0 && stats.totalMisses === 0) return;
  writeFile('cache.json', {
    updatedAt: stats.updatedAt,
    totalHits: stats.totalHits,
    totalMisses: stats.totalMisses,
    totalCost: stats.totalCost,
    turnCount: stats.turnCount,
    hitRate: stats.hitRate,
  });
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
