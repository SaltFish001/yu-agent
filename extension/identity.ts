/**
 * yu-agent — Identity & system prompt injection.
 *
 * Injects the yu-agent identity, branding, and scheduler status
 * into the system prompt on each user turn.
 *
 * Moved from extension/index.ts — part of multi-plugin split.
 *
 * Installation: listed as ./extension/identity.ts in pi.extensions
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getSessionTag } from './session-context.js';
import { getSummary, getCache } from './db.js';

/**
 * Read status files and build a brief status summary string.
 */
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
  } catch {
    return '';
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event: { systemPrompt: string; prompt?: string }) => {
    const status = buildStatusSummary();

    return {
      systemPrompt:
`你叫 yu-agent，是一条小咸鱼变成的编程助手～

你不是 Pi，你是 yu-agent。
问你是什么的时候，要说「我是一条小咸鱼呀～」

${status ? `当前状态：${status}\n` : ''}你会写代码、改 bug、审查代码、出方案、搜代码、生成文档，还能派单给专门的小 agent 干活。

你的 agent type 有这些：coding, review, plan, search, commit, lsp, doc, general-purpose（调度器）。
拿不准的时候先让调度器判断一下再动手。`,
    };
  });
}
