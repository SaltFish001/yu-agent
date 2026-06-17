/**
 * yu-agent — Checkpoint mechanism for phase-level recovery.
 *
 * Saves checkpoints before each important step (agent spawn, LSP verify,
 * commit) so that interrupted workflows can be detected and resumed later.
 *
 * Directory: ~/.yu/checkpoints/
 * Storage:   JSON files, one per checkpoint, named <timestamp>-<step>.json
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { YU_HOME } from './paths.js'

// ── Constants ──────────────────────────────────────────

const CHECKPOINT_DIR = resolve(YU_HOME, 'checkpoints')

/** Maximum age of a pending checkpoint before it's considered stale (24h). */
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000

// ── Types ──────────────────────────────────────────────

export interface Checkpoint {
  /** Unique checkpoint ID (timestamp-step). */
  id: string
  /** Step name: 'agent_spawn' | 'lsp_verify' | 'commit'. */
  step: 'agent_spawn' | 'lsp_verify' | 'commit'
  /** When the checkpoint was created. */
  timestamp: number
  /** Files involved in this step. */
  files: string[]
  /** 'pending' = not yet completed; 'completed' = done; 'abandoned' = user rejected. */
  status: 'pending' | 'completed' | 'abandoned'
  /** Optional extra metadata (e.g., agent type, task description). */
  metadata?: Record<string, unknown>
}

// ── Helpers ────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(CHECKPOINT_DIR)) {
    mkdirSync(CHECKPOINT_DIR, { recursive: true })
  }
}

function checkpointPath(id: string): string {
  return resolve(CHECKPOINT_DIR, `${id}.json`)
}

// ── Public API ─────────────────────────────────────────

/**
 * Create a new checkpoint before an important step.
 * Returns the checkpoint ID so callers can mark it complete later.
 */
export function saveCheckpoint(cp: Omit<Checkpoint, 'id'> & { id?: string }): string {
  ensureDir()
  const id = cp.id ?? `${Date.now()}-${cp.step}`
  const full: Checkpoint = { ...cp, id }
  writeFileSync(checkpointPath(id), JSON.stringify(full, null, 2), 'utf-8')
  return id
}

/**
 * Mark a checkpoint as completed.
 */
export function completeCheckpoint(id: string): void {
  const path = checkpointPath(id)
  if (!existsSync(path)) return
  try {
    const raw = readFileSync(path, 'utf-8')
    const cp = JSON.parse(raw) as Checkpoint
    cp.status = 'completed'
    writeFileSync(path, JSON.stringify(cp, null, 2), 'utf-8')
  } catch {
    // Best-effort
  }
}

/**
 * Remove a checkpoint file entirely (used for abandoned steps).
 */
export function removeCheckpoint(id: string): void {
  const path = checkpointPath(id)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Best-effort
  }
}

/**
 * List all pending (uncompleted) checkpoints, excluding stale ones (>24h).
 * Returns them sorted by timestamp (oldest first).
 */
export function listPendingCheckpoints(): Checkpoint[] {
  if (!existsSync(CHECKPOINT_DIR)) return []

  try {
    const files = readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith('.json'))
    const now = Date.now()
    const result: Checkpoint[] = []

    for (const file of files) {
      try {
        const raw = readFileSync(resolve(CHECKPOINT_DIR, file), 'utf-8')
        const cp = JSON.parse(raw) as Checkpoint
        if (cp.status === 'pending') {
          // Skip stale checkpoints
          if (now - cp.timestamp > MAX_PENDING_AGE_MS) continue
          result.push(cp)
        }
      } catch {
        // Skip unreadable files
      }
    }

    result.sort((a, b) => a.timestamp - b.timestamp)
    return result
  } catch {
    return []
  }
}

/**
 * Create a checkpoint and return a cleanup function that marks it completed.
 * Use with `finally` blocks for automatic cleanup.
 *
 * @example
 *   const done = checkpointGuard('lsp_verify', files, { task: 'fix lint' });
 *   try { ... } finally { done(); }
 */
export function checkpointGuard(
  step: Checkpoint['step'],
  files: string[],
  metadata?: Record<string, unknown>,
): () => void {
  const id = saveCheckpoint({ step, files, timestamp: Date.now(), status: 'pending', metadata })
  return () => {
    completeCheckpoint(id)
    removeCheckpoint(id) // Clean up completed checkpoints immediately
  }
}
