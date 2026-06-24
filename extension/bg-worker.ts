#!/usr/bin/env node

/**
 * yu-agent — Background worker entry point.
 *
 * This module is the entry point for child processes/workers spawned by
 * the Supervisor. It imports and calls the scheduler handler for a given topic.
 *
 * Supports two modes:
 *   - Bun.Worker (preferred): spawned via new Worker(), IPC via postMessage
 *   - Bun.spawn (legacy): spawned as subprocess, IPC via stdin/stdout JSON lines
 *
 * Phase 1: IPC protocol (ping/pong, shutdown, task results),
 *          dedicated DB connection with busy_timeout=5000.
 *
 * Phase 2: Resident mode — after task completes, enters wait loop
 *          for `parent:new_task` or `parent:shutdown` messages.
 */

import { Database as DatabaseSync } from 'bun:sqlite'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { send, setupChildIPC } from './ipc-child.js'
import { createLogger } from './logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const log = createLogger('bg-worker')

// Worker globals for Bun's Worker context
interface WorkerGlobals {
  postMessage(message: string): void
  close(): void
  onmessage: ((event: MessageEvent) => void) | null
}

// Detect Worker mode
const isWorkerMode = typeof (globalThis as unknown as WorkerGlobals).postMessage === 'function'

// ── Open a dedicated DB connection for write operations ──
const TOPICS_DB_PATH = resolve(process.env.HOME || '/home/saltfish', '.yu', 'topics.db')
const TASK_TIMEOUT = 300_000 // 5 minutes — default timeout for handler() calls
let _bgDb: DatabaseSync | null = null

function getBgDb(): DatabaseSync {
  if (_bgDb) return _bgDb
  _bgDb = new DatabaseSync(TOPICS_DB_PATH)
  _bgDb.exec('PRAGMA journal_mode=WAL')
  _bgDb.exec('PRAGMA busy_timeout=5000')
  return _bgDb
}

/**
 * Update topic status using our dedicated DB connection.
 */
function bgSetStatus(name: string, status: string): void {
  const db = getBgDb()
  const find = db.prepare('SELECT id FROM topics WHERE LOWER(name) = LOWER(?)').get(name) as { id: string } | undefined
  if (!find) {
    log.error(`Topic "${name}" not found for status update`)
    return
  }
  db.prepare('UPDATE topics SET status = ?, last_active = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    find.id,
  )
}

/**
 * Update topic summary using our dedicated DB connection.
 */
function bgSetSummary(name: string, summary: string): void {
  const db = getBgDb()
  const find = db.prepare('SELECT id FROM topics WHERE LOWER(name) = LOWER(?)').get(name) as { id: string } | undefined
  if (!find) {
    log.error(`Topic "${name}" not found for summary update`)
    return
  }
  db.prepare('UPDATE topics SET summary = ? WHERE id = ?').run(summary, find.id)
}

/**
 * Graceful exit — process.exit() in process mode, self.close() in Worker mode.
 */
function gracefulExit(code: number, reason?: string): never {
  if (reason) log.info(`Exiting: ${reason}`)
  if (isWorkerMode) {
    ;(globalThis as unknown as WorkerGlobals).close()
    // self.close() doesn't stop execution immediately in all Bun versions
    // so we force-stop via throwing
    throw new Error(`exit:${code}`)
  }
  process.exit(code)
}

/**
 * Execute a single task for the given topic.
 */
async function executeTask(topicName: string, prompt: string): Promise<boolean> {
  log.info(`Executing: ${prompt.substring(0, 200)}`)

  try {
    const { handler } = await import('./scheduler.js')

    const result = (await Promise.race([
      handler(prompt, { source: 'topic_bg', topic: topicName }),
      new Promise<string | null>((_, reject) =>
        setTimeout(() => reject(new Error(`Task timed out after ${TASK_TIMEOUT}ms`)), TASK_TIMEOUT),
      ),
    ])) as string | null | undefined

    if (result) {
      const dbSummary = result.substring(0, 500)
      bgSetSummary(topicName, `Completed: ${prompt}\n\n${dbSummary}`)
      log.info(`Task completed for "${topicName}"`)

      const sent = send('task_result', { topicName, status: 'completed', result })
      if (!sent) log.warn('Failed to send task_result IPC message — channel may be closed')
    } else {
      bgSetSummary(topicName, `Completed: ${prompt}\n\n(no output)`)
      log.info(`Task completed (empty result) for "${topicName}"`)
      const sent = send('task_result', { topicName, status: 'completed' })
      if (!sent) log.warn('Failed to send task_result IPC message — channel may be closed')
    }

    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    bgSetSummary(topicName, `Failed: ${prompt}\n\n${msg}`)
    log.error(`Task failed for "${topicName}": ${msg}`)
    const sent = send('error', { topicName, error: msg })
    if (!sent) log.warn('Failed to send error IPC message — channel may be closed')
    return false
  }
}

async function main(): Promise<void> {
  // Get topic name from env (works in both Worker and process mode)
  const topicName = process.env.YU_TOPIC_NAME
  if (!topicName) {
    log.error('Missing YU_TOPIC_NAME environment variable')
    gracefulExit(1, 'missing YU_TOPIC_NAME')
  }

  log.info(`Background worker starting for topic "${topicName}"`)

  // ── Set up IPC handlers ──
  let residentMode = false
  let currentTaskPromise: Promise<boolean> | null = null
  const currentTaskRef = { current: currentTaskPromise as Promise<unknown> | null }

  setupChildIPC(
    {
      ping: () => {
        send('pong')
      },
      shutdown: () => {
        gracefulExit(0, 'shutdown')
      },
      'parent:shutdown': () => {
        log.info('Received parent:shutdown, cleaning up and exiting')
        bgSetStatus(topicName, 'idle')
        gracefulExit(0, 'parent:shutdown')
      },
      'parent:die': () => {
        log.info('Received parent:die, exiting immediately')
        gracefulExit(0, 'parent:die')
      },
      'parent:new_task': (payload: unknown) => {
        if (!residentMode) {
          log.warn('Received new_task but not in resident mode, ignoring')
          return
        }
        const data = payload as { prompt?: string; options?: Record<string, unknown> } | undefined
        if (!data?.prompt) {
          log.warn('Received parent:new_task without prompt')
          return
        }
        if (currentTaskPromise !== null) {
          log.warn('Received parent:new_task while a task is already running, dropping')
          return
        }
        currentTaskPromise = executeTask(topicName, data.prompt).finally(() => {
          currentTaskPromise = null
          currentTaskRef.current = null
        })
        currentTaskRef.current = currentTaskPromise
      },
    },
    currentTaskRef,
  )

  // Signal to parent that we're alive
  send('pong')
  log.info('Sent pong to parent')

  const { get } = await import('./topic.js')
  const topic = get(topicName)
  if (!topic) {
    log.error(`Topic "${topicName}" not found`)
    gracefulExit(1, 'topic not found')
  }

  const prompt = topic.summary.replace(/^Running: /, '')

  // Start heartbeat interval
  const _heartbeatInterval = setInterval(() => {
    send('heartbeat', { topicName })
  }, 5_000)

  // ── Execute the first task ──
  await executeTask(topicName, prompt)

  // ── Enter resident mode ──
  bgSetStatus(topicName, 'idle')
  residentMode = true
  log.info(`Entering resident mode for topic "${topicName}"`)
  send('status_update', { topicName, status: 'resident' })

  // Wait for parent:shutdown or parent:die to trigger exit
  await new Promise<void>(() => {
    // This promise never resolves on its own.
    // Handlers call gracefulExit() above.
    // We just keep the event loop alive.
  })
}

main().catch((err) => {
  log.error('Fatal worker error:', err instanceof Error ? err.message : String(err))
  gracefulExit(1, 'fatal error')
})
