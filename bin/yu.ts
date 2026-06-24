#!/usr/bin/env node
/**
 * yu-agent — Standalone CLI entry point.
 *
 * 零外部依赖。不再需要 Pi SDK。
 * Usage:
 *   yu "prompt"            → Classify + dispatch via AgentLoop
 *   yu chat                → Interactive REPL (direct API)
 *   yu review <path>       → Review code
 *   yu plan <task>         → Generate plan
 *   yu doctor              → One-click health diagnosis
 *   yu team <subcommand>   → Team mode management
 *   yu topic <subcommand>  → Topic management
 *   yu ui                  → Launch Web UI
 */

import { createRequire } from 'module'

const _require = createRequire(import.meta.url)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { shutdownManager } from '../extension/lifecycle.js'
import { formatBytes } from '../extension/paths.js'
import { getVersion, HELP_TEXT, showHelpForCommand } from './help.js'

// For ESM: __dirname equivalent
const __dirname = dirname(fileURLToPath(import.meta.url))
// Project root: dist/bin/ -> dist/ -> project root
const PROJECT_ROOT = resolve(__dirname, '..', '..')

/**
 * 估算 DeepSeek v4 系列 API 费用。
 *
 * Pricing (元/百万 token):
 *   v4-flash:  输入 ¥3,  输出 ¥6,  缓存命中 ¥0.3 (10%)
 *   v4-pro:    输入 ¥12, 输出 ¥24, 缓存命中 ¥1.2 (10%)
 *
 * 当模型信息不可用时默认使用 v4-flash 价格估算。
 */
function estimateCost(
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens: number,
  model: string = 'v4-flash',
): { inputCost: number; outputCost: number; totalCost: number; cacheSavings: number } {
  const isPro = model.includes('pro')
  const inputPrice = isPro ? 12 : 3
  const outputPrice = isPro ? 24 : 6
  const cachePrice = isPro ? 1.2 : 0.3

  const cacheMissInput = Math.max(0, inputTokens - cacheHitTokens)
  const inputCost = (cacheMissInput * inputPrice + cacheHitTokens * cachePrice) / 1_000_000
  const outputCost = (outputTokens * outputPrice) / 1_000_000
  const noCacheCost = (inputTokens * inputPrice) / 1_000_000
  const totalCost = inputCost + outputCost
  const cacheSavings = noCacheCost - (cacheHitTokens * cachePrice) / 1_000_000

  return { inputCost, outputCost, totalCost, cacheSavings }
}

/** Print cache hit-rate + cost summary from SQLite if available. */
async function printCacheStats(recentResult?: {
  cacheHitTokens?: number
  cacheMissTokens?: number
  outputTokens?: number
  durationMs?: number
  model?: string
}): Promise<void> {
  try {
    const { getCache } = await import('../extension/db.js')
    const tag = process.env.YU_SESSION_ID || 'shared'
    if (!tag || tag === 'shared') return
    const cache = getCache(tag)
    if (!cache || cache.turnCount === 0) return
    const pct = Math.round(cache.hitRate * 100)
    const total = cache.totalHits + cache.totalMisses

    // Use most recent result if available, otherwise aggregate from DB
    const hitTokens = recentResult?.cacheHitTokens ?? cache.totalHits
    const missTokens = recentResult?.cacheMissTokens ?? cache.totalMisses
    const outTokens = recentResult?.outputTokens ?? cache.totalOutput
    const model = recentResult?.model ?? 'v4-flash'

    const cost = estimateCost(missTokens, outTokens, hitTokens, model)

    console.log(`\n── Cost ──────────────────────────────────`)
    console.log(`  Cache hit rate: ${pct}% (${cache.totalHits} hits / ${total} total, ${cache.turnCount} turns)`)
    console.log(`  Input tokens:  ${(missTokens / 1000).toFixed(1)}k (cache hit: ${(hitTokens / 1000).toFixed(1)}k)`)
    console.log(`  Output tokens: ${(outTokens / 1000).toFixed(1)}k`)
    console.log(
      `  Est. cost:     ¥${cost.totalCost.toFixed(4)} (input ¥${cost.inputCost.toFixed(4)} + output ¥${cost.outputCost.toFixed(4)})`,
    )
    if (cost.cacheSavings > 0) {
      console.log(`  Cache saved:   ¥${cost.cacheSavings.toFixed(4)}`)
    }
    if (recentResult?.durationMs) {
      console.log(`  API duration:  ${(recentResult.durationMs / 1000).toFixed(1)}s`)
    }
    console.log(`──────────────────────────────────────────`)
  } catch {
    // ignore — no data yet or SQLite unavailable
  }
}

const COMMANDS = new Set([
  'review',
  'plan',
  'team',
  'coding',
  'commit',
  'doc',
  'search',
  'lsp',
  'run',
  'monitor',
  'memory',
  'refactor',
])

// ── Factory function ───────────────────────────────────

/**
 * Create a yu-agent application with memory lifecycle managed.
 * Returns an object with run() for starting the CLI.
 *
 * This is the factory function for programmatic use.
 * Instead of `new YuApp()`, call `createApp()`.
 */
export async function createApp(options?: {
  /** Print startup config summary. */
  printSummary?: boolean
}): Promise<{ run: () => Promise<void> }> {
  if (options?.printSummary) {
    await printStartupSummary()
  }

  return {
    run: async () => {
      await mainCli()
    },
  }
}

// ── Startup summary ────────────────────────────────────

/**
 * Print a concise startup configuration summary.
 */
async function printStartupSummary(): Promise<void> {
  try {
    const { YU_HOME, MCP_CONFIG_PATH, PROMPTS_DIR } = await import('../extension/paths.js')
    const { readdirSync } = await import('fs')
    const osInfo = `${process.platform} ${process.version}`

    const lines: string[] = [`yu-agent v${getVersion()} — ${osInfo}`, `  Data dir: ${YU_HOME}`]

    // Check MCP config
    if (existsSync(MCP_CONFIG_PATH)) {
      try {
        const mcpRaw = readFileSync(MCP_CONFIG_PATH, 'utf-8')
        const mcp = JSON.parse(mcpRaw)
        const serverCount = Object.keys(mcp.servers || {}).length
        lines.push(`  MCP servers: ${serverCount} configured`)
      } catch {
        lines.push(`  MCP config: unreadable`)
      }
    } else {
      lines.push(`  MCP servers: none configured`)
    }

    // Check prompts
    if (existsSync(PROMPTS_DIR)) {
      const promptFiles = readdirSync(PROMPTS_DIR).filter((f: string) => f.endsWith('.md'))
      lines.push(`  Prompts: ${promptFiles.length} files`)
    }

    console.log(lines.join('\n'))
  } catch {
    // Best-effort
  }
}

// ── Health diagnosis (--doctor) ────────────────────────

/**
 * One-click health diagnosis.
 * Checks all subsystems: memory, config, MCP, session DB.
 */
async function runDoctor(jsonOutput?: boolean): Promise<void> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = []

  if (!jsonOutput) {
    console.log('═ yu-agent 健康诊断 ════════════════════════')
    console.log(`Version: ${getVersion()}`)
    console.log()
  }

  // ── Paths ──
  const { YU_HOME, MCP_CONFIG_PATH, PROMPTS_DIR } = await import('../extension/paths.js')
  results.push({
    name: '数据目录',
    ok: existsSync(YU_HOME),
    detail: existsSync(YU_HOME) ? YU_HOME : `${YU_HOME} (不存在)`,
  })

  // ── MCP config ──
  const mcpOk = existsSync(MCP_CONFIG_PATH)
  let mcpDetail = MCP_CONFIG_PATH
  if (mcpOk) {
    try {
      const raw = readFileSync(MCP_CONFIG_PATH, 'utf-8')
      const mcp = JSON.parse(raw)
      const servers = Object.keys(mcp.servers || {})
      mcpDetail = `${MCP_CONFIG_PATH} (${servers.length} servers: ${servers.join(', ') || 'none'})`
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      mcpDetail = `${MCP_CONFIG_PATH} (解析失败: ${msg})`
    }
  } else {
    mcpDetail = `${MCP_CONFIG_PATH} (文件不存在)`
  }
  results.push({ name: 'MCP 配置', ok: mcpOk, detail: mcpDetail })

  // ── Prompt files ──
  const promptsOk = existsSync(PROMPTS_DIR)
  let promptCount = 0
  if (promptsOk) {
    const { readdirSync } = await import('fs')
    const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md'))
    promptCount = files.length
    results.push({
      name: 'Prompt 文件',
      ok: promptCount >= 8,
      detail: `${PROMPTS_DIR} (${promptCount} files, expected >= 8)`,
    })
  } else {
    results.push({
      name: 'Prompt 文件',
      ok: false,
      detail: `${PROMPTS_DIR} (目录不存在)`,
    })
  }

  // ── Session DB ──
  let dbIntegrityOk = true
  let dbIntegrityDetail = ''
  try {
    const { getDbPath } = await import('../extension/db.js')
    const dbPath = getDbPath()
    const dbExists = existsSync(dbPath)
    let dbDetail = dbPath
    if (dbExists) {
      const { Database: DatabaseSync } = await import('bun:sqlite')
      const size = readFileSync(dbPath).length
      dbDetail = `${dbPath} (${formatBytes(size)})`
      // Run integrity check
      try {
        const checkDb = new DatabaseSync(dbPath)
        const integrityRow = checkDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
        checkDb.close()
        if (integrityRow && integrityRow.integrity_check === 'ok') {
          dbIntegrityOk = true
          dbIntegrityDetail = 'ok'
        } else {
          dbIntegrityOk = false
          dbIntegrityDetail = integrityRow?.integrity_check || 'unknown error'
        }
      } catch (e2: unknown) {
        dbIntegrityOk = false
        dbIntegrityDetail = e2 instanceof Error ? e2.message : String(e2)
      }
    } else {
      dbDetail = `${dbPath} (文件不存在, 首次使用时会自动创建)`
    }
    results.push({ name: 'Session DB', ok: dbExists || true, detail: dbDetail })
    if (dbExists) {
      results.push({ name: 'DB 完整性', ok: dbIntegrityOk, detail: dbIntegrityDetail })
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name: 'Session DB', ok: false, detail: `诊断失败: ${msg}` })
  }

  // ── Token Usage Stats ──
  try {
    const { getTokenUsageAggregate, getTokenUsageBySession } = await import('../extension/db.js')
    const agg = getTokenUsageAggregate()
    if (agg.sessionCount > 0) {
      results.push({
        name: 'Token 用量 (累计)',
        ok: true,
        detail: `${agg.totalTokens.toLocaleString()} tokens (命中: ${agg.totalHits.toLocaleString()}, 未命中: ${agg.totalMisses.toLocaleString()}, 输出: ${agg.totalOutput.toLocaleString()}) | ¥${agg.totalCost.toFixed(4)} | ${agg.sessionCount} 会话`,
      })
      // Today's stats
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const _today = getTokenUsageBySession('__today__')
      // Use aggregate for now since we don't have a date filter
    }
    // Current session stats
    const tag = process.env.YU_SESSION_ID || 'shared'
    if (tag && tag !== 'shared') {
      const sessionUsage = getTokenUsageBySession(tag)
      if (sessionUsage.count > 0) {
        results.push({
          name: 'Token 用量 (当前会话)',
          ok: true,
          detail: `${sessionUsage.totalTokens.toLocaleString()} tokens (${sessionUsage.count} 次调用, 耗时 ${(sessionUsage.totalDurationMs / 1000).toFixed(1)}s)`,
        })
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name: 'Token 用量', ok: true, detail: `统计失败: ${msg}` })
  }

  // ── Agent Run Stats ──
  try {
    const { getAgentRunStats } = await import('../extension/db.js')
    const stats = getAgentRunStats()
    const { total, completed, failed, avgDurationMs, ...byType } = stats
    if (total > 0) {
      const successRate = total > 0 ? Math.round((completed / total) * 100) : 0
      const lines = [
        `${total} 次运行, ${completed} 成功, ${failed} 失败, ${successRate}% 成功率, 平均 ${(avgDurationMs / 1000).toFixed(1)}s`,
      ]
      for (const [type, t] of Object.entries(byType)) {
        const typed = t as { total: number; completed: number; failed: number; avgDurationMs: number }
        const rate = typed.total > 0 ? Math.round((typed.completed / typed.total) * 100) : 0
        lines.push(`  ${type}: ${typed.total} 次, ${rate}% 成功率, 平均 ${(typed.avgDurationMs / 1000).toFixed(1)}s`)
      }
      results.push({
        name: 'Agent 运行统计',
        ok: failed === 0,
        detail: lines.join('\n'),
      })
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name: 'Agent 运行统计', ok: true, detail: `统计失败: ${msg}` })
  }

  // ── Checkpoints ──
  try {
    const { listPendingCheckpoints } = await import('../extension/checkpoint.js')
    const pending = listPendingCheckpoints()
    if (pending.length > 0) {
      const lines = pending.map(
        (cp) => `    ${cp.step} (${new Date(cp.timestamp).toLocaleString()}, files: ${cp.files.length})`,
      )
      results.push({
        name: '未完成的 Checkpoint',
        ok: false,
        detail: `${pending.length} 个未完成:\n${lines.join('\n')}\n    运行 yu agent-recover 查看详情`,
      })
    } else {
      results.push({ name: 'Checkpoints', ok: true, detail: '无未完成项' })
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name: 'Checkpoints', ok: true, detail: `检查失败: ${msg}` })
  }

  // ── Event Channel ──
  try {
    const { existsSync: fsExistsSync } = await import('fs')
    const { resolve: resolvePath } = await import('path')
    const osHomedir = process.env.HOME || process.env.USERPROFILE || '/home/saltfish'
    const topicsDbPath = resolvePath(osHomedir, '.yu', 'topics.db')
    const dbExists = fsExistsSync(topicsDbPath)

    if (!dbExists) {
      results.push({
        name: '事件通道',
        ok: true,
        detail: 'topics.db 不存在 (事件通道未初始化, 首次使用时会自动创建)',
      })
    } else {
      const { Database: DatabaseSync } = await import('bun:sqlite')
      const eventDb = new DatabaseSync(topicsDbPath)
      try {
        const totalRow = eventDb.prepare('SELECT COUNT(*) AS cnt FROM events').get() as { cnt: number }
        const unackRow = eventDb.prepare('SELECT COUNT(*) AS cnt FROM events WHERE acknowledged = 0').get() as {
          cnt: number
        }
        const topicsWithPending = eventDb
          .prepare(`SELECT DISTINCT topic_name FROM events WHERE acknowledged = 0 ORDER BY topic_name`)
          .all() as Array<{ topic_name: string }>

        const totalEvents = totalRow?.cnt ?? 0
        const unacknowledged = unackRow?.cnt ?? 0
        const pendingTopics = topicsWithPending.map((r) => r.topic_name)

        if (totalEvents > 0) {
          const topicList = pendingTopics.length > 0 ? pendingTopics.join(', ') : 'none'
          results.push({
            name: '事件通道',
            ok: unacknowledged === 0,
            detail: `✅ 正常 (总计 ${totalEvents} 事件, ${unacknowledged} 未确认, 待处理主题: ${topicList})`,
          })
        } else {
          results.push({
            name: '事件通道',
            ok: true,
            detail: '✅ 正常 (无事件记录)',
          })
        }
      } finally {
        eventDb.close()
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name: '事件通道', ok: false, detail: `诊断失败: ${msg}` })
  }

  // ── Skill cache stats ──
  try {
    const { getSkillCacheStats } = await import('../extension/skills/registry.js')
    const stats = getSkillCacheStats()
    results.push({
      name: '技能缓存',
      ok: true,
      detail: `${stats.files} 文件, ${stats.fromDisk} 次磁盘加载, ${stats.fromCache} 次缓存命中`,
    })
  } catch {
    // non-critical
  }

  // ── Print results ──
  let allOk = true
  for (const r of results) {
    if (!r.ok) allOk = false
  }

  if (jsonOutput) {
    const output = {
      version: getVersion(),
      timestamp: new Date().toISOString(),
      healthy: allOk,
      checks: results.map((r) => ({
        name: r.name,
        ok: r.ok,
        detail: r.detail,
      })),
    }
    console.log(JSON.stringify(output, null, 2))
    return
  }

  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    console.log(` ${icon} ${r.name}`)
    console.log(`    ${r.detail}`)
  }

  console.log()
  console.log(allOk ? '✓ 全部正常' : '✗ 发现问题，请检查上方 ✗ 标记项')
  console.log('═══════════════════════════════════════════')
}

// ── Help text (moved to ./help.ts) ──────────────────────

// ── Doctor / health check ───────────────────────────────
async function mainCli(): Promise<void> {
  const args = process.argv.slice(2)

  // ═ 启动时检测未完成的 checkpoint ═
  try {
    const { listPendingCheckpoints } = await import('../extension/checkpoint.js')
    const pending = listPendingCheckpoints()
    if (pending.length > 0) {
      console.warn('')
      console.warn('═ 检测到未完成的 Checkpoint ═══════════════════')
      for (const cp of pending) {
        console.warn(`  • ${cp.step} — ${new Date(cp.timestamp).toLocaleString()}`)
        if (cp.files.length > 0) {
          console.warn(`    文件: ${cp.files.join(', ')}`)
        }
      }
      console.warn('')
      console.warn('  运行 yu doctor 查看完整诊断')
      console.warn('═══════════════════════════════════════════════')
      console.warn('')
    }
  } catch {
    // Best-effort
  }

  // Help
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    if (args[1]) {
      console.log(showHelpForCommand(args[1]))
    } else {
      console.log(HELP_TEXT)
    }
    process.exit(0)
  }

  // Version
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`yu-agent v${getVersion()}`)
    process.exit(0)
  }

  // Use yu-specific config directory (separate from pi)
  process.env.PI_CODING_AGENT_DIR = resolve(process.env.HOME || '/home/saltfish', '.yu', 'agent')
  // Suppress Pi's version check — yu-agent manages its own updates
  process.env.PI_SKIP_VERSION_CHECK = '1'

  // `yu doctor` — one-click health diagnosis
  if (args[0] === 'doctor') {
    const useJson = args.includes('--json')
    await runDoctor(useJson)
    process.exit(0)
  }

  // `yu team <subcommand>` — handled directly, no Pi session needed
  if (args[0] === 'team') {
    const subcommand = args[1] || 'help'
    const teamArgs = args.slice(2)
    const { teamCommand } = await import('../extension/team/index.js')
    const result = await teamCommand(subcommand, teamArgs)
    console.log(result)
    process.exit(0)
  }

  // `yu knowledge <subcommand>` — RAG knowledge base
  if (args[0] === 'knowledge') {
    const sub = args[1] || 'help'
    const { knowledgeCommand } = await import('../extension/knowledge/index.js')
    try {
      const out = knowledgeCommand(sub, args.slice(2))
      console.log(out)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`knowledge 操作失败: ${msg}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // `yu terminal <subcommand>` — terminal attach/watch
  if (args[0] === 'terminal') {
    const { terminalCommand, watchProcessOutput, isLinux } = await import('../extension/terminal/index.js')
    const sub = args[1] || 'help'

    try {
      if (sub === 'watch') {
        if (!isLinux()) {
          console.error('terminal 功能仅支持 Linux 平台。')
          process.exit(1)
        }
        const pidStr = args[2]
        if (!pidStr || !/^\d+$/.test(pidStr)) {
          console.error('Usage: yu terminal watch <pid>')
          process.exit(1)
        }
        const pid = parseInt(pidStr, 10)

        // 检查是否为交互式终端
        if (!process.stdin.isTTY) {
          console.log('非交互式环境，watch 模式不可用。使用 yu terminal attach <pid> 一次性读取。')
          process.exit(1)
        }

        console.log(`正在观察进程 ${pid} 的输出...（按 Ctrl+C 停止）`)
        const handle = watchProcessOutput(pid, (output) => {
          process.stdout.write(output.text)
        })

        // Wait for Ctrl+C
        process.on('SIGINT', () => {
          handle.disconnect()
          console.log('\n[yu-terminal] 已断开')
          process.exit(0)
        })

        // Keep alive
        await new Promise(() => {})
      } else {
        const out = terminalCommand(args.slice(1))
        console.log(out)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`terminal 操作失败: ${msg}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // `yu sandbox <command...>` — isolated execution
  if (args[0] === 'sandbox') {
    const { sandboxCommand } = await import('../extension/sandbox/index.js')
    try {
      const out = sandboxCommand(args.slice(1))
      console.log(out)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`sandbox 操作失败: ${msg}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // `yu git <subcommand>` — Git integration via gh CLI
  if (args[0] === 'git') {
    const sub = args[1] || 'help'
    const { prCreate, prList, createBranch, mergeBranch } = await import('../extension/git-commands.js')
    try {
      switch (sub) {
        case 'pr': {
          const prSub = args[2]
          if (prSub === 'create') {
            const out = prCreate(args[3] || 'main')
            console.log(out)
          } else if (prSub === 'list') {
            const out = prList()
            console.log(out)
          } else {
            console.error('Usage: yu git pr create [target-branch]')
            console.error('       yu git pr list')
            process.exit(1)
          }
          break
        }
        case 'branch': {
          const branchName = args[2]
          if (!branchName) {
            console.error('Usage: yu git branch <name>')
            process.exit(1)
          }
          const out = createBranch(branchName)
          console.log(out)
          break
        }
        case 'merge': {
          const mergeBranchName = args[2]
          if (!mergeBranchName) {
            console.error('Usage: yu git merge <branch>')
            process.exit(1)
          }
          const out = mergeBranch(mergeBranchName)
          console.log(out)
          break
        }
        default:
          console.error('Usage: yu git pr create [target-branch]')
          console.error('       yu git pr list')
          console.error('       yu git branch <name>')
          console.error('       yu git merge <branch>')
          process.exit(1)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`git 操作失败: ${msg}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // `yu hook list|toggle <name>` — manage hook config
  if (args[0] === 'hook') {
    const sub = args[1] || 'help'
    const configPath = resolve(process.env.HOME || '/home/saltfish', '.yu', 'config.json')
    let config: Record<string, unknown> = {}
    try {
      if (existsSync(configPath)) {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
      }
    } catch {
      // will fall back to empty config
    }

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
      // Validate: only known hook names can be toggled
      const knownHooks = ['beforeChat']
      if (!knownHooks.includes(hookName)) {
        console.error(`Unknown hook "${hookName}". Available hooks: ${knownHooks.join(', ')}`)
        process.exit(1)
      }
      const current = hooks[hookName]?.enabled ?? true
      hooks[hookName] = { enabled: !current }
      config.hooks = hooks
      // Ensure dir exists
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

  // `yu tool list | inspect <name>` — tool registry inspection
  if (args[0] === 'tool') {
    const sub = args[1] || 'help'
    const { listTools, getTool } = await import('../extension/tools/registry.js')

    if (sub === 'list') {
      const tools = listTools()
      if (tools.length === 0) {
        console.log('No tools registered.')
      } else {
        console.log(`Registered tools (${tools.length}):`)
        for (const t of tools) {
          const hasSchema = t.parameters?.properties ? Object.keys(t.parameters.properties).length > 0 : false
          console.log(`  ${t.name}`)
          console.log(`    Description: ${t.description}`)
          console.log(`    Parameters: ${hasSchema ? Object.keys(t.parameters.properties || {}).join(', ') : 'none'}`)
          if (t.enabled === false) console.log(`    Status: disabled`)
          if (t.enhancement?.auth) {
            const auth = t.enhancement.auth
            const parts: string[] = []
            if (auth.requiredRoles?.length) parts.push(`require: ${auth.requiredRoles.join(', ')}`)
            if (auth.denyRoles?.length) parts.push(`deny: ${auth.denyRoles.join(', ')}`)
            if (parts.length) console.log(`    Auth: ${parts.join('; ')}`)
          }
          if (t.enhancement?.timeout) {
            console.log(`    Timeout: ${t.enhancement.timeout}ms`)
          }
          console.log('')
        }
      }
      process.exit(0)
    }

    if (sub === 'inspect') {
      const name = args[2]
      if (!name) {
        console.error('Usage: yu tool inspect <name>')
        process.exit(1)
      }
      const tool = getTool(name)
      if (!tool) {
        console.error(`Tool not found: ${name}`)
        process.exit(1)
      }
      console.log(`Tool: ${tool.name}`)
      console.log(`  Description: ${tool.description}`)
      console.log(`  Parameters: ${JSON.stringify(tool.parameters, null, 4)}`)
      if (tool.enabled !== undefined) {
        console.log(`  Enabled: ${tool.enabled}`)
      }
      if (tool.enhancement) {
        console.log(`  Enhancement:`)
        if (tool.enhancement.auth) {
          console.log(`    Auth: ${JSON.stringify(tool.enhancement.auth, null, 4)}`)
        }
        if (tool.enhancement.timeout) {
          console.log(`    Timeout: ${tool.enhancement.timeout}ms`)
        }
        if (tool.enhancement.schema) {
          console.log(`    Schema: <zod validator>`)
        }
        if (tool.enhancement.audit) {
          console.log(
            `    Audit hooks: before=${!!tool.enhancement.audit.before}, after=${!!tool.enhancement.audit.after}, error=${!!tool.enhancement.audit.error}`,
          )
        }
      }
      process.exit(0)
    }

    if (sub === 'toggle') {
      const name = args[2]
      if (!name) {
        console.error('Usage: yu tool toggle <name>')
        process.exit(1)
      }
      const { toggleTool } = await import('../extension/tools/registry.js')
      const result = await toggleTool(name)
      if (result === null) {
        console.error(`Tool not found: ${name}`)
        process.exit(1)
      }
      console.log(`Tool "${name}" is now ${result ? 'enabled' : 'disabled'}`)
      process.exit(0)
    }

    console.error('Usage:')
    console.error('  yu tool list              — list all registered tools')
    console.error('  yu tool inspect <name>    — inspect a specific tool')
    console.error('  yu tool toggle <name>     — enable/disable a tool')
    process.exit(1)
  }

  // `yu mcp <subcommand>` — MCP server management
  if (args[0] === 'mcp') {
    const sub = args[1] || 'list'

    if (sub === 'list') {
      const { existsSync, readFileSync } = await import('fs')
      const { resolve } = await import('path')
      const { homedir } = await import('os')
      const configPath = resolve(homedir(), '.yu', 'mcp.config.json')
      const statusPath = resolve(homedir(), '.yu', 'mcp.json')

      // Read config
      let configured: string[] = []
      if (existsSync(configPath)) {
        try {
          const raw = readFileSync(configPath, 'utf-8')
          const config = JSON.parse(raw)
          configured = Object.keys(config.servers || {})
        } catch {
          /* ignore */
        }
      }

      // Read status
      const statusMap: Record<string, { status: string; tools?: string[]; error?: string }> = {}
      if (existsSync(statusPath)) {
        try {
          const raw = readFileSync(statusPath, 'utf-8')
          const statusData = JSON.parse(raw)
          for (const s of statusData.servers || []) {
            statusMap[s.name] = s
          }
        } catch {
          /* ignore */
        }
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
      const command = args[3]
      if (!name || !command) {
        console.error('Usage: yu mcp add <name> <command> [args...]')
        process.exit(1)
      }
      const extraArgs = args.slice(4)
      const { resolve } = await import('path')
      const { homedir } = await import('os')
      const { existsSync, readFileSync, writeFileSync } = await import('fs')
      const configPath = resolve(homedir(), '.yu', 'mcp.config.json')

      let config: { servers: Record<string, { command: string; args?: string[] }> } = { servers: {} }
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, 'utf-8'))
        } catch {
          /* ignore */
        }
      }
      if (!config.servers) config.servers = {}

      config.servers[name] = { command, args: extraArgs.length > 0 ? extraArgs : undefined }
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
      const { resolve } = await import('path')
      const { homedir } = await import('os')
      const { existsSync, readFileSync, writeFileSync } = await import('fs')
      const configPath = resolve(homedir(), '.yu', 'mcp.config.json')

      let config: { servers: Record<string, unknown> } = { servers: {} }
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, 'utf-8'))
        } catch {
          /* ignore */
        }
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

  // `yu run <prompt>` — scheduler dispatch with optional --agent and --bg
  // Classifies intent → pass_through to chat agent, or dispatch to
  // coding/search/review/etc. Replaces the old hardcoded coding-agent spawn.
  if (args[0] === 'run') {
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
    // Remove --bg/--background flag
    const finalArgs = filtered.filter((a) => a !== '--bg' && a !== '--background')
    if (filtered.length !== finalArgs.length) isBackground = true
    const prompt = finalArgs.join(' ')
    if (!prompt) {
      console.error('Usage: yu run [--agent <name>] [--bg] <prompt>')
      process.exit(1)
    }

    // Validate agent name if specified
    if (agentName) {
      const mod = await import('../extension/config.js')
      const { getAgentTypeConfig } = mod
      if (!getAgentTypeConfig(agentName)) {
        console.error(`Unknown agent type: "${agentName}"`)
        console.error(`Available: ${Object.keys(mod.AGENT_TYPES || {}).join(', ')}`)
        process.exit(1)
      }
      if (!isBackground) console.error(`  Using agent: ${agentName}`)
    }

    if (isBackground) {
      const { handler } = await import('../extension/scheduler.js')
      const result = await handler(prompt, { agentType: agentName, background: true })
      if (result !== null) {
        console.log(result)
      }
      return
    }

    const { handler } = await import('../extension/scheduler.js')
    const result = await handler(prompt, { agentType: agentName })
    if (result !== null) {
      console.log(result)
    }
    return
  }

  // `yu bg <subcommand>` — background task management
  if (args[0] === 'bg') {
    const sub = args[1] || 'list'
    const { bg } = await import('../extension/background.js')

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

  // `yu supervisor <subcommand>` — supervisor management
  if (args[0] === 'supervisor') {
    const sub = args[1] || 'help'
    const supervisorArgs = args.slice(2)
    const { supervisorCommand } = await import('../extension/supervisor.js')
    const out = supervisorCommand(sub, supervisorArgs)
    console.log(out)
    process.stdout.write('\n')
    process.exit(0)
  }

  // `yu rule <subcommand>` — rule (orchestrator) management
  if (args[0] === 'rule') {
    const sub = args[1] || 'help'
    const ruleArgs = args.slice(2)

    if (sub === 'help') {
      const { showHelpForCommand } = await import('./help.js')
      console.log(showHelpForCommand('rule'))
      process.exit(0)
    }

    // Read rules from orchestrator.json
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

  // `yu role <subcommand>` — role management
  if (args[0] === 'role') {
    const sub = args[1] || 'help'
    const roleArgs = args.slice(2)
    const { ruleCommand } = await import('../extension/rules/index.js')
    const out = await ruleCommand(sub, roleArgs)
    console.log(out)
    process.exit(0)
  }

  // `yu skill <subcommand>` — skill management (delegates to extension/skills/index.ts)
  if (args[0] === 'skill') {
    const sub = args[1] || 'help'
    const skillArgs = args.slice(2)
    const { skillCommand } = await import('../extension/skills/index.js')
    const out = await skillCommand(sub, skillArgs)
    console.log(out)
    process.exit(0)
  }

  // `yu topic <subcommand>` — topic management
  // For `bg` subcommand, cmdBg() atomically sets status='background',
  // ensures the supervisor daemon is running (spawns if needed),
  // and returns a confirmation message. The CLI exits immediately
  // while the daemon picks up the task asynchronously.
  if (args[0] === 'topic') {
    const sub = args[1] || 'help'
    const topicArgs = args.slice(2)
    const { topicCommand } = await import('../extension/topic.js')
    const out = topicCommand(sub, topicArgs)
    console.log(out)
    process.exit(0)
  }

  // `yu search <query>` — semantic code search via CodeGraph
  if (args[0] === 'search') {
    const query = args.slice(1).join(' ')
    if (!query) {
      console.error('Usage: yu search <query>')
      process.exit(1)
    }
    const cgPath = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'codegraph')
    try {
      const proc = Bun.spawnSync([cgPath, 'query', query, '--limit', '15'], {
        cwd: PROJECT_ROOT,
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

  // `yu graph <symbol>` — show callers/callees
  if (args[0] === 'graph') {
    const symbol = args.slice(1).join(' ')
    if (!symbol) {
      console.error('Usage: yu graph <symbol>')
      process.exit(1)
    }
    const cgPath = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'codegraph')
    try {
      console.log('=== Callers ===')
      const callersProc = Bun.spawnSync([cgPath, 'callers', symbol, '--limit', '10'], {
        cwd: PROJECT_ROOT,
        timeout: 10000,
      })
      if (callersProc.exitCode === 0) {
        console.log(callersProc.stdout.toString())
      }
      console.log('=== Callees ===')
      const calleesProc = Bun.spawnSync([cgPath, 'callees', symbol, '--limit', '10'], {
        cwd: PROJECT_ROOT,
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

  // `yu context <task>` — build task context
  if (args[0] === 'context') {
    const task = args.slice(1).join(' ')
    if (!task) {
      console.error('Usage: yu context <task description>')
      process.exit(1)
    }
    const cgPath = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'codegraph')
    try {
      const proc = Bun.spawnSync([cgPath, 'context', task], {
        cwd: PROJECT_ROOT,
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

  // `yu refactor <action>` — AST-aware refactoring
  if (args[0] === 'refactor') {
    const action = args[1] || 'help'
    const refactorArgs = args.slice(2)
    const { refactorCommand } = await import('../extension/refactor/index.js')
    const result = await refactorCommand(action, refactorArgs)
    console.log(result)
    process.exit(0)
  }

  // `yu monitor` — live dashboard
  if (args[0] === 'monitor') {
    const scriptPath = resolve(PROJECT_ROOT, 'scripts', 'monitor.ts')
    await import(scriptPath)
    return
  }

  // `yu ui` — launch Web UI
  if (args[0] === 'ui') {
    const { createServer } = await import('../webui/server.js')
    await createServer()
    // Keep process alive
    await new Promise(() => {})
    return
  }

  // Subcommand dispatch (Pi-managed commands)
  if (args[0] && COMMANDS.has(args[0])) {
    const command = args.shift()!
    const rest = args.join(' ')
    const piArgs = ['--print']
    if (rest) {
      piArgs.push(`/${command} ${rest}`)
    } else {
      piArgs.push(`/${command}`)
    }

  // Pi SDK 模块类型（可选依赖）
  interface PiSdkModule {
    main: (args: string[], opts: { extensionFactories: unknown[][] }) => Promise<void>
    subagents?: unknown[]
    yuAgent?: unknown
  }

    // Dynamic import for Pi SDK (optional dependency)
    const piMod = await import('@tintinweb/pi-subagents').catch(() => null) as PiSdkModule | null
    if (!piMod) {
      console.error('Pi SDK not available, cannot run command:', command)
      process.exit(1)
    }
    const piMain = piMod.main
    const piSubagents = piMod.subagents ?? []
    const piYuAgent = (piMod.yuAgent ?? []) as unknown[]
    await piMain(piArgs, {
      extensionFactories: [piSubagents, piYuAgent],
    })
    await printCacheStats()
    return
  }

  // ── Slash 路由 ────────────────────────────────────────
  // 直接解析 /topic、/memory 等命令，不经过 Pi 或 classifier
  if (args[0]?.startsWith('/')) {
    const slashCmd = args[0].slice(1)
    const slashArgs = args.slice(1)

    if (slashCmd === 'topic' || slashCmd === 't') {
      const sub = slashArgs[0] || 'list'
      const { topicCommand } = await import('../extension/topic.js')
      const out = topicCommand(sub, slashArgs.slice(1))
      console.log(out)
      return
    }

    if (slashCmd === 'memory' || slashCmd === 'mem') {
      // /memory falls through to Pi's subagent system
      // (no direct handler — Pi manages session memory)
    }

    // Unknown slash — fall through to Pi
  }

  // Default: check if non-coding → use chat agent directly
  const query = args.join(' ')
  if (query) {
    try {
      const { classifyIntent } = await import('../extension/classifier.js')
      const plan = await classifyIntent(query, {})
      // Route to chat agent if: pass_through explicitly, OR no intent/agents,
      // OR intent is none of the known work intents (non-coding general chat)
      const isPassThrough = plan.pass_through === true
      const isGeneralQuery =
        !plan.intent ||
        !['coding', 'review', 'commit', 'lsp', 'doc', 'refactor', 'team', 'search'].includes(plan.intent)
      if (isPassThrough || isGeneralQuery) {
        // Non-coding task: use chat.md prompt directly via DeepSeek API
        const { chatCompletion } = await import('../extension/deepseek.js')
        const { readFileSync, existsSync } = await import('fs')
        const { resolve: resolvePath } = await import('path')
        const promptsDir = resolvePath(PROJECT_ROOT, 'prompts')
        const chatPromptPath = resolvePath(promptsDir, 'chat.md')
        let systemPrompt = ''
        if (existsSync(chatPromptPath)) {
          systemPrompt = readFileSync(chatPromptPath, 'utf-8')
        }
        const result = await chatCompletion({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt || 'You are a concise, direct assistant.' },
            { role: 'user', content: query },
          ],
          max_tokens: 2048,
          temperature: 0.7,
        })
        if (result?.choices?.[0]?.message?.content) {
          console.log(result.choices[0].message.content)
          await printCacheStats()
          return
        }
      }
    } catch {
      // Scheduler classification failed — fall through to Pi
    }
  }

  // Default: run via AgentLoop (取代旧的 Pi main() 回退)
  // ── Session tracking ──────────────────────────────
  const YU_HOME_DIR = resolve(process.env.HOME || '/home/saltfish', '.yu')
  const LAST_SESSION_FILE = resolve(YU_HOME_DIR, '.last_session')
  const SESSIONS_DIR = resolve(YU_HOME_DIR, 'sessions')

  function getLastSessionId(): string | null {
    try {
      if (existsSync(LAST_SESSION_FILE)) {
        const tag = readFileSync(LAST_SESSION_FILE, 'utf-8').trim()
        return tag || null
      }
    } catch {
      /* ignore */
    }
    return null
  }

  function saveLastSessionId(tag: string): void {
    try {
      mkdirSync(YU_HOME_DIR, { recursive: true })
      writeFileSync(LAST_SESSION_FILE, tag, 'utf-8')
    } catch {
      /* ignore */
    }
  }

  // ── --new 标志 ────────────────────────────────────
  const forceNew = args.includes('--new')
  const cleanArgs = args.filter((a) => a !== '--new')
  const prompt = cleanArgs.join(' ')

  // ── 无参数 → 自动续接上次 session ─────────────────
  if (!prompt) {
    const lastId = getLastSessionId()
    if (lastId && existsSync(resolve(SESSIONS_DIR, `${lastId}.json`))) {
      const { ContextManager } = await import('../extension/context-manager.js')
      const ctx = ContextManager.load(lastId)
      if (ctx) {
        const msgs = ctx.getMessages()
        const msgCount = msgs.length
        const lastMsg = msgs[msgs.length - 1]
        console.error(`\n  ⤿ Resuming session ${lastId.slice(0, 8)}… (${msgCount} messages)`)
        if (lastMsg?.content) {
          const preview = lastMsg.content.slice(0, 120)
          console.error(`  Last: ${preview}${lastMsg.content.length > 120 ? '…' : ''}`)
        }
        console.error(`  ───────────────────────────────────`)
        console.error(`  Enter your next message, or --new to start fresh.\n`)
        // Interactive prompt
        process.stdout.write('  > ')
        for await (const line of console) {
          if (!line.trim()) {
            process.stdout.write('  > ')
            continue
          }
          if (line === '--new') {
            console.error('  Starting fresh session.')
            break
          }
          const { runAgent } = await import('../extension/agent-loop.js')
          const result = await runAgent(line, { sessionId: lastId })
          if (result.success) {
            console.log(result.output)
            saveLastSessionId(lastId)
            if (result.cacheStats) {
              const pct = Math.round(result.cacheStats.hitRate * 100)
              console.error(
                `\n── (${result.iterations} iters, ${result.totalTokens} tokens, cache ${pct}%, ${result.compressCount ?? 0} compressions) ──`,
              )
            }
            await printCacheStats({
              cacheHitTokens: result.cacheStats?.cacheHitTokens,
              cacheMissTokens: result.cacheStats?.cacheMissTokens,
              outputTokens: result.totalTokens,
            })
          }
          process.stdout.write('\n  > ')
        }
        return
      }
    }
    console.log(HELP_TEXT)
    return
  }

  if (prompt) {
    try {
      // Use last session for continuation unless --new was specified
      const sessionId = forceNew ? undefined : getLastSessionId()
      const { runAgent } = await import('../extension/agent-loop.js')
      const result = await runAgent(prompt, sessionId ? { sessionId } : undefined)
      if (result.success) {
        console.log(result.output)
        // Save session ID for next continuation (AgentLoop auto-generates one if not provided)
        const sessionsDir = resolve(process.env.HOME || '/home/saltfish', '.yu', 'sessions')
        const sessionFiles = existsSync(sessionsDir)
          ? readdirSync(sessionsDir)
              .filter((f) => f.endsWith('.json'))
              .sort()
              .reverse()
          : []
        // Use the most recently modified session file
        if (sessionFiles.length > 0) {
          const latest = sessionFiles[0].replace(/\.json$/, '')
          saveLastSessionId(latest)
        }
        if (result.cacheStats) {
          const pct = Math.round(result.cacheStats.hitRate * 100)
          console.log(
            `\n── (${result.iterations} iters, ${result.totalTokens} tokens, cache ${pct}%, ${result.compressCount ?? 0} compressions) ──`,
          )
        }
        await printCacheStats()
        return
      }
      console.error(result.error || 'Agent returned no output')
      return
    } catch (err) {
      console.error('yu-agent error:', err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  }

  // 无参数 — 显示帮助
  console.log(HELP_TEXT)
}

// ── Graceful shutdown handlers ──────────────────────────
process.on('SIGTERM', () => shutdownManager.shutdown('SIGTERM').then(() => process.exit(143)))
process.on('SIGINT', () => shutdownManager.shutdown('SIGINT').then(() => process.exit(130)))

shutdownManager.registerHandler('close-db', async () => {
  const { closeDb } = await import('../extension/db.js')
  const { flushLogs } = await import('../extension/logger.js')
  await flushLogs?.()
  closeDb?.()
})
shutdownManager.registerHandler('stop-mcp', async () => {
  const { stopMCPManager } = await import('../extension/mcp-manager.js')
  await stopMCPManager?.()
})

// ── Entry ──────────────────────────────────────────────
// Direct invocation: run mainCli()
// Programmatic: use createApp().then(app => app.run())
mainCli().catch((err) => {
  console.error('yu-agent error:', err)
  process.exit(1)
})
