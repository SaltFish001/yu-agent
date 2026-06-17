/**
 * ContextManager — 单元测试
 *
 * 测试 Token 计数、压缩阈值判断、缓存追踪、持久化。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { ContextManager, TokenCounter } from '../extension/context-manager.js'

const TEST_DIR = resolve(process.env.HOME || '/home/saltfish', '.yu', 'test-sessions')

describe('TokenCounter', () => {
  const tc = new TokenCounter()

  test('counts CJK text', () => {
    const tokens = tc.count('你好世界这是一段中文')
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20) // ~2 chars/token
  })

  test('counts English text', () => {
    const tokens = tc.count('hello world this is some english text')
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(15) // ~4 chars/token
  })

  test('counts code content', () => {
    const code = `import { foo } from './bar';
function test() {
  return foo();
}`
    const tokens = tc.count(code)
    expect(tokens).toBeGreaterThan(0)
  })

  test('counts empty string as 0 (no content)', () => {
    expect(tc.count('')).toBe(0)
  })

  test('estimates message array', () => {
    const msgs = [
      { role: 'system' as const, content: 'You are a helpful assistant.' },
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there!' },
    ]
    const total = tc.estimateMessages(msgs)
    expect(total).toBeGreaterThan(0)
  })

  test('isCodeContent detects code patterns', () => {
    expect(TokenCounter.isCodeContent('const x = 1;')).toBe(true)
    expect(TokenCounter.isCodeContent('import { z } from "zod"')).toBe(true)
    expect(TokenCounter.isCodeContent('hello world')).toBe(false)
    expect(TokenCounter.isCodeContent('// comment')).toBe(true)
  })
})

describe('ContextManager', () => {
  let cm: ContextManager

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true })
    cm = new ContextManager({
      systemPrompt: 'You are a test assistant.',
      maxTokens: 1000,
      persistDir: TEST_DIR,
      autoPersist: false,
    })
  })

  afterEach(() => {
    // Cleanup test session files
    try {
      const path = resolve(TEST_DIR, `${cm.id}.json`)
      if (existsSync(path)) unlinkSync(path)
    } catch {
      /* ignore */
    }
  })

  test('system prompt is first message', () => {
    const msgs = cm.getMessages()
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe('You are a test assistant.')
  })

  test('addMessage appends correctly', () => {
    cm.addMessage({ role: 'user', content: 'hello' })
    expect(cm.getMessages().length).toBe(2)
    expect(cm.getLastMessage()?.content).toBe('hello')
  })

  test('totalTokens returns reasonable value', () => {
    cm.addMessage({ role: 'user', content: 'short' })
    const tokens = cm.totalTokens()
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(50)
  })

  test('shouldCompress returns false when under threshold', () => {
    expect(cm.shouldCompress()).toBe(false)
  })

  test('shouldCompress returns true when over threshold', () => {
    // Override maxTokens low
    const small = new ContextManager({
      systemPrompt: 'X',
      maxTokens: 10,
      persistDir: TEST_DIR,
      autoPersist: false,
    })
    small.addMessage({ role: 'user', content: 'hello world this is a long message that will exceed the tiny limit' })
    expect(small.shouldCompress()).toBe(true)
  })

  test('compressRatio returns correct range', () => {
    const ratio = cm.getCompressRatio()
    expect(ratio).toBeGreaterThan(0)
    expect(ratio).toBeLessThan(1)
  })

  test('addToolCalls and addToolResult work', () => {
    cm.addToolCalls([{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }])
    expect(cm.getMessages().length).toBe(2)
    expect(cm.getMessages()[1].tool_calls).toBeDefined()

    cm.addToolResult('call_1', 'output')
    expect(cm.getMessages().length).toBe(3)
  })

  test('recordUsage and getCacheStats', () => {
    cm.recordUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_hit_tokens: 30,
      cache_miss_tokens: 70,
    })

    const stats = cm.getCacheStats()
    expect(stats.hitRate).toBeCloseTo(0.3, 1)
    expect(stats.cacheHitTokens).toBe(30)
    expect(stats.cacheMissTokens).toBe(70)
  })

  test('save and load round-trip', () => {
    cm.addMessage({ role: 'user', content: 'persist test' })
    cm.addMessage({ role: 'assistant', content: 'saved!' })
    cm.recordUsage({ prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 })

    cm.save()

    const loaded = ContextManager.load(cm.id, TEST_DIR)
    expect(loaded).not.toBeNull()
    expect(loaded!.getMessages().length).toBe(3) // system + user + assistant
    expect(loaded!.getLastMessage()?.content).toBe('saved!')

    const stats = loaded!.getCacheStats()
    expect(stats.hitRate).toBe(0) // no cache hits recorded
  })

  test('load returns null for nonexistent id', () => {
    const loaded = ContextManager.load('nonexistent-id', TEST_DIR)
    expect(loaded).toBeNull()
  })

  test('byteSize returns positive value', () => {
    cm.addMessage({ role: 'user', content: 'size test' })
    expect(cm.byteSize()).toBeGreaterThan(0)
  })

  test('compressCount starts at 0', () => {
    expect(cm.getCompressCount()).toBe(0)
    expect(cm.getCompressHistory().length).toBe(0)
  })
})

describe('ContextManager compression (mock API)', () => {
  test('compressIfNeeded returns false when under threshold', async () => {
    const cm = new ContextManager({
      systemPrompt: 'test',
      maxTokens: 10000,
      autoPersist: false,
    })
    const result = await cm.compressIfNeeded({
      chatCompletion: async () => ({
        content: 'summary of conversation',
        finish_reason: 'stop',
      }),
    })
    expect(result).toBe(false)
  })

  test('compressIfNeeded with force=true calls API', async () => {
    const cm = new ContextManager({
      systemPrompt: 'test',
      maxTokens: 100,
      autoPersist: false,
    })
    // Add enough messages to have some beyond keepRecent (6)
    for (let i = 0; i < 5; i++) {
      cm.addMessage({ role: 'user', content: `Old message ${i}` })
      cm.addMessage({ role: 'assistant', content: `Old response ${i}` })
    }
    cm.addMessage({ role: 'user', content: 'Final message' })

    const result = await cm.compressIfNeeded(
      {
        chatCompletion: async () => {
          return {
            content: 'Mock summary: user asked about A, assistant answered B.',
            finish_reason: 'stop',
            usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
          }
        },
      },
      { force: true, compressRatio: 0.5 },
    )

    // Should succeed
    expect(result).toBe(true)
    expect(cm.getCompressCount()).toBe(1)
    expect(cm.getCompressHistory().length).toBe(1)
  })

  test('compressIfNeeded falls back on API failure', async () => {
    const cm = new ContextManager({
      systemPrompt: 'test',
      maxTokens: 50,
      autoPersist: false,
    })
    cm.addMessage({ role: 'user', content: 'X'.repeat(100) })

    const result = await cm.compressIfNeeded(
      {
        chatCompletion: async () => null, // API fails
      },
      { force: true },
    )

    expect(result).toBe(false) // falls back silently
  })
})
