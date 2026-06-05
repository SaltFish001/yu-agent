/**
 * Integration tests — classifier / scheduler pipeline.
 *
 * Tests classifyIntent() fast path and fallback behavior.
 * These tests work whether or not a DeepSeek API key is configured.
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyIntent } from '../../extension/classifier.js';

// Mock trackAgent and loadDecisions (no external deps)
vi.mock('../../extension/tracker.js', () => ({
  trackAgent: vi.fn(),
  loadDecisions: vi.fn(() => []),
}));

describe('Scheduler integration', () => {
  it('long input fast path returns pass_through', async () => {
    const longInput =
      '你是我的助手。请帮我完成以下任务：\n\n重要通知：请编写一个完整的 Node.js 应用，' +
      '包含 REST API、数据库连接、用户认证、日志系统、错误处理、单元测试、集成测试、' +
      '以及部署配置。代码必须经过充分测试并且可以投入生产使用。\n\n请生成所有必要文件。';

    const result = await classifyIntent(longInput, {});
    expect(result?.pass_through).toBe(true);
    expect(result?.reasoning).toBeTruthy();
  });

  it('short input returns a valid plan (pass_through or intent)', async () => {
    const result = await classifyIntent('hello', {});
    expect(result).toBeTruthy();
    // Either pass_through (no API key) or explicit intent (with API key)
    expect(result?.pass_through === true || typeof result?.intent === 'string').toBe(true);
  });

  it('empty input returns a valid plan', async () => {
    const result = await classifyIntent('', {});
    expect(result).toBeTruthy();
  });

  it('"你是" triggers fast path', async () => {
    const result = await classifyIntent('你是我的助手吗', {});
    expect(result?.pass_through).toBe(true);
  });

  it('non-coding query returns a valid plan', async () => {
    const result = await classifyIntent('今天天气怎么样', {});
    expect(result).toBeTruthy();
  });

  it('coding query returns a valid plan', async () => {
    const result = await classifyIntent('修复这个bug', {});
    expect(result).toBeTruthy();
  });
});
