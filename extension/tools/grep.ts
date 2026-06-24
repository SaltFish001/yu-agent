/**
 * yu-agent — Grep 工具
 *
 * 文件内容搜索（类似 ripgrep/grep）。
 * 支持正则表达式、大小写忽略、上下文行。
 */

import { createLogger } from '../logger.js'
import { registerTool, type ToolResult } from './registry.js'

const _log = createLogger('tool-grep')

registerTool({
  name: 'grep',
  description: 'Search file contents with regex. Supports case-insensitive mode and context lines.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search in (default: current working directory)',
      },
      file_glob: {
        type: 'string',
        description: 'Optional file filter (e.g. "*.ts" to only search TypeScript files)',
      },
      ignore_case: {
        type: 'boolean',
        description: 'Case insensitive search (default: false)',
      },
      context: {
        type: 'number',
        description: 'Lines of context before and after each match (default: 0)',
      },
      limit: {
        type: 'number',
        description: 'Maximum results (default: 50, max: 200)',
      },
    },
    required: ['pattern'],
  },
  async execute(params): Promise<ToolResult> {
    const pattern = String(params.pattern ?? '')
    const searchPath = String(params.path ?? '.')
    const fileGlob = String(params.file_glob ?? '')
    const ignoreCase = Boolean(params.ignore_case)
    const contextLines = Math.max(0, Number(params.context ?? 0))
    const limit = Math.min(200, Number(params.limit ?? 50))

    if (!pattern.trim()) {
      return { success: false, output: '', error: 'Empty pattern' }
    }

    try {
      // Use ripgrep if available (Bun.spawn, no shell injection)
      const rgPath = process.env.RIPGREP_PATH || 'rg'

      const args: string[] = ['--no-heading', '--line-number', '--color', 'never']
      if (ignoreCase) args.push('-i')
      if (contextLines > 0) args.push('-C', String(contextLines))
      if (fileGlob) args.push('-g', fileGlob)
      args.push('--max-count', String(limit))
      args.push(pattern, searchPath)

      const proc = Bun.spawn([rgPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited

      if (exitCode === 2) {
        // rg returned error (e.g. invalid pattern) — fall through
        throw new Error(`rg exited with code ${exitCode}`)
      }

      const lines = stdout.trim().split('\n').filter(Boolean)
      const total = lines.length

      if (total === 0) {
        return { success: true, output: `No matches for "${pattern}" in ${searchPath}` }
      }

      // Limit output
      const output = lines.slice(0, limit).join('\n')
      const meta = total > limit ? `\n--- ${limit}/${total} matches shown ---` : `\n--- ${total} matches ---`

      return { success: true, output: output + meta }
    } catch {
      // ripgrep not available — fall back to recursive file search with fs
      return fallbackGrep(pattern, searchPath, fileGlob, ignoreCase, limit)
    }
  },
})

async function fallbackGrep(
  pattern: string,
  searchPath: string,
  fileGlob: string,
  ignoreCase: boolean,
  limit: number,
): Promise<ToolResult> {
  try {
    const { readdirSync, readFileSync, statSync } = await import('fs')
    const { resolve } = await import('path')
    const regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g')

    const results: string[] = []
    const searchFiles = (dir: string): void => {
      try {
        const entries = readdirSync(dir)
        for (const entry of entries) {
          if (results.length >= limit) return
          const fullPath = resolve(dir, entry)
          try {
            const stat = statSync(fullPath)
            if (stat.isDirectory()) {
              if (!entry.startsWith('.') && entry !== 'node_modules') {
                searchFiles(fullPath)
              }
            } else if (stat.isFile()) {
              // Check file_glob filter
              if (fileGlob) {
                const globPattern = fileGlob.replace('*', '')
                if (!entry.endsWith(globPattern)) continue
              }
              // Skip large files (> 1MB)
              if (stat.size > 1024 * 1024) continue
              const content = readFileSync(fullPath, 'utf-8')
              const lines = content.split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  results.push(`${fullPath}:${i + 1}:${lines[i].trim().slice(0, 200)}`)
                  if (results.length >= limit) return
                }
              }
            }
          } catch {
            /* skip unreadable */
          }
        }
      } catch {
        /* skip unreadable dirs */
      }
    }

    searchFiles(resolve(searchPath))

    if (results.length === 0) {
      return { success: true, output: `No matches for "${pattern}" in ${searchPath}` }
    }

    return {
      success: true,
      output: `${results.join('\n')}\n--- ${results.length} match(es) ---`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: '', error: msg }
  }
}
