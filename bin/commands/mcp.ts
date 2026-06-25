/**
 * yu-agent CLI — MCP server management (`yu mcp <subcommand>`)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

export function command(args: string[]): void {
  const sub = args[1] || 'list'

  if (sub === 'list') {
    const configPath = resolve(homedir(), '.yu', 'mcp.config.json')
    const statusPath = resolve(homedir(), '.yu', 'mcp.json')

    let configured: string[] = []
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8')
        const config = JSON.parse(raw)
        configured = Object.keys(config.servers || {})
      } catch { /* ignore */ }
    }

    const statusMap: Record<string, { status: string; tools?: string[]; error?: string }> = {}
    if (existsSync(statusPath)) {
      try {
        const raw = readFileSync(statusPath, 'utf-8')
        const statusData = JSON.parse(raw)
        for (const s of statusData.servers || []) {
          statusMap[s.name] = s
        }
      } catch { /* ignore */ }
    }

    if (configured.length === 0 && Object.keys(statusMap).length === 0) {
      console.log('No MCP servers configured.')
      console.log('  Add one with: yu mcp add <name> <command> [args...]')
      process.exit(0)
    }

    const allNames = [...new Set([...configured, ...Object.keys(statusMap)])]
    console.log(`MCP servers (${allNames.length}):`)
    for (const name of allNames) {
      const st = statusMap[name]
      const statusIcon = !st ? '○' : st.status === 'connected' ? '✓' : st.status === 'error' ? '✗' : '○'
      const statusText = !st ? 'not started' : st.status
      const tools = st?.tools?.length ? ` (${st.tools.length}t)` : ''
      const err = st?.error ? ` — ${st.error}` : ''
      const configuredMark = configured.includes(name) ? '' : ' (not in config)'
      console.log(`  ${statusIcon} ${name} ${statusText}${tools}${err}${configuredMark}`)
    }
    process.exit(0)
  }

  if (sub === 'add') {
    const name = args[2]
    const commandStr = args[3]
    if (!name || !commandStr) {
      console.error('Usage: yu mcp add <name> <command> [args...]')
      process.exit(1)
    }
    const extraArgs = args.slice(4)
    const configPath = resolve(homedir(), '.yu', 'mcp.config.json')

    let config: { servers: Record<string, { command: string; args?: string[] }> } = { servers: {} }
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch { /* ignore */ }
    }
    if (!config.servers) config.servers = {}

    config.servers[name] = { command: commandStr, args: extraArgs.length > 0 ? extraArgs : undefined }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    console.log(`MCP server "${name}" added to ${configPath}`)
    console.log('  Restart yu-agent to apply changes.')
    process.exit(0)
  }

  if (sub === 'rm' || sub === 'remove') {
    const name = args[2]
    if (!name) {
      console.error('Usage: yu mcp rm <name>')
      process.exit(1)
    }
    const configPath = resolve(homedir(), '.yu', 'mcp.config.json')

    let config: { servers: Record<string, unknown> } = { servers: {} }
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch { /* ignore */ }
    }
    if (!config.servers?.[name]) {
      console.error(`MCP server "${name}" not found in config.`)
      process.exit(1)
    }
    delete config.servers[name]
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    console.log(`MCP server "${name}" removed from ${configPath}`)
    process.exit(0)
  }

  console.error('Usage:')
  console.error('  yu mcp list                — list MCP servers (configured + status)')
  console.error('  yu mcp add <name> <cmd>    — add a new MCP server')
  console.error('  yu mcp rm <name>           — remove an MCP server')
  process.exit(1)
}
