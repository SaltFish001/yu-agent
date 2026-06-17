/**
 * yu-agent — Team mode: types & schemas
 *
 * OMO-style team orchestration types, ported to yu-agent.
 * Core concepts:
 *   - TeamSpec:  declarative team definition (name, members, lead)
 *   - Message:   async peer-to-peer message via filesystem mailboxes
 *   - Task:      shared task board item
 *   - RuntimeState: durable runtime state per team run
 */

import { z } from 'zod'

// ── Message kinds ──────────────────────────────────────

export const MESSAGE_KINDS = [
  'message',
  'shutdown_request',
  'shutdown_approved',
  'shutdown_rejected',
  'announcement',
] as const

export const MEMBER_KINDS = ['category', 'subagent_type'] as const
export const TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'completed', 'deleted'] as const
export const RUNTIME_STATUSES = [
  'creating',
  'active',
  'shutdown_requested',
  'deleting',
  'deleted',
  'failed',
  'orphaned',
] as const

// ── Member schema ──────────────────────────────────────

const MemberBaseSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/),
    cwd: z.string().optional(),
    worktreePath: z.string().optional(),
    model: z.string().optional(),
    backendType: z.enum(['in-process', 'tmux']).default('in-process'),
    color: z.string().optional(),
    isActive: z.boolean().default(true),
  })
  .strict()

export const CategoryMemberSchema = MemberBaseSchema.extend({
  kind: z.literal('category'),
  category: z.string().min(1),
  prompt: z.string().min(1),
})

export const SubagentMemberSchema = MemberBaseSchema.extend({
  kind: z.literal('subagent_type'),
  subagent_type: z.string().min(1),
  prompt: z.string().optional(),
})

export const MemberSchema = z.discriminatedUnion('kind', [CategoryMemberSchema, SubagentMemberSchema])

// ── Team spec schema ───────────────────────────────────

export const TeamSpecSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/),
    description: z.string().optional(),
    createdAt: z
      .number()
      .int()
      .positive()
      .default(() => Date.now()),
    leadAgentId: z.string().optional(),
    teamAllowedPaths: z.array(z.string()).optional(),
    members: z.array(MemberSchema).min(1).max(8),
  })
  .superRefine((spec, ctx) => {
    if (spec.leadAgentId === undefined && spec.members.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'leadAgentId required when team has multiple members. Add lead: { kind: "subagent_type", subagent_type: "sisyphus" } or mark one member with isLead: true.',
        path: ['leadAgentId'],
      })
    }
  })
  .transform((spec) => {
    if (spec.leadAgentId !== undefined) return spec
    const first = spec.members[0]
    if (!first) throw new Error('Team must have at least one member')
    return { ...spec, leadAgentId: first.name }
  })

// ── Message schema ─────────────────────────────────────

export const MessageSchema = z.object({
  version: z.literal(1),
  messageId: z.string().uuid(),
  from: z.string(),
  to: z.string(), // member name or '*' for broadcast
  kind: z.enum(MESSAGE_KINDS),
  body: z.string().max(32 * 1024),
  summary: z.string().optional(),
  references: z.array(z.object({ path: z.string(), description: z.string().optional() })).optional(),
  timestamp: z.number().int().positive(),
  correlationId: z.string().uuid().optional(),
  color: z.string().optional(),
})

// ── Task schema ────────────────────────────────────────

export const TaskSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  subject: z.string(),
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  owner: z.string().optional(),
  blocks: z.array(z.string()).default([]),
  blockedBy: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  claimedAt: z.number().int().positive().optional(),
})

// ── Runtime state schema ───────────────────────────────

export const RuntimeStateMemberSchema = z
  .object({
    name: z.string(),
    sessionId: z.string().optional(),
    agentType: z.enum(['leader', 'general-purpose']),
    subagent_type: z.string().optional(),
    category: z.string().optional(),
    model: z.string().optional(),
    modelProvider: z.string().optional(),
    status: z.enum(['pending', 'running', 'idle', 'errored', 'completed', 'shutdown_approved']),
    color: z.string().optional(),
    worktreePath: z.string().optional(),
    lastInjectedTurnMarker: z.string().optional(),
    pendingInjectedMessageIds: z.array(z.string()).default([]),
  })
  .strict()

export const RuntimeStateSchema = z.object({
  version: z.literal(1),
  teamRunId: z.string().uuid(),
  teamName: z.string(),
  specSource: z.enum(['project', 'user']),
  createdAt: z.number().int().positive(),
  status: z.enum(RUNTIME_STATUSES),
  leadSessionId: z.string().optional(),
  members: z.array(RuntimeStateMemberSchema),
  shutdownRequests: z
    .array(
      z.object({
        memberId: z.string(),
        requesterName: z.string(),
        requestedAt: z.number().int().positive(),
        approvedAt: z.number().int().positive().optional(),
        rejectedReason: z.string().optional(),
        rejectedAt: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  bounds: z.object({
    maxMembers: z.number().int().default(8),
    maxParallelMembers: z.number().int().default(4),
    maxMessagesPerRun: z.number().int().default(10000),
    maxWallClockMinutes: z.number().int().default(120),
    maxMemberTurns: z.number().int().default(500),
  }),
})

// ── Type exports ───────────────────────────────────────

export type TeamSpec = z.infer<typeof TeamSpecSchema>
export type Member = z.infer<typeof MemberSchema>
export type CategoryMember = z.infer<typeof CategoryMemberSchema>
export type SubagentMember = z.infer<typeof SubagentMemberSchema>
export type Message = z.infer<typeof MessageSchema>
export type Task = z.infer<typeof TaskSchema>
export type RuntimeStateMember = z.infer<typeof RuntimeStateMemberSchema>
export type RuntimeState = z.infer<typeof RuntimeStateSchema>
