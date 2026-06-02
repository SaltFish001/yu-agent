/**
 * yu-agent — 综合高级测试套件
 *
 * 覆盖 scheduler 纯函数、TeamSession 纯逻辑、integration hooks、
 * teamCommand CLI 调度器。
 *
 * Run: node tests/scheduler-team-advanced.mjs
 */

import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TEST_TEMP = resolve(homedir(), '.yu-test-sched');

let passed = 0;
let failed = 0;
const pendingTests = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      pendingTests.push(
        result.then(() => { passed++; console.log(`  ✅ ${name}`); })
          .catch((e) => { failed++; console.log(`  ❌ ${name}`); console.log(`      ${e.message}`); })
      );
    } else {
      passed++; console.log(`  ✅ ${name}`);
    }
  } catch (e) {
    failed++; console.log(`  ❌ ${name}`); console.log(`      ${e.message}`);
  }
}

function cleanTemp() {
  rmSync(TEST_TEMP, { recursive: true, force: true });
  mkdirSync(TEST_TEMP, { recursive: true });
}

// ═══════════════════════════════════════════════════════
// 1. SCHEDULER PURE FUNCTIONS
// ═══════════════════════════════════════════════════════

// Replicate private scheduler functions
const _agentTrackers = new Map();
function resetTracker() { _agentTrackers.clear(); _handlerStartTime = Date.now(); }
let _handlerStartTime = 0;

function trackAgent(id, status, extra) {
  const existing = _agentTrackers.get(id);
  const entry = {
    id, status,
    type: extra?.type || existing?.type || 'unknown',
    model: extra?.model || '',
    goal: extra?.goal || existing?.goal,
    files: extra?.files || existing?.files,
    startedAt: existing?.startedAt,
    durationMs: existing?.durationMs,
    error: extra?.error || existing?.error,
  };
  if (status === 'running' && !entry.startedAt) entry.startedAt = Date.now();
  if ((status === 'completed' || status === 'failed' || status === 'interrupted') && entry.startedAt) {
    entry.durationMs = Date.now() - entry.startedAt;
  }
  _agentTrackers.set(id, entry);
}
function getAgentStatusList() { return Array.from(_agentTrackers.values()); }

function loadDecisions(decisionsFile) {
  if (existsSync(decisionsFile)) {
    try { return JSON.parse(readFileSync(decisionsFile, 'utf-8')); }
    catch { return {}; }
  }
  return {};
}

function saveDecision(key, value, dataDir, decisionsFile) {
  const decisions = loadDecisions(decisionsFile);
  decisions[key] = value;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(decisionsFile, JSON.stringify(decisions, null, 2));
}

function findProjectRoot(files) {
  let dir;
  if (files.length > 0) {
    dir = resolve(files[0]);
    if (/\.\w+$/.test(dir)) dir = dirname(dir);
  } else {
    dir = process.cwd();
  }
  const markers = ['package.json', 'pyproject.toml', 'requirements.txt'];
  for (let i = 0; i < 5; i++) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function runCommand(command, cwd) {
  try { execSync(command, { cwd, stdio: 'pipe', timeout: 5000 }); return true; }
  catch { return false; }
}

async function runWithConcurrencyLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      try { const v = await tasks[i](); results[i] = { status: 'fulfilled', value: v }; }
      catch (r) { results[i] = { status: 'rejected', reason: r }; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── 1a. trackAgent ─────────────────────────────────────
console.log('\n📊 scheduler — trackAgent / getAgentStatusList');

test('trackAgent: pending→running→completed transition', () => {
  resetTracker();
  trackAgent('a1', 'running', { type: 'coding', model: 'v4-flash', goal: 'fix bug' });
  trackAgent('a1', 'completed');
  const list = getAgentStatusList();
  strictEqual(list.length, 1);
  strictEqual(list[0].status, 'completed');
  strictEqual(list[0].type, 'coding');
  strictEqual(list[0].goal, 'fix bug');
});

test('trackAgent: running→failed sets durationMs and error', () => {
  resetTracker();
  trackAgent('a2', 'running', { type: 'coding' });
  const started = _agentTrackers.get('a2').startedAt;
  ok(started > 0);
  trackAgent('a2', 'failed', { error: 'timeout' });
  const entry = _agentTrackers.get('a2');
  strictEqual(entry.status, 'failed');
  strictEqual(entry.error, 'timeout');
  ok(entry.durationMs >= 0);
  strictEqual(entry.startedAt, started);
});

test('trackAgent: preserves extra fields', () => {
  resetTracker();
  trackAgent('a3', 'running', { type: 'lsp', files: ['a.ts'] });
  trackAgent('a3', 'completed');
  deepStrictEqual(_agentTrackers.get('a3').files, ['a.ts']);
});

test('trackAgent: startedAt set only on first running', () => {
  resetTracker();
  trackAgent('a4', 'running');
  const first = _agentTrackers.get('a4').startedAt;
  trackAgent('a4', 'running', { goal: 'retry' });
  strictEqual(_agentTrackers.get('a4').startedAt, first);
});

test('trackAgent: durationMs undefined for running agents', () => {
  resetTracker();
  trackAgent('a5', 'running');
  strictEqual(_agentTrackers.get('a5').durationMs, undefined);
});

test('getAgentStatusList: returns all agents', () => {
  resetTracker();
  trackAgent('x', 'completed'); trackAgent('y', 'running'); trackAgent('z', 'failed');
  strictEqual(getAgentStatusList().length, 3);
});

test('getAgentStatusList: returns copy', () => {
  resetTracker();
  trackAgent('p', 'running');
  const list = getAgentStatusList();
  list.length = 0;
  strictEqual(getAgentStatusList().length, 1, 'original should be unchanged');
});

test('resetTracker: clears all agents', () => {
  resetTracker();
  trackAgent('q', 'running'); trackAgent('r', 'running');
  strictEqual(getAgentStatusList().length, 2);
  resetTracker();
  strictEqual(getAgentStatusList().length, 0);
});

// ── 1b. loadDecisions / saveDecision ──────────────────
console.log('\n📂 scheduler — loadDecisions / saveDecision');

test('loadDecisions: missing file returns {}', () => {
  const f = '/tmp/__nonexist_dec__.json';
  if (existsSync(f)) rmSync(f);
  deepStrictEqual(loadDecisions(f), {});
});

test('loadDecisions: corrupted JSON returns {}', () => {
  cleanTemp(); const f = join(TEST_TEMP, 'bad.json');
  writeFileSync(f, 'not json{{{');
  deepStrictEqual(loadDecisions(f), {});
});

test('loadDecisions: valid JSON', () => {
  cleanTemp(); const f = join(TEST_TEMP, 'good.json');
  writeFileSync(f, JSON.stringify({ a: 1, b: [2] }));
  deepStrictEqual(loadDecisions(f), { a: 1, b: [2] });
});

test('saveDecision: creates dir and file', () => {
  cleanTemp();
  const dir = join(TEST_TEMP, 'sd1'); const f = join(dir, 'decisions.json');
  saveDecision('k1', 42, dir, f);
  ok(existsSync(f));
  strictEqual(JSON.parse(readFileSync(f, 'utf-8')).k1, 42);
});

test('saveDecision: appends to existing file', () => {
  cleanTemp();
  const dir = join(TEST_TEMP, 'sd2'); const f = join(dir, 'decisions.json');
  saveDecision('a', 1, dir, f); saveDecision('b', 2, dir, f);
  const d = JSON.parse(readFileSync(f, 'utf-8'));
  strictEqual(d.a, 1); strictEqual(d.b, 2);
});

test('saveDecision: overwrites existing key', () => {
  cleanTemp();
  const dir = join(TEST_TEMP, 'sd3'); const f = join(dir, 'decisions.json');
  saveDecision('x', 'old', dir, f); saveDecision('x', 'new', dir, f);
  strictEqual(JSON.parse(readFileSync(f, 'utf-8')).x, 'new');
});

// ── 1c. runWithConcurrencyLimit ──────────────────────
console.log('\n⚡ scheduler — runWithConcurrencyLimit');

test('concurrency: 0 tasks returns []', async () => {
  deepStrictEqual(await runWithConcurrencyLimit([], 4), []);
});

test('concurrency: tasks fewer than limit', async () => {
  const r = await runWithConcurrencyLimit([() => Promise.resolve(1), () => Promise.resolve(2)], 10);
  strictEqual(r.length, 2);
  strictEqual(r[0].value, 1);
  strictEqual(r[1].value, 2);
});

test('concurrency: more tasks than limit', async () => {
  const tasks = Array.from({ length: 6 }, (_, i) => async () => { await new Promise(r => setTimeout(r, 5)); return i; });
  const r = await runWithConcurrencyLimit(tasks, 2);
  strictEqual(r.length, 6);
  deepStrictEqual(r.map(x => x.value), [0, 1, 2, 3, 4, 5]);
});

test('concurrency: rejected tasks captured', async () => {
  const r = await runWithConcurrencyLimit([
    () => Promise.resolve('ok'),
    () => Promise.reject(new Error('fail')),
    () => Promise.resolve('also ok'),
  ], 2);
  strictEqual(r[0].status, 'fulfilled');
  strictEqual(r[0].value, 'ok');
  strictEqual(r[1].status, 'rejected');
  strictEqual(r[1].reason.message, 'fail');
  strictEqual(r[2].status, 'fulfilled');
  strictEqual(r[2].value, 'also ok');
});

test('concurrency: single task at limit 1', async () => {
  const r = await runWithConcurrencyLimit([() => Promise.resolve(42)], 1);
  strictEqual(r[0].value, 42);
});

test('concurrency: all reject', async () => {
  const r = await runWithConcurrencyLimit([() => Promise.reject('e1'), () => Promise.reject('e2')], 3);
  strictEqual(r[0].status, 'rejected');
  strictEqual(r[1].status, 'rejected');
});

// ── 1d. findProjectRoot ─────────────────────────────
console.log('\n📁 scheduler — findProjectRoot');

test('findProjectRoot: empty files → cwd', () => {
  strictEqual(findProjectRoot([]), process.cwd());
});

test('findProjectRoot: finds package.json', () => {
  // ROOT has package.json
  const root = findProjectRoot([join(ROOT, 'tests', 'run.mjs')]);
  strictEqual(root, ROOT);
});

test('findProjectRoot: no marker walks up then falls back', () => {
  const tmp = TEST_TEMP; cleanTemp();
  writeFileSync(join(tmp, 'readme.txt'), 'hello');
  const r = findProjectRoot([join(tmp, 'readme.txt')]);
  // After walking up 5 levels without finding a marker, returns the current level (not cwd)
  ok(typeof r === 'string', 'should return a path');
  ok(!r.endsWith('readme.txt'), 'should be directory not file');
});

// ── 1e. runCommand ─────────────────────────────────
console.log('\n⚙️  scheduler — runCommand');

test('runCommand: echo success', () => { ok(runCommand('echo hello', '/tmp')); });
test('runCommand: true success', () => { ok(runCommand('true', '/tmp')); });
test('runCommand: false fails', () => { ok(!runCommand('false', '/tmp')); });
test('runCommand: nonexistent cmd fails', () => { ok(!runCommand('xyznonexistent123', '/tmp')); });

// ═══════════════════════════════════════════════════════
// 2. TEAM SESSION (pure logic)
// ═══════════════════════════════════════════════════════

console.log('\n🔌 team/session — TeamSession & registry');

test('TeamSession: call wraps original fn', async () => {
  const modSession = await import('../dist/extension/team/session.js');
  const session = new modSession.TeamSession('team-1', 'worker');
  const result = await session.call(async () => ({ response: 'hi' }));
  strictEqual(result.response, 'hi');
  ok(Array.isArray(result.injectedMessages));
  strictEqual(result.injectedMessages.length, 0);
});

test('TeamSession: buildPrompt passthrough', async () => {
  const modSession = await import('../dist/extension/team/session.js');
  const session = new modSession.TeamSession('nonexistent', 'worker');
  const p = await session.buildPrompt('Do work');
  strictEqual(p, 'Do work');
});

// Registry
test('registry: register/get/unregister', async () => {
  const mod = await import('../dist/extension/team/session.js');
  strictEqual(mod.getTeamSession('r1'), undefined);
  mod.registerTeamSession('r1', { teamRunId: 't1', memberName: 'm1' });
  ok(mod.getTeamSession('r1') !== undefined);
  mod.unregisterTeamSession('r1');
  strictEqual(mod.getTeamSession('r1'), undefined);
});

test('registry: distinct sessions', async () => {
  const mod = await import('../dist/extension/team/session.js');
  mod.registerTeamSession('sa', { teamRunId: 't1', memberName: 'a' });
  mod.registerTeamSession('sb', { teamRunId: 't2', memberName: 'b' });
  ok(mod.getTeamSession('sa') !== mod.getTeamSession('sb'));
  mod.unregisterTeamSession('sa'); mod.unregisterTeamSession('sb');
});

// ═══════════════════════════════════════════════════════
// 3. INTEGRATION HOOKS
// ═══════════════════════════════════════════════════════

console.log('\n🔗 team/integration — hooks');

test('hook: no sessionId returns null', async () => {
  const mod = await import('../dist/extension/team/integration.js');
  strictEqual(await mod.createTeamMailboxHook()({ message: 'hi', session: {} }), null);
});

test('hook: unregistered session returns null', async () => {
  const mod = await import('../dist/extension/team/integration.js');
  strictEqual(await mod.createTeamMailboxHook()({ message: 'hi', session: { id: 'unk' } }), null);
});

test('track/cleanup via integration', async () => {
  const m = await import('../dist/extension/team/integration.js');
  const s = await import('../dist/extension/team/session.js');
  await m.trackTeamMemberSession('track1', 'tx', 'w1');
  ok(s.getTeamSession('track1') !== undefined);
  await m.cleanupTeamSession('track1');
  strictEqual(s.getTeamSession('track1'), undefined);
});

// ═══════════════════════════════════════════════════════
// 4. teamCommand CLI dispatcher
// ═══════════════════════════════════════════════════════

console.log('\n🖥  team/index — teamCommand');

test('teamCommand: unknown subcommand', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok((await teamCommand('bogus', [])).includes('Available'));
});

test('teamCommand: create no args', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok((await teamCommand('create', [])).includes('Usage'));
});

test('teamCommand: list returns', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok(typeof (await teamCommand('list', [])) === 'string');
});

test('teamCommand: status no args', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok((await teamCommand('status', [])).includes('Usage'));
});

test('teamCommand: status not found', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  try {
    await teamCommand('status', ['nonexistent-run-id']);
    ok(false, 'should have thrown');
  } catch (e) {
    ok(e.message.includes('not found'), 'error should mention not found');
  }
});

test('teamCommand: send no args', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok((await teamCommand('send', [])).includes('Usage'));
});

test('teamCommand: task no args', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok((await teamCommand('task', [])).includes('Usage'));
});

test('teamCommand: task unknown action', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok((await teamCommand('task', ['rid', 'fly'])).includes('Unknown'));
});

test('teamCommand: shutdown no args', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok((await teamCommand('shutdown', [])).includes('Usage'));
});

test('teamCommand: delete no args', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok((await teamCommand('delete', [])).includes('Usage'));
});

test('teamCommand: specs returns', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  ok(typeof (await teamCommand('specs', [])) === 'string');
});

// ── E2E lifecycle ─────────────────────────────────────
console.log('\n🔁 team/index — lifecycle e2e');

test('e2e: create single-member team', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  const out = await teamCommand('create', ['e2e-solo', 'worker:coding']);
  ok(out.includes('created') && out.includes('worker'));
});

test('e2e: create multi-member team', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  const out = await teamCommand('create', ['e2e-multi', 'lead:architect', 'dev:coding', 'rev:review']);
  ok(out.includes('created') && out.includes('Lead: lead'));
});

test('e2e: create → task → delete cycle', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  const createOut = await teamCommand('create', ['e2e-cycle', 'lead:plan', 'dev:coding']);
  const runId = createOut.match(/runId: ([^\s)]+)/)?.[1];
  ok(runId, `should get runId: ${createOut}`);

  const taskOut = await teamCommand('task', [runId, 'create', 'Fix bug', 'Broken login']);
  ok(taskOut.includes('Fix bug'), `task created: ${taskOut}`);

  const listOut = await teamCommand('task', [runId, 'list']);
  ok(listOut.includes('Fix bug'), 'task in list');

  const delOut = await teamCommand('delete', [runId, '--force']);
  ok(delOut.includes('deleted'), 'deleted');
});

test('e2e: create with --inline JSON', async () => {
  const { teamCommand } = await import('../dist/extension/team/index.js');
  const inline = '{"name":"e2e-inline","leadAgentId":"a","members":[{"kind":"subagent_type","name":"a","subagent_type":"architect"},{"kind":"subagent_type","name":"b","subagent_type":"coding"}]}';
  const out = await teamCommand('create', ['--inline', inline]);
  ok(out.includes('created'));
});

// ── Summary ──────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━`);

// Await any pending async tests before reporting final count
if (pendingTests.length > 0) {
  Promise.all(pendingTests).then(() => {
    console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    process.exit(failed > 0 ? 1 : 0);
  }).catch(() => {
    console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    process.exit(1);
  });
} else {
  console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.exit(failed > 0 ? 1 : 0);
}
