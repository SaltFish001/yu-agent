/**
 * yu-agent — IPC parent-side helpers.
 *
 * Functions for the Supervisor/parent side to communicate
 * with forked child processes over the 4th fd ('ipc').
 *
 * Phase 1: Minimal IPC layer — ping/pong, task results, status updates.
 */

import type { ChildProcess } from 'node:child_process';
import type { IpcMessageType, IpcMessage } from './types.js';

// Shared message counter for seq generation
let msgSeq = 0;

/**
 * Build an IpcMessage with auto-populated timestamp and optional seq.
 */
function buildMessage(type: IpcMessageType, payload?: Record<string, unknown>): IpcMessage {
  return {
    type,
    payload,
    timestamp: Date.now(),
    seq: ++msgSeq,
  };
}

/**
 * Send a JSON message to a child process via IPC.
 * Returns true if the message was queued, false if the channel is closed.
 */
export function sendToChild(child: ChildProcess, type: IpcMessageType, payload?: Record<string, unknown>): boolean {
  if (!child.connected) return false;
  return child.send(buildMessage(type, payload));
}

/**
 * Wait for the child to send a specific message type.
 * Rejects with a timeout error if the expected message doesn't arrive.
 */
export function waitForMessage(
  child: ChildProcess,
  expectedType: IpcMessageType,
  timeoutMs: number,
): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for '${expectedType}' after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (msg: IpcMessage) => {
      if (msg.type === expectedType) {
        cleanup();
        resolve(msg);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('message', handler);
    };

    child.on('message', handler);

    // Also clean up if the child exits
    child.once('exit', (code) => {
      cleanup();
      reject(new Error(`Child exited (code=${code}) while waiting for '${expectedType}'`));
    });
  });
}
