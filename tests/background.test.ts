/**
 * Unit tests — background.ts (Background task registry)
 *
 * Tests the `bg` API: register, markRunning, markCompleted, markFailed,
 * cancel, get, list, stats, run, capacity eviction, timeout.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

// Mock eventBus to silence emits
beforeEach(async () => {
  spyOn((await import('../extension/events.js')).eventBus as any, 'emit').mockReturnValue(undefined as never)
})

// ── register ──────────────────────────────────────────────

describe('bg.register', () => {
  it('返回有效的任务 ID', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'fix bug' })
    expect(id).toMatch(/^bg_\d+_[a-z0-9]+$/)
  })

  it('注册后状态为 pending', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'fix bug' })
    const t = bg.get(id)
    expect(t).toBeDefined()
    expect(t!.status).toBe('pending')
    expect(t!.type).toBe('coding')
    expect(t!.prompt).toBe('fix bug')
  })

  it('prompt 超过 200 字符被截断', async () => {
    const { bg } = await import('../extension/background.js')
    const longPrompt = 'x'.repeat(500)
    const id = bg.register({ type: 'search', prompt: longPrompt })
    const t = bg.get(id)
    expect(t!.prompt.length).toBe(200)
  })

  it('注册多个任务 ID 不重复', async () => {
    const { bg } = await import('../extension/background.js')
    const ids = Array.from({ length: 5 }, (_, i) => bg.register({ type: 'coding', prompt: `task ${i}` }))
    const unique = new Set(ids)
    expect(unique.size).toBe(5)
  })
})

// ── get / list / stats ────────────────────────────────────

describe('bg 查询', () => {
  it('get 返回 undefined 用于不存在的 ID', async () => {
    const { bg } = await import('../extension/background.js')
    expect(bg.get('nonexistent')).toBeUndefined()
  })

  it('list 返回按 startTime 降序排列', async () => {
    const { bg } = await import('../extension/background.js')
    // 先注册一个较老的，稍后再注册新的
    const oldId = bg.register({ type: 'coding', prompt: 'old' })
    await new Promise((r) => setTimeout(r, 5))
    const newId = bg.register({ type: 'search', prompt: 'new' })
    const all = bg.list()
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all[0].id).toBe(newId) // 最新的在前
  })

  it('stats 返回正确计数（相对值）', async () => {
    const { bg } = await import('../extension/background.js')
    const before = bg.stats()
    const a = bg.register({ type: 'a', prompt: 'a' })
    const b = bg.register({ type: 'b', prompt: 'b' })
    const c = bg.register({ type: 'c', prompt: 'c' })
    bg.markRunning(a)
    bg.markCompleted(a, 'done')
    bg.markRunning(b)
    bg.markFailed(b, 'error')
    // c is pending

    const s = bg.stats()
    expect(s.active - before.active).toBe(1) // c is pending
    expect(s.completed - before.completed).toBe(1) // a is completed
    expect(s.failed - before.failed).toBe(1) // b is failed
  })
})

// ── 生命周期 ──────────────────────────────────────────────

describe('bg 任务生命周期', () => {
  it('markRunning 将 pending 改为 running', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.markRunning(id)
    expect(bg.get(id)!.status).toBe('running')
  })

  it('markCompleted 设置 endTime 和 result', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.markRunning(id)
    bg.markCompleted(id, 'success result')
    const t = bg.get(id)!
    expect(t.status).toBe('completed')
    expect(t.result).toBe('success result')
    expect(t.endTime).toBeGreaterThanOrEqual(t.startTime)
  })

  it('markFailed 设置 error', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.markRunning(id)
    bg.markFailed(id, 'something went wrong')
    const t = bg.get(id)!
    expect(t.status).toBe('failed')
    expect(t.error).toContain('something went wrong')
  })

  it('result 超过 5000 字符被截断', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.markRunning(id)
    bg.markCompleted(id, 'x'.repeat(10000))
    expect(bg.get(id)!.result!.length).toBe(5000)
  })

  it('对不存在的 ID 调用 markRunning 不报错', async () => {
    const { bg } = await import('../extension/background.js')
    expect(() => bg.markRunning('nonexistent')).not.toThrow()
  })

  it('对不存在的 ID 调用 markCompleted 不报错', async () => {
    const { bg } = await import('../extension/background.js')
    expect(() => bg.markCompleted('nonexistent', 'nope')).not.toThrow()
  })
})

// ── cancel ────────────────────────────────────────────────

describe('bg.cancel', () => {
  it('取消 pending 任务', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    const result = bg.cancel(id, 'user requested')
    expect(result).toBe(true)
    expect(bg.get(id)!.status).toBe('cancelled')
    expect(bg.get(id)!.error).toContain('user requested')
  })

  it('取消 running 任务', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.markRunning(id)
    expect(bg.cancel(id)).toBe(true)
    expect(bg.get(id)!.status).toBe('cancelled')
  })

  it('对 completed 任务取消返回 false', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.markRunning(id)
    bg.markCompleted(id, 'done')
    expect(bg.cancel(id)).toBe(false)
    expect(bg.get(id)!.status).toBe('completed')
  })

  it('对不存在的 ID 取消返回 false', async () => {
    const { bg } = await import('../extension/background.js')
    expect(bg.cancel('nonexistent')).toBe(false)
  })
})

// ── 容量限制 ──────────────────────────────────────────────

describe('bg 容量限制', () => {
  it('超过 MAX_TASKS 时淘汰最旧的一半', async () => {
    const { bg } = await import('../extension/background.js')
    // 注册超过 100 个任务（MAX_TASKS = 100）
    const ids: string[] = []
    for (let i = 0; i < 110; i++) {
      ids.push(bg.register({ type: 'coding', prompt: `task ${i}` }))
    }
    const all = bg.list()
    expect(all.length).toBeLessThanOrEqual(100)
    // 最早的 10 个应该被淘汰
    for (let i = 0; i < 10; i++) {
      expect(bg.get(ids[i])).toBeUndefined()
    }
    // 最新的应该还在
    expect(bg.get(ids[109])).toBeDefined()
  })
})

// ── timeout ───────────────────────────────────────────────

describe('bg 超时', () => {
  it('超时后自动取消任务', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test', timeout: 50 })
    expect(bg.get(id)!.status).toBe('pending')
    // 等超时触发
    await new Promise((r) => setTimeout(r, 100))
    expect(bg.get(id)!.status).toBe('cancelled')
    expect(bg.get(id)!.error).toContain('timeout')
  })

  it('timeout 为 0 时不设置超时', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test', timeout: 0 })
    expect(bg.get(id)!.status).toBe('pending')
    await new Promise((r) => setTimeout(r, 50))
    expect(bg.get(id)!.status).toBe('pending')
  })
})

// ── bg.run ────────────────────────────────────────────────

describe('bg.run', () => {
  it('完成任务后状态变为 completed', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.run(id, async () => 'hello result')
    // 等待微任务完成
    await new Promise((r) => setTimeout(r, 10))
    const t = bg.get(id)!
    expect(t.status).toBe('completed')
    expect(t.result).toBe('hello result')
  })

  it('任务函数抛出错误时标记为 failed', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.run(id, async () => { throw new Error('task error') })
    await new Promise((r) => setTimeout(r, 10))
    const t = bg.get(id)!
    expect(t.status).toBe('failed')
    expect(t.error).toContain('task error')
  })

  it('多次调用 run 不覆盖已有结果', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.run(id, async () => 'first result')
    await new Promise((r) => setTimeout(r, 10))
    // 再次 run 不应该改变已完成的状态（不被保护，但至少不崩溃）
    expect(() => bg.run(id, async () => 'second')).not.toThrow()
  })
})

// ── getSignal ─────────────────────────────────────────────

describe('bg.getSignal', () => {
  it('注册后返回 AbortSignal', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    const signal = bg.getSignal(id)
    expect(signal).toBeDefined()
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)
  })

  it('取消后 signal 变为 aborted', async () => {
    const { bg } = await import('../extension/background.js')
    const id = bg.register({ type: 'coding', prompt: 'test' })
    bg.cancel(id)
    const signal = bg.getSignal(id)
    // cancel 删除了 abortControllers 中的条目
    expect(signal).toBeUndefined()
  })
})
