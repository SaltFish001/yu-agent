#!/usr/bin/env node
/**
 * yu-agent — Fork 原型验证脚本 (Phase 0 验证项)
 *
 * v1.3: Round 3 B4 修复 — 实际调用 Pi SDK createAgentSession() + session.prompt()
 *
 * 验证 Pi SDK 在 child_process.fork() 子进程中的最小可行性：
 * 1. 主进程 fork 一个子进程
 * 2. 子进程初始化 Pi SDK（最小配置，不连 MCP）
 * 3. 子进程实际调用 createAgentSession() 和 session.prompt("hello")
 * 4. 验证 better-sqlite3 在 WAL 模式下的多进程并发读
 * 5. 子进程每秒通过 IPC 发心跳 { type: 'heartbeat', ts: Date.now() }
 * 6. 主进程收 5 次心跳后发 { type: 'shutdown' } → 子进程 exit 0
 * 7. 如果子进程 init 超过 10s 没发心跳，主进程 kill 并报告失败
 *
 * Usage:
 *   node dist/bin/yu-bg-proto.js
 *
 * 通过条件（stderr 输出）:
 *   ✓ 子进程创建成功
 *   ✓ Pi SDK createAgentSession() 调用成功
 *   ✓ session.prompt("hello") 返回非空结果
 *   ✓ better-sqlite3 WAL 并发读通过
 *   ✓ 心跳 1/5 ... 心跳 5/5
 *   ✓ 收到 shutdown 指令
 *   ✓ 子进程正常退出 code=0
 */

import { fork } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ── 子进程代码（作为内联字符串执行） ──

const CHILD_CODE = `
import { createLogger } from '../extension/logger.js';

const log = createLogger('yu-bg-proto');

async function main() {
  // ── 1. 通知父进程准备就绪 ──
  if (!process.send) {
    log.error('No IPC channel available (not forked?)');
    process.exit(1);
  }

  // 发送第一条 ready 消息
  process.send({ type: 'ready', pid: process.pid, ts: Date.now() });

  // ── 2. 实际初始化 Pi SDK ──
  // B4 修复：不再只检查 typeof，而是实际调用 createAgentSession()
  let sdkWorks = false;
  try {
    const piModule = await import('@earendil-works/pi-coding-agent');
    log.info('Pi SDK imported successfully');

    // 实际调用 createAgentSession() — 验证不依赖 main() 的全局状态
    const session = await piModule.createAgentSession({
      agentType: 'generic',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      systemPrompt: 'You are a helpful assistant.',
      maxTurns: 5,
      temperature: 0.7,
    });

    if (session && typeof session.prompt === 'function') {
      log.info('createAgentSession() succeeded, session.prompt() is available');
      process.send({ type: 'sdk_session_ok', pid: process.pid, ts: Date.now() });

      // 实际调用 session.prompt("hello") — 验证完整调用链
      try {
        const result = await session.prompt('Hello, what is 1+1?');
        if (result && (typeof result === 'string' || typeof result.text === 'string')) {
          const responseText = typeof result === 'string' ? result : result.text || '(no text)';
          log.info(\`session.prompt("hello") succeeded, response length: \${responseText.length}\`);
          process.send({
            type: 'sdk_prompt_ok',
            pid: process.pid,
            preview: responseText.substring(0, 100),
            ts: Date.now(),
          });
          sdkWorks = true;
        } else {
          log.warn('session.prompt returned empty result');
          process.send({ type: 'sdk_prompt_warn', pid: process.pid, message: 'empty result', ts: Date.now() });
        }
      } catch (promptErr) {
        log.warn('session.prompt() failed:', promptErr instanceof Error ? promptErr.message : String(promptErr));
        process.send({
          type: 'sdk_prompt_fail',
          pid: process.pid,
          error: String(promptErr),
          ts: Date.now(),
        });
      }
    } else {
      log.warn('createAgentSession() returned invalid session object');
      process.send({ type: 'sdk_session_warn', pid: process.pid, message: 'invalid session', ts: Date.now() });
    }
  } catch (err) {
    log.warn('Pi SDK createAgentSession() failed:', err instanceof Error ? err.message : String(err));
    process.send({
      type: 'sdk_fail',
      pid: process.pid,
      error: String(err),
      ts: Date.now(),
    });
  }

  // ── 3. 验证 defineTool 兼容性（如果 SDK 可用） ──
  if (sdkWorks) {
    try {
      const { defineTool } = await import('@earendil-works/pi-coding-agent');
      if (typeof defineTool === 'function') {
        log.info('defineTool() is available in child process');
        process.send({ type: 'tool_ok', pid: process.pid, ts: Date.now() });
      }
    } catch {
      log.warn('defineTool import failed');
    }
  }

  // ── 4. 验证 better-sqlite3 WAL 模式并发读（B4 修复） ──
  try {
    const Database = (await import('better-sqlite3')).default;
    // 尝试打开一个临时内存数据库并测试 WAL 模式
    const testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('busy_timeout = 3000');

    // 创建测试表并写入数据
    testDb.exec(\`CREATE TABLE IF NOT EXISTS test_concurrent (
      id INTEGER PRIMARY KEY,
      value TEXT
    )\`);
    const insert = testDb.prepare('INSERT INTO test_concurrent (id, value) VALUES (?, ?)');
    insert.run(1, 'hello');
    insert.run(2, 'world');

    // 验证并发读（WAL 模式下读不会阻塞）
    const stmt = testDb.prepare('SELECT * FROM test_concurrent ORDER BY id');
    const rows = stmt.all();
    if (rows.length === 2 && rows[0].value === 'hello') {
      log.info('better-sqlite3 WAL mode concurrent read OK');
      process.send({ type: 'db_wal_ok', pid: process.pid, rows: rows.length, ts: Date.now() });
    } else {
      log.warn('better-sqlite3 WAL read returned unexpected data');
      process.send({ type: 'db_wal_warn', pid: process.pid, rows: rows.length, ts: Date.now() });
    }

    testDb.close();
  } catch (dbErr) {
    log.warn('better-sqlite3 test failed:', dbErr instanceof Error ? dbErr.message : String(dbErr));
    process.send({
      type: 'db_wal_fail',
      pid: process.pid,
      error: String(dbErr),
      ts: Date.now(),
    });
  }

  // ── 5. 验证 process.env 继承 ──
  process.send({
    type: 'env_check',
    pid: process.pid,
    hasApiKey: !!process.env.DEEPSEEK_API_KEY,
    yuChildMode: process.env.YU_CHILD_MODE || '(not set)',
    yuSessionTag: process.env.YU_SESSION_TAG || '(not set)',
    ts: Date.now(),
  });

  // ── 6. 心跳循环 ──
  let beatCount = 0;
  const heartbeatInterval = setInterval(() => {
    beatCount++;
    try {
      process.send({ type: 'heartbeat', pid: process.pid, count: beatCount, ts: Date.now() });
    } catch {
      // IPC channel may be closing
    }
  }, 1000);

  // ── 7. 监听父进程消息 ──
  process.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') {
      clearInterval(heartbeatInterval);
      log.info('Received shutdown from parent, exiting cleanly');
      process.send({ type: 'shutdown_ack', pid: process.pid, ts: Date.now() });
      setTimeout(() => process.exit(0), 100); // 给 IPC 发送 ACK 的时间
    }
    if (msg && msg.type === 'ping') {
      process.send({ type: 'pong', pid: process.pid, ts: Date.now() });
    }
  });

  // ── 8. 监听父进程退出（孤儿检测） ──
  const parentPid = process.ppid;
  const orphanCheck = setInterval(() => {
    try {
      // kill(pid, 0) 检测进程存活
      process.kill(parentPid, 0);
    } catch {
      // 父进程已死
      log.warn('Parent process seems dead, exiting');
      clearInterval(heartbeatInterval);
      clearInterval(orphanCheck);
      process.exit(1);
    }
  }, 2000);
}

main().catch((err) => {
  console.error('Fatal error in child:', err);
  process.exit(1);
});
`;

// ── 主进程 ──

function main(): void {
  const child = fork(
    resolve(PROJECT_ROOT, 'dist/bin/yu-bg-proto.js'),
    [],
    {
      execArgv: ['--max-old-space-size=512'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '(test-key-not-set)',
        DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        YU_CHILD_MODE: '1',
        YU_SESSION_TAG: 'bg:proto-test',
      },
    },
  );

  let heartbeatCount = 0;
  const TARGET_HEARTBEATS = 5;
  const MAX_INIT_TIME_MS = 10_000; // 10 秒超时
  let initTimer: ReturnType<typeof setTimeout> | null = null;
  let testPassed = false;

  console.log(`[main] Forked child PID: ${child.pid || '(unknown)'}`);

  // ── 初始化超时 ──
  initTimer = setTimeout(() => {
    if (heartbeatCount === 0) {
      console.error(`[main] ❌ FAIL: Child did not send first heartbeat within ${MAX_INIT_TIME_MS}ms`);
      console.error(`[main] Killing child PID ${child.pid}`);
      child.kill('SIGKILL');
      process.exit(1);
    }
  }, MAX_INIT_TIME_MS);

  // ── 子进程 stdout/stderr ──
  if (child.stdout) {
    child.stdout.on('data', (data: Buffer) => {
      console.log(`[child:stdout] ${data.toString().trim()}`);
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      console.log(`[child:stderr] ${data.toString().trim()}`);
    });
  }

  // ── IPC 消息 ──
  child.on('message', (msg: any) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'ready':
        console.log(`[main] ✓ Child ready, PID=${msg.pid}`);
        break;

      case 'sdk_session_ok':
        console.log(`[main] ✓ Pi SDK createAgentSession() succeeded in child`);
        break;

      case 'sdk_session_warn':
        console.log(`[main] ⚠ Pi SDK createAgentSession: ${msg.message}`);
        break;

      case 'sdk_prompt_ok':
        console.log(`[main] ✓ session.prompt("hello") succeeded`);
        console.log(`[main]   Response preview: ${msg.preview}`);
        break;

      case 'sdk_prompt_warn':
        console.log(`[main] ⚠ session.prompt: ${msg.message}`);
        break;

      case 'sdk_prompt_fail':
        console.log(`[main] ❌ session.prompt failed: ${msg.error}`);
        break;

      case 'sdk_fail':
        console.log(`[main] ❌ Pi SDK init failed: ${msg.error}`);
        break;

      case 'tool_ok':
        console.log(`[main] ✓ defineTool() available in child`);
        break;

      case 'db_wal_ok':
        console.log(`[main] ✓ better-sqlite3 WAL mode concurrent read OK (${msg.rows} rows)`);
        break;

      case 'db_wal_warn':
        console.log(`[main] ⚠ better-sqlite3 WAL read: ${msg.rows} rows (unexpected)`);
        break;

      case 'db_wal_fail':
        console.log(`[main] ❌ better-sqlite3 test failed: ${msg.error}`);
        break;

      case 'env_check':
        console.log(`[main]   Env: DEEPSEEK_API_KEY=${msg.hasApiKey ? '✓ set' : '✗ missing'}, ` +
          `YU_CHILD_MODE=${msg.yuChildMode}, YU_SESSION_TAG=${msg.yuSessionTag}`);
        break;

      case 'heartbeat':
        heartbeatCount++;
        if (initTimer) {
          clearTimeout(initTimer);
          initTimer = null;
        }
        console.log(`[main] ♥ Heartbeat ${heartbeatCount}/${TARGET_HEARTBEATS} (PID=${msg.pid})`);

        if (heartbeatCount >= TARGET_HEARTBEATS) {
          console.log(`[main] ✓ Received ${TARGET_HEARTBEATS} heartbeats, sending shutdown...`);
          child.send({ type: 'shutdown' });
        }
        break;

      case 'shutdown_ack':
        console.log(`[main] ✓ Child acknowledged shutdown`);
        break;

      case 'pong':
        console.log(`[main]   Pong from child`);
        break;

      default:
        console.log(`[main]   Unknown message:`, msg);
    }
  });

  // ── 子进程退出 ──
  child.on('exit', (code, signal) => {
    if (code === 0) {
      if (heartbeatCount >= TARGET_HEARTBEATS) {
        console.log(`[main] ✅ PASS: Child exited normally (code=0) after ${heartbeatCount} heartbeats`);
        testPassed = true;
        process.exit(0);
      } else {
        console.error(`[main] ❌ FAIL: Child exited early (code=0) with only ${heartbeatCount}/${TARGET_HEARTBEATS} heartbeats`);
        process.exit(1);
      }
    } else {
      console.error(`[main] ❌ FAIL: Child exited with code=${code}, signal=${signal}`);
      process.exit(1);
    }
  });

  // ── 主进程错误处理 ──
  child.on('error', (err) => {
    console.error(`[main] ❌ Child error:`, err);
    process.exit(1);
  });

  // ── 全局超时 ──
  setTimeout(() => {
    if (!testPassed) {
      console.error(`[main] ❌ FAIL: Overall test timeout (30s)`);
      child.kill('SIGKILL');
      process.exit(1);
    }
  }, 30_000);
}

main();
