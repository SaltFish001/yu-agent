/**
 * yu-agent — IPC parent-side helpers (Bun stdio IPC + Worker mode).
 *
 * Functions for the Supervisor/parent side to communicate
 * with spawned child processes or workers.
 *
 * Two modes:
 *   - Process mode: JSON lines over stdin/stdout (legacy Bun.spawn)
 *   - Worker mode:  postMessage/onmessage (Bun.Worker, preferred)
 */

import type { Subprocess } from 'bun'
import type { IpcMessage, IpcMessageType } from './types.js'

// Worker 没有 Subprocess 类型，用通用接口
export interface WorkerHandle {
  postMessage(msg: string): void
  onmessage?: ((event: { data: string }) => void) | undefined
  onerror?: ((err: ErrorEvent) => void) | undefined
  terminate(): void
  readonly threadId?: number
}

// Shared message counter for seq generation
let msgSeq = 0

/**
 * Build an IpcMessage with auto-populated timestamp and optional seq.
 */
export function buildMessage(type: IpcMessageType, payload?: Record<string, unknown>): IpcMessage {
  return {
    type,
    payload,
    timestamp: Date.now(),
    seq: ++msgSeq,
  }
}

/**
 * Send a JSON message to a child process via stdin.
 */
export function sendToChild(child: Subprocess, type: IpcMessageType, payload?: Record<string, unknown>): boolean {
  try {
    const buffer = new TextEncoder().encode(`${JSON.stringify(buildMessage(type, payload))}\n`)
    const n = (child.stdin as { write(data: Uint8Array): number })?.write(buffer)
    return typeof n === 'number' && n > 0
  } catch {
    return false
  }
}

/**
 * Send a JSON message to a Worker via postMessage.
 */
export function sendToWorker(worker: WorkerHandle, type: IpcMessageType, payload?: Record<string, unknown>): boolean {
  try {
    worker.postMessage(JSON.stringify(buildMessage(type, payload)))
    return true
  } catch {
    return false
  }
}

/**
 * Wait for a child process to send a specific message type via stdout.
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
              /* malformed line, skip */
            }
          }
        }
      } catch {
        /* stream error */
      }
      cleanup()
      reject(new Error('Child stdout closed while waiting'))
    }

    readLoop()
    child.exited.then((exitCode) => {
      cleanup()
      reject(new Error(`Child exited (code=${exitCode}) while waiting for '${expectedType}'`))
    })
  })
}

/**
 * Wait for a Worker to send a specific message type via postMessage.
 * Uses a wrapper around the Worker's onmessage to intercept the expected type.
 */
export function waitForWorkerMessage(
  worker: WorkerHandle,
  expectedType: IpcMessageType,
  timeoutMs: number,
): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timeout waiting for '${expectedType}' after ${timeoutMs}ms`))
    }, timeoutMs)

    const origOnMessage = worker.onmessage
    let done = false

    function cleanup() {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.onmessage = origOnMessage ?? undefined
    }

    worker.onmessage = (event: { data: string }) => {
      try {
        const msg = JSON.parse(event.data) as IpcMessage
        if (msg.type === expectedType) {
          cleanup()
          resolve(msg)
          return
        }
        // Pass through to original handler
        origOnMessage?.call(worker, event)
      } catch {
        /* skip */
      }
    }
  })
}
