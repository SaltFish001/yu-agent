/**
 * yu-agent — Bash 工具
 *
 * 通过 bun:spawn 执行 shell 命令。
 * 支持超时和输出截断。
 */

import { createLogger } from '../logger.js'
import { registerTool, type ToolResult } from './registry.js'

const _log = createLogger('tool-bash')

registerTool({
  name: 'bash',
  description: 'Execute a shell command. Returns stdout + stderr output.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000, max: 120000)',
      },
      workdir: {
        type: 'string',
        description: 'Working directory (default: project root)',
      },
    },
    required: ['command'],
  },
  async execute(params): Promise<ToolResult> {
    const command = String(params.command ?? '')
    const timeout = Math.min(Number(params.timeout ?? 30000), 120000)
    const workdir = params.workdir ? String(params.workdir) : undefined

    if (!command.trim()) {
      return { success: false, output: '', error: 'Empty command' }
    }

    try {
      const proc = Bun.spawn(['bash', '-c', command], {
        cwd: workdir,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const result = await Promise.race([
        Promise.all([proc.exited, proc.stdout.getReader().read(), proc.stderr.getReader().read()]),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            proc.kill()
            reject(new Error(`Timeout after ${timeout}ms`))
          }, timeout),
        ),
      ])

      const [exitCode, stdoutResult, stderrResult] = result as [number, any, any]
      const stdout = new TextDecoder().decode(stdoutResult?.value ?? new Uint8Array())
      const stderr = new TextDecoder().decode(stderrResult?.value ?? new Uint8Array())

      const output = [stdout, stderr].filter(Boolean).join('\n').slice(0, 50000)

      return {
        success: exitCode === 0,
        output: output || '(no output)',
        error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: msg }
    }
  },
})
