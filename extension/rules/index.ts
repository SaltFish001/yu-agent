/**
 * yu-agent — Role CLI command handler
 *
 * Handles `yu role` subcommands:
 *   yu role list                    List all loaded roles
 *   yu role get <name>              Show role details
 *   yu role resolve <name>          Show resolved (inherited) role
 *   yu role compose <name> [<name>...] Compose multiple roles
 *   yu role refresh                 Re-scan roles directory
 */

import { createLogger } from '../logger.js'
import { scanRoles, listRoles, getRole, refreshRoles } from './registry.js'
import { resolveRole, composeRoles } from './compose.js'

const log = createLogger('role:command')

export async function roleCommand(sub: string, args: string[]): Promise<string> {
  switch (sub) {
    case 'list': {
      const roles = await listRoles()
      if (roles.length === 0) return 'No roles loaded.\nPlace .yaml or .ts role files in ~/.yu/roles/'

      const lines = roles.map((r) => {
        const ext = r.extend?.length ? ` (extends: ${r.extend.join(', ')})` : ''
        return `  ${r.name}${ext} — ${r.description ?? 'no description'}`
      })
      return `Loaded roles (${roles.length}):\n${lines.join('\n')}`
    }

    case 'get': {
      const name = args[0]
      if (!name) return 'Usage: yu role get <name>'

      const role = await getRole(name)
      if (!role) return `Role not found: ${name}`

      return formatRole(role)
    }

    case 'resolve': {
      const name = args[0]
      if (!name) return 'Usage: yu role resolve <name>'

      const role = await resolveRole(name)
      if (!role) return `Role not found or could not be resolved: ${name}`

      return `Resolved role: ${name}\n${formatRole(role)}`
    }

    case 'compose': {
      if (args.length === 0) return 'Usage: yu role compose <name> [<name>...]'

      const composed = await composeRoles(args)
      if (!composed) return 'Could not compose roles (none found).'

      return `Composed roles (${args.join(', ')}):\n${formatRole(composed)}`
    }

    case 'refresh': {
      await refreshRoles()
      const roles = await listRoles()
      return `Roles refreshed. ${roles.length} role(s) loaded.`
    }

    case 'help':
    default:
      return `yu role — Role management

Usage:
  yu role list                    List all loaded roles
  yu role get <name>              Show role details
  yu role resolve <name>          Show resolved (inherited) role
  yu role compose <n1> [<n2>...]  Compose multiple roles
  yu role refresh                 Re-scan roles directory

Role files: ~/.yu/roles/*.{yaml,yml,ts,json}`
  }
}

function formatRole(role: {
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
  const lines: string[] = [`  Name:        ${role.name}`]
  if (role.description) lines.push(`  Description: ${role.description}`)
  if (role.extend?.length) lines.push(`  Extends:     ${role.extend.join(', ')}`)
  if (role.model) lines.push(`  Model:       ${role.model}`)
  if (role.thinking) lines.push(`  Thinking:    ${role.thinking}`)
  if (role.maxTurns !== undefined) lines.push(`  Max Turns:   ${role.maxTurns}`)

  const caps = role.capabilities
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
