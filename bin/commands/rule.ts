/**
 * yu-agent CLI — Rule management (`yu rule <subcommand>`)
 */

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

export async function command(args: string[]): Promise<void> {
  const sub = args[1] || 'help'
  const ruleArgs = args.slice(2)

  if (sub === 'help') {
    const { showHelpForCommand } = await import('../help.js')
    console.log(showHelpForCommand('rule'))
    process.exit(0)
  }

  const configPath = resolve(process.env.HOME || '/home/saltfish', '.yu', 'orchestrator.json')
  let rules: Array<{ name: string; trigger?: string; action?: string; condition?: string }> = []
  let configSource = '(no config)'
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      rules = parsed.rules ?? []
      configSource = configPath
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`Error reading orchestrator.json: ${msg}`)
      process.exit(1)
    }
  }

  if (sub === 'list') {
    if (rules.length === 0) {
      console.log('No rules configured.')
      console.log(`  Config: ${configSource}`)
      console.log('  Create ~/.yu/orchestrator.json with a "rules" array to get started.')
    } else {
      console.log(`Rules (${rules.length}):`)
      console.log(`  Config: ${configSource}`)
      console.log('')
      for (const r of rules) {
        const trigger = r.trigger ? `  Trigger: ${r.trigger}` : ''
        const action = r.action ? `  Action: ${r.action}` : ''
        const condition = r.condition ? `  Condition: ${r.condition}` : ''
        console.log(`  ▶ ${r.name}`)
        if (trigger) console.log(trigger)
        if (condition) console.log(condition)
        if (action) console.log(action)
        console.log('')
      }
    }
    process.exit(0)
  }

  if (sub === 'inspect') {
    const name = ruleArgs[0]
    if (!name) {
      console.error('Usage: yu rule inspect <name>')
      process.exit(1)
    }
    const rule = rules.find((r) => r.name === name)
    if (!rule) {
      console.error(`Rule not found: "${name}"`)
      process.exit(1)
    }
    console.log(`Rule: ${rule.name}`)
    console.log(`  Trigger:   ${rule.trigger ?? '(none)'}`)
    console.log(`  Action:    ${rule.action ?? '(none)'}`)
    console.log(`  Condition: ${rule.condition ?? '(none)'}`)
    console.log(`  Source:    ${configSource}`)
    process.exit(0)
  }

  console.error('Usage:')
  console.error('  yu rule list              — list all active rules')
  console.error('  yu rule inspect <name>    — show rule details')
  process.exit(1)
}
