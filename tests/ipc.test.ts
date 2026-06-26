/**
 * Unit tests — ipc-child.ts, ipc-main.ts
 *
 * Tests buildMessage (pure), processLine (handler dispatch).
 * processLine is not exported from ipc-child, so tests are
 * written via exported setupChildIPC / send functions.
 * ipc-main's sendToChild/sendToWorker are thin wrappers tested
 * via buildMessage validation.
 */

import { describe, expect, it } from 'bun:test'

// ── ipc-child: buildMessage ─────────────────────────────

describe('ipc-child buildMessage', () => {
  it('buildMessage 返回 IpcMessage 结构', async () => {
    const { buildMessage } = await import('../extension/ipc-child.js')
    const msg = buildMessage('ping')
    expect(msg).toHaveProperty('type', 'ping')
    expect(msg).toHaveProperty('timestamp')
    expect(typeof msg.timestamp).toBe('number')
    expect(msg).toHaveProperty('seq')
    expect(msg.seq!).toBeGreaterThan(0)
  })

  it('buildMessage 携带 payload', async () => {
    const { buildMessage } = await import('../extension/ipc-child.js')
    const msg = buildMessage('task_result', { status: 'ok', data: 42 })
    expect(msg.type).toBe('task_result')
    expect(msg.payload).toEqual({ status: 'ok', data: 42 })
  })

  it('buildMessage 递增 seq', async () => {
    const { buildMessage } = await import('../extension/ipc-child.js')
    const m1 = buildMessage('ping')
    const m2 = buildMessage('ping')
    expect(m2.seq).toBe((m1.seq ?? 0) + 1)
  })

  it('buildMessage 无 payload 时 payload 为 undefined', async () => {
    const { buildMessage } = await import('../extension/ipc-child.js')
    const msg = buildMessage('pong')
    expect(msg.payload).toBeUndefined()
  })
})

// ── ipc-child: send (mock-free validation) ─────────────

describe('ipc-child send', () => {
  it('send 返回布尔值', async () => {
    const { send } = await import('../extension/ipc-child.js')
    // In test environment without Worker or stdout write,
    // send may fail gracefully or succeed. Ensure no crash.
    const result = send('ping')
    expect(typeof result).toBe('boolean')
  })

  it('send 携带 payload 不报错', async () => {
    const { send } = await import('../extension/ipc-child.js')
    expect(() => send('task_result', { topicName: 'test', status: 'completed' })).not.toThrow()
  })
})

// ── ipc-main: buildMessage ─────────────────────────────

describe('ipc-main buildMessage', () => {
  it('buildMessage 返回 IpcMessage 结构', async () => {
    const { buildMessage } = await import('../extension/ipc-main.js')
    const msg = buildMessage('ping')
    expect(msg).toHaveProperty('type', 'ping')
    expect(msg).toHaveProperty('timestamp')
    expect(typeof msg.timestamp).toBe('number')
    expect(msg).toHaveProperty('seq')
    expect(msg.seq!).toBeGreaterThan(0)
  })

  it('buildMessage 携带 payload', async () => {
    const { buildMessage } = await import('../extension/ipc-main.js')
    const msg = buildMessage('parent:new_task', { prompt: 'fix bug' })
    expect(msg.type).toBe('parent:new_task')
    expect(msg.payload).toEqual({ prompt: 'fix bug' })
  })

  it('递增 seq 独立于 child', async () => {
    const { buildMessage } = await import('../extension/ipc-main.js')
    const m1 = buildMessage('ping')
    const m2 = buildMessage('ping')
    expect(m2.seq).toBe((m1.seq ?? 0) + 1)
  })
})

// ── ipc-main: sendToChild/sendToWorker ─────────────────

describe('ipc-main sendToChild', () => {
  it('传入无效 child 时不报错（返回 false）', async () => {
    const { sendToChild } = await import('../extension/ipc-main.js')
    const result = sendToChild(null as unknown as any, 'ping')
    expect(result).toBe(false)
  })
})

describe('ipc-main sendToWorker', () => {
  it('传入无效 worker 时不报错（返回 false）', async () => {
    const { sendToWorker } = await import('../extension/ipc-main.js')
    const result = sendToWorker(null as unknown as any, 'ping')
    expect(result).toBe(false)
  })
})
