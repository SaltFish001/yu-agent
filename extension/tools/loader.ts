/**
 * yu-agent — 动态工具加载器
 *
 * 三作用域扫描：全局 /etc/yu/tools/ → 用户 ~/.yu/tools/ → 项目 .yu/tools/
 * 优先级：项目 > 用户 > 全局（同名覆盖）
 */

import { createLogger } from '../logger.js'
import { registerTool } from './registry.js'
import type { ToolDefinition } from './registry.js'
import { scanScopeFiles, ensureScopeDirs } from '../scope.js'

const log = createLogger('tool-loader')

/**
 * 从三作用域扫描并加载所有用户工具（.ts/.js）。
 * 项目级优先于用户级，用户级优先于全局级（同名覆盖）。
 */
export async function loadUserTools(): Promise<number> {
  ensureScopeDirs('tools')
  const files = scanScopeFiles('tools', ['.ts', '.js'])

  if (files.length === 0) {
    log.info('No user tools found in any scope')
    return 0
  }

  let count = 0
  for (const file of files) {
    try {
      const mod = await import(file.path)
      const tools: ToolDefinition[] = Array.isArray(mod.default)
        ? mod.default
        : mod.default
          ? [mod.default]
          : []

      for (const tool of tools) {
        if (tool?.name) {
          registerTool(tool)
          count++
          log.info(`Loaded user tool: ${tool.name} (${file.scope}:${file.name})`)
        }
      }
    } catch (err) {
      log.error(`Failed to load tool from ${file.name}`, {
        error: err instanceof Error ? err.message : String(err),
        scope: file.scope,
      })
    }
  }

  log.info(`Loaded ${count} user tool(s) from ${files.length} file(s) across all scopes`)
  return count
}
