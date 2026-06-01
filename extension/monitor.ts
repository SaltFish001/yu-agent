// monitored

/**
 * yu-agent — TUI monitor widget.
 *
 * Renders a live status panel in the Pi TUI (above the editor)
 * showing the yu-agent scheduler's sub-agent state.
 *
 * Reads status files from ~/yu-agent/status/ (written by the scheduler)
 * and updates every 3 seconds via setInterval.
 *
 * Usage:
 *   import { setupMonitor } from './monitor.js';
 *   setupMonitor(pi);  // inside extension factory
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';


// ── Constants ──────────────────────────────────────────

const STATUS_DIR = resolve(homedir(), 'yu-agent', 'status');
const WIDGET_KEY = 'yu-agent-monitor';
const POLL_INTERVAL_MS = 3000;

// ── Types (local subset) ───────────────────────────────

interface SummaryData {
  updatedAt?: number;
  running?: number;
  completed?: number;
  failed?: number;
  mcpConnected?: number;
  lspReady?: number;
}

interface AgentEntry {
  id: string;
  type: string;
  model?: string;
  status: string;
  goal?: string;
  files?: string[];
  startedAt?: number;
  durationMs?: number;
  error?: string;
}

interface CacheFile {
  updatedAt?: number;
  totalHits?: number;
  totalMisses?: number;
  totalCost?: number;
  turnCount?: number;
  hitRate?: number;
}

interface AgentsFile {
  updatedAt?: number;
  agents?: AgentEntry[];
}

// ── Helpers ────────────────────────────────────────────

function readJSON<T>(name: string): T | null {
  const p = resolve(STATUS_DIR, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Status glyph (single character).
 */
function glyph(status: string): string {
  switch (status) {
    case 'running':
      return '\u25CF'; // ●
    case 'queued':
      return '\u25CB'; // ○
    case 'completed':
      return '\u2713'; // ✓
    case 'failed':
    case 'interrupted':
      return '\u2717'; // ✗
    default:
      return '?';
  }
}

/**
 * Format duration from ms to human-readable string.
 */
function fmtDur(ms?: number): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

// ── Widget renderer ───────────────────────────────────

/**
 * Status bar text — always shown, even when idle.
 */
function buildStatusText(): string {
  const summary = readJSON<SummaryData>('summary.json');
  const agentsFile = readJSON<AgentsFile>('agents.json');
  const agents = agentsFile?.agents;
  const cacheFile = readJSON<CacheFile>('cache.json');

  const parts: string[] = [];

  let runningCount = 0;
  let completedCount = 0;
  let failedCount = 0;

  if (summary) {
    runningCount = summary.running ?? 0;
    completedCount = summary.completed ?? 0;
    failedCount = summary.failed ?? 0;
  } else if (agents && agents.length > 0) {
    runningCount = agents.filter((a) => a.status === 'running' || a.status === 'queued').length;
    completedCount = agents.filter((a) => a.status === 'completed').length;
    failedCount = agents.filter((a) => a.status === 'failed' || a.status === 'interrupted').length;
  }

  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (completedCount > 0) parts.push(`${completedCount} done`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);

  let text: string;
  if (parts.length > 0) {
    text = `yu-agent: ${parts.join(' · ')}`;
  } else {
    text = 'yu-agent';
  }

  if (cacheFile && typeof cacheFile.hitRate === 'number' && (cacheFile.turnCount ?? 0) > 0) {
    const pct = Math.round(cacheFile.hitRate * 100);
    const total = (cacheFile.totalHits ?? 0) + (cacheFile.totalMisses ?? 0);
    text += ` · cache: ${pct}% (${cacheFile.totalHits}h/${total}t)`;
  }

  return text;
}

/**
 * Read status files and produce an array of widget lines.
 * Returns [] when no data is available (shows nothing).
 */
function renderWidgetContent(): string[] {
  const summary = readJSON<SummaryData>('summary.json');
  const agentsFile = readJSON<AgentsFile>('agents.json');
  const agents = agentsFile?.agents;

  // ── No data at all → show nothing ──
  if (!summary && (!agents || agents.length === 0)) {
    return [];
  }

  const lines: string[] = [];

  // ── Cache stats ──
  const cacheFile = readJSON<CacheFile>('cache.json');

  // ── Build summary string ──
  let runningCount = 0;
  let completedCount = 0;
  let failedCount = 0;

  if (summary) {
    runningCount = summary.running ?? 0;
    completedCount = summary.completed ?? 0;
    failedCount = summary.failed ?? 0;
  } else if (agents && agents.length > 0) {
    runningCount = agents.filter((a) => a.status === 'running' || a.status === 'queued').length;
    completedCount = agents.filter((a) => a.status === 'completed').length;
    failedCount = agents.filter((a) => a.status === 'failed' || a.status === 'interrupted').length;
  }

  // ── Widget only shows when there are active agents ──
  if (runningCount === 0) {
    return [];
  }

  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (completedCount > 0) parts.push(`${completedCount} done`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);

  let statusLine: string;
  if (parts.length > 0) {
    statusLine = `yu-agent: ${parts.join(' \u00B7 ')}`;
  } else {
    statusLine = 'yu-agent: idle';
  }

  // Append cache info if available
  if (cacheFile && typeof cacheFile.hitRate === 'number' && (cacheFile.turnCount ?? 0) > 0) {
    const pct = Math.round(cacheFile.hitRate * 100);
    const total = (cacheFile.totalHits ?? 0) + (cacheFile.totalMisses ?? 0);
    statusLine += `  \u00B7  cache: ${pct}% (${cacheFile.totalHits} hits / ${total} total)`;
  }

  lines.push(statusLine);

  // ── Only show running/failed agents in the panel ──
  const activeAgents = (agents || []).filter(
    (a) => a.status === 'running' || a.status === 'queued' || a.status === 'failed' || a.status === 'interrupted'
  );

  if (activeAgents.length > 0) {
    for (const a of activeAgents.slice(0, 5)) {
      const g = glyph(a.status);
      const dur = a.durationMs ? ` ${fmtDur(a.durationMs)}` : '';
      const goal = a.goal ? ` ${a.goal.slice(0, 40)}` : '';
      const err = a.error ? ` [${a.error.slice(0, 25)}]` : '';
      lines.push(`  ${g} ${a.type}${goal}${dur}${err}`);
    }
    if (activeAgents.length > 5) {
      const remaining = activeAgents.length - 5;
      lines.push(`  ... ${remaining} more`);
    }
  }

  return lines;
}


// ── Module-level interval reference ────────────────────

let _updateInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Set up the monitor widget lifecycle.
 *
 * - On session_start: initialize widget and start polling.
 * - On session_shutdown: stop polling and clear widget.
 *
 * Call once inside the extension factory function.
 */
export function setupMonitor(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    // Clear any stale interval from a previous session
    if (_updateInterval !== null) {
      clearInterval(_updateInterval);
      _updateInterval = null;
    }

    // Initial render
    try {
      const content = renderWidgetContent();
      const statusText = buildStatusText();
      if (content.length > 0) {
        ctx.ui.setWidget(WIDGET_KEY, content);
      } else {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
      }
      ctx.ui.setStatus('yu-agent', statusText);
    } catch (err) {
      console.error('[yu-agent monitor] initial render error:', err);
    }

    // Periodic polling
    _updateInterval = setInterval(() => {
      try {
        const content = renderWidgetContent();
        const statusText = buildStatusText();
        if (content.length > 0) {
          ctx.ui.setWidget(WIDGET_KEY, content);
        } else {
          ctx.ui.setWidget(WIDGET_KEY, undefined);
        }
        ctx.ui.setStatus('yu-agent', statusText);
      } catch (err) {
        console.error('[yu-agent monitor] poll error:', err);
      }
    }, POLL_INTERVAL_MS);
  });

  pi.on('session_shutdown', () => {
    if (_updateInterval !== null) {
      clearInterval(_updateInterval);
      _updateInterval = null;
    }
  });


}

//t
