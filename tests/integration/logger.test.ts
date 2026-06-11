/**
 * Integration tests — structured JSON Lines logger.
 *
 * Tests that createLogger() writes log entries to both stderr (JSON Lines)
 * and the SQLite logs table. Verifies persistence via flushLogs() + DB query.
 *
 * API reference (logger.ts):
 *   createLogger(module: string)
 *     → { debug, info, warn, error, fatal }
 *   flushLogs(): Promise<void>
 *     — waits for all pending DB writes to complete
 *
 * Non-debug levels (info, warn, error, fatal) are persisted to the logs table.
 * Debug level entries are written only to stderr (not persisted).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger, flushLogs } from '../../extension/logger.js';
import { getDb } from '../../extension/db.js';

describe('Logger', () => {
  beforeEach(() => {
    // Ensure the DB schema is initialized and logs table exists
    getDb();
    // Clean up any stale records
    const db = getDb();
    db.prepare('DELETE FROM logs').run();
  });

  afterEach(() => {
    // Clean up logs from this test run
    const db = getDb();
    db.prepare('DELETE FROM logs WHERE module = ?').run('test');
    db.prepare('DELETE FROM logs WHERE module = ?').run('test-logger');
  });

  it('writes info-level entries to the logs table', async () => {
    const log = createLogger('test');
    log.info('hello world');

    await flushLogs();

    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM logs WHERE module = ? ORDER BY id')
      .all('test') as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].message).toContain('hello world');
    expect(rows[0].level).toBe('info');
    expect(rows[0].module).toBe('test');
  });

  it('persists warn level with timestamp', async () => {
    const log = createLogger('test');
    log.warn('something suspicious');

    await flushLogs();

    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM logs WHERE module = ? AND level = ?')
      .all('test', 'warn') as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].message).toContain('suspicious');
    // timestamp should be a valid ISO string
    expect(rows[0].timestamp).toBeTruthy();
  });

  it('writes error entries with serialized error details', async () => {
    const log = createLogger('test');
    const err = new Error('something broke');
    log.error('operation failed', err);

    await flushLogs();

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM logs WHERE level = 'error' AND module = ?")
      .all('test') as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    const errorField = JSON.parse(rows[0].error as string);
    expect(errorField.message).toBe('something broke');
    expect(errorField.name).toBe('Error');
  });

  it('does NOT persist debug-level entries', async () => {
    const log = createLogger('test');
    log.debug('this is debug only');

    await flushLogs();

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM logs WHERE level = 'debug' AND module = ?")
      .all('test') as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(0);
  });

  it('persists multiple log entries from different modules', async () => {
    const logA = createLogger('test-a');
    const logB = createLogger('test-b');

    logA.info('from module A');
    logB.info('from module B');

    await flushLogs();

    const db = getDb();
    const rowsA = db
      .prepare('SELECT * FROM logs WHERE module = ?')
      .all('test-a') as Array<Record<string, unknown>>;
    const rowsB = db
      .prepare('SELECT * FROM logs WHERE module = ?')
      .all('test-b') as Array<Record<string, unknown>>;

    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA[0].message).toContain('module A');
    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsB[0].message).toContain('module B');
  });

  // ── Additional level coverage ───────────────────────────

  it('persists fatal-level entries', async () => {
    const log = createLogger('test-logger');
    log.fatal('critical error occurred');

    await flushLogs();

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM logs WHERE level = 'fatal' AND module = ?")
      .all('test-logger') as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].message).toContain('critical error');
    expect(rows[0].level).toBe('fatal');
  });

  // ── Data field ──────────────────────────────────────────

  it('persists data field alongside log entry', async () => {
    const log = createLogger('test-logger');
    log.info('with data', { userId: 42, action: 'test', tags: ['a', 'b'] });

    await flushLogs();

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM logs WHERE level = 'info' AND module = ?")
      .all('test-logger') as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    const dataField = JSON.parse(rows[0].data as string);
    expect(dataField.userId).toBe(42);
    expect(dataField.action).toBe('test');
    expect(dataField.tags).toEqual(['a', 'b']);
  });

  // ── Timestamp ───────────────────────────────────────────

  it('includes valid ISO 8601 timestamp in DB entry', async () => {
    const log = createLogger('test-logger');
    log.info('timestamp check');

    await flushLogs();

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM logs WHERE module = ? AND level = 'info'")
      .all('test-logger') as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    const ts = rows[0].timestamp as string;
    expect(ts).toBeTruthy();
    // Verify ISO 8601 format
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  // ── Error serialization ─────────────────────────────────

  it('serializes error with stack trace for fatal level', async () => {
    const log = createLogger('test-logger');
    const err = new Error('fatal failure');
    log.fatal('system crashed', err);

    await flushLogs();

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM logs WHERE level = 'fatal' AND module = ?")
      .all('test-logger') as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    const errorField = JSON.parse(rows[0].error as string);
    expect(errorField.name).toBe('Error');
    expect(errorField.message).toBe('fatal failure');
    expect(errorField.stack).toBeTruthy();
    expect(errorField.stack).toContain('Error: fatal failure');
  });
});
