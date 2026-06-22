import { getSessionPool } from './dist/extension/spawn.js'
import { parseSchedulerOutput } from './dist/extension/template.js'

async function main() {
  const pool = getSessionPool('general-purpose')
  console.log('Pool obtained, calling...')

  const result = await pool.call('count files in extension/', {
    type: 'general-purpose',
    model: 'v4-flash',
    maxTurns: 3,
    task: 'count files in extension/',
    timeout: 30000,
  })

  console.log('=== RAW OUTPUT ===')
  console.log(result.response)
  console.log('=== PARSED ===')
  const parsed = parseSchedulerOutput(result.response)
  console.log(JSON.stringify(parsed, null, 2))

  const stats = pool.getStats()
  console.log('=== STATS ===')
  console.log(JSON.stringify(stats, null, 2))
}

main().catch((err) => {
  console.error('ERROR:', err)
  process.exit(1)
})
