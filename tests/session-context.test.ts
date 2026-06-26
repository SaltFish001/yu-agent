/**
 * Unit tests — session-context.ts
 *
 * Tests get/set functions for session tag, agent, model, parent.
 * Uses process.env as state — tests isolate via unique env keys.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const ENV_KEYS = ['YU_SESSION_ID', 'YU_SESSION_AGENT', 'YU_SESSION_MODEL', 'YU_SESSION_PARENT', 'YU_PROJECT_DIR']

beforeEach(() => {
  // Clear env before each test
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
})

// ── Session Tag ─────────────────────────────────────────

describe('session tag', () => {
  it('默认 tag 为 shared', async () => {
    const { getSessionTag } = await import('../extension/session-context.js')
    expect(getSessionTag()).toBe('shared')
  })

  it('setSessionTag 设置 tag', async () => {
    const { getSessionTag, setSessionTag } = await import('../extension/session-context.js')
    setSessionTag('my-session')
    expect(getSessionTag()).toBe('my-session')
  })

  it('setSessionTag 从文件路径提取 tag', async () => {
    const { getSessionTag, setSessionTag } = await import('../extension/session-context.js')
    setSessionTag('/home/user/.yu/sessions/abc123.json')
    expect(getSessionTag()).toBe('abc123')
  })

  it('setSessionTag 清理非法字符', async () => {
    const { getSessionTag, setSessionTag } = await import('../extension/session-context.js')
    setSessionTag('bad chars!@#$')
    expect(getSessionTag()).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('setSessionTag 设置空值时生成 fallback', async () => {
    const { getSessionTag, setSessionTag } = await import('../extension/session-context.js')
    setSessionTag('')
    const tag = getSessionTag()
    expect(tag).toMatch(/^sess_\d+$/)
  })

  it('setSessionTag 设置 YU_PROJECT_DIR', async () => {
    const { setSessionTag } = await import('../extension/session-context.js')
    setSessionTag('test')
    expect(process.env.YU_PROJECT_DIR).toBeDefined()
  })
})

// ── Session Agent ───────────────────────────────────────

describe('session agent', () => {
  it('默认 agent 为空', async () => {
    const { getSessionAgent } = await import('../extension/session-context.js')
    expect(getSessionAgent()).toBe('')
  })

  it('setSessionAgent 设置 agent', async () => {
    const { getSessionAgent, setSessionAgent } = await import('../extension/session-context.js')
    setSessionAgent('coding')
    expect(getSessionAgent()).toBe('coding')
  })
})

// ── Session Model ───────────────────────────────────────

describe('session model', () => {
  it('默认 model 为 {}', async () => {
    const { getSessionModel } = await import('../extension/session-context.js')
    expect(getSessionModel()).toBe('{}')
  })

  it('setSessionModel 设置 model JSON', async () => {
    const { getSessionModel, setSessionModel } = await import('../extension/session-context.js')
    setSessionModel(JSON.stringify({ name: 'deepseek-v4' }))
    expect(getSessionModel()).toContain('deepseek-v4')
  })
})

// ── Session Parent ──────────────────────────────────────

describe('session parent', () => {
  it('默认 parent 为空', async () => {
    const { getSessionParent } = await import('../extension/session-context.js')
    expect(getSessionParent()).toBe('')
  })

  it('setSessionParent 设置 parent', async () => {
    const { getSessionParent, setSessionParent } = await import('../extension/session-context.js')
    setSessionParent('parent-session')
    expect(getSessionParent()).toBe('parent-session')
  })
})

// ── getStatusDir ────────────────────────────────────────

describe('getStatusDir', () => {
  it('返回 YuHome 当无项目目录时', async () => {
    const { getStatusDir } = await import('../extension/session-context.js')
    const dir = getStatusDir()
    expect(dir).toBeTruthy()
  })

  it('YU_PROJECT_DIR 设定后 getStatusDir 返回路径（有本地目录时优先本地）', async () => {
    process.env.YU_PROJECT_DIR = '/tmp/test-project'
    const { getStatusDir } = await import('../extension/session-context.js')
    const dir = getStatusDir()
    // 由于测试在 yu-agent 项目目录运行，本地 .yu-agent/status/ 存在时优先于 YU_PROJECT_DIR
    expect(dir).toContain('.yu-agent/status')
  })
})
