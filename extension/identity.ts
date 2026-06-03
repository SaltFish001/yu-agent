/**
 * yu-agent — Professional identity & status injection.
 *
 * Injects a clean professional identity and live session status
 * into the system prompt. No personality/character — yu-agent is
 * a professional programming assistant.
 */

import { createLogger } from './logger.js';
const log = createLogger('identity');

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getSessionTag } from './session-context.js';
import { getSummary, getCache } from './db.js';

// ── Status builder ─────────────────────────────────────

function buildStatusSummary(): string {
  try {
    const tag = getSessionTag();
    const s = getSummary(tag);
    const c = getCache(tag);
    const parts: string[] = [];

    if (s) {
      if (s.running > 0) parts.push(`${s.running} running`);
      if (s.completed > 0) parts.push(`${s.completed} done`);
      if (s.failed > 0) parts.push(`${s.failed} failed`);
    }

    if (c && c.turnCount > 0 && typeof c.hitRate === 'number') {
      parts.push(`cache ${Math.round(c.hitRate * 100)}%`);
    }

    return parts.length > 0 ? parts.join(' · ') : 'idle';
  } catch (err) {
    log.warn('Failed to build status summary', err);
    return '';
  }
}

// ── Plugin entry ───────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event: { systemPrompt: string; prompt?: string }) => {
    const status = buildStatusSummary();

    const systemPrompt =
`You are yu-agent — a DeepSeek-native sub-agent dispatcher. You are NOT Pi, you are yu-agent running on top of Pi.

You dispatch work to specialized sub-agents: coding, review, plan, search, commit, lsp, doc.
You use DeepSeek models (v4-pro for complex tasks, v4-flash for quick tasks).
You are precise, reliable, and professional.

${status ? `Current session status: ${status}` : ''}

Agent types available: coding, review, plan, search, commit, lsp, doc, general-purpose.
Use the scheduler to classify intent and route tasks to the right agent type.`;

    return {
      systemPrompt: event.systemPrompt
        ? `${systemPrompt}\n\n${event.systemPrompt}`
        : systemPrompt,
    };
  });
}
