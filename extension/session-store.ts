/**
 * yu-agent — Session metadata & message persistence.
 *
 * Captures session display name from the first user prompt,
 * persists conversation messages to the SQLite database,
 * and writes session metadata (cwd, agent, model, parent).
 *
 * Moved from extension/index.ts + extension/monitor.ts — part of multi-plugin split.
 *
 * Installation: listed as ./extension/session-store.ts in pi.extensions
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getSessionTag, getSessionAgent, getSessionModel, getSessionParent } from './session-context.js';
import { upsertSession, insertMessage, ensureSlug } from './db.js';

/**
 * Extract text content from an AgentMessage-like object.
 * Content can be a string or an array of content blocks.
 */
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

export default function (pi: ExtensionAPI): void {
  // ── In-memory dedup set for assistant messages ──
  const _savedMessages = new Set<string>();

  pi.on('before_agent_start', (event: { systemPrompt: string; prompt?: string }) => {
    // ── Capture first user prompt as session display name ──
    if (!process.env.YU_NAME_CAPTURED && event.prompt) {
      process.env.YU_NAME_CAPTURED = '1';
      const summary = event.prompt
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      if (summary) {
        process.env.YU_SESSION_NAME = summary;
        const tag = getSessionTag();
        upsertSession(tag, {
          name: summary,
          cwd: process.cwd(),
          agent: getSessionAgent() || undefined,
          model: getSessionModel() !== '{}' ? getSessionModel() : undefined,
          parentId: getSessionParent() || undefined,
        });
      }
    }

    // ── Save user message (every before_agent_start = each user prompt) ──
    if (event.prompt) {
      try {
        const tag = getSessionTag();
        insertMessage(tag, 'user', event.prompt);
        ensureSlug(tag); // ensure slug exists on first user message
      } catch (e) {
        console.warn('[yu-agent] Failed to save user message:', e);
      }
    }
  });

  // ── Save assistant messages to messages table (with dedup) ──
  pi.on('turn_end', (event: { message: { role: string; content?: unknown } }) => {
    const tag = getSessionTag();
    const role = event.message.role;

    if (role === 'assistant') {
      const text = extractText(event.message);
      if (text.trim()) {
        const key = `assistant:${text.slice(0, 200)}:${Date.now()}`;
        if (!_savedMessages.has(key)) {
          _savedMessages.add(key);
          try {
            insertMessage(tag, 'assistant', text);
            ensureSlug(tag);
          } catch (e) {
            console.warn('[yu-agent] Failed to save assistant message:', e);
          }
        }
      }
    }
  });
}
