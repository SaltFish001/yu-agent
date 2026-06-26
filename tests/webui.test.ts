/**
 * yu-agent Web UI — 单元测试
 *
 * 测试 server.ts 中的纯辅助函数（无需启动服务器）。
 * escapeHtml / getNotFoundHtml 等纯函数。
 */

import { describe, expect, it } from 'bun:test'
import { escapeHtml, getNotFoundHtml } from '../webui/server'

// ── escapeHtml ─────────────────────────────────────────────

describe('escapeHtml', () => {
  it('不修改普通文本', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123')
  })

  it('转义 &', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('转义 <', () => {
    expect(escapeHtml('<tag>')).toBe('&lt;tag&gt;')
  })

  it('转义 >', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b')
  })

  it('转义双引号', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
  })

  it('同时转义多个特殊字符', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    )
  })

  it('空字符串返回空字符串', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('转义 & 优先于其他', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})

// ── getNotFoundHtml ────────────────────────────────────────

describe('getNotFoundHtml', () => {
  it('返回包含 404 的 HTML', () => {
    const html = getNotFoundHtml('/some/path')
    expect(html).toContain('404')
    expect(html).toContain('</html>')
  })

  it('包含请求路径', () => {
    const html = getNotFoundHtml('/api/nonexistent')
    expect(html).toContain('/api/nonexistent')
  })

  it('路径中的特殊字符被转义', () => {
    const html = getNotFoundHtml('/path/<script>')
    expect(html).toContain('/path/&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('包含返回首页链接', () => {
    const html = getNotFoundHtml('/x')
    expect(html).toContain('返回首页')
    expect(html).toContain('href="/"')
  })

  it('根路径的 404 页面', () => {
    const html = getNotFoundHtml('/')
    expect(html).toContain('/')
    expect(html).toContain('404')
  })

  it('包含导航图标', () => {
    const html = getNotFoundHtml('/test')
    expect(html).toContain('🎣')
    expect(html).toContain('←')
  })
})
