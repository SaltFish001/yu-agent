/**
 * Unit tests — status.ts
 *
 * Tests buildSummary (pure function).
 * DB write functions (writeSnapshot, writeAgentStatus, etc.) depend on
 * external DB module and are tested via integration.
 */

import { describe, expect, it } from 'bun:test'
import type { AgentStatus } from '../extension/status.js'

// ── buildSummary ─────────────────────────────────────────

describe('buildSummary', () => {
  it('空数组全部归零', async () => {
    const { buildSummary } = await import('../extension/status.js')
    const s = buildSummary([])
    expect(s).toEqual({ running: 0, completed: 0, failed: 0, mcpConnected: 0, lspReady: 0 })
  })

  it('统计 running/queued 为 active', async () => {
    const { buildSummary } = await import('../extension/status.js')
    const agents: AgentStatus[] = [
      { id: 'a', type: 'coding', model: 'v4', status: 'running' },
      { id: 'b', type: 'search', model: 'v4', status: 'queued' },
      { id: 'c', type: 'plan', model: 'v4', status: 'completed' },
    ]
    const s = buildSummary(agents)
    expect(s.running).toBe(2)
    expect(s.completed).toBe(1)
    expect(s.failed).toBe(0)
  })

  it('统计 completed', async () => {
    const { buildSummary } = await import('../extension/status.js')
    const agents: AgentStatus[] = [
      { id: 'a', type: 'coding', model: 'v4', status: 'completed' },
      { id: 'b', type: 'coding', model: 'v4', status: 'completed' },
      { id: 'c', type: 'coding', model: 'v4', status: 'running' },
    ]
    const s = buildSummary(agents)
    expect(s.completed).toBe(2)
    expect(s.running).toBe(1)
  })

  it('统计 failed/interrupted', async () => {
    const { buildSummary } = await import('../extension/status.js')
    const agents: AgentStatus[] = [
      { id: 'a', type: 'coding', model: 'v4', status: 'failed' },
      { id: 'b', type: 'coding', model: 'v4', status: 'interrupted' },
    ]
    const s = buildSummary(agents)
    expect(s.failed).toBe(2)
    expect(s.running).toBe(0)
    expect(s.completed).toBe(0)
  })

  it('混合状态', async () => {
    const { buildSummary } = await import('../extension/status.js')
    const agents: AgentStatus[] = [
      { id: '1', type: 'coding', model: 'v4', status: 'running' },
      { id: '2', type: 'coding', model: 'v4', status: 'queued' },
      { id: '3', type: 'coding', model: 'v4', status: 'completed' },
      { id: '4', type: 'coding', model: 'v4', status: 'completed' },
      { id: '5', type: 'coding', model: 'v4', status: 'failed' },
      { id: '6', type: 'coding', model: 'v4', status: 'interrupted' },
    ]
    const s = buildSummary(agents)
    expect(s.running).toBe(2)
    expect(s.completed).toBe(2)
    expect(s.failed).toBe(2)
  })

  it('mcpConnected 和 lspReady 始终为 0（未实现）', async () => {
    const { buildSummary } = await import('../extension/status.js')
    const s = buildSummary([{ id: 'a', type: 'coding', model: 'v4', status: 'completed' }])
    expect(s.mcpConnected).toBe(0)
    expect(s.lspReady).toBe(0)
  })
})
