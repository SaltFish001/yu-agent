/**
 * Integration tests — classifier / scheduler pipeline.
 *
 * Tests classifyIntent() with a mocked spawnAgent function (passed as the
 * optional third parameter). Verifies JSON plan parsing and fallback
 * behavior without requiring an actual LLM API call.
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyIntent } from '../../extension/classifier.js';

describe('Scheduler integration', () => {
  it('parses valid JSON plan from mock spawn', async () => {
    const mockSpawn = vi.fn().mockResolvedValue({
      response: JSON.stringify({
        pass_through: false,
        intent: 'coding',
        agents: [
          { type: 'coding', model: 'v4-flash', id: 'c1', files: ['src/test.ts'] },
        ],
        parallel_groups: [['c1']],
      }),
    });

    const result = await classifyIntent('fix the bug', {}, mockSpawn);
    expect(result).not.toBeNull();
    expect(result?.intent).toBe('coding');
    expect(result?.pass_through).toBe(false);
    expect(result?.agents).toHaveLength(1);
    expect(result?.agents![0].id).toBe('c1');
  });

  it('falls back to pass_through on non-JSON output', async () => {
    const mockSpawn = vi.fn().mockResolvedValue({ response: 'This is not JSON' });
    const result = await classifyIntent('hello', {}, mockSpawn);
    expect(result?.pass_through).toBe(true);
    // Should include a fallback reason
    expect(result?.reasoning).toBeTruthy();
  });

  it('falls back to pass_through on empty output', async () => {
    const mockSpawn = vi.fn().mockResolvedValue({ response: '' });
    const result = await classifyIntent('', {}, mockSpawn);
    expect(result?.pass_through).toBe(true);
  });

  it('passes through long inputs without calling spawn', async () => {
    // Input longer than 200 chars should trigger the fast path
    const longInput =
      '你是我的助手。请帮我完成以下任务：\n\n重要通知：请编写一个完整的 Node.js 应用，' +
      '包含 REST API、数据库连接、用户认证、日志系统、错误处理、单元测试、集成测试、' +
      '以及部署配置。代码必须经过充分测试并且可以投入生产使用。\n\n请生成所有必要文件。';
    const mockSpawn = vi.fn();

    const result = await classifyIntent(longInput, {}, mockSpawn);
    expect(result?.pass_through).toBe(true);
    expect(result?.reasoning).toContain('full instruction');
    // spawn should NOT have been called
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
