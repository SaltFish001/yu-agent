/**
 * yu-agent — Memory CLI commands.
 *
 * Provides `yu memory <subcommand>` CLI for ring buffer management.
 * Facts and scene commands removed — they belong to 予鱼, not yu-agent.
 *
 * Usage:
 *   yu memory stats                — Show ring buffer stats
 *   yu memory recent [n]           — Show recent ring entries
 *   yu memory health               — Run memory subsystem health check
 */

import {
  ringRecent,
  ringStats,
  memoryHealth,
} from './memory/index.js';

// ── Input sanitizer ────────────────────────────────────

const MAX_INPUT_LENGTH = 512;
// biome-ignore lint/complexity/useRegexLiterals: need RegExp to avoid control char lint
const CONTROL_CHAR_RE = new RegExp('[\\x00-\\x1F\\x7F]', 'g');

function sanitizeInput(value: string): string {
  return value
    .replace(CONTROL_CHAR_RE, '')
    .slice(0, MAX_INPUT_LENGTH);
}

function sanitizeArgsArray(arr: string[]): string[] {
  return arr.map(sanitizeInput);
}

export async function memoryCommand(
  subcommand: string,
  args: string[],
): Promise<string> {
  subcommand = sanitizeInput(subcommand);
  args = sanitizeArgsArray(args);

  switch (subcommand) {
    // ── stats ────────────────────────────────────────
    case 'stats': {
      const r = ringStats();
      return [
        `Ring memory: ${r.total} entries`,
        `  platforms: ${JSON.stringify(r.by_platform)}`,
      ].join('\n');
    }

    // ── recent ───────────────────────────────────────
    case 'recent': {
      const n = parseInt(args[0], 10) || 15;
      const msgs = ringRecent(n);
      if (msgs.length === 0) return 'No ring memory entries.';
      return msgs
        .map((m) => {
          const time = new Date(m.created_at).toLocaleString();
          const role = m.role === 'user' ? 'USER' : 'YU';
          return `[${time}] ${role}: ${m.content.slice(0, 300)}`;
        })
        .join('\n\n');
    }

    // ── health ──────────────────────────────────────
    case 'health': {
      const h = memoryHealth();
      const lines: string[] = [
        `Memory subsystem health: ${h.ok ? '✓ OK' : '✗ Issues found'}`,
        '',
        `  Ring buffer  | ${h.components.ring.ok ? '✓' : '✗'} ${h.components.ring.total} entries`,
      ];

      if (h.issues.length > 0) {
        lines.push('', 'Issues:');
        for (const issue of h.issues) {
          lines.push(`  - ${issue}`);
        }
      }

      return lines.join('\n');
    }

    // ── help / unknown ───────────────────────────────
    default:
      return [
        'yu memory — Memory system management',
        '',
        'Usage:',
        '  yu memory stats                  Show ring buffer stats',
        '  yu memory recent [n]             Show recent ring entries',
        '  yu memory health                 Run memory health check',
      ].join('\n');
  }
}
