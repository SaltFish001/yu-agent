#!/usr/bin/env node
/**
 * yu-agent — Background worker entry point (fork target).
 *
 * This module is the entry point for child processes forked by the Supervisor.
 * It imports and calls the scheduler handler for a given topic.
 *
 * Phase 1: IPC protocol (ping/pong, shutdown, task results),
 *          dedicated DB connection with busy_timeout=5000.
 *
 * Phase 2: Resident mode — after task completes, enters wait loop
 *          for `parent:new_task` or `parent:shutdown` messages.
 *
 * Usage (called by Supervisor.spawnChild):
 *   node dist/extension/bg-worker.js --topic-name=frontend
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { createLogger } from './logger.js';
import { setupChildIPC, send } from './ipc-child.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('bg-worker');

// ── Open a dedicated DB connection for write operations ──
// Use a longer busy_timeout (5000ms) to avoid contention with the
// supervisor daemon which also writes to topics.db.
const TOPICS_DB_PATH = resolve(homedir(), '.yu', 'topics.db');
const TASK_TIMEOUT = 300_000; // 5 minutes — default timeout for handler() calls
let _bgDb: DatabaseSync | null = null;

function getBgDb(): DatabaseSync {
  if (_bgDb) return _bgDb;
  _bgDb = new DatabaseSync(TOPICS_DB_PATH);
  _bgDb.exec('PRAGMA journal_mode=WAL');
  _bgDb.exec('PRAGMA busy_timeout=5000');
  return _bgDb;
}

/**
 * Update topic status using our dedicated DB connection.
 * Same logic as topic.ts setStatus() but with longer busy_timeout.
 */
function bgSetStatus(name: string, status: string): void {
  const db = getBgDb();
  const find = db.prepare(
    'SELECT id FROM topics WHERE LOWER(name) = LOWER(?)'
  ).get(name) as { id: string } | undefined;
  if (!find) {
    log.error(`Topic "${name}" not found for status update`);
    return;
  }
  db.prepare('UPDATE topics SET status = ?, last_active = ? WHERE id = ?')
    .run(status, new Date().toISOString(), find.id);
}

/**
 * Update topic summary using our dedicated DB connection.
 */
function bgSetSummary(name: string, summary: string): void {
  const db = getBgDb();
  const find = db.prepare(
    'SELECT id FROM topics WHERE LOWER(name) = LOWER(?)'
  ).get(name) as { id: string } | undefined;
  if (!find) {
    log.error(`Topic "${name}" not found for summary update`);
    return;
  }
  db.prepare('UPDATE topics SET summary = ? WHERE id = ?')
    .run(summary, find.id);
}

/**
 * Execute a single task for the given topic.
 * Shared between initial execution and parent:new_task.
 */
async function executeTask(topicName: string, prompt: string): Promise<boolean> {
  log.info(`Executing: ${prompt.substring(0, 200)}`);

  try {
    // Import and call scheduler
    const { handler } = await import('./scheduler.js');

    // Wrap handler call in a timeout to prevent hanging indefinitely
    const result = await Promise.race([
      handler(prompt, { source: 'topic_bg', topic: topicName }),
      new Promise<string | null>((_, reject) =>
        setTimeout(() => reject(new Error(`Task timed out after ${TASK_TIMEOUT}ms`)), TASK_TIMEOUT),
      ),
    ]) as string | null | undefined;

    if (result) {
      // P2-04: Store full result in IPC payload, truncation only for DB storage
      const dbSummary = result.substring(0, 500);
      bgSetSummary(topicName, `Completed: ${prompt}\n\n${dbSummary}`);
      log.info(`Task completed for "${topicName}"`);

      // Send full result via IPC (no truncation)
      const sent = send('task_result', { topicName, status: 'completed', result });
      if (!sent) {
        log.warn('Failed to send task_result IPC message — channel may be closed');
      }
    } else {
      bgSetSummary(topicName, `Completed: ${prompt}\n\n(no output)`);
      log.info(`Task completed (empty result) for "${topicName}"`);

      const sent = send('task_result', { topicName, status: 'completed' });
      if (!sent) {
        log.warn('Failed to send task_result IPC message — channel may be closed');
      }
    }

    return true;

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    bgSetSummary(topicName, `Failed: ${prompt}\n\n${msg}`);
    log.error(`Task failed for "${topicName}": ${msg}`);

    // Send error via IPC
    const sent = send('error', { topicName, error: msg });
    if (!sent) {
      log.warn('Failed to send error IPC message — channel may be closed');
    }
    return false;
  }
}

async function main(): Promise<void> {
  // Parse --topic-name argument
  const topicName = process.argv
    .find(a => a.startsWith('--topic-name='))
    ?.split('=', 2)[1];

  if (!topicName) {
    log.error('Missing --topic-name argument');
    process.exit(1);
  }

  log.info(`Background worker starting for topic "${topicName}"`);

  // ── Set up IPC handlers ──
  let residentMode = false;
  let currentTaskPromise: Promise<boolean> | null = null;

  // Create a ref object so setupChildIPC can check mid-task state (P2-08)
  const currentTaskRef = { current: currentTaskPromise as Promise<unknown> | null };

  setupChildIPC({
    'ping': () => {
      send('pong');
    },
    'shutdown': () => {
      log.info('Received shutdown from parent, exiting');
      process.exit(0);
    },
    'parent:shutdown': () => {
      log.info('Received parent:shutdown, cleaning up and exiting');
      bgSetStatus(topicName, 'idle');
      process.exit(0);
    },
    'parent:die': () => {
      log.info('Received parent:die, exiting immediately');
      process.exit(0);
    },
    'parent:new_task': (payload: unknown) => {
      if (!residentMode) {
        log.warn('Received new_task but not in resident mode, ignoring');
        return;
      }
      const data = payload as { prompt?: string; options?: Record<string, unknown> } | undefined;
      if (!data?.prompt) {
        log.warn('Received parent:new_task without prompt');
        return;
      }
      // If a task is already running, reject/drop the second one (P1-07)
      if (currentTaskPromise !== null) {
        log.warn('Received parent:new_task while a task is already running, dropping');
        return;
      }
      // Execute the new task
      currentTaskPromise = executeTask(topicName, data.prompt).finally(() => {
        currentTaskPromise = null;
        currentTaskRef.current = null;
      });
      currentTaskRef.current = currentTaskPromise;
    },
  }, currentTaskRef);

  // Signal to parent that we're alive
  send('pong');
  log.info('Sent pong to parent');

  // Dynamically import topic module for get() only (we use our own DB for writes)
  const { get } = await import('./topic.js');

  const topic = get(topicName);
  if (!topic) {
    log.error(`Topic "${topicName}" not found`);
    process.exit(1);
  }

  const prompt = topic.summary.replace(/^Running: /, '');

  // Start heartbeat interval BEFORE first task (P1-04)
  // This ensures the parent sees heartbeats during long-running first tasks
  const heartbeatInterval = setInterval(() => {
    send('heartbeat', { topicName });
  }, 5_000);

  // ── Execute the first task ──
  await executeTask(topicName, prompt);

  // ── Enter resident mode ──
  bgSetStatus(topicName, 'idle');
  residentMode = true;
  log.info(`Entering resident mode for topic "${topicName}"`);

  // Report status to parent
  send('status_update', { topicName, status: 'resident' });

  // Wait for parent:shutdown or parent:die to trigger exit
  // The handlers are already registered via setupChildIPC above.
  // We keep the process alive by waiting indefinitely.
  await new Promise<void>(() => {
    // This promise never resolves on its own.
    // The 'parent:shutdown' or 'parent:die' handler calls process.exit(0).
    // The 'shutdown' handler also calls process.exit(0).
    // We just need to keep the event loop alive.
  });
}

main().catch(err => {
  log.error('Fatal worker error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
