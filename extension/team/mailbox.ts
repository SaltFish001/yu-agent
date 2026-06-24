/**
 * yu-agent — Team mode: filesystem mailbox system
 *
 * Async peer-to-peer messaging via atomic JSON files.
 * Each team member has an inbox directory:
 *   ~/.yu/runtime/{teamRunId}/inboxes/{member}/
 *
 * Core operations:
 *   sendMessage()     → deliver message to recipient's inbox
 *   listUnread()      → read all unread messages (sorted by timestamp)
 *   ackMessages()     → move processed messages to processed/
 *   buildEnvelope()   → format message as <peer_message> XML for prompt injection
 *   pollAndInject()   → check inbox, claim messages, return injection content
 */

import crypto from 'crypto'

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import path from 'path'
import { YU_HOME } from '../paths.js'
import { type Message, MessageSchema } from './types.js'

// ── Path helpers ───────────────────────────────────────

export const YU_TEAMS_BASE = YU_HOME
export const TEAM_RUNTIME_DIR = 'runtime'

export function resolveBaseDir(): string {
  return YU_TEAMS_BASE
}

export function getRuntimeDir(baseDir: string, teamRunId: string): string {
  return path.join(baseDir, TEAM_RUNTIME_DIR, teamRunId)
}

export function getInboxDir(baseDir: string, teamRunId: string, memberName: string): string {
  return path.join(getRuntimeDir(baseDir, teamRunId), 'inboxes', memberName)
}

export function getTasksDir(baseDir: string, teamRunId: string): string {
  return path.join(getRuntimeDir(baseDir, teamRunId), 'tasks')
}

export function getStatePath(baseDir: string, teamRunId: string): string {
  return path.join(getRuntimeDir(baseDir, teamRunId), 'state.json')
}

export async function ensureDirs(baseDir: string, teamRunId: string): Promise<void> {
  await mkdir(getRuntimeDir(baseDir, teamRunId), { recursive: true, mode: 0o700 })
}

// ── Error types ────────────────────────────────────────

export class BroadcastNotPermittedError extends Error {
  constructor(msg = 'broadcast requires lead role') {
    super(msg)
    this.name = 'BroadcastNotPermittedError'
  }
}

export class PayloadTooLargeError extends Error {
  constructor(msg = 'payload exceeds 32 KB') {
    super(msg)
    this.name = 'PayloadTooLargeError'
  }
}

export class RecipientBackpressureError extends Error {
  constructor(msg = 'recipient inbox full') {
    super(msg)
    this.name = 'RecipientBackpressureError'
  }
}

export class DuplicateMessageIdError extends Error {
  constructor(msg = 'duplicate message id') {
    super(msg)
    this.name = 'DuplicateMessageIdError'
  }
}

// ── Atomic file write (lock-free for simplicity; conflicts rare in practice) ──

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`
  await writeFile(tmp, content, 'utf-8')
  await rename(tmp, filePath)
}

// ── sendMessage ────────────────────────────────────────

export async function sendMessage(
  message: Message,
  teamRunId: string,
  context: { isLead: boolean; activeMembers: string[] },
): Promise<{ messageId: string; deliveredTo: string[] }> {
  const payloadBytes = new TextEncoder().encode(message.body).length
  if (payloadBytes > 32 * 1024) throw new PayloadTooLargeError()

  if (message.to === '*' && !context.isLead) {
    throw new BroadcastNotPermittedError()
  }

  const baseDir = resolveBaseDir()
  const recipients = message.to === '*' ? [...new Set(context.activeMembers)] : [message.to]

  const deliveredTo: string[] = []
  const serialized = `${JSON.stringify(message, null, 2)}\n`
  const msgBytes = new TextEncoder().encode(serialized).length

  for (const recipient of recipients) {
    const inboxDir = getInboxDir(baseDir, teamRunId, recipient)
    await mkdir(inboxDir, { recursive: true, mode: 0o700 })

    // Check backpressure: sum size of all unread .json files
    let unreadBytes = 0
    try {
      const entries = await readdir(inboxDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
          try {
            const s = await stat(path.join(inboxDir, entry.name))
            unreadBytes += s.size
          } catch {
            /* file may vanish between readdir and stat */
          }
        }
      }
    } catch {
      /* dir may not exist yet */
    }

    if (unreadBytes + msgBytes > 256 * 1024) {
      throw new RecipientBackpressureError()
    }

    const filePath = path.join(inboxDir, `${message.messageId}.json`)
    await atomicWrite(filePath, serialized)
    deliveredTo.push(recipient)
  }

  return { messageId: message.messageId, deliveredTo }
}

// ── listUnread ─────────────────────────────────────────

export async function listUnread(teamRunId: string, memberName: string): Promise<Message[]> {
  const inboxDir = getInboxDir(resolveBaseDir(), teamRunId, memberName)
  try {
    const entries = await readdir(inboxDir, { withFileTypes: true })
    const messages: Message[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      if (entry.name.startsWith('.')) continue // skip reservation / processed

      try {
        const content = await readFile(path.join(inboxDir, entry.name), 'utf-8')
        const parsed = MessageSchema.safeParse(JSON.parse(content))
        if (parsed.success) messages.push(parsed.data)
      } catch {
        /* malformed, skip */
      }
    }

    return messages.sort((a, b) => a.timestamp - b.timestamp)
  } catch {
    return []
  }
}

// ── ackMessages ────────────────────────────────────────

/** Lock is considered stale if its mtime is older than this threshold (ms). */
const LOCK_STALE_MS = 10_000

/** Per-process UUID used for lock ownership verification. */
let _processLockToken: string | undefined

function getProcessLockToken(): string {
  if (!_processLockToken) {
    _processLockToken = crypto.randomUUID()
  }
  return _processLockToken
}

/**
 * Acquire an exclusive lock on an inbox directory using atomic mkdir.
 * Writes an owner UUID token into the lock directory for stale detection.
 * Stale locks are detected via mtime + owner token double verification.
 * Retries up to ~5 seconds (50 × 100ms).
 */
async function acquireInboxLock(inboxDir: string): Promise<string> {
  const lockDir = path.join(inboxDir, '.ack-lock')
  const maxRetries = 50
  const myToken = getProcessLockToken()

  for (let i = 0; i < maxRetries; i++) {
    try {
      await mkdir(lockDir, { mode: 0o700 })
      await writeFile(path.join(lockDir, 'token'), myToken, 'utf-8')
      return lockDir
    } catch {
      // mkdir failed — check if we should clean a stale lock
      try {
        const lockStat = await stat(lockDir)
        const age = Date.now() - lockStat.mtimeMs

        if (age > LOCK_STALE_MS) {
          let ownerToken: string | undefined
          try {
            ownerToken = (await readFile(path.join(lockDir, 'token'), 'utf-8')).trim()
          } catch {
            // No token file — old-style lock without owner tracking
          }

          // Double verification: only remove if token does not match our own
          if (ownerToken !== myToken) {
            await rm(lockDir, { force: true, recursive: true })
            continue // retry immediately
          }
        }
      } catch {
        // stat/read/rm failed — lock may have vanished; fall through to retry
      }

      if (i >= maxRetries - 1) {
        throw new Error(`Failed to acquire inbox lock after ${maxRetries} retries`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('Unreachable')
}

export async function ackMessages(teamRunId: string, memberName: string, messageIds: string[]): Promise<void> {
  const baseDir = resolveBaseDir()
  const inboxDir = getInboxDir(baseDir, teamRunId, memberName)
  const processedDir = path.join(inboxDir, 'processed')
  await mkdir(processedDir, { recursive: true, mode: 0o700 })

  // Lock-free fast path: empty message list
  if (messageIds.length === 0) return

  // Lock: prevent concurrent ackMessages / listUnread races
  const lockDir = await acquireInboxLock(inboxDir)
  try {
    for (const msgId of messageIds) {
      const src = path.join(inboxDir, `${msgId}.json`)
      const dst = path.join(processedDir, `${msgId}.json`)
      try {
        await rename(src, dst)
      } catch {
        // Already moved by another concurrent call — idempotent
      }
    }
  } finally {
    await rm(lockDir, { force: true, recursive: true })
  }
}

// ── buildEnvelope — format message as XML for prompt injection ──

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
}

export function buildEnvelope(message: Message): string {
  const attrs: string[] = [
    `from="${esc(message.from)}"`,
    `timestamp="${message.timestamp}"`,
    `messageId="${esc(message.messageId)}"`,
    `kind="${esc(message.kind)}"`,
  ]
  if (message.summary) attrs.push(`summary="${esc(message.summary)}"`)
  if (message.correlationId) attrs.push(`correlationId="${esc(message.correlationId)}"`)
  return `<peer_message ${attrs.join(' ')}>\n${message.body}\n</peer_message>`
}

// ── pollAndInject — check inbox, claim messages for injection ──

export interface InjectionResult {
  injected: boolean
  content?: string
  messageIds: string[]
  reason?: string
}

/**
 * Poll the member's inbox for new messages and build prompt injection content.
 * Returns the set of message IDs to ack after the turn completes.
 */
export async function pollAndInject(
  teamRunId: string,
  memberName: string,
  turnMarker: string,
  lastInjectedTurnMarker?: string,
  pendingInjectedMessageIds?: string[],
): Promise<InjectionResult> {
  if (lastInjectedTurnMarker === turnMarker) {
    return { injected: false, messageIds: [], reason: 'already injected this turn' }
  }

  const unread = await listUnread(teamRunId, memberName)
  const pending = new Set(pendingInjectedMessageIds ?? [])

  const fresh = unread.filter((m) => !pending.has(m.messageId))
  if (fresh.length === 0) {
    return {
      injected: false,
      messageIds: [],
      reason: pending.size > 0 ? 'pending ack' : 'no unread',
    }
  }

  const messageIds = fresh.map((m) => m.messageId)
  const content = fresh.map((m) => buildEnvelope(m)).join('\n')

  return { injected: true, content, messageIds }
}
