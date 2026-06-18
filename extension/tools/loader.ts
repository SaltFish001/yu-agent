/**
 * yu-agent — 动态工具加载器
 *
 * 扫描 ~/.yu/tools/ 目录下的 .ts/.js 文件，自动注册为工具。
 * 每个文件应默认导出一个 ToolDefinition 或 ToolDefinition[]。
 */

import { existsSync, mkdirSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import { createLogger } from '../logger.js'
import { registerTool } from './registry.js'
import type { ToolDefinition } from './registry.js'

const log = createLogger('tool-loader')

const TOOLS_DIR = resolve(homedir(), '.yu', 'tools')

/** 确保工具目录存在 */
export function ensureToolsDir(): string {
  if (!existsSync(TOOLS_DIR)) {
    mkdirSync(TOOLS_DIR, { recursive: true })
    log.info(`Created tools directory: ${TOOLS_DIR}`)
  }
  return TOOLS_DIR
}

/** 扫描并加载所有用户工具 */
export async function loadUserTools(): Promise<number> {
  const dir = ensureToolsDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'))

  if (files.length === 0) {
    log.info(`No user tools found in ${dir}`)
    return 0
  }

  let count = 0
  for (const file of files) {
    try {
      const filePath = resolve(dir, file)
      const mod = await import(filePath)

      // 支持导出单个工具或工具数组
      const tools: ToolDefinition[] = Array.isArray(mod.default)
        ? mod.default
        : mod.default
          ? [mod.default]
          : []

      for (const tool of tools) {
        if (tool?.name) {
          registerTool(tool)
          count++
          log.info(`Loaded user tool: ${tool.name} (from ${file})`)
        }
      }
    } catch (err) {
      log.error(`Failed to load tool from ${file}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log.info(`Loaded ${count} user tool(s) from ${files.length} file(s)`)
  return count
}
