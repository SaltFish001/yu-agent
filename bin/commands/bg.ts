/**
 * yu-agent CLI — Background task management (`yu bg <subcommand>`)
 */

export async function command(args: string[]): Promise<void> {
  const sub = args[1] || 'list'
  const { bg } = await import('../../extension/background.js')

  if (sub === 'list' || sub === 'ls') {
    const tasks = bg.list()
    if (tasks.length === 0) {
      console.log('No background tasks.')
    } else {
      console.log(`Background tasks (${tasks.length}):`)
      console.log('')
      for (const t of tasks) {
        const dur = t.endTime ? `${((t.endTime - t.startTime) / 1000).toFixed(1)}s` : '-'
        const icon =
          t.status === 'completed'
            ? '✓'
            : t.status === 'failed'
              ? '✗'
              : t.status === 'running'
                ? '▶'
                : t.status === 'cancelled'
                  ? '⊘'
                  : '○'
        console.log(`  ${icon} ${t.id}`)
        console.log(`     Type: ${t.type}  Status: ${t.status}  Duration: ${dur}`)
        console.log(`     Task: ${t.prompt}`)
        if (t.status === 'failed' && t.error) {
          console.log(`     Error: ${t.error.slice(0, 200)}`)
        }
        console.log('')
      }
    }
    process.exit(0)
  }

  if (sub === 'get' || sub === 'show') {
    const id = args[2]
    if (!id) {
      console.error('Usage: yu bg get <id>')
      process.exit(1)
    }
    const t = bg.get(id)
    if (!t) {
      console.error(`Background task not found: ${id}`)
      process.exit(1)
    }
    console.log(`Task: ${t.id}`)
    console.log(`  Type:   ${t.type}`)
    console.log(`  Status: ${t.status}`)
    console.log(`  Start:  ${new Date(t.startTime).toLocaleString()}`)
    if (t.endTime) console.log(`  End:    ${new Date(t.endTime).toLocaleString()}`)
    console.log(`  Prompt: ${t.prompt}`)
    if (t.result) console.log(`\n  Result:\n${t.result.slice(0, 2000)}`)
    if (t.error) console.log(`\n  Error: ${t.error}`)
    process.exit(0)
  }

  if (sub === 'cancel') {
    const id = args[2]
    if (!id) {
      console.error('Usage: yu bg cancel <id>')
      process.exit(1)
    }
    if (bg.cancel(id)) {
      console.log(`Cancelled: ${id}`)
    } else {
      console.error(`Task not found or already finished: ${id}`)
      process.exit(1)
    }
    process.exit(0)
  }

  console.error('Usage:')
  console.error('  yu bg list           — list background tasks')
  console.error('  yu bg get <id>       — show task result')
  console.error('  yu bg cancel <id>    — cancel pending task')
  process.exit(1)
}
