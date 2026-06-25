/**
 * Unit tests — deepseek.ts (Direct DeepSeek API client)
 *
 * Tests chatCompletion and callScheduler with mocked fetch.
 * Config loading uses a temp directory with a stub config.json.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DeepSeekResponse } from '../extension/deepseek.js'

// ── Helpers ──────────────────────────────────────────────

let tmpHome = ''
let origHome: string | undefined
let origFetch: typeof globalThis.fetch

function setupFakeConfig(): void {
  origHome = process.env.HOME
  tmpHome = join(tmpdir(), `yu-test-deepseek-${Date.now()}`)
  const configDir = join(tmpHome, '.yu')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    apiKeys: { deepseek: '***' },
  }))
  process.env.HOME = tmpHome
}

function cleanupFakeConfig(): void {
  process.env.HOME = origHome
  if (tmpHome) {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tmpHome = ''
}

// ── Mock fetch ───────────────────────────────────────────

let mockFetch: ReturnType<typeof mock>

beforeEach(() => {
  setupFakeConfig()
  origFetch = globalThis.fetch
  mockFetch = mock(() => {})
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterEach(() => {
  cleanupFakeConfig()
  globalThis.fetch = origFetch
})

// ── Tests ────────────────────────────────────────────────

describe('chatCompletion', () => {
  it('sends correct request and returns parsed response on success', async () => {
    const mockResponse: DeepSeekResponse = {
      id: 'test-id',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello back' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    })

    const { chatCompletion } = await import('../extension/deepseek.js')
    const result = await chatCompletion({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      max_tokens: 500,
    })

    expect(result).toEqual(mockResponse)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const call = mockFetch.mock.calls[0]
    expect(call[0]).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(call[1].method).toBe('POST')
    expect(call[1].headers.Authorization).toBe('Bearer ***')

    const body = JSON.parse(call[1].body)
    expect(body.model).toBe('deepseek-chat')
    expect(body.max_tokens).toBe(500)
    expect(body.temperature).toBe(0.7)
  })

  it('returns null on API error (non-200)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    })

    const { chatCompletion } = await import('../extension/deepseek.js')
    const result = await chatCompletion({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(result).toBeNull()
  })

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'))

    const { chatCompletion } = await import('../extension/deepseek.js')
    const result = await chatCompletion({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(result).toBeNull()
  })

  it('uses defaults for max_tokens and temperature', async () => {
    const mockResponse: DeepSeekResponse = {
      id: 'test-id',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    })

    const { chatCompletion } = await import('../extension/deepseek.js')
    await chatCompletion({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: 'Be helpful' }],
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.max_tokens).toBe(1024)
    expect(body.temperature).toBe(0)
  })
})

describe('callScheduler', () => {
  it('parses JSON response correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'sched-1',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '{"action": "coding", "files": ["src/main.ts"]}',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      }),
    })

    const { callScheduler } = await import('../extension/deepseek.js')
    const result = await callScheduler('You are a scheduler', 'Write a test')

    expect(result).toEqual({ action: 'coding', files: ['src/main.ts'] })
  })

  it('returns null when response content is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'sched-2',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: null },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
    })

    const { callScheduler } = await import('../extension/deepseek.js')
    const result = await callScheduler('System prompt', 'User input')
    expect(result).toBeNull()
  })

  it('returns null when response is not valid JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'sched-3',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'this is not json' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    })

    const { callScheduler } = await import('../extension/deepseek.js')
    const result = await callScheduler('System', 'Input')
    expect(result).toBeNull()
  })
})
