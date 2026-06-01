/**
 * yu-agent — Session resume context injection.
 *
 * Reads ~/.yu/resume_context.json (written by `yu session resume <tag>`)
 * and injects historical conversation context into the system prompt.
 *
 * Depends on identity.ts having set the base system prompt first
 * (chained via event.systemPrompt).
 *
 * Moved from extension/index.ts — part of multi-plugin split.
 *
 * Installation: listed as ./extension/resumer.ts in pi.extensions
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { YU_HOME } from './paths.js';

export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event: { systemPrompt: string; prompt?: string }) => {
    let resumeBlock = '';
    const resumeFile = resolve(YU_HOME, 'resume_context.json');

    if (existsSync(resumeFile) || process.env.YU_RESUME_TAG) {
      try {
        if (existsSync(resumeFile)) {
          const ctx = JSON.parse(readFileSync(resumeFile, 'utf-8'));
          if (ctx.messages && Array.isArray(ctx.messages) && ctx.messages.length > 0) {
            const historyLines: string[] = ['<history>'];
            for (const msg of ctx.messages) {
              const role = msg.role === 'user' ? 'User' : 'Assistant';
              // Truncate very long messages to avoid token blowup
              const content = (msg.content || '').slice(0, 4000);
              historyLines.push(`<${role}>${content}</${role}>`);
            }
            historyLines.push('</history>');
            resumeBlock = `\n\n以下是你之前会话中的历史消息（从 session "${ctx.tag || process.env.YU_RESUME_TAG}" 恢复）：\n${historyLines.join('\n')}\n\n请基于以上历史上下文继续帮助用户。如果你发现有中断的未完成任务，优先继续完成它。\n`;
          }
          // Clean up the temp file
          unlinkSync(resumeFile);
        }
      } catch (e) {
        console.warn('[yu-agent] Failed to load resume context:', e);
        // Best-effort cleanup
        try { if (existsSync(resumeFile)) unlinkSync(resumeFile); } catch { /* ignore */ }
      }
      delete process.env.YU_RESUME_TAG;
    }

    if (resumeBlock) {
      return {
        systemPrompt: event.systemPrompt + resumeBlock,
      };
    }
  });
}
