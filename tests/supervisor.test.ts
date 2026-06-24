/**
 * yu-agent — Supervisor 单元测试
 *
 * 覆盖 IPC 消息处理 (handleChildMessage)、killChild、scheduleRestart。
 * Worker/process 启动本身（Bun.spawn / new Worker）在集成测试中覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test'

// ── Setup: create a Supervisor instance with minimal mocking ──

let Supervisor: any
let supervisor: any

beforeEach(async () => {
  // Dynamic import to isolate module state
  const mod = await import('../extension/supervisor.js')
  Supervisor = mod.Supervisor
  supervisor = new Supervisor()
})

afterEach(() => {
  supervisor = null
})

// ── handleChildMessage tests ──

describe('handleChildMessage', () => {
  it('updates status from spawning to running on pong', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'spawning',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 1,
    })

    ;(supervisor as any).handleChildMessage('test', { type: 'pong' })

    const child = supervisor.children.get('test')
    expect(child.status).toBe('running')
    expect(child.restartCount).toBe(0)
  })

  it('resets restartCount on pong', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'running',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 3,
      resident: true,
      pid: 1,
    })
    supervisor.restartCount.set('test', 3)

    ;(supervisor as any).handleChildMessage('test', { type: 'pong' })

    expect(supervisor.restartCount.get('test')).toBe(0)
    const child = supervisor.children.get('test')
    expect(child.restartCount).toBe(0)
  })

  it('updates lastHeartbeat on heartbeat', () => {
    const before = Date.now() - 10000
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'running',
      startedAt: before,
      lastHeartbeat: before,
      restartCount: 0,
      resident: true,
      pid: 1,
    })

    ;(supervisor as any).handleChildMessage('test', { type: 'heartbeat' })

    const child = supervisor.children.get('test')
    expect(child.lastHeartbeat).toBeGreaterThan(before)
  })

  it('promotes spawning to running on heartbeat', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'spawning',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 1,
    })

    ;(supervisor as any).handleChildMessage('test', { type: 'heartbeat' })

    expect(supervisor.children.get('test').status).toBe('running')
  })

  it('promotes degraded to running on heartbeat', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'degraded',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 1,
    })

    ;(supervisor as any).handleChildMessage('test', { type: 'heartbeat' })

    expect(supervisor.children.get('test').status).toBe('running')
  })

  it('sets status to stopped on task_result when non-resident', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'running',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: false,
      pid: 1,
    })

    ;(supervisor as any).handleChildMessage('test', { type: 'task_result' })

    expect(supervisor.children.get('test').status).toBe('stopped')
  })

  it('keeps running on task_result when resident', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'running',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 1,
    })

    ;(supervisor as any).handleChildMessage('test', { type: 'task_result' })

    expect(supervisor.children.get('test').status).toBe('running')
  })

  it('sets degraded on error message', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'running',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 1,
    })

    ;(supervisor as any).handleChildMessage('test', { type: 'error', payload: { error: 'oops' } })

    expect(supervisor.children.get('test').status).toBe('degraded')
  })

  it('does nothing for unknown child', () => {
    // Should not throw
    ;(supervisor as any).handleChildMessage('nonexistent', { type: 'pong' })
  })

  it('does nothing for unknown message type', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'running',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 1,
    })

    // Should not throw
    ;(supervisor as any).handleChildMessage('test', { type: 'unknown_type' })
    expect(supervisor.children.get('test').status).toBe('running')
  })
})

// ── killChild tests ──

describe('killChild', () => {
  it('terminates a Worker child', () => {
    let terminated = false
    const mockWorker = {
      terminate: () => { terminated = true },
      threadId: 42,
    }

    supervisor.children.set('test', {
      topicName: 'test',
      status: 'running',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 42,
    })
    supervisor.processes.set('test', mockWorker)
    supervisor.killRequested = new Set()

    supervisor.killChild('test')

    expect(terminated).toBe(true)
    expect(supervisor.killRequested.has('test')).toBe(true)
  })

  it('does not throw for non-existent child', () => {
    supervisor.killRequested = new Set()
    expect(() => supervisor.killChild('nonexistent')).not.toThrow()
  })

  it('marks child as stopped', () => {
    const mockWorker = { terminate: () => {}, threadId: 1 }
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'running',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 1,
    })
    supervisor.processes.set('test', mockWorker)
    supervisor.killRequested = new Set()

    supervisor.killChild('test')

    expect(supervisor.children.get('test').status).toBe('stopped')
  })
})

// ── scheduleRestart tests ──

describe('scheduleRestart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not restart if already restarting', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'dead',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 1,
    })
    supervisor.restarting.add('test')

    const spyWorker = vi.spyOn(supervisor, 'spawnWorker')
    const spyChild = vi.spyOn(supervisor, 'spawnChild')
    ;(supervisor as any).scheduleRestart('test')

    expect(spyWorker).not.toHaveBeenCalled()
    expect(spyChild).not.toHaveBeenCalled()
  })

  it('does not restart if restartCount exceeds maxRetries', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'dead',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 999,
      resident: true,
      pid: 1,
    })

    const spyWorker = vi.spyOn(supervisor, 'spawnWorker')
    ;(supervisor as any).scheduleRestart('test')

    expect(spyWorker).not.toHaveBeenCalled()
  })

  it('sets status to restarting', () => {
    supervisor.children.set('test', {
      topicName: 'test',
      status: 'dead',
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      restartCount: 0,
      resident: true,
      pid: 1,
    })

    ;(supervisor as any).scheduleRestart('test')

    const child = supervisor.children.get('test')
    expect(child.status).toBe('restarting')
    expect(child.restartCount).toBe(1)
  })
})
