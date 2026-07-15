import { createLogger } from '../logger.js'
import type { CacheRow, MessageRow, SessionMeta, SummaryRow, TodoRow } from './db-core.js'
import { getDb } from './db-core.js'

const log = createLogger('db-entities')

// ── Session metadata ─────────────────────────────────────

export function upsertSession(
  tag: string,
  data: {
    name?: string
    cwd?: string
    agent?: string
    model?: string
    parentId?: string
    slug?: string
    metadata?: string
  },
): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(`
    INSERT INTO sessions (tag, name, cwd, agent, model, parent_id, slug, archived_at, metadata, summary_files, summary_additions, summary_deletions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET
      name = COALESCE(NULLIF(?, ''), sessions.name),
      cwd = COALESCE(NULLIF(?, ''), sessions.cwd),
      agent = COALESCE(NULLIF(?, ''), sessions.agent),
      model = COALESCE(NULLIF(?, ''), sessions.model),
      parent_id = COALESCE(NULLIF(?, ''), sessions.parent_id),
      slug = COALESCE(NULLIF(?, ''), sessions.slug),
      metadata = COALESCE(NULLIF(?, ''), sessions.metadata),
      updated_at = ?
  `).run(
    tag,
    data.name ?? '',
    data.cwd ?? '',
    data.agent ?? '',
    data.model ?? '',
    data.parentId ?? '',
    data.slug ?? '',
    data.metadata ?? '{}',
    now,
    now,
    data.name ?? '',
    data.cwd ?? '',
    data.agent ?? '',
    data.model ?? '',
    data.parentId ?? '',
    data.slug ?? '',
    data.metadata ?? '{}',
    now,
  )
}

export function getSessionMeta(tag: string): SessionMeta | null {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT tag, name, cwd, agent, model, parent_id, slug, archived_at, metadata, summary_files, summary_additions, summary_deletions, created_at, updated_at FROM sessions WHERE tag = ?',
    )
    .get(tag) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    tag: row.tag as string,
    name: row.name as string,
    cwd: row.cwd as string,
    agent: row.agent as string,
    model: row.model as string,
    parentId: row.parent_id as string,
    slug: (row.slug as string) || '',
    archivedAt: row.archived_at as number,
    metadata: row.metadata as string,
    summaryFiles: (row.summary_files as number) || 0,
    summaryAdditions: (row.summary_additions as number) || 0,
    summaryDeletions: (row.summary_deletions as number) || 0,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }
}

export function listSessions(): SessionMeta[] {
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT tag, name, cwd, agent, model, parent_id, slug, archived_at, metadata, summary_files, summary_additions, summary_deletions, created_at, updated_at FROM sessions ORDER BY updated_at DESC',
    )
    .all() as Record<string, unknown>[]
  return rows.map((r) => ({
    tag: r.tag as string,
    name: r.name as string,
    cwd: r.cwd as string,
    agent: r.agent as string,
    model: r.model as string,
    parentId: r.parent_id as string,
    slug: (r.slug as string) || '',
    archivedAt: r.archived_at as number,
    metadata: r.metadata as string,
    summaryFiles: (r.summary_files as number) || 0,
    summaryAdditions: (r.summary_additions as number) || 0,
    summaryDeletions: (r.summary_deletions as number) || 0,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  }))
}

export function deleteSession(tag: string): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM sessions WHERE tag = ?').run(tag)
    db.prepare('DELETE FROM agents WHERE tag = ?').run(tag)
    db.prepare('DELETE FROM mcp WHERE tag = ?').run(tag)
    db.prepare('DELETE FROM lsp WHERE tag = ?').run(tag)
    db.prepare('DELETE FROM team WHERE tag = ?').run(tag)
    db.prepare('DELETE FROM summary WHERE tag = ?').run(tag)
    db.prepare('DELETE FROM cache WHERE tag = ?').run(tag)
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(tag)
    db.prepare('DELETE FROM todos WHERE session_id = ?').run(tag)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ── Agents ───────────────────────────────────────────────

export function upsertAgents(tag: string, agentsJson: string, updatedAt: number = Date.now()): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO agents (tag, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = ?
  `).run(tag, agentsJson, updatedAt, agentsJson, updatedAt)
}

export function getAgents(tag: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT data FROM agents WHERE tag = ?').get(tag) as { data: string } | undefined
  return row?.data ?? null
}

// ── MCP ──────────────────────────────────────────────────

export function upsertMCP(tag: string, dataJson: string, updatedAt: number = Date.now()): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO mcp (tag, data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = ?
    `).run(tag, dataJson, updatedAt, dataJson, updatedAt)
  } catch (err: unknown) {
    // MCP status writing is non-critical — log and move on
    const msg = err instanceof Error ? err.message : String(err)
    log.warn(`upsertMCP failed (non-critical): ${msg}`)
  }
}

export function getMCP(tag: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT data FROM mcp WHERE tag = ?').get(tag) as { data: string } | undefined
  return row?.data ?? null
}

// ── LSP ──────────────────────────────────────────────────

export function upsertLSP(tag: string, dataJson: string, updatedAt: number = Date.now()): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO lsp (tag, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = ?
  `).run(tag, dataJson, updatedAt, dataJson, updatedAt)
}

export function getLSP(tag: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT data FROM lsp WHERE tag = ?').get(tag) as { data: string } | undefined
  return row?.data ?? null
}

// ── Team ─────────────────────────────────────────────────

export function upsertTeam(tag: string, dataJson: string, updatedAt: number = Date.now()): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO team (tag, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = ?
  `).run(tag, dataJson, updatedAt, dataJson, updatedAt)
}

export function getTeam(tag: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT data FROM team WHERE tag = ?').get(tag) as { data: string } | undefined
  return row?.data ?? null
}

// ── Summary ──────────────────────────────────────────────

export function upsertSummary(
  tag: string,
  data: {
    running?: number
    completed?: number
    failed?: number
    mcpConnected?: number
    lspReady?: number
  },
  updatedAt: number = Date.now(),
): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO summary (tag, running, completed, failed, mcp_connected, lsp_ready, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET
      running = ?, completed = ?, failed = ?,
      mcp_connected = ?, lsp_ready = ?, updated_at = ?
  `).run(
    tag,
    data.running ?? 0,
    data.completed ?? 0,
    data.failed ?? 0,
    data.mcpConnected ?? 0,
    data.lspReady ?? 0,
    updatedAt,
    data.running ?? 0,
    data.completed ?? 0,
    data.failed ?? 0,
    data.mcpConnected ?? 0,
    data.lspReady ?? 0,
    updatedAt,
  )
}

export function getSummary(tag: string): SummaryRow | null {
  const db = getDb()
  const row = db
    .prepare('SELECT running, completed, failed, mcp_connected, lsp_ready, updated_at FROM summary WHERE tag = ?')
    .get(tag) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    running: row.running as number,
    completed: row.completed as number,
    failed: row.failed as number,
    mcp_connected: row.mcp_connected as number,
    lsp_ready: row.lsp_ready as number,
    updatedAt: row.updated_at as number,
  }
}

// ── Cache ────────────────────────────────────────────────

export function upsertCache(
  tag: string,
  data: {
    totalHits?: number
    totalMisses?: number
    totalOutput?: number
    totalCost?: number
    turnCount?: number
    hitRate?: number
  },
  updatedAt: number = Date.now(),
): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO cache (tag, total_hits, total_misses, total_output, total_cost, turn_count, hit_rate, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tag) DO UPDATE SET
      total_hits = ?, total_misses = ?, total_output = ?, total_cost = ?,
      turn_count = ?, hit_rate = ?, updated_at = ?
  `).run(
    tag,
    data.totalHits ?? 0,
    data.totalMisses ?? 0,
    data.totalOutput ?? 0,
    data.totalCost ?? 0,
    data.turnCount ?? 0,
    data.hitRate ?? 0,
    updatedAt,
    data.totalHits ?? 0,
    data.totalMisses ?? 0,
    data.totalOutput ?? 0,
    data.totalCost ?? 0,
    data.turnCount ?? 0,
    data.hitRate ?? 0,
    updatedAt,
  )
}

export function getCache(tag: string): CacheRow | null {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT total_hits, total_misses, total_output, total_cost, turn_count, hit_rate, updated_at FROM cache WHERE tag = ?',
    )
    .get(tag) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    totalHits: row.total_hits as number,
    totalMisses: row.total_misses as number,
    totalOutput: row.total_output as number,
    totalCost: row.total_cost as number,
    turnCount: row.turn_count as number,
    hitRate: row.hit_rate as number,
    updatedAt: row.updated_at as number,
  }
}

// ── Messages (P0 — conversation history) ────────────────

export function insertMessage(
  sessionId: string,
  role: string,
  content: string,
  timeCreated: number = Date.now(),
  reasoning?: string | null,
): number {
  const db = getDb()
  const result = db
    .prepare('INSERT INTO messages (session_id, role, content, time_created, reasoning) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, role, content, timeCreated, reasoning ?? null)
  return Number(result.lastInsertRowid)
}

export function getMessages(sessionId: string, limit?: number): MessageRow[] {
  const db = getDb()
  const sql = limit
    ? 'SELECT id, session_id, role, content, reasoning, time_created FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?'
    : 'SELECT id, session_id, role, content, reasoning, time_created FROM messages WHERE session_id = ? ORDER BY id ASC'
  const params: (string | number | null)[] = [sessionId]
  if (limit) params.push(limit)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  const result = rows.map((r) => ({
    id: r.id as number,
    sessionId: r.session_id as string,
    role: r.role as string,
    content: r.content as string,
    reasoning: (r.reasoning as string) ?? null,
    timeCreated: r.time_created as number,
  }))
  // If limit was used, reverse to chronological order
  if (limit) result.reverse()
  return result
}

export function getMessageCount(sessionId: string): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?').get(sessionId) as { cnt: number }
  return row.cnt
}

/** Cursor pagination: N messages older than beforeId */
export function getMessagesBefore(sessionId: string, beforeId: number, limit: number = 20): MessageRow[] {
  const db = getDb()
  const rows = db.prepare('SELECT id, session_id, role, content, reasoning, time_created FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
    .all(sessionId, beforeId, limit) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as number, sessionId: r.session_id as string, role: r.role as string,
    content: r.content as string, timeCreated: r.time_created as number,
  })).reverse()
}

// ── Todos (P1 — per-session task list) ──────────────────

export function insertTodo(
  sessionId: string,
  content: string,
  priority: string = 'medium',
  position?: number,
  timeCreated: number = Date.now(),
  reasoning?: string | null,
): number {
  const db = getDb()
  // Auto-assign position if not given
  if (position === undefined) {
    const maxRow = db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM todos WHERE session_id = ?')
      .get(sessionId) as { pos: number }
    position = maxRow.pos
  }
  const result = db
    .prepare(
      'INSERT INTO todos (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(sessionId, content, 'pending', priority, position, timeCreated, timeCreated)
  return Number(result.lastInsertRowid)
}

export function getTodos(sessionId: string): TodoRow[] {
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT id, session_id, content, status, priority, position, time_created, time_updated FROM todos WHERE session_id = ? ORDER BY position ASC',
    )
    .all(sessionId) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as number,
    sessionId: r.session_id as string,
    content: r.content as string,
    status: r.status as string,
    priority: r.priority as string,
    position: r.position as number,
    timeCreated: r.time_created as number,
    timeUpdated: r.time_updated as number,
  }))
}

export function updateTodoStatus(id: number, status: string): void {
  const db = getDb()
  db.prepare('UPDATE todos SET status = ?, time_updated = ? WHERE id = ?').run(status, Date.now(), id)
}

export function updateTodoPriority(id: number, priority: string): void {
  const db = getDb()
  db.prepare('UPDATE todos SET priority = ?, time_updated = ? WHERE id = ?').run(priority, Date.now(), id)
}

export function deleteTodo(id: number): void {
  const db = getDb()
  db.prepare('DELETE FROM todos WHERE id = ?').run(id)
}
