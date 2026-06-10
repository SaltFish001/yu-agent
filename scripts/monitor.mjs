#!/usr/bin/env node

/**
 * yu-agent standalone monitor.
 *
 * Reads status files from ~/yu-agent/status/ and displays
 * a live-updating dashboard in the terminal.
 *
 * Zero external dependencies — uses only Node.js built-ins.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const STATUS_DIR = resolve(homedir(), '.yu');

// ── Terminal helpers ───────────────────────────────────

const CLEAR = '\x1B[2J\x1B[H';
const BOLD = '\x1B[1m';
const DIM = '\x1B[2m';
const RESET = '\x1B[0m';
const RED = '\x1B[31m';
const GREEN = '\x1B[32m';
const YELLOW = '\x1B[33m';
const CYAN = '\x1B[36m';
const GRAY = '\x1B[90m';

const glyph = (status) => {
  switch (status) {
    case 'running': return `${CYAN}●${RESET}`;
    case 'queued': return `${DIM}○${RESET}`;
    case 'completed': return `${GREEN}✓${RESET}`;
    case 'failed': return `${RED}✗${RESET}`;
    case 'interrupted': return `${YELLOW}■${RESET}`;
    case 'connected': return `${GREEN}●${RESET}`;
    case 'disconnected': return `${GRAY}○${RESET}`;
    case 'error': return `${RED}✗${RESET}`;
    default: return `${DIM}?${RESET}`;
  }
};

const fmtDur = (ms) => {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
};

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString();
};

// ── File readers ───────────────────────────────────────

function readJSON(name) {
  const p = resolve(STATUS_DIR, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

// ── Summary ────────────────────────────────────────────

function summaryLine(summary) {
  if (!summary) return `${DIM}no data${RESET}`;
  const parts = [];
  if (summary.running > 0) parts.push(`${CYAN}${summary.running}●${RESET}`);
  if (summary.completed > 0) parts.push(`${GREEN}${summary.completed}✓${RESET}`);
  if (summary.failed > 0) parts.push(`${RED}${summary.failed}✗${RESET}`);
  return parts.join(' ') || `${DIM}idle${RESET}`;
}

// ── Render dashboard ───────────────────────────────────

function render() {
  const agents = readJSON('agents.json');
  const mcp = readJSON('mcp.json');
  const lsp = readJSON('lsp.json');
  const team = readJSON('team.json');
  const rawSummary = readJSON('summary.json');
  const summary = rawSummary?.summary ?? rawSummary;
  const cache = readJSON('cache.json');

  const lines = [];

  lines.push(`${BOLD}┌─ yu-agent monitor ─────────────────────────────${RESET}`);
  lines.push(`│ ${BOLD}Summary:${RESET} ${summaryLine(summary)}`);
  lines.push(`│ ${DIM}Updated: ${agents?.updatedAt ? fmtTime(agents.updatedAt) : 'never'}${RESET}`);
  if (agents) {
    lines.push(`│ ${DIM}Status:  ${agents.agents?.length || 0} agents tracked${RESET}`);
  }

  // ── Cache stats ──────────────────────────────────────
  if (cache) {
    lines.push(`│`);
    lines.push(`│ ${BOLD}Session Cache${RESET}`);
    if (cache.totalHits > 0 || cache.totalMisses > 0) {
      const hitRate = cache.totalHits > 0
        ? `${(cache.hitRate * 100).toFixed(1)}%`
        : '0.0%';
      lines.push(`│  ${GREEN}✓${RESET} Hits:   ${cache.totalHits}  ${DIM}(${hitRate})${RESET}`);
      lines.push(`│  ${RED}✗${RESET} Misses: ${cache.totalMisses}`);
      if (cache.turnCount != null) {
        lines.push(`│  ${DIM}  Turns:  ${cache.turnCount}  ·  Cost: ${cache.totalCost ?? '-'}${RESET}`);
      }
    } else {
      lines.push(`│  ${DIM}(no data)${RESET}`);
    }
  }

  // ── Sub-agents ───────────────────────────────────────
  if (agents?.agents?.length) {
    lines.push(`│`);
    lines.push(`│ ${BOLD}Sub-agents${RESET} ${DIM}(${agents.agents.length})${RESET}`);
    for (const a of agents.agents) {
      const g = glyph(a.status);
      const dur = a.durationMs ? ` ${DIM}${fmtDur(a.durationMs)}${RESET}` : '';
      const goal = a.goal ? ` ${DIM}${a.goal.slice(0, 50)}${RESET}` : '';
      const err = a.error ? ` ${RED}[${a.error}]${RESET}` : '';
      lines.push(`│  ${g} ${BOLD}${a.type}${RESET} ${DIM}#${a.id}${RESET}${dur}${goal}${err}`);
    }
  }

  // ── MCP ──────────────────────────────────────────────
  if (mcp?.servers?.length) {
    lines.push(`│`);
    lines.push(`│ ${BOLD}MCP servers${RESET} ${DIM}(${mcp.servers.length})${RESET}`);
    for (const s of mcp.servers) {
      const g = glyph(s.status);
      const tools = s.tools?.length ? ` ${DIM}(${s.tools.length}t)${RESET}` : '';
      const err = s.error ? ` ${RED}${s.error}${RESET}` : '';
      lines.push(`│  ${g} ${s.name} ${DIM}${s.status}${RESET}${tools}${err}`);
    }
  }

  // ── LSP ──────────────────────────────────────────────
  if (lsp?.servers?.length) {
    lines.push(`│`);
    lines.push(`│ ${BOLD}LSP servers${RESET} ${DIM}(${lsp.servers.length})${RESET}`);
    for (const s of lsp.servers) {
      const g = glyph(s.status);
      const proj = s.project ? ` ${DIM}· ${s.project}${RESET}` : '';
      const err = s.error ? ` ${RED}${s.error}${RESET}` : '';
      lines.push(`│  ${g} ${s.name} ${DIM}${s.status}${RESET}${proj}${err}`);
    }
  }

  // ── Team ─────────────────────────────────────────────
  if (team?.active) {
    lines.push(`│`);
    lines.push(`│ ${BOLD}Team mode${RESET} ${DIM}${team.mode || 'active'} · ${team.currentPhase || ''}${RESET}`);
    if (team.members?.length) {
      for (const m of team.members) {
        const g = glyph(m.status);
        const model = m.model ? ` ${DIM}[${m.model}]${RESET}` : '';
        lines.push(`│  ${g} ${m.role} ${DIM}${m.status}${RESET}${model}`);
      }
    }
  }

  lines.push(`└─────────────────────────────────────────────${RESET}`);

  return lines.join('\n');
}

// ── Args ───────────────────────────────────────────────

const HELP_TEXT = `Usage: node scripts/monitor.mjs [options]

Options:
  --once             Single snapshot, no polling loop
  --interval <ms>    Polling interval in milliseconds (default: 1000)
  --help, -h         Show this help message
`;

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

// Parse --interval
let pollInterval = 1000;
const intervalIdx = args.indexOf('--interval');
if (intervalIdx !== -1 && intervalIdx + 1 < args.length) {
  const parsed = parseInt(args[intervalIdx + 1], 10);
  if (!isNaN(parsed) && parsed > 0) {
    pollInterval = parsed;
  }
}

if (args.includes('--once')) {
  // Single snapshot
  console.log(render());
  process.exit(0);
}

// Live dashboard — polling mode
if (!existsSync(STATUS_DIR)) {
  console.error(`Status directory not found: ${STATUS_DIR}`);
  console.error('Start yu-agent first to generate status files.');
  process.exit(1);
}

let frame = 0;
function tick() {
  const ts = new Date().toLocaleTimeString();
  console.log(`${CLEAR}${DIM}polling @ ${ts} · frame ${++frame} · interval ${pollInterval}ms${RESET}`);
  console.log(render());
}

tick();
const intervalId = setInterval(tick, pollInterval);

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  clearInterval(intervalId);
  console.log(`\n${DIM}monitor stopped${RESET}`);
  process.exit(0);
});
