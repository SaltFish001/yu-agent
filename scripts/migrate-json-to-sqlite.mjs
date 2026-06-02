#!/usr/bin/env node
/**
 * 迁移旧 JSON session 文件到 SQLite。
 *
 * 扫描 ~/yu-agent/status/（或指定目录）下的 *.{tag}.json，
 * 将数据写入 sessions.db。
 *
 * Usage:
 *   node scripts/migrate-json-to-sqlite.mjs [--dir ~/yu-agent/status]
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const STATUS_DIR = resolve(homedir(), 'yu-agent', 'status');
const _ALT_STATUS_DIR = resolve(homedir(), '.yu-agent', 'status');
const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const targetDir = dirIdx !== -1 && dirIdx + 1 < args.length
  ? resolve(args[dirIdx + 1])
  : STATUS_DIR;

const dbPath = resolve(targetDir, 'sessions.db');

// ── Open/create DB ──────────────────────────────────────

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    tag TEXT PRIMARY KEY, name TEXT DEFAULT '', cwd TEXT DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    tag TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mcp (
    tag TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lsp (
    tag TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS team (
    tag TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS summary (
    tag TEXT PRIMARY KEY, running INTEGER DEFAULT 0, completed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0, mcp_connected INTEGER DEFAULT 0,
    lsp_ready INTEGER DEFAULT 0, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cache (
    tag TEXT PRIMARY KEY, total_hits INTEGER DEFAULT 0, total_misses INTEGER DEFAULT 0,
    total_cost REAL DEFAULT 0, turn_count INTEGER DEFAULT 0,
    hit_rate REAL DEFAULT 0, updated_at INTEGER NOT NULL
  );
`);

// ── Scan JSON files ─────────────────────────────────────

if (!existsSync(targetDir)) {
  console.error(`Directory not found: ${targetDir}`);
  process.exit(1);
}

const files = readdirSync(targetDir);
const tagMap = new Map(); // tag -> { type -> content }

for (const f of files) {
  const m = f.match(/^(agents|summary|cache|session|mcp|lsp|team)\.(.+)\.json$/);
  if (!m) continue;

  const type = m[1];
  const tag = m[2];
  const fullPath = resolve(targetDir, f);

  try {
    const content = readFileSync(fullPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!tagMap.has(tag)) tagMap.set(tag, new Map());
    tagMap.get(tag).set(type, { content: parsed, path: fullPath });
  } catch (e) {
    console.warn(`  [skip] ${f}: ${e.message}`);
  }
}

if (tagMap.size === 0) {
  console.log(`No JSON session files found in ${targetDir}`);
  db.close();
  process.exit(0);
}

// ── Import into SQLite ──────────────────────────────────

const upsertSessionStmt = db.prepare(`
  INSERT INTO sessions (tag, name, cwd, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(tag) DO UPDATE SET
    name = COALESCE(NULLIF(?, ''), sessions.name),
    cwd = COALESCE(NULLIF(?, ''), sessions.cwd),
    updated_at = MAX(updated_at, ?)
`);

const upsertAgentsStmt = db.prepare(`
  INSERT INTO agents (tag, data, updated_at)
  VALUES (?, ?, ?) ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = MAX(updated_at, ?)
`);
const upsertSummaryStmt = db.prepare(`
  INSERT INTO summary (tag, running, completed, failed, mcp_connected, lsp_ready, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tag) DO UPDATE SET
    running = ?, completed = ?, failed = ?, mcp_connected = ?, lsp_ready = ?,
    updated_at = MAX(updated_at, ?)
`);
const upsertCacheStmt = db.prepare(`
  INSERT INTO cache (tag, total_hits, total_misses, total_cost, turn_count, hit_rate, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tag) DO UPDATE SET
    total_hits = ?, total_misses = ?, total_cost = ?, turn_count = ?, hit_rate = ?,
    updated_at = MAX(updated_at, ?)
`);
const upsertMCPStmt = db.prepare(`
  INSERT INTO mcp (tag, data, updated_at)
  VALUES (?, ?, ?) ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = MAX(updated_at, ?)
`);
const upsertLSPStmt = db.prepare(`
  INSERT INTO lsp (tag, data, updated_at)
  VALUES (?, ?, ?) ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = MAX(updated_at, ?)
`);
const upsertTeamStmt = db.prepare(`
  INSERT INTO team (tag, data, updated_at)
  VALUES (?, ?, ?) ON CONFLICT(tag) DO UPDATE SET data = ?, updated_at = MAX(updated_at, ?)
`);

let imported = 0;

for (const [tag, entries] of tagMap) {
  const updatedAt = Date.now();
  const ups = [];

  // Session metadata
  const sessionData = entries.get('session');
  if (sessionData) {
    const c = sessionData.content;
    const name = c.name || tag;
    const cwd = c.cwd || '';
    const ts = c.updatedAt || updatedAt;
    ups.push(['session', tag, name, cwd, ts]);
  }

  // Agents
  const agentsData = entries.get('agents');
  if (agentsData) {
    const ts = agentsData.content.updatedAt || updatedAt;
    upsertAgentsStmt.run(tag, JSON.stringify(agentsData.content), ts, JSON.stringify(agentsData.content), ts);
    ups.push(['agents', tag]);
  }

  // Summary
  const summaryData = entries.get('summary');
  if (summaryData) {
    const c = summaryData.content;
    const ts = c.updatedAt || updatedAt;
    upsertSummaryStmt.run(tag, c.running || 0, c.completed || 0, c.failed || 0, c.mcpConnected || 0, c.lspReady || 0, ts,
      c.running || 0, c.completed || 0, c.failed || 0, c.mcpConnected || 0, c.lspReady || 0, ts);
    ups.push(['summary', tag]);
  }

  // Cache
  const cacheData = entries.get('cache');
  if (cacheData) {
    const c = cacheData.content;
    const ts = c.updatedAt || updatedAt;
    upsertCacheStmt.run(tag, c.totalHits || 0, c.totalMisses || 0, c.totalCost || 0, c.turnCount || 0, c.hitRate || 0, ts,
      c.totalHits || 0, c.totalMisses || 0, c.totalCost || 0, c.turnCount || 0, c.hitRate || 0, ts);
    ups.push(['cache', tag]);
  }

  // MCP
  const mcpData = entries.get('mcp');
  if (mcpData) {
    const ts = mcpData.content.updatedAt || updatedAt;
    upsertMCPStmt.run(tag, JSON.stringify(mcpData.content), ts, JSON.stringify(mcpData.content), ts);
    ups.push(['mcp', tag]);
  }

  // LSP
  const lspData = entries.get('lsp');
  if (lspData) {
    const ts = lspData.content.updatedAt || updatedAt;
    upsertLSPStmt.run(tag, JSON.stringify(lspData.content), ts, JSON.stringify(lspData.content), ts);
    ups.push(['lsp', tag]);
  }

  // Team
  const teamData = entries.get('team');
  if (teamData) {
    const ts = teamData.content.updatedAt || updatedAt;
    upsertTeamStmt.run(tag, JSON.stringify(teamData.content), ts, JSON.stringify(teamData.content), ts);
    ups.push(['team', tag]);
  }

  // Write session metadata if we have any data
  if (sessionData) {
    const c = sessionData.content;
    upsertSessionStmt.run(tag, c.name || tag, c.cwd || '', c.updatedAt || updatedAt, c.updatedAt || updatedAt,
      c.name || tag, c.cwd || '', c.updatedAt || updatedAt);
  } else if (ups.length > 0) {
    // Auto-create session entry from first file's mtime
    const firstEntry = entries.values().next().value;
    const st = statSync(firstEntry.path);
    upsertSessionStmt.run(tag, tag, '', st.birthtimeMs, st.mtimeMs,
      tag, '', st.mtimeMs);
  }

  imported++;
  console.log(`  [ok] ${tag}: ${ups.map(u => u[0]).join(', ')}`);
}

console.log(`\nImported ${imported} session(s) from ${targetDir} into ${dbPath}`);
db.close();
