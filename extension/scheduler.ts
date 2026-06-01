/**
 * yu-agent — Scheduler: hook handler.
 *
 * The core handler registered on Pi's beforeChat hook.
 * Flow:
 *   1. Spawn scheduler sub-agent (LLM) for intent classification
 *   2. Parse JSON output → determine intent, agents, parallel groups
 *   3. If non-programming → pass through to Pi native agent
 *   4. If programming → spawn sub-agents in parallel groups, handle results
 *   5. LSP verification → test run → decisions → merge → return
 *
 * Status: writes runtime telemetry to ~/yu-agent/status/ for
 *         the standalone yu-agent monitor.
 */

import { spawnAgent, getAllPoolsStats, type SpawnConfig } from './spawn.js';
import type { SpawnResult } from './spawn.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch } from 'fs';
import { resolve, join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import type { SchedulerContext } from './types.js';
import { parseAgentOutput, parseSchedulerOutput } from './template.js';
import type {
  CodingOutput,
  ReviewOutput,
  LspOutput,
} from './template.js';
import {
  type AgentStatus,
  writeAgentStatus,
  writeTeamStatus,
  buildSummary,
  writeSnapshot,
  writeCacheStats,
} from './status.js';

// ── Constants ──────────────────────────────────────────

const DATA_DIR = resolve(homedir(), 'yu-agent', 'data');
const DECISIONS_FILE = resolve(DATA_DIR, 'decisions.json');
const TEMP_DIR = resolve(DATA_DIR, 'temp');
const MAX_CONCURRENCY = 4;
const MAX_RETRY_SCHEDULER = 2;
const MAX_RETRY_LSP = 2;
const MAX_RETRY_TEAM = 2;
const AGENT_TIMEOUT_MS = 120_000;
const TEAM_FILE_TIMEOUT_MS = 120_000;

// ── In-memory agent tracker ────────────────────────────
// Tracks all spawned agents in the current invocation.
// Reset on each handler call.

const _agentTrackers: Map<string, AgentStatus> = new Map();
let _handlerStartTime = 0;

function resetTracker(): void {
  _agentTrackers.clear();
  _handlerStartTime = Date.now();
}

function trackAgent(id: string, status: AgentStatus['status'], extra?: Record<string, unknown>): void {
  const existing = _agentTrackers.get(id);
  const entry: AgentStatus = {
    id,
    type: (extra?.type as string) || existing?.type || 'unknown',
    model: (extra?.model as string) || '',
    status,
    goal: (extra?.goal as string) || existing?.goal,
    files: (extra?.files as string[]) || existing?.files,
    startedAt: existing?.startedAt,
    durationMs: existing?.durationMs,
    error: (extra?.error as string) || existing?.error,
  };
  // Apply runtime computed fields
  if (status === 'running' && !entry.startedAt) {
    entry.startedAt = Date.now();
  }
  if ((status === 'completed' || status === 'failed' || status === 'interrupted') && entry.startedAt) {
    entry.durationMs = Date.now() - entry.startedAt;
  }
  _agentTrackers.set(id, entry);

  // Flush to disk
  writeAgentStatus(Array.from(_agentTrackers.values()));
}

function getAgentStatusList(): AgentStatus[] {
  return Array.from(_agentTrackers.values());
}

function flushFinalStatus(): void {
  const agents = getAgentStatusList();
  const summary = buildSummary(agents);
  writeSnapshot({
    updatedAt: Date.now(),
    agents,
    mcp: [],
    lsp: [],
    team: null,
    summary,
  });
  // Record cache hit/miss stats for external monitoring
  const cacheStats = getAllPoolsStats();
  writeCacheStats({
    updatedAt: Date.now(),
    totalHits: cacheStats.totalHits,
    totalMisses: cacheStats.totalMisses,
    totalCost: cacheStats.totalCost,
    turnCount: cacheStats.turnCount,
    hitRate: cacheStats.hitRate,
  });
}

// ── Types ──────────────────────────────────────────────

interface SchedulerPlan {
  pass_through?: boolean;
  reasoning?: string;
  intent?: string;
  agents?: { type: string; model: string; id: string; files?: string[]; task?: string }[];
  parallel_groups?: string[][];
  dependencies?: Record<string, string[]>;
}

interface AgentTask {
  type: string;
  model: string;
  id: string;
  files?: string[];
  task: string;
}

// ── Decisions ──────────────────────────────────────────

function loadDecisions(): Record<string, unknown> {
  if (existsSync(DECISIONS_FILE)) {
    try {
      return JSON.parse(readFileSync(DECISIONS_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

const MAX_DECISIONS = 50;

function saveDecision(key: string, value: unknown): void {
  const decisions = loadDecisions();
  decisions[key] = value;

  // Keep only the most recent MAX_DECISIONS entries
  const entries = Object.entries(decisions)
    .sort(([a], [b]) => b.localeCompare(a)) // timestamp-prefixed keys → newest first
    .slice(0, MAX_DECISIONS);

  const trimmed = Object.fromEntries(entries);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DECISIONS_FILE, JSON.stringify(trimmed, null, 2));
}

// ── Scheduler agent call ───────────────────────────────

async function classifyIntent(userInput: string, context: Record<string, unknown>): Promise<SchedulerPlan> {
  // Track the scheduler agent itself
  trackAgent('scheduler', 'running', {
    type: 'scheduler',
    model: 'v4-flash',
    goal: 'classify intent & generate plan',
  });

  for (let attempt = 0; attempt <= MAX_RETRY_SCHEDULER; attempt++) {
    try {
      const result = await spawnAgent({
        type: 'general-purpose',
        model: 'v4-flash',
        thinking: 'max',
        maxTurns: 3,
        task: userInput,
        context: { ...context, decisions: loadDecisions(), prompt_type: 'scheduler' },
        timeout: AGENT_TIMEOUT_MS,
      });

      const plan = parseSchedulerOutput(result.response);
      if (plan && (plan.pass_through !== undefined || (plan.intent && plan.agents))) {
        trackAgent('scheduler', 'completed');
        return plan;
      }

      console.log(`[yu-agent] ── Scheduler raw output (attempt ${attempt + 1}) ──`);
      console.log(result.response);
      console.log(`[yu-agent] ── End scheduler raw output ──`);
      console.warn(`[yu-agent] Scheduler output invalid (attempt ${attempt + 1}), retrying...`);
    } catch (err) {
      console.warn(`[yu-agent] Scheduler spawn failed (attempt ${attempt + 1}):`, err);
    }
  }

  trackAgent('scheduler', 'failed', { error: 'all retries exhausted' });
  return { pass_through: true, reasoning: 'scheduler failed, falling back to Pi native' };
}

// ── Sub-agent spawn helpers ────────────────────────────

async function spawnAgentWithTimeout(
  task: AgentTask,
  extraContext: Record<string, unknown>,
): Promise<SpawnResult> {
  trackAgent(task.id, 'running', {
    type: task.type,
    model: task.model,
    goal: task.task?.slice(0, 120) ?? '',
    files: task.files,
  });

  try {
    const config: SpawnConfig = {
      type: task.type,
      model: task.model,
      thinking: 'max',
      maxTurns: 50,
      task: task.task || (task.files?.join(', ') || ''),
      files: task.files,
      context: extraContext,
      timeout: AGENT_TIMEOUT_MS,
      teamRunId: extraContext.teamRunId as string | undefined,
      memberName: extraContext.memberName as string | undefined,
    };
    const result = await spawnAgent(config);
    trackAgent(task.id, 'completed');
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trackAgent(task.id, 'failed', { error: msg });
    throw err;
  }
}

/**
 * Run tasks with a concurrency limit. At most `limit` tasks execute
 * simultaneously. Returns PromiseSettledResult array (same shape as
 * Promise.allSettled) so callers can handle individual failures.
 */
async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      try {
        const value = await tasks[i]();
        results[i] = { status: 'fulfilled' as const, value };
      } catch (reason) {
        results[i] = { status: 'rejected' as const, reason };
      }
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runParallelGroup(
  group: string[],
  agentMap: Map<string, AgentTask>,
  context: Record<string, unknown>,
): Promise<Map<string, SpawnResult>> {
  const taskFactories = group.map((id) => {
    const task = agentMap.get(id);
    if (!task) throw new Error(`Unknown agent id: ${id}`);
    return () => spawnAgentWithTimeout(task, context).then((r) => [id, r] as const);
  });

  const results = await runWithConcurrencyLimit(taskFactories, MAX_CONCURRENCY);
  const resultMap = new Map<string, SpawnResult>();

  for (const result of results) {
    if (result.status === 'fulfilled') {
      resultMap.set(result.value[0], result.value[1]);
    } else {
      console.warn('[yu-agent] Agent failed:', result.reason);
    }
  }

  return resultMap;
}

// ── LSP verification loop ──────────────────────────────

async function verifyWithLsp(
  files: string[],
  prevErrors: Record<string, unknown>[],
): Promise<{ ok: boolean; errors: Record<string, unknown>[] }> {
  // Track LSP verification start
  trackAgent('lsp-verify', 'running', {
    type: 'lsp',
    model: 'v4-flash',
    goal: `LSP verify ${files.length} files`,
    files,
  });

  let allErrors: Record<string, unknown>[] = [];

  for (let round = 0; round < MAX_RETRY_LSP; round++) {
    const lspTasks = files.map((f) => ({
      type: 'lsp' as const,
      model: 'v4-flash' as const,
      id: `lsp-${f.replace(/[^a-zA-Z0-9]/g, '-')}`,
      files: [f],
      task: `检查并修复 ${f} 的类型错误`,
    }));

    const agentMap = new Map(lspTasks.map((t) => [t.id, t]));
    const results = await runParallelGroup(
      lspTasks.map((t) => t.id),
      agentMap,
      { errors: prevErrors },
    );

    allErrors = [];
    for (const [, result] of results) {
      const output = parseAgentOutput(result?.response || '');
      if (output && 'errors_remaining' in output && Array.isArray((output as LspOutput).errors_remaining)) {
        const remaining = (output as LspOutput).errors_remaining.filter(
          (e) => e.level !== 'warning',
        );
        allErrors.push(...remaining);
      }
    }

    if (allErrors.length === 0) {
      trackAgent('lsp-verify', 'completed');
      return { ok: true, errors: [] };
    }

    if (round < MAX_RETRY_LSP - 1) {
      const codingTask: AgentTask = {
        type: 'coding',
        model: 'v4-flash',
        id: 'lsp-fix',
        files,
        task: `修复以下 LSP error:\n${JSON.stringify(allErrors, null, 2)}`,
      };
      await spawnAgentWithTimeout(codingTask, { errors: allErrors });
    }
  }

  trackAgent('lsp-verify', 'failed', { error: `LSP errors remaining after retries: ${allErrors.length}` });
  return { ok: false, errors: allErrors };
}

// ── Test runner ────────────────────────────────────────

/**
 * Find the project root directory by walking up from the first file's
 * directory looking for known config files (package.json, pyproject.toml,
 * requirements.txt). Falls back to process.cwd().
 */
function findProjectRoot(files: string[]): string {
  let dir: string;
  if (files.length > 0) {
    dir = resolve(files[0]);
    // If it's a file (has extension), use its parent directory
    if (/\.\w+$/.test(dir)) {
      dir = dirname(dir);
    }
  } else {
    dir = process.cwd();
  }

  const markers = ['package.json', 'pyproject.toml', 'requirements.txt'];

  for (let i = 0; i < 5; i++) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return process.cwd();
}

/**
 * Run a shell command synchronously and return true on zero exit code.
 * Output is inherited from the parent process (visible to the user).
 */
function runCommand(cmd: string, args: string[], cwd: string): boolean {
  try {
    const result = spawnSync(cmd, args, {
      cwd,
      stdio: 'inherit',
      timeout: 120_000,
      shell: false,
    });
    return result.status === 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[yu-agent] Test command failed: ${msg}`);
    return false;
  }
}

/**
 * Auto-detect the project's test framework and run the appropriate test
 * command. Returns true if tests pass or no framework is detected, false
 * if tests fail.
 *
 * Detection order:
 * 1. package.json + vitest → npx vitest run --changed
 * 2. package.json + jest   → npx jest --findRelatedTests <files>
 * 3. package.json + mocha  → npx mocha <files>
 * 4. pyproject.toml + pytest → poetry run pytest -x / uv run pytest -x
 * 5. requirements.txt + pytest → pytest -x
 * 6. No detection → skip with warning
 */
async function runTests(files: string[]): Promise<boolean> {
  const root = findProjectRoot(files);
  console.log(`[yu-agent] Project root: ${root}`);

  // ── package.json ──
  const pkgJsonPath = join(root, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      const deps: Record<string, string> = {
        ...(pkg.devDependencies as Record<string, string> | undefined ?? {}),
        ...(pkg.dependencies as Record<string, string> | undefined ?? {}),
      };

      if (deps.vitest) {
        console.log('[yu-agent] Detected vitest → npx vitest run --changed');
        return runCommand('npx', ['vitest', 'run', '--changed'], root);
      }
      if (deps.jest) {
        console.log('[yu-agent] Detected jest → npx jest --findRelatedTests');
        return runCommand('npx', ['jest', '--findRelatedTests', ...files], root);
      }
      if (deps.mocha) {
        console.log('[yu-agent] Detected mocha → npx mocha');
        return runCommand('npx', ['mocha', ...files], root);
      }
    } catch (e) {
      console.warn('[yu-agent] Failed to parse package.json:', e);
    }
  }

  // ── pyproject.toml ──
  const pyprojectPath = join(root, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      if (content.includes('pytest')) {
        if (existsSync(join(root, 'poetry.lock'))) {
          console.log('[yu-agent] Detected pyproject.toml + poetry + pytest → poetry run pytest -x');
          return runCommand('poetry', ['run', 'pytest', '-x'], root);
        }
        if (existsSync(join(root, 'uv.lock'))) {
          console.log('[yu-agent] Detected pyproject.toml + uv + pytest → uv run pytest -x');
          return runCommand('uv', ['run', 'pytest', '-x'], root);
        }
        console.log('[yu-agent] Detected pyproject.toml + pytest → pytest -x');
        return runCommand('pytest', ['-x'], root);
      }
    } catch (e) {
      console.warn('[yu-agent] Failed to read pyproject.toml:', e);
    }
  }

  // ── requirements.txt ──
  const reqPath = join(root, 'requirements.txt');
  if (existsSync(reqPath)) {
    try {
      const content = readFileSync(reqPath, 'utf-8');
      if (content.includes('pytest')) {
        console.log('[yu-agent] Detected requirements.txt + pytest → pytest -x');
        return runCommand('pytest', ['-x'], root);
      }
    } catch (e) {
      console.warn('[yu-agent] Failed to read requirements.txt:', e);
    }
  }

  // ── No detection ──
  console.warn('[yu-agent] Could not detect test framework, skipping tests');
  return true;
}

// ── Team mode orchestrator ─────────────────────────────

async function runTeamMode(
  plan: SchedulerPlan,
  context: Record<string, unknown>,
): Promise<string> {
  const taskId = `team-${Date.now()}`;
  const sharedDir = resolve(TEMP_DIR, taskId);
  mkdirSync(sharedDir, { recursive: true });

  const planFile = resolve(sharedDir, 'plan.md');

  // Track team mode
  writeTeamStatus({
    active: true,
    mode: 'architect-searcher',
    members: [
      { role: 'architect', status: 'running', model: 'v4-pro' },
      { role: 'searcher', status: 'running', model: 'v4-flash' },
    ],
    currentPhase: 'research',
    sharedDir,
  });

  // Phase 1: Architect + Searcher in parallel
  const architectTask: AgentTask = {
    type: 'plan',
    model: 'v4-pro',
    id: 'team-architect',
    task: `分析现有代码结构并出方案。将方案写入 ${planFile}`,
  };
  const searcherTask: AgentTask = {
    type: 'search',
    model: 'v4-flash',
    id: 'team-searcher',
    task: `搜索相关信息。结果写入 ${resolve(sharedDir, 'context.md')}`,
  };

  const agentMap = new Map<string, AgentTask>([
    ['team-architect', architectTask],
    ['team-searcher', searcherTask],
  ]);

  await runParallelGroup(['team-architect', 'team-searcher'], agentMap, {
    ...context,
    shared_dir: sharedDir,
  });

  // Wait for plan.md with fs.watch timeout
  if (!existsSync(planFile)) {
    await new Promise<void>((resolveTimeout, reject) => {
      const watcher = watch(sharedDir, (eventType, filename) => {
        if (filename === 'plan.md' && existsSync(planFile)) {
          watcher.close();
          resolveTimeout();
        }
      });
      setTimeout(() => {
        watcher.close();
        reject(new Error('Timeout waiting for plan.md'));
      }, TEAM_FILE_TIMEOUT_MS);
    });
  }

  writeTeamStatus({
    active: true,
    mode: 'coder-reviewer',
    members: [
      { role: 'architect', status: 'completed' },
      { role: 'searcher', status: 'completed' },
      { role: 'coder', status: 'waiting' },
      { role: 'reviewer', status: 'waiting' },
    ],
    currentPhase: 'plan-ready',
    sharedDir,
  });

  // Phase 2: Read plan, spawn Coder(s)
  const planContent = readFileSync(planFile, 'utf-8');

  // Parse modules from plan (JSON in markdown code block) or fallback to headings
  const planOutput = parseAgentOutput(planContent);
  let modules: { name: string; files: string[]; independent: boolean }[] = [];

  if (planOutput && 'modules' in planOutput && Array.isArray((planOutput as unknown as Record<string, unknown>).modules)) {
    modules = (planOutput as unknown as { modules: typeof modules }).modules;
  }
  if (modules.length === 0) {
    // Fallback: extract modules from markdown headings (## Module Name)
    const headingRegex = /^##\s+(.+)/gm;
    let match;
    while ((match = headingRegex.exec(planContent)) !== null) {
      modules.push({ name: match[1].trim(), files: [], independent: true });
    }
  }
  if (modules.length === 0) {
    // Last resort: treat the entire plan as a single module
    modules = [{ name: 'default', files: [], independent: true }];
  }

  // Load context.md if generated by searcher
  const contextMdPath = resolve(sharedDir, 'context.md');
  const contextMd = existsSync(contextMdPath) ? readFileSync(contextMdPath, 'utf-8') : '';

  // Update status: Phase 2 — Coding
  writeTeamStatus({
    active: true,
    mode: 'coder-reviewer',
    members: [
      { role: 'architect', status: 'completed' },
      { role: 'searcher', status: 'completed' },
      ...modules.map(() => ({ role: 'coder', status: 'running' as const, model: 'v4-flash' })),
      ...modules.map(() => ({ role: 'reviewer', status: 'waiting' as const })),
    ],
    currentPhase: 'coding',
    sharedDir,
  });

  // Create one Coder task per module and run in parallel
  const coderTasks: AgentTask[] = modules.map((mod, i) => ({
    type: 'coding',
    model: 'v4-flash',
    id: `team-coder-${i}`,
    task: `实现模块: ${mod.name}。遵循 plan.md 的方案。\n\n模块文件: ${(mod.files || []).join(', ')}\n\n约束: 只实现本模块 ${mod.name} 的内容，不要改其他模块的代码。`,
    files: mod.files.length > 0 ? mod.files : undefined,
  }));

  const coderAgentMap = new Map(coderTasks.map((t) => [t.id, t]));
  await runParallelGroup(
    coderTasks.map((t) => t.id),
    coderAgentMap,
    { ...context, shared_dir: sharedDir, plan_content: planContent, context_md: contextMd },
  );

  // Phase 3: Reviewers — up to 2 rounds of review cycles
  const MAX_REVIEW_ROUNDS = 2;
  let allApproved = false;

  for (let round = 0; round < MAX_REVIEW_ROUNDS && !allApproved; round++) {
    writeTeamStatus({
      active: true,
      mode: 'coder-reviewer',
      members: [
        { role: 'architect', status: 'completed' },
        { role: 'searcher', status: 'completed' },
        ...modules.map(() => ({ role: 'coder', status: 'completed' as const })),
        ...modules.map(() => ({ role: 'reviewer', status: 'running' as const })),
      ],
      currentPhase: `review-round-${round + 1}`,
      sharedDir,
    });

    // Create one Reviewer task per module
    const reviewerTasks: AgentTask[] = modules.map((mod, i) => ({
      type: 'review',
      model: 'v4-flash',
      id: `team-reviewer-${i}-r${round}`,
      task: `审查模块 "${mod.name}" 的代码实现。\n模块文件: ${mod.files.join(', ')}\n\n根据 plan.md 的方案评估实现质量。返回 approved 或 changes_requested。如果 changes_requested，请列出具体问题。`,
      files: mod.files.length > 0 ? mod.files : undefined,
    }));

    const reviewerAgentMap = new Map(reviewerTasks.map((t) => [t.id, t]));
    const reviewerResults = await runParallelGroup(
      reviewerTasks.map((t) => t.id),
      reviewerAgentMap,
      { ...context, shared_dir: sharedDir, plan_content: planContent },
    );

    // Check if any reviewer requested changes
    const changesDetails: string[] = [];
    for (const [, result] of reviewerResults) {
      const output = parseAgentOutput(result?.response || '');
      if (output && 'status' in output && (output as ReviewOutput).status === 'changes_requested') {
        changesDetails.push(JSON.stringify((output as ReviewOutput).findings || []));
      }
    }

    if (changesDetails.length === 0) {
      allApproved = true;
      console.log(`[yu-agent] Review round ${round + 1}: all approved`);
      break;
    }

    // Changes requested — cycle back to Coders (if not the last round)
    if (round < MAX_REVIEW_ROUNDS - 1) {
      console.log(`[yu-agent] Review round ${round + 1}: changes requested, cycling back to Coders`);
      const coderRetryTasks: AgentTask[] = modules.map((mod, i) => ({
        type: 'coding',
        model: 'v4-flash',
        id: `team-coder-${i}-fix-r${round}`,
        task: `根据 review 反馈修复模块 "${mod.name}" 的问题。\n\nReview 反馈:\n${changesDetails.join('\n---\n')}\n\n只修复列出的问题，不要改动其他代码。`,
        files: mod.files.length > 0 ? mod.files : undefined,
      }));

      const coderRetryAgentMap = new Map(coderRetryTasks.map((t) => [t.id, t]));
      await runParallelGroup(
        coderRetryTasks.map((t) => t.id),
        coderRetryAgentMap,
        { ...context, shared_dir: sharedDir, plan_content: planContent, review_feedback: changesDetails },
      );
    }
  }

  // Phase 4: Conflict detection via git diff
  writeTeamStatus({
    active: true,
    mode: 'conflict-detection',
    members: [
      { role: 'architect', status: 'completed' },
      { role: 'searcher', status: 'completed' },
      ...modules.map(() => ({ role: 'coder', status: 'completed' as const })),
      ...modules.map(() => ({ role: 'reviewer', status: 'completed' as const })),
    ],
    currentPhase: 'conflict-detection',
    sharedDir,
  });

  const conflictedFiles: string[] = [];
  try {
    const gitDiff = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { encoding: 'utf-8', timeout: 10_000 });
    if ((gitDiff.stdout || '').toString().trim()) {
      conflictedFiles.push(...(gitDiff.stdout || '').toString().trim().split('\n').filter(Boolean));
    }
  } catch {
    console.warn('[yu-agent] Git conflict detection skipped (not a git repo or git unavailable)');
  }

  if (conflictedFiles.length > 0) {
    console.warn(`[yu-agent] Conflicts detected in files: ${conflictedFiles.join(', ')}`);
  } else {
    console.log('[yu-agent] No merge conflicts detected');
  }

  // Final status
  writeTeamStatus({
    active: false,
    currentPhase: 'complete',
  });

  return `Team mode complete (${taskId})${conflictedFiles.length > 0 ? `. Conflicts in: ${conflictedFiles.join(', ')}` : ''}`;
}

// ── Main handler ───────────────────────────────────────

export async function handler(
  userInput: string,
  sessionContext: Record<string, unknown> | SchedulerContext,
): Promise<string | null> {
  // Initialize tracker for this invocation
  resetTracker();

  // Step 1: Classify intent via scheduler agent
  const plan = await classifyIntent(userInput, sessionContext as Record<string, unknown>);

  // ── Pass-through: hand off to Pi native agent ──
  if (plan.pass_through) {
    trackAgent('pi-native', 'running', {
      type: 'pi-default',
      model: '',
      goal: `处理: ${userInput.slice(0, 100)}`,
    });
    trackAgent('pi-native', 'completed');
    flushFinalStatus();
    return null;
  }

  // ── Team mode: multi-agent orchestration ──
  if (plan.intent === 'team') {
    try {
      const result = await runTeamMode(plan, sessionContext as Record<string, unknown>);
      return result;
    } finally {
      flushFinalStatus();
    }
  }

  // ── Multi-agent execution ──
  try {
    // Step 2: Build agent map
    const agentTasks = (plan.agents || []).map((a) => ({
      type: a.type,
      model: a.model,
      id: a.id,
      files: a.files,
      task: userInput,
    }));
    const agentMap = new Map(agentTasks.map((t) => [t.id, t]));

    // Step 3: Execute parallel groups in order
    let allResults = new Map<string, SpawnResult>();
    const groups = plan.parallel_groups || agentTasks.map((t) => [t.id]);

    const context = { decisions: loadDecisions() };

    for (const group of groups) {
      const groupResults = await runParallelGroup(group, agentMap, context);
      for (const [id, result] of groupResults) {
        allResults.set(id, result);
      }
    }

    // Step 4: Collect modified files
    const modifiedFiles: string[] = [];
    for (const [, result] of allResults) {
      const output = parseAgentOutput(result?.response || '');
      if (output && 'files_modified' in output && Array.isArray((output as CodingOutput).files_modified)) {
        modifiedFiles.push(...(output as CodingOutput).files_modified);
      }
    }

    // Step 5: LSP verification
    let lspOk = true;
    if (modifiedFiles.length > 0) {
      const lspResult = await verifyWithLsp(modifiedFiles, []);
      if (!lspResult.ok) {
        lspOk = false;
        const errorSummary = lspResult.errors
          .slice(0, 10)
          .map((e) => `${(e as Record<string, unknown>).file || '?'}:${(e as Record<string, unknown>).line || '?'} — ${(e as Record<string, unknown>).error || '?'}`)
          .join('\n      ');
        console.warn(`[yu-agent] LSP verification failed with ${lspResult.errors.length} remaining errors:\n      ${errorSummary}`);
      }
    }

    // Step 6: Run tests (skip if LSP has errors — tests will likely fail anyway)
    if (modifiedFiles.length > 0 && lspOk) {
      await runTests(modifiedFiles);
    } else if (modifiedFiles.length > 0 && !lspOk) {
      console.warn('[yu-agent] Skipping tests due to unresolved LSP errors');
    }

    // Step 7: Save decision
    if (plan.intent) {
      saveDecision(`${Date.now()}-${plan.intent}`, {
        intent: plan.intent,
        agents: plan.agents,
        files: modifiedFiles,
      });
    }

    // Step 8: Aggregate and return
    const summaries: string[] = [];
    for (const [, result] of allResults) {
      const output = parseAgentOutput(result?.response || '');
      if (output && 'summary' in output) {
        summaries.push((output as CodingOutput).summary);
      }
    }

    return summaries.join('\n') || JSON.stringify(Object.fromEntries(allResults));
  } finally {
    flushFinalStatus();
  }
}
