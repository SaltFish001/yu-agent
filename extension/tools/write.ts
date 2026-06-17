/**
 * yu-agent — Write 工具
 *
 * 写入或覆盖文件。自动创建目录。
 * 用于创建新文件或完全重写现有文件。
 */

import { createLogger } from '../logger.js'
import { registerTool, type ToolResult } from './registry.js'

const _log = createLogger('tool-write')

registerTool({
  name: 'write',
  description:
    'Write content to a file, completely replacing existing content. Creates parent directories automatically.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path to write',
      },
      content: {
        type: 'string',
        description: 'Full content to write to the file',
      },
    },
    required: ['path', 'content'],
  },
  async execute(params): Promise<ToolResult> {
    const filePath = String(params.path ?? '')
    const content = String(params.content ?? '')

    if (!filePath.trim()) {
      return { success: false, output: '', error: 'Empty path' }
    }

    try {
      await Bun.write(filePath, content)
      return {
        success: true,
        output: `Written ${content.length} bytes to ${filePath}`,
      }
    } catch (_err) {
      // 尝试创建目录后重试
      try {
        const { dirname } = await import('path')
        const { mkdirSync } = await import('fs')
        const dir = dirname(filePath)
        mkdirSync(dir, { recursive: true })
        await Bun.write(filePath, content)
        return {
          success: true,
          output: `Written ${content.length} bytes to ${filePath} (created directories)`,
        }
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        return { success: false, output: '', error: msg }
      }
    }
  },
})
