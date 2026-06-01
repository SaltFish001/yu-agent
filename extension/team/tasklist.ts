/**
 * yu-agent — Team mode: shared task board
 *
 * OMO-style task management with status transitions, claiming, and dependencies.
 * Files stored at ~/.yu/runtime/{teamRunId}/tasks/{id}.json
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { TaskSchema, type Task } from './types.js';
import { getTasksDir, resolveBaseDir } from './mailbox.js';

// ── Errors ─────────────────────────────────────────────

export class InvalidTaskTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

export class BlockedByError extends Error {
  constructor(taskId: string, blockedBy: string[]) {
    super(`Task ${taskId} blocked by incomplete tasks: ${blockedBy.join(', ')}`);
    this.name = 'BlockedByError';
  }
}

export class AlreadyClaimedError extends Error {
  constructor(taskId: string, owner: string) {
    super(`Task ${taskId} already claimed by ${owner}`);
    this.name = 'AlreadyClaimedError';
  }
}

// ── Allowed transitions ────────────────────────────────

const ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(['claimed']),
  claimed: new Set(['in_progress', 'pending']),
  in_progress: new Set(['completed', 'pending']),
  completed: new Set(['pending']),
  deleted: new Set([]),
};

function isValidTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

// ── Atomic write helper ────────────────────────────────

async function atomicWriteTask(filePath: string, task: Task): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(task, null, 2)}\n`, 'utf-8');
  await rename(tmp, filePath);
}

// ── Core operations ────────────────────────────────────

export async function createTask(
  teamRunId: string,
  input: {
    subject: string;
    description: string;
    blocks?: string[];
    blockedBy?: string[];
    metadata?: Record<string, unknown>;
  },
): Promise<Task> {
  const baseDir = resolveBaseDir();
  const tasksDir = getTasksDir(baseDir, teamRunId);
  await mkdir(tasksDir, { recursive: true, mode: 0o700 });

  const now = Date.now();
  const task: Task = {
    version: 1,
    id: `${randomUUID().slice(0, 8)}`,
    subject: input.subject,
    description: input.description,
    status: 'pending',
    blocks: input.blocks ?? [],
    blockedBy: input.blockedBy ?? [],
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now,
  };

  const validated = TaskSchema.parse(task);
  await atomicWriteTask(path.join(tasksDir, `${task.id}.json`), validated);
  return validated;
}

export async function getTask(teamRunId: string, taskId: string): Promise<Task | null> {
  const taskPath = path.join(getTasksDir(resolveBaseDir(), teamRunId), `${taskId}.json`);
  try {
    const content = await readFile(taskPath, 'utf-8');
    const parsed = TaskSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function listTasks(
  teamRunId: string,
  filter?: { status?: string; owner?: string },
): Promise<Task[]> {
  const tasksDir = getTasksDir(resolveBaseDir(), teamRunId);
  try {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    const tasks: Task[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const content = await readFile(path.join(tasksDir, entry.name), 'utf-8');
        const parsed = TaskSchema.safeParse(JSON.parse(content));
        if (parsed.success) tasks.push(parsed.data);
      } catch { /* skip malformed */ }
    }

    return tasks
      .filter((t) => {
        if (filter?.status && t.status !== filter.status) return false;
        if (filter?.owner && t.owner !== filter.owner) return false;
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function updateTaskStatus(
  teamRunId: string,
  taskId: string,
  newStatus: Task['status'],
  owner: string,
): Promise<Task> {
  const task = await getTask(teamRunId, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  // Special case: claiming requires transition check
  if (newStatus === 'claimed') {
    if (task.status === 'claimed' && task.owner === owner) return task; // idempotent
    if (task.status === 'claimed') throw new AlreadyClaimedError(taskId, task.owner!);
    if (task.status !== 'pending') throw new InvalidTaskTransitionError(task.status, newStatus);
  }

  if (!isValidTransition(task.status, newStatus)) {
    throw new InvalidTaskTransitionError(task.status, newStatus);
  }

  const updated: Task = {
    ...task,
    status: newStatus,
    owner: newStatus === 'claimed' || newStatus === 'in_progress' ? owner : task.owner,
    updatedAt: Date.now(),
    ...(newStatus === 'claimed' && !task.claimedAt ? { claimedAt: Date.now() } : {}),
  };

  const validated = TaskSchema.parse(updated);
  const taskPath = path.join(getTasksDir(resolveBaseDir(), teamRunId), `${taskId}.json`);
  await atomicWriteTask(taskPath, validated);
  return validated;
}

export async function claimTask(
  teamRunId: string,
  taskId: string,
  claimant: string,
): Promise<Task> {
  const task = await getTask(teamRunId, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  // Check blockedBy
  if (task.blockedBy.length > 0) {
    const blockers = await Promise.all(
      task.blockedBy.map((id) => getTask(teamRunId, id)),
    );
    const incomplete = blockers.filter(
      (t): t is Task => t !== null && t.status !== 'completed' && t.status !== 'deleted',
    );
    if (incomplete.length > 0) {
      throw new BlockedByError(taskId, incomplete.map((t) => t.id));
    }
  }

  if (task.status === 'claimed' && task.owner === claimant) {
    return task; // idempotent
  }

  if (task.status !== 'pending') {
    if (task.status === 'claimed') throw new AlreadyClaimedError(taskId, task.owner!);
    throw new InvalidTaskTransitionError(task.status, 'claimed');
  }

  return updateTaskStatus(teamRunId, taskId, 'claimed', claimant);
}

export async function deleteTask(teamRunId: string, taskId: string): Promise<void> {
  const task = await getTask(teamRunId, taskId);
  if (!task) return;
  if (task.status !== 'completed' && task.status !== 'deleted') {
    await updateTaskStatus(teamRunId, taskId, 'deleted', 'system');
  }
}
