/**
 * yu-agent — Read 工具
 *
 * 读取文件内容，支持行号分页。
 */

import { registerTool, type ToolResult } from './registry.js'

registerTool({
  name: 'read',
  description: 'Read a file with line numbers and pagination. Use offset and limit for large files.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or project-relative file path',
      },
      offset: {
        type: 'number',
        description: 'Starting line number (1-indexed, default: 1)',
      },
      limit: {
        type: 'number',
        description: 'Maximum lines to return (default: 500, max: 2000)',
      },
    },
    required: ['path'],
  },
  async execute(params): Promise<ToolResult> {
    const filePath = String(params.path ?? '')
    const offset = Math.max(1, Number(params.offset ?? 1))
    const limit = Math.min(2000, Number(params.limit ?? 500))

    if (!filePath.trim()) {
      return { success: false, output: '', error: 'Empty path' }
    }

    try {
      const file = Bun.file(filePath)
      const exists = await file.exists()
      if (!exists) {
        return { success: false, output: '', error: `File not found: ${filePath}` }
      }

      const content = await file.text()
      const lines = content.split('\n')
      const startIdx = offset - 1
      const selected = lines.slice(startIdx, startIdx + limit)

      const output = selected.map((line, i) => `${startIdx + i + 1}|${line}`).join('\n')

      const totalLines = lines.length
      const meta =
        totalLines > limit
          ? `\n--- ${Math.min(offset + limit - 1, totalLines)}/${totalLines} lines ---`
          : `\n--- ${totalLines} lines ---`

      return { success: true, output: output + meta }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: msg }
    }
  },
})
