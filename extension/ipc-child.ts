/**
 * yu-agent — IPC child-side helpers (Bun stdio IPC).
 *
 * Functions for the bg-worker child process to communicate
 * with the parent Supervisor over stdin/stdout JSON-line protocol.
 *
 * Bun has no fork()+IPC equivalent; we use JSON lines over stdio:
 *   Child → Parent: writes JSON to stdout
 *   Parent → Child: writes to stdin, child reads
 *
 * Phase 1: Minimal IPC layer — respond to pings, report results.
 */

import { createLogger } from './logger.js'
import type { IpcMessage, IpcMessageType } from './types.js'

const log = createLogger('ipc-child')

// Shared message counter for seq generation
let msgSeq = 0

type MessageHandler = (payload: unknown) => void | Promise<void>

// Readline buffer for stdin
let stdinBuffer = ''
const stdinDecoder = new TextDecoder()

/**
 * Build an IpcMessage with auto-populated timestamp and optional seq.
 */
function buildMessage(type: IpcMessageType, payload?: Record<string, unknown>): IpcMessage {
  return {
    type,
    payload,
    timestamp: Date.now(),
    seq: ++msgSeq,
  }
}

/**
 * Send a JSON message to the parent process via stdout.
 */
export function send(type: IpcMessageType, payload?: Record<string, unknown>): boolean {
  try {
    const buffer = new TextEncoder().encode(JSON.stringify(buildMessage(type, payload)) + '\n')
    return process.stdout.write(buffer) as unknown as boolean
  } catch {
    return false
  }
}

/**
 * Process one line of JSON input from stdin.
 */
function processLine(line: string, handlers: Record<string, MessageHandler>): void {
  if (!line.trim()) return
  try {
    const msg = JSON.parse(line) as IpcMessage
    if (!msg || typeof msg !== 'object' || !msg.type) {
      log.warn('Malformed IPC message received', msg)
      return
    }
    const handler = handlers[msg.type]
    if (handler) {
      try {
        const result = handler(msg.payload)
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            log.error(`IPC handler for '${msg.type}' threw async error`, err)
          })
        }
      } catch (err: unknown) {
        log.error(`IPC handler for '${msg.type}' threw error`, err)
      }
    } else {
      log.debug(`Unhandled IPC message type: ${msg.type}`)
    }
  } catch {
    // malformed JSON line, skip
  }
}

/**
 * Set up IPC message handlers for the child process.
 *
 * Uses stdin (Bun.ReadableStream) instead of process.on('message').
 * Prints messages to stdout (Bun.write) instead of process.send().
 *
 * @param handlers  Map of message types to handler functions.
 * @param currentTaskRef  Optional reference to a promise that resolves when
 *   the current task completes.
 */
export function setupChildIPC(
  handlers: Record<string, MessageHandler>,
  currentTaskRef?: { current: Promise<unknown> | null },
): void {
  // Listen for messages from parent via stdin
  ;(async () => {
    try {
      const stdin = process.stdin as unknown as ReadableStream
      const reader = stdin.getReader()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        stdinBuffer += stdinDecoder.decode(value, { stream: true })
        const lines = stdinBuffer.split('\n')
        stdinBuffer = lines.pop() ?? ''

        for (const line of lines) {
          processLine(line, handlers)
        }
      }
    } catch (err) {
      log.error('stdin read error', err)
    }
    // stdin closed = parent disconnected
    log.warn('Parent process stdin closed, exiting')

    // If a task is currently running, give it a brief moment to finish
    if (currentTaskRef?.current) {
      log.info('Task still running on disconnect, waiting up to 2s before exit')
      const taskPromise = currentTaskRef.current
      await Promise.race([taskPromise, new Promise((resolve) => setTimeout(resolve, 2000))])
    }
    process.exit(0)
  })()

  // ── OS signal handlers (P1-05) ──
  function handleSignal(signal: string): void {
    log.info(`Received ${signal}, exiting gracefully`)
    process.exit(0)
  }
  process.on('SIGTERM', () => handleSignal('SIGTERM'))
  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGHUP', () => handleSignal('SIGHUP'))
}
