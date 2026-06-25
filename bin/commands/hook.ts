/**
 * yu-agent CLI — Hook management (`yu hook <subcommand>`)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

export function command(args: string[]): void {
  const sub = args[1] || 'help'
  const configPath = resolve(process.env.HOME || '/home/saltfish', '.yu', 'config.json')
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf-8'))
    }
  } catch { /* will fall back to empty config */ }

  if (sub === 'list') {
    const hooks = config.hooks as Record<string, { enabled: boolean }> | undefined
    if (!hooks || Object.keys(hooks).length === 0) {
      console.log('No hooks configured.')
    } else {
      console.log('Registered hooks:')
      for (const [name, opts] of Object.entries(hooks)) {
        const enabled = (opts as { enabled: boolean })?.enabled ?? true
        console.log(`  ${enabled ? '✓' : '✗'} ${name} (${enabled ? 'enabled' : 'disabled'})`)
      }
    }
    process.exit(0)
  }

  if (sub === 'toggle') {
    const hookName = args[2]
    if (!hookName) {
      console.error('Usage: yu hook toggle <name>')
      console.error('Example: yu hook toggle beforeChat')
      process.exit(1)
    }
    const hooks = (config.hooks || {}) as Record<string, { enabled: boolean }>
    const knownHooks = ['beforeChat']
    if (!knownHooks.includes(hookName)) {
      console.error(`Unknown hook "${hookName}". Available hooks: ${knownHooks.join(', ')}`)
      process.exit(1)
    }
    const current = hooks[hookName]?.enabled ?? true
    hooks[hookName] = { enabled: !current }
    config.hooks = hooks
    mkdirSync(resolve(process.env.HOME || '/home/saltfish', '.yu'), { recursive: true })
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    console.log(`Hook "${hookName}" ${!current ? 'disabled' : 'enabled'}.`)
    process.exit(0)
  }

  console.error('Usage:')
  console.error('  yu hook list            — show registered hooks')
  console.error('  yu hook toggle <name>   — toggle hook on/off')
  process.exit(1)
}
