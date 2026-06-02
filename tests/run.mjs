// yu-agent — 功能测试套件
// 测试核心模块的纯函数逻辑，不依赖 LLM API。
// 用 node 直接跑：node tests/run.mjs

import { strictEqual, ok } from 'node:assert';
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

// 3. template.js — 输出解析
console.log('\n🔧 template — 输出解析');
await testAsync('parseAgentOutput: 直接 JSON', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseAgentOutput('{"status":"success","files_modified":["a.ts"],"summary":"done","details":[]}');
  ok(result !== null);
  strictEqual(result.status, 'success');
  strictEqual(result.files_modified?.[0], 'a.ts');
});
await testAsync('parseAgentOutput: JSON 代码块', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseAgentOutput('Some text\n```json\n{"status":"approved","findings":[]}\n```');
  ok(result !== null);
  strictEqual(result.status, 'approved');
});
await testAsync('parseAgentOutput: 非法 JSON 返回 null', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseAgentOutput('这不是 JSON');
  strictEqual(result, null);
});
await testAsync('parseSchedulerOutput: 标准 plan', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('{"intent":"review","agents":[{"type":"review","model":"v4-flash","id":"r1","files":["src/"]}]}');
  ok(result !== null);
  strictEqual(result.intent, 'review');
});
await testAsync('parseSchedulerOutput: pass_through', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.parseSchedulerOutput('{"pass_through":true,"reasoning":"not a coding task"}');
  ok(result !== null);
  strictEqual(result.pass_through, true);
});
await testAsync('validateOutput: coding 有效', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.validateOutput('coding', { status: 'success', files_modified: ['a.ts'], summary: '', details: [] });
  strictEqual(result.valid, true);
});
await testAsync('validateOutput: review 有效', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.validateOutput('review', { status: 'approved', findings: [] });
  strictEqual(result.valid, true);
});
await testAsync('validateOutput: 未知类型报错', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.validateOutput('unknown', {});
  strictEqual(result.valid, false);
  ok(result.errors[0].includes('unknown'));
});
await testAsync('validateOutput: lsp 有效', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.validateOutput('lsp', { status: 'clean', errors_fixed: [], errors_remaining: [] });
  strictEqual(result.valid, true);
});
await testAsync('validateOutput: coding 状态无效', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/template.js'));
  const result = mod.validateOutput('coding', { status: 'invalid_status', files_modified: [] });
  strictEqual(result.valid, false);
});

// 4. config.js — 代理类型配置
console.log('\n⚙️  config — 代理类型配置');
await testAsync('AGENT_TYPES 包含所有 7 种类型', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const types = mod.AGENT_TYPES;
  const expected = ['coding', 'review', 'plan', 'lsp', 'commit', 'doc', 'search'];
  for (const t of expected) {
    ok(t in types, `Missing agent type: ${t}`);
  }
  strictEqual(Object.keys(types).length, 7);
});
await testAsync('getAgentTypeConfig 返回正确配置', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  const cfg = mod.getAgentTypeConfig('coding');
  ok(cfg !== undefined);
  strictEqual(cfg.model, 'v4-flash');
  strictEqual(cfg.thinking, 'max');
  strictEqual(cfg.maxTurns, 50);
});
await testAsync('getAgentTypeConfig 大小写不敏感', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  ok(mod.getAgentTypeConfig('CODING') !== undefined);
  ok(mod.getAgentTypeConfig('Review') !== undefined);
  ok(mod.getAgentTypeConfig('PLAN') !== undefined);
});
await testAsync('getAgentTypeNames 返回所有类型', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/config.js'));
  strictEqual(mod.getAgentTypeNames().length, 7);
});

// 5. status.js — 状态管理
console.log('\n📊 status — 状态管理');
await testAsync('buildSummary 正确计数', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const agents = [
    { id: '1', type: 'coding', model: 'v4-flash', status: 'running', startedAt: 0 },
    { id: '2', type: 'review', model: 'v4-flash', status: 'completed', startedAt: 1, durationMs: 100 },
    { id: '3', type: 'code', model: 'v4-flash', status: 'failed', startedAt: 2, durationMs: 50 },
  ];
  const summary = mod.buildSummary(agents);
  strictEqual(summary.running, 1);
  strictEqual(summary.completed, 1);
  strictEqual(summary.failed, 1);
});
await testAsync('buildSummary 空列表', async () => {
  const mod = await import(resolve(ROOT, 'dist/extension/status.js'));
  const summary = mod.buildSummary([]);
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

// 7. spawn 路径检查
console.log('\n🚀 spawn — Pi CLI 路径');
test('Pi CLI 在 node_modules 中存在', () => {
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
  strictEqual(typeof config.servers, 'object');
});

// 9. CLI — 子命令映射
console.log('\n🖥️  CLI — 子命令定义');
test('CLI 入口包含所有子命令', () => {
  const content = readFileSync(resolve(ROOT, 'dist/bin/yu.js'), 'utf-8');
  const expected = ['review', 'plan', 'team', 'coding', 'commit', 'doc', 'search', 'lsp'];
  for (const cmd of expected) {
    ok(content.includes(`'${cmd}'`), `Missing command in CLI: ${cmd}`);
  }
});
test('CLI 有 --help 和 --version 处理', () => {
  const content = readFileSync(resolve(ROOT, 'dist/bin/yu.js'), 'utf-8');
  ok(content.includes('--help'));
  ok(content.includes('--version'));
});

// 10. package.json 完整性
console.log('\n📦 package.json');
test('bin 指向 dist/bin/yu.js', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
  strictEqual(pkg.bin.yu, './dist/bin/yu.js');
});
test('type 为 module', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
  strictEqual(pkg.type, 'module');
});
test('pi-coding-agent 在 dependencies 中', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
  ok('@earendil-works/pi-coding-agent' in pkg.dependencies);
});

// 11. 类型声明中的类型完整性
console.log('\n🔍 scheduler — 类型完整性检查（编译验证）');
test('scheduler.js 不包含 as any', () => {
  const _content = readFileSync(resolve(ROOT, 'dist/extension/scheduler.js'), 'utf-8');
  // 编译后的 JS 可能会有少量类型擦除残留，但重点检查源码
  const srcContent = readFileSync(resolve(ROOT, 'extension/scheduler.ts'), 'utf-8');
  // 我们的代码中不应该有 as any 了（除了极少数合理的）
  const anyMatches = srcContent.match(/as any/g);
  // 应该有0个 as any
  ok(anyMatches === null || anyMatches.length === 0, `还剩 ${anyMatches?.length} 个 as any`);
});

// ── 汇总 ────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

process.exit(failed > 0 ? 1 : 0);
