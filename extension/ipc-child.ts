/**
 * yu-agent — IPC child-side helpers.
 *
 * Functions for the bg-worker child process to communicate
 * with the parent Supervisor over the 4th fd ('ipc').
 *
 * Phase 1: Minimal IPC layer — respond to pings, report results.
 */

import { createLogger } from './logger.js';

const log = createLogger('ipc-child');

export type IpcMessageType =
  | 'ping'
  | 'pong'
  | 'task_result'
  | 'error'
  | 'status_update'
  | 'heartbeat'
  | 'parent:shutdown'
  | 'parent:new_task'
  | 'parent:die';

export interface IpcMessage {
  type: IpcMessageType;
  payload?: unknown;
  timestamp: number;
}

type MessageHandler = (payload: unknown) => void | Promise<void>;

/**
 * Send a JSON message to the parent process via IPC.
 * Returns true if the message was queued, false if the channel is closed.
 */
export function send(type: IpcMessageType, payload?: unknown): boolean {
  if (!process.send) {
    log.warn('IPC channel not available (process.send is undefined)');
    return false;
  }
  return process.send({ type, payload, timestamp: Date.now() } as IpcMessage);
}

/**
 * Set up IPC message handlers for the child process.
 *
 * @param handlers  Map of message types to handler functions.
 *   The handler is called with the payload of the message.
 *   Handlers can be async; the IPC layer does not await them.
 *
 * Typical handlers:
 *   { 'ping': () => send('pong'), 'shutdown': () => process.exit(0) }
 */
export function setupChildIPC(handlers: Record<string, MessageHandler>): void {
  // Listen for messages from parent
  process.on('message', (msg: IpcMessage) => {
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
  process.on('disconnect', () => {
    log.warn('Parent process disconnected, exiting');
    process.exit(0);
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
