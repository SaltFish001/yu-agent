/**
 * yu-agent — Team mode 功能测试
 *
 * 测试核心模块的纯函数逻辑，不依赖 LLM API。
 * 用 node 直接跑：node tests/team-mode.mjs
 */

import { strictEqual, ok } from 'node:assert';
import { mkdirSync, rmSync, } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _ROOT = resolve(__dirname, '..');

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

// ── Import dist modules ────────────────────────────────

let types, mailbox, tasklist, runtime, registry;

try {
  types = await import('../dist/extension/team/types.js');
  mailbox = await import('../dist/extension/team/mailbox.js');
  tasklist = await import('../dist/extension/team/tasklist.js');
  runtime = await import('../dist/extension/team/runtime.js');
  registry = await import('../dist/extension/team/registry.js');
} catch (e) {
  console.error('Failed to load team modules:', e.message);
  process.exit(1);
}

// ── Helper: clean up test runtime dir ──────────────────

const TEST_BASE = resolve(process.env.HOME || '/tmp', '.yu-test');

function withTestEnv(fn) {
  return async () => {
    // Override YU_TEAMS_BASE for tests
    const orig = mailbox.YU_TEAMS_BASE;
    try {
      mailbox.YU_TEAMS_BASE = TEST_BASE;
      rmSync(TEST_BASE, { recursive: true, force: true });
      mkdirSync(TEST_BASE, { recursive: true });
      await fn();
    } finally {
      mailbox.YU_TEAMS_BASE = orig;
    }
  };
}

// ── Tests ──────────────────────────────────────────────

console.log('\n📋 yu-agent Team Mode 测试套件\n');

// 1. Types & Schemas
console.log('📐 types — 类型校验');

test('TeamSpecSchema: 最小有效 spec', () => {
  const spec = types.TeamSpecSchema.parse({
    name: 'test-team',
    members: [{ kind: 'subagent_type', name: 'worker', subagent_type: 'coding' }],
  });
  strictEqual(spec.name, 'test-team');
  strictEqual(spec.leadAgentId, 'worker');
  strictEqual(spec.members.length, 1);
});

test('TeamSpecSchema: 多成员必须指定 lead', () => {
  ok.throws(() => {
    types.TeamSpecSchema.parse({
      name: 'multi',
      members: [
        { kind: 'subagent_type', name: 'a', subagent_type: 'coding' },
        { kind: 'subagent_type', name: 'b', subagent_type: 'coding' },
      ],
    });
  }, /leadAgentId/);
});

test('TeamSpecSchema: 多成员指定 leadAgentId 不抛错', () => {
  const spec = types.TeamSpecSchema.parse({
    name: 'multi',
    leadAgentId: 'a',
    members: [
      { kind: 'subagent_type', name: 'a', subagent_type: 'architect' },
      { kind: 'subagent_type', name: 'b', subagent_type: 'coding' },
    ],
  });
  strictEqual(spec.leadAgentId, 'a');
  strictEqual(spec.members.length, 2);
});

test('TeamSpecSchema: 名字只能用 a-z0-9-', () => {
  ok.throws(() => {
    types.TeamSpecSchema.parse({
      name: 'Bad Team!',
      members: [{ kind: 'subagent_type', name: 'w', subagent_type: 'coding' }],
    });
  });
});

test('MessageSchema: 有效消息', () => {
  const msg = types.MessageSchema.parse({
    version: 1,
    messageId: randomUUID(),
    from: 'lead',
    to: 'worker',
    kind: 'message',
    body: 'Hello',
    timestamp: Date.now(),
  });
  strictEqual(msg.from, 'lead');
  strictEqual(msg.to, 'worker');
});

test('MessageSchema: 消息体超 32KB 拒绝', () => {
  ok.throws(() => {
    types.MessageSchema.parse({
      version: 1,
      messageId: randomUUID(),
      from: 'a',
      to: 'b',
      kind: 'message',
      body: 'x'.repeat(33 * 1024),
      timestamp: Date.now(),
    });
  });
});

test('TaskSchema: 创建任务', () => {
  const task = types.TaskSchema.parse({
    version: 1,
    id: 'abc123',
    subject: 'Fix login',
    description: 'The login button is broken',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  strictEqual(task.status, 'pending');
  strictEqual(task.subject, 'Fix login');
});

test('TaskSchema: 无效状态拒绝', () => {
  ok.throws(() => {
    types.TaskSchema.parse({
      version: 1,
      id: 'x',
      subject: 'x',
      description: '',
      status: 'invalid_status',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
});

test('RuntimeStateSchema: 有效 runtime', () => {
  const state = types.RuntimeStateSchema.parse({
    version: 1,
    teamRunId: randomUUID(),
    teamName: 'test',
    specSource: 'user',
    createdAt: Date.now(),
    status: 'active',
    members: [
      { name: 'lead', agentType: 'leader', status: 'running' },
      { name: 'worker', agentType: 'general-purpose', status: 'pending' },
    ],
    bounds: {},
  });
  strictEqual(state.status, 'active');
  strictEqual(state.members.length, 2);
});

// 2. Mailbox
console.log('\n📬 mailbox — 异步消息');

test('mailbox: send + listUnread', withTestEnv(async () => {
  const teamRunId = randomUUID();
  const msgId = randomUUID();
  const msg = {
    version: 1,
    messageId: msgId,
    from: 'lead',
    to: 'worker',
    kind: 'message',
    body: 'Hello worker!',
    timestamp: Date.now(),
  };

  await mailbox.sendMessage(msg, teamRunId, {
    isLead: true,
    activeMembers: ['worker'],
  });

  const unread = await mailbox.listUnread(teamRunId, 'worker');
  strictEqual(unread.length, 1);
  strictEqual(unread[0].body, 'Hello worker!');
  strictEqual(unread[0].from, 'lead');
}));

test('mailbox: send 广播需 lead 权限', withTestEnv(async () => {
  try {
    await mailbox.sendMessage({
      version: 1,
      messageId: randomUUID(),
      from: 'worker',
      to: '*',
      kind: 'message',
      body: 'broadcast',
      timestamp: Date.now(),
    }, randomUUID(), { isLead: false, activeMembers: ['a', 'b'] });
    ok(false, 'should have thrown');
  } catch (e) {
    ok(e instanceof mailbox.BroadcastNotPermittedError);
  }
}));

test('mailbox: ack 后 inbox 为空', withTestEnv(async () => {
  const teamRunId = randomUUID();
  const msgId = randomUUID();

  await mailbox.sendMessage({
    version: 1,
    messageId: msgId,
    from: 'lead',
    to: 'worker',
    kind: 'message',
    body: 'Ack me',
    timestamp: Date.now(),
  }, teamRunId, { isLead: true, activeMembers: ['worker'] });

  await mailbox.ackMessages(teamRunId, 'worker', [msgId]);
  const unread = await mailbox.listUnread(teamRunId, 'worker');
  strictEqual(unread.length, 0);
}));

test('mailbox: buildEnvelope 格式正确', () => {
  const msg = {
    version: 1,
    messageId: 'abc-123',
    from: 'lead',
    to: 'worker',
    kind: 'message',
    body: 'Do the thing',
    timestamp: 1000,
    summary: 'Quick task',
  };
  const env = mailbox.buildEnvelope(msg);
  ok(env.includes('<peer_message'));
  ok(env.includes('from="lead"'));
  ok(env.includes('messageId="abc-123"'));
  ok(env.includes('Do the thing'));
  ok(env.includes('</peer_message>'));
});

test('mailbox: pollAndInject 空 inbox', withTestEnv(async () => {
  const result = await mailbox.pollAndInject(randomUUID(), 'worker', 'turn1');
  strictEqual(result.injected, false);
  strictEqual(result.reason, 'no unread');
}));

test('mailbox: pollAndInject 有新消息', withTestEnv(async () => {
  const teamRunId = randomUUID();
  await mailbox.sendMessage({
    version: 1,
    messageId: randomUUID(),
    from: 'lead',
    to: 'worker',
    kind: 'message',
    body: 'New work',
    timestamp: Date.now(),
  }, teamRunId, { isLead: true, activeMembers: ['worker'] });

  const result = await mailbox.pollAndInject(teamRunId, 'worker', 'turn1');
  strictEqual(result.injected, true);
  ok(result.content.includes('New work'));
  strictEqual(result.messageIds.length, 1);
}));

test('mailbox: 重复 inject 跳过已注入', withTestEnv(async () => {
  const teamRunId = randomUUID();
  const msgId = randomUUID();
  await mailbox.sendMessage({
    version: 1,
    messageId: msgId,
    from: 'lead',
    to: 'worker',
    kind: 'message',
    body: 'Once',
    timestamp: Date.now(),
  }, teamRunId, { isLead: true, activeMembers: ['worker'] });

  const r1 = await mailbox.pollAndInject(teamRunId, 'worker', 'turn1');
  strictEqual(r1.injected, true);

  const r2 = await mailbox.pollAndInject(teamRunId, 'worker', 'turn1', 'turn1', [msgId]);
  strictEqual(r2.injected, false);
  strictEqual(r2.reason, 'already injected this turn');
}));

// 3. Tasklist
console.log('\n📋 tasklist — 共享任务板');

test('tasklist: 创建任务', withTestEnv(async () => {
  const task = await tasklist.createTask(randomUUID(), {
    subject: 'Fix bug',
    description: 'The login is broken',
  });
  ok(task.id.length > 0);
  strictEqual(task.status, 'pending');
  strictEqual(task.subject, 'Fix bug');
}));

test('tasklist: 获取任务', withTestEnv(async () => {
  const teamRunId = randomUUID();
  const created = await tasklist.createTask(teamRunId, {
    subject: 'Test',
    description: 'Desc',
  });
  const fetched = await tasklist.getTask(teamRunId, created.id);
  ok(fetched !== null);
  strictEqual(fetched.subject, 'Test');
}));

test('tasklist: 列出任务', withTestEnv(async () => {
  const teamRunId = randomUUID();
  await tasklist.createTask(teamRunId, { subject: 'A', description: '' });
  await tasklist.createTask(teamRunId, { subject: 'B', description: '' });
  const tasks = await tasklist.listTasks(teamRunId);
  strictEqual(tasks.length, 2);
}));

test('tasklist: 认领任务', withTestEnv(async () => {
  const teamRunId = randomUUID();
  const task = await tasklist.createTask(teamRunId, {
    subject: 'Claim me',
    description: '',
  });
  const claimed = await tasklist.claimTask(teamRunId, task.id, 'worker1');
  strictEqual(claimed.status, 'claimed');
  strictEqual(claimed.owner, 'worker1');
}));

test('tasklist: 重复认领抛错', withTestEnv(async () => {
  const teamRunId = randomUUID();
  const task = await tasklist.createTask(teamRunId, { subject: 'X', description: '' });
  await tasklist.claimTask(teamRunId, task.id, 'worker1');
  try {
    await tasklist.claimTask(teamRunId, task.id, 'worker2');
    ok(false, 'should have thrown');
  } catch (e) {
    ok(e instanceof tasklist.AlreadyClaimedError);
  }
}));

test('tasklist: 更新状态', withTestEnv(async () => {
  const teamRunId = randomUUID();
  const task = await tasklist.createTask(teamRunId, { subject: 'X', description: '' });
  const claimed = await tasklist.updateTaskStatus(teamRunId, task.id, 'claimed', 'w');
  strictEqual(claimed.status, 'claimed');
  const done = await tasklist.updateTaskStatus(teamRunId, task.id, 'completed', 'w');
  strictEqual(done.status, 'completed');
}));

test('tasklist: 无效状态转换', withTestEnv(async () => {
  const teamRunId = randomUUID();
  const task = await tasklist.createTask(teamRunId, { subject: 'X', description: '' });
  try {
    await tasklist.updateTaskStatus(teamRunId, task.id, 'completed', 'w');
    ok(false, 'should have thrown');
  } catch (e) {
    ok(e instanceof tasklist.InvalidTaskTransitionError);
  }
}));

// 4. Runtime lifecycle
console.log('\n⚡ runtime — 团队生命周期');

test('runtime: 创建团队', withTestEnv(async () => {
  const spec = types.TeamSpecSchema.parse({
    name: 'lifecycle-test',
    leadAgentId: 'lead',
    members: [
      { kind: 'subagent_type', name: 'lead', subagent_type: 'architect' },
      { kind: 'subagent_type', name: 'worker', subagent_type: 'coding' },
    ],
  });

  const state = await runtime.createTeamRun({ spec });
  strictEqual(state.status, 'active');
  strictEqual(state.teamName, 'lifecycle-test');
  strictEqual(state.members.length, 2);

  const leadMember = state.members.find((m) => m.agentType === 'leader');
  ok(leadMember);
  strictEqual(leadMember.name, 'lead');
}));

test('runtime: 获取团队状态', withTestEnv(async () => {
  const spec = types.TeamSpecSchema.parse({
    name: 'status-test',
    members: [{ kind: 'subagent_type', name: 'only', subagent_type: 'coding' }],
  });
  const state = await runtime.createTeamRun({ spec });
  const fetched = await runtime.getTeamStatus(state.teamRunId);
  strictEqual(fetched.teamRunId, state.teamRunId);
  strictEqual(fetched.status, 'active');
}));

test('runtime: 不存在的团队抛错', withTestEnv(async () => {
  try {
    await runtime.getTeamStatus('nonexistent-uuid');
    ok(false, 'should have thrown');
  } catch (e) {
    ok(e instanceof runtime.TeamNotFoundError);
  }
}));

test('runtime: 更新成员 session', withTestEnv(async () => {
  const spec = types.TeamSpecSchema.parse({
    name: 'session-test',
    members: [{ kind: 'subagent_type', name: 'w', subagent_type: 'coding' }],
  });
  const state = await runtime.createTeamRun({ spec });
  const updated = await runtime.updateMemberSession(state.teamRunId, 'w', {
    sessionId: 'sess-123',
    status: 'running',
  });
  const member = updated.members.find((m) => m.name === 'w');
  strictEqual(member.sessionId, 'sess-123');
  strictEqual(member.status, 'running');
}));

// 5. Registry
console.log('\n📂 registry — 团队配置');

test('registry: buildInlineSpec 单成员', () => {
  const spec = registry.buildInlineSpec('test', [
    { name: 'dev', role: 'coding', prompt: 'Code stuff' },
  ]);
  strictEqual(spec.name, 'test');
  strictEqual(spec.members.length, 1);
  strictEqual(spec.leadAgentId, 'dev');
});

test('registry: buildInlineSpec 多成员选 lead', () => {
  const spec = registry.buildInlineSpec('squad', [
    { name: 'arch', role: 'plan' },
    { name: 'coder', role: 'coding' },
    { name: 'reviewer', role: 'review' },
  ], 0);
  strictEqual(spec.leadAgentId, 'arch');
  strictEqual(spec.members.length, 3);
});

// 6. Integration: end-to-end team lifecycle
console.log('\n🔗 integration — 端到端团队生命周期');

test('e2e: 创建 → 发消息 → 读消息 → 删除', withTestEnv(async () => {
  const spec = types.TeamSpecSchema.parse({
    name: 'e2e-test',
    leadAgentId: 'mgr',
    members: [
      { kind: 'subagent_type', name: 'mgr', subagent_type: 'architect' },
      { kind: 'subagent_type', name: 'dev', subagent_type: 'coding' },
    ],
  });

  const state = await runtime.createTeamRun({ spec });
  strictEqual(state.status, 'active');

  // Lead sends message to dev
  const msgResult = await mailbox.sendMessage({
    version: 1,
    messageId: randomUUID(),
    from: 'mgr',
    to: 'dev',
    kind: 'message',
    body: 'Please implement the login feature.',
    timestamp: Date.now(),
    summary: 'New task: login',
  }, state.teamRunId, { isLead: true, activeMembers: ['dev'] });

  strictEqual(msgResult.deliveredTo.length, 1);

  // Dev polls mailbox
  const inject = await mailbox.pollAndInject(state.teamRunId, 'dev', 'turn1');
  strictEqual(inject.injected, true);
  ok(inject.content.includes('Please implement'));
  ok(inject.content.includes('summary="New task: login"'));

  // Dev acks
  await mailbox.ackMessages(state.teamRunId, 'dev', inject.messageIds);
  const remaining = await mailbox.listUnread(state.teamRunId, 'dev');
  strictEqual(remaining.length, 0);

  // Create a shared task
  const task = await tasklist.createTask(state.teamRunId, {
    subject: 'Implement login',
    description: 'Add user authentication',
    metadata: { assignee: 'dev' },
  });
  strictEqual(task.status, 'pending');

  // Dev claims it
  const claimed = await tasklist.claimTask(state.teamRunId, task.id, 'dev');
  strictEqual(claimed.status, 'claimed');
  strictEqual(claimed.owner, 'dev');

  // Complete it
  const done = await tasklist.updateTaskStatus(state.teamRunId, task.id, 'completed', 'dev');
  strictEqual(done.status, 'completed');

  // Cleanup
  await runtime.deleteTeamRun(state.teamRunId, true);
  try {
    await runtime.getTeamStatus(state.teamRunId);
    ok(false, 'should be gone');
  } catch (e) {
    ok(e instanceof runtime.TeamNotFoundError);
  }
}));

// ── Summary ────────────────────────────────────────────
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

process.exit(failed > 0 ? 1 : 0);
