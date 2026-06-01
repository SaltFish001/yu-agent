/**
 * yu-agent — LSP verification & test runner utilities.
 *
 * Extracted from scheduler.ts for maintainability.
 * Provides LSP verification loop, project root detection,
 * shell command runner, and test framework auto-detection.
 */

import {
  spawnAgentWithTimeout,
  runParallelGroup,
  type AgentTask,
} from './executor.js';
import { parseAgentOutput } from './template.js';
import type { LspOutput } from './template.js';
import { writeTeamStatus } from './status.js';
import { trackAgent } from './tracker.js';
import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, join, dirname } from 'path';

// ── Constants ──────────────────────────────────────────

const MAX_RETRY_LSP = 2;

// ── LSP verification loop ──────────────────────────────

export async function verifyWithLsp(
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
export function findProjectRoot(files: string[]): string {
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
export function runCommand(cmd: string, args: string[], cwd: string): boolean {
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
export async function runTests(files: string[]): Promise<boolean> {
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
