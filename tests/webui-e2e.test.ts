/**
 * yu-agent Web UI — End-to-End 测试
 *
 * 启动 server 实例，通过 HTTP 请求验证所有端点。
 * 不依赖浏览器，用 fetch API 模拟真实请求。
 *
 * Phase 3: SSE 改用 ReadableStream，chat 接入真实 AgentLoop，
 * 静态文件拆分 assets/ 目录，零 CDN 依赖。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer } from '../webui/server'

const PORT = 19876
const BASE = `http://localhost:${PORT}`

let server: ReturnType<typeof Bun.serve> | null = null

beforeAll(async () => {
  process.env.YU_WEBUI_HOST = '127.0.0.1'
  server = await createServer(PORT)
})

afterAll(() => {
  server?.stop()
})

// ── GET / ────────────────────────────────────────────────

describe('GET /', () => {
  test('返回 200 + HTML', async () => {
    const res = await fetch(`${BASE}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('yu-agent')
    expect(html).toContain('</html>')
  })

  test('Cache-Control 为 no-cache', async () => {
    const res = await fetch(`${BASE}/`)
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
  })

  test('HTML 无 CDN 外链', async () => {
    const html = await (await fetch(`${BASE}/`)).text()
    expect(html).not.toContain('cdn.')
    expect(html).not.toContain('unpkg.com')
    expect(html).not.toContain('googleapis.com')
    expect(html).not.toContain('cdnjs')
  })
})

// ── GET /assets/* ──────────────────────────────────────

describe('GET /assets/* (静态文件)', () => {
  test('/assets/style.css 返回 200 + CSS', async () => {
    const res = await fetch(`${BASE}/assets/style.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/css')
    const css = await res.text()
    expect(css).toContain('sidebar')
    expect(css).toContain('chat')
  })

  test('/assets/client.js 返回 200 + JS', async () => {
    const res = await fetch(`${BASE}/assets/client.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('javascript')
    const js = await res.text()
    expect(js).toContain('EventSource')
    expect(js).toContain('/api/chat')
    expect(js).toContain('/api/status')
  })
})

// ── GET /api/status ──────────────────────────────────────

describe('GET /api/status', () => {
  async function getStatus(): Promise<Record<string, unknown>> {
    return (await fetch(`${BASE}/api/status`)).json() as Promise<Record<string, unknown>>
  }

  test('返回 200 + JSON', async () => {
    const res = await fetch(`${BASE}/api/status`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test('返回对象包含 version/uptime/memory', async () => {
    const data = await getStatus()
    expect(data).toHaveProperty('version')
    expect(data).toHaveProperty('uptime')
    expect(data).toHaveProperty('memory')
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
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '说一句"hello"就行了' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test('返回包含 success/output/iterations', async () => {
    const data = (await (
      await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '说一句"hello"就行了' }),
      })
    ).json()) as Record<string, unknown>
    expect(data).toHaveProperty('success')
    expect(data).toHaveProperty('output')
    expect(data).toHaveProperty('iterations')
    expect(data).toHaveProperty('totalTokens')
  })

  test('返回包含 output 字段', async () => {
    const data = (await (
      await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '说一句"hello"就行了' }),
      })
    ).json()) as Record<string, unknown>
    expect(data).toHaveProperty('output')
    expect(typeof data.output).toBe('string')
  })

  test('空消息返回 400', async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data).toHaveProperty('error')
  })

  test('空消息体返回 400', async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('非法 JSON 返回 400', async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '这不是 JSON',
    })
    expect(res.status).toBe(400)
  })

  test('GET /api/chat 返回 404', async () => {
    const res = await fetch(`${BASE}/api/chat`)
    expect(res.status).toBe(404)
  })

  test('消息为数字时返回 400 + Zod 错误信息', async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 123 }),
    })
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error?: string }
    expect(data).toHaveProperty('error')
    expect(data.error).toContain('参数错误')
  })

  test('消息过长返回 400', async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(10001) }),
    })
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error?: string }
    expect(data.error).toContain('消息过长')
  })
})

// ── GET /events (SSE via ReadableStream) ────────────────

describe('GET /events (SSE via ReadableStream)', () => {
  test('返回 200 + text/event-stream', async () => {
    const res = await fetch(`${BASE}/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
  })

  test('返回流式数据包含 connected 事件', async () => {
    const res = await fetch(`${BASE}/events`)
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()

    if (reader) {
      const { value, done } = await reader.read()
      expect(done).toBe(false)
      const text = new TextDecoder().decode(value)
      expect(text).toContain('event: connected')
      expect(text).toContain('"status":"ok"')
      reader.cancel()
    }
  })
})

// ── WebSocket /ws ───────────────────────────────────────

describe('WebSocket /ws', () => {
  test('WebSocket 连接成功并收到 connected 消息', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    const msg = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => {
        /* 等待第一条消息 */
      }
      ws.onmessage = (e) => {
        resolve(e.data as string)
        ws.close()
      }
      ws.onerror = () => reject(new Error('WS error'))
      setTimeout(() => reject(new Error('Timeout')), 3000)
    })

    const parsed = JSON.parse(msg)
    expect(parsed.type).toBe('connected')
    expect(parsed.data.status).toBe('ok')
    expect(parsed.timestamp).toBeGreaterThan(0)
  })

  test('WebSocket 收到 status 推送', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    let receivedStatus = false
    let receivedConnected = false

    const result = await new Promise<string[]>((resolve, reject) => {
      const messages: string[] = []
      ws.onmessage = (e) => {
        messages.push(e.data as string)
        // 等待 connected + 至少一条 status
        if (messages.length >= 2) {
          resolve(messages)
          ws.close()
        }
      }
      ws.onerror = () => reject(new Error('WS error'))
      setTimeout(() => reject(new Error('Timeout after 5s')), 5000)
    })

    for (const msg of result) {
      const parsed = JSON.parse(msg)
      if (parsed.type === 'status') {
        receivedStatus = true
        expect(parsed.data).toHaveProperty('version')
        expect(parsed.data).toHaveProperty('uptime')
        expect(parsed.data).toHaveProperty('memory')
      }
      if (parsed.type === 'connected') {
        receivedConnected = true
      }
    }

    expect(receivedConnected).toBe(true)
    expect(receivedStatus).toBe(true)
  })

  test('WebSocket 支持 ping/pong', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    const result = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => {
        // 等 connected 消息到达后再发 ping
        setTimeout(() => ws.send(JSON.stringify({ type: 'ping' })), 100)
      }
      ws.onmessage = (e) => {
        const parsed = JSON.parse(e.data as string)
        if (parsed.type === 'pong') {
          resolve(e.data as string)
          ws.close()
        }
        // 忽略 connected/status 消息
      }
      ws.onerror = () => reject(new Error('WS error'))
      setTimeout(() => reject(new Error('Timeout')), 3000)
    })

    const parsed = JSON.parse(result)
    expect(parsed.type).toBe('pong')
  })
})

// ── GET /api/ws ───────────────────────────────────────────

describe('GET /api/ws (WS 统计)', () => {
  test('返回 200 + JSON', async () => {
    const res = await fetch(`${BASE}/api/ws`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test('返回对象包含 connected/total/peak/messagesSent/uptime', async () => {
    const data = (await (await fetch(`${BASE}/api/ws`)).json()) as Record<string, unknown>
    expect(data).toHaveProperty('connected')
    expect(data).toHaveProperty('total')
    expect(data).toHaveProperty('peak')
    expect(data).toHaveProperty('messagesSent')
    expect(data).toHaveProperty('uptime')
    expect(typeof data.connected).toBe('number')
    expect(typeof data.total).toBe('number')
    expect(typeof data.uptime).toBe('number')
  })

  test('startedAt 为有效 ISO 日期', async () => {
    const data = (await (await fetch(`${BASE}/api/ws`)).json()) as Record<string, unknown>
    expect(data).toHaveProperty('startedAt')
    expect(() => new Date(data.startedAt as string)).not.toThrow()
    expect(Date.parse(data.startedAt as string)).toBeGreaterThan(0)
  })
})

// ── POST /api/ws/reset ────────────────────────────────────

describe('POST /api/ws/reset', () => {
  test('返回 200 + { status: "ok" }', async () => {
    const res = await fetch(`${BASE}/api/ws/reset`, { method: 'POST' })
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(data.status).toBe('ok')
  })

  test('重置后 messagesSent 归零', async () => {
    await fetch(`${BASE}/api/ws/reset`, { method: 'POST' })
    const data = (await (await fetch(`${BASE}/api/ws`)).json()) as Record<string, unknown>
    expect(data.messagesSent).toBe(0)
    expect(data.total).toBe(0)
  })

  test('peak 为当前连接数', async () => {
    await fetch(`${BASE}/api/ws/reset`, { method: 'POST' })
    const data = (await (await fetch(`${BASE}/api/ws`)).json()) as Record<string, unknown>
    expect(typeof data.peak).toBe('number')
    expect(data.peak).toBeGreaterThanOrEqual(0)
  })
})

// ── GET /api/topics ───────────────────────────────────────

describe('GET /api/topics', () => {
  test('返回 200 + JSON', async () => {
    const res = await fetch(`${BASE}/api/topics`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test('返回对象包含 topics 数组和 activeName', async () => {
    const data = (await (await fetch(`${BASE}/api/topics`)).json()) as Record<string, unknown>
    expect(Array.isArray(data.topics)).toBe(true)
    expect(data).toHaveProperty('activeName')
  })

  test('每个 topic 有 name/status/turns 字段', async () => {
    const data = (await (await fetch(`${BASE}/api/topics`)).json()) as Record<string, unknown>
    const topics = data.topics as Array<Record<string, unknown>>
    if (topics.length > 0) {
      const t = topics[0]
      expect(t).toHaveProperty('name')
      expect(t).toHaveProperty('status')
      expect(t).toHaveProperty('turns')
    }
  })
})

// ── GET /api/topic/:name ──────────────────────────────────

describe('GET /api/topic/:name', () => {
  test('不存在的主题返回 404', async () => {
    const res = await fetch(`${BASE}/api/topic/nonexistent-xyz-123`)
    expect(res.status).toBe(404)
    const data = (await res.json()) as Record<string, unknown>
    expect(data).toHaveProperty('error')
    expect((data.error as string)).toContain('not found')
  })
})

// ── GET /api/terminals ───────────────────────────────────

describe('GET /api/terminals', () => {
  test('返回 200 + JSON', async () => {
    const res = await fetch(`${BASE}/api/terminals`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
  })

  test('返回 { sessions: [] }', async () => {
    const data = (await (await fetch(`${BASE}/api/terminals`)).json()) as Record<string, unknown>
    expect(Array.isArray(data.sessions)).toBe(true)
  })

  test('sessions 中的条目有 topic/cwd/pid/uptime/alive 字段', async () => {
    const data = (await (await fetch(`${BASE}/api/terminals`)).json()) as Record<string, unknown>
    const sessions = data.sessions as Array<Record<string, unknown>>
    for (const s of sessions) {
      expect(s).toHaveProperty('topic')
      expect(s).toHaveProperty('cwd')
      expect(s).toHaveProperty('pid')
      expect(s).toHaveProperty('uptime')
      expect(s).toHaveProperty('alive')
    }
  })
})

// ── GET /api/status?fields= ──────────────────────────────

describe('GET /api/status?fields= 字段过滤', () => {
  test('返回包含指定字段', async () => {
    const res = await fetch(`${BASE}/api/status?fields=version,uptime`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(data).toHaveProperty('version')
    expect(data).toHaveProperty('uptime')
  })

  test('不包含未请求字段', async () => {
    const res = await fetch(`${BASE}/api/status?fields=version`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(data).toHaveProperty('version')
    expect(data).not.toHaveProperty('uptime')
    expect(data).not.toHaveProperty('memory')
  })

  test('空字段返回完整状态（?fields= 等同于不传）', async () => {
    const res = await fetch(`${BASE}/api/status?fields=`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(data).toHaveProperty('version')
    expect(data).toHaveProperty('uptime')
    expect(data).toHaveProperty('memory')
  })

  test('不存在的字段返回空对象', async () => {
    const res = await fetch(`${BASE}/api/status?fields=nonexistent_field_xyz`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(Object.keys(data).length).toBe(0)
  })

  test('多字段过滤', async () => {
    const res = await fetch(`${BASE}/api/status?fields=memory,ws,rules`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(data).toHaveProperty('memory')
    expect(data).toHaveProperty('ws')
    expect(data).toHaveProperty('rules')
  })
})

// ── 静态文件边角 ──────────────────────────────────────────

describe('静态文件边角', () => {
  test('不存在的静态文件返回 404', async () => {
    const res = await fetch(`${BASE}/assets/nonexistent.css`)
    expect(res.status).toBe(404)
  })

  test('路径穿越攻击被阻止', async () => {
    const res = await fetch(`${BASE}/assets/../../../etc/passwd`)
    expect(res.status).toBe(404)
  })

  test('双重路径穿越', async () => {
    const res = await fetch(`${BASE}/assets/..%2f..%2f..%2fetc%2fpasswd`)
    expect(res.status).toBe(404)
  })
})

// ── WebSocket 消息交互 ──────────────────────────────────

describe('WebSocket 消息交互', () => {
  test('发送 set_interval 后收到 interval_set', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    const result = await new Promise<string>((resolve, reject) => {
      let connected = false
      ws.onmessage = (e) => {
        const parsed = JSON.parse(e.data as string)
        if (parsed.type === 'connected') {
          connected = true
          ws.send(JSON.stringify({ type: 'set_interval', interval: 1000 }))
          return
        }
        if (connected && parsed.type === 'interval_set') {
          resolve(e.data as string)
          ws.close()
        }
      }
      ws.onerror = () => reject(new Error('WS error'))
      setTimeout(() => reject(new Error('Timeout')), 3000)
    })
    const parsed = JSON.parse(result)
    expect(parsed.type).toBe('interval_set')
    expect(parsed.data.interval).toBe(1000)
  })

  test('发送 set_channels 后收到 channels_set', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    const result = await new Promise<string>((resolve, reject) => {
      let connected = false
      ws.onmessage = (e) => {
        const parsed = JSON.parse(e.data as string)
        if (parsed.type === 'connected') {
          connected = true
          ws.send(JSON.stringify({ type: 'set_channels', channels: ['status', 'events'] }))
          return
        }
        if (connected && parsed.type === 'channels_set') {
          resolve(e.data as string)
          ws.close()
        }
      }
      ws.onerror = () => reject(new Error('WS error'))
      setTimeout(() => reject(new Error('Timeout')), 3000)
    })
    const parsed = JSON.parse(result)
    expect(parsed.type).toBe('channels_set')
    expect(parsed.data.channels).toContain('status')
    expect(parsed.data.channels).toContain('events')
  })

  test('发送非法 JSON 不崩溃', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        setTimeout(() => {
          ws.send('not json at all!!!')
          ws.close()
          resolve()
        }, 200)
      }
      ws.onerror = () => reject(new Error('WS error'))
      setTimeout(() => reject(new Error('Timeout')), 3000)
    })
  })

  test('发送未知 type 不崩溃', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'some_unknown_type_xyz' }))
          ws.close()
          resolve()
        }, 200)
      }
      ws.onerror = () => reject(new Error('WS error'))
      setTimeout(() => reject(new Error('Timeout')), 3000)
    })
  })
})

// ── 并发 WS 连接 ──────────────────────────────────────────

describe('并发 WebSocket 连接', () => {
  test('多个 WS 同时连接不崩溃', async () => {
    const count = 5
    const wss = Array.from({ length: count }, () => new WebSocket(`ws://localhost:${PORT}/ws`))
    const results = await Promise.all(
      wss.map((ws) => {
        return new Promise<void>((resolve, reject) => {
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
          ws.onmessage = (e) => {
            const parsed = JSON.parse(e.data as string)
            if (parsed.type === 'pong') {
              ws.close()
              resolve()
            }
          }
          ws.onerror = () => reject(new Error('WS error'))
          setTimeout(() => reject(new Error('Timeout')), 3000)
        })
      }),
    )
    expect(results.length).toBe(count)
  })
})

// ── 404 ──────────────────────────────────────────────────

describe('未定义路由', () => {
  test('GET /nonexistent 返回 404', async () => {
    const res = await fetch(`${BASE}/nonexistent`)
    expect(res.status).toBe(404)
  })

  test('GET /api/nonexistent 返回 404', async () => {
    const res = await fetch(`${BASE}/api/nonexistent`)
    expect(res.status).toBe(404)
  })

  test('POST /nonexistent 返回 404', async () => {
    const res = await fetch(`${BASE}/nonexistent`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('404 返回 HTML', async () => {
    const res = await fetch(`${BASE}/no-such-page`)
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('404')
    expect(html).toContain('返回首页')
  })
})

// ── 健康检查 ─────────────────────────────────────────────

describe('服务器健康', () => {
  test('服务器在正确端口监听', async () => {
    const res = await fetch(`${BASE}/`)
    expect(res.status).toBe(200)
  })

  test('并发请求正常处理', async () => {
    const results = await Promise.all([
      fetch(`${BASE}/`),
      fetch(`${BASE}/api/status`),
      fetch(`${BASE}/api/status`),
      fetch(`${BASE}/`),
    ])
    for (const res of results) {
      expect(res.status).toBe(200)
    }
  })
})
