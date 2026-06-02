/**
 * Unit tests — facts.ts (long-term key-value memory).
 *
 * Tests basic CRUD, TTL expiration, increment, cleanup, and stats.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  factGet,
  factSet,
  factIncrement,
  factDelete,
  factList,
  factCleanup,
  factStats,
} from '../extension/memory/facts.js';

/** Remove all entries from the facts store. */
function clearAllFacts(): void {
  const entries = factList();
  for (const e of entries) {
    factDelete(e.key);
  }
}

describe('facts — basic CRUD', () => {
  beforeEach(() => {
    clearAllFacts();
  });

  it('returns undefined for missing key', () => {
    expect(factGet('nonexistent')).toBeUndefined();
  });

  it('sets and gets a value', () => {
    factSet('test-key', 'hello world', 'milestone');
    expect(factGet('test-key')).toBe('hello world');
  });

  it('overwrites existing key', () => {
    factSet('key1', 'first', 'milestone');
    factSet('key1', 'second', 'milestone');
    expect(factGet('key1')).toBe('second');
  });

  it('deletes a key', () => {
    factSet('delete-me', 'value', 'milestone');
    const deleted = factDelete('delete-me');
    expect(deleted).toBe(true);
    expect(factGet('delete-me')).toBeUndefined();
  });

  it('returns false when deleting non-existent key', () => {
    expect(factDelete('not-exist')).toBe(false);
  });

  it('stores different types of values', () => {
    factSet('num', 42, 'counter');
    factSet('bool', true, 'milestone');
    factSet('obj', { nested: true }, 'pref');

    expect(factGet('num')).toBe(42);
    expect(factGet('bool')).toBe(true);
    expect(factGet('obj')).toEqual({ nested: true });
  });
});

describe('facts — increment', () => {
  beforeEach(() => {
    clearAllFacts();
  });

  it('creates counter with default 1 when key does not exist', () => {
    const val = factIncrement('new-counter');
    expect(val).toBe(1);
    expect(factGet('new-counter')).toBe(1);
  });

  it('increments existing counter by 1', () => {
    factSet('counter', 5, 'counter');
    expect(factIncrement('counter')).toBe(6);
    expect(factGet('counter')).toBe(6);
  });

  it('increments by custom amount', () => {
    factSet('score', 10, 'counter');
    expect(factIncrement('score', 5)).toBe(15);
    expect(factGet('score')).toBe(15);
  });

  it('resets to by when existing value is not a number', () => {
    factSet('bad', 'string-value', 'milestone');
    // increment should treat non-numeric as missing, start at `by`
    expect(factIncrement('bad', 3)).toBe(3);
  });
});

describe('facts — listing and stats', () => {
  beforeEach(() => {
    clearAllFacts();
  });

  it('lists entries by category', () => {
    factSet('a', 1, 'counter');
    factSet('b', 'pref', 'pref');
    factSet('c', true, 'milestone');

    const counters = factList('counter');
    expect(counters.length).toBe(1);
    expect(counters[0].key).toBe('a');

    const all = factList();
    expect(all.length).toBe(3);
  });

  it('stats returns correct counts', () => {
    factSet('c1', 1, 'counter');
    factSet('c2', 2, 'counter');
    factSet('m1', 'done', 'milestone');

    const stats = factStats();
    expect(stats.total).toBe(3);
    expect(stats.by_category.counter).toBe(2);
    expect(stats.by_category.milestone).toBe(1);
  });
});

describe('facts — TTL expiry', () => {
  beforeEach(() => {
    clearAllFacts();
  });

  it('does not expire entries with null ttl', () => {
    factSet('permanent', 'stays', 'milestone', null);
    expect(factGet('permanent')).toBe('stays');
  });

  it('removes entrants with ttl=0 (age < ttl_days is false so entry filtered out)', () => {
    // With ttlDays=0: age < 0 is false → filter removes the entry.
    factSet('zero-ttl', 'gone', 'milestone', 0);
    expect(factGet('zero-ttl')).toBeUndefined();
  });

  it('cleanup removes nothing when no entries expired', () => {
    factSet('valid1', 'val1', 'counter');
    factSet('valid2', 'val2', 'pref');

    const removed = factCleanup();
    expect(removed).toBe(0);

    expect(factGet('valid1')).toBe('val1');
    expect(factGet('valid2')).toBe('val2');
  });
});
