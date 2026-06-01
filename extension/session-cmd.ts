/**
 * yu-agent — /session slash command.
 *
 * Provides interactive and non-interactive session management:
 *   /session list        — List recent sessions
 *   /session resume <t>  — Switch to a session
 *   /session show <t>    — Show session details + recent messages
 *
 * Moved from extension/index.ts — part of multi-plugin split.
 *
 * Installation: listed as ./extension/session-cmd.ts in pi.extensions
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { listSessions, getSessionMeta, getMessages } from './db.js';

export default function (pi: ExtensionAPI): void {
  pi.registerCommand('session', {
    description: '查看/恢复历史 session。用法：/session list, /session resume <tag>, /session show <tag>',
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || '';

      if (sub === 'list' || !sub) {
        const sessions = listSessions().filter(s => !s.archivedAt);
        if (sessions.length === 0) {
          ctx.ui.notify('No historical sessions found.', 'info');
          return;
        }

        if (!sub && ctx.hasUI && sessions.length > 0) {
          // Interactive: show select dialog
          const options = sessions.slice(0, 20).map(s => {
            const name = s.name || s.tag.slice(0, 20);
            const agent = s.agent ? `[${s.agent}]` : '';
            const slug = s.slug ? `(${s.slug})` : '';
            return `${name} ${agent}${slug} — ${new Date(s.updatedAt).toLocaleString()}`;
          });

          const choice = await ctx.ui.select('Select session to resume:', options);
          if (!choice) {
            ctx.ui.notify('Session selection cancelled.', 'info');
            return;
          }

          const idx = options.indexOf(choice);
          if (idx === -1 || idx >= sessions.length) return;
          const picked = sessions[idx];
          const meta = getSessionMeta(picked.tag);
          if (!meta) {
            ctx.ui.notify(`Session "${picked.tag}" metadata not found.`, 'error');
            return;
          }

          const md = meta.metadata ? JSON.parse(meta.metadata) : {};
          const piPath = md.piSessionPath;
          if (!piPath || !existsSync(piPath)) {
            ctx.ui.notify(`Session "${picked.tag}" has no recoverable Pi session file.`, 'warning');
            return;
          }

          try {
            await ctx.switchSession(piPath);
            ctx.ui.notify(`Switched to session: ${meta.name || picked.tag}`, 'info');
          } catch (e: any) {
            ctx.ui.notify(`Failed to switch session: ${e.message}`, 'error');
          }
          return;
        }

        // Non-interactive: show table
        const lines = sessions.slice(0, 15).map(s => {
          const name = (s.name || s.tag.slice(0, 20)).padEnd(30);
          const agent = s.agent ? s.agent.padEnd(10) : ' '.repeat(10);
          const time = new Date(s.updatedAt).toLocaleString();
          return `${name} ${agent} ${time}`;
        });
        lines.unshift('Session                          Agent      Updated');
        lines.unshift('─'.repeat(65));
        if (sessions.length > 15) lines.push(`... and ${sessions.length - 15} more`);
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      if (sub === 'resume') {
        const tag = parts.slice(1).join(' ');
        if (!tag) {
          ctx.ui.notify('Usage: /session resume <tag>', 'warning');
          return;
        }
        const meta = getSessionMeta(tag);
        if (!meta) {
          ctx.ui.notify(`Session "${tag}" not found.`, 'error');
          return;
        }
        const md = meta.metadata ? JSON.parse(meta.metadata) : {};
        const piPath = md.piSessionPath;
        if (!piPath || !existsSync(piPath)) {
          ctx.ui.notify(`Session "${tag}" has no recoverable Pi session file.`, 'warning');
          return;
        }
        try {
          await ctx.switchSession(piPath);
          ctx.ui.notify(`Switched to session: ${meta.name || tag}`, 'info');
        } catch (e: any) {
          ctx.ui.notify(`Failed to switch session: ${e.message}`, 'error');
        }
        return;
      }

      if (sub === 'show') {
        const tag = parts.slice(1).join(' ');
        if (!tag) {
          ctx.ui.notify('Usage: /session show <tag>', 'warning');
          return;
        }
        const meta = getSessionMeta(tag);
        if (!meta) {
          ctx.ui.notify(`Session "${tag}" not found.`, 'error');
          return;
        }
        const md = meta.metadata ? JSON.parse(meta.metadata) : {};
        const lines = [
          `Session: ${meta.name || tag}`,
          `  tag: ${tag}`,
          `  slug: ${meta.slug || '—'}`,
          `  agent: ${meta.agent || '—'}`,
          `  cwd: ${meta.cwd}`,
          `  created: ${new Date(meta.createdAt).toLocaleString()}`,
          `  updated: ${new Date(meta.updatedAt).toLocaleString()}`,
          `  archived: ${meta.archivedAt ? new Date(meta.archivedAt).toLocaleString() : 'no'}`,
          `  piSessionPath: ${md.piSessionPath || '—'}`,
          '',
          'Recent messages:',
        ];
        const msgs = getMessages(tag, 5);
        for (const m of msgs) {
          const role = m.role === 'user' ? 'You' : 'yu';
          const content = m.content.slice(0, 200);
          lines.push(`  [${role}] ${content}`);
        }
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      ctx.ui.notify('Unknown subcommand. Usage: /session list, /session resume <tag>, /session show <tag>', 'warning');
    },
  });
}
