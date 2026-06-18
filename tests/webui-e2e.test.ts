/**
 * yu-agent Web UI — End-to-End 测试
 *
 * 启动 server 实例，通过 HTTP 请求验证所有端点。
 * 不依赖浏览器，用 fetch API 模拟真实请求。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createServer } from '../webui/server'

const PORT = 19876 // 固定端口，避免冲突
const BASE = `http://localhost:${PORT}`

let server: ReturnType<typeof Bun.serve> | null = null

beforeAll(() => {
  process.env.YU_WEBUI_HOST = '127.0.0.1'
  server = createServer(PORT)
})

afterAll(() => {
  server?.stop()
})

// ── GET / ────────────────────────────────────────────────

describe('GET /', () => {
  test('返回 200 + HTML', async () => {
    const res = await fetch(BASE + '/')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('yu-agent')
    expect(html).toContain('</html>')
  })

  test('返回 HTML 包含界面标题', async () => {
    const html = await (await fetch(BASE + '/')).text()
    expect(html).toContain('yu-agent')
    expect(html).toContain('<h1>')
  })

  test('Cache-Control 为 no-cache', async () => {
    const res = await fetch(BASE + '/')
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
  })
})

// ── GET /api/status ──────────────────────────────────────

describe('GET /api/status', () => {
  async function getStatus(): Promise<Record<string, unknown>> {
    return (await fetch(BASE + '/api/status')).json() as Promise<Record<string, unknown>>
  }

  test('返回 200 + JSON', async () => {
    const res = await fetch(BASE + '/api/status')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test('返回对象包含 version 字段', async () => {
    const data = await getStatus()
    expect(data).toHaveProperty('version')
    expect(data).toHaveProperty('uptime')
    expect(data).toHaveProperty('memory')
    expect(data).toHaveProperty('session')
  })

  test('version 为非空字符串', async () => {
    const data = await getStatus()
    expect(typeof data.version).toBe('string')
    expect((data.version as string).length).toBeGreaterThan(0)
  })

  test('uptime 为正数', async () => {
    const data = await getStatus()
    expect(data.uptime as number).toBeGreaterThan(0)
  })

  test('memory 包含 rss/heapTotal/heapUsed', async () => {
    const data = await getStatus()
    const mem = data.memory as Record<string, unknown>
    expect(mem).toHaveProperty('rss')
    expect(mem).toHaveProperty('heapTotal')
    expect(mem).toHaveProperty('heapUsed')
  })
})

// ── POST /api/chat ───────────────────────────────────────

describe('POST /api/chat', () => {
  test('发送消息返回 200 + JSON', async () => {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好 yu' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test('返回包含 success 和 output', async () => {
    const data = await (
      await fetch(BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '测试消息' }),
      })
    ).json()
    expect(data).toHaveProperty('success')
    expect(data).toHaveProperty('output')
    expect(data).toHaveProperty('iterations')
  })

  test('output 包含发送的消息内容', async () => {
    const data = await (
      await fetch(BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello yu' }),
      })
    ).json()
    expect((data as Record<string, unknown>).output).toContain('hello yu')
  })

  test('空消息返回 400', async () => {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    })
    expect(res.status).toBe(400)

    const data = await res.json()
    expect(data).toHaveProperty('error')
  })

  test('空消息体返回 400', async () => {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('非法 JSON 返回 500', async () => {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '这不是 JSON',
    })
    expect(res.status).toBe(500)
  })

  test('GET /api/chat 返回 404', async () => {
    const res = await fetch(BASE + '/api/chat')
    expect(res.status).toBe(404)
  })
})

// ── GET /events (SSE) ────────────────────────────────────

describe('GET /events (SSE)', () => {
  test('返回 426 当不是 WebSocket 请求', async () => {
    const res = await fetch(BASE + '/events')
    expect(res.status).toBe(426)
  })

  test('返回 Upgrade Required 提示', async () => {
    const res = await fetch(BASE + '/events')
    const text = await res.text()
    expect(text).toContain('SSE')
  })
})

// ── 404 ──────────────────────────────────────────────────

describe('未定义路由', () => {
  test('GET /nonexistent 返回 404', async () => {
    const res = await fetch(BASE + '/nonexistent')
    expect(res.status).toBe(404)
  })

  test('GET /api/nonexistent 返回 404', async () => {
    const res = await fetch(BASE + '/api/nonexistent')
    expect(res.status).toBe(404)
  })

  test('POST /nonexistent 返回 404', async () => {
    const res = await fetch(BASE + '/nonexistent', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

// ── 健康检查 ─────────────────────────────────────────────

describe('服务器健康', () => {
  test('服务器在正确端口监听', async () => {
    const res = await fetch(BASE + '/')
    expect(res.status).toBe(200)
  })

  test('并发请求正常处理', async () => {
    const results = await Promise.all([
      fetch(BASE + '/'),
      fetch(BASE + '/api/status'),
      fetch(BASE + '/api/status'),
      fetch(BASE + '/'),
    ])
    for (const res of results) {
      expect(res.status).toBe(200)
    }
  })
})
