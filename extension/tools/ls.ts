/**
 * yu-agent — Ls 工具
 *
 * 列出目录内容（文件/子目录），按修改时间排序。
 * 显示文件大小、类型和最后修改时间。
 */

import { createLogger } from '../logger.js'
import { registerTool, type ToolResult } from './registry.js'

const _log = createLogger('tool-ls')

registerTool({
  name: 'ls',
  description: 'List directory contents sorted by modification time. Shows file size, type, and last modified.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path to list (default: current working directory)',
      },
      limit: {
        type: 'number',
        description: 'Maximum entries (default: 50, max: 500)',
      },
      all: {
        type: 'boolean',
        description: 'Show hidden files (default: false)',
      },
    },
  },
  async execute(params): Promise<ToolResult> {
    const dirPath = String(params.path ?? '.')
    const limit = Math.min(500, Number(params.limit ?? 50))
    const showAll = Boolean(params.all)

    try {
      const { readdirSync, statSync } = await import('fs')
      const { resolve } = await import('path')

      let entries = readdirSync(dirPath)
      if (!showAll) {
        entries = entries.filter((e) => !e.startsWith('.'))
      }

      const stats = entries
        .map((name) => {
          try {
            const fullPath = resolve(dirPath, name)
            const stat = statSync(fullPath)
            return {
              name,
              isDir: stat.isDirectory(),
              size: stat.size,
              mtime: stat.mtimeMs,
            }
          } catch {
            return null
          }
        })
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .sort((a, b) => b.mtime - a.mtime) // newest first
        .slice(0, limit)

      if (stats.length === 0) {
        return { success: true, output: `(empty directory: ${dirPath})` }
      }

      // Format entries
      const lines = stats.map((s) => {
        const type = s.isDir ? '📁' : '📄'
        const size = formatSize(s.size)
        const time = new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')
        return `${type} ${s.name.padEnd(30)} ${size.padStart(8)} ${time}`
      })

      const output = `${lines.join('\n')}\n--- ${stats.length} entries ---`
      return { success: true, output }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, output: '', error: msg }
    }
  },
})

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
