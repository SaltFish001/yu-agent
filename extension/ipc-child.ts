/**
 * yu-agent — IPC child-side helpers (Bun stdio IPC + Worker mode).
 *
 * Functions for the bg-worker to communicate with the parent Supervisor.
 * Supports two modes:
 *   - Process mode: JSON lines over stdin/stdout (legacy Bun.spawn)
 *   - Worker mode:  postMessage/onmessage (Bun.Worker, preferred)
 *
 * Auto-detects based on runtime context.
 */

import { createLogger } from './logger.js'
import type { IpcMessage, IpcMessageType } from './types.js'

const log = createLogger('ipc-child')

// Shared message counter for seq generation
let msgSeq = 0

type MessageHandler = (payload: unknown) => void | Promise<void>

// Detect if running inside a Bun Worker context
// In Workers, globalThis has postMessage but process.stdout may not be available
const isWorkerMode = typeof (globalThis as any).postMessage === 'function'

// Readline buffer for stdin (process mode only)
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
 * Send a JSON message to the parent process.
 * - Worker mode: uses self.postMessage
 * - Process mode: writes JSON line to stdout
 */
export function send(type: IpcMessageType, payload?: Record<string, unknown>): boolean {
  try {
    if (isWorkerMode) {
    ;(globalThis as any).postMessage(JSON.stringify(buildMessage(type, payload)))
      return true
    }
    const buffer = new TextEncoder().encode(JSON.stringify(buildMessage(type, payload)) + '\n')
    return process.stdout.write(buffer) as unknown as boolean
  } catch {
    return false
  }
}

/**
 * Process one line of JSON input.
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
 * Set up IPC in Worker mode via self.onmessage.
 */
function setupWorkerIPC(
  handlers: Record<string, MessageHandler>,
): void {
  ;(globalThis as any).onmessage = (event: MessageEvent) => {
    try {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
      const msg = JSON.parse(raw) as IpcMessage
      const handler = handlers[msg.type]
      if (handler) {
        const result = handler(msg.payload)
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            log.error(`Worker IPC handler for '${msg.type}' threw async error`, err)
          })
        }
      }
    } catch {
      // skip malformed
    }
  }
}

/**
 * Set up IPC message handlers.
 *
 * Process mode: listens on stdin (Bun.ReadableStream).
 * Worker mode:  listens via self.onmessage.
 *
 * @param handlers  Map of message types to handler functions.
 * @param currentTaskRef  Optional reference to a promise that resolves when
 *   the current task completes.
 */
export function setupChildIPC(
  handlers: Record<string, MessageHandler>,
  currentTaskRef?: { current: Promise<unknown> | null },
): void {
  if (isWorkerMode) {
    setupWorkerIPC(handlers)
    return
  }

  // ── Process mode: stdin reader ──
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
    if (currentTaskRef?.current) {
      log.info('Task still running on disconnect, waiting up to 2s before exit')
      const taskPromise = currentTaskRef.current
      await Promise.race([taskPromise, new Promise((resolve) => setTimeout(resolve, 2000))])
    }
    process.exit(0)
  })()

  // ── OS signal handlers ──
  function handleSignal(signal: string): void {
    log.info(`Received ${signal}, exiting gracefully`)
    process.exit(0)
  }
  process.on('SIGTERM', () => handleSignal('SIGTERM'))
  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGHUP', () => handleSignal('SIGHUP'))
}
