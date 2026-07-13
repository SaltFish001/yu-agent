/**
 * Unit tests — tool-call-parser.ts (纯函数)
 *
 * Tests parseToolCalls (3 种格式), extractJsonObjects, buildResult.
 * Zero external dependencies.
 */

import { describe, expect, it } from 'bun:test'

// ── extractJsonObjects ───────────────────────────────────

describe('extractJsonObjects', () => {
  it('提取单个顶层 JSON 对象', async () => {
    const { extractJsonObjects } = await import('../extension/tool-call-parser.js')
    const result = extractJsonObjects('前置文本 {"a": 1, "b": 2} 后置文本')
    expect(result).toHaveLength(1)
    expect(JSON.parse(result[0])).toEqual({ a: 1, b: 2 })
  })

  it('提取多个顶层 JSON 对象', async () => {
    const { extractJsonObjects } = await import('../extension/tool-call-parser.js')
    const result = extractJsonObjects('{"a":1}{"b":2}')
    expect(result).toHaveLength(2)
    expect(JSON.parse(result[0])).toEqual({ a: 1 })
    expect(JSON.parse(result[1])).toEqual({ b: 2 })
  })

  it('处理嵌套大括号', async () => {
    const { extractJsonObjects } = await import('../extension/tool-call-parser.js')
    const text = '{"nested": {"inner": [1, 2, { "deep": true }]}}'
    const result = extractJsonObjects(text)
    expect(result).toHaveLength(1)
    expect(JSON.parse(result[0]).nested.inner).toHaveLength(3)
  })

  it('不提取字符串中的大括号', async () => {
    const { extractJsonObjects } = await import('../extension/tool-call-parser.js')
    const text = '{"key": "value with {braces} inside"}'
    const result = extractJsonObjects(text)
    expect(result).toHaveLength(1)
    expect(JSON.parse(result[0]).key).toBe('value with {braces} inside')
  })

  it('无 JSON 时返回空数组', async () => {
    const { extractJsonObjects } = await import('../extension/tool-call-parser.js')
    const result = extractJsonObjects('纯文本，没有花括号')
    expect(result).toEqual([])
  })

  it('只有开括号无闭括号时返回空数组', async () => {
    const { extractJsonObjects } = await import('../extension/tool-call-parser.js')
    const result = extractJsonObjects('{"unclosed:{still')
    expect(result).toEqual([])
  })

  it('空字符串返回空数组', async () => {
    const { extractJsonObjects } = await import('../extension/tool-call-parser.js')
    expect(extractJsonObjects('')).toEqual([])
  })
})

// ── parseToolCalls ───────────────────────────────────────

describe('parseToolCalls', () => {
  it('解析 JSON code block 格式', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    const content = '```json\n[\n  {"function": "read_file", "args": "src/index.ts", "id": "c1"},\n  {"function": "search_files", "args": "{\\"pattern\\":\\"test\\"}", "id": "c2"}\n]\n```'
    const calls = parseToolCalls(content)
    expect(calls).toHaveLength(2)
    expect(calls[0].name).toBe('read_file')
    expect(calls[0].args).toBe('src/index.ts')
    expect(calls[1].name).toBe('search_files')
    expect(calls[1].args).toBe('{"pattern":"test"}')
  })

  it('解析内联 JSON 格式', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    const content = '前置文本 {"function": "write_file", "args": "output.txt"} 后置'
    const calls = parseToolCalls(content)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('write_file')
  })

  it('解析 XML tool_use 格式', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    const content = '<tool_use><name>execute_command</name><args>ls -la</args></tool_use>'
    const calls = parseToolCalls(content)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('execute_command')
    expect(calls[0].args).toBe('ls -la')
  })

  it('三种格式混合', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    const content = [
      '```json\n[{"function": "read", "args": "a.ts", "id": "c1"}]\n```',
      '{"function": "write", "args": "b.ts"}',
      '<tool_use><name>delete</name><args>c.ts</args></tool_use>',
    ].join('\n')
    const calls = parseToolCalls(content)
    expect(calls).toHaveLength(3)
  })

  it('重复调用去重（同名只保留第一个）', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    const content = [
      '{"function": "read", "args": "a.ts"}',
      '{"function": "read", "args": "b.ts"}',
    ].join('\n')
    const calls = parseToolCalls(content)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toBe('a.ts')
  })

  it('无工具调用时返回空数组', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    expect(parseToolCalls('这是一段普通文本')).toEqual([])
  })

  it('空字符串返回空数组', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    expect(parseToolCalls('')).toEqual([])
  })

  it('args 为对象时被序列化为字符串', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    const content = '{"function": "edit", "args": {"file": "x.ts", "content": "hi"}}'
    const calls = parseToolCalls(content)
    expect(calls).toHaveLength(1)
    expect(typeof calls[0].args).toBe('string')
    expect(JSON.parse(calls[0].args).file).toBe('x.ts')
  })

  it('JSON block 无效时跳过不报错', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    const content = '```json\n{invalid json}\n```'
    // 不会报错，返回空
    const calls = parseToolCalls(content)
    expect(Array.isArray(calls)).toBe(true)
  })

  it('JSON block 单个对象由内联格式处理', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    // 单个对象不是 JSON code block 格式（需要数组），但内联 JSON 会抓到
    const content = '```json\n{"function": "test", "args": "x"}\n```'
    const calls = parseToolCalls(content)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('test')
  })

  it('XML 缺失字段时不匹配', async () => {
    const { parseToolCalls } = await import('../extension/tool-call-parser.js')
    const content = '<tool_use><name>test</name></tool_use>'
    const calls = parseToolCalls(content)
    expect(calls).toHaveLength(0)
  })
})

// ── buildResult ──────────────────────────────────────────

describe('buildResult', () => {
  it('返回固定格式成功结果', async () => {
    const { buildResult } = await import('../extension/tool-call-parser.js')
    const result = buildResult('done', 3)
    expect(result).toEqual({ success: true, output: 'done', iterations: 3 })
  })

  it('空输出', async () => {
    const { buildResult } = await import('../extension/tool-call-parser.js')
    const result = buildResult('', 0)
    expect(result.success).toBe(true)
    expect(result.output).toBe('')
    expect(result.iterations).toBe(0)
  })
})
