/**
 * yu-agent — AgentLoop 单元测试
 *
 * 覆盖 parseToolCalls (JSON block / inline JSON / XML 三种格式)
 * 和 buildResult / extractJsonObjects。
 *
 * 注：测试纯函数（parseToolCalls / extractJsonObjects / buildResult）
 * 而非 AgentLoop 类，避免 CI 上类加载问题。
 */
import { describe, it, expect } from 'bun:test'
import { parseToolCalls, extractJsonObjects, buildResult } from '../extension/agent-loop'

// ── parseToolCalls tests ──

describe('parseToolCalls — JSON block format', () => {
  it('extracts tool calls from ```json [...] ``` block', () => {
    const content = '```json\n[{"function": "bash", "args": {"command": "ls"}}]\n```'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('bash')
    expect(calls[0].args).toBe('{"command":"ls"}')
  })

  it('handles multiple tool calls in one JSON block', () => {
    const content = '```json\n[{"function": "read_file", "args": {"path": "a.ts"}}, {"function": "read_file", "args": {"path": "b.ts"}}]\n```'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(2)
    expect(calls[0].name).toBe('read_file')
    expect(calls[1].name).toBe('read_file')
  })

  it('handles JSON block without ```json prefix (just ```)', () => {
    const content = '```\n[{"function": "bash", "args": {"command": "pwd"}}]\n```'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('bash')
  })

  it('handles nested args in JSON block', () => {
    const content = '```json\n[{"function": "write_file", "args": {"path": "test.ts", "content": "{\\"key\\": \\"value\\"}"}}]\n```'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('write_file')
    const args = JSON.parse(calls[0].args)
    expect(args.path).toBe('test.ts')
    expect(args.content).toBe('{"key": "value"}')
  })

  it('skips malformed JSON block silently', () => {
    const content = '```json\n[{invalid json...}]\n```'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(0)
  })
})

describe('parseToolCalls — inline JSON format', () => {
  it('extracts inline {"function": ..., "args": {...}} objects', () => {
    const content = 'Some text {"function": "bash", "args": {"command": "ls"}} more text'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('bash')
  })

  it('handles deeply nested JSON args', () => {
    const content = '{"function": "write_file", "args": {"path": "test.ts", "content": {"deep": {"nested": true}}}}'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('write_file')
    const args = JSON.parse(calls[0].args)
    expect(args.content.deep.nested).toBe(true)
  })

  it('handles multiple inline JSON objects', () => {
    const content = 'First {"function": "bash", "args": {"command": "ls"}} Second {"function": "grep", "args": {"pattern": "test"}}'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(2)
    expect(calls[0].name).toBe('bash')
    expect(calls[1].name).toBe('grep')
  })

  it('deduplicates calls found by both JSON block and inline parser', () => {
    const content = '```json\n[{"function": "bash", "args": {"command": "ls"}}]\n```\nAlso {"function": "bash", "args": {"command": "ls"}}'
    const calls = parseToolCalls(content)
    // Should be deduplicated
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('bash')
  })

  it('returns empty array when no tool calls present', () => {
    const content = 'Just a regular response without any tool calls.'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(0)
  })
})

describe('parseToolCalls — XML format', () => {
  it('extracts <tool_use> blocks', () => {
    const content = '<tool_use><name>bash</name><args>{"command": "ls"}</args></tool_use>'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('bash')
  })

  it('handles multiple XML tool_use blocks', () => {
    const content =
      '<tool_use><name>read_file</name><args>{"path": "a.ts"}</args></tool_use>' +
      '<tool_use><name>write_file</name><args>{"path": "b.ts"}</args></tool_use>'
    const calls = parseToolCalls(content)
    expect(calls.length).toBe(2)
    expect(calls[0].name).toBe('read_file')
    expect(calls[1].name).toBe('write_file')
  })
})

describe('parseToolCalls — mixed formats', () => {
  it('handles JSON + XML in the same response', () => {
    const content = '```json\n[{"function": "bash", "args": {"command": "ls"}}]\n```\n<tool_use><name>grep</name><args>{"pattern": "test"}</args></tool_use>'
    const calls = parseToolCalls(content)
    // Both should be found, no dedup since names differ
    expect(calls.length).toBe(2)
  })
})

// ── buildResult tests ──

describe('buildResult', () => {
  it('returns success with correct output and iteration count', () => {
    const result = buildResult('hello world', 5)
    expect(result.success).toBe(true)
    expect(result.output).toBe('hello world')
    expect(result.iterations).toBe(5)
  })
})

// ── extractJsonObjects tests ──

describe('extractJsonObjects', () => {
  it('extracts top-level JSON objects with brace counting', () => {
    const objects = extractJsonObjects('prefix {"a": 1} middle {"b": {"c": 2}} suffix')
    expect(objects.length).toBe(2)
    expect(JSON.parse(objects[0])).toEqual({ a: 1 })
    expect(JSON.parse(objects[1])).toEqual({ b: { c: 2 } })
  })

  it('handles nested braces correctly', () => {
    const text = '{"outer": {"inner": "value"}, "arr": [1, 2, 3]}'
    const objects = extractJsonObjects(text)
    expect(objects.length).toBe(1)
    const parsed = JSON.parse(objects[0])
    expect(parsed.outer.inner).toBe('value')
    expect(parsed.arr).toEqual([1, 2, 3])
  })

  it('returns empty array for text with no braces', () => {
    const objects = extractJsonObjects('plain text without braces')
    expect(objects.length).toBe(0)
  })
})
