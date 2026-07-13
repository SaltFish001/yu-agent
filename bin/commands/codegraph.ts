/**
 * yu-agent CLI — CodeGraph commands (`yu search | graph | context`)
 */

import { resolve } from 'path'

export async function command(subcommand: string, args: string[]): Promise<void> {
  const cgPath = resolve(import.meta.dir, '..', '..', 'node_modules', '.bin', 'codegraph')

  if (subcommand === 'search') {
    const query = args.join(' ')
    if (!query) {
      console.error('Usage: yu search <query>')
      process.exit(1)
    }
    try {
      const proc = Bun.spawnSync([cgPath, 'query', query, '--limit', '15'], {
        cwd: resolve(import.meta.dir, '..', '..'),
        timeout: 15000,
      })
      if (proc.exitCode === 0) {
        console.log(proc.stdout.toString())
      } else {
        console.error('Search failed: codegraph exited with code', proc.exitCode, proc.stderr.toString())
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error('Search failed:', errMsg)
    }
    process.exit(0)
  }

  if (subcommand === 'graph') {
    const symbol = args.join(' ')
    if (!symbol) {
      console.error('Usage: yu graph <symbol>')
      process.exit(1)
    }
    try {
      console.log('=== Callers ===')
      const callersProc = Bun.spawnSync([cgPath, 'callers', symbol, '--limit', '10'], {
        cwd: resolve(import.meta.dir, '..', '..'),
        timeout: 10000,
      })
      if (callersProc.exitCode === 0) {
        console.log(callersProc.stdout.toString())
      }
      console.log('=== Callees ===')
      const calleesProc = Bun.spawnSync([cgPath, 'callees', symbol, '--limit', '10'], {
        cwd: resolve(import.meta.dir, '..', '..'),
        timeout: 10000,
      })
      if (calleesProc.exitCode === 0) {
        console.log(calleesProc.stdout.toString())
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error('Graph query failed:', errMsg)
    }
    process.exit(0)
  }

  if (subcommand === 'context') {
    const task = args.join(' ')
    if (!task) {
      console.error('Usage: yu context <task description>')
      process.exit(1)
    }
    try {
      const proc = Bun.spawnSync([cgPath, 'context', task], {
        cwd: resolve(import.meta.dir, '..', '..'),
        timeout: 30000,
      })
      if (proc.exitCode === 0) {
        console.log(proc.stdout.toString())
      } else {
        throw new Error(`codegraph exit code ${proc.exitCode}: ${proc.stderr.toString()}`)
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error('Context build failed:', errMsg)
    }
    process.exit(0)
  }

  console.error('Usage:')
  console.error('  yu search <query>           — semantic code search')
  console.error('  yu graph <symbol>           — show callers/callees')
  console.error('  yu context <description>    — build task context')
  process.exit(1)
}
