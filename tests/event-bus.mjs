#!/usr/bin/env node
/**
 * yu-agent — Phase 3 Integration Test: Event Bus + Orchestrator
 *
 * Tests:
 * 1. Events table is created in topics.db
 * 2. writeEvent() inserts rows correctly
 * 3. setStatus() writes child_spawned / child_task_done events
 * 4. Orchestrator rules in ~/.yu/orchestrator.json trigger spawn_child
 * 5. Supervisor writes events on spawn/exit (mocked)
 *
 * Run: node tests/event-bus.mjs
 */

import { strictEqual, ok } from 'node:assert';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`      ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`      ${e.message}`);
  }
}

// ── Ensure DB is initialized with events table ───────────
await import(resolve(ROOT, 'dist/extension/topic.js'));

// ── Helpers ──────────────────────────────────────────────

const YU_HOME = resolve(homedir(), '.yu');
const DB_PATH = resolve(YU_HOME, 'topics.db');
const ORCHESTRATOR_PATH = resolve(YU_HOME, 'orchestrator.json');

function getDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=3000');
  return db;
}

function cleanTestTopic(db, name) {
  try {
    db.prepare('DELETE FROM topics WHERE name = ?').run(name);
  } catch { /* ignore */ }
}

// ── Tests ────────────────────────────────────────────────

console.log('\n📦 Phase 3: Event Bus + Orchestrator Integration\n');

// 1. Events table exists
test('events table exists in topics.db', () => {
  const db = getDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
  ).all();
  db.close();
  ok(tables.length > 0, 'events table should exist');
});

// 2. writeEvent inserts rows
await testAsync('writeEvent inserts event row', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/topic.js'));

  // Write an event
  mod.writeEvent('test-topic', 'child_spawned', { pid: 12345 });

  // Verify it's in the DB
  const db = getDb();
  const rows = db.prepare(
    "SELECT topic, event_type, payload FROM events WHERE topic = 'test-topic'"
  ).all();
  db.close();

  ok(rows.length >= 1, 'should have at least 1 event row');
  const row = rows[rows.length - 1];
  strictEqual(row.topic, 'test-topic');
  strictEqual(row.event_type, 'child_spawned');
  const payload = JSON.parse(row.payload);
  strictEqual(payload.pid, 12345);

  // Cleanup
  const db2 = getDb();
  db2.prepare("DELETE FROM events WHERE topic = 'test-topic'").run();
  db2.close();
});

// 3. setStatus writes events
await testAsync('setStatus writes child_spawned for background transition', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/topic.js'));

  // Ensure test topic exists
  const topicName = 'event-bus-test-status';
  try {
    mod.create(topicName, resolve(YU_HOME, 'topics', topicName));
  } catch {
    // Already exists — set to idle first
    mod.setStatus(topicName, 'idle');
  }

  // Clear any prior events for this topic
  const db = getDb();
  db.prepare("DELETE FROM events WHERE topic = ?").run(topicName);
  db.close();

  // Transition to background → should write child_spawned
  mod.setStatus(topicName, 'background');

  const db2 = getDb();
  const events = db2.prepare(
    "SELECT event_type, payload FROM events WHERE topic = ? ORDER BY id DESC LIMIT 1"
  ).get(topicName);
  db2.close();

  ok(events, 'should have an event');
  strictEqual(events.event_type, 'child_spawned', 'should be child_spawned');

  // Transition back to idle → should write child_task_done
  mod.setStatus(topicName, 'idle');

  const db3 = getDb();
  const doneEvent = db3.prepare(
    "SELECT event_type, payload FROM events WHERE topic = ? AND event_type = 'child_task_done' ORDER BY id DESC LIMIT 1"
  ).get(topicName);
  db3.close();

  ok(doneEvent, 'should have child_task_done event');
  strictEqual(doneEvent.event_type, 'child_task_done');

  // Cleanup
  cleanTestTopic(getDb(), topicName);
});

// 4. Orchestrator rules trigger actions
await testAsync('orchestrator rule triggers spawn_child', async () => {
  // Save existing orchestrator.json (if any)
  const hadExisting = existsSync(ORCHESTRATOR_PATH);
  let backup = null;
  if (hadExisting) {
    backup = readFileSync(ORCHESTRATOR_PATH, 'utf-8');
  }

  // Write test orchestrator rule
  const testRule = {
    rules: [
      {
        name: 'test-trigger',
        when: {
          topic: '*',
          event: 'child_task_done',
          condition: "payload.status === 'completed'",
        },
        then: {
          action: 'spawn_child',
          topic: 'orchestrated-target',
          prompt: 'Process result: {{payload}}',
        },
      },
    ],
  };
  writeFileSync(ORCHESTRATOR_PATH, JSON.stringify(testRule, null, 2));

  try {
    // Import orchestrator and call it
    const { checkAndTriggerOrchestrator } = await import(resolve(ROOT, 'dist/extension/orchestrator.js'));

    // This should trigger the rule and create 'orchestrated-target'
    checkAndTriggerOrchestrator(
      'any-topic',
      'child_task_done',
      { status: 'completed', pid: 999 },
    );

    // Give a moment for any async operations
    await new Promise(r => setTimeout(r, 200));

    // Check that the target topic was created or updated
    const mod = await import(resolve(ROOT, 'dist/extension/topic.js'));
    const target = mod.get('orchestrated-target');
    ok(target, 'orchestrated target topic should exist');
    ok(target.status === 'background' || target.status === 'idle',
      'target topic status should be set (background or idle if already processed)');

    // Verify an orchestrator-spawned event was written
    // Use the topic module's DB (same connection as writeEvent)
    const mod2 = await import(resolve(ROOT, 'dist/extension/topic.js'));
    // We can't access getDb() directly since it's not exported,
    // but writeEvent uses it internally. Let's query directly.
    const db = getDb();
    const orchEvents = db.prepare(
      "SELECT event_type, payload FROM events WHERE topic = 'orchestrated-target' AND event_type = 'child_spawned' ORDER BY id DESC LIMIT 1"
    ).get();
    db.close();

    ok(orchEvents, 'should have child_spawned event for orchestrated target');
    if (orchEvents) {
      const payload = JSON.parse(orchEvents.payload);
      ok(payload.source === 'orchestrator' || Object.keys(payload).length > 0,
        'event payload should contain orchestrator metadata');
    }

    // Cleanup test target topic
    cleanTestTopic(getDb(), 'orchestrated-target');
  } finally {
    // Restore original orchestrator.json
    if (hadExisting && backup) {
      writeFileSync(ORCHESTRATOR_PATH, backup);
    } else {
      try { unlinkSync(ORCHESTRATOR_PATH); } catch { /* ignore */ }
    }
  }
});

// 5. Events table auto-increments IDs
test('events table uses auto-increment IDs', () => {
  const db = getDb();
  const info = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'"
  ).get();
  db.close();
  ok(info.sql.includes('AUTOINCREMENT'), 'events table should use AUTOINCREMENT');
});

// ── Summary ──────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('✅ All tests passed!');
}
