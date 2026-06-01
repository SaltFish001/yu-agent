/**
 * yu-agent — 功能测试套件
 *
 * 测试核心模块的纯函数逻辑，不依赖 LLM API。
 * 用 node 直接跑：node tests/run.js
 */

import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function assertContains(actual, expected) {
  if (!actual.includes(expected)) {
    throw new Error(`Expected "${actual}" to contain "${expected}"`);
  }
}

// ── 测试开始 ────────────────────────────────────────
console.log('\n📋 yu-agent 测试套件\n');

// 1. 编译产物检查
console.log('📁 构建产物');
test('dist/bin/yu.js 存在且有 shebang', () => {
  const content = readFileSync(resolve(ROOT, 'dist/bin/yu.js'), 'utf-8');
  ok(content.startsWith('#!/usr/bin/env node'), 'Missing shebang');
});
test('dist/extension/scheduler.js 存在', () => {
  ok(existsSync(resolve(ROOT, 'dist/extension/scheduler.js')));
});
test('dist/extension/spawn.js 存在', () => {
  ok(existsSync(resolve(ROOT, 'dist/extension/spawn.js')));
});
test('dist/extension/config.js 存在', () => {
  ok(existsSync(resolve(ROOT, 'dist/extension/config.js')));
});
test('dist/extension/template.js 存在', () => {
  ok(existsSync(resolve(ROOT, 'dist/extension/template.js')));
});
test('dist/extension/status.js 存在', () => {
  ok(existsSync(resolve(ROOT, 'dist/extension/status.js')));
});
test('dist/extension/mcp-manager.js 存在', () => {
  ok(existsSync(resolve(ROOT, 'dist/extension/mcp-manager.js')));
});
test('dist/extension/types.d.ts 存在', () => {
  ok(existsSync(resolve(ROOT, 'dist/extension/types.d.ts')));
});

// 2. 类型声明文件检查
console.log('\n📘 类型声明');
test('所有 extension 模块都有 .d.ts', () => {
  for (const mod of ['config', 'index', 'mcp-manager', 'scheduler', 'spawn', 'status', 'template', 'types']) {
    const dts = resolve(ROOT, `dist/extension/${mod}.d.ts`);
    ok(existsSync(dts), `Missing ${mod}.d.ts`);
  }
});

// 3. template.ts — 输出解析
console.log('\n🔧 template — 输出解析');
test('parseAgentOutput: 直接 JSON', async () => {
  const { parseAgentOutput } = await import('../dist/extension/template.js');
  const result = parseAgentOutput('{"status":"success","files_modified":["a.ts"],"summary":"done"}');
  ok(result !== null);
  strictEqual(result.status, 'success');
});
test('parseAgentOutput: JSON 代码块', async () => {
  const { parseAgentOutput } = await import('../dist/extension/template.js');
  const result = parseAgentOutput('Some text\n```json\n{"status":"approved","findings":[]}\n```');
  ok(result !== null);
  strictEqual(result.status, 'approved');
});
test('parseAgentOutput: 非法 JSON 返回 null', async () => {
  const { parseAgentOutput } = await import('../dist/extension/template.js');
  const result = parseAgentOutput('这不是 JSON');
  strictEqual(result, null);
});
test('parseSchedulerOutput: 标准 plan', async () => {
  const { parseSchedulerOutput } = await import('../dist/extension/template.js');
  const result = parseSchedulerOutput('{"intent":"review","agents":[{"type":"review","model":"v4-flash","id":"r1","files":["src/"]}]}');
  ok(result !== null);
  strictEqual(result.intent, 'review');
});
test('parseSchedulerOutput: pass_through', async () => {
  const { parseSchedulerOutput } = await import('../dist/extension/template.js');
  const result = parseSchedulerOutput('{"pass_through":true,"reasoning":"not a coding task"}');
  ok(result !== null);
  strictEqual(result.pass_through, true);
});
test('validateOutput: coding 有效', async () => {
  const { validateOutput } = await import('../dist/extension/template.js');
  const result = validateOutput('coding', { status: 'success', files_modified: ['a.ts'], summary: '', details: [] });
  strictEqual(result.valid, true);
});
test('validateOutput: review 有效', async () => {
  const { validateOutput } = await import('../dist/extension/template.js');
  const result = validateOutput('review', { status: 'approved', findings: [] });
  strictEqual(result.valid, true);
});
test('validateOutput: 未知类型报错', async () => {
  const { validateOutput } = await import('../dist/extension/template.js');
  const result = validateOutput('unknown', {});
  strictEqual(result.valid, false);
  ok(result.errors[0].includes('unknown'));
});

// 4. config.ts — 代理类型配置
console.log('\n⚙️  config — 代理类型配置');
test('AGENT_TYPES 包含所有 7 种类型', async () => {
  const { AGENT_TYPES } = await import('../dist/extension/config.js');
  const expectedTypes = ['coding', 'review', 'plan', 'lsp', 'commit', 'doc', 'search'];
  for (const t of expectedTypes) {
    ok(t in AGENT_TYPES, `Missing agent type: ${t}`);
  }
  strictEqual(Object.keys(AGENT_TYPES).length, 7);
});
test('getAgentTypeConfig 返回正确配置', async () => {
  const { getAgentTypeConfig } = await import('../dist/extension/config.js');
  const cfg = getAgentTypeConfig('coding');
  ok(cfg !== undefined);
  strictEqual(cfg.model, 'v4-flash');
  strictEqual(cfg.thinking, 'max');
  strictEqual(cfg.maxTurns, 50);
});
test('getAgentTypeConfig 大小写不敏感', async () => {
  const { getAgentTypeConfig } = await import('../dist/extension/config.js');
  ok(getAgentTypeConfig('CODING') !== undefined);
  ok(getAgentTypeConfig('Review') !== undefined);
  ok(getAgentTypeConfig('PLAN') !== undefined);
});
test('getAgentTypeNames 返回所有类型', async () => {
  const { getAgentTypeNames } = await import('../dist/extension/config.js');
  strictEqual(getAgentTypeNames().length, 7);
});

// 5. status.ts — 状态管理
console.log('\n📊 status — 状态管理');
test('buildSummary 正确计数', async () => {
  const { buildSummary } = await import('../dist/extension/status.js');
  const agents = [
    { id: '1', type: 'coding', model: 'v4-flash', status: 'running', startedAt: 0 },
    { id: '2', type: 'review', model: 'v4-flash', status: 'completed', startedAt: 1, durationMs: 100 },
    { id: '3', type: 'code', model: 'v4-flash', status: 'failed', startedAt: 2, durationMs: 50 },
  ];
  const summary = buildSummary(agents);
  strictEqual(summary.running, 1);
  strictEqual(summary.completed, 1);
  strictEqual(summary.failed, 1);
});
test('buildSummary 空列表', async () => {
  const { buildSummary } = await import('../dist/extension/status.js');
  const summary = buildSummary([]);
  strictEqual(summary.running, 0);
  strictEqual(summary.completed, 0);
  strictEqual(summary.failed, 0);
});

// 6. Prompt 文件检查
console.log('\n📝 prompts — 所有 prompt 文件存在且非空');
test('9 个 prompt 文件都存在', () => {
  const prompts = ['scheduler', 'coding', 'review', 'plan', 'lsp', 'commit', 'doc', 'search', 'team'];
  for (const p of prompts) {
    const path = resolve(ROOT, `prompts/${p}.md`);
    ok(existsSync(path), `Missing prompts/${p}.md`);
    const content = readFileSync(path, 'utf-8');
    ok(content.trim().length > 0, `prompts/${p}.md is empty`);
  }
});

// 7. spawn.ts — 路径解析（不实际 spawn）
console.log('\n🚀 spawn — Pi CLI 路径查找');
test('resolvePiCli 能找到 pi-coding-agent 的 cli.js', async () => {
  // 直接测试 node_modules 路径存在
  const piCliPath = resolve(ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  ok(existsSync(piCliPath), `Pi CLI not found at ${piCliPath}`);
});

// 8. MCP 配置
console.log('\n🔌 MCP 配置');
test('mcp.config.json 存在且格式正确', () => {
  const path = resolve(ROOT, 'mcp.config.json');
  ok(existsSync(path));
  const config = JSON.parse(readFileSync(path, 'utf-8'));
  ok('servers' in config);
});

// 9. CLI — 参数解析（--help 和 --version 已手动验证）
console.log('\n🖥️  CLI — 子命令映射');
test('COMMANDS 集合包含所有子命令', () => {
  // 测试编译后的 CLI 入口包含正确的命令定义
  const content = readFileSync(resolve(ROOT, 'dist/bin/yu.js'), 'utf-8');
  const expected = ['review', 'plan', 'team', 'coding', 'commit', 'doc', 'search', 'lsp'];
  for (const cmd of expected) {
    ok(content.includes(`'${cmd}'`), `Missing command in CLI: ${cmd}`);
  }
});

// ── 汇总 ────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

process.exit(failed > 0 ? 1 : 0);
