/**
 * yu-agent — Team mode: main integration module
 *
 * Ties together mailbox, tasklist, runtime, and registry into a coherent
 * team orchestration system.  Re-exports everything for external consumers
 * and exposes teamCommand() for CLI dispatch.
 */

// ── Local imports (used by teamCommand) ────────────────

import { randomUUID } from 'node:crypto';
import { sendMessage } from './mailbox.js';
import {
  createTask, getTask, listTasks, updateTaskStatus,
} from './tasklist.js';
import {
  createTeamRun, getTeamStatus, listActiveTeams,
  requestShutdown, deleteTeamRun,
} from './runtime.js';
import {
  saveTeamSpec, listTeamSpecs, buildInlineSpec,
} from './registry.js';
import { TeamSpecSchema } from './types.js';
import type { Task } from './types.js';

// ── Re-exports ─────────────────────────────────────────

export {
  pollAndInject, ackMessages, buildEnvelope, sendMessage, listUnread,
} from './mailbox.js';

export type { InjectionResult } from './mailbox.js';

export {
  createTask, getTask, listTasks, updateTaskStatus, claimTask, deleteTask,
  InvalidTaskTransitionError, BlockedByError, AlreadyClaimedError,
} from './tasklist.js';

export {
  createTeamRun, getTeamStatus, listActiveTeams,
  requestShutdown, approveShutdown, rejectShutdown, deleteTeamRun,
  updateMemberSession,
  TeamNotFoundError,
} from './runtime.js';

export type { TeamCreateOptions } from './runtime.js';

export {
  loadTeamSpec, saveTeamSpec, listTeamSpecs, buildInlineSpec,
} from './registry.js';

export {
  TeamSpecSchema, MemberSchema, MessageSchema, TaskSchema, RuntimeStateSchema,
} from './types.js';

export type {
  TeamSpec, Member, Message, Task, RuntimeState, RuntimeStateMember,
} from './types.js';

// ── CLI dispatcher ─────────────────────────────────────

/**
 * CLI handler for `yu team <subcommand> [args...]`
 */
export async function teamCommand(subcommand: string, args: string[]): Promise<string> {
  switch (subcommand) {
    case 'create': {
      const name = args[0];
      if (!name) {
        return 'Usage: yu team create <name> [member:role ...]\n'
          + '  e.g. yu team create my-team lead:plan coder:coding reviewer:review';
      }

      // Inline JSON spec
      if (name === '--inline') {
        const raw = JSON.parse(args.slice(1).join(' '));
        const parsed = TeamSpecSchema.parse(raw);
        await saveTeamSpec(parsed);
        const rt = await createTeamRun({ spec: parsed });
        return `Team '${parsed.name}' created (runId: ${rt.teamRunId})\n`
          + `Members: ${parsed.members.map((m) => `${m.name} (${m.kind === 'subagent_type' ? m.subagent_type : m.category})`).join(', ')}`;
      }

      // Simple format: yu team create <name> [member1:role1 member2:role2 ...]
      interface MemberInput { name: string; role: string; prompt: string }
      const memberSpecs: MemberInput[] = args.slice(1).map((m) => {
        const [n, role] = m.split(':');
        return { name: n, role: role || 'coding', prompt: `Work as ${role || 'coding'} member.` };
      });

      if (memberSpecs.length === 0) {
        memberSpecs.push({ name, role: 'coding', prompt: 'Complete the assigned task.' });
      }

      const spec = buildInlineSpec(name, memberSpecs, 0);
      await saveTeamSpec(spec);
      const rt = await createTeamRun({ spec });
      return `Team '${spec.name}' created (runId: ${rt.teamRunId})\n`
        + `Lead: ${spec.leadAgentId}\n`
        + `Members: ${spec.members.map((m) => m.name).join(', ')}`;
    }

    case 'list': {
      const teams = await listActiveTeams();
      if (teams.length === 0) return 'No active teams.';
      return teams.map((t) =>
        `  ${t.teamName} (${t.teamRunId.slice(0, 8)}…) — ${t.status}, ${t.members.length} members`,
      ).join('\n');
    }

    case 'status': {
      const teamRunId = args[0];
      if (!teamRunId) return 'Usage: yu team status <teamRunId>';
      const state = await getTeamStatus(teamRunId);
      return [
        `Team: ${state.teamName}`,
        `RunId: ${state.teamRunId}`,
        `Status: ${state.status}`,
        'Members:',
        ...state.members.map((m) =>
          `  ${m.agentType === 'leader' ? '★' : ' '} ${m.name} — ${m.status}${m.sessionId ? ` (session: ${m.sessionId.slice(0, 8)}…)` : ''}`,
        ),
      ].join('\n');
    }

    case 'send': {
      const [teamRunId, to, ...bodyParts] = args;
      if (!teamRunId || !to || bodyParts.length === 0) {
        return 'Usage: yu team send <teamRunId> <to> <message body>';
      }
      const state = await getTeamStatus(teamRunId);
      const msg = await sendMessage(
        {
          version: 1,
          messageId: randomUUID(),
          from: 'cli',
          to,
          kind: 'message',
          body: bodyParts.join(' '),
          timestamp: Date.now(),
        },
        teamRunId,
        {
          isLead: to === '*' || state.leadSessionId === 'cli',
          activeMembers: state.members.map((m) => m.name),
        },
      );
      return `Message sent to ${msg.deliveredTo.join(', ')} (id: ${msg.messageId})`;
    }

    case 'task': {
      const [teamRunId, action, ...taskArgs] = args;
      if (!teamRunId || !action) {
        return 'Usage: yu team task <teamRunId> <create|list|get|update|delete> [...]';
      }
      switch (action) {
        case 'create': {
          const [subject, ...descParts] = taskArgs;
          if (!subject) return 'Usage: yu team task <teamRunId> create <subject> [description]';
          const t = await createTask(teamRunId, {
            subject,
            description: descParts.join(' ') || '',
          });
          return `Task created: ${t.id} — ${t.subject}`;
        }
        case 'list': {
          const tasks = await listTasks(teamRunId);
          if (tasks.length === 0) return 'No tasks.';
          return tasks.map((t) =>
            `  ${t.id} [${t.status}] ${t.subject}${t.owner ? ` — ${t.owner}` : ''}`,
          ).join('\n');
        }
        case 'get': {
          const taskId = taskArgs[0];
          if (!taskId) return 'Usage: yu team task <teamRunId> get <taskId>';
          const t = await getTask(teamRunId, taskId);
          if (!t) return `Task not found: ${taskId}`;
          return `Task: ${t.id}\n  Subject: ${t.subject}\n  Status: ${t.status}\n  Owner: ${t.owner ?? 'unassigned'}\n  Description: ${t.description}`;
        }
        case 'update': {
          const [taskId, status] = taskArgs;
          if (!taskId || !status) return 'Usage: yu team task <teamRunId> update <taskId> <status>';
          const t = await updateTaskStatus(teamRunId, taskId, status as Task['status'], 'cli');
          return `Task ${t.id} updated to ${t.status}`;
        }
        default:
          return `Unknown task action: ${action}. Available: create, list, get, update, delete`;
      }
    }

    case 'shutdown': {
      const teamRunId = args[0];
      if (!teamRunId) return 'Usage: yu team shutdown <teamRunId>';
      const state = await requestShutdown(teamRunId, 'cli', 'cli');
      return `Shutdown requested for '${state.teamName}'. Members will be notified.`;
    }

    case 'delete': {
      const teamRunId = args[0];
      const force = args.includes('--force');
      if (!teamRunId) return 'Usage: yu team delete <teamRunId> [--force]';
      await deleteTeamRun(teamRunId, force);
      return `Team run ${teamRunId} deleted.`;
    }

    case 'specs': {
      const specs = await listTeamSpecs();
      if (specs.length === 0) {
        return 'No saved team specs. Use `yu team create <name> <members...>` to create one.';
      }
      return specs.map((s) => `  ${s.name}${s.description ? ` — ${s.description}` : ''}`).join('\n');
    }

    default:
      return `Unknown team command: ${subcommand}\n`
        + 'Available: create, list, status, send, task, shutdown, delete, specs';
  }
}
