/**
 * yu-agent — IPC child-side helpers.
 *
 * Functions for the bg-worker child process to communicate
 * with the parent Supervisor over the 4th fd ('ipc').
 *
 * Phase 1: Minimal IPC layer — respond to pings, report results.
 */

import { createLogger } from './logger.js';
import type { IpcMessageType, IpcMessage } from './types.js';

const log = createLogger('ipc-child');

// Shared message counter for seq generation
let msgSeq = 0;

type MessageHandler = (payload: unknown) => void | Promise<void>;

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
 * Send a JSON message to the parent process via IPC.
 * Returns true if the message was queued, false if the channel is closed.
 */
export function send(type: IpcMessageType, payload?: Record<string, unknown>): boolean {
  if (!process.send) {
    log.warn('IPC channel not available (process.send is undefined)');
    return false;
  }
  return process.send(buildMessage(type, payload));
}

/**
 * Set up IPC message handlers for the child process.
 *
 * @param handlers  Map of message types to handler functions.
 *   The handler is called with the payload of the message.
 *   Handlers can be async; the IPC layer does not await them.
 *
 * @param currentTaskRef  Optional reference to a promise that resolves when
 *   the current task completes. Used by the disconnect handler to avoid
 *   exiting mid-task (P2-08).
 *
 * Typical handlers:
 *   { 'ping': () => send('pong'), 'shutdown': () => process.exit(0) }
 */
export function setupChildIPC(
  handlers: Record<string, MessageHandler>,
  currentTaskRef?: { current: Promise<unknown> | null },
): void {
  // Listen for messages from parent
  process.on('message', (msg: IpcMessage) => {
    // Log malformed messages (P2-11)
    if (!msg || typeof msg !== 'object' || !msg.type) {
      log.warn('Malformed IPC message received', msg);
      return;
    }

    const handler = handlers[msg.type];
    if (handler) {
      try {
        const result = handler(msg.payload);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            log.error(`IPC handler for '${msg.type}' threw async error`, err);
          });
        }
      } catch (err: unknown) {
        log.error(`IPC handler for '${msg.type}' threw error`, err);
      }
    } else {
      log.debug(`Unhandled IPC message type: ${msg.type}`);
    }
  });

  // If parent disconnects (crashes), exit gracefully
  // P2-08: Check for mid-task execution before exit(0)
  process.on('disconnect', () => {
    log.warn('Parent process disconnected, exiting');

    // If a task is currently running, give it a brief moment to finish
    if (currentTaskRef?.current) {
      log.info('Task still running on disconnect, waiting up to 2s before exit');
      const taskPromise = currentTaskRef.current;
      Promise.race([
        taskPromise,
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]).finally(() => {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });

  // ── OS signal handlers (P1-05) ──
  // These ensure the child exits cleanly when the parent sends SIGTERM/SIGINT
  // or when the terminal sends SIGHUP, preventing orphan children.
  function handleSignal(signal: string): void {
    log.info(`Received ${signal}, exiting gracefully`);
    process.exit(0);
  }
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGHUP', () => handleSignal('SIGHUP'));
}
