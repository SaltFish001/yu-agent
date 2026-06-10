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
  setupChildIPC({
    'ping': () => {
      send('pong');
    },
    'shutdown': () => {
      log.info('Received shutdown from parent, exiting');
      process.exit(0);
    },
  });

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

  log.info(`Executing: ${prompt}`);

  try {
    // Import and call scheduler
    const { handler } = await import('./scheduler.js');
    const result = await handler(prompt, { source: 'topic_bg', topic: topicName });

    if (result) {
      const outcome = result.substring(0, 500);
      bgSetSummary(topicName, `Completed: ${prompt}\n\n${outcome}`);
      log.info(`Task completed for "${topicName}"`);
    } else {
      bgSetSummary(topicName, `Completed: ${prompt}\n\n(no output)`);
      log.info(`Task completed (empty result) for "${topicName}"`);
    }

    // Send result via IPC
    send('task_result', { topicName, status: 'completed' });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    bgSetSummary(topicName, `Failed: ${prompt}\n\n${msg}`);
    log.error(`Task failed for "${topicName}": ${msg}`);

    // Send error via IPC
    send('error', { topicName, error: msg });
  } finally {
    bgSetStatus(topicName, 'idle');
    log.info(`Worker exiting for topic "${topicName}"`);
    process.exit(0);
  }
}

main().catch(err => {
  log.error('Fatal worker error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
