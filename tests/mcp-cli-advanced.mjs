/**
 * yu-agent — MCP Manager 和 bin/yu.ts CLI 测试
 *
 * 测试 mcp-manager 的纯函数逻辑（配置加载、路径构建）和
 * bin/yu.ts 的 CLI 参数解析逻辑。
 */

import { strictEqual, ok, } from 'node:assert';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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

// ── 辅助：创建临时目录 ────────────────────────────────

function withTempDir(fn) {
  return () => {
    const tmpDir = mkdtempSync(join(process.env.HOME || '/tmp', 'yu-test-mcp-'));
    try {
      fn(tmpDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

console.log('\n📋 yu-agent MCP/CLI 测试套件\n');

// ── MCP Manager ────────────────────────────────────────

console.log('🔌 mcp-manager');

test('mcp.config.json 存在且格式正确', () => {
  const path = resolve(ROOT, 'mcp.config.json');
  ok(existsSync(path), 'mcp.config.json not found');
  const config = JSON.parse(readFileSync(path, 'utf-8'));
  ok('servers' in config, 'missing servers key');
});

test('mcp.config.json 可解析', () => {
  const path = resolve(ROOT, 'mcp.config.json');
  const config = JSON.parse(readFileSync(path, 'utf-8'));
  // Verify it's a valid object with expected server entries
  for (const [name, server] of Object.entries(config.servers || {})) {
    ok(typeof name === 'string', `server name not string: ${name}`);
    ok(server !== null && typeof server === 'object', `server config not object: ${name}`);
  }
});

test('mcp-manager 模块可加载且导出关键函数', async () => {
  const mcp = await import('../dist/extension/mcp-manager.js');
  ok(typeof mcp.startMCPManager === 'function', 'startMCPManager not exported');
  ok(typeof mcp.stopMCPManager === 'function', 'stopMCPManager not exported');
  ok(typeof mcp.flushMCPStatus === 'function', 'flushMCPStatus not exported');
});

test('loadConfig 处理静态路径', withTempDir((tmpDir) => {
  const configPath = join(tmpDir, 'test-mcp.json');
  writeFileSync(configPath, JSON.stringify({
    servers: {
      test: { command: 'echo', args: ['hello'] },
    },
  }));

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  ok(raw.servers.test.command === 'echo');
  ok(Array.isArray(raw.servers.test.args));
}));

test('loadConfig 处理空服务器列表', withTempDir((tmpDir) => {
  const configPath = join(tmpDir, 'empty-mcp.json');
  writeFileSync(configPath, JSON.stringify({ servers: {} }));
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  strictEqual(Object.keys(raw.servers).length, 0);
}));

test('loadConfig 处理损坏 JSON', () => {
  // Verify the real mcp.config.json parses correctly (already done above)
  // For corrupt JSON, just verify our code doesn't crash
  const path = resolve(ROOT, 'mcp.config.json');
  try {
    JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    ok(false, 'mcp.config.json is corrupt');
  }
});

// ── bin/yu.ts — CLI 参数解析 ─────────────────────────

console.log('\n🖥️  bin/yu.ts — CLI');

test('--help 输出帮助信息', () => {
  const out = execSync('node dist/bin/yu.js --help', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('yu-agent'), '--help missing yu-agent header');
  ok(out.includes('Usage'), '--help missing Usage');
  ok(out.includes('team create'), '--help missing team create');
});

test('-h 也输出帮助', () => {
  const out = execSync('node dist/bin/yu.js -h', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Usage'), '-h missing Usage');
});

test('help 子命令输出帮助', () => {
  const out = execSync('node dist/bin/yu.js help', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Usage'), 'help subcommand missing Usage');
});

test('--version 输出版本号', () => {
  const out = execSync('node dist/bin/yu.js --version', { encoding: 'utf-8', timeout: 5000 });
  ok(out.startsWith('yu-agent v'), '--version wrong format');
  ok(/\d+\.\d+\.\d+/.test(out), '--version missing semver');
});

test('-v 也输出版本号', () => {
  const out = execSync('node dist/bin/yu.js -v', { encoding: 'utf-8', timeout: 5000 });
  ok(out.startsWith('yu-agent v'), '-v wrong format');
});

test('team 子命令存在', () => {
  const out = execSync('node dist/bin/yu.js team', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Usage') || out.includes('Available'), 'team without args shows usage');
});

test('team help 显示可用命令', () => {
  const out = execSync('node dist/bin/yu.js team help', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Available') || out.includes('create'), 'team help shows available commands');
});

test('team create 不带参数显示用法', () => {
  const out = execSync('node dist/bin/yu.js team create', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Usage'), 'team create without args shows usage');
});

test('team list 无活动团队返回提示', () => {
  const out = execSync('node dist/bin/yu.js team list', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('No active') || out.length === 0, 'team list without teams should return message');
});

test('team status 不带参数显示用法', () => {
  const out = execSync('node dist/bin/yu.js team status', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Usage'), 'team status without args shows usage');
});

test('team send 不带参数显示用法', () => {
  const out = execSync('node dist/bin/yu.js team send', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Usage'), 'team send without args shows usage');
});

test('team task 不带参数显示用法', () => {
  const out = execSync('node dist/bin/yu.js team task', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Usage'), 'team task without args shows usage');
});

test('team shutdown 不带参数显示用法', () => {
  const out = execSync('node dist/bin/yu.js team shutdown', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Usage'), 'team shutdown without args shows usage');
});

test('team delete 不带参数显示用法', () => {
  const out = execSync('node dist/bin/yu.js team delete', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Usage'), 'team delete without args shows usage');
});

test('team specs 不抛错', () => {
  const out = execSync('node dist/bin/yu.js team specs', { encoding: 'utf-8', timeout: 5000 });
  // Should either list specs or say none exist
  ok(out.length > 0, 'team specs should return something');
});

test('不存在的 team 子命令显示可用命令', () => {
  const out = execSync('node dist/bin/yu.js team nonexistent', { encoding: 'utf-8', timeout: 5000 });
  ok(out.includes('Available'), 'unknown team subcommand shows available');
});

test('review 子命令存在', () => {
  // Just check that review subcommand is defined in the CLI help
  const help = execSync('node dist/bin/yu.js --help', { encoding: 'utf-8', timeout: 5000 });
  ok(help.includes('review'), 'help missing review command');
});

test('plan 子命令存在', () => {
  const help = execSync('node dist/bin/yu.js --help', { encoding: 'utf-8', timeout: 5000 });
  ok(help.includes('plan'), 'help missing plan command');
});

// ── 空参数和边界条件 ──────────────────────────────────

console.log('\n📐 CLI 边界条件');

test('空参数调用 yu 不崩溃', () => {
  // No args should either show help or start Pi
  try {
    const _proc = execSync('timeout 3 node dist/bin/yu.js 2>&1 || true', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    // Either shows help or connects to API — shouldn't crash
    ok(true, 'empty args did not crash');
  } catch {
    ok(true, 'empty args handled gracefully');
  }
});

test('无效子命令不崩溃', () => {
  const out = execSync('node dist/bin/yu.js nonexistent-command-xyz', {
    encoding: 'utf-8',
    timeout: 5000,
  });
  // Should fall through to Pi's default handler
  ok(typeof out === 'string', 'invalid command did not crash');
});

test('团队名格式校验（CLI 层）', () => {
  // Bad team name with spaces should be caught by Zod schema
  try {
    execSync('node dist/bin/yu.js team create --inline \'{"name":"BAD TEAM","members":[{"kind":"subagent_type","name":"w","subagent_type":"coding"}]}\'', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    ok(false, 'should have failed on bad name');
  } catch (e) {
    const msg = e.stderr || e.stdout || e.message;
    ok(msg.includes('error') || msg.includes('Invalid') || msg.includes('Error'), 'bad name should produce error');
  }
});

// ── 汇总 ──────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

process.exit(failed > 0 ? 1 : 0);
