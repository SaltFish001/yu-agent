/**
 * yu-agent — Knowledge RAG (Phase 3).
 *
 * SQLite FTS5-based full-text search over project files.
 * Zero external dependencies — uses Node 24 built-in sqlite (DatabaseSync).
 *
 * Indexes:
 *   - .md files (full content)
 *   - .ts / .tsx files (extract JSDoc/TSDoc comments)
 *   - Architecture Decision Records (docs/adr/*.md or adr-*.md)
 *
 * Directory: ~/.yu/knowledge.db
 */

import { DatabaseSync, type DatabaseSync as Database } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, extname, basename, dirname, join } from 'node:path';
import { YU_HOME, formatBytes } from '../paths.js';

// ── Constants ──────────────────────────────────────────

const DB_PATH = resolve(YU_HOME, 'knowledge.db');

/** File extensions we index. */
const INDEXED_EXTENSIONS = new Set(['.md', '.ts', '.tsx']);

/** Directories to skip when indexing. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage', '.yu']);

/** Regex to extract JSDoc/TSDoc block comments. */
const JSDOC_RE = /\/\*\*[\s\S]*?\*\//g;

/** Regex to extract single-line comments starting with //. */
const LINE_COMMENT_RE = /\/\/\/? .*$/gm;

// ── Database ───────────────────────────────────────────

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;

  if (!existsSync(dirname(DB_PATH))) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
  }

  const db = new DatabaseSync(DB_PATH);
  _db = db;

  // Enable WAL mode for better concurrent access
  db.exec('PRAGMA journal_mode=WAL');

  // Create FTS5 virtual table
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    path,
    type,
    content,
    tokenize='porter unicode61'
  )`);

  // Metadata table for tracking indexed files
  db.exec(`CREATE TABLE IF NOT EXISTS indexed_files (
    path TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    last_indexed INTEGER NOT NULL,
    last_modified INTEGER NOT NULL
  )`);

  return db;
}

// ── File content extraction ────────────────────────────

/** Extract indexable text from a file. */
function extractContent(filePath: string, ext: string): { content: string; type: string } | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');

    if (ext === '.md') {
      // Full markdown content; detect ADR
      const name = basename(filePath);
      const isAdr = name.startsWith('adr-') || filePath.includes('/adr/');
      return { content: raw, type: isAdr ? 'adr' : 'md' };
    }

    if (ext === '.ts' || ext === '.tsx') {
      // Extract JSDoc/TSDoc block comments
      const blocks: string[] = [];
      const jsdocRe = new RegExp(JSDOC_RE.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = jsdocRe.exec(raw)) !== null) {
        // Clean up comment markers
        const cleaned = match[0]
          .replace(/^\/\*\*?/, '')
          .replace(/\*\/$/, '')
          .replace(/^\s*\*\s?/gm, '')
          .trim();
        if (cleaned) blocks.push(cleaned);
      }

      // Also extract line comments that look like documentation
      const lineRe = new RegExp(LINE_COMMENT_RE.source, 'gm');
      while ((match = lineRe.exec(raw)) !== null) {
        const cleaned = match[0].replace(/^\/\/\/?\s*/, '').trim();
        if (cleaned) blocks.push(cleaned);
      }

      if (blocks.length === 0) return null;
      return { content: blocks.join('\n\n'), type: 'ts' };
    }

    return null;
  } catch {
    return null;
  }
}

// ── Indexing ───────────────────────────────────────────

/**
 * Walk a directory recursively and return all file paths
 * that match indexed extensions, skipping SKIP_DIRS.
 */
function walkDir(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        results.push(...walkDir(full, baseDir));
      }
    } else if (stats.isFile()) {
      const ext = extname(entry).toLowerCase();
      if (INDEXED_EXTENSIONS.has(ext)) {
        const relPath = relative(baseDir, full);
        results.push(relPath);
      }
    }
  }

  return results;
}

/**
 * Index a project directory. Walks the directory tree, extracts
 * content from indexed files, and inserts/updates the FTS index.
 *
 * Skips files whose last modified time hasn't changed since last index.
 */
export function indexProject(projectDir?: string): { indexed: number; skipped: number; failed: number } {
  const db = getDb();
  const root = projectDir || process.cwd();

  if (!existsSync(root)) {
    throw new Error(`目录不存在: ${root}`);
  }

  const files = walkDir(root, root);
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (const relPath of files) {
    const fullPath = resolve(root, relPath);
    const ext = extname(relPath).toLowerCase();
    const mtime = statSync(fullPath).mtimeMs;

    // Check if file is already indexed and unchanged
    const stmt = db.prepare('SELECT last_modified FROM indexed_files WHERE path = ?');
    const row = stmt.get(relPath) as { last_modified: number } | undefined;
    if (row && row.last_modified >= mtime) {
      skipped++;
      continue;
    }

    const extracted = extractContent(fullPath, ext);
    if (!extracted) {
      skipped++;
      continue;
    }

    try {
      // Remove old entry if exists
      db.prepare('DELETE FROM knowledge_fts WHERE path = ?').run(relPath);
      db.prepare('DELETE FROM indexed_files WHERE path = ?').run(relPath);

      // Insert new entry
      db.prepare('INSERT INTO knowledge_fts (path, type, content) VALUES (?, ?, ?)').run(
        relPath,
        extracted.type,
        extracted.content,
      );
      db.prepare(
        'INSERT OR REPLACE INTO indexed_files (path, type, last_indexed, last_modified) VALUES (?, ?, ?, ?)',
      ).run(relPath, extracted.type, Date.now(), mtime);

      indexed++;
    } catch {
      failed++;
    }
  }

  return { indexed, skipped, failed };
}

// ── Search ─────────────────────────────────────────────

export interface SearchResult {
  path: string;
  type: string;
  snippet: string;
  rank: number;
}

/**
 * Search the knowledge base using FTS5 full-text search.
 * Returns up to `limit` results with context snippets.
 */
export function searchKnowledge(query: string, limit = 10): SearchResult[] {
  const db = getDb();

  // Validate the query contains safe characters for FTS5
  const safe = sanitizeFtsQuery(query);
  if (!safe) {
    return [];
  }

  type Row = { path: string; type: string; snippet: string; rank: number };
  const rows = db
    .prepare(
      `SELECT path, type, snippet(knowledge_fts, 2, '**', '**', '…', 30) AS snippet, rank
       FROM knowledge_fts
       WHERE knowledge_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(safe, limit) as Row[];

  return rows.map((r) => ({
    path: r.path,
    type: r.type,
    snippet: r.snippet,
    rank: r.rank,
  }));
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 * Escapes special characters and wraps terms.
 */
function sanitizeFtsQuery(query: string): string {
  // Remove FTS5 special operators to prevent syntax errors
  // We convert to a simple AND query of terms
  const terms = query
    .replace(/[()*"^~:]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
}

// ── Stats ──────────────────────────────────────────────

export interface KnowledgeStats {
  totalFiles: number;
  byType: Record<string, number>;
  dbSize: number;
  lastIndexed: number | null;
}

/**
 * Return statistics about the knowledge base.
 */
export function knowledgeStats(): KnowledgeStats {
  const db = getDb();

  const totalRow = db.prepare('SELECT COUNT(*) as count FROM indexed_files').get() as { count: number };
  const typeRows = db.prepare('SELECT type, COUNT(*) as count FROM indexed_files GROUP BY type').all() as {
    type: string;
    count: number;
  }[];

  const byType: Record<string, number> = {};
  for (const r of typeRows) {
    byType[r.type] = r.count;
  }

  const lastRow = db.prepare('SELECT MAX(last_indexed) as last FROM indexed_files').get() as {
    last: number | null;
  };

  let dbSize = 0;
  try {
    dbSize = statSync(DB_PATH).size;
  } catch { /* ignore */ }

  return {
    totalFiles: totalRow.count,
    byType,
    dbSize,
    lastIndexed: lastRow.last,
  };
}

// ── Relevant context injection ─────────────────────────

/**
 * Search the knowledge base and return formatted context strings
 * suitable for injecting into agent system prompts.
 */
export function getRelevantContext(taskDescription: string, maxResults = 5): string[] {
  try {
    const results = searchKnowledge(taskDescription, maxResults);
    if (results.length === 0) return [];

    return results.map((r) => `[${r.type}] ${r.path}:\n  ${r.snippet}`);
  } catch {
    return [];
  }
}

// ── CLI-friendly command dispatch ──────────────────────

/**
 * Handle `yu knowledge <subcommand>` CLI calls.
 * Returns the output string to print.
 */
export function knowledgeCommand(subcommand: string, args: string[]): string {
  switch (subcommand) {
    case 'search': {
      const query = args.join(' ');
      if (!query) return 'Usage: yu knowledge search <query>';
      const results = searchKnowledge(query);
      if (results.length === 0) return '未找到匹配结果。';
      return results
        .map((r) => `[${r.type}] ${r.path}\n  ${r.snippet}`)
        .join('\n\n');
    }
    case 'index': {
      const targetDir = args[0] || process.cwd();
      const result = indexProject(targetDir);
      return `索引完成: ${result.indexed} 个文件已索引, ${result.skipped} 个跳过, ${result.failed} 个失败`;
    }
    case 'status':
    case 'stats': {
      const stats = knowledgeStats();
      const lines: string[] = ['知识库状态:'];
      lines.push(`  文件总数: ${stats.totalFiles}`);
      lines.push(
        `  类型分布: ${Object.entries(stats.byType)
          .map(([t, c]) => `${t}: ${c}`)
          .join(', ')}`,
      );
      lines.push(`  数据库大小: ${formatBytes(stats.dbSize)}`);
      if (stats.lastIndexed) {
        lines.push(`  上次索引: ${new Date(stats.lastIndexed).toLocaleString()}`);
      } else {
        lines.push('  尚未索引任何文件，请运行 yu knowledge index');
      }
      return lines.join('\n');
    }
    default:
      return 'Usage: yu knowledge search <query>\n' +
             '       yu knowledge index [project-dir]\n' +
             '       yu knowledge status';
  }
}
