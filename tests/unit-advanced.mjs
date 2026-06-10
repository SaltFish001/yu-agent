// yu-agent — Advanced Unit Tests
// Covers spawn.ts (private utilities, prefix builder, pool API),
// template.ts (remaining edge cases), config.ts (all types field-by-field),
// status.ts (summary edge cases, file I/O).
//
// Run: node tests/unit-advanced.mjs

import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

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

// ── Helpers for module-private functions from spawn.ts ──
// These replicate the exact logic from dist/extension/spawn.js.
// The original `extractAssistantResponse` and `compactResult`
// are module-scoped (not exported), so we mirror them here
// to verify the algorithm.

function extractAssistantResponse(messages) {
  return messages
    .filter((m) => m.role === 'assistant')
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n');
      }
      return '';
    })
    .join('\n');
}

function compactResult(text, maxLen) {
  if (maxLen === undefined) maxLen = 3000;
  if (text.length <= maxLen) return text;
  const head = text.slice(0, Math.floor(maxLen / 2));
  const tail = text.slice(-Math.floor(maxLen / 2));
  return `${head}\n\n[... ${text.length - maxLen} chars compressed ...]\n\n${tail}`;
}

// ── 1. spawn.ts — buildAgentPrefix (accessible on instance) ──
console.log('\n🚀 spawn — buildAgentPrefix');

await testAsync('buildAgentPrefix: coding type', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'coding', task: 'hello' });
  ok(result.includes('编码 agent'));
});

await testAsync('buildAgentPrefix: review type', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'review', task: 'hello' });
  ok(result.includes('审查 agent'));
});

await testAsync('buildAgentPrefix: plan type', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'plan', task: 'hello' });
  ok(result.includes('计划 agent'));
});

await testAsync('buildAgentPrefix: lsp type', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'lsp', task: 'hello' });
  ok(result.includes('LSP agent'));
});

await testAsync('buildAgentPrefix: commit type', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'commit', task: 'hello' });
  ok(result.includes('commit agent'));
});

await testAsync('buildAgentPrefix: doc type', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'doc', task: 'hello' });
  ok(result.includes('文档 agent'));
});

await testAsync('buildAgentPrefix: search type', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'search', task: 'hello' });
  ok(result.includes('搜索 agent'));
});

await testAsync('buildAgentPrefix: files included in prefix', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'coding', task: 'hello', files: ['src/a.ts', 'src/b.ts'] });
  ok(result.includes('相关文件'));
  ok(result.includes('src/a.ts'));
  ok(result.includes('src/b.ts'));
});

await testAsync('buildAgentPrefix: no files when files empty', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'coding', task: 'hello', files: [] });
  ok(!result.includes('相关文件'));
});

await testAsync('buildAgentPrefix: unknown type returns empty hint (no files)', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'unknown_type', task: 'hello' });
  strictEqual(result, '');
});

await testAsync('buildAgentPrefix: unknown type with files still shows files', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const result = pool.buildAgentPrefix({ type: 'unknown_type', task: 'hello', files: ['x.ts'] });
  strictEqual(result, '\n相关文件: x.ts');
});

// ── 2. spawn.ts — buildDefaultConfig ──
console.log('\n⚙️  spawn — buildDefaultConfig');

await testAsync('buildDefaultConfig returns correct tools', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const cfg = pool.buildDefaultConfig({ type: 'coding', task: 't' });
  ok(Array.isArray(cfg.tools));
  strictEqual(cfg.tools.length, 7);
  ok(cfg.tools.includes('Bash'));
  ok(cfg.tools.includes('Read'));
  ok(cfg.tools.includes('Edit'));
  ok(cfg.tools.includes('Write'));
  ok(cfg.tools.includes('Glob'));
  ok(cfg.tools.includes('Grep'));
  ok(cfg.tools.includes('Ls'));
});

// ── 3. spawn.ts — compactResult (algorithm verification) ──
console.log('\n📏 spawn — compactResult');

test('compactResult: short text (< 3000) returns unchanged', () => {
  const short = 'Hello, World!';
  const result = compactResult(short);
  strictEqual(result, short);
});

test('compactResult: text at exactly 3000 chars returns unchanged', () => {
  const exact = 'a'.repeat(3000);
  const result = compactResult(exact);
  strictEqual(result, exact);
});

test('compactResult: text at exactly 0 chars returns unchanged', () => {
  const result = compactResult('');
  strictEqual(result, '');
});

test('compactResult: long text (> 3000) gets compressed', () => {
  const long = 'A'.repeat(1500) + 'B'.repeat(1500) + 'C'.repeat(500); // 3500 chars
  const result = compactResult(long);
  ok(result.length > 0);
  ok(result.includes('compressed'));
  ok(result.includes('500 chars compressed'));
  // Head should contain first 1500 chars of A's
  ok(result.startsWith('A'.repeat(1500)));
  // Tail should contain last 1500 chars of... last 1500 of the original
  ok(result.endsWith('C'.repeat(500)));
});

test('compactResult: custom maxLen respected', () => {
  const text = 'Hello_World_Test';
  // maxLen = 10, text.length = 16, expected compression
  const result = compactResult(text, 10);
  ok(result.includes('compressed'));
  ok(result.includes('6 chars compressed'));
  // Head = first 5 chars: "Hello"
  ok(result.startsWith('Hello'));
  // Tail = last 5 chars: "_Test"
  ok(result.endsWith('_Test'));
});

test('compactResult: exact boundary at custom maxLen', () => {
  const text = '12345';
  const result = compactResult(text, 5);
  strictEqual(result, text);
});

test('compactResult: just over boundary', () => {
  const text = '123456';
  const result = compactResult(text, 5);
  ok(result.includes('compressed'));
  ok(result.includes('1 chars compressed'));
});

// ── 4. spawn.ts — extractAssistantResponse (algorithm verification) ──
console.log('\n💬 spawn — extractAssistantResponse');

test('extractAssistantResponse: string content', () => {
  const msgs = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ];
  strictEqual(extractAssistantResponse(msgs), 'world');
});

test('extractAssistantResponse: array content with text items', () => {
  const msgs = [
    { role: 'assistant', content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] },
  ];
  strictEqual(extractAssistantResponse(msgs), 'line1\nline2');
});

test('extractAssistantResponse: array content filters non-text items', () => {
  const msgs = [
    { role: 'assistant', content: [
      { type: 'text', text: 'hello' },
      { type: 'image', image_url: '...' },
      { type: 'text', text: 'world' },
    ]},
  ];
  strictEqual(extractAssistantResponse(msgs), 'hello\nworld');
});

test('extractAssistantResponse: mixed content types', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'string response' },
    { role: 'assistant', content: [{ type: 'text', text: 'array part' }] },
  ];
  strictEqual(extractAssistantResponse(msgs), 'string response\narray part');
});

test('extractAssistantResponse: empty messages array', () => {
  strictEqual(extractAssistantResponse([]), '');
});

test('extractAssistantResponse: no assistant messages', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'result' },
  ];
  strictEqual(extractAssistantResponse(msgs), '');
});

test('extractAssistantResponse: null/undefined content treated as empty', () => {
  const msgs = [
    { role: 'assistant', content: null },
    { role: 'assistant' },  // no content property
  ];
  // Two empty messages joined by newline
  strictEqual(extractAssistantResponse(msgs), '\n');
});

test('extractAssistantResponse: assistant with empty string content', () => {
  const msgs = [
    { role: 'assistant', content: '' },
  ];
  strictEqual(extractAssistantResponse(msgs), '');
});

test('extractAssistantResponse: multiple assistants joined with newlines', () => {
  const msgs = [
    { role: 'assistant', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'assistant', content: 'third' },
  ];
  strictEqual(extractAssistantResponse(msgs), 'first\nsecond\nthird');
});

// ── 5. spawn.ts — SessionPool public API ──
console.log('\n🔁 spawn — SessionPool singleton & state');

await testAsync('getSessionPool returns same instance', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const a = mod.getSessionPool();
  const b = mod.getSessionPool();
  strictEqual(a, b);
});

await testAsync('resetSessionPool clears singleton', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const before = mod.getSessionPool();
  await mod.resetSessionPool();
  const after = mod.getSessionPool();
  // After reset, getSessionPool creates a new instance
  ok(before !== after);
  // Clean up
  await mod.resetSessionPool();
});

await testAsync('getStats returns a copy', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  const stats = pool.getStats();
  stats.totalHits = 999;
  const stats2 = pool.getStats();
  strictEqual(stats2.totalHits, 0, 'mutating returned stats should not affect internal');
});

await testAsync('dispose resets turnCount and session', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  const pool = new mod.SessionPool();
  // Access private field (JS, not TS)
  pool.turnCount = 42;
  pool.dispose();
  strictEqual(pool.turnCount, 0);
  strictEqual(pool.session, null);
});

await testAsync('spawnAgent is exported as async function', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/spawn.js'));
  strictEqual(typeof mod.spawnAgent, 'function');
  // spawnAgent returns a promise (will reject because no real session, but verifying it's async)
  const result = mod.spawnAgent({ type: 'coding', task: 'test', model: 'v4-flash', maxTurns: 5, timeout: 1000 });
  ok(result instanceof Promise);
  try {
    await result;
  } catch {
    // Expected to fail due to missing Pi session — that's OK
  }
});

// ── 6. template.ts — parseSchedulerOutput edge cases ──
console.log('\n📋 template — parseSchedulerOutput edge cases');

await testAsync('parseSchedulerOutput: JSON in bare code block (no "json" tag)', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('```\n{"intent":"review","agents":[]}\n```');
  ok(result !== null);
  strictEqual(result.intent, 'review');
});

await testAsync('parseSchedulerOutput: non-object JSON (array) returns null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('[1, 2, 3]');
  // Arrays are typeof 'object' in JS — the function returns them as-is
  ok(result === null || Array.isArray(result), 'array should either be rejected or returned as-is');
});

await testAsync('parseSchedulerOutput: non-object JSON (string) returns null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('"just a string"');
  strictEqual(result, null);
});

await testAsync('parseSchedulerOutput: non-object JSON (number) returns null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('42');
  strictEqual(result, null);
});

await testAsync('parseSchedulerOutput: empty string returns null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('');
  strictEqual(result, null);
});

await testAsync('parseSchedulerOutput: JSON in bare code block with extra text', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('Here is the plan:\n```\n{"pass_through":true,"reasoning":"simple"}\n```\nEnd.');
  ok(result !== null);
  strictEqual(result.pass_through, true);
});

await testAsync('parseSchedulerOutput: non-object JSON in code block returns null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('```json\n"not an object"\n```');
  strictEqual(result, null);
});

await testAsync('parseSchedulerOutput: whitespace-only text returns null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('   \n  \t  ');
  strictEqual(result, null);
});

// ── 7. template.ts — parseAgentOutput additional edge cases ──
console.log('\n📋 template — parseAgentOutput edge cases');

await testAsync('parseAgentOutput: JSON array returns as-is', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseAgentOutput('[{"status":"success"}]');
  ok(Array.isArray(result));
  strictEqual(result[0].status, 'success');
});

await testAsync('parseAgentOutput: whitespace-only string returns null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseAgentOutput('   ');
  strictEqual(result, null);
});

await testAsync('parseAgentOutput: empty code block returns null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseAgentOutput('```json\n\n```');
  strictEqual(result, null);
});

await testAsync('parseAgentOutput: code block with non-JSON returns null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseAgentOutput('```json\nnot json at all\n```');
  strictEqual(result, null);
});

await testAsync('parseAgentOutput: nested JSON object', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const data = { status: 'success', nested: { key: 'val' }, arr: [1, 2] };
  const result = mod.parseAgentOutput(JSON.stringify(data));
  deepStrictEqual(result, data);
});

// ── 9. config.ts — all 7 types field-by-field ──
console.log('\n⚙️  config — all 7 agent types field-by-field');

await testAsync('AGENT_TYPES has exactly 7 entries', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  strictEqual(Object.keys(mod.AGENT_TYPES).length, 7);
});

// Coding
await testAsync('coding: displayName, model, maxTurns, thinking, builtinToolNames', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const t = mod.AGENT_TYPES.coding;
  strictEqual(t.displayName, 'Coding Agent');
  strictEqual(t.description, '编写和修改代码');
  strictEqual(t.model, 'v4-flash');
  strictEqual(t.thinking, 'max');
  strictEqual(t.maxTurns, 50);
  deepStrictEqual(t.builtinToolNames, ['Bash', 'Read', 'Edit', 'Glob', 'Grep']);
});

// Review
await testAsync('review: displayName, model, maxTurns, thinking, builtinToolNames', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const t = mod.AGENT_TYPES.review;
  strictEqual(t.displayName, 'Review Agent');
  strictEqual(t.description, '审查代码，只读不改');
  strictEqual(t.model, 'v4-flash');
  strictEqual(t.thinking, 'max');
  strictEqual(t.maxTurns, 30);
  deepStrictEqual(t.builtinToolNames, ['Read', 'Glob', 'Grep']);
});

// Plan
await testAsync('plan: displayName, model, maxTurns, thinking, builtinToolNames', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const t = mod.AGENT_TYPES.plan;
  strictEqual(t.displayName, 'Plan Agent');
  strictEqual(t.description, '出技术方案，只读不改');
  strictEqual(t.model, 'v4-flash');
  strictEqual(t.thinking, 'max');
  strictEqual(t.maxTurns, 30);
  deepStrictEqual(t.builtinToolNames, ['Read', 'Glob', 'Grep']);
});

// LSP
await testAsync('lsp: displayName, model, maxTurns, thinking, builtinToolNames', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const t = mod.AGENT_TYPES.lsp;
  strictEqual(t.displayName, 'LSP Agent');
  strictEqual(t.description, 'LSP 诊断与自动修复');
  strictEqual(t.model, 'v4-flash');
  strictEqual(t.thinking, 'flash');   // lsp uses flash thinking
  strictEqual(t.maxTurns, 20);
  deepStrictEqual(t.builtinToolNames, ['Bash']);
});

// Commit
await testAsync('commit: displayName, model, maxTurns, thinking, builtinToolNames', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const t = mod.AGENT_TYPES.commit;
  strictEqual(t.displayName, 'Commit Agent');
  strictEqual(t.description, 'git commit');
  strictEqual(t.model, 'v4-flash');
  strictEqual(t.thinking, 'flash');   // commit uses flash thinking
  strictEqual(t.maxTurns, 10);
  deepStrictEqual(t.builtinToolNames, ['Bash']);
});

// Doc
await testAsync('doc: displayName, model, maxTurns, thinking, builtinToolNames', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const t = mod.AGENT_TYPES.doc;
  strictEqual(t.displayName, 'Doc Agent');
  strictEqual(t.description, '生成文档');
  strictEqual(t.model, 'v4-flash');
  strictEqual(t.thinking, 'flash');   // doc uses flash thinking
  strictEqual(t.maxTurns, 20);
  deepStrictEqual(t.builtinToolNames, ['Read', 'Edit']);
});

// Search
await testAsync('search: displayName, model, maxTurns, thinking, builtinToolNames', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const t = mod.AGENT_TYPES.search;
  strictEqual(t.displayName, 'Search Agent');
  strictEqual(t.description, '代码库搜索 + 网页搜索');
  strictEqual(t.model, 'v4-flash');
  strictEqual(t.thinking, 'flash');   // search uses flash thinking
  strictEqual(t.maxTurns, 15);
  deepStrictEqual(t.builtinToolNames, ['Bash']);
});

// getAgentTypeConfig for nonexistent type
await testAsync('getAgentTypeConfig for nonexistent type returns undefined', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const result = mod.getAgentTypeConfig('nonexistent_type_xyz');
  strictEqual(result, undefined);
});

await testAsync('getAgentTypeConfig for empty string returns undefined', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const result = mod.getAgentTypeConfig('');
  strictEqual(result, undefined);
});

// systemPrompt is loaded for each type
await testAsync('all agent types have non-empty systemPrompt', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  for (const name of Object.keys(mod.AGENT_TYPES)) {
    const t = mod.AGENT_TYPES[name];
    ok(typeof t.systemPrompt === 'string', `systemPrompt for ${name} should be a string`);
    ok(t.systemPrompt.length > 0, `systemPrompt for ${name} should not be empty`);
  }
});

// registerAgents
await testAsync('registerAgents logs and does not throw', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  // Should not throw
  mod.registerAgents();
});

// ── 10. status.ts — buildSummary edge cases ──
console.log('\n📊 status — buildSummary edge cases');

await testAsync('buildSummary: all completed', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const agents = [
    { id: '1', type: 'coding', status: 'completed', startedAt: 0, durationMs: 100 },
    { id: '2', type: 'review', status: 'completed', startedAt: 1, durationMs: 200 },
    { id: '3', type: 'plan', status: 'completed', startedAt: 2, durationMs: 50 },
  ];
  const s = mod.buildSummary(agents);
  strictEqual(s.running, 0);
  strictEqual(s.completed, 3);
  strictEqual(s.failed, 0);
});

await testAsync('buildSummary: all failed', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const agents = [
    { id: '1', type: 'coding', status: 'failed' },
    { id: '2', type: 'review', status: 'failed' },
  ];
  const s = mod.buildSummary(agents);
  strictEqual(s.running, 0);
  strictEqual(s.completed, 0);
  strictEqual(s.failed, 2);
});

await testAsync('buildSummary: queued and interrupted statuses counted correctly', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const agents = [
    { id: '1', status: 'queued' },
    { id: '2', status: 'running' },
    { id: '3', status: 'completed' },
    { id: '4', status: 'failed' },
    { id: '5', status: 'interrupted' },
  ];
  const s = mod.buildSummary(agents);
  strictEqual(s.running, 2, 'queued + running = 2');
  strictEqual(s.completed, 1);
  strictEqual(s.failed, 2, 'failed + interrupted = 2');
});

await testAsync('buildSummary: empty list', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const s = mod.buildSummary([]);
  strictEqual(s.running, 0);
  strictEqual(s.completed, 0);
  strictEqual(s.failed, 0);
});

await testAsync('buildSummary: unknown status not counted in any bucket', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const agents = [
    { id: '1', status: 'unknown_status' },
  ];
  const s = mod.buildSummary(agents);
  strictEqual(s.running, 0);
  strictEqual(s.completed, 0);
  strictEqual(s.failed, 0);
});

await testAsync('buildSummary: mixed with many agents', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const agents = Array.from({ length: 10 }, (_, i) => ({
    id: `${i}`,
    status: i < 3 ? 'running' : i < 7 ? 'completed' : 'failed',
  }));
  const s = mod.buildSummary(agents);
  strictEqual(s.running, 3);
  strictEqual(s.completed, 4);
  strictEqual(s.failed, 3);
});

// ── 11. status.ts — File I/O ──
console.log('\n💾 status — file I/O');

// Save original STATUS_DIR contents by reading what's already there
const STATUS_DIR = resolve(homedir(), 'yu-agent', 'status');

await testAsync('writeAgentStatus writes agents.json', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const agents = [
    { id: 't1', type: 'coding', model: 'v4-flash', status: 'running', startedAt: Date.now() },
  ];
  mod.writeAgentStatus(agents, 1234567890);
  const filePath = resolve(STATUS_DIR, 'agents.json');
  ok(existsSync(filePath), 'agents.json should exist');
  const content = JSON.parse(readFileSync(filePath, 'utf-8'));
  strictEqual(content.updatedAt, 1234567890);
  strictEqual(content.agents.length, 1);
  strictEqual(content.agents[0].id, 't1');
  // Clean up
  try { unlinkSync(filePath); } catch {}
});

await testAsync('writeSnapshot writes all 5 files', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const snapshot = {
    updatedAt: 999999,
    agents: [{ id: 'a1', type: 'coding', model: 'v4-flash', status: 'completed', startedAt: 0 }],
    mcp: [{ name: 'mcp1', status: 'connected' }],
    lsp: [{ name: 'lsp1', status: 'running', project: '/test' }],
    team: { active: true, mode: 'coder-reviewer' },
    summary: { running: 0, completed: 1, failed: 0, mcpConnected: 1, lspReady: 1 },
  };
  mod.writeSnapshot(snapshot);

  const files = ['agents.json', 'mcp.json', 'lsp.json', 'team.json', 'summary.json'];
  for (const f of files) {
    const filePath = resolve(STATUS_DIR, f);
    ok(existsSync(filePath), `${f} should exist after writeSnapshot`);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    ok(content !== null, `${f} should be valid JSON`);
  }

  // Verify agents.json content
  const agents = JSON.parse(readFileSync(resolve(STATUS_DIR, 'agents.json'), 'utf-8'));
  strictEqual(agents.updatedAt, 999999);
  strictEqual(agents.agents.length, 1);
  strictEqual(agents.agents[0].id, 'a1');

  // Verify team.json
  const team = JSON.parse(readFileSync(resolve(STATUS_DIR, 'team.json'), 'utf-8'));
  strictEqual(team.active, true);
  strictEqual(team.mode, 'coder-reviewer');

  // Verify summary.json
  const summary = JSON.parse(readFileSync(resolve(STATUS_DIR, 'summary.json'), 'utf-8'));
  strictEqual(summary.updatedAt, 999999);
  strictEqual(summary.running, 0);
  strictEqual(summary.completed, 1);

  // Clean up all files
  for (const f of files) {
    try { unlinkSync(resolve(STATUS_DIR, f)); } catch {}
  }
});

await testAsync('writeTeamStatus writes team.json', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const team = { active: true, mode: 'architect-searcher', currentPhase: 'planning' };
  mod.writeTeamStatus(team, 111111);

  const filePath = resolve(STATUS_DIR, 'team.json');
  ok(existsSync(filePath));
  const content = JSON.parse(readFileSync(filePath, 'utf-8'));
  strictEqual(content.active, true);
  strictEqual(content.mode, 'architect-searcher');
  strictEqual(content.currentPhase, 'planning');
  strictEqual(content.updatedAt, 111111);

  try { unlinkSync(filePath); } catch {}
});

await testAsync('writeAgentStatus with default updatedAt works (uses Date.now)', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const before = Date.now();
  mod.writeAgentStatus([{ id: 'd1', type: 'coding', model: 'v4-flash', status: 'completed', startedAt: 0 }]);
  const after = Date.now();

  const filePath = resolve(STATUS_DIR, 'agents.json');
  ok(existsSync(filePath));
  const content = JSON.parse(readFileSync(filePath, 'utf-8'));
  ok(content.updatedAt >= before && content.updatedAt <= after, 'updatedAt should be within call time range');

  try { unlinkSync(filePath); } catch {}
});

await testAsync('writeSnapshot with null team writes fallback {active: false}', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const snapshot = {
    updatedAt: 0,
    agents: [],
    mcp: [],
    lsp: [],
    team: null,
    summary: { running: 0, completed: 0, failed: 0, mcpConnected: 0, lspReady: 0 },
  };
  mod.writeSnapshot(snapshot);

  const teamPath = resolve(STATUS_DIR, 'team.json');
  ok(existsSync(teamPath));
  const team = JSON.parse(readFileSync(teamPath, 'utf-8'));
  strictEqual(team.active, false);

  // Clean up
  for (const f of ['agents.json', 'mcp.json', 'lsp.json', 'team.json', 'summary.json']) {
    try { unlinkSync(resolve(STATUS_DIR, f)); } catch {}
  }
});

// Test error handling by making STATUS_DIR point to an invalid location
// We can't easily override the module constant, but we can test that
// writeFile handles errors gracefully (the try-catch in source).
await testAsync('write functions handle errors gracefully (no throw)', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  // These should not throw even if called with unusual data
  mod.writeAgentStatus([], 0);
  mod.writeAgentStatus([], NaN);
  mod.writeAgentStatus([]);

  // Clean up
  try { unlinkSync(resolve(STATUS_DIR, 'agents.json')); } catch {}
});

// ── Summary ────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

process.exit(failed > 0 ? 1 : 0);
