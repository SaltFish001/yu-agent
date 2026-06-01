/**
 * yu-agent — TUI monitor widget.
 *
 * Renders a live status panel in the Pi TUI (above the editor)
 * showing the yu-agent scheduler's sub-agent state.
 *
 * Reads status data from SQLite (db.ts) written by the scheduler
 * and updates every 500ms via setInterval.
 *
 * Usage:
 *   import { setupMonitor } from './monitor.js';
 *   setupMonitor(pi);  // inside extension factory
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { getSessionTag, setSessionTag } from './session-context.js';
import {
  getSummary, getAgents, getCache,
  upsertAgents, upsertSummary, upsertSession, upsertCache,
} from './db.js';


// ── Constants ──────────────────────────────────────────

const WIDGET_KEY = 'yu-agent-monitor';
const POLL_INTERVAL_MS = 500;

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
  const tag = getSessionTag();
  const summary = getSummary(tag);
  const agentsJson = getAgents(tag);
  const agents: AgentEntry[] = agentsJson ? (JSON.parse(agentsJson).agents ?? []) : [];
  const cacheFile = getCache(tag);

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

  if (cacheFile && typeof cacheFile.hitRate === 'number') {
    const pct = Math.round(cacheFile.hitRate * 100);
    text += ` · cache: ${pct}%`;
  } else {
    text += ` · cache: —`;
  }

  return text;
}

/**
 * Read status files and produce an array of widget lines.
 * Returns [] when no data is available (shows nothing).
 */
function renderWidgetContent(): string[] {
  const tag = getSessionTag();
  const summary = getSummary(tag);
  const agentsJson = getAgents(tag);
  const agents: AgentEntry[] = agentsJson ? (JSON.parse(agentsJson).agents ?? []) : [];

  // ── No data at all → show nothing ──
  if (!summary && agents.length === 0) {
    return [];
  }

  const lines: string[] = [];

  // ── Cache stats ──
  const cacheFile = getCache(tag);

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
  let _initialTagSet = false;

  pi.on('session_start', async (_event, ctx) => {
    // Only set the session tag on the first session_start (main session).
    // Sub-agent sessions (scheduler callIsolated, fork, etc.) must NOT overwrite it.
    if (!_initialTagSet) {
      try {
        const sessionFile = ctx.sessionManager?.getSessionFile();
        if (sessionFile) {
          setSessionTag(sessionFile);
          _initialTagSet = true;
        }
      } catch { /* best-effort */ }
    }

    // Reset status files for this session
    const now = Date.now();
    const tag = getSessionTag();
    upsertCache(tag, { totalHits: 0, totalMisses: 0, totalCost: 0, turnCount: 0, hitRate: 0 }, now);
    upsertAgents(tag, JSON.stringify({ updatedAt: now, agents: [] }), now);
    upsertSummary(tag, { running: 0, completed: 0, failed: 0, mcpConnected: 0, lspReady: 0 }, now);
    if (_initialTagSet) {
      const piSessionPath = ctx.sessionManager?.getSessionFile();
      // Write initial session metadata (name will be updated on first user message)
      upsertSession(tag, {
        name: tag.slice(0, 20),
        cwd: process.cwd(),
        metadata: piSessionPath ? JSON.stringify({ piSessionPath }) : undefined,
      });
    }

    // Replace Pi startup header with yu-agent branding
    try {
      ctx.ui.setHeader((tui, theme) => new Text(
        `${theme.bold(theme.fg('accent', 'yu-agent'))}${theme.fg('dim', ' · AI-powered coding agent')}\n` +
        `\n` +
        `${theme.fg('accent', 'Commands')}\n` +
        `${theme.fg('dim', '  /review <path>    审查代码')}\n` +
        `${theme.fg('dim', '  /plan <task>      出技术方案')}\n` +
        `${theme.fg('dim', '  /coding <task>    编码任务')}\n` +
        `${theme.fg('dim', '  /commit           生成 commit 信息')}\n` +
        `${theme.fg('dim', '  /doc <task>       生成文档')}\n` +
        `${theme.fg('dim', '  /search           搜索代码库')}\n` +
        `${theme.fg('dim', '  /monitor          实时状态面板')}\n` +
        `${theme.fg('dim', '  /team <sub>       多 agent 协作')}\n` +
        `\n` +
        `${theme.fg('accent', 'Keys')}   ${theme.fg('dim', 'Esc 中断 · Ctrl+D 退出 · / 命令 · ! bash 终端')}\n` +
        `${theme.fg('accent', 'Skills')} ${theme.fg('dim', 'agent-browser, find-skills')}`,
        0, 1
      ));
      ctx.ui.setTitle('yu-agent');
    } catch {
      // setHeader/setTitle may not be available in print/RPC mode — ignore
    }

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
    _cacheReadTotal = 0;
    _cacheWriteTotal = 0;
  });

  // Track real API-level cache stats on each assistant turn
  let _cacheReadTotal = 0;
  let _cacheWriteTotal = 0;

  pi.on('turn_end', (event: { message: { role: string; content?: unknown; usage?: { input: number; cacheRead: number; cacheWrite: number } } }) => {
    const tag = getSessionTag();
    const role = event.message.role;

    // ── Cache stats (existing logic) ─────
    if (role !== 'assistant' || !event.message.usage) return;

    _cacheReadTotal += event.message.usage.cacheRead;
    _cacheWriteTotal += event.message.usage.cacheWrite;
    const totalInput = event.message.usage.input;

    const total = _cacheReadTotal + _cacheWriteTotal + totalInput;
    const hitRate = total > 0 ? _cacheReadTotal / total : 0;

    const cacheFile: CacheFile = {
      updatedAt: Date.now(),
      totalHits: _cacheReadTotal,
      totalMisses: _cacheWriteTotal + totalInput,
      totalCost: 0,
      turnCount: 0,
      hitRate,
    };

    upsertCache(tag, {
      totalHits: cacheFile.totalHits,
      totalMisses: cacheFile.totalMisses,
      totalCost: cacheFile.totalCost,
      turnCount: cacheFile.turnCount,
      hitRate: cacheFile.hitRate,
    }, cacheFile.updatedAt);
  });
}
