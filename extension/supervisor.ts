/**
 * yu-agent — Supervisor: child process lifecycle management.
 *
 * Manages forked child agent processes, health checks,
 * graceful shutdown, and status reporting.
 *
 * Phase 0: Basic structure with forking, heartbeat, and kill.
 * Phase 1+: IPC protocol, restart policy, event bus integration.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createLogger } from './logger.js';
import type { ChildProcessInfo, ChildSpawnConfig, SupervisorStatus, ChildStatus } from './types.js';

const log = createLogger('supervisor');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

/** Path to the forked child process entry point. */
const CHILD_ENTRY = resolve(PROJECT_ROOT, 'dist/extension/bg-worker.js');

/** Default spawning timeout (ms). */
const DEFAULT_SPAWN_TIMEOUT = 15_000;

/** Time to wait after SIGTERM before sending SIGKILL (ms). */
const SIGKILL_DELAY = 5_000;

export class Supervisor {
  /** TopicName → ChildProcessInfo (metadata / status). */
  readonly children = new Map<string, ChildProcessInfo>();
  /** TopicName → ChildProcess (OS handle). */
  private processes = new Map<string, ChildProcess>();
  private startTime = Date.now();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start the supervisor heartbeat loop.
   * Every 5 seconds, checks children liveness and updates statuses.
   */
  start(): void {
    log.info('Supervisor starting');
    this.startTime = Date.now();

    this.heartbeatTimer = setInterval(() => {
      this.checkChildren();
    }, 5_000);
  }

  /**
   * Fork a child process for the given topic.
   * The child process runs bg-worker.ts which imports and calls schedulerHandler.
   */
  spawnChild(topicName: string, config?: Partial<ChildSpawnConfig>): ChildProcess | undefined {
    const cfg: ChildSpawnConfig = {
      timeout: config?.timeout ?? DEFAULT_SPAWN_TIMEOUT,
      env: config?.env ?? {},
    };

    if (!existsSync(CHILD_ENTRY)) {
      log.error(`Child entry not found: ${CHILD_ENTRY}. Build the project first (npx tsc).`);
      return undefined;
    }

    const child = fork(CHILD_ENTRY, [`--topic-name=${topicName}`], {
      execArgv: ['--max-old-space-size=4096'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ...cfg.env,
        YU_CHILD_MODE: '1',
        YU_SESSION_TAG: `bg:${topicName}`,
      },
    });

    const info: ChildProcessInfo = {
      pid: child.pid ?? 0,
      topicName,
      status: 'spawning',
      startedAt: Date.now(),
    };

    this.children.set(topicName, info);
    this.processes.set(topicName, child);

    log.info(`Child forked for topic "${topicName}" (PID ${child.pid})`);

    // ── IPC message handler (Phase 1: full IPC protocol) ──
    child.on('message', (_msg: unknown) => {
      // Phase 1: handle child:ready, child:heartbeat, child:done, etc.
    });

    // ── Exit handler ──
    child.on('exit', (code, signal) => {
      const existing = this.children.get(topicName);
      if (existing) {
        if (signal) {
          existing.status = 'dead';
          log.warn(`Child "${topicName}" killed by signal ${signal}`);
        } else if (code !== null && code !== 0) {
          existing.status = 'dead';
          log.warn(`Child "${topicName}" exited with code ${code}`);
        } else {
          existing.status = 'stopped';
          log.info(`Child "${topicName}" exited cleanly (code=0)`);
        }
      }
      this.processes.delete(topicName);
    });

    // ── Spawning timeout: if child doesn't send 'child:ready' in time, kill ──
    setTimeout(() => {
      const current = this.children.get(topicName);
      if (current && current.status === 'spawning') {
        log.warn(`Child "${topicName}" spawning timed out after ${cfg.timeout}ms, killing`);
        current.status = 'spawn_failed';
        this.killChild(topicName);
      }
    }, cfg.timeout);

    return child;
  }

  /**
   * Gracefully kill a child process.
   * Sends SIGTERM first, then SIGKILL after 5 seconds if still alive.
   */
  killChild(topicName: string): void {
    const child = this.processes.get(topicName);
    if (!child) return;

    const info = this.children.get(topicName);
    if (info && info.status !== 'dead') {
      info.status = 'stopped';
    }

    log.info(`Killing child for topic "${topicName}" (PID ${child.pid})`);

    // SIGTERM — allow graceful shutdown
    try {
      child.kill('SIGTERM');
    } catch {
      // Process may already be dead
    }

    // Force SIGKILL after delay
    setTimeout(() => {
      try {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      } catch {
        // Already dead
      }
    }, SIGKILL_DELAY);
  }

  /**
   * Return a snapshot of the supervisor's current state.
   */
  getStatus(): SupervisorStatus {
    return {
      pid: process.pid,
      uptime: Date.now() - this.startTime,
      children: Array.from(this.children.values()),
      daemonVersion: '0.1.0',
    };
  }

  /**
   * Graceful shutdown: kill all children and stop heartbeat.
   */
  shutdown(): void {
    log.info('Supervisor shutting down');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const [topicName] of this.children) {
      this.killChild(topicName);
    }
  }

  // ── Private: periodic health check ────────────────────

  private checkChildren(): void {
    for (const [topicName, info] of this.children) {
      const child = this.processes.get(topicName);
      if (!child || child.killed) {
        info.status = 'dead';
        continue;
      }

      // If exitCode is set, process has exited
      if (child.exitCode !== null) {
        info.status = child.exitCode === 0 ? 'stopped' : 'dead';
      }
    }

    // Log status periodically (every 5th check ≈ every 25s)
    if (this.children.size > 0) {
      const alive = Array.from(this.children.values()).filter(
        c => c.status !== 'dead' && c.status !== 'stopped',
      ).length;
      log.debug(`Heartbeat: ${alive} alive / ${this.children.size} total children`);
    }
  }
}
