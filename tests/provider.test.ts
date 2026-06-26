/**
 * Unit tests — provider.ts
 *
 * Tests getModel (config lookup) and createMockClient (test helper).
 * chatCompletion and getApiKey have external deps (DeepSeek API, file system).
 */

import { describe, expect, it } from 'bun:test'

// ── getModel ─────────────────────────────────────────────

describe('getModel', () => {
  it('已知 agent 类型返回对应 model', async () => {
    const { getModel } = await import('../extension/provider.js')
    const model = getModel('coding')
    expect(typeof model).toBe('string')
    expect(model.length).toBeGreaterThan(0)
  })

  it('未知 agent 类型返回 deepseek-chat', async () => {
    const { getModel } = await import('../extension/provider.js')
    const model = getModel('nonexistent_type_xyz')
    expect(model).toBe('deepseek-chat')
  })

  it('plan 类型返回非空 model', async () => {
    const { getModel } = await import('../extension/provider.js')
    const model = getModel('plan')
    expect(model.length).toBeGreaterThan(0)
  })
})

// ── createMockClient ─────────────────────────────────────

describe('createMockClient', () => {
  it('匹配模式时返回对应 response', async () => {
    const { createMockClient } = await import('../extension/provider.js')
    const client = createMockClient(new Map([['hello', 'Hi there!']]))
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'say hello world' }],
    })
    expect(result?.content).toBe('Hi there!')
  })

  it('不匹配时返回 fallback', async () => {
    const { createMockClient } = await import('../extension/provider.js')
    const client = createMockClient(new Map([['hello', 'Hi!']]))
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'something else' }],
    })
    expect(result?.content).toBe('Mock fallback response')
  })

  it('匹配第一个模式后停止', async () => {
    const { createMockClient } = await import('../extension/provider.js')
    const client = createMockClient(
      new Map([
        ['hello', 'Hello!'],
        ['world', 'World!'],
      ]),
    )
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'hello world' }],
    })
    // hello 先匹配
    expect(result?.content).toBe('Hello!')
  })

  it('返回 finish_reason 为 stop', async () => {
    const { createMockClient } = await import('../extension/provider.js')
    const client = createMockClient(new Map([['test', 'ok']]))
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'test' }],
    })
    expect(result?.finish_reason).toBe('stop')
  })

  it('空消息列表时返回 fallback', async () => {
    const { createMockClient } = await import('../extension/provider.js')
    const client = createMockClient(new Map([['hello', 'Hi']]))
    const result = await client.chatCompletion({
      messages: [],
    })
    expect(result?.content).toBe('Mock fallback response')
  })

  it('空 Map 时始终 fallback', async () => {
    const { createMockClient } = await import('../extension/provider.js')
    const client = createMockClient(new Map())
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'anything' }],
    })
    expect(result?.content).toBe('Mock fallback response')
  })
})
