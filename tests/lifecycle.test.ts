/**
 * Unit tests — lifecycle.ts
 *
 * Tests ShutdownManager: agent tracking, handler registration,
 * shutdown idempotency, running drain.
 */

import { describe, expect, it } from 'bun:test'

describe('ShutdownManager', () => {
  it('初始 runningCount 为 0', async () => {
    const { ShutdownManager } = await import('../extension/lifecycle.js')
    const mgr = new ShutdownManager()
    expect(mgr.runningCount).toBe(0)
  })

  it('agentStarted/agentFinished 维护计数', async () => {
    const { ShutdownManager } = await import('../extension/lifecycle.js')
    const mgr = new ShutdownManager()
    mgr.agentStarted('agent-1')
    mgr.agentStarted('agent-2')
    expect(mgr.runningCount).toBe(2)
    mgr.agentFinished('agent-1')
    expect(mgr.runningCount).toBe(1)
    mgr.agentFinished('agent-2')
    expect(mgr.runningCount).toBe(0)
  })

  it('agentFinished 对不存在的 ID 不报错', async () => {
    const { ShutdownManager } = await import('../extension/lifecycle.js')
    const mgr = new ShutdownManager()
    expect(() => mgr.agentFinished('nonexistent')).not.toThrow()
  })

  it('shutdown 调用注册的 handler', async () => {
    const { ShutdownManager } = await import('../extension/lifecycle.js')
    const mgr = new ShutdownManager()
    let called = false
    mgr.registerHandler('test', async () => { called = true })
    await mgr.shutdown('SIGTERM')
    expect(called).toBe(true)
  })

  it('shutdown 是幂等的（重复调用只执行一次）', async () => {
    const { ShutdownManager } = await import('../extension/lifecycle.js')
    const mgr = new ShutdownManager()
    let callCount = 0
    mgr.registerHandler('test', async () => { callCount++ })
    await mgr.shutdown('SIGTERM')
    await mgr.shutdown('SIGINT')
    expect(callCount).toBe(1)
  })

  it('handler 抛出错误时不阻止后续', async () => {
    const { ShutdownManager } = await import('../extension/lifecycle.js')
    const mgr = new ShutdownManager()
    let secondCalled = false
    mgr.registerHandler('fail', async () => { throw new Error('handler error') })
    mgr.registerHandler('ok', async () => { secondCalled = true })
    await expect(mgr.shutdown('SIGTERM')).resolves.toBeUndefined()
    expect(secondCalled).toBe(true)
  })

  it('有 running agent 时 shutdown 等待 drain', async () => {
    const { ShutdownManager } = await import('../extension/lifecycle.js')
    const mgr = new ShutdownManager()
    mgr.agentStarted('agent-1')
    let handlerCalled = false
    mgr.registerHandler('test', async () => { handlerCalled = true })
    // 让 agent 尽快完成
    setTimeout(() => mgr.agentFinished('agent-1'), 50)
    await mgr.shutdown('SIGTERM')
    expect(handlerCalled).toBe(true)
    expect(mgr.runningCount).toBe(0)
  })

  it('shutdown 后 runningCount 不受影响（未 finish 的 agent 保留）', async () => {
    const { ShutdownManager } = await import('../extension/lifecycle.js')
    const mgr = new ShutdownManager()
    mgr.agentStarted('persistent')
    // 让 agent 在 shutdown 过程中完成（触发 drain resolve）
    setTimeout(() => mgr.agentFinished('persistent'), 50)
    await mgr.shutdown('SIGTERM')
    expect(mgr.runningCount).toBe(0)
  })
})
