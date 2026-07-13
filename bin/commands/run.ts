/**
 * yu-agent CLI — Run command (`yu run <prompt>`)
 * Classifies intent → pass_through to chat agent, or dispatch to
 * coding/search/review/etc.
 */

const PROJECT_ROOT = new URL('../..', import.meta.url).pathname

export async function command(args: string[]): Promise<void> {
  const agentIdx = args.indexOf('--agent')
  const _bgIdx = args.indexOf('--bg') !== -1 ? args.indexOf('--bg') : args.indexOf('--background')
  let agentName: string | undefined
  let isBackground = false
  const filtered: string[] = []
  if (agentIdx !== -1 && args[agentIdx + 1]) {
    agentName = args[agentIdx + 1]
    filtered.push(...args.slice(1, agentIdx), ...args.slice(agentIdx + 2))
  } else {
    filtered.push(...args.slice(1))
  }
  const finalArgs = filtered.filter((a) => a !== '--bg' && a !== '--background')
  if (filtered.length !== finalArgs.length) isBackground = true
  const prompt = finalArgs.join(' ')
  if (!prompt) {
    console.error('Usage: yu run [--agent <name>] [--bg] <prompt>')
    process.exit(1)
  }

  if (agentName) {
    const mod = await import('../../extension/config.js')
    const { getAgentTypeConfig } = mod
    if (!getAgentTypeConfig(agentName)) {
      console.error(`Unknown agent type: "${agentName}"`)
      console.error(`Available: ${Object.keys(mod.AGENT_TYPES || {}).join(', ')}`)
      process.exit(1)
    }
    if (!isBackground) console.error(`  Using agent: ${agentName}`)
  }

  const { handler } = await import('../../extension/scheduler.js')
  const result = await handler(prompt, { agentType: agentName, background: isBackground || undefined })
  if (result !== null) {
    console.log(result)
  }
}
