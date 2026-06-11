#!/usr/bin/env node
/**
 * yu-agent — Supervisor Daemon entry point.
 *
 * Independent process that manages background topic execution.
 * Spawned by `cmdBg()` via `child_process.spawn(detached)` when
 * no supervisor daemon is currently running.
 *
 * Phase 0:
 *  - Write PID file to ~/.yu/supervisor.pid
 *  - Redirect stdout/stderr to ~/.yu/logs/supervisor.log
 *  - Scan topics DB for status='background' tasks
 *  - Use Supervisor class to fork child agents
 *  - Listen for SIGTERM → graceful shutdown
 *
 * Phase 1+:
 *  - Full IPC protocol with children
 *  - Event bus integration
 *  - Mailbox-based CLI communication
 *
 * This module is NOT imported by bin/yu.ts — it runs as a separate process.
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './logger.js';
import { Supervisor } from './supervisor.js';
import type { ChildSpawnConfig } from './types.js';
import { DatabaseSync } from 'node:sqlite';

// ── File paths ──────────────────────────────────────────

const YU_HOME = resolve(homedir(), '.yu');
const LOGS_DIR = resolve(YU_HOME, 'logs');
const PID_PATH = resolve(YU_HOME, 'supervisor.pid');

// ── Ensure directories ──────────────────────────────────

if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

// ── Redirect stdout/stderr to log file ──────────────────

const LOG_FILE = resolve(LOGS_DIR, 'supervisor.log');

// Simple file-based logging (avoid circular imports with the full logger)
function writeLog(level: string, message: string): void {
  const timestamp = new Date().toISOString();
  try {
    appendFileSync(LOG_FILE, `[${timestamp}] [${level}] ${message}\n`);
  } catch {
    // Best-effort logging
  }
}

/**
 * P2-19: Structured daemon log helper.
 * Writes a formatted log entry to the supervisor log file with a proper
 * daemon-level prefix. Uses fs.appendFileSync directly as a fallback
 * instead of monkey-patching console.* methods.
 */
function daemonLog(level: string, message: string): void {
  writeLog(level, message);
}

// ── Write PID file ──────────────────────────────────────

try {
  writeFileSync(PID_PATH, String(process.pid) + '\n');
  daemonLog('INFO', `Daemon started (PID ${process.pid})`);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  daemonLog('ERROR', `Failed to write PID file: ${msg}`);
  process.exit(1);
}

// ── K7 migration: clean up zombie background records ─────

/**
 * On startup, recover any topics stuck in 'background' status for
 * over 24 hours (zombie records from prior crashes or exit(0) bugs).
 * Sets them to 'idle' with a recovery note in the summary.
 * Returns the number of records cleaned up.
 */
function cleanupZombieBackgroundRecords(): number {
  try {
    const db = new DatabaseSync(resolve(homedir(), '.yu', 'topics.db'));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=5000');

    const result = db.prepare(`
      UPDATE topics
      SET status = 'idle',
          summary = summary || ' (recovered)'
      WHERE status = 'background'
        AND (started_at IS NULL OR started_at < datetime('now', '-24 hours'))
    `).run() as { changes: number };

    db.close();
    return result.changes;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    daemonLog('ERROR', `K7 migration failed: ${msg}`);
    return 0;
  }
}

// ── Run K7 migration before picking up tasks ─────────────

const cleanedCount = cleanupZombieBackgroundRecords();
if (cleanedCount > 0) {
  daemonLog('INFO', `K7 migration: cleaned up ${cleanedCount} zombie background topic(s)`);
}

// ── Initialize Supervisor ───────────────────────────────

const supervisor = new Supervisor();
supervisor.start();
daemonLog('INFO', 'Supervisor initialized');

// ── P2-12: Periodic K7 re-check during daemon lifetime ────
// Recheck for zombie background records every hour to catch
// records that become stale while the daemon is running.
setInterval(() => {
  const recheckCount = cleanupZombieBackgroundRecords();
  if (recheckCount > 0) {
    daemonLog('INFO', `Periodic K7 re-check: cleaned up ${recheckCount} zombie background topic(s)`);
  }
}, 60 * 60 * 1000); // Every hour

// ── Scan for existing background topics ─────────────────
// P1-14: pickupBackgroundTasks() runs AFTER start() completes initialization
// by being called from within start's initialization flow.

async function pickupBackgroundTasks(): Promise<void> {
  try {
    const { list } = await import('./topic.js');
    const topics = list(false);
    const bgTopics = topics.filter(t => t.status === 'background');

    if (bgTopics.length === 0) {
      daemonLog('INFO', 'No pending background tasks found');
      return;
    }

    daemonLog('INFO', `Found ${bgTopics.length} pending background task(s)`);

    for (const topic of bgTopics) {
      daemonLog('INFO', `Picking up task for topic "${topic.name}": ${topic.summary.substring(0, 100)}`);

      // P2-25: Add missing config fields to daemon task pickup
      const config: Partial<ChildSpawnConfig> = {
        timeout: 15_000,
        spawning_timeout: 30_000,
        resident: true,
        autoRetry: true,
        maxRetries: 3,
        env: {
          YU_DAEMON_PID: String(process.pid),
        },
      };

      // P1-13: Retry loop with exponential backoff on spawn failure
      const maxRetries = 3;
      let lastError: string | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const child = supervisor.spawnChild(topic.name, config);
        if (child) {
          daemonLog('INFO', `Forked child for "${topic.name}" (PID ${child.pid})`);
          lastError = null;
          break;
        } else {
          lastError = `Failed to fork child for "${topic.name}" (attempt ${attempt + 1}/${maxRetries + 1})`;
          daemonLog('ERROR', lastError);
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
            daemonLog('INFO', `Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      if (lastError) {
        daemonLog('ERROR', `Marking topic "${topic.name}" as spawn_failed after ${maxRetries + 1} attempts`);
        try {
          const db = new DatabaseSync(resolve(homedir(), '.yu', 'topics.db'));
          db.exec('PRAGMA journal_mode=WAL');
          db.prepare("UPDATE topics SET status = 'spawn_failed' WHERE name = ?").run(topic.name);
          db.close();
        } catch (dbErr: unknown) {
          const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          daemonLog('ERROR', `Failed to mark topic as spawn_failed: ${msg}`);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    daemonLog('ERROR', `Error picking up background tasks: ${msg}`);
  }
}

// ── Run pickup ──────────────────────────────────────────

pickupBackgroundTasks().catch(err => {
  daemonLog('ERROR', `Fatal error during task pickup: ${String(err)}`);
});

// ── Status reporting interval ───────────────────────────

setInterval(() => {
  const status = supervisor.getStatus();
  const alive = status.children.filter(c => 
    c.status !== 'dead' && c.status !== 'stopped' && c.status !== 'spawn_failed',
  );
  if (status.children.length > 0) {
    daemonLog('INFO', `Status: ${alive.length} running / ${status.children.length} total (uptime: ${Math.round(status.uptime / 1000)}s)`);
  }
}, 30_000); // Every 30 seconds

// ── Signal handlers ─────────────────────────────────────

/**
 * P2-26: Extract common shutdown logic to ensure PID file is always cleaned up.
 */
function handleShutdown(signal: string): void {
  daemonLog('INFO', `Received ${signal}, shutting down gracefully...`);
  supervisor.shutdown();
  // P2-26: Clean up PID file even on non-SIGKILL shutdown paths
  try {
    if (existsSync(PID_PATH)) {
      writeFileSync(PID_PATH, '');
    }
  } catch {
    // Best-effort
  }
  daemonLog('INFO', 'Daemon shut down');
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// ── Uncaught exception handler ──────────────────────────

process.on('uncaughtException', (err) => {
  daemonLog('ERROR', `Uncaught exception: ${err.message}\n${err.stack ?? ''}`);
  // Don't exit — try to stay alive
});

process.on('unhandledRejection', (reason) => {
  daemonLog('ERROR', `Unhandled rejection: ${String(reason)}`);
});

// ── Keep alive ──────────────────────────────────────────

daemonLog('INFO', 'Daemon ready, waiting for tasks...');
