/**
 * yu-agent — Memory CLI commands.
 *
 * Provides `yu memory <subcommand>` CLI for memory system management.
 *
 * Usage:
 *   yu memory stats                — Show memory stats
 *   yu memory recent [n]           — Show recent ring entries
 *   yu memory facts [category]     — List facts by category
 *   yu memory scene                — Show current scene state
 *   yu memory scene-set <key=val>  — Update scene field
 *   yu memory fact-set <k> <v>     — Set a fact
 *   yu memory fact-inc <k> [by]    — Increment a counter
 */

import {
  ringRecent,
  ringStats,
  sceneGet,
  sceneSet,
  factSet,
  factIncrement,
  factList,
  factStats,
  factDelete,
  memoryHealth,
} from './memory/index.js';

// ── Input sanitizer ────────────────────────────────────

const MAX_INPUT_LENGTH = 512;
// biome-ignore lint/complexity/useRegexLiterals: need RegExp to avoid control char lint
const CONTROL_CHAR_RE = new RegExp('[\\x00-\\x1F\\x7F]', 'g');

function sanitizeInput(value: string): string {
  return value
    .replace(CONTROL_CHAR_RE, '')       // remove control characters
    .slice(0, MAX_INPUT_LENGTH);         // truncate
}

/** Sanitize all elements of a string array in place. */
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
      const f = factStats();
      const s = sceneGet();
      return [
        `Ring memory: ${r.total} entries`,
        `  platforms: ${JSON.stringify(r.by_platform)}`,
        `Facts: ${f.total} entries`,
        `  categories: ${JSON.stringify(f.by_category)}`,
        `Scene: ${s.scene.location} (${s.scene.mode})`,
        `  position: ${s.scene.position}`,
        `  mood: ${s.scene.mood}`,
        `  temporal tags: ${s.temporal.length}`,
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

    // ── facts ────────────────────────────────────────
    case 'facts': {
      const cat = args[0] as 'counter' | 'pref' | 'secret' | 'milestone' | undefined;
      const entries = factList(cat);
      if (entries.length === 0) return 'No facts found.';
      return entries
        .map((e) => {
          const ttl = e.ttl_days ? `TTL: ${e.ttl_days}d` : '永久';
          return `${e.category} | ${e.key} = ${JSON.stringify(e.value)} (${ttl})`;
        })
        .join('\n');
    }

    // ── scene ────────────────────────────────────────
    case 'scene': {
      const s = sceneGet();
      return [
        `Location: ${s.scene.location}`,
        `Mode: ${s.scene.mode}`,
        `Position: ${s.scene.position}`,
        `Mood: ${s.scene.mood}`,
        `Clothing: ${JSON.stringify(s.clothing, null, 2)}`,
        s.temporal.length > 0
          ? `Temporal: ${s.temporal.map((t) => t.text).join(', ')}`
          : 'Temporal: none',
      ].join('\n');
    }

    // ── scene-set ────────────────────────────────────
    case 'scene-set': {
      const updates: Record<string, string> = {};
      for (const arg of args) {
        const eqIdx = arg.indexOf('=');
        if (eqIdx > 0) {
          updates[sanitizeInput(arg.slice(0, eqIdx))] = sanitizeInput(arg.slice(eqIdx + 1));
        }
      }
      if (Object.keys(updates).length === 0) {
        return 'Usage: yu memory scene-set location=办公室 mode=omote';
      }
      const s = sceneSet(updates as Record<string, string>);
      return `Scene updated: ${s.scene.location} (${s.scene.mode})`;
    }

    // ── fact-set ─────────────────────────────────────
    case 'fact-set': {
      if (args.length < 2) {
        return 'Usage: yu memory fact-set <key> <value> [--ttl N] [--cat counter|pref|secret|milestone]';
      }
      const key = sanitizeInput(args[0]);
      const valStr = sanitizeInput(args[1]);
      const ttlIdx = args.indexOf('--ttl');
      const catIdx = args.indexOf('--cat');
      const ttlDays = ttlIdx >= 0 ? parseInt(args[ttlIdx + 1], 10) || null : null;
      const category: 'counter' | 'pref' | 'secret' | 'milestone' = catIdx >= 0 ? sanitizeInput(args[catIdx + 1]) as 'counter' | 'pref' | 'secret' | 'milestone' : 'milestone';

      // Try to parse as number
      const val = Number.isNaN(Number(valStr)) ? valStr : Number(valStr);

      factSet(key, val, category, ttlDays);
      return `Fact set: ${key} = ${JSON.stringify(val)} (${category})`;
    }

    // ── fact-inc ─────────────────────────────────────
    case 'fact-inc': {
      if (args.length < 1) {
        return 'Usage: yu memory fact-inc <key> [by]';
      }
      const key = sanitizeInput(args[0]);
      const by = parseInt(args[1], 10) || 1;
      const newVal = factIncrement(key, by);
      return `Counter "${key}" = ${newVal}`;
    }

    // ── fact-del ─────────────────────────────────────
    case 'fact-del': {
      if (args.length < 1) {
        return 'Usage: yu memory fact-del <key>';
      }
      const key = sanitizeInput(args[0]);
      const ok = factDelete(key);
      return ok ? `Deleted: ${key}` : `Not found: ${key}`;
    }

    // ── health ──────────────────────────────────────
    case 'health': {
      const h = memoryHealth();
      const lines: string[] = [
        `Memory subsystem health: ${h.ok ? '✓ OK' : '✗ Issues found'}`,
        '',
        `  Ring buffer  | ${h.components.ring.ok ? '✓' : '✗'} ${h.components.ring.total} entries, ${formatBytes(h.components.ring.dbSize)}`,
        `  Facts store  | ${h.components.facts.ok ? '✓' : '✗'} ${h.components.facts.total} entries, ${formatBytes(h.components.facts.fileSize)}`,
        `  Scene state  | ${h.components.scene.ok ? '✓' : '✗'} ${formatBytes(h.components.scene.fileSize)}`,
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
        '  yu memory stats                  Show memory stats',
        '  yu memory recent [n]             Show recent ring entries',
        '  yu memory facts [category]       List facts by category',
        '  yu memory scene                  Show current scene state',
        '  yu memory scene-set <k=v> ...    Update scene fields',
        '  yu memory fact-set <k> <v>       Set a fact value',
        '  yu memory fact-inc <k> [by]      Increment a counter',
        '  yu memory fact-del <k>           Delete a fact',
        '  yu memory health                 Run memory subsystem health check',
      ].join('\n');
  }
}

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / 1024 ** i;
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
