/**
 * yu-agent — LSP verification & test runner utilities.
 *
 * Extracted from scheduler.ts for maintainability.
 * Provides LSP verification loop, project root detection,
 * shell command runner, and test framework auto-detection.
 */

import { createLogger } from './logger.js';
const log = createLogger('verifier');

import {
  spawnAgentWithTimeout,
  type AgentTask,
} from './executor.js';
import { trackAgent } from './tracker.js';
import { LspManager } from './lsp-manager.js';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';

// ── Constants ──────────────────────────────────────────

const MAX_RETRY_LSP = 2;

// ── LSP verification loop ──────────────────────────────

export async function verifyWithLsp(
  files: string[],
  _prevErrors: Record<string, unknown>[], // kept for backward compatibility
): Promise<{ ok: boolean; errors: Record<string, unknown>[] }> {
  // Track LSP verification start
  trackAgent('lsp-verify', 'running', {
    type: 'lsp',
    model: '',
    goal: `LSP verify ${files.length} files`,
    files,
  });

  // ── 1. Detect project's LSP server ──
  const root = findProjectRoot(files);
  const lspConfig = detectLspServer(root);

  if (!lspConfig) {
    // No LSP detected — warn and skip
    trackAgent('lsp-verify', 'completed');
    return { ok: true, errors: [] };
  }

  log.info(`Starting LSP server: ${lspConfig.name} (${lspConfig.command})`);

  // ── 2. Start LSP server ──
  const manager = new LspManager();
  try {
    await manager.start(lspConfig.name, lspConfig.command, lspConfig.args, root);

    // ── 3. Read real diagnostics ──
    let allErrors: Record<string, unknown>[] = [];
    for (const file of files) {
      const diagnostics = await manager.getDiagnostics(file);
      allErrors.push(...diagnostics);
    }

    if (allErrors.length === 0) {
      log.info('LSP: no errors found');
      trackAgent('lsp-verify', 'completed');
      return { ok: true, errors: [] };
    }

    // ── 4. Fix errors with coding agent (up to MAX_RETRY_LSP rounds) ──
    for (let round = 0; round < MAX_RETRY_LSP; round++) {
      log.info(`LSP: ${allErrors.length} errors found, fixing (round ${round + 1}/${MAX_RETRY_LSP})...`);

      const codingTask: AgentTask = {
        type: 'coding',
        model: 'v4-flash',
        id: 'lsp-fix',
        files,
        task: `修复以下 LSP error:\n${JSON.stringify(allErrors, null, 2)}`,
      };
      await spawnAgentWithTimeout(codingTask, { errors: allErrors });

      // Re-check diagnostics after fix
      const newErrors: Record<string, unknown>[] = [];
      for (const file of files) {
        const diagnostics = await manager.getDiagnostics(file);
        newErrors.push(...diagnostics);
      }

      if (newErrors.length === 0) {
        log.info('LSP: all errors fixed');
        trackAgent('lsp-verify', 'completed');
        return { ok: true, errors: [] };
      }

      allErrors = newErrors;
    }

    // ── 5. Unresolved errors after all retries ──
    const errorSummary = allErrors
      .slice(0, 10)
      .map((e) => `${(e as Record<string, unknown>).file || '?'}:${(e as Record<string, unknown>).line || '?'} — ${(e as Record<string, unknown>).error || '?'}`)
      .join('\n      ');
    log.warn(`LSP: ${allErrors.length} errors remaining after retries`, { errors: errorSummary });
    trackAgent('lsp-verify', 'failed', { error: `LSP errors remaining after retries: ${allErrors.length}` });
    return { ok: false, errors: allErrors };
  } finally {
    // ── 6. Stop LSP server ──
    await manager.stop();
  }
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
    log.warn(`Test command failed: ${msg}`);
    return false;
  }
}

// ── Project-aware toolchain detection ──────────────────

/**
 * Detect the LSP server for the project at the given root directory.
 * Returns the server name, command, and args, or null if none detected.
 *
 * Detection order:
 * 1. tsconfig.json → typescript-language-server
 * 2. pyproject.toml / requirements.txt → pyright-langserver
 * 3. go.mod → gopls
 * 4. Cargo.toml → rust-analyzer
 * 5. No detection → warn and return null
 */
export function detectLspServer(root: string): { name: string; command: string; args: string[] } | null {
  // 1. TypeScript
  if (existsSync(join(root, 'tsconfig.json'))) {
    return { name: 'typescript-language-server', command: 'typescript-language-server', args: ['--stdio'] };
  }

  // 2. Python
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) {
    return { name: 'pyright', command: 'pyright-langserver', args: ['--stdio'] };
  }

  // 3. Go
  if (existsSync(join(root, 'go.mod'))) {
    return { name: 'gopls', command: 'gopls', args: [] };
  }

  // 4. Rust
  if (existsSync(join(root, 'Cargo.toml'))) {
    return { name: 'rust-analyzer', command: 'rust-analyzer', args: [] };
  }

  // 5. No detection
  log.warn('Could not detect LSP server, skipping LSP verification');
  return null;
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
  log.info(`Project root: ${root}`);

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
        log.info('Detected vitest → npx vitest run --changed');
        return runCommand('npx', ['vitest', 'run', '--changed'], root);
      }
      if (deps.jest) {
        log.info('Detected jest → npx jest --findRelatedTests');
        return runCommand('npx', ['jest', '--findRelatedTests', ...files], root);
      }
      if (deps.mocha) {
        log.info('Detected mocha → npx mocha');
        return runCommand('npx', ['mocha', ...files], root);
      }
    } catch (e) {
      log.warn('Failed to parse package.json', e);
    }
  }

  // ── pyproject.toml ──
  const pyprojectPath = join(root, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      if (content.includes('pytest')) {
        if (existsSync(join(root, 'poetry.lock'))) {
          log.info('Detected pyproject.toml + poetry + pytest → poetry run pytest -x');
          return runCommand('poetry', ['run', 'pytest', '-x'], root);
        }
        if (existsSync(join(root, 'uv.lock'))) {
          log.info('Detected pyproject.toml + uv + pytest → uv run pytest -x');
          return runCommand('uv', ['run', 'pytest', '-x'], root);
        }
        log.info('Detected pyproject.toml + pytest → pytest -x');
        return runCommand('pytest', ['-x'], root);
      }
    } catch (e) {
      log.warn('Failed to read pyproject.toml', e);
    }
  }

  // ── requirements.txt ──
  const reqPath = join(root, 'requirements.txt');
  if (existsSync(reqPath)) {
    try {
      const content = readFileSync(reqPath, 'utf-8');
      if (content.includes('pytest')) {
        log.info('Detected requirements.txt + pytest → pytest -x');
        return runCommand('pytest', ['-x'], root);
      }
    } catch (e) {
      log.warn('Failed to read requirements.txt', e);
    }
  }

  // ── No detection ──
  log.warn('Could not detect test framework, skipping tests');
  return true;
}
