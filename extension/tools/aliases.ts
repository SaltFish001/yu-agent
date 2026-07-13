/**
 * yu-agent — 常用工具别名注册
 *
 * LLM 经常猜错工具名（write_file → write, execute_command → bash 等），
 * 这里注册常见别名保证容错。
 *
 * 同时导入所有内置工具（通过 side-effect 注册）。
 */
import './bash.js'
import './read.js'
import './grep.js'
import './ls.js'
import './glob.js'
import './write.js'
import './edit.js'
import './web.js'
import { registerTool, getTool } from './registry.js'
import { createLogger } from '../logger.js'

const log = createLogger('aliases')

export function registerAliases(): void {
  const toolMap: Record<string, string> = {
    write_file: 'write',
    read_file: 'read',
    execute_command: 'bash',
    run_command: 'bash',
    shell_command: 'bash',
    list_tools: 'ls',
    list_dir: 'ls',
    file_search: 'grep',
    search_text: 'grep',
    find_file: 'glob',
    write_to_file: 'write',
    read_from_file: 'read',
    edit_file: 'edit',
    replace_text: 'edit',
  }

  let count = 0
  for (const [alias, target] of Object.entries(toolMap)) {
    const targetTool = getTool(target)
    if (!targetTool) continue
    if (getTool(alias)) continue // 不覆盖已有工具
    registerTool({
      name: alias,
      description: `Alias for ${target}: ${targetTool.description}`,
      parameters: targetTool.parameters,
      async execute(params) {
        return targetTool.execute(params)
      },
    })
    count++
  }
  log.info(`Registered ${count} tool aliases (${Object.keys(toolMap).length} configured)`)
}
