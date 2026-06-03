/**
 * yu-agent — Memory plugin (Pi extension).
 *
 * Wires the ring buffer memory into the Pi lifecycle:
 * - Auto-saves each user/assistant message to ring buffer
 * - Provides /memory CLI command for querying
 * - Lifecycle management via MemoryLifecycle (init/shutdown)
 *
 * Installation: add to pi.extensions in package.json
 */

import { createLogger } from './logger.js';
const log = createLogger('memory-plugin');

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  memoryHealth, RingMemory,
} from './memory/index.js';
import type { IMemoryRing, MemoryPluginConfig } from './types.js';
import { resolve } from 'node:path';
import { YU_HOME } from './paths.js';
import { existsSync, readFileSync } from 'node:fs';

// ── Default config ─────────────────────────────────────

function loadPluginConfig(): MemoryPluginConfig {
  const configPath = resolve(YU_HOME, 'config.json');
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw.memory ?? {};
    }
  } catch { /* best-effort */ }
  return {};
}

// ── Memory lifecycle manager ───────────────────────────

export class MemoryLifecycle {
  private _ring: IMemoryRing;
  private _config: MemoryPluginConfig;
  private _initialized = false;

  constructor(options?: { ring?: IMemoryRing; config?: MemoryPluginConfig }) {
    this._config = options?.config ?? loadPluginConfig();
    this._ring = options?.ring ?? new RingMemory({
      maxEntries: this._config.ringMaxEntries,
      overflowStrategy: this._config.overflowStrategy,
    });
  }

  /** Get the ring buffer instance. */
  get ring(): IMemoryRing { return this._ring; }

  /** Get the plugin config. */
  get config(): MemoryPluginConfig { return this._config; }

  /**
   * Initialize the memory subsystem.
   * Runs a health check and logs the result.
   * Safe to call multiple times — only runs once.
   */
  init(): void {
    if (this._initialized) return;
    this._initialized = true;

    try {
      const health = memoryHealth();
      if (!health.ok) {
        log.warn('init: Health check found issues', { issues: health.issues.join('; ') });
      } else {
        log.info('init: OK', { ring: health.components.ring.total });
      }
    } catch (e) {
      log.warn('init: Health check failed', e);
    }
  }

  /**
   * Shut down the memory subsystem.
   * Closes database connections and releases resources.
   */
  shutdown(): void {
    if (!this._initialized) return;
    this._initialized = false;

    try {
      if (this._ring instanceof RingMemory) {
        (this._ring as RingMemory).close();
      }
      log.info('shutdown: memory subsystem shut down');
    } catch (e) {
      log.warn('shutdown: error during shutdown', e);
    }
  }
}

// ── Global state ───────────────────────────────────────

let _lifecycle: MemoryLifecycle | null = null;

export function getMemoryLifecycle(options?: { config?: MemoryPluginConfig }): MemoryLifecycle {
  if (!_lifecycle) {
    _lifecycle = new MemoryLifecycle({ config: options?.config });
    _lifecycle.init();
  }
  return _lifecycle;
}

export function resetMemoryLifecycle(): void {
  if (_lifecycle) {
    _lifecycle.shutdown();
    _lifecycle = null;
  }
}

// ── Plugin entry ───────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const lifecycle = getMemoryLifecycle();
  lifecycle.init();

  // ── Startup health check (non-blocking) ──
  pi.on('session_start', async () => {
    try {
      const health = memoryHealth();
      if (!health.ok) {
        log.warn('Health check found issues', { issues: health.issues.join('; ') });
      }
    } catch (e) {
      log.warn('Health check failed', e);
    }
  });

  // ── Auto-save user messages ──
  pi.on('before_agent_start', (event: { systemPrompt: string; prompt?: string }) => {
    if (event.prompt) {
      try {
        lifecycle.ring.append('user', event.prompt, 'pi');
      } catch (e) {
        log.warn('Failed to save user message', e);
      }
    }
  });

  // ── Auto-save assistant messages ──
  pi.on('turn_end', (event: { message: { role: string; content?: unknown } }) => {
    if (event.message.role === 'assistant') {
      const text = extractText(event.message);
      if (text.trim()) {
        try {
          lifecycle.ring.append('assistant', text, 'pi');
        } catch (e) {
          log.warn('Failed to save assistant message', e);
        }
      }
    }
  });

  // ── /memory slash command ──
  pi.registerCommand('memory', {
    description: '记忆系统查询。用法: /memory recent [n], /memory stats',
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || '';

      // /memory recent [n]
      if (sub === 'recent' || (sub === '' && parts.length <= 1)) {
        const n = parseInt(parts[1], 10) || 10;
        const msgs = lifecycle.ring.recent(n);
        const lines = msgs.map(m => {
          const time = new Date(m.created_at).toLocaleTimeString();
          const role = m.role === 'user' ? 'You' : 'Yu';
          return `[${time}] ${role}: ${m.content.slice(0, 200)}`;
        });
        ctx.ui.notify(
          lines.length > 0
            ? `Recent memory (${lines.length}):\n${lines.join('\n')}`
            : 'No memory entries yet.',
          'info',
        );
        return;
      }

      // /memory stats
      if (sub === 'stats') {
        const memStats = lifecycle.ring.stats();
        const lines = [
          `Ring memory: ${memStats.total} entries`,
          `  by platform: ${JSON.stringify(memStats.by_platform)}`,
        ];
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      ctx.ui.notify(
        'Usage: /memory recent [n], /memory stats',
        'warning',
      );
    },
  });

  // Register process exit handler for cleanup
  process.once('exit', () => {
    lifecycle.shutdown();
  });
}

function extractText(msg: { content?: unknown; role?: string }): string {
  if (!msg.content) return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: Record<string, unknown>) => b.text as string)
      .join('\n');
  }
  return '';
}
