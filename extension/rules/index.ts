/**
 * yu-agent — Rule CLI command handler (deprecated `yu role` alias)
 *
 * Handles `yu role` subcommands (deprecated, use `yu rule`):
 *   yu rule list                    List all loaded rules
 *   yu rule get <name>              Show rule details
 *   yu rule resolve <name>          Show resolved (inherited) rule
 *   yu rule compose <name> [<name>...] Compose multiple rules
 *   yu rule refresh                 Re-scan rules directory
 */
import { createLogger } from '../logger.js'
import { scanRules, listRules, getRule, refreshRules } from './registry.js'
import { resolveRule, composeRules } from './compose.js'

const log = createLogger('rule:command')

export async function ruleCommand(sub: string, args: string[]): Promise<string> {
  switch (sub) {
    case 'list': {
      const rules = await listRules()
      if (rules.length === 0) return 'No rules loaded.\nPlace .yaml or .ts rule files in ~/.yu/rules/'

      const lines = rules.map((r) => {
        const ext = r.extend?.length ? ` (extends: ${r.extend.join(', ')})` : ''
        return `  ${r.name}${ext} — ${r.description ?? 'no description'}`
      })
      return `Loaded rules (${rules.length}):\n${lines.join('\n')}`
    }

    case 'get': {
      const name = args[0]
      if (!name) return 'Usage: yu rule get <name>'

      const rule = await getRule(name)
      if (!rule) return `Rule not found: ${name}`

      return formatRule(rule)
    }

    case 'resolve': {
      const name = args[0]
      if (!name) return 'Usage: yu rule resolve <name>'

      const rule = await resolveRule(name)
      if (!rule) return `Rule not found or could not be resolved: ${name}`

      return `Resolved rule: ${name}\n${formatRule(rule)}`
    }

    case 'compose': {
      if (args.length === 0) return 'Usage: yu rule compose <name> [<name>...]'

      const composed = await composeRules(args)
      if (!composed) return 'Could not compose rules (none found).'

      return `Composed rules (${args.join(', ')}):\n${formatRule(composed)}`
    }

    case 'refresh': {
      await refreshRules()
      const rules = await listRules()
      return `Rules refreshed. ${rules.length} rule(s) loaded.`
    }

    case 'help':
    default:
      return `yu rule — Rule management

Usage:
  yu rule list                    List all loaded rules
  yu rule get <name>              Show rule details
  yu rule resolve <name>          Show resolved (inherited) rule
  yu rule compose <n1> [<n2>...]  Compose multiple rules
  yu rule refresh                 Re-scan rules directory

Rule files: ~/.yu/rules/*.{yaml,yml,ts,json}`
  }
}

function formatRule(rule: {
  name: string
  description?: string
  extend?: string[]
  systemPrompt?: string
  model?: string
  thinking?: string
  maxTurns?: number
  capabilities?: {
    allowTools?: string[]
    denyTools?: string[]
    maxToolCalls?: number
    allowMcpServers?: string[]
    maxTokens?: number
  }
}): string {
  const lines: string[] = [`  Name:        ${rule.name}`]
  if (rule.description) lines.push(`  Description: ${rule.description}`)
  if (rule.extend?.length) lines.push(`  Extends:     ${rule.extend.join(', ')}`)
  if (rule.model) lines.push(`  Model:       ${rule.model}`)
  if (rule.thinking) lines.push(`  Thinking:    ${rule.thinking}`)
  if (rule.maxTurns !== undefined) lines.push(`  Max Turns:   ${rule.maxTurns}`)

  const caps = rule.capabilities
  if (caps) {
    lines.push(`  Capabilities:`)
    if (caps.allowTools?.length) lines.push(`    Allow tools:  ${caps.allowTools.join(', ')}`)
    if (caps.denyTools?.length) lines.push(`    Deny tools:   ${caps.denyTools.join(', ')}`)
    if (caps.maxToolCalls !== undefined) lines.push(`    Max tool calls: ${caps.maxToolCalls}`)
    if (caps.allowMcpServers?.length) lines.push(`    Allow MCP:    ${caps.allowMcpServers.join(', ')}`)
    if (caps.maxTokens !== undefined) lines.push(`    Max tokens:   ${caps.maxTokens}`)
  }

  return lines.join('\n')
}
