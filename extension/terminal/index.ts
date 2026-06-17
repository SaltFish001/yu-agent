/**
 * yu-agent — Terminal integration (Phase 4).
 *
 * Attach to running terminal processes (read-only) via /proc.
 * Limitations:
 *   - Linux only (/proc filesystem)
 *   - Current user only
 *   - Read-only (no write to terminal)
 *   - Auto-disconnect after 300s
 */

import { closeSync, existsSync, openSync, readlinkSync, readSync } from 'fs'

// ── Constants ──────────────────────────────────────────

const WATCH_TIMEOUT_MS = 300_000 // 300s = 5min
const WATCH_POLL_MS = 200 // poll interval
const READ_BUF_SIZE = 4096
const _BUF_FLUSH_INTERVAL_MS = 2_000 // flush buffer every 2s for callback

// ── Types ──────────────────────────────────────────────

export interface TerminalProcess {
  pid: number
  command: string
  user: string
  startedAt: number
}

export interface TerminalOutput {
  text: string
  pid: number
  timestamp: number
}

export interface AttachHandle {
  pid: number
  disconnect: () => void
}

// ── Helpers ────────────────────────────────────────────

/** Get current username. */
function currentUser(): string {
  try {
    const proc = Bun.spawnSync(['whoami'], { timeout: 3_000 })
    if (proc.exitCode === 0) return proc.stdout.toString().trim()
    return process.env.USER || 'unknown'
  } catch {
    return process.env.USER || 'unknown'
  }
}

/** Check if the platform is Linux. */
export function isLinux(): boolean {
  return process.platform === 'linux'
}

/** Ensure we're on Linux, throw otherwise. */
function requireLinux(): void {
  if (!isLinux()) {
    throw new Error('terminal 功能仅支持 Linux（依赖 /proc 文件系统）')
  }
}

// ── List processes ─────────────────────────────────────

/**
 * List terminal processes belonging to the current user.
 * Filters for shell and tty-attached processes.
 */
export function listTerminalProcesses(): TerminalProcess[] {
  requireLinux()

  const user = currentUser()
  const results: TerminalProcess[] = []
  const seen = new Set<number>()

  // ps output: pid, comm (command name), lstart (start time)
  let psOutput = ''
  try {
    psOutput = (() => {
      try {
        const proc = Bun.spawnSync(['ps', '-u', user, '-o', 'pid=,comm=,lstart=', '--no-headers'], { timeout: 10_000 })
        return proc.exitCode === 0 ? proc.stdout.toString() : ''
      } catch {
        return ''
      }
    })()
  } catch {
    return results
  }

  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // ps output format: "  PID COMMAND START_TIME"
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue

    const pid = parseInt(parts[0], 10)
    if (Number.isNaN(pid) || seen.has(pid)) continue
    seen.add(pid)

    const command = parts.slice(1).join(' ')

    // Filter: only shell/tty processes
    const isShell =
      command.includes('bash') ||
      command.includes('zsh') ||
      command.includes('fish') ||
      command.includes('sh') ||
      command.includes('tmux') ||
      command.includes('screen') ||
      command.endsWith('sh')

    const hasTty = checkTty(pid)

    if (isShell || hasTty) {
      const procDir = `/proc/${pid}`
      let startedAt = Date.now()
      try {
        const statRaw = (() => {
          try {
            const p = Bun.spawnSync(['stat', '-c', '%Y', procDir], { timeout: 2_000 })
            return p.exitCode === 0 ? p.stdout.toString().trim() : String(Math.floor(Date.now() / 1000))
          } catch {
            return String(Math.floor(Date.now() / 1000))
          }
        })()
        const ts = parseInt(statRaw, 10)
        if (!Number.isNaN(ts)) startedAt = ts * 1000
      } catch {
        /* use fallback */
      }

      results.push({
        pid,
        command,
        user,
        startedAt,
      })
    }
  }

  return results
}

/** Check if a process has an associated TTY. */
function checkTty(pid: number): boolean {
  try {
    const ttyPath = `/proc/${pid}/fd/0`
    if (!existsSync(ttyPath)) return false
    const link = readlinkSync(ttyPath)
    return link.startsWith('/dev/pts/') || link.startsWith('/dev/tty')
  } catch {
    return false
  }
}

// ── Attach (read FD) ───────────────────────────────────

/**
 * Read the current stdout buffer of a process.
 * Reads /proc/pid/fd/1 (stdout).
 *
 * Returns the text content or empty string on error.
 */
export function readProcessOutput(pid: number): string {
  requireLinux()
  assertOwnProcess(pid)

  const stdoutPath = `/proc/${pid}/fd/1`
  if (!existsSync(stdoutPath)) {
    throw new Error(`进程 ${pid} 没有可读的文件描述符 (fd/1)`)
  }

  let fd: number | undefined
  try {
    fd = openSync(stdoutPath, 'r')
    const buf = Buffer.alloc(READ_BUF_SIZE)
    const bytesRead = readSync(fd, buf, 0, READ_BUF_SIZE, 0)
    if (bytesRead <= 0) return ''
    return buf.toString('utf-8', 0, bytesRead)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// ── Watch (poll fd, callback) ──────────────────────────

/**
 * Watch a process's stdout by polling /proc/pid/fd/1.
 * Calls the callback with incremental output.
 *
 * Returns an AttachHandle with a `disconnect()` method.
 *
 * Auto-disconnects after WATCH_TIMEOUT_MS (300s).
 */
export function watchProcessOutput(pid: number, callback: (output: TerminalOutput) => void): AttachHandle {
  requireLinux()
  assertOwnProcess(pid)

  const stdoutPath = `/proc/${pid}/fd/1`
  if (!existsSync(stdoutPath)) {
    throw new Error(`进程 ${pid} 没有可读的标准输出 (fd/1)`)
  }

  let fd: number | undefined
  try {
    fd = openSync(stdoutPath, 'r')
  } catch (e) {
    throw new Error(`无法打开进程 ${pid} 的标准输出: ${e instanceof Error ? e.message : String(e)}`)
  }

  let aborted = false
  let lastOffset = 0
  let lastFlush = Date.now()

  const interval = setInterval(() => {
    if (aborted) return

    // Check timeout
    if (Date.now() - lastFlush > WATCH_TIMEOUT_MS) {
      callback({
        text: `\n[yu-terminal] 超时断开（${WATCH_TIMEOUT_MS / 1000}s 无新输出）`,
        pid,
        timestamp: Date.now(),
      })
      clearInterval(interval)
      if (fd !== undefined) closeSync(fd)
      return
    }

    try {
      const buf = Buffer.alloc(READ_BUF_SIZE)
      const bytesRead = readSync(fd!, buf, 0, READ_BUF_SIZE, lastOffset)

      if (bytesRead > 0) {
        const text = buf.toString('utf-8', 0, bytesRead)
        lastOffset += bytesRead
        lastFlush = Date.now()

        callback({
          text,
          pid,
          timestamp: Date.now(),
        })
      }
    } catch {
      // Process may have ended
      if (!aborted) {
        callback({
          text: `\n[yu-terminal] 进程 ${pid} 已结束`,
          pid,
          timestamp: Date.now(),
        })
      }
      clearInterval(interval)
      if (fd !== undefined) closeSync(fd)
    }
  }, WATCH_POLL_MS)

  // Allow reading to stop after timeout regardless of activity
  const killTimer = setTimeout(() => {
    if (!aborted) {
      aborted = true
      clearInterval(interval)
      if (fd !== undefined) closeSync(fd)
    }
  }, WATCH_TIMEOUT_MS + 5_000)

  return {
    pid,
    disconnect: () => {
      aborted = true
      clearInterval(interval)
      clearTimeout(killTimer)
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
      }
    },
  }
}

// ── Security checks ────────────────────────────────────

/** Assert that the given PID belongs to the current user. */
function assertOwnProcess(pid: number): void {
  try {
    const statusPath = `/proc/${pid}/status`
    if (!existsSync(statusPath)) {
      throw new Error(`进程 ${pid} 不存在`)
    }

    // Read process UID from /proc/pid/status
    const status = (() => {
      try {
        const p = Bun.spawnSync(['grep', '-i', '^Uid:', statusPath], { timeout: 3_000 })
        return p.exitCode === 0 ? p.stdout.toString().trim() : ''
      } catch {
        return ''
      }
    })()

    const match = status.match(/^Uid:\s+(\d+)/)
    if (!match) {
      throw new Error(`无法读取进程 ${pid} 的 UID`)
    }

    const procUid = parseInt(match[1], 10)
    const ourUid = (() => {
      try {
        const p = Bun.spawnSync(['id', '-u'], { timeout: 3_000 })
        return parseInt(p.exitCode === 0 ? p.stdout.toString().trim() : '0', 10)
      } catch {
        return 0
      }
    })()

    if (procUid !== ourUid) {
      throw new Error(`进程 ${pid} 不属于当前用户（只允许 attach 到自己的进程）`)
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('不属于当前用户')) throw e
    throw new Error(`进程 ${pid} 不存在或无法访问`)
  }
}

// ── CLI command dispatch ───────────────────────────────

/**
 * Handle `yu terminal <subcommand>` CLI calls.
 * Returns the output string to print.
 *
 * Subcommands:
 *   list                    List terminal processes
 *   attach <pid>            Read current stdout buffer (one-shot)
 *   watch <pid>             Live-tail stdout (Ctrl+C to stop)
 */
export function terminalCommand(args: string[]): string {
  if (!isLinux()) {
    return 'terminal 功能仅支持 Linux 平台。'
  }

  const sub = args[0] || 'help'

  switch (sub) {
    case 'list': {
      const procs = listTerminalProcesses()
      if (procs.length === 0) {
        return '没有找到当前用户的终端进程。'
      }

      const lines = ['当前用户的终端进程:']
      lines.push('  PID      COMMAND                       STARTED')
      lines.push('  ─────── ────────────────────────────── ────────────────────')
      for (const p of procs) {
        const cmd = p.command.length > 30 ? `${p.command.slice(0, 27)}...` : p.command.padEnd(30)
        const time = new Date(p.startedAt).toLocaleString()
        lines.push(`  ${String(p.pid).padEnd(7)} ${cmd} ${time}`)
      }
      lines.push(`\n  共 ${procs.length} 个进程。`)
      return lines.join('\n')
    }

    case 'attach': {
      const pidStr = args[1]
      if (!pidStr || !/^\d+$/.test(pidStr)) {
        return 'Usage: yu terminal attach <pid>'
      }
      const pid = parseInt(pidStr, 10)
      try {
        const output = readProcessOutput(pid)
        if (!output) {
          return `进程 ${pid} 的标准输出缓冲区为空（无最新内容）。`
        }
        return `--- stdout of PID ${pid} ---\n${output}`
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return `attach 失败: ${msg}`
      }
    }

    case 'watch': {
      return 'watch 模式仅支持在交互式环境中使用。'
    }

    default:
      return (
        'Usage: yu terminal list              List terminal processes\n' +
        '       yu terminal attach <pid>      Read process stdout (one-shot)\n' +
        '       yu terminal watch <pid>       Live-tail stdout (interactive only)'
      )
  }
}
