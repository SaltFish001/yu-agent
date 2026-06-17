/**
 * yu-agent — Glob 工具
 *
 * 通过 glob 模式查找文件（文件名匹配, 非内容搜索）。
 * 递归搜索，返回匹配的文件路径列表。
 */

import { createLogger } from '../logger.js'
import { registerTool, type ToolResult } from './registry.js'

const _log = createLogger('tool-glob')

registerTool({
  name: 'glob',
  description: 'Find files by glob pattern (e.g. "*.ts", "**/*.json", "src/**"). Uses ripgrep-style matching.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to search for (e.g. "*.ts", "**/*.json", "src/**")',
      },
      path: {
        type: 'string',
        description: 'Directory to search in (default: current working directory)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 50, max: 500)',
      },
    },
    required: ['pattern'],
  },
  async execute(params): Promise<ToolResult> {
    const pattern = String(params.pattern ?? '')
    const searchPath = String(params.path ?? '.')
    const limit = Math.min(500, Number(params.limit ?? 50))

    if (!pattern.trim()) {
      return { success: false, output: '', error: 'Empty pattern' }
    }

    try {
      const { Glob } = await import('bun')
      const glob = new Glob(pattern)
      const results: string[] = []

      for await (const file of glob.scan(searchPath)) {
        results.push(file)
        if (results.length >= limit) break
      }

      if (results.length === 0) {
        return { success: true, output: `No files matching "${pattern}" in ${searchPath}` }
      }

      return {
        success: true,
        output: `${results.join('\n')}\n--- ${results.length} file(s) ---`,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: msg }
    }
  },
})
