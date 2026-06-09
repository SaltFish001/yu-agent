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

// Override console.log/error to go to the log file
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

console.log = (...args: unknown[]) => {
  writeLog('INFO', args.map(String).join(' '));
};
console.error = (...args: unknown[]) => {
  writeLog('ERROR', args.map(String).join(' '));
};
console.warn = (...args: unknown[]) => {
  writeLog('WARN', args.map(String).join(' '));
};

// Also redirect actual stdout/stderr for any code that uses process.stdout.write
const logStream = appendFileSync.bind(null, LOG_FILE, 'utf-8') as unknown as (chunk: string) => void;

// We can't easily override process.stdout.write without breaking things,
// so console overrides above are the primary mechanism.

// ── Write PID file ──────────────────────────────────────

try {
  writeFileSync(PID_PATH, String(process.pid) + '\n');
  console.log(`Daemon started (PID ${process.pid})`);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Failed to write PID file: ${msg}`);
  process.exit(1);
}

// ── Initialize Supervisor ───────────────────────────────

const supervisor = new Supervisor();
supervisor.start();
console.log('Supervisor initialized');

// ── Scan for existing background topics ─────────────────

async function pickupBackgroundTasks(): Promise<void> {
  try {
    const { list } = await import('./topic.js');
    const topics = list(false);
    const bgTopics = topics.filter(t => t.status === 'background');

    if (bgTopics.length === 0) {
      console.log('No pending background tasks found');
      return;
    }

    console.log(`Found ${bgTopics.length} pending background task(s)`);

    for (const topic of bgTopics) {
      console.log(`Picking up task for topic "${topic.name}": ${topic.summary.substring(0, 100)}`);

      const config: Partial<ChildSpawnConfig> = {
        timeout: 15_000,
        env: {
          YU_DAEMON_PID: String(process.pid),
        },
      };

      const child = supervisor.spawnChild(topic.name, config);
      if (child) {
        console.log(`Forked child for "${topic.name}" (PID ${child.pid})`);
      } else {
        console.error(`Failed to fork child for "${topic.name}"`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error picking up background tasks: ${msg}`);
  }
}

// ── Run pickup ──────────────────────────────────────────

pickupBackgroundTasks().catch(err => {
  console.error('Fatal error during task pickup:', String(err));
});

// ── Status reporting interval ───────────────────────────

setInterval(() => {
  const status = supervisor.getStatus();
  const alive = status.children.filter(c => 
    c.status !== 'dead' && c.status !== 'stopped' && c.status !== 'spawn_failed',
  );
  if (status.children.length > 0) {
    console.log(`Status: ${alive.length} running / ${status.children.length} total (uptime: ${Math.round(status.uptime / 1000)}s)`);
  }
}, 30_000); // Every 30 seconds

// ── Signal handlers ─────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  supervisor.shutdown();
  try {
    if (existsSync(PID_PATH)) {
      writeFileSync(PID_PATH, '');
    }
  } catch {
    // Best-effort
  }
  console.log('Daemon shut down');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  supervisor.shutdown();
  try {
    if (existsSync(PID_PATH)) {
      writeFileSync(PID_PATH, '');
    }
  } catch {
    // Best-effort
  }
  process.exit(0);
});

// ── Uncaught exception handler ──────────────────────────

process.on('uncaughtException', (err) => {
  console.error(`Uncaught exception: ${err.message}\n${err.stack ?? ''}`);
  // Don't exit — try to stay alive
});

process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled rejection: ${String(reason)}`);
});

// ── Keep alive ──────────────────────────────────────────

console.log('Daemon ready, waiting for tasks...');
