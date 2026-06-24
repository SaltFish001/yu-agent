/**
 * yu-agent — Team mode: runtime lifecycle
 *
 * Team runtime creation, status tracking, and shutdown/cleanup.
 * Runtime state stored at ~/.yu/runtime/{teamRunId}/state.json
 */

import crypto from 'crypto'

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import path from 'path'
import { ensureDirs, getInboxDir, getRuntimeDir, getStatePath, resolveBaseDir } from './mailbox.js'
import { type RuntimeState, type RuntimeStateMember, RuntimeStateSchema, type TeamSpec } from './types.js'

// ── Errors ─────────────────────────────────────────────

export class TeamNotFoundError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'TeamNotFoundError'
  }
}

// ── Allowed runtime transitions ────────────────────────

const ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  creating: new Set(['active', 'failed']),
  active: new Set(['shutdown_requested', 'deleting']),
  shutdown_requested: new Set(['deleting']),
  deleting: new Set(['deleted']),
  deleted: new Set(),
  failed: new Set(),
  orphaned: new Set(),
}

// ── State read/write ───────────────────────────────────

async function readState(baseDir: string, teamRunId: string): Promise<RuntimeState> {
  const content = await readFile(getStatePath(baseDir, teamRunId), 'utf-8')
  const parsed = RuntimeStateSchema.safeParse(JSON.parse(content))
  if (!parsed.success) throw new Error(`Invalid runtime state: ${parsed.error.message}`)
  return parsed.data
}

async function writeState(baseDir: string, state: RuntimeState): Promise<void> {
  const statePath = getStatePath(baseDir, state.teamRunId)
  const dir = path.dirname(statePath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${statePath}.tmp.${process.pid}`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  await rename(tmp, statePath)
}

// ── Per-team-run exclusive access (Promise-chain mutex) ──
// Ensures readState → fn → writeState is linearized within the same process.
const transitionQueues = new Map<string, Promise<void>>()

// ── Transition helper ──────────────────────────────────

async function transitionState(teamRunId: string, fn: (state: RuntimeState) => RuntimeState): Promise<RuntimeState> {
  const baseDir = resolveBaseDir()

  // Chain after the previous transition for this teamRunId, guaranteeing
  // that concurrent calls execute sequentially and never interleave.
  const prev = transitionQueues.get(teamRunId) ?? Promise.resolve()

  const work = prev.then(async () => {
    const state = await readState(baseDir, teamRunId)
    const newState = fn(state)

    if (newState.status !== state.status) {
      const allowed = ALLOWED_TRANSITIONS[state.status]
      if (!allowed?.has(newState.status) && newState.status !== 'orphaned') {
        throw new Error(`Invalid runtime transition: ${state.status} -> ${newState.status}`)
      }
    }

    const validated = RuntimeStateSchema.parse(newState)
    await writeState(baseDir, validated)
    return validated
  })

  // Always resolve the queue promise so a failed transition doesn't
  // permanently block subsequent operations for this teamRunId.
  transitionQueues.set(
    teamRunId,
    work.then(
      () => {},
      () => {},
    ),
  )

  return work
}

// ── Create team run ────────────────────────────────────

export interface TeamCreateOptions {
  spec: TeamSpec
  leadSessionId?: string
}

export async function createTeamRun(options: TeamCreateOptions): Promise<RuntimeState> {
  const baseDir = resolveBaseDir()
  const teamRunId = crypto.randomUUID()

  await ensureDirs(baseDir, teamRunId)

  // 并行创建 inbox 目录
  await Promise.all(
    options.spec.members.map((member) =>
      mkdir(getInboxDir(baseDir, teamRunId, member.name), { recursive: true, mode: 0o700 }),
    ),
  )

  const runtimeState: RuntimeState = {
    version: 1,
    teamRunId,
    teamName: options.spec.name,
    specSource: 'user',
    createdAt: Date.now(),
    status: 'creating',
    leadSessionId: options.leadSessionId,
    members: options.spec.members.map((m) => ({
      name: m.name,
      agentType: options.spec.leadAgentId === m.name ? 'leader' : 'general-purpose',
      status: 'pending',
      color: m.color,
      subagent_type: m.kind === 'subagent_type' ? m.subagent_type : undefined,
      category: m.kind === 'category' ? m.category : undefined,
      model: m.model,
      pendingInjectedMessageIds: [],
    })),
    shutdownRequests: [],
    bounds: {
      maxMembers: options.spec.members.length,
      maxParallelMembers: Math.min(options.spec.members.length, 4),
      maxMessagesPerRun: 10000,
      maxWallClockMinutes: 120,
      maxMemberTurns: 500,
    },
  }

  const validated = RuntimeStateSchema.parse(runtimeState)
  validated.status = 'active'
  await writeState(baseDir, validated)
  return validated
}

// ── Status ─────────────────────────────────────────────

export async function getTeamStatus(teamRunId: string): Promise<RuntimeState> {
  try {
    return await readState(resolveBaseDir(), teamRunId)
  } catch {
    throw new TeamNotFoundError(`Team run not found: ${teamRunId}`)
  }
}

export async function listActiveTeams(): Promise<RuntimeState[]> {
  const baseDir = resolveBaseDir()
  const runtimeDir = getRuntimeDir(baseDir, '')
  const parentDir = path.dirname(runtimeDir)
  try {
    const entries = await readdir(parentDir, { withFileTypes: true })
    const states: RuntimeState[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const s = await readState(baseDir, entry.name)
        if (['active', 'creating', 'shutdown_requested'].includes(s.status)) {
          states.push(s)
        }
      } catch {
        /* skip */
      }
    }
    return states
  } catch {
    return []
  }
}

// ── Shutdown lifecycle ─────────────────────────────────

export async function requestShutdown(
  teamRunId: string,
  memberId: string,
  requesterName?: string,
): Promise<RuntimeState> {
  return transitionState(teamRunId, (state) => ({
    ...state,
    status: 'shutdown_requested',
    shutdownRequests: [
      ...state.shutdownRequests,
      { memberId, requesterName: requesterName ?? memberId, requestedAt: Date.now() },
    ],
  }))
}

export async function approveShutdown(teamRunId: string, memberName: string): Promise<RuntimeState> {
  return transitionState(teamRunId, (state) => ({
    ...state,
    status: 'deleting',
    shutdownRequests: state.shutdownRequests.map((r) =>
      r.memberId === memberName ? { ...r, approvedAt: Date.now() } : r,
    ),
  }))
}

export async function rejectShutdown(teamRunId: string, memberName: string, reason: string): Promise<RuntimeState> {
  return transitionState(teamRunId, (state) => ({
    ...state,
    status: 'active',
    shutdownRequests: state.shutdownRequests.map((r) =>
      r.memberId === memberName ? { ...r, rejectedAt: Date.now(), rejectedReason: reason } : r,
    ),
  }))
}

export async function deleteTeamRun(teamRunId: string, force = false): Promise<void> {
  const baseDir = resolveBaseDir()
  if (!force) {
    const state = await getTeamStatus(teamRunId)
    const activeMembers = state.members.filter((m) => ['running', 'idle'].includes(m.status))
    if (activeMembers.length > 0) {
      throw new Error(
        `Cannot delete team with active members: ${activeMembers.map((m) => m.name).join(', ')}. Use force=true.`,
      )
    }
  }
  const dir = getRuntimeDir(baseDir, teamRunId)
  await rm(dir, { recursive: true, force: true })
}

export async function updateMemberSession(
  teamRunId: string,
  memberName: string,
  updates: Partial<RuntimeStateMember>,
): Promise<RuntimeState> {
  return transitionState(teamRunId, (state) => ({
    ...state,
    members: state.members.map((m) => (m.name === memberName ? { ...m, ...updates } : m)),
  }))
}
