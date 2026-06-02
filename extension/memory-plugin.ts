/**
 * yu-agent — Memory plugin (Pi extension).
 *
 * Wires the memory subsystem into the Pi lifecycle:
 * - Auto-saves each user/assistant message to ring buffer
 * - Auto-loads scene state for identity injection
 * - Provides /memory CLI command for querying
 *
 * Installation: add to pi.extensions in package.json
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ringAppend, ringRecent, ringStats, sceneGet, factStats, factList } from './memory/index.js';

export default function (pi: ExtensionAPI): void {
  // ── Auto-save user messages ──
  pi.on('before_agent_start', (event: { systemPrompt: string; prompt?: string }) => {
    if (event.prompt) {
      try {
        ringAppend('user', event.prompt, 'pi');
      } catch (e) {
        console.warn('[yu-memory] Failed to save user message:', e);
      }
    }
  });

  // ── Auto-save assistant messages ──
  pi.on('turn_end', (event: { message: { role: string; content?: unknown } }) => {
    if (event.message.role === 'assistant') {
      const text = extractText(event.message);
      if (text.trim()) {
        try {
          ringAppend('assistant', text, 'pi');
        } catch (e) {
          console.warn('[yu-memory] Failed to save assistant message:', e);
        }
      }
    }
  });

  // ── /memory slash command ──
  pi.registerCommand('memory', {
    description: '记忆系统查询。用法: /memory recent [n], /memory stats, /memory facts [category]',
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || '';

      // /memory recent [n]
      if (sub === 'recent' || (sub === '' && parts.length <= 1)) {
        const n = parseInt(parts[1]) || 10;
        const msgs = ringRecent(n);
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
        const memStats = ringStats();
        const factStatsData = factStats();
        const scene = sceneGet();
        const lines = [
          `Ring memory: ${memStats.total} entries`,
          `  by platform: ${JSON.stringify(memStats.by_platform)}`,
          `Facts store: ${factStatsData.total} entries`,
          `  by category: ${JSON.stringify(factStatsData.by_category)}`,
          `Scene: ${scene.scene.location} (${scene.scene.mode})`,
        ];
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      // /memory facts [category]
      if (sub === 'facts') {
        const cat = parts[1] as any;
        const entries = factList(cat);
        if (entries.length === 0) {
          ctx.ui.notify('No facts found.', 'info');
          return;
        }
        const lines = entries.map(e =>
          `  ${e.category} | ${e.key} = ${JSON.stringify(e.value)}${e.ttl_days ? ` (TTL: ${e.ttl_days}d)` : ' (永久)'}`,
        );
        ctx.ui.notify(`Facts (${entries.length}):\n${lines.join('\n')}`, 'info');
        return;
      }

      ctx.ui.notify(
        'Usage: /memory recent [n], /memory stats, /memory facts [category]',
        'warning',
      );
    },
  });
}

/**
 * Extract text content from an AgentMessage-like object.
 */
function extractText(msg: { content?: unknown; role?: string }): string {
  if (!msg.content) return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}
