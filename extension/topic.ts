/**
 * yu-agent — Topic management system.
 *
 * SQLite-backed topic registry with CLI commands.
 * Each topic represents a named context with its own working directory,
 * summary, status tracking, and turn counting.
 *
 * DB path: ~/.yu/topics.db
 */

import { Database as DatabaseSync } from 'bun:sqlite'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { ExtendedTopicStatus } from './types.js'
import { createLogger } from './logger.js'
import { eventBus } from './events.js'

const log = createLogger('topic')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Compiled file is at dist/extension/topic.js, so go up 2 dirs to reach project root
const PROJECT_ROOT = resolve(__dirname, '..', '..')

// ── Types ─────────────────────────────────────────────────

export interface Topic {
  id: string
  name: string
  dir: string
  summary: string
  status: ExtendedTopicStatus
  turns: number
  lastActive: string | null
  createdAt: string
  archived: number // 0 or 1
  pid?: number // child process PID (if running as background)
  cmd?: string // command string (the prompt)
  startedAt?: string // ISO timestamp of when the task started
}

// ── DB path ────────────────────────────────────────────────

const DB_PATH = resolve(process.env.HOME || '/home/saltfish', '.yu', 'topics.db')

let _db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (_db) return _db

  const dir = resolve(process.env.HOME || '/home/saltfish', '.yu')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  _db = new DatabaseSync(DB_PATH)
  _db.exec('PRAGMA journal_mode=WAL')
  _db.exec('PRAGMA busy_timeout=5000')
  initDb(_db)
  return _db
}

// ── Schema ─────────────────────────────────────────────────

export function initDb(db?: DatabaseSync): void {
  const d = db ?? getDb()
  d.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id          TEXT PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      dir         TEXT NOT NULL,
      summary     TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'idle',
      turns       INTEGER NOT NULL DEFAULT 0,
      last_active TEXT,
      created_at  TEXT NOT NULL,
      archived    INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Phase 0: Add supervisor-related columns if they don't exist yet.
  // Use ALTER TABLE ADD COLUMN which is safe — fails silently if column exists.
  const newColumns = [
    ['pid', 'INTEGER'],
    ['cmd', 'TEXT DEFAULT ""'],
    ['started_at', 'TEXT'],
  ] as const

  for (const [col, def] of newColumns) {
    try {
      d.exec(`ALTER TABLE topics ADD COLUMN ${col} ${def}`)
    } catch {
      // Column already exists — ignore
    }
  }

  // Phase 1: Create child_processes table for supervisor tracking
  // P2-10: Use ON CONFLICT REPLACE for idempotent inserts
  d.exec(`
    CREATE TABLE IF NOT EXISTS child_processes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_name      TEXT UNIQUE NOT NULL ON CONFLICT REPLACE,
      pid             INTEGER NOT NULL,
      parent_pid      INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'running',
      prompt          TEXT NOT NULL DEFAULT '',
      fork_time       TEXT NOT NULL,
      last_heartbeat  TEXT,
      restart_count   INTEGER DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
  `)

  // Phase 3: Events table for event bus / orchestration
  // P2-06: Added pid, parent_pid, seq, acknowledged columns
  // P2-23: Renamed 'topic' to 'topic_name' for plan consistency
  d.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_name    TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      payload       TEXT DEFAULT '{}',
      pid           INTEGER,
      parent_pid    INTEGER,
      seq           INTEGER,
      acknowledged  INTEGER DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // P2-07: Add performance indexes on events table
  d.exec(`CREATE INDEX IF NOT EXISTS idx_events_topic_created ON events(topic_name, created_at)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)`)

  // P3-05: Migration — drop spawning_timeout column if it still exists in an older schema.
  // SQLite does not support DROP COLUMN directly in older versions, but we can
  // simply leave it as a no-op if the column doesn't cause issues. No migration needed
  // since CREATE TABLE IF NOT EXISTS won't alter an existing table.

  // P2-23: Migration — rename 'topic' to 'topic_name' in events if old column exists.
  // Also add new columns that were added in P2-06 but don't exist in old tables.
  try {
    // Check if the old 'topic' column still exists and 'topic_name' doesn't
    const tableInfo = d.prepare("PRAGMA table_info('events')").all() as Array<{ name: string }>
    const hasTopic = tableInfo.some((c) => c.name === 'topic')
    const hasTopicName = tableInfo.some((c) => c.name === 'topic_name')
    if (hasTopic && !hasTopicName) {
      // SQLite >= 3.25.0 supports RENAME COLUMN
      d.exec('ALTER TABLE events RENAME COLUMN topic TO topic_name')
    }

    // P2-06: Add missing columns if not present (for tables created before P2-06)
    const addColIfMissing = (colDef: string) => {
      const colName = colDef.split(' ')[0]
      if (!tableInfo.some((c) => c.name === colName)) {
        d.exec(`ALTER TABLE events ADD COLUMN ${colDef}`)
      }
    }
    addColIfMissing('pid INTEGER')
    addColIfMissing('parent_pid INTEGER')
    addColIfMissing('seq INTEGER')
    addColIfMissing('acknowledged INTEGER DEFAULT 0')
  } catch {
    // Column migration failed — columns may already be gone
  }
}

// ── Internal helpers ──────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function findByName(name: string): Topic | undefined {
  const db = getDb()
  const row = db.prepare('SELECT * FROM topics WHERE LOWER(name) = LOWER(?)').get(name) as
    | Record<string, unknown>
    | undefined

  if (!row) return undefined
  return rowToTopic(row)
}

function rowToTopic(row: Record<string, unknown>): Topic {
  return {
    id: row.id as string,
    name: row.name as string,
    dir: row.dir as string,
    summary: (row.summary as string) ?? '',
    status: (row.status as ExtendedTopicStatus) ?? 'idle',
    turns: (row.turns as number) ?? 0,
    lastActive: (row.last_active as string) ?? null,
    createdAt: row.created_at as string,
    archived: (row.archived as number) ?? 0,
    pid: (row.pid as number) ?? undefined,
    cmd: (row.cmd as string) ?? undefined,
    startedAt: (row.started_at as string) ?? undefined,
  }
}

// ── Public API ─────────────────────────────────────────────

/**
 * List all topics, optionally including archived ones.
 */
export function list(archived?: boolean): Topic[] {
  const db = getDb()
  let rows: Record<string, unknown>[]

  if (archived) {
    rows = db.prepare('SELECT * FROM topics ORDER BY created_at DESC').all() as Record<string, unknown>[]
  } else {
    rows = db.prepare('SELECT * FROM topics WHERE archived = 0 ORDER BY created_at DESC').all() as Record<
      string,
      unknown
    >[]
  }

  return rows.map(rowToTopic)
}

/**
 * Get a single topic by name (case-insensitive).
 */
export function get(name: string): Topic | undefined {
  return findByName(name)
}

/**
 * Get the currently active topic (status = 'active').
 * Returns undefined if no topic is active.
 */
export function getActive(): Topic | undefined {
  const db = getDb()
  const row = db.prepare('SELECT * FROM topics WHERE status = ? AND archived = 0 LIMIT 1').get('active') as
    | Record<string, unknown>
    | undefined
  return row ? rowToTopic(row) : undefined
}

/**
 * Create a new topic.
 * Throws if a topic with the same name (case-insensitive) already exists.
 */
export function create(name: string, dir: string): Topic {
  const db = getDb()
  const existing = findByName(name)
  if (existing) {
    throw new Error(`Topic "${name}" already exists.`)
  }

  const id = generateId()
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO topics (id, name, dir, summary, status, turns, last_active, created_at, archived)
    VALUES (?, ?, ?, '', 'idle', 0, NULL, ?, 0)
  `).run(id, name, dir, now)

  // Emit topic.created
  try {
    eventBus.emit('topic.created', { name, dir })
  } catch { /* non-critical */ }

  return {
    id,
    name,
    dir,
    summary: '',
    status: 'idle',
    turns: 0,
    lastActive: null,
    createdAt: now,
    archived: 0,
  }
}

/**
 * Switch to a topic: set its status to 'active' and update cwd.
 */
export function switchTopic(name: string): void {
  const db = getDb()
  const topic = findByName(name)
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`)
  }

  const now = new Date().toISOString()
  db.prepare(`
    UPDATE topics SET status = 'active', last_active = ? WHERE id = ?
  `).run(now, topic.id)

  // Update cwd for the main session
  // Guard: only chdir if the topic's directory still exists
  if (topic.dir && existsSync(topic.dir)) {
    process.chdir(topic.dir)
  }

  // Emit topic.switched
  try {
    eventBus.emit('topic.switched', { name, from: topic.status })
  } catch { /* non-critical */ }
}

/**
 * Rename a topic (case-insensitive lookup, name must be unique).
 */
export function rename(oldName: string, newName: string): void {
  const db = getDb()
  const topic = findByName(oldName)
  if (!topic) {
    throw new Error(`Topic "${oldName}" not found.`)
  }

  const existing = findByName(newName)
  if (existing && existing.id !== topic.id) {
    throw new Error(`Topic "${newName}" already exists.`)
  }

  db.prepare('UPDATE topics SET name = ? WHERE id = ?').run(newName, topic.id)
}

/**
 * Archive a topic (soft-delete).
 */
export function archive(name: string): void {
  const db = getDb()
  const topic = findByName(name)
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`)
  }

  db.prepare('UPDATE topics SET archived = 1 WHERE id = ?').run(topic.id)

  // Emit topic.archived
  try {
    eventBus.emit('topic.archived', { name })
  } catch { /* non-critical */ }
}

/**
 * Set a topic's summary text.
 */
export function setSummary(name: string, summary: string): void {
  const db = getDb()
  const topic = findByName(name)
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`)
  }

  db.prepare('UPDATE topics SET summary = ? WHERE id = ?').run(summary, topic.id)
}

/**
 * Set a topic's status.
 * P2-09: Extended validation to match all ChildStatus values.
 * P2-11: Event writing moved to supervisor.ts's spawnChild/killChild.
 *        Only topic-level events are written here.
 */
export function setStatus(name: string, status: string): void {
  const db = getDb()
  const topic = findByName(name)
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`)
  }

  // P2-09: Full set of valid statuses matching ChildStatus + ExtendedTopicStatus
  const validStatuses = [
    'idle',
    'active',
    'background',
    'spawning',
    'spawn_failed',
    'running',
    'degraded',
    'disconnected',
    'dead',
    'restarting',
    'stopped',
  ]
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}.`)
  }

  const oldStatus = topic.status

  db.prepare('UPDATE topics SET status = ?, last_active = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    topic.id,
  )

  // ── Write events for relevant status transitions (Phase 3) ──
  // P2-11: child_spawned event is now written by supervisor.ts spawnChild.
  // We only write topic-level events here (child_task_done, child_crashed, etc.)
  // for transitions that originate from the DB/topic side.
  if (oldStatus !== status) {
    const payload: Record<string, unknown> = { from: oldStatus, to: status }
    if (status === 'spawn_failed') {
      // P2-27: Write child_spawn_failed event for spawning→spawn_failed path
      writeEvent(name, 'child_spawn_failed', { ...payload, reason: 'spawn_timeout' })
    } else if (status === 'idle' && (oldStatus === 'background' || oldStatus === 'spawning')) {
      writeEvent(name, 'child_task_done', payload)
      // P2-28: Also emit task.completed event for the cross-topic event channel
      writeEvent(name, 'task.completed', { status: 'completed', from_status: oldStatus, summary: topic.summary || '' })
    } else if (status === 'degraded' || status === 'restarting' || status === 'stopped') {
      // P2-08: Write events for new supervisor states
      const eventType =
        status === 'degraded'
          ? 'child_degraded'
          : status === 'restarting'
            ? 'child_restarting'
            : status === 'stopped'
              ? 'child_stopped'
              : 'child_status_change'
      writeEvent(name, eventType, payload)
    }
  }
}

/**
 * Increment the turn counter for a topic.
 */
export function incrementTurns(name: string): void {
  const db = getDb()
  const topic = findByName(name)
  if (!topic) {
    throw new Error(`Topic "${name}" not found.`)
  }

  db.prepare('UPDATE topics SET turns = turns + 1 WHERE id = ?').run(topic.id)
}

/**
 * Read topic.maxBackground from ~/.yu/config.json.
 * Default: 3.
 */
export function getMaxBackground(): number {
  try {
    const configPath = resolve(process.env.HOME || '/home/saltfish', '.yu', 'config.json')
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      const max = config?.topic?.maxBackground
      if (typeof max === 'number' && max > 0) {
        return max
      }
    }
  } catch {
    // ignore — fall through to default
  }
  return 3
}

/**
 * Write an event to the events table for the event bus / orchestrator.
 * Events log status changes (child_spawned, child_task_done, child_crashed, child_degraded)
 * and are consumed by checkAndTriggerOrchestrator().
 *
 * P2-23: Uses 'topic_name' column instead of 'topic' for plan consistency.
 */
export function writeEvent(topicName: string, eventType: string, payload: Record<string, unknown> = {}): void {
  const db = getDb()
  // Extract pid / parent_pid / seq from payload if present (P2-06)
  const pid = (payload.pid as number) ?? null
  const parentPid = (payload.parent_pid as number) ?? null
  const seq = (payload.seq as number) ?? null
  db.prepare(
    `INSERT INTO events (topic_name, event_type, payload, pid, parent_pid, seq)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(topicName, eventType, JSON.stringify(payload), pid, parentPid, seq)
}

/**
 * Retrieve all unacknowledged events for a given topic (or '' for broadcast).
 * Returns events ordered by creation time (oldest first).
 */
export function pendingEvents(topicName: string): Array<{
  id: number
  topic_name: string
  event_type: string
  payload: Record<string, unknown>
  created_at: string
}> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, topic_name, event_type, payload, created_at
     FROM events
     WHERE acknowledged = 0
       AND (topic_name = ? OR topic_name = '')
     ORDER BY created_at ASC`,
    )
    .all(topicName) as Array<Record<string, unknown>>

  return rows.map((r) => ({
    id: r.id as number,
    topic_name: r.topic_name as string,
    event_type: r.event_type as string,
    payload: JSON.parse((r.payload as string) || '{}'),
    created_at: r.created_at as string,
  }))
}

/**
 * Mark an event as acknowledged so it won't appear in pendingEvents().
 */
export function acknowledgeEvent(eventId: number): void {
  const db = getDb()
  db.prepare('UPDATE events SET acknowledged = 1 WHERE id = ?').run(eventId)
}

/**
 * Delete events older than maxAgeDays.
 * Returns the number of deleted rows.
 * Exported for cron jobs and `yu doctor`.
 */
export function cleanOldEvents(maxAgeDays: number = 7): number {
  const db = getDb()
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000)
  // Format as 'YYYY-MM-DD HH:MM:SS' to match SQLite datetime('now') output
  const cutoff = cutoffDate
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '')
  const result = db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff)
  return Number(result.changes)
}

/**
 * Test helper — override the internal DB singleton with an in-memory DB.
 * Pass null to reset to the real file-based DB.
 */
export function __setDbForTest(db: DatabaseSync | null): void {
  _db = db
}

/**
 * Count currently running background topics.
 */
export function backgroundCount(): number {
  const db = getDb()
  const row = db.prepare("SELECT COUNT(*) AS count FROM topics WHERE archived = 0 AND status = 'background'").get() as {
    count: number
  }

  return row?.count ?? 0
}

/** Path to the supervisor daemon script (compiled JS). */
const DAEMON_SCRIPT = resolve(PROJECT_ROOT, 'dist/extension/supervisor-daemon.js')

/** PID file for the supervisor daemon. */
const DAEMON_PID_PATH = resolve(process.env.HOME || '/home/saltfish', '.yu', 'supervisor.pid')

/** Lock file for mutual exclusion around daemon spawn. */
const DAEMON_LOCK_PATH = resolve(process.env.HOME || '/home/saltfish', '.yu', 'supervisor.lock')

/** Logs directory. */
const DAEMON_LOGS_DIR = resolve(process.env.HOME || '/home/saltfish', '.yu', 'logs')

/**
 * Ensure the supervisor daemon is running.
 * If the PID file exists and points to a live process, do nothing.
 * Otherwise, spawn a new daemon process (detached) and write its PID.
 *
 * Uses an OS file lock (flock via openSync) around the PID-check→spawn
 * critical section to prevent two concurrent CLI processes from spawning
 * two daemons (P0-03).
 *
 * Called by cmdBg() before returning, so the daemon can pick
 * up the newly created background task.
 */
export function ensureDaemonRunning(): void {
  // Acquire lock to prevent concurrent daemon spawning (P0-03)
  // Use openSync with 'wx' (write exclusive) — atomic on POSIX.
  // Only one process can create/open the file exclusively at a time.
  let lockFd: number | null = null
  try {
    lockFd = openSync(DAEMON_LOCK_PATH, 'wx')
  } catch {
    // Lock already held by another process — skip spawning
    return
  }

  try {
    // Check if daemon is already running
    if (existsSync(DAEMON_PID_PATH)) {
      try {
        const pidContent = readFileSync(DAEMON_PID_PATH, 'utf-8').trim()
        const lines = pidContent.split('\n')
        const pidStr = lines[0]
        const pid = parseInt(pidStr, 10)
        if (!Number.isNaN(pid) && pid > 0) {
          try {
            // Signal 0 tests whether the process exists without actually sending a signal
            process.kill(pid, 0)

            // P1-09: Verify process identity (startup timestamp + script path)
            if (lines.length >= 2) {
              const storedIdentity = lines.slice(1).join('\n')
              const _expectedIdentity = `${process.argv[1]}:${Date.now()}`
              // If we have identity data but it doesn't match, treat as stale
              if (!storedIdentity.startsWith(process.argv[1]) && storedIdentity.includes(':')) {
                // Stale PID file from a different script — fall through to spawn
              } else {
                return // Daemon is alive and identity matches
              }
            } else {
              return // Daemon is alive (no identity data to verify)
            }
          } catch {
            // Stale PID file — process is dead, proceed to spawn
          }
        }
      } catch {
        // Corrupted PID file — proceed to spawn
      }
    }

    // Ensure logs directory exists
    if (!existsSync(DAEMON_LOGS_DIR)) {
      mkdirSync(DAEMON_LOGS_DIR, { recursive: true })
    }

    // Check that the compiled daemon script exists
    if (!existsSync(DAEMON_SCRIPT)) {
      // In dev mode, try the source file via tsx
      log.warn(`Daemon script not found at ${DAEMON_SCRIPT}. Build the project first (npx tsc).`)
      return
    }

    try {
      const child = Bun.spawn([process.execPath, DAEMON_SCRIPT], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })

      // P1-11: Forward daemon stdout/stderr to log file so they aren't lost
      ;(async () => {
        const decoder = new TextDecoder()
        try {
          const reader = child.stdout.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            appendFileSync(resolve(DAEMON_LOGS_DIR, 'supervisor.log'), decoder.decode(value))
          }
        } catch {
          /* best-effort */
        }
      })()
      ;(async () => {
        const decoder = new TextDecoder()
        try {
          const reader = child.stderr.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            appendFileSync(resolve(DAEMON_LOGS_DIR, 'supervisor.log'), decoder.decode(value))
          }
        } catch {
          /* best-effort */
        }
      })()

      if (child.pid) {
        // P1-09: Write PID + startup timestamp + script path for identity verification
        const identityLine = `${process.argv[1]}:${Date.now()}`
        writeFileSync(DAEMON_PID_PATH, `${child.pid}\n${identityLine}\n`)
      } else {
        log.warn('Daemon spawned but PID is null')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(`Failed to spawn daemon: ${msg}`)
    }
  } finally {
    // Release the file lock
    if (lockFd !== null) {
      try {
        closeSync(lockFd)
        // Remove the lock file so future spawns can acquire it
        if (existsSync(DAEMON_LOCK_PATH)) {
          unlinkSync(DAEMON_LOCK_PATH)
        }
      } catch {
        // Best-effort
      }
    }
  }
}

// ── CLI command handler ───────────────────────────────────

const HELP_TEXT = `yu topic — Topic management

Usage:
  yu topic list                    List all topics
  yu topic switch <name>           Switch to a topic (updates cwd)
  yu topic new <name> <dir>        Create a new topic
  yu topic rename <old> <new>      Rename a topic
  yu topic archive <name>          Archive a topic (soft-delete)
  yu topic bg <name> <prompt...>   Run a background task on a topic
  yu topic status                  Show background task progress
  yu topic events [topic-name]     Show pending events for a topic (default: all topics grouped)

Data stored in ~/.yu/topics.db (SQLite).`

export function topicCommand(subcommand: string, args: string[]): string {
  switch (subcommand) {
    case 'list':
      return cmdList(args)
    case 'switch':
      return cmdSwitch(args)
    case 'new':
      return cmdNew(args)
    case 'rename':
      return cmdRename(args)
    case 'archive':
      return cmdArchive(args)
    case 'bg':
      return cmdBg(args)
    case 'status':
      return cmdStatus()
    case 'events':
      return cmdEvents(args)
    default:
      return HELP_TEXT
  }
}

function cmdList(args: string[]): string {
  const showArchived = args.includes('--all') || args.includes('-a')
  const topics = list(showArchived)

  if (topics.length === 0) {
    return 'No topics found. Use `yu topic new <name> <dir>` to create one.'
  }

  const lines: string[] = []
  lines.push('Topics:')
  lines.push('')

  for (const t of topics) {
    const archiveMark = t.archived ? ' (archived)' : ''
    const statusIcon = t.status === 'active' ? '▶' : t.status === 'background' ? '⏳' : '○'
    const lastActive = t.lastActive ? `last: ${new Date(t.lastActive).toLocaleDateString()}` : 'never'
    lines.push(`  ${statusIcon} ${t.name}${archiveMark}` + `  [${t.status}]  ${t.turns} turns  ${lastActive}`)
    if (t.summary) {
      lines.push(`     ${t.summary}`)
    }
  }

  lines.push('')
  lines.push(`Total: ${topics.length} topic(s)`)
  return lines.join('\n')
}

function cmdSwitch(args: string[]): string {
  if (args.length === 0) {
    return 'Usage: yu topic switch <name>'
  }

  const name = args[0]
  try {
    switchTopic(name)

    // Auto-cleanup old events on topic switch (only if > 1000 events exist)
    try {
      const db = getDb()
      const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM events').get() as { cnt: number }
      if (Number(countRow?.cnt ?? 0) > 1000) {
        const removed = cleanOldEvents(7)
        if (removed > 0) {
          log.info(`Cleaned up ${removed} old event(s).`)
        }
      }
    } catch {
      // best-effort cleanup
    }

    // P2-28: Check for pending events on the target topic and inject as context
    const events = pendingEvents(name)
    if (events.length > 0) {
      const summaries = events
        .map((e) => `[${e.created_at}] ${e.event_type}: ${JSON.stringify(e.payload)}`)
        .join('\n      ')
      log.info(`Pending events for "${name}":\n      ${summaries}`)

      // Auto-acknowledge events after delivery
      for (const ev of events) {
        acknowledgeEvent(ev.id)
      }
    }

    return `Switched to topic "${name}". CWD is now ${process.cwd()}.`
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return `Error: ${msg}`
  }
}

function cmdNew(args: string[]): string {
  if (args.length < 2) {
    return 'Usage: yu topic new <name> <dir>'
  }

  const name = args[0]
  const dir = resolve(process.cwd(), args[1])

  if (!existsSync(dir)) {
    return `Error: Directory does not exist: ${dir}`
  }

  try {
    // Check background limit if topic would be background
    // (default status is 'idle', so this check only applies if bg is explicitly set)
    create(name, dir)
    return `Created topic "${name}" at ${dir}.`
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return `Error: ${msg}`
  }
}

function cmdRename(args: string[]): string {
  if (args.length < 2) {
    return 'Usage: yu topic rename <old-name> <new-name>'
  }

  const oldName = args[0]
  const newName = args[1]

  try {
    rename(oldName, newName)
    return `Renamed topic "${oldName}" to "${newName}".`
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return `Error: ${msg}`
  }
}

function cmdArchive(args: string[]): string {
  if (args.length === 0) {
    return 'Usage: yu topic archive <name>'
  }

  const name = args[0]
  try {
    archive(name)
    return `Archived topic "${name}".`
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return `Error: ${msg}`
  }
}

/** Path to the supervisor daemon script (compiled JS) — same as above. */
function daemonScriptExists(): boolean {
  return existsSync(DAEMON_SCRIPT)
}

function cmdBg(args: string[]): string {
  if (args.length < 2) {
    return 'Usage: yu topic bg <name> <prompt...>'
  }

  const name = args[0]
  const prompt = args.slice(1).join(' ')

  const topic = get(name)
  if (!topic) {
    return `Error: Topic "${name}" not found.`
  }

  // P2-24: Ensure daemon script exists BEFORE setting topic to background.
  // This avoids the scenario where we commit a topic to 'background' status
  // but have no way to actually execute the task.
  if (!daemonScriptExists()) {
    return `Error: Supervisor daemon script not found at ${DAEMON_SCRIPT}. Build the project first (npx tsc).`
  }

  // Check background limit first
  const maxBg = getMaxBackground()
  const currentBg = backgroundCount()
  if (currentBg >= maxBg) {
    const topics = list(false)
    const bgTopics = topics.filter((t) => t.status === 'background' || t.status === 'spawning')
    const bgList = bgTopics.map((t) => `  • ${t.name} (${t.summary || 'no summary'})`).join('\n')
    return `Error: Maximum background topics reached (${maxBg}).\nCurrently running:\n${bgList}`
  }

  try {
    const db = getDb()
    const now = new Date().toISOString()

    // Atomic transaction: update to 'background' in one step and sync in-memory status
    // Previously this was a two-step UPDATE→setStatus that could crash between,
    // leaving the topic stuck at 'spawning' (P1-12).
    db.exec('BEGIN IMMEDIATE')
    try {
      const updateResult = db
        .prepare(`
        UPDATE topics
        SET status = 'background',
            summary = ?,
            turns = turns + 1,
            last_active = ?,
            cmd = ?,
            started_at = ?
        WHERE name = ? AND status = 'idle'
      `)
        .run(`Running: ${prompt}`, now, prompt, now, name)

      if (updateResult.changes === 0) {
        db.exec('ROLLBACK')
        const currentStatus = get(name)?.status ?? 'unknown'
        return `Error: Topic "${name}" is not idle (current status: ${currentStatus}).`
      }

      // Also write the event inside the transaction for consistency
      writeEvent(name, 'child_spawned', { from: topic.status, to: 'background', prompt })
      db.exec('COMMIT')
    } catch (txErr: unknown) {
      db.exec('ROLLBACK')
      const msg = txErr instanceof Error ? txErr.message : String(txErr)
      return `Error: Failed to set topic status: ${msg}`
    }

    // Ensure the supervisor daemon is running
    ensureDaemonRunning()

    return `Background task started on topic "${name}".\nPrompt: ${prompt}`
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return `Error: ${msg}`
  }
}

function cmdStatus(): string {
  const topics = list(false)
  const bgTopics = topics.filter((t) => t.status === 'background')

  if (bgTopics.length === 0) {
    return 'No background tasks running.'
  }

  const maxBg = getMaxBackground()
  const lines: string[] = [`Background tasks (${bgTopics.length}/${maxBg}):`, '']

  for (const t of bgTopics) {
    const lastActive = t.lastActive ? `last active: ${new Date(t.lastActive).toLocaleString()}` : 'never active'
    lines.push(`  ⏳ ${t.name}`)
    lines.push(`     summary: ${t.summary || '(no summary)'}`)
    lines.push(`     turns: ${t.turns}  ${lastActive}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Retrieve all unacknowledged events across all topics.
 */
function pendingEventsAll(): Array<{
  id: number
  topic_name: string
  event_type: string
  payload: Record<string, unknown>
  created_at: string
}> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, topic_name, event_type, payload, created_at
     FROM events
     WHERE acknowledged = 0
     ORDER BY topic_name, created_at ASC`,
    )
    .all() as Array<Record<string, unknown>>

  return rows.map((r) => ({
    id: r.id as number,
    topic_name: r.topic_name as string,
    event_type: r.event_type as string,
    payload: JSON.parse((r.payload as string) || '{}'),
    created_at: r.created_at as string,
  }))
}

function cmdEvents(args: string[]): string {
  const topicName = args[0]

  if (topicName) {
    // Show events for a specific topic
    const topic = findByName(topicName)
    if (!topic) {
      return `Error: Topic "${topicName}" not found.`
    }

    const events = pendingEvents(topicName)
    const recentEvents = events.slice(-20)

    if (recentEvents.length === 0) {
      return `No pending events for topic "${topicName}".`
    }

    const lines: string[] = []
    lines.push(`Events for topic "${topicName}" (${recentEvents.length} pending):`)
    lines.push('')
    for (const ev of recentEvents) {
      const payloadStr = JSON.stringify(ev.payload)
      const truncated = payloadStr.length > 60 ? `${payloadStr.slice(0, 60)}…` : payloadStr
      const fromTo =
        ev.payload?.from && ev.payload?.to ? `${ev.payload.from as string} → ${ev.payload.to as string}` : ''
      lines.push(`  #${ev.id}  ${ev.event_type}${fromTo ? `  ${fromTo}` : ''}` + `  ${ev.created_at}`)
      if (truncated !== '{}') {
        lines.push(`         ${truncated}`)
      }
    }
    return lines.join('\n')
  }

  // No topic specified — show events for all topics grouped
  const allEvents = pendingEventsAll()
  if (allEvents.length === 0) {
    return 'No pending events found.'
  }

  // Group by topic_name
  const grouped = new Map<string, typeof allEvents>()
  for (const ev of allEvents) {
    const list = grouped.get(ev.topic_name) || []
    list.push(ev)
    grouped.set(ev.topic_name, list)
  }

  const lines: string[] = []
  lines.push(`Pending events (${allEvents.length} total):`)
  lines.push('')

  for (const [topicName, topicEvents] of grouped) {
    lines.push(`  ── ${topicName} ──`)
    const recent = topicEvents.slice(-20)
    for (const ev of recent) {
      const payloadStr = JSON.stringify(ev.payload)
      const truncated = payloadStr.length > 60 ? `${payloadStr.slice(0, 60)}…` : payloadStr
      const fromTo =
        ev.payload?.from && ev.payload?.to ? `${ev.payload.from as string} → ${ev.payload.to as string}` : ''
      lines.push(`    #${ev.id}  ${ev.event_type}${fromTo ? `  ${fromTo}` : ''}  ${ev.created_at}`)
      if (truncated !== '{}') {
        lines.push(`           ${truncated}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}
