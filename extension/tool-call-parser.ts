/**
 * yu-agent — 工具调用解析器（纯函数）
 *
 * 从 AgentLoop 类中提取的 parseToolCalls / extractJsonObjects / buildResult，
 * 供测试直接 import 使用，绕过 CI 上 agent-loop.ts 类加载问题。
 */
// ── parseToolCalls ──────────────────────────────────────

export function parseToolCalls(content: string): Array<{ id: string; name: string; args: string }> {
  const calls: Array<{ id: string; name: string; args: string }> = []

  // 格式 1: code block JSON — ```json [...] ```
  const jsonBlockPattern = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/g
  for (const match of content.matchAll(jsonBlockPattern)) {
    try {
      const parsed = JSON.parse(match[1])
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.function && item.args !== undefined) {
            calls.push({
              id: item.id ?? `call_${calls.length}`,
              name: item.function,
              args: typeof item.args === 'string' ? item.args : JSON.stringify(item.args),
            })
          }
        }
      }
    } catch {
      /* skip malformed */
    }
  }

  // 格式 2: 内联 JSON 对象 — brace-counting 提取所有顶层 JSON
  for (const maybeJson of extractJsonObjects(content)) {
    try {
      const parsed = JSON.parse(maybeJson)
      if (parsed.function && parsed.args !== undefined) {
        if (!calls.some((c) => c.name === parsed.function)) {
          calls.push({
            id: parsed.id ?? `call_${calls.length}`,
            name: parsed.function,
            args: typeof parsed.args === 'string' ? parsed.args : JSON.stringify(parsed.args),
          })
        }
      }
    } catch {
      /* not valid JSON, skip */
    }
  }

  // 格式 3: tool_use XML block
  const xmlPattern = /<tool_use>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<args>([\s\S]*?)<\/args>[\s\S]*?<\/tool_use>/g
  for (const match of content.matchAll(xmlPattern)) {
    if (!calls.some((c) => c.name === match[1].trim())) {
      calls.push({
        id: `call_${calls.length}`,
        name: match[1].trim(),
        args: match[2].trim(),
      })
    }
  }

  return calls
}

// ── extractJsonObjects ──────────────────────────────────

export function extractJsonObjects(text: string): string[] {
  const results: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return results
}

// ── buildResult ─────────────────────────────────────────

export function buildResult(
  output: string,
  iterations: number,
): { success: boolean; output: string; iterations: number } {
  return { success: true, output, iterations }
}
