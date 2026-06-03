/**
 * yu-agent — Sandbox execution (Phase 3).
 *
 * Provides an isolated bash execution environment.
 * Uses Docker when available, falls back to local execution with a warning.
 *
 * Docker mode:
 *   - image: node:24-slim
 *   - timeout: 60s
 *   - memory: 512MB
 *   - runs `bash -c <command>` inside a disposable container
 *
 * Local fallback:
 *   - runs `bash -c <command>` directly
 *   - prints a warning about reduced isolation
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';

// ── Constants ──────────────────────────────────────────

const SANDBOX_IMAGE = 'node:24-slim';
const SANDBOX_TIMEOUT_MS = 60_000;
const SANDBOX_MEMORY_LIMIT = '512m';

// ── Docker detection ───────────────────────────────────

/** Whether Docker is available on the system. */
let _dockerChecked = false;
let _dockerAvailable = false;

function isDockerAvailable(): boolean {
  if (_dockerChecked) return _dockerAvailable;
  _dockerChecked = true;
  try {
    execSync('docker info --format "{{.ServerVersion}}"', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

// ── Sandbox execution ──────────────────────────────────

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  mode: 'docker' | 'local';
}

/**
 * Run a command inside the sandbox.
 *
 * @param command  Shell command to execute
 * @param options  Optional overrides
 * @returns        SandboxResult with stdout, stderr, exit code, timing, mode
 */
export function runInSandbox(
  command: string,
  options?: {
    /** Working directory (only used in local fallback; Docker always uses /workspace). */
    cwd?: string;
    /** Timeout in ms (default 60000). */
    timeout?: number;
    /** Memory limit for Docker container (default '512m'). */
    memory?: string;
    /** Force local execution even if Docker is available. */
    forceLocal?: boolean;
    /** Additional Docker run arguments (as array). */
    dockerArgs?: string[];
  },
): SandboxResult {
  const timeout = options?.timeout ?? SANDBOX_TIMEOUT_MS;
  const forceLocal = options?.forceLocal ?? false;
  const useDocker = !forceLocal && isDockerAvailable();

  const startTime = Date.now();
  let exitCode = 0;
  let stdout = '';
  let stderr = '';

  if (useDocker) {
    // ── Docker execution ──
    const cwd = options?.cwd || process.cwd();
    const memory = options?.memory ?? SANDBOX_MEMORY_LIMIT;

    // Build docker run args
    const dockerArgs = [
      'run',
      '--rm',
      '-i', // interactive (stdin)
      '--memory', memory,
      '--memory-swap', memory, // no swap
      '--network', 'none', // no network for security
      '--read-only', // read-only filesystem
      '--tmpfs', '/tmp:noexec,nosuid,size=64m',
      '--workdir', '/workspace',
      '--mount', `type=bind,source=${cwd},target=/workspace,readonly`,
      ...(options?.dockerArgs ?? []),
      SANDBOX_IMAGE,
      'bash', '-c', command,
    ];

    try {
      const result = execSync('docker ' + dockerArgs.map(escapeArg).join(' '), {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      stdout = result;
    } catch (e: unknown) {
      const err = e as {
        stdout?: string;
        stderr?: string;
        status?: number;
        message?: string;
      };
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
      exitCode = err.status ?? 1;
    }

    const durationMs = Date.now() - startTime;
    return { stdout, stderr, exitCode, durationMs, mode: 'docker' };
  }

  // ── Local fallback ──
  console.warn(
    '[yu-agent] ⚠ Docker 不可用，使用本地执行（无隔离）。' +
      ' 安装 Docker 以获得沙箱隔离: https://docs.docker.com/engine/install/',
  );

  const execOptions: ExecSyncOptions = {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    cwd: options?.cwd,
    shell: 'bash',
  };

  try {
    const result = execSync(command, execOptions);
    stdout = typeof result === 'string' ? result : result?.toString() ?? '';
  } catch (e: unknown) {
    const err = e as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number;
      message?: string;
    };
    stdout = err.stdout?.toString() ?? '';
    stderr = err.stderr?.toString() ?? '';
    exitCode = err.status ?? 1;
  }

  const durationMs = Date.now() - startTime;
  return { stdout, stderr, exitCode, durationMs, mode: 'local' };
}

// ── CLI command dispatch ───────────────────────────────

/**
 * Handle `yu sandbox <command>` CLI calls.
 * Runs the given command string in the sandbox.
 */
export function sandboxCommand(args: string[]): string {
  if (args.length === 0) {
    return 'Usage: yu sandbox <command...>\n' +
           '       yu sandbox status';
  }

  if (args[0] === 'status') {
    const dockerOk = isDockerAvailable();
    const dockerStatus = dockerOk ? '可用 ✓' : '不可用 ✗（将 fallback 到本地执行）';
    const lines: string[] = ['沙箱状态:'];
    lines.push('  Docker: ' + dockerStatus);
    lines.push(`  基础镜像: ${SANDBOX_IMAGE}`);
    lines.push(`  超时限制: ${SANDBOX_TIMEOUT_MS / 1000}s`);
    lines.push(`  内存限制: ${SANDBOX_MEMORY_LIMIT}`);
    return lines.join('\n');
  }

  const command = args.join(' ');
  const result = runInSandbox(command);

  const lines: string[] = [];
  if (result.stdout) lines.push(result.stdout);
  if (result.stderr) {
    lines.push('--- stderr ---');
    lines.push(result.stderr);
  }
  lines.push(`\n[沙箱] 退出码: ${result.exitCode} | 耗时: ${(result.durationMs / 1000).toFixed(1)}s | 模式: ${result.mode}`);
  return lines.join('\n');
}

// ── Helpers ────────────────────────────────────────────

/** Escape a shell argument for safe concatenation. */
function escapeArg(arg: string): string {
  // For simplicity, wrap in single quotes and escape single quotes inside
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
