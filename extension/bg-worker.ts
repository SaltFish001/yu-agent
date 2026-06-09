#!/usr/bin/env node
/**
 * yu-agent — Background worker entry point (fork target).
 *
 * This module is the entry point for child processes forked by the Supervisor.
 * It imports and calls the scheduler handler for a given topic.
 *
 * Phase 0: Minimal worker — imports scheduler, executes the task,
 *          updates topic status on completion.
 * Phase 1+: IPC heartbeat, ready/shutdown protocol, SessionPool recovery.
 *
 * Usage (called by Supervisor.spawnChild):
 *   node dist/extension/bg-worker.js --topic-name=frontend
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger('bg-worker');

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

  // Dynamically import topic module (same process, no IPC needed for Phase 0)
  const { get, setStatus, setSummary } = await import('./topic.js');

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
      setSummary(topicName, `Completed: ${prompt}\n\n${outcome}`);
      log.info(`Task completed for "${topicName}"`);
    } else {
      setSummary(topicName, `Completed: ${prompt}\n\n(no output)`);
      log.info(`Task completed (empty result) for "${topicName}"`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setSummary(topicName, `Failed: ${prompt}\n\n${msg}`);
    log.error(`Task failed for "${topicName}": ${msg}`);
  } finally {
    setStatus(topicName, 'idle');
    log.info(`Worker exiting for topic "${topicName}"`);
    process.exit(0);
  }
}

main().catch(err => {
  log.error('Fatal worker error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
