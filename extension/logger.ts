/**
 * yu-agent — Structured JSON Lines logger.
 *
 * All output goes to stderr as JSON Lines.
 * Non-debug levels are also persisted to SQLite (async, fire-and-forget).
 * Errors are safely serialized (name, message, stack — no circular refs).
 */

import { writeSync } from 'fs'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LogEntry {
  level: LogLevel
  timestamp: string // ISO 8601
  module: string
  message: string
  error?: { name: string; message: string; stack?: string }
  data?: Record<string, unknown>
}

// ── Pending writes queue for flushLogs ──────────────────

let _pendingWrites: Promise<void>[] = []

// ── Error serialization ────────────────────────────────

/**
 * Safely serialize an error object without circular references.
 * Returns undefined if err is falsy.
 */
function serializeError(err?: unknown): { name: string; message: string; stack?: string } | undefined {
  if (err == null) return undefined
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    }
  }
  return {
    name: 'UnknownError',
    message: String(err),
  }
}

// ── SQLite persistence (async, fire-and-forget) ────────

function persistToDb(entry: LogEntry): void {
  // Fire-and-forget: we don't await this, but track the promise for flushLogs
  const promise = (async () => {
    try {
      const { getDb } = await import('./db.js')
      const db = getDb()
      db.prepare(`
        INSERT INTO logs (timestamp, level, module, message, error, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        entry.timestamp,
        entry.level,
        entry.module,
        entry.message,
        entry.error ? JSON.stringify(entry.error) : null,
        entry.data ? JSON.stringify(entry.data) : null,
      )
    } catch {
      // DB persistence is best-effort — silence errors
    }
  })()
  _pendingWrites.push(promise)
  // Keep the queue bounded — drop old entries if too many pending
  if (_pendingWrites.length > 100) {
    _pendingWrites = _pendingWrites.slice(-50)
  }
}

// ── Core log function ──────────────────────────────────

function log(entry: {
  level: LogLevel
  module: string
  message: string
  error?: { name: string; message: string; stack?: string }
  data?: Record<string, unknown>
}): void {
  const logEntry: LogEntry = {
    level: entry.level,
    timestamp: new Date().toISOString(),
    module: entry.module,
    message: entry.message,
    error: entry.error,
    data: entry.data,
  }

  // Write JSON Lines to stderr
  const line = `${JSON.stringify(logEntry)}\n`
  try {
    writeSync(process.stderr.fd, line)
  } catch {
    // stderr might be closed during shutdown — ignore
  }

  // Non-debug levels also persist to SQLite
  if (entry.level !== 'debug') {
    persistToDb(logEntry)
  }
}

// ── Public API ─────────────────────────────────────────

export function createLogger(module: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => log({ level: 'debug', module, message: msg, data }),
    info: (msg: string, data?: Record<string, unknown>) => log({ level: 'info', module, message: msg, data }),
    warn: (msg: string, err?: unknown, data?: Record<string, unknown>) =>
      log({ level: 'warn', module, message: msg, error: serializeError(err), data }),
    error: (msg: string, err?: unknown, data?: Record<string, unknown>) =>
      log({ level: 'error', module, message: msg, error: serializeError(err), data }),
    fatal: (msg: string, err?: unknown, data?: Record<string, unknown>) =>
      log({ level: 'fatal', module, message: msg, error: serializeError(err), data }),
  }
}

/**
 * Wait for all pending log writes to complete.
 * Useful before shutdown to ensure all logs are flushed.
 */
export async function flushLogs(): Promise<void> {
  const pending = _pendingWrites.slice()
  _pendingWrites = []
  await Promise.allSettled(pending)
}
