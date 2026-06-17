/**
 * yu-agent — IPC parent-side helpers (Bun stdio IPC).
 *
 * Functions for the Supervisor/parent side to communicate
 * with spawned child processes over stdin/stdout JSON-line protocol.
 *
 * Bun has no fork()+IPC equivalent; we use JSON lines over stdio:
 *   Parent → Child: writes JSON to child's stdin
 *   Child → Parent: writes JSON to its stdout, parent reads
 *
 * Phase 1: Minimal IPC layer — ping/pong, task results, status updates.
 */

import type { Subprocess } from 'bun'
import type { IpcMessage, IpcMessageType } from './types.js'

// Shared message counter for seq generation
let msgSeq = 0

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
 * Send a JSON message to a child process via stdin.
 * Returns true if written, false if stdin is closed.
 */
export function sendToChild(child: Subprocess, type: IpcMessageType, payload?: Record<string, unknown>): boolean {
  try {
    const buffer = new TextEncoder().encode(JSON.stringify(buildMessage(type, payload)) + '\n')
    // Bun's Subprocess stdin pipe has a synchronous write() method
    const n = (child.stdin as any)?.write(buffer)
    return typeof n === 'number' && n > 0
  } catch {
    return false
  }
}

/**
 * Wait for the child to send a specific message type via stdout.
 * Reads from child's stdout as JSON lines.
 */
export function waitForMessage(
  child: Subprocess,
  expectedType: IpcMessageType,
  timeoutMs: number,
): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const reader = (child.stdout as unknown as ReadableStream).getReader()
    if (!reader) {
      reject(new Error('Child stdout not available'))
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let done = false

    const timer = setTimeout(() => {
      done = true
      reader.cancel()
      reject(new Error(`Timeout waiting for '${expectedType}' after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      if (!done) reader.cancel()
    }

    async function readLoop() {
      try {
        while (!done) {
          const { value, done: streamDone } = await reader.read()
          if (streamDone) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const msg = JSON.parse(line) as IpcMessage
              if (msg.type === expectedType) {
                cleanup()
                resolve(msg)
                return
              }
            } catch {
              // malformed line, skip
            }
          }
        }
      } catch {
        // stream error
      }
      cleanup()
      reject(new Error('Child stdout closed while waiting'))
    }

    readLoop()

    // Also clean up if the child exits
    child.exited.then((exitCode) => {
      cleanup()
      reject(new Error(`Child exited (code=${exitCode}) while waiting for '${expectedType}'`))
    })
  })
}
