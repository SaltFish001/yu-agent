/**
 * Unit tests — Ring buffer memory module.
 *
 * Tests overflow strategies (delete_oldest, sliding_window),
 * stats, search, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RingMemory } from '../extension/memory/ring.js';

// The RingMemory class uses a singleton DB, so we rely on
// the SQLite in-memory / file behavior. We test logic around
// overflow by checking behavior with small maxEntries.

import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/** Delete the ring DB between test suites to get a clean slate. */
function resetRingDb(): void {
  const dbPath = resolve(homedir(), '.yu', 'ring_memory.db');
  if (existsSync(dbPath)) {
    try { unlinkSync(dbPath); } catch { /* best-effort */ }
  }
}

describe('RingMemory — overflow strategies', () => {
  let ring: RingMemory;

  beforeEach(() => {
    resetRingDb();
    ring = new RingMemory({ maxEntries: 5, overflowStrategy: 'delete_oldest' });
  });

  afterEach(() => {
    ring.close();
  });

  it('starts empty', () => {
    const recent = ring.recent(10);
    expect(recent.length).toBe(0);
  });

  it('stores entries up to maxEntries', () => {
    for (let i = 0; i < 5; i++) {
      ring.append('user', `message ${i}`);
    }
    const recent = ring.recent(10);
    expect(recent.length).toBe(5);
    // Most recent first
    expect(recent[0].content).toBe('message 4');
  });

  it('delete_oldest: evicts excess entries in batch', () => {
    for (let i = 0; i < 7; i++) {
      ring.append('user', `msg ${i}`);
    }
    const recent = ring.recent(10);
    // Should have only maxEntries (5)
    expect(recent.length).toBe(5);
    // The oldest (msg 0, 1) should be gone
    const contents = recent.map((e) => e.content).sort();
    expect(contents).toEqual(['msg 2', 'msg 3', 'msg 4', 'msg 5', 'msg 6']);
  });

  it('sliding_window: removes one oldest per new entry', () => {
    const slidingRing = new RingMemory({ maxEntries: 3, overflowStrategy: 'sliding_window' });

    for (let i = 0; i < 5; i++) {
      slidingRing.append('user', `msg ${i}`);
    }
    const recent = slidingRing.recent(10);
    expect(recent.length).toBe(3);
    const contents = recent.map((e) => e.content).sort();
    expect(contents).toEqual(['msg 2', 'msg 3', 'msg 4']);

    slidingRing.close();
  });

  it('sliding_window: maintains order with exact max', () => {
    const slidingRing = new RingMemory({ maxEntries: 3, overflowStrategy: 'sliding_window' });

    for (let i = 0; i < 3; i++) {
      slidingRing.append('user', `msg ${i}`);
    }
    expect(slidingRing.recent(10).length).toBe(3);

    // Add one more — oldest (msg 0) should be removed
    slidingRing.append('user', 'msg 3');
    const contents = slidingRing.recent(10).map((e) => e.content).sort();
    expect(contents).toEqual(['msg 1', 'msg 2', 'msg 3']);

    slidingRing.close();
  });
});

describe('ringAppend / ringRecent / ringSearch', () => {
  beforeEach(() => { resetRingDb(); });

  it('ringAppend appends and ringRecent returns in reverse order', () => {
    const r = new RingMemory({ maxEntries: 10 });
    r.append('user', 'first');
    r.append('assistant', 'second');
    r.append('system', 'third');

    const recent = r.recent(10);
    expect(recent.length).toBe(3);
    expect(recent[0].content).toBe('third');
    expect(recent[1].content).toBe('second');
    expect(recent[2].content).toBe('first');

    expect(recent[0].role).toBe('system');
    expect(recent[1].role).toBe('assistant');
    expect(recent[2].role).toBe('user');

    r.close();
  });

  it('ringSearch finds matching entries', () => {
    const r = new RingMemory({ maxEntries: 10 });
    r.append('user', 'hello world');
    r.append('assistant', 'goodbye world');
    r.append('user', 'something else');

    const results = r.search('world');
    expect(results.length).toBe(2);

    const sorted = results.sort((a, b) => a.content.localeCompare(b.content));
    expect(sorted[0].content).toBe('goodbye world');
    expect(sorted[1].content).toBe('hello world');

    r.close();
  });

  it('ringSearch returns empty for no match', () => {
    const r = new RingMemory({ maxEntries: 5 });
    r.append('user', 'abc');
    expect(r.search('xyz').length).toBe(0);
    r.close();
  });
});

describe('ringStats', () => {
  beforeEach(() => { resetRingDb(); });

  it('ringStats returns correct total and by_platform', () => {
    const r = new RingMemory({ maxEntries: 10 });
    r.append('user', 'a', 'cli');
    r.append('assistant', 'b', 'cli');
    r.append('user', 'c', 'web');

    const stats = r.stats();
    expect(stats.total).toBe(3);
    expect(stats.by_platform.cli).toBe(2);
    expect(stats.by_platform.web).toBe(1);

    r.close();
  });
});

describe('RingMemory — edge cases', () => {
  beforeEach(() => { resetRingDb(); });

  it('handles empty content', () => {
    const r = new RingMemory({ maxEntries: 5 });
    r.append('user', '');
    expect(r.recent(1).length).toBe(1);
    expect(r.recent(1)[0].content).toBe('');
    r.close();
  });

  it('handles platform filter', () => {
    const r = new RingMemory({ maxEntries: 10 });
    r.append('user', 'a', 'cli');
    r.append('user', 'b', 'web');
    r.append('user', 'c', 'cli');

    const cliMessages = r.recent(10, 'cli');
    expect(cliMessages.length).toBe(2);
    expect(cliMessages.every((m) => m.platform === 'cli')).toBe(true);
    r.close();
  });
});
