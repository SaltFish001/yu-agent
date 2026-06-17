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

import { createLogger } from '../logger.js'

const log = createLogger('sandbox')

// ── Constants ──────────────────────────────────────────

const SANDBOX_IMAGE = 'node:24-slim'
const SANDBOX_TIMEOUT_MS = 60_000
const SANDBOX_MEMORY_LIMIT = '512m'

// ── Docker detection ───────────────────────────────────

/** Whether Docker is available on the system. */
let _dockerChecked = false
let _dockerAvailable = false

function isDockerAvailable(): boolean {
  if (_dockerChecked) return _dockerAvailable
  _dockerChecked = true
  try {
    const proc = Bun.spawnSync(['docker', 'info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 })
    _dockerAvailable = proc.exitCode === 0
  } catch {
    _dockerAvailable = false
  }
  return _dockerAvailable
}

// ── Sandbox execution ──────────────────────────────────

export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  mode: 'docker' | 'local'
}

/**
 * Run a command inside the sandbox.
 */
export function runInSandbox(
  command: string,
  options?: {
    cwd?: string
    timeout?: number
    memory?: string
    forceLocal?: boolean
    dockerArgs?: string[]
  },
): SandboxResult {
  const timeout = options?.timeout ?? SANDBOX_TIMEOUT_MS
  const forceLocal = options?.forceLocal ?? false
  const useDocker = !forceLocal && isDockerAvailable()

  const startTime = Date.now()

  if (useDocker) {
    const cwd = options?.cwd || process.cwd()
    const memory = options?.memory ?? SANDBOX_MEMORY_LIMIT

    const args = [
      'run',
      '--rm',
      '-i',
      '--memory',
      memory,
      '--memory-swap',
      memory,
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:noexec,nosuid,size=64m',
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,source=${cwd},target=/workspace,readonly`,
      ...(options?.dockerArgs ?? []),
      SANDBOX_IMAGE,
      'bash',
      '-c',
      command,
    ]

    try {
      const proc = Bun.spawnSync(['docker', ...args], { timeout })
      const durationMs = Date.now() - startTime
      return {
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
        exitCode: proc.exitCode,
        durationMs,
        mode: 'docker',
      }
    } catch (e: unknown) {
      const durationMs = Date.now() - startTime
      const msg = e instanceof Error ? e.message : String(e)
      return { stdout: '', stderr: msg, exitCode: 1, durationMs, mode: 'docker' }
    }
  }

  // ── Local fallback ──
  log.warn('Docker 不可用，使用本地执行（无隔离）。安装 Docker 以获得沙箱隔离: https://docs.docker.com/engine/install/')

  try {
    const proc = Bun.spawnSync(['bash', '-c', command], {
      timeout,
      cwd: options?.cwd,
    })
    const durationMs = Date.now() - startTime
    return {
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode,
      durationMs,
      mode: 'local',
    }
  } catch (e: unknown) {
    const durationMs = Date.now() - startTime
    const msg = e instanceof Error ? e.message : String(e)
    return { stdout: '', stderr: msg, exitCode: 1, durationMs, mode: 'local' }
  }
}

// ── CLI command dispatch ───────────────────────────────

export function sandboxCommand(args: string[]): string {
  if (args.length === 0) {
    return 'Usage: yu sandbox <command...>\n' + '       yu sandbox status'
  }

  if (args[0] === 'status') {
    const dockerOk = isDockerAvailable()
    const dockerStatus = dockerOk ? '可用 ✓' : '不可用 ✗（将 fallback 到本地执行）'
    const lines: string[] = ['沙箱状态:']
    lines.push(`  Docker: ${dockerStatus}`)
    lines.push(`  基础镜像: ${SANDBOX_IMAGE}`)
    lines.push(`  超时限制: ${SANDBOX_TIMEOUT_MS / 1000}s`)
    lines.push(`  内存限制: ${SANDBOX_MEMORY_LIMIT}`)
    return lines.join('\n')
  }

  const command = args.join(' ')
  const result = runInSandbox(command)

  const lines: string[] = []
  if (result.stdout) lines.push(result.stdout)
  if (result.stderr) {
    lines.push('--- stderr ---')
    lines.push(result.stderr)
  }
  lines.push(
    `\n[沙箱] 退出码: ${result.exitCode} | 耗时: ${(result.durationMs / 1000).toFixed(1)}s | 模式: ${result.mode}`,
  )
  return lines.join('\n')
}
