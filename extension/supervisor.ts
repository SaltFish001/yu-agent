/**
 * yu-agent — Supervisor: child process lifecycle management.
 *
 * Manages forked child agent processes, health checks,
 * graceful shutdown, and status reporting.
 *
 * Phase 0: Basic structure with forking, heartbeat, and kill.
 * Phase 1+: IPC protocol, restart policy, event bus integration.
 */

import { Database as DatabaseSync } from 'bun:sqlite'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { sendToChild, waitForMessage } from './ipc-main.js'
import { createLogger } from './logger.js'
import { checkAndTriggerOrchestrator } from './orchestrator.js'
import { writeEvent } from './topic.js'
import type { ChildProcessInfo, ChildSpawnConfig, SupervisorStatus } from './types.js'

const log = createLogger('supervisor')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Compiled file is at dist/extension/supervisor.js, so go up 2 dirs to reach project root
const PROJECT_ROOT = resolve(__dirname, '..', '..')

/** Path to the forked child process entry point. */
const CHILD_ENTRY = resolve(PROJECT_ROOT, 'dist/extension/bg-worker.js')

/** Default spawning timeout (ms). */
const DEFAULT_SPAWN_TIMEOUT = 15_000

/** Time to wait after SIGTERM before sending SIGKILL (ms). */
const SIGKILL_DELAY = 10_000

/** Max consecutive restarts before giving up (default, can be overridden per-child). */
const DEFAULT_MAX_RESTARTS = 3

/** Exponential backoff durations (ms) for restart 0, 1, 2. */
const BACKOFF_DURATIONS = [1_000, 2_000, 4_000]

/** Milliseconds without heartbeat before marking degraded. */
const DEGRADED_THRESHOLD = 15_000

/** Milliseconds without heartbeat before marking dead. */
const DEAD_THRESHOLD = 30_000

/**
 * Read daemon version from package.json.
 * Cached after first read.
 */
let _daemonVersion: string | null = null
function getDaemonVersion(): string {
  if (_daemonVersion) return _daemonVersion
  try {
    const pkgPath = resolve(PROJECT_ROOT, 'package.json')
    _daemonVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version || '0.1.0'
  } catch {
    _daemonVersion = '0.1.0'
  }
  return _daemonVersion!
}

export class Supervisor {
  /** TopicName → ChildProcessInfo (metadata / status). */
  readonly children = new Map<string, ChildProcessInfo>()
  /** TopicName → Subprocess (OS handle). */
  private processes = new Map<string, any>()
  private startTime = Date.now()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** Track last heartbeat timestamp per child. */
  private lastHeartbeat = new Map<string, number>()
  /** Track restart attempts per child. */
  private restartCount = new Map<string, number>()
  /** Topic names currently being restarted (prevent re-entrant restarts). */
  private restarting = new Set<string>()
  /** True when supervisor is performing graceful shutdown. */
  private shuttingDown = false
  /** Topic names for which kill was explicitly requested (P1-03). */
  private killRequested = new Set<string>()
  /** Timer handles for spawning timeouts, keyed by topic name (P1-01). */
  private spawningTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Start the supervisor heartbeat loop.
   * Every 5 seconds, checks children liveness and updates statuses.
   */
  start(): void {
    log.info('Supervisor starting')
    this.startTime = Date.now()

    this.heartbeatTimer = setInterval(() => {
      this.checkChildren()
    }, 5_000)
  }

  /**
   * Spawn a child process for the given topic (Bun stdio IPC).
   * The child process runs bg-worker.ts (via bun) to execute scheduler logic.
   * After spawning, sends a 'ping' and waits for 'pong' to confirm the child is alive.
   * Communication is via JSON-line protocol over stdin/stdout.
   */
  spawnChild(topicName: string, config?: Partial<ChildSpawnConfig>): any | undefined {
    const cfg: ChildSpawnConfig = {
      timeout: config?.timeout ?? DEFAULT_SPAWN_TIMEOUT,
      env: config?.env ?? {},
      spawning_timeout: config?.spawning_timeout ?? 30_000,
      resident: config?.resident ?? true,
      autoRetry: config?.autoRetry ?? true,
      maxRetries: config?.maxRetries ?? DEFAULT_MAX_RESTARTS,
    }

    if (!existsSync(CHILD_ENTRY)) {
      log.error(`Child entry not found: ${CHILD_ENTRY}. Build the project first (npx tsc).`)
      return undefined
    }

    const child = Bun.spawn({
      cmd: ['bun', CHILD_ENTRY, `--topic-name=${topicName}`],
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '',
        DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? '',
        ...Object.fromEntries(
          Object.entries(cfg.env).filter(([key]) => {
            const sensitivePatterns = [
              'DEEPSEEK_API_KEY',
              'OPENAI_API_KEY',
              'ANTHROPIC_API_KEY',
              'API_KEY',
              'SECRET',
              'TOKEN',
            ]
            const isSensitive = sensitivePatterns.some((p) => key.toUpperCase().includes(p))
            if (isSensitive) {
              log.warn(`Filtering sensitive env key "${key}" from cfg.env override`)
            }
            return !isSensitive
          }),
        ),
        YU_CHILD_MODE: '1',
        YU_SESSION_TAG: `bg:${topicName}`,
      },
    })

    const info: ChildProcessInfo = {
      pid: child.pid ?? 0,
      topicName,
      status: 'spawning',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: cfg.resident,
    }

    this.children.set(topicName, info)
    this.processes.set(topicName, child)

    log.info(`Child spawned for topic "${topicName}" (PID ${child.pid})`)

    // ── Phase 3: Write spawn event and check orchestrator (P2-11) ──
    this.safeWriteEvent(topicName, 'child_spawned', { pid: child.pid, status: 'spawning' })
    this.safeTriggerOrchestrator(topicName, 'child_spawned', { pid: child.pid, status: 'spawning' })

    // ── IPC message handler via stdout JSON-line reader ──
    const stdoutReader = child.stdout?.getReader()
    if (stdoutReader) {
      const decoder = new TextDecoder()
      let buf = ''
      ;(async () => {
        try {
          while (true) {
            const { done, value } = await stdoutReader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.trim()) continue
              try {
                const msg = JSON.parse(line) as { type?: string; payload?: unknown }
                if (!msg?.type) continue
                const existing = this.children.get(topicName)
                if (!existing) continue
                switch (msg.type) {
                  case 'pong': {
                    if (existing.status === 'spawning') {
                      existing.status = 'running'
                      this.lastHeartbeat.set(topicName, Date.now())
                      log.info(`Child "${topicName}" is alive (pong received)`)
                    }
                    const timer = this.spawningTimers.get(topicName)
                    if (timer) { clearTimeout(timer); this.spawningTimers.delete(topicName) }
                    this.restartCount.set(topicName, 0)
                    existing.restartCount = 0
                    break
                  }
                  case 'heartbeat':
                    this.lastHeartbeat.set(topicName, Date.now())
                    existing.lastHeartbeat = Date.now()
                    if (existing.status === 'spawning' || existing.status === 'degraded') existing.status = 'running'
                    break
                  case 'task_result':
                    if (!existing.resident) existing.status = 'stopped'
                    log.info(`Child "${topicName}" completed task`)
                    break
                  case 'error':
                    existing.status = 'degraded'
                    log.error(`Child "${topicName}" reported error:`, msg.payload as Record<string, unknown> | undefined)
                    this.safeWriteEvent(topicName, 'child_degraded', { reason: 'child_error', error: msg.payload, pid: existing.pid })
                    this.safeTriggerOrchestrator(topicName, 'child_degraded', { reason: 'child_error', error: msg.payload, pid: existing.pid })
                    break
                  case 'status_update':
                    log.debug(`Child "${topicName}" status:`, msg.payload as Record<string, unknown> | undefined)
                    break
                }
              } catch { /* malformed json line, skip */ }
            }
          }
        } catch { /* stream error */ }
        log.warn(`Child "${topicName}" stdout closed`)
      })()
    }

    // ── Exit handler with auto-restart + event bus (Phase 3) ──
    child.exited.then((exitCode: number) => {
      const existing = this.children.get(topicName)
      if (existing) {
        if (exitCode !== 0) {
          existing.status = 'dead'
          log.warn(`Child "${topicName}" exited with code ${exitCode}`)
          this.safeWriteEvent(topicName, 'child_crashed', { exitCode, pid: existing.pid })
          this.safeTriggerOrchestrator(topicName, 'child_crashed', { exitCode, pid: existing.pid, reason: 'non_zero_exit' })
        } else {
          if (this.killRequested.has(topicName)) {
            log.info(`Child "${topicName}" exited (code=0) after kill was requested, marking 'stopped'`)
            this.killRequested.delete(topicName)
          }
          existing.status = 'stopped'
          log.info(`Child "${topicName}" exited cleanly (code=0)`)
          this.safeWriteEvent(topicName, 'child_task_done', { exitCode, pid: existing.pid })
          this.safeTriggerOrchestrator(topicName, 'child_task_done', { exitCode, pid: existing.pid, status: 'completed' })
        }
      }
      this.processes.delete(topicName)
      if (existing && !this.shuttingDown && !this.killRequested.has(topicName) && existing.status !== 'stopped') {
        this.scheduleRestart(topicName)
      }
    })

    // ── Ping child to confirm it's alive ──
    // Give the child a short moment to boot up before sending ping
    setTimeout(async () => {
      try {
        sendToChild(child, 'ping')
        await waitForMessage(child, 'pong', cfg.spawning_timeout ?? 30_000)
        const existing = this.children.get(topicName)
        if (existing && existing.status === 'spawning') {
          existing.status = 'running'
          log.info(`Child "${topicName}" confirmed alive via ping/pong`)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`Child "${topicName}" ping/pong failed: ${msg}`)
        const existing = this.children.get(topicName)
        if (existing && existing.status === 'spawning') {
          existing.status = 'spawn_failed'
          // P2-27: Write spawn_failed event for the spawning→spawn_failed path
          this.safeWriteEvent(topicName, 'child_spawn_failed', {
            reason: 'ping_timeout',
            error: msg,
            pid: existing.pid,
          })
          this.killChild(topicName)
        }
      }
    })

    // ── Spawning timeout: if child never responds to ping, kill ──
    const spawnTimer = setTimeout(() => {
      const current = this.children.get(topicName)
      if (current && current.status === 'spawning') {
        log.warn(`Child "${topicName}" spawning timed out after ${cfg.timeout}ms, killing`)
        current.status = 'spawn_failed'
        // P2-27: Write spawn_failed event for the spawning timeout path
        this.safeWriteEvent(topicName, 'child_spawn_failed', {
          reason: 'spawn_timeout',
          timeout: cfg.timeout,
          pid: current.pid,
        })
        this.killChild(topicName)
      }
      this.spawningTimers.delete(topicName)
    }, cfg.timeout)
    this.spawningTimers.set(topicName, spawnTimer)

    return child
  }

  /**
   * Gracefully kill a child process.
   * Sends SIGTERM first, then SIGKILL after 5 seconds if still alive.
   */
  killChild(topicName: string): void {
    const child = this.processes.get(topicName)
    if (!child) return

    const info = this.children.get(topicName)
    if (info && info.status !== 'dead') {
      info.status = 'stopped'
    }

    // P1-03: Mark that kill was requested so exit handler doesn't restart
    this.killRequested.add(topicName)

    log.info(`Killing child for topic "${topicName}" (PID ${child.pid})`)

    // SIGTERM — allow graceful shutdown
    try {
      child.kill('SIGTERM')
    } catch {
      // Process may already be dead
    }

    // Force SIGKILL after delay
    setTimeout(() => {
      try {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL')
        }
      } catch {
        // Already dead
      }
    }, SIGKILL_DELAY)
  }

  /**
   * Return a snapshot of the supervisor's current state.
   * P3-06: Use package.json version instead of hardcoded '0.1.0'.
   */
  getStatus(): SupervisorStatus {
    return {
      pid: process.pid,
      uptime: Date.now() - this.startTime,
      children: Array.from(this.children.values()),
      daemonVersion: getDaemonVersion(),
    }
  }

  /**
   * Safely write an event to the event bus, catching and logging errors.
   */
  private safeWriteEvent(topicName: string, kind: string, data: Record<string, unknown>): void {
    try {
      writeEvent(topicName, kind, data)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`Failed to write ${kind} event for "${topicName}": ${msg}`)
    }
  }

  /**
   * Safely trigger the orchestrator, catching and logging errors.
   */
  private safeTriggerOrchestrator(topicName: string, eventType: string, data: Record<string, unknown>): void {
    try {
      checkAndTriggerOrchestrator(topicName, eventType, data)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error(`Failed to trigger orchestrator for "${topicName}": ${msg}`)
    }
  }

  /**
   * Graceful shutdown: send IPC shutdown to all children,
   * wait 10s, then force-kill remaining.
   */
  shutdown(): void {
    log.info('Supervisor shutting down')
    this.shuttingDown = true

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    // Send graceful shutdown to all children via IPC
    const shutdownPromises: Array<Promise<unknown>> = []
    for (const [topicName, child] of this.processes) {
      const sent = sendToChild(child, 'parent:shutdown', { reason: 'parent_terminating' })
      if (sent) {
        // Wait for child to exit, or timeout and SIGKILL
        shutdownPromises.push(
          new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              log.warn(`Child "${topicName}" did not exit gracefully, force killing`)
              this.killChild(topicName)
              resolve()
            }, SIGKILL_DELAY)

            child.once('exit', () => {
              clearTimeout(timeout)
              resolve()
            })
          }),
        )
      } else {
        // IPC channel closed, force kill
        this.killChild(topicName)
      }
    }

    if (shutdownPromises.length > 0) {
      Promise.allSettled(shutdownPromises).then(() => {
        log.info('All children terminated')
        this.cleanup()
      })
    } else {
      this.cleanup()
    }
  }

  /**
   * Schedule a restart with exponential backoff.
   * P2-22: Uses per-child maxRetries from config instead of hardcoded MAX_RESTARTS.
   */
  private scheduleRestart(topicName: string): void {
    if (this.restarting.has(topicName)) return
    const count = this.restartCount.get(topicName) ?? 0

    // Use per-child maxRetries if available, otherwise default
    const info = this.children.get(topicName)
    const maxRetries = info?.resident !== undefined ? (info.resident ? DEFAULT_MAX_RESTARTS : 0) : DEFAULT_MAX_RESTARTS

    if (count >= maxRetries) {
      log.warn(`Child "${topicName}" exceeded max restarts (${maxRetries}), giving up`)
      return
    }

    this.restarting.add(topicName)
    const delay = BACKOFF_DURATIONS[count] ?? 4_000
    this.restartCount.set(topicName, count + 1)

    if (info) {
      info.status = 'restarting'
      // P1-02: Sync restartCount on ChildProcessInfo struct with Map
      info.restartCount = count + 1
      log.info(`Child "${topicName}" restart scheduled in ${delay}ms (attempt ${count + 1}/${maxRetries})`)
    }

    setTimeout(() => {
      this.restarting.delete(topicName)
      if (this.shuttingDown) return
      this.spawnChild(topicName, { resident: info?.resident ?? true })
    }, delay)
  }

  /**
   * Manually restart a child via CLI.
   */
  restartChild(topicName: string): boolean {
    const existing = this.children.get(topicName)
    if (!existing) return false

    this.killChild(topicName)
    this.scheduleRestart(topicName)
    return true
  }

  /**
   * Clean up after all children are gone.
   */
  private cleanup(): void {
    this.children.clear()
    this.processes.clear()
    this.lastHeartbeat.clear()
    this.restartCount.clear()
    this.restarting.clear()
    this.killRequested.clear()
    this.spawningTimers.clear()
    log.info('Supervisor cleanup complete')
  }

  // ── Private: periodic health check ────────────────────

  private checkChildren(): void {
    const now = Date.now()
    for (const [topicName, info] of this.children) {
      const child = this.processes.get(topicName)

      // Process-level checks
      if (!child || child.killed) {
        if (info.status !== 'stopped' && info.status !== 'dead') {
          info.status = 'dead'
          log.warn(`Child "${topicName}" process gone, marking dead`)
          if (!this.shuttingDown) {
            this.scheduleRestart(topicName)
          }
        }
        continue
      }

      if (child.exitCode !== null) {
        info.status = child.exitCode === 0 ? 'stopped' : 'dead'
        continue
      }

      // Heartbeat-based degraded/dead detection (only for running/degraded)
      if (info.status === 'running' || info.status === 'degraded') {
        const lhb = this.lastHeartbeat.get(topicName) ?? info.lastHeartbeat
        if (lhb) {
          const elapsed = now - lhb
          if (elapsed > DEAD_THRESHOLD) {
            info.status = 'dead'
            log.warn(`Child "${topicName}" no heartbeat for ${(elapsed / 1000).toFixed(0)}s, marking dead`)
            // Phase 3: Write crash event for heartbeat dead
            try {
              writeEvent(topicName, 'child_crashed', {
                heartbeatElapsed: elapsed,
                pid: info.pid,
                reason: 'heartbeat_timeout',
              })
            } catch (err: unknown) {
              log.error(`Failed to write child_crashed event: ${err}`)
            }
            try {
              checkAndTriggerOrchestrator(topicName, 'child_crashed', {
                heartbeatElapsed: elapsed,
                pid: info.pid,
                reason: 'heartbeat_timeout',
              })
            } catch (err: unknown) {
              log.error(`Failed to trigger orchestrator: ${err}`)
            }
            if (!this.shuttingDown) {
              this.scheduleRestart(topicName)
            }
          } else if (elapsed > DEGRADED_THRESHOLD && info.status === 'running') {
            info.status = 'degraded'
            log.warn(`Child "${topicName}" no heartbeat for ${(elapsed / 1000).toFixed(0)}s, degraded`)
            // Phase 3: Write degraded event
            try {
              writeEvent(topicName, 'child_degraded', { heartbeatElapsed: elapsed, pid: info.pid })
            } catch (err: unknown) {
              log.error(`Failed to write child_degraded event: ${err}`)
            }
            try {
              checkAndTriggerOrchestrator(topicName, 'child_degraded', { heartbeatElapsed: elapsed, pid: info.pid })
            } catch (err: unknown) {
              log.error(`Failed to trigger orchestrator: ${err}`)
            }
          }
        }
      }
    }

    // Log status periodically
    if (this.children.size > 0) {
      const alive = Array.from(this.children.values()).filter(
        (c) => c.status !== 'dead' && c.status !== 'stopped' && c.status !== 'spawn_failed',
      ).length
      log.debug(`Heartbeat: ${alive} alive / ${this.children.size} total children`)
    }
  }
}

// ── Supervisor CLI command handler ─────────────────────────

const YU_HOME = resolve(process.env.HOME || '/home/saltfish', '.yu')
const SUPERVISOR_LOG_PATH = resolve(YU_HOME, 'logs', 'supervisor.log')

/**
 * Handle `yu supervisor <subcommand>` CLI commands.
 * Reads from the child_processes DB table and sends signals directly.
 *
 * P3-09: Add explicit 'help' case alongside default.
 */
export function supervisorCommand(subcommand: string, args: string[]): string {
  switch (subcommand) {
    case 'status':
      return cmdSupervisorStatus(args)
    case 'stop':
      return cmdSupervisorStop(args)
    case 'restart':
      return cmdSupervisorRestart(args)
    case 'logs':
      return cmdSupervisorLogs(args)
    case 'help':
      return SUPERVISOR_HELP
    default:
      return SUPERVISOR_HELP
  }
}

function getChildProcessesDb(): DatabaseSync | null {
  try {
    const dbPath = resolve(YU_HOME, 'topics.db')
    if (!existsSync(dbPath)) return null
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout=3000')
    return db
  } catch {
    return null
  }
}

function cmdSupervisorStatus(args: string[]): string {
  const topicFilter = args[0] // optional topic name filter

  const db = getChildProcessesDb()
  if (!db) {
    return 'No supervisor database found. Start a background task first (yu topic bg).'
  }

  const rows = db
    .prepare(
      'SELECT topic_name, pid, parent_pid, status, prompt, fork_time, last_heartbeat, restart_count FROM child_processes ORDER BY fork_time DESC',
    )
    .all() as Array<Record<string, unknown>>

  db.close()

  if (rows.length === 0) {
    return 'No child processes registered.'
  }

  const lines: string[] = []
  lines.push('Supervisor Children:')
  lines.push('')

  for (const row of rows) {
    const name = row.topic_name as string
    if (topicFilter && name !== topicFilter) continue
    const pid = row.pid as number
    const status = row.status as string
    const prompt = (row.prompt as string) || ''
    const _forkTime = row.fork_time as string
    const lastHb = row.last_heartbeat as string | null
    const restartCount = (row.restart_count as number) ?? 0

    const statusIcon =
      status === 'running'
        ? '▶'
        : status === 'restarting'
          ? '🔄'
          : status === 'degraded'
            ? '⚠'
            : status === 'dead'
              ? '✗'
              : '○'
    const hbInfo = lastHb ? `last hb: ${new Date(lastHb).toLocaleTimeString()}` : 'no heartbeat yet'

    lines.push(`  ${statusIcon} ${name}` + `  [${status}]  PID ${pid}  ${hbInfo}  restarts: ${restartCount}`)
    if (prompt) {
      lines.push(`     ${prompt.substring(0, 120)}`)
    }
  }

  lines.push('')
  lines.push(`Total: ${rows.length} child process(es)`)
  return lines.join('\n')
}

function cmdSupervisorStop(args: string[]): string {
  if (args.length === 0) {
    return 'Usage: yu supervisor stop <topic>'
  }

  const topicName = args[0]
  const db = getChildProcessesDb()
  if (!db) return 'No supervisor database found.'

  const row = db.prepare('SELECT pid, status FROM child_processes WHERE topic_name = ?').get(topicName) as
    | { pid: number; status: string }
    | undefined

  if (!row) {
    db.close()
    return `No child process found for topic "${topicName}".`
  }

  // Update status in DB
  db.prepare('UPDATE child_processes SET status = ?, updated_at = ? WHERE topic_name = ?').run(
    'stopped',
    new Date().toISOString(),
    topicName,
  )
  db.close()

  // Send SIGTERM to the child process
  try {
    process.kill(row.pid, 'SIGTERM')
    return `Sent SIGTERM to child "${topicName}" (PID ${row.pid}).`
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Child "${topicName}" (PID ${row.pid}) may already be dead: ${msg}`
  }
}

function cmdSupervisorRestart(args: string[]): string {
  if (args.length === 0) {
    return 'Usage: yu supervisor restart <topic>'
  }

  const topicName = args[0]
  const db = getChildProcessesDb()
  if (!db) return 'No supervisor database found.'

  const row = db.prepare('SELECT pid, status FROM child_processes WHERE topic_name = ?').get(topicName) as
    | { pid: number; status: string }
    | undefined

  if (!row) {
    db.close()
    return `No child process found for topic "${topicName}".`
  }

  // Kill the child process
  try {
    process.kill(row.pid, 'SIGTERM')
  } catch {
    // Already dead
  }

  // Update DB: set topic status to 'background' so daemon picks it up
  db.prepare('UPDATE child_processes SET status = ?, updated_at = ? WHERE topic_name = ?').run(
    'restarting',
    new Date().toISOString(),
    topicName,
  )

  const topicRow = db.prepare('SELECT id FROM topics WHERE LOWER(name) = LOWER(?)').get(topicName) as
    | { id: string }
    | undefined

  if (topicRow) {
    db.prepare('UPDATE topics SET status = ?, last_active = ? WHERE id = ?').run(
      'background',
      new Date().toISOString(),
      topicRow.id,
    )
  }

  db.close()
  return `Restart initiated for child "${topicName}" (PID ${row.pid} was killed). The daemon will pick up the new task.`
}

function cmdSupervisorLogs(args: string[]): string {
  const topicName = args[0]
  if (!topicName) {
    return 'Usage: yu supervisor logs <topic> [n]'
  }

  const nLines = args[1] ? parseInt(args[1], 10) : 10
  if (Number.isNaN(nLines) || nLines < 1) {
    return 'Error: n must be a positive integer.'
  }

  if (!existsSync(SUPERVISOR_LOG_PATH)) {
    return `Supervisor log not found at ${SUPERVISOR_LOG_PATH}.`
  }

  try {
    const content = readFileSync(SUPERVISOR_LOG_PATH, 'utf-8')
    const lines = content.split('\n').filter((l: string) => l.includes(topicName))
    const tail = lines.slice(-nLines)
    if (tail.length === 0) {
      return `No log entries found for topic "${topicName}".`
    }
    return tail.join('\n')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Error reading supervisor log: ${msg}`
  }
}

const SUPERVISOR_HELP = `yu supervisor — Supervisor management

Usage:
  yu supervisor status              Show all child process statuses
  yu supervisor status <topic>      Show single child detail
  yu supervisor stop <topic>        Gracefully stop a child process
  yu supervisor restart <topic>     Restart a child process
  yu supervisor logs <topic> [n]    Show last n lines of child log (default: 10)
`
