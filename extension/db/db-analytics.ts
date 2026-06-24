import { createLogger } from '../logger.js'
import { getDb } from './db-core.js'

const _log = createLogger('db-analytics')

export interface UpdateSummaryOptions {
  /** 'accumulate' (default): add values to existing counts (old updateSessionSummary behavior).
   *  'replace': overwrite existing counts (old updateSessionSummaryStats behavior). */
  mode?: 'accumulate' | 'replace'
}

/**
 * Update session summary stats. Merges the old updateSessionSummary (accumulate)
 * and updateSessionSummaryStats (replace) into one function with a mode parameter.
 */
export function updateSessionSummary(
  tag: string,
  data: {
    files?: number
    additions?: number
    deletions?: number
  },
  opts?: UpdateSummaryOptions,
): void {
  const db = getDb()
  const mode = opts?.mode ?? 'accumulate'
  const useAccumulate = mode === 'accumulate'

  if (useAccumulate) {
    db.prepare(`
      UPDATE sessions SET
        summary_files = summary_files + ?,
        summary_additions = summary_additions + ?,
        summary_deletions = summary_deletions + ?,
        updated_at = ?
      WHERE tag = ?
    `).run(data.files ?? 0, data.additions ?? 0, data.deletions ?? 0, Date.now(), tag)
  } else {
    db.prepare(`
      UPDATE sessions SET
        summary_files = ?,
        summary_additions = ?,
        summary_deletions = ?,
        updated_at = ?
      WHERE tag = ?
    `).run(data.files ?? 0, data.additions ?? 0, data.deletions ?? 0, Date.now(), tag)
  }
}

/** @deprecated Use updateSessionSummary with { mode: 'replace' } instead. */
export function updateSessionSummaryStats(
  tag: string,
  data: {
    files?: number
    additions?: number
    deletions?: number
  },
): void {
  updateSessionSummary(tag, data, { mode: 'replace' })
}

// ── Token Usage ──────────────────────────────────────────

export interface TokenUsageEntry {
  sessionTag: string
  agentType: string
  model: string
  cacheHitTokens?: number
  cacheMissTokens?: number
  outputTokens?: number
  totalTokens?: number
  cost?: number
  durationMs?: number
  turnCount?: number
}

export function insertTokenUsage(entry: TokenUsageEntry): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO token_usage (session_tag, agent_type, model, cache_hit_tokens, cache_miss_tokens, output_tokens, total_tokens, cost, duration_ms, turn_count, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionTag,
    entry.agentType,
    entry.model,
    entry.cacheHitTokens ?? 0,
    entry.cacheMissTokens ?? 0,
    entry.outputTokens ?? 0,
    entry.totalTokens ?? 0,
    entry.cost ?? 0,
    entry.durationMs ?? 0,
    entry.turnCount ?? 0,
    Date.now(),
  )
}

export function getTokenUsageBySession(sessionTag: string): {
  totalHits: number
  totalMisses: number
  totalOutput: number
  totalTokens: number
  totalCost: number
  totalDurationMs: number
  totalTurns: number
  count: number
} {
  const db = getDb()
  const row = db
    .prepare(`
    SELECT
      COALESCE(SUM(cache_hit_tokens), 0) AS total_hits,
      COALESCE(SUM(cache_miss_tokens), 0) AS total_misses,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost), 0) AS total_cost,
      COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
      COALESCE(SUM(turn_count), 0) AS total_turns,
      COUNT(*) AS count
    FROM token_usage
    WHERE session_tag = ?
  `)
    .get(sessionTag) as Record<string, unknown>
  return {
    totalHits: row.total_hits as number,
    totalMisses: row.total_misses as number,
    totalOutput: row.total_output as number,
    totalTokens: row.total_tokens as number,
    totalCost: row.total_cost as number,
    totalDurationMs: row.total_duration_ms as number,
    totalTurns: row.total_turns as number,
    count: row.count as number,
  }
}

export function getTokenUsageAggregate(): {
  totalHits: number
  totalMisses: number
  totalOutput: number
  totalTokens: number
  totalCost: number
  totalDurationMs: number
  totalTurns: number
  sessionCount: number
} {
  const db = getDb()
  const row = db
    .prepare(`
    SELECT
      COALESCE(SUM(cache_hit_tokens), 0) AS total_hits,
      COALESCE(SUM(cache_miss_tokens), 0) AS total_misses,
      COALESCE(SUM(output_tokens), 0) AS total_output,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost), 0) AS total_cost,
      COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
      COALESCE(SUM(turn_count), 0) AS total_turns,
      COUNT(DISTINCT session_tag) AS session_count
    FROM token_usage
  `)
    .get() as Record<string, unknown>
  return {
    totalHits: row.total_hits as number,
    totalMisses: row.total_misses as number,
    totalOutput: row.total_output as number,
    totalTokens: row.total_tokens as number,
    totalCost: row.total_cost as number,
    totalDurationMs: row.total_duration_ms as number,
    totalTurns: row.total_turns as number,
    sessionCount: row.session_count as number,
  }
}

// ── Agent Runs ───────────────────────────────────────────

export interface AgentRunEntry {
  sessionTag: string
  agentId: string
  agentType: string
  model: string
  status: string
  goal?: string
  files?: string[]
  startedAt: number
  durationMs?: number
  error?: string
}

export function insertAgentRun(entry: AgentRunEntry): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO agent_runs (session_tag, agent_id, agent_type, model, status, goal, files, started_at, duration_ms, error, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionTag,
    entry.agentId,
    entry.agentType,
    entry.model,
    entry.status,
    entry.goal ?? null,
    entry.files ? JSON.stringify(entry.files) : null,
    entry.startedAt,
    entry.durationMs ?? null,
    entry.error ?? null,
    Date.now(),
  )
}

export function updateAgentRunStatus(agentId: string, status: string, durationMs?: number, error?: string): void {
  const db = getDb()
  db.prepare(`
    UPDATE agent_runs SET
      status = ?,
      duration_ms = COALESCE(?, duration_ms),
      error = COALESCE(?, error),
      timestamp = ?
    WHERE agent_id = ?
  `).run(status, durationMs ?? null, error ?? null, Date.now(), agentId)
}

export function getAgentRunStats(): {
  total: number
  completed: number
  failed: number
  avgDurationMs: number
} & Record<string, { total: number; completed: number; failed: number; avgDurationMs: number }> {
  const db = getDb()
  const rows = db
    .prepare(`
    SELECT
      agent_type,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status IN ('failed', 'interrupted') THEN 1 ELSE 0 END) AS failed,
      COALESCE(AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE NULL END), 0) AS avg_duration_ms
    FROM agent_runs
    GROUP BY agent_type
  `)
    .all() as Record<string, unknown>[]

  const result: Record<string, { total: number; completed: number; failed: number; avgDurationMs: number }> = {}
  let total = 0
  let completed = 0
  let failed = 0
  let totalDuration = 0
  let durationCount = 0

  for (const row of rows) {
    const agentType = row.agent_type as string
    const t = row.total as number
    const c = row.completed as number
    const f = row.failed as number
    const avg = row.avg_duration_ms as number
    result[agentType] = {
      total: t,
      completed: c,
      failed: f,
      avgDurationMs: Math.round(avg),
    }
    total += t
    completed += c
    failed += f
    totalDuration += avg * t
    durationCount += t
  }

  return {
    ...result,
    total,
    completed,
    failed,
    avgDurationMs: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
  } as {
    total: number
    completed: number
    failed: number
    avgDurationMs: number
  } & Record<string, { total: number; completed: number; failed: number; avgDurationMs: number }>
}

// ── Logs ─────────────────────────────────────────────────

export function getRecentLogs(
  limit: number,
  level?: string,
  module?: string,
): {
  id: number
  timestamp: string
  level: string
  module: string
  message: string
  error: string | null
  data: string | null
}[] {
  const db = getDb()
  let sql = 'SELECT id, timestamp, level, module, message, error, data FROM logs WHERE 1=1'
  const params: (string | number)[] = []

  if (level) {
    sql += ' AND level = ?'
    params.push(level)
  }
  if (module) {
    sql += ' AND module = ?'
    params.push(module)
  }

  sql += ' ORDER BY id DESC LIMIT ?'
  params.push(limit)

  return db.prepare(sql).all(...params) as {
    id: number
    timestamp: string
    level: string
    module: string
    message: string
    error: string | null
    data: string | null
  }[]
}
